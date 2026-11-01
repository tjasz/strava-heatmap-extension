import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { getLayerConfigs, parseLayerPresets } from '../src/clients/common/layers.js';

const source = (await readFile(
  new URL('../src/clients/tjasz.github.io/index.js', import.meta.url), 'utf8'
)).replace(/^import[\s\S]*?from ['"][^'"]+['"];?/gm, '');

class Element {
  constructor() {
    this.children = [];
    this.classList = { add() {} };
    this.style = {};
  }
  append(child) {
    child.remove();
    child.parentElement = this;
    this.children.push(child);
  }
  remove() {
    if (!this.parentElement) return;
    const siblings = this.parentElement.children;
    siblings.splice(siblings.indexOf(this), 1);
    this.parentElement = null;
  }
  querySelector(selector) {
    return selector === 'input' ? this.input : this.overlays;
  }
  querySelectorAll() { return this.overlays.children; }
}

async function fixture(requested = '') {
  const errors = [];
  const overlayEvents = [];
  const controls = new Set();
  class Map {
    constructor() {
      this.layers = new Set();
      this.events = {};
      this.panes = {};
    }
    on(names, fn) {
      for (const name of names.split(' ')) (this.events[name] ??= new Set()).add(fn);
    }
    off(names, fn) {
      for (const name of names.split(' ')) this.events[name]?.delete(fn);
    }
    fire(type, layer) {
      for (const fn of [...this.events[type] ?? []]) fn({ type, layer });
      if (type.startsWith('overlay')) overlayEvents.push([type, layer.options.geotabId]);
    }
    hasLayer(layer) { return this.layers.has(layer); }
    addLayer(layer) {
      if (this.hasLayer(layer)) return;
      this.layers.add(layer);
      this.fire('layeradd', layer);
    }
    removeLayer(layer) {
      if (!this.layers.delete(layer)) return;
      this.fire('layerremove', layer);
    }
    getPane(name) { return this.panes[name]; }
    createPane(name) { return this.panes[name] = new Element(); }
    remove() {
      this.fire('unload');
      for (const layer of this.layers) this.removeLayer(layer);
    }
  }
  class Control {
    constructor() {
      this.entries = [];
      this.container = new Element();
      this.container.overlays = new Element();
      this.changed = ({ type, layer }) => {
        if (!this.handlingClick) this._update();
        if (this.entries.some((entry) => entry.layer === layer)) {
          this.map.fire(type === 'layeradd' ? 'overlayadd' : 'overlayremove', layer);
        }
      };
    }
    addTo(map) {
      this.map = map;
      controls.add(this);
      map.on('layeradd layerremove', this.changed);
      this._update();
    }
    getContainer() { return this.container; }
    addOverlay(layer, name) {
      this.entries.push({ layer, name });
      this._update();
    }
    _update() {
      for (const label of [...this.container.overlays.children]) label.remove();
      this.inputs = this.entries.map(({ layer }) => {
        const label = new Element();
        label.input = {
          checked: this.map.hasLayer(layer),
          click: () => {
            label.input.checked = !label.input.checked;
            this.handlingClick = true;
            for (let i = 0; i < this.entries.length; i++) {
              const entry = this.entries[i];
              if (this.inputs[i].checked) this.map.addLayer(entry.layer);
              else this.map.removeLayer(entry.layer);
            }
            this.handlingClick = false;
          },
        };
        this.container.overlays.append(label);
        return label.input;
      });
      return this;
    }
    remove() {
      this.map.off('layeradd layerremove', this.changed);
      controls.delete(this);
    }
  }
  let containers = [];
  let observe;
  let authChanged;
  let presetsChanged;
  const mount = (map = new Map()) => {
    const container = new Element();
    container.overlays = new Element();
    container.__reactFiber$test = {
      memoizedState: { memoizedState: { map } },
    };
    containers = [container];
    return { map, container, overlays: container.overlays };
  };
  const initial = mount();
  vm.runInNewContext(source, {
    window: {
      L: { Map, control: { layers: () => new Control() }, tileLayer: (template, options) => ({ template, options }) },
      location: { search: `?o=${requested}` },
    },
    document: {
      body: new Element(),
      querySelector: () => ({
        dataset: { version: '0', authenticated: 'true', layers: 'run:orange;ride:purple' },
      }),
      querySelectorAll: () => containers,
    },
    URLSearchParams, setTimeout,
    console: { log() {}, error: (...args) => errors.push(args) },
    MutationObserver: class {
      constructor(callback) { observe = callback; }
      observe() {}
    },
    getLayerConfigs, parseLayerPresets,
    installGradientTileRecoloring() {},
    injectHeatmapColorFilters() {},
    setupAuthStatusChangeListener: (fn) => { authChanged = fn; },
    setupLayerPresetsChangeListener: (fn) => { presetsChanged = fn; },
  });
  await new Promise((resolve) => setImmediate(resolve));
  return {
    ...initial, controls, errors, overlayEvents, mount,
    observe: () => {
      observe();
      assert.deepEqual(errors, []);
    },
    hide: () => { containers = []; observe(); },
    authChanged: (value) => authChanged(value),
    presetsChanged: (value) => presetsChanged(value),
    enabled: (map = initial.map) => [...map.layers]
      .map((layer) => layer.options?.geotabId).filter(Boolean).sort(),
  };
}

test('restores rows after native control updates without duplicates or stale checkboxes', async () => {
  const f = await fixture('strava-heatmap-run');
  assert.equal(f.overlays.children.length, 2);
  assert.equal(f.overlays.children[0].input.checked, true);
  f.overlays.children[1].input.click();
  const enabled = ['strava-heatmap-ride', 'strava-heatmap-run'];
  assert.deepEqual(f.enabled(), enabled);
  for (let i = 0; i < 3; i++) {
    for (const label of [...f.overlays.children]) label.remove();
    f.observe();
    assert.equal(f.overlays.children.length, 2);
  }
  const native = {};
  f.map.addLayer(native);
  assert.equal(f.overlays.children.length, 2);
  assert.ok(f.overlays.children.every((label) => label.input.checked));
  f.overlays.children[0].input.click();
  assert.deepEqual(f.enabled(), ['strava-heatmap-ride']);
  assert.ok(f.overlayEvents.some(([type, id]) =>
    type === 'overlayremove' && id === 'strava-heatmap-run'));
  assert.equal(f.controls.size, 1);
  assert.deepEqual(f.errors, []);
});

test('reattaches rows to a replacement control on the same map', async () => {
  const f = await fixture('strava-heatmap-run,strava-heatmap-ride');
  const replacement = new Element();
  f.container.overlays = replacement;
  f.observe();
  assert.equal(f.overlays.children.length, 0);
  assert.equal(replacement.children.length, 2);
  replacement.children[1].input.click();
  f.map.addLayer({});
  assert.equal(replacement.children.length, 2);
  assert.equal(replacement.children[1].input.checked, false);
  assert.equal(f.controls.size, 1);
  assert.deepEqual(f.errors, []);
});

test('preserves user toggles through unload, hidden settings changes and repeated remounts', async () => {
  const f = await fixture('strava-heatmap-run');
  f.overlays.children[0].input.click();
  f.overlays.children[1].input.click();
  f.hide();
  f.map.remove();
  assert.equal(f.controls.size, 0);
  f.authChanged(false);
  f.presetsChanged('ride:blue;run:orange;run:purple:weekly');
  for (let i = 0; i < 3; i++) {
    const next = f.mount();
    f.observe();
    assert.deepEqual(f.enabled(next.map), ['strava-heatmap-ride']);
    assert.equal(next.overlays.children.length, 3);
    assert.equal(next.overlays.children[0].input.checked, true);
    assert.equal(next.overlays.children[1].input.checked, false);
    assert.equal(f.controls.size, 1);
    f.hide();
    next.map.remove();
    assert.equal(f.controls.size, 0);
  }
  assert.deepEqual(f.errors, []);
});

test('cleans up a replaced map and refreshes auth and presets on the new map', async () => {
  const f = await fixture('strava-heatmap-run,strava-heatmap-ride');
  const next = f.mount();
  f.observe();
  assert.equal(f.map.layers.size, 0);
  assert.equal(f.overlays.children.length, 0);
  assert.equal(f.controls.size, 1);
  assert.ok(Object.values(f.map.events).every((handlers) => handlers.size === 0));
  f.authChanged(false);
  assert.ok([...next.map.layers].every((layer) => layer.template.includes('heatmap-fallback')));
  f.presetsChanged('run:blue;run:purple');
  assert.equal(next.overlays.children.length, 2);
  assert.deepEqual(f.enabled(next.map), ['strava-heatmap-run']);
  next.overlays.children[1].input.click();
  f.authChanged(true);
  assert.deepEqual(f.enabled(next.map), ['strava-heatmap-run', 'strava-heatmap-run-2']);
  assert.ok([...next.map.layers].every((layer) => layer.template.includes('/grayscale/')));
  assert.equal(f.controls.size, 1);
  assert.deepEqual(f.errors, []);
});

test('keeps all layers disabled after remount instead of reapplying the initial URL', async () => {
  const f = await fixture('strava-heatmap-run');
  f.overlays.children[0].input.click();
  f.map.remove();
  f.hide();
  const next = f.mount();
  f.observe();
  assert.deepEqual(f.enabled(next.map), []);
  assert.equal(next.overlays.children.length, 2);
  assert.ok(next.overlays.children.every((label) => !label.input.checked));
  assert.deepEqual(f.errors, []);
});
