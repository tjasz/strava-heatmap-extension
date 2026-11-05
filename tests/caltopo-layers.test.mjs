import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { getLayerConfigs, parseLayerPresets } from '../src/clients/common/layers.js';

const source = (await readFile(new URL('../src/clients/caltopo.com/index.js', import.meta.url), 'utf8'))
  .replace(/^import[\s\S]*?from ['"][^'"]+['"];?/gm, '');
const storageKey = 'strava-heatmap-extension:caltopo-layer-state';
const presets = 'run:orange;run:blue:weekly;ride:purple';

test('CalTopo dims only the swatch emoji to 50% opacity', async () => {
  const css = await readFile(new URL('../src/clients/caltopo.com/index.css', import.meta.url), 'utf8');
  assert.match(css, /\.strava-heatmap-swatch-emoji\s*\{\s*opacity:\s*0\.5;\s*\}/);
  assert.doesNotMatch(css.match(/\.strava-heatmap-swatch\s*\{[^}]*\}/)[0], /\bopacity\s*:/);
});

class Element {
  constructor(tagName) {
    Object.assign(this, {
      tagName: tagName.toUpperCase(), children: [],
      style: { setProperty(name, value) { this[name] = value; } }, attributes: {},
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
  blur() { this.handlers.blur?.(); }
  addEventListener(name, handler) { this.handlers[name] = handler; }
  appendChild(child) { child.remove(); this.children.push(child); child.parentElement = this; }
  insertBefore(child, reference) {
    child.remove();
    const index = reference ? this.children.indexOf(reference) : this.children.length;
    assert.ok(index >= 0);
    this.children.splice(index, 0, child);
    child.parentElement = this;
  }
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

test('CalTopo forwards the injected map-sheet limit as a number for both renderers', () => {
  for (const renderer of ['google', 'leaflet']) {
    for (const limit of ['0', '1', '25', '225']) fixture(renderer, undefined, presets, limit);
  }
});

function fixture(renderer, saved, initialPresets = presets, mapSheetMaxSize) {
  const body = new Element('body');
  const heading = new Element('p');
  heading.textContent = 'Route Discovery';
  heading.className = 'native-section-heading';
  const list = new Element('ul');
  list.className = 'native-section-list';
  const nativeLayer = new Element('li');
  list.appendChild(nativeLayer);
  const followingSection = new Element('p');
  followingSection.textContent = 'Following section';
  body.append(heading, list, followingSection);
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
  const document = {
      body,
      createElement: (tag) => new Element(tag),
      createElementNS: (namespace, tag) => {
        assert.equal(namespace, 'http://www.w3.org/2000/svg');
        return new Element(tag);
      },
      getElementById: (id) => all(body).find((element) => element.id === id),
      querySelectorAll: (tag) => all(body).filter((element) => element.tagName === tag.toUpperCase()),
      querySelector: () => ({ dataset: {
        version: '0', authenticated: 'true', layers: initialPresets, mapsheetmaxsize: mapSheetMaxSize,
      } }),
    };
  vm.runInNewContext(source, {
    window, console, getLayerConfigs, parseLayerPresets, document,
    localStorage: {
      getItem: (key) => { assert.equal(key, storageKey); return stored; },
      setItem: (key, value) => { assert.equal(key, storageKey); stored = value; },
    },
    MutationObserver: class {
      constructor(callback) { observe = callback; }
      observe() {}
    },
    installGradientTileRecoloring() {},
    injectHeatmapColorFilters() {},
    setupAuthStatusChangeListener: (callback) => { authChanged = callback; },
    setupLayerPresetsChangeListener: (callback) => { presetsChanged = callback; },
    installCalTopoSnap: (manager, getLayer) => {
      getSnapLayer = getLayer;
      return { invalidate() { invalidations++; } };
    },
    installCalTopoMapSheets: (getLayers, getMap, maxTiles) => {
      assert.equal(maxTiles, Number(mapSheetMaxSize ?? 0));
      getSheetLayers = getLayers;
    },
  });
  timers[0]();
  const heatmapList = () => document.getElementById('strava-heatmap-caltopo-ribbon-layers');
  const row = (index) => {
    const stack = heatmapList().children[index].children[0];
    const button = stack.children[0];
    const collapse = stack.children[1];
    const opacityRow = collapse.children[0].children[0].children[0].children[0];
    return { button, collapse, input: opacityRow.children[0].children[0], value: opacityRow.children[1] };
  };
  return {
    window, document, body, map, mapOverlays, row, observe,
    routeDiscoveryHeading: heading, routeDiscoveryList: list, nativeLayer, followingSection,
    get list() { return heatmapList(); },
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
  test(`${renderer} places heatmaps in their own native-styled section below Route Discovery`, () => {
    const f = fixture(renderer);
    const heading = f.routeDiscoveryList.nextElementSibling;
    assert.equal(heading.textContent, 'Strava Heatmap');
    assert.equal(heading.tagName, 'P');
    assert.equal(heading.className, f.routeDiscoveryHeading.className);
    assert.equal(heading.nextElementSibling, f.list);
    assert.equal(f.list.tagName, 'UL');
    assert.equal(f.list.className, f.routeDiscoveryList.className);
    assert.equal(f.list.attributes['aria-labelledby'], heading.id);
    assert.equal(f.list.nextElementSibling, f.followingSection);
    assert.deepEqual(f.routeDiscoveryList.children, [f.nativeLayer]);
    assert.equal(f.list.children.length, 3);
    f.observe();
    f.authChanged(false);
    f.presetsChanged('ride:purple;run:orange');
    assert.equal(f.routeDiscoveryList.nextElementSibling, heading);
    assert.equal(heading.nextElementSibling, f.list);
    assert.equal(f.list.nextElementSibling, f.followingSection);
    assert.equal(f.list.children.length, 2);
    assert.deepEqual(f.routeDiscoveryList.children, [f.nativeLayer]);
    assert.equal(f.body.children.length, 5, 'do not duplicate section headings or lists');
  });

  test(`${renderer} restores the heatmap section after the layer panel remounts`, () => {
    const f = fixture(renderer);
    f.row(0).input.value = '25';
    f.row(0).input.handlers.input();
    const heading = f.routeDiscoveryList.nextElementSibling;
    const list = f.list;
    heading.remove();
    f.observe();
    assert.equal(f.routeDiscoveryList.nextElementSibling.textContent, 'Strava Heatmap');
    assert.equal(f.list, list, 'removing the heading must not replace the list');
    f.routeDiscoveryList.nextElementSibling.remove();
    list.remove();
    f.routeDiscoveryHeading.remove();
    f.routeDiscoveryList.remove();
    f.observe();
    assert.equal(f.list, undefined, 'wait for Route Discovery to remount');
    f.body.insertBefore(f.routeDiscoveryHeading, f.followingSection);
    f.body.insertBefore(f.routeDiscoveryList, f.followingSection);
    f.observe();
    assert.equal(f.routeDiscoveryList.nextElementSibling.textContent, 'Strava Heatmap');
    assert.equal(f.list.children.length, 3);
    assert.equal(f.row(0).input.value, '25');
    assert.equal(f.row(0).button.attributes['aria-pressed'], 'true');
    assert.equal(f.list.nextElementSibling, f.followingSection);
    assert.deepEqual(f.routeDiscoveryList.children, [f.nativeLayer]);
  });

  test(`${renderer} synchronizes the opacity slider and editable percentage without losing drafts`, () => {
    const f = fixture(renderer);
    const { input, value } = f.row(0);
    const overlay = f.mapOverlays[0];
    const opacity = () => renderer === 'leaflet' ? overlay.options.opacity : overlay.opacity;
    assert.equal(value.tagName, 'INPUT');
    assert.equal(value.type, 'text');
    assert.equal(value.inputMode, 'numeric');
    assert.match(value.attributes['aria-label'], /opacity percent$/);
    assert.equal(value.value, '100');
    input.value = '42';
    input.handlers.input();
    assert.equal(value.value, '42');
    assert.equal(input.style['--opacity-percentage'], '42%');
    assert.equal(opacity(), 0.42);

    f.document.activeElement = value;
    for (const text of ['6', '60', '0', '100']) {
      value.value = text;
      value.handlers.input();
      const expected = Number(text) / 100;
      assert.equal(value.value, text, 'keep the text draft until committed');
      assert.equal(Number(input.value) / 100, expected);
      assert.equal(opacity(), expected);
      assert.equal(f.state().layers['strava-heatmap-run'].opacity, expected);
    }
    for (const [text, expected] of [
      ['101', '100'], ['999', '100'], ['9'.repeat(400), '100'],
      ['a4b2', '42'], ['60.', '60'], ['60,', '60'], ['-1', '1'],
      [' 25% ', '25'], ['1e2', '12'], ['0007', '7'],
    ]) {
      value.value = text;
      value.handlers.input();
      assert.equal(value.value, expected);
      assert.equal(input.value, expected);
      assert.equal(opacity(), Number(expected) / 100);
      assert.equal(f.state().layers['strava-heatmap-run'].opacity, Number(expected) / 100);
    }
    const saved = f.state();
    for (const text of ['', ' ', 'Infinity', 'NaN', 'abc', '.,-', '\u0661\u0662']) {
      value.value = text;
      value.handlers.input();
      assert.equal(value.value, '');
      assert.deepEqual(f.state(), saved, 'empty drafts must not change saved state');
      assert.equal(opacity(), 0.07);
    }
    value.handlers.change();
    assert.equal(value.value, '7');
    const keydown = (key) => value.handlers.keydown({ key, preventDefault() {} });
    value.value = '';
    value.handlers.input();
    keydown('Enter');
    assert.equal(value.value, '7');
    value.value = '';
    value.handlers.input();
    keydown('Escape');
    assert.equal(value.value, '7');
    value.value = '27';
    value.handlers.input();
    keydown('Enter');
    assert.equal(value.value, '27');

    value.value = '';
    value.handlers.input();
    f.document.activeElement = null;
    input.value = '35';
    input.handlers.input();
    assert.equal(value.value, '35');
    f.row(0).button.handlers.click();
    assert.equal(input.disabled, true);
    assert.equal(value.disabled, true);
    f.row(0).button.handlers.click();
    assert.equal(value.disabled, false);
    assert.equal(fixture(renderer, f.state()).row(0).value.value, '35');
    f.flush();
  });

  test(`${renderer} restores snapping from the enabled stack instead of a stale hidden selection`, () => {
    const f = fixture(renderer, {
      layerId: 'strava-heatmap-run-weekly',
      layerOrder: [
        'strava-heatmap-run', 'strava-heatmap-ride', 'strava-heatmap-ride',
        'strava-heatmap-run-weekly', 'removed-layer',
      ],
      layers: {
        'strava-heatmap-run': { enabled: true, opacity: 1 },
        'strava-heatmap-run-weekly': { enabled: false, opacity: 0.7 },
        'strava-heatmap-ride': { enabled: true, opacity: 1 },
      },
    });
    assert.deepEqual(f.state().layerOrder, ['strava-heatmap-run', 'strava-heatmap-ride']);
    assert.equal(f.getSnapLayer().id, 'strava-heatmap-ride');
    f.row(2).button.handlers.click();
    assert.equal(f.getSnapLayer().id, 'strava-heatmap-run');
    f.row(0).button.handlers.click();
    assert.equal(f.getSnapLayer(), undefined);
    f.flush();
  });

  test(`${renderer} shares activation order with snapping, restores and map-sheet exports without reordering on opacity changes`, () => {
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
      const top = fixture.getSheetLayers().at(-1);
      assert.equal(fixture.getSnapLayer()?.id, top?.id);
      assert.equal(fixture.window.__stravaHeatmapCalTopoOverlay,
        expected.length ? fixture.mapOverlays.at(-1) : undefined);
      assert.equal(new Set(fixture.state().layerOrder).size, expected.length);
    };
    f.row(2).button.handlers.click();
    f.row(1).button.handlers.click();
    expectOrder(f, ['run', 'ride', 'weekly']);
    const invalidations = f.invalidations();
    f.row(0).input.value = '45';
    f.row(0).input.handlers.input();
    expectOrder(f, ['run', 'ride', 'weekly']);
    f.row(0).input.handlers.input();
    expectOrder(f, ['run', 'ride', 'weekly']);
    f.row(1).input.handlers.input();
    expectOrder(f, ['run', 'ride', 'weekly']);
    assert.equal(f.invalidations(), invalidations, 'opacity changes keep the same snap source');
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
    assert.equal(f.getSnapLayer(), undefined);
    f.row(0).button.handlers.click();
    f.row(1).button.handlers.click();
    assert.equal(f.mapOverlays.length, 2);
    assert.equal(f.row(0).input.value, '0');
    assert.equal(f.row(1).input.value, '100');
    assert.deepEqual(Array.from(f.getSheetLayers(), (layer) => [layer.id, layer.opacity]), [
      ['strava-heatmap-run', 0], ['strava-heatmap-run-2', 1],
    ]);
    assert.equal(f.getSnapLayer().id, 'strava-heatmap-run-2');
    f.row(0).button.handlers.click();
    assert.equal(f.row(1).button.attributes['aria-pressed'], 'true');
    assert.equal(f.mapOverlays.length, 1);
    assert.equal(f.getSnapLayer().id, 'strava-heatmap-run-2');
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
      assert.equal(button.children[0].className, index === 1
        ? 'MuiBox-root css-1myp8s' : 'MuiBox-root strava-heatmap-swatch');
      assert.equal(button.children[0].children[0].className, 'strava-heatmap-swatch-emoji');
      assert.equal(button.children[0].children[0].textContent, '🔥');
      assert.equal(button.children[0].children[0].style.display, index === 1 ? 'none' : '');
      const selectedIcon = button.children[0].children[1];
      assert.equal(selectedIcon.className, 'css-1y66ce9');
      assert.equal(selectedIcon.style.display, index === 1 ? '' : 'none');
      const svg = selectedIcon.children[0];
      assert.equal(svg.tagName, 'SVG');
      assert.equal(svg.attributes.viewBox, '0 0 24 24');
      assert.equal(svg.attributes['aria-hidden'], 'true');
      assert.equal(svg.attributes.focusable, 'false');
      assert.equal(svg.attributes.class, 'MuiSvgIcon-root MuiSvgIcon-fontSizeMedium css-140d7vm');
      assert.equal(svg.children[0].tagName, 'PATH');
      assert.ok(svg.children[0].attributes.d.startsWith('M16.59 7.58'));
    }
    assert.ok(!f.list.children.some((item) => item.tagName === 'SELECT'));

    f.row(0).button.handlers.click();
    f.row(2).button.handlers.keydown({ key: 'Enter', preventDefault() {} });
    for (let index = 0; index < 3; index++) {
      const swatch = f.row(index).button.children[0];
      assert.equal(swatch.className, 'MuiBox-root css-1myp8s');
      assert.equal(swatch.children[0].style.display, 'none');
      assert.equal(swatch.children[1].style.display, '');
    }
    assert.equal(f.mapOverlays.length, 3);
    assert.equal(f.getSnapLayer().id, 'strava-heatmap-ride');
    f.row(1).input.value = '70';
    f.row(1).input.handlers.input();
    assert.equal(f.getSnapLayer().id, 'strava-heatmap-ride');
    assert.equal(f.row(1).value.value, '70');
    assert.deepEqual(Array.from(f.getSheetLayers(), (layer) => [layer.id, layer.opacity]), [
      ['strava-heatmap-run-weekly', 0.7], ['strava-heatmap-run', 1], ['strava-heatmap-ride', 1],
    ]);
    assert.equal(f.invalidations(), 2);
    const invalidations = f.invalidations();
    f.row(1).button.handlers.click();
    assert.equal(f.invalidations(), invalidations + 1);
    assert.equal(f.mapOverlays.length, 2);
    assert.equal(f.row(1).input.disabled, true);
    assert.equal(f.row(1).button.attributes['aria-expanded'], 'false');
    const deselectedSwatch = f.row(1).button.children[0];
    assert.equal(deselectedSwatch.className, 'MuiBox-root strava-heatmap-swatch');
    assert.equal(deselectedSwatch.children[0].style.display, '');
    assert.equal(deselectedSwatch.children[1].style.display, 'none');
    assert.equal(f.getSnapLayer().id, 'strava-heatmap-ride', 'snapping follows the remaining top layer');
    assert.deepEqual(Array.from(f.getSheetLayers(), (layer) => layer.id),
      ['strava-heatmap-run', 'strava-heatmap-ride']);

    const restored = fixture(renderer, f.state());
    assert.equal(restored.mapOverlays.length, 2);
    assert.equal(restored.row(1).input.value, '70');
    assert.equal(restored.row(1).button.attributes['aria-pressed'], 'false');
    assert.equal(restored.getSnapLayer().id, 'strava-heatmap-ride');
    f.row(2).button.handlers.click();
    assert.equal(f.getSnapLayer().id, 'strava-heatmap-run');
    f.row(0).button.handlers.click();
    assert.equal(f.getSnapLayer(), undefined);
    assert.equal(f.state().layerOrder.length, 0);
    assert.equal(fixture(renderer, f.state()).getSnapLayer(), undefined);
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
    assert.equal(f.getSnapLayer(), undefined);
    assert.equal(f.mapOverlays.filter((overlay) => overlay.getTile || overlay.template).length, 0);
    f.flush();
  });
}
