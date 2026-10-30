import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { ACTIVITY_OPTIONS, COLOR_OPTIONS, normalizeGradientStops } from '../src/clients/common/layers.js';
import { formatLayerPresets, validateLayerPresets } from '../src/background/layers.js';

function element(tagName) {
  const node = {
    tagName, children: [], className: '', dataset: {}, disabled: false,
    appendChild(child) { this.children.push(child); },
    append(...children) { this.children.push(...children); },
    setAttribute(name, value) { this[name] = value; },
    addEventListener(name, callback) { this[`on${name}`] = callback; },
    querySelector(selector) {
      return this.querySelectorAll(selector)[0];
    },
    querySelectorAll(selector) {
      const matches = (child) => selector.startsWith('.')
        ? child.className.split(' ').includes(selector.slice(1))
        : child.tagName === selector;
      return this.children.flatMap((child) => [
        ...(matches(child) ? [child] : []), ...child.querySelectorAll(selector),
      ]);
    },
    get innerHTML() { return ''; },
    set innerHTML(value) { assert.equal(value, ''); this.children = []; },
  };
  node.classList = {
    add(name) { this.toggle(name, true); },
    toggle(name, enabled) {
      const classes = new Set(node.className.split(' ').filter(Boolean));
      if (enabled) classes.add(name);
      else classes.delete(name);
      node.className = [...classes].join(' ');
    },
  };
  if (tagName === 'select') {
    Object.defineProperty(node, 'options', {
      get: () => node.children.flatMap((child) => child.tagName === 'optgroup' ? child.children : [child]),
    });
    Object.defineProperty(node, 'value', {
      get: () => (node.options.find((option) => option.selected) ?? node.options[0])?.value ?? '',
      set: (value) => node.options.forEach((option) => { option.selected = option.value === value; }),
    });
  }
  return node;
}

test('settings preserve weekly types through editing, adding, sorting, applying and resetting', async () => {
  const ids = Object.fromEntries([
    'layer-list', 'settings-title', 'add-layer', 'apply-settings',
    'close-settings', 'reset-settings',
  ].map((id) => [id, element(id === 'layer-list' ? 'ul' : 'button')]));
  const list = ids['layer-list'];
  let onReady;
  let sorting;
  const gradientSorting = new WeakMap();
  let closed = false;
  let presets = [
    { activity: 'run', color: 'orange' },
    { activity: 'run', color: 'blue', period: 'weekly' },
  ];
  const document = {
    createElement: element,
    getElementById: (id) => ids[id],
    addEventListener: (name, callback) => {
      assert.equal(name, 'DOMContentLoaded');
      onReady = callback;
    },
    querySelectorAll: (selector) => {
      assert.equal(selector, '#layer-list .layer');
      return list.children;
    },
    querySelector: (selector) => {
      assert.equal(selector, '#layer-list .layer button');
      return list.children[0].querySelector('button');
    },
  };
  const source = (await readFile(new URL('../src/popups/settings.js', import.meta.url), 'utf8'))
    .replace(/^import[\s\S]*?from ['"][^'"]+['"];?/gm, '');
  vm.runInNewContext(source, {
    document,
    window: { close() { closed = true; } },
    Sortable: { create(node, options) {
      if (node === list) sorting = options;
      else {
        assert.equal(node.className, 'gradient-controls');
        gradientSorting.set(node, options);
      }
    } },
    ACTIVITY_OPTIONS, COLOR_OPTIONS, normalizeGradientStops, formatLayerPresets, validateLayerPresets,
    getExtensionName: () => 'Strava Heatmap',
    getLayerPresets: async () => presets,
    setLayerPresets: async (value) => { presets = value; },
    resetLayerPresets: async () => { presets = [{ activity: 'all', color: 'orange' }]; },
  });
  await onReady();
  const select = (index, kind) => list.children[index].querySelector(`.layer-${kind}`);
  assert.equal(select(0, 'period').value, 'global');
  assert.equal(select(1, 'period').value, 'weekly');
  assert.equal(ids['apply-settings'].disabled, true, 'old global presets must not look changed');
  assert.equal(select(0, 'period').options.find((o) => o.value === 'weekly').disabled, true);
  assert.equal(select(1, 'period').options.find((o) => o.value === 'global').disabled, true);
  assert.equal(select(0, 'activity').value, select(1, 'activity').value);
  assert.deepEqual(select(0, 'color').options.map((o) => o.value),
    select(1, 'color').options.map((o) => o.value));

  await ids['add-layer'].onclick();
  select(2, 'period').value = 'weekly';
  await select(2, 'period').onchange();
  assert.equal(ids['apply-settings'].disabled, true, 'type changes must not validate missing sport/color');
  assert.equal(select(2, 'activity').options.find((o) => o.value === 'run').disabled, true);
  select(2, 'activity').value = 'sport_Hike';
  await select(2, 'activity').onchange();
  assert.equal(ids['apply-settings'].disabled, true);
  select(2, 'color').value = 'purple';
  await select(2, 'color').onchange();
  assert.equal(ids['apply-settings'].disabled, false);

  list.children.reverse();
  await sorting.onEnd();
  assert.equal(select(0, 'activity').value, 'sport_Hike');
  assert.equal(select(0, 'period').value, 'weekly');
  assert.equal(select(2, 'period').value, 'global');
  await ids['apply-settings'].onclick();
  assert.equal(formatLayerPresets(presets), 'sport_Hike:purple:weekly;run:blue:weekly;run:orange');
  assert.equal(closed, true);

  await list.children[0].querySelector('button').onclick();
  assert.equal(list.children.length, 2);
  assert.equal(select(0, 'period').value, 'weekly');
  await ids['reset-settings'].onclick();
  assert.equal(list.children.length, 1);
  assert.equal(select(0, 'period').value, 'global');
  assert.equal(ids['apply-settings'].disabled, true);

  select(0, 'color').value = 'grayscale';
  await select(0, 'color').onchange();
  const stops = (index) => list.children[index].querySelectorAll('.gradient-stop');
  const input = (index, stop, kind) => stops(index)[stop].querySelector(`.gradient-stop-${kind}`);
  assert.equal(stops(0).length, 2);
  assert.equal(stops(0)[0].querySelector('.gradient-stop-remove').disabled, true);
  input(0, 0, 'color').value = '#123456';
  await input(0, 0, 'color').onchange();
  input(0, 0, 'opacity').value = '20';
  input(0, 0, 'opacity').oninput();
  assert.equal(stops(0)[0].querySelector('output').value, '20%');
  await input(0, 0, 'opacity').onchange();
  await stops(0)[0].querySelector('.gradient-stop-add').onclick();
  assert.equal(stops(0).length, 3);
  assert.equal(input(0, 1, 'color').value, '#899aab');
  assert.equal(input(0, 1, 'opacity').value, '60');
  const controls = list.children[0].querySelector('.gradient-controls');
  controls.children.reverse();
  await gradientSorting.get(controls).onEnd();
  assert.equal(input(0, 0, 'color').value, '#ffffff');
  await stops(0)[1].querySelector('.gradient-stop-remove').onclick();
  assert.equal(stops(0).length, 2);

  await ids['add-layer'].onclick();
  select(1, 'period').value = 'weekly';
  await select(1, 'period').onchange();
  select(1, 'activity').value = 'all';
  await select(1, 'activity').onchange();
  select(1, 'color').value = 'grayscale';
  await select(1, 'color').onchange();
  input(1, 0, 'color').value = '#abcdef';
  await input(1, 0, 'color').onchange();
  input(1, 1, 'opacity').value = '50';
  await input(1, 1, 'opacity').onchange();
  assert.equal(input(0, 1, 'color').value, '#123456', 'weekly edits must not change global stops');
  list.children.reverse();
  await sorting.onEnd();
  assert.equal(select(0, 'period').value, 'weekly');
  assert.equal(input(0, 0, 'color').value, '#abcdef');
  await ids['apply-settings'].onclick();
  assert.equal(formatLayerPresets(presets),
    'all:grayscale:weekly:#abcdef,1|#ffffff,0.5;all:grayscale:#ffffff,1|#123456,0.2');
  await onReady();
  assert.equal(ids['apply-settings'].disabled, true, 'saved gradients and periods must reload unchanged');
  assert.equal(input(0, 1, 'opacity').value, '50');
  assert.equal(input(1, 1, 'color').value, '#123456');
});
