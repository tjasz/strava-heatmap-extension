import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { getLayerConfigs, parseLayerPresets } from '../src/clients/common/layers.js';

const source = (await readFile(new URL('../src/clients/caltopo.com/index.js', import.meta.url), 'utf8'))
  .replace(/^import[\s\S]*?from ['"][^'"]+['"];?/gm, '');
const storageKey = 'strava-heatmap-extension:caltopo-layer-state';
const presets = 'run:orange;run:blue:weekly;ride:purple';

class Element {
  constructor(tagName) {
    Object.assign(this, {
      tagName: tagName.toUpperCase(), children: [], style: {}, attributes: {},
      handlers: {}, textContent: '', className: '',
    });
    this.classList = {
      toggle: (name, enabled) => {
        const values = new Set(this.className.split(' ').filter(Boolean));
        if (enabled) values.add(name);
        else values.delete(name);
        this.className = [...values].join(' ');
      },
    };
  }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, handler) { this.handlers[name] = handler; }
  appendChild(child) { child.remove(); this.children.push(child); child.parentElement = this; }
  append(...children) { children.forEach((child) => this.appendChild(child)); }
  remove() {
    if (!this.parentElement) return;
    const siblings = this.parentElement.children;
    siblings.splice(siblings.indexOf(this), 1);
    this.parentElement = null;
  }
  get nextElementSibling() {
    return this.parentElement.children[this.parentElement.children.indexOf(this) + 1];
  }
}

function fixture(renderer, saved, initialPresets = presets) {
  const body = new Element('body');
  const heading = new Element('p');
  heading.textContent = 'Route Discovery';
  const list = new Element('ul');
  body.append(heading, list);
  const all = (root) => [root, ...root.children.flatMap(all)];
  const timers = [];
  const timeouts = [];
  const mapOverlays = [];
  const listeners = {};
  const map = renderer === 'leaflet' ? { addLayer() {}, removeLayer() {} } : {
    overlayMapTypes: {
      getLength: () => mapOverlays.length,
      getAt: (i) => mapOverlays[i],
      push: (overlay) => { mapOverlays.push(overlay); listeners.insert_at?.(); },
      removeAt: (i) => { mapOverlays.splice(i, 1); listeners.remove_at?.(); },
      addListener: (name, callback) => {
        listeners[name] = callback;
        return { remove() { delete listeners[name]; } };
      },
    },
  };
  const removeOverlay = (overlay) => {
    const index = mapOverlays.indexOf(overlay);
    if (index >= 0) mapOverlays.splice(index, 1);
  };
  const window = {
    location: new URL('https://caltopo.com/map.html'),
    map: { map: { map } },
    imap: { drawingManager: {} },
    setInterval: (callback) => { timers.push(callback); return timers.length; },
    clearInterval() {},
    setTimeout: (callback) => { timeouts.push(callback); return timeouts.length; },
  };
  if (renderer === 'leaflet') {
    window.L = {
      tileLayer: (template, options) => ({
        template, options,
        addTo(map) { this._map = map; mapOverlays.push(this); },
        remove() { removeOverlay(this); },
        bringToFront() { removeOverlay(this); mapOverlays.push(this); },
        setOpacity(opacity) { this.options.opacity = opacity; },
      }),
    };
  } else {
    window.google = { maps: { Size: class {} } };
  }
  let authChanged;
  let presetsChanged;
  let observe;
  let getSnapLayer;
  let getSheetLayers;
  let invalidations = 0;
  let stored = saved ? JSON.stringify(saved) : null;
  vm.runInNewContext(source, {
    window, console, getLayerConfigs, parseLayerPresets,
    document: {
      body,
      createElement: (tag) => new Element(tag),
      getElementById: (id) => all(body).find((element) => element.id === id),
      querySelectorAll: (tag) => all(body).filter((element) => element.tagName === tag.toUpperCase()),
      querySelector: () => ({ dataset: { version: '0', authenticated: 'true', layers: initialPresets } }),
    },
    localStorage: {
      getItem: (key) => { assert.equal(key, storageKey); return stored; },
      setItem: (key, value) => { assert.equal(key, storageKey); stored = value; },
    },
    MutationObserver: class {
      constructor(callback) { observe = callback; }
      observe() {}
    },
    injectHeatmapColorFilters() {},
    setupAuthStatusChangeListener: (callback) => { authChanged = callback; },
    setupLayerPresetsChangeListener: (callback) => { presetsChanged = callback; },
    installCalTopoSnap: (manager, getLayer) => {
      getSnapLayer = getLayer;
      return { invalidate() { invalidations++; } };
    },
    installCalTopoMapSheets: (getLayers) => { getSheetLayers = getLayers; },
  });
  timers[0]();
  const row = (index) => {
    const stack = list.children[index].children[0];
    const button = stack.children[0];
    const collapse = stack.children[1];
    const label = collapse.children[0].children[0].children[0].children[0];
    return { button, collapse, input: label.children[0], output: label.children[1] };
  };
  return {
    window, body, list, map, mapOverlays, row, observe,
    state: () => JSON.parse(stored),
    getSnapLayer: () => getSnapLayer(),
    getSheetLayers: () => getSheetLayers(),
    invalidations: () => invalidations,
    authChanged: (value) => authChanged(value),
    presetsChanged: (value) => presetsChanged(value),
    flush() {
      let attempts = 0;
      while (timeouts.length) {
        assert.ok(attempts++ < 10, 'overlay restoration must settle');
        timeouts.shift()();
      }
    },
  };
}

for (const renderer of ['leaflet', 'google']) {
  test(`${renderer} stacks by activation order through refreshes, restores and map-sheet exports`, () => {
    const f = fixture(renderer);
    const order = (fixture) => fixture.mapOverlays
      .filter((overlay) => overlay.template || overlay.getTile)
      .map((overlay) => {
        const url = renderer === 'leaflet' ? overlay.template :
          overlay.getTile({ x: 0, y: 0 }, 1, {
            createElement: (tag) => new Element(tag),
          }).children[0].src;
        if (url.includes('weeklyheat')) return 'weekly';
        return url.includes('/ride/') ? 'ride' : 'run';
      });
    const expectOrder = (fixture, expected) => {
      fixture.flush();
      assert.deepEqual(order(fixture), expected);
      assert.deepEqual(Array.from(fixture.getSheetLayers(), (layer) =>
        layer.id.endsWith('-weekly') ? 'weekly' : layer.id.endsWith('-ride') ? 'ride' : 'run'), expected);
    };
    f.row(2).button.handlers.click();
    f.row(1).button.handlers.click();
    expectOrder(f, ['run', 'ride', 'weekly']);
    f.row(0).input.value = '45';
    f.row(0).input.handlers.input();
    expectOrder(f, ['run', 'ride', 'weekly']);
    f.row(2).button.handlers.click();
    expectOrder(f, ['run', 'weekly']);
    f.row(2).button.handlers.click();
    expectOrder(f, ['run', 'weekly', 'ride']);
    f.authChanged(true);
    expectOrder(f, ['run', 'weekly', 'ride']);
    f.presetsChanged('ride:purple;run:blue:weekly;run:orange');
    expectOrder(f, ['run', 'weekly', 'ride']);
    const restored = fixture(renderer, f.state(), 'ride:purple;run:blue:weekly;run:orange');
    expectOrder(restored, ['run', 'weekly', 'ride']);
    if (renderer === 'google') {
      const native = {};
      restored.map.overlayMapTypes.push(native);
      expectOrder(restored, ['run', 'weekly', 'ride']);
      assert.equal(restored.mapOverlays[0], native);
    }
    f.presetsChanged('ride:purple;run:orange');
    expectOrder(f, ['run', 'ride']);
    assert.deepEqual(f.state().layerOrder, ['strava-heatmap-run', 'strava-heatmap-ride']);
  });

  test(`${renderer} keeps duplicate activities independent and preserves an all-hidden legacy state`, () => {
    const f = fixture(renderer, {
      layerId: 'strava-heatmap-run', enabled: false, opacity: 0,
    }, 'run:orange;run:blue;run:purple:weekly');
    assert.equal(f.list.children.length, 3);
    assert.equal(f.mapOverlays.length, 0);
    assert.equal(f.getSheetLayers().length, 0);
    assert.equal(f.getSnapLayer().id, 'strava-heatmap-run');
    f.row(0).button.handlers.click();
    f.row(1).button.handlers.click();
    assert.equal(f.mapOverlays.length, 2);
    assert.equal(f.row(0).input.value, '0');
    assert.equal(f.row(1).input.value, '100');
    assert.deepEqual(Array.from(f.getSheetLayers(), (layer) => [layer.id, layer.opacity]), [
      ['strava-heatmap-run', 0], ['strava-heatmap-run-2', 1],
    ]);
    f.row(0).button.handlers.click();
    assert.equal(f.row(1).button.attributes['aria-pressed'], 'true');
    assert.equal(f.mapOverlays.length, 1);
    f.flush();
  });

  test(`${renderer} shows independent buttons and opacity controls and migrates the old selection`, () => {
    const f = fixture(renderer, { layerId: 'strava-heatmap-run-weekly', enabled: true, opacity: 0.35 });
    assert.equal(f.list.children.length, 3);
    assert.equal(f.mapOverlays.length, 1);
    assert.equal(f.row(0).button.attributes['aria-pressed'], 'false');
    assert.equal(f.row(1).button.attributes['aria-pressed'], 'true');
    assert.equal(f.row(1).input.value, '35');
    assert.equal(f.row(0).collapse.style.visibility, 'hidden');
    assert.match(f.row(1).button.attributes['aria-label'], /Weekly/);
    for (let index = 0; index < 3; index++) {
      const { button } = f.row(index);
      const title = button.children[1].children[0].children[0];
      assert.equal(title.textContent, getLayerConfigs(
        parseLayerPresets(presets), true, '0', true,
      )[index].name);
      assert.equal(button.attributes['aria-label'], title.textContent);
      assert.ok(!title.textContent.includes('Strava Heatmap'));
      assert.equal(button.children[0].className, 'MuiBox-root strava-heatmap-swatch');
    }
    assert.ok(!f.list.children.some((item) => item.tagName === 'SELECT'));

    f.row(0).button.handlers.click();
    f.row(2).button.handlers.keydown({ key: 'Enter', preventDefault() {} });
    assert.equal(f.mapOverlays.length, 3);
    assert.equal(f.getSnapLayer().id, 'strava-heatmap-ride');
    f.row(1).input.value = '70';
    f.row(1).input.handlers.input();
    assert.equal(f.getSnapLayer().id, 'strava-heatmap-run-weekly');
    assert.equal(f.row(1).output.value, '70%');
    assert.deepEqual(Array.from(f.getSheetLayers(), (layer) => [layer.id, layer.opacity]), [
      ['strava-heatmap-run-weekly', 0.7], ['strava-heatmap-run', 1], ['strava-heatmap-ride', 1],
    ]);
    assert.ok(f.invalidations() >= 3);
    f.row(1).button.handlers.click();
    assert.equal(f.mapOverlays.length, 2);
    assert.equal(f.row(1).input.disabled, true);
    assert.equal(f.row(1).button.attributes['aria-expanded'], 'false');
    assert.equal(f.getSnapLayer().id, 'strava-heatmap-run-weekly', 'snapping remembers a hidden source');
    assert.deepEqual(Array.from(f.getSheetLayers(), (layer) => layer.id),
      ['strava-heatmap-run', 'strava-heatmap-ride']);

    const restored = fixture(renderer, f.state());
    assert.equal(restored.mapOverlays.length, 2);
    assert.equal(restored.row(1).input.value, '70');
    assert.equal(restored.row(1).button.attributes['aria-pressed'], 'false');
    assert.equal(restored.getSnapLayer().id, 'strava-heatmap-run-weekly');
    f.flush();
  });

  test(`${renderer} preserves layer state through auth, preset reorder/removal and native UI remounts`, () => {
    const f = fixture(renderer);
    f.row(1).button.handlers.click();
    f.row(0).input.value = '25';
    f.row(0).input.handlers.input();
    f.authChanged(false);
    assert.ok(f.getSheetLayers().every((layer) => layer.template.includes('heatmap-fallback.png')));
    assert.equal(f.mapOverlays.length, 2);
    f.authChanged(true);
    assert.equal(f.row(0).input.value, '25');
    f.presetsChanged('run:blue:weekly;run:orange');
    assert.equal(f.list.children.length, 2);
    assert.equal(f.row(0).input.value, '100');
    assert.equal(f.row(1).input.value, '25');
    assert.equal(f.mapOverlays.length, 2);
    assert.deepEqual(Object.keys(f.state().layers).sort(),
      ['strava-heatmap-run', 'strava-heatmap-run-weekly']);

    if (renderer === 'google') {
      const native = {};
      f.map.overlayMapTypes.push(native);
      f.flush();
      assert.equal(f.mapOverlays[0], native);
    }
    f.list.children.slice().forEach((item) => item.remove());
    f.observe();
    assert.equal(f.list.children.length, 2);
    assert.equal(f.row(1).input.value, '25');
    f.row(0).button.handlers.click();
    f.row(1).button.handlers.click();
    assert.equal(f.getSheetLayers().length, 0);
    assert.equal(f.mapOverlays.filter((overlay) => overlay.getTile || overlay.template).length, 0);
    f.flush();
  });
}
