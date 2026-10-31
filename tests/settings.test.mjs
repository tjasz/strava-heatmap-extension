import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { ACTIVITY_OPTIONS, COLOR_OPTIONS, normalizeGradientStops } from '../src/clients/common/layers.js';
import {
  formatLayerPresets, validateLayerPresets, validateCustomGradients, resolveGradientLayers,
} from '../src/background/layers.js';
import { PALETTES } from '../src/clients/common/palettes.js';

function element(tagName) {
  const node = {
    tagName, children: [], className: '', dataset: {}, disabled: false,
    appendChild(child) { this.children.push(child); },
    append(...children) { this.children.push(...children); },
    setAttribute(name, value) { this[name] = value; },
    addEventListener(name, callback) { this[`on${name}`] = callback; },
    focus() { this.focused = true; },
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
  if (tagName === 'canvas') {
    node.getContext = () => ({
      createImageData(width, height) { return { data: new Uint8ClampedArray(width * height * 4) }; },
      putImageData(image) { node.image = image; },
    });
  }
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
    'close-settings', 'reset-settings', 'gradient-list', 'add-gradient',
    'layers-tab', 'gradients-tab', 'layers-panel', 'gradients-panel', 'settings-error',
  ].map((id) => [id, element(id === 'layer-list' ? 'ul' : 'button')]));
  const list = ids['layer-list'];
  let onReady;
  let sorting;
  const gradientSorting = new WeakMap();
  let closed = false;
  let gradients = [];
  let nextGradient = 0;
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
    ACTIVITY_OPTIONS, COLOR_OPTIONS, PALETTES, normalizeGradientStops,
    formatLayerPresets, validateLayerPresets, validateCustomGradients, resolveGradientLayers,
    crypto: { randomUUID: () => `custom-${++nextGradient}` },
    console,
    getExtensionName: () => 'Strava Heatmap',
    getGradientSettings: async () => structuredClone({ layers: presets, gradients }),
    setGradientSettings: async (value, palettes) => {
      presets = structuredClone(value);
      gradients = structuredClone(palettes);
    },
    resetLayerPresets: async () => { presets = [{ activity: 'all', color: 'orange' }]; },
  });
  await onReady();
  const select = (index, kind) => list.children[index].querySelector(`.layer-${kind}`);
  assert.equal(select(0, 'period').value, 'global');
  assert.equal(select(1, 'period').value, 'weekly');
  assert.equal(ids['apply-settings'].disabled, true, 'old global presets must not look changed');
  assert.equal(select(0, 'period').options.find((o) => o.value === 'weekly').disabled, false);
  assert.equal(select(1, 'period').options.find((o) => o.value === 'global').disabled, false);
  assert.equal(select(0, 'activity').value, select(1, 'activity').value);
  assert.deepEqual(select(0, 'color').options.map((o) => o.value),
    select(1, 'color').options.map((o) => o.value));

  await ids['add-layer'].onclick();
  select(2, 'period').value = 'weekly';
  await select(2, 'period').onchange();
  assert.equal(ids['apply-settings'].disabled, true, 'type changes must not validate missing sport/color');
  assert.equal(select(2, 'activity').options.find((o) => o.value === 'run').disabled, false);
  select(2, 'activity').value = 'run';
  await select(2, 'activity').onchange();
  assert.equal(ids['apply-settings'].disabled, true);
  select(2, 'color').value = 'purple';
  await select(2, 'color').onchange();
  assert.equal(ids['apply-settings'].disabled, false);

  list.children.reverse();
  await sorting.onEnd();
  assert.equal(select(0, 'activity').value, 'run');
  assert.equal(select(0, 'period').value, 'weekly');
  assert.equal(select(2, 'period').value, 'global');
  await ids['apply-settings'].onclick();
  assert.equal(formatLayerPresets(presets), 'run:purple:weekly;run:blue:weekly;run:orange');
  assert.equal(closed, true);

  select(2, 'period').value = 'weekly';
  await select(2, 'period').onchange();
  assert.equal(ids['apply-settings'].disabled, false);
  await ids['apply-settings'].onclick();
  assert.equal(formatLayerPresets(presets), 'run:purple:weekly;run:blue:weekly;run:orange:weekly');

  await list.children[0].querySelector('button').onclick();
  assert.equal(list.children.length, 2);
  assert.equal(select(0, 'period').value, 'weekly');
  await ids['reset-settings'].onclick();
  assert.equal(list.children.length, 1);
  assert.equal(select(0, 'period').value, 'global');
  assert.equal(ids['apply-settings'].disabled, true);

  assert.ok(!select(0, 'color').options.some((option) => option.value === 'grayscale'));
  await ids['gradients-tab'].onclick();
  assert.equal(ids['layers-panel'].hidden, true);
  assert.equal(ids['gradients-panel'].hidden, false);
  assert.equal(ids['gradients-tab']['aria-selected'], 'true');
  ids['gradients-tab'].onkeydown({ key: 'ArrowLeft', preventDefault() {} });
  assert.equal(ids['layers-tab'].focused, true);
  assert.equal(ids['layers-panel'].hidden, false);
  const gradientList = ids['gradient-list'];
  assert.equal(gradientList.children.length, Object.keys(PALETTES).length);
  for (const [index, ramp] of Object.values(PALETTES).entries()) {
    const item = gradientList.children[index];
    assert.equal(item.querySelector('.gradient-edit'), undefined);
    assert.ok(item.querySelector('.gradient-label').textContent.length > 0);
    const preview = item.querySelector('canvas');
    assert.equal(preview.width, 256);
    assert.equal(preview.height, 10);
    assert.equal(Buffer.from(preview.image.data.slice(0, 1024)).toString('hex'), ramp);
  }

  await ids['add-gradient'].onclick();
  const customItem = (index = 0) => gradientList.children[Object.keys(PALETTES).length + index];
  assert.equal(customItem().querySelector('canvas').width, 256);
  assert.equal(customItem().querySelector('canvas').height, 10);
  const name = customItem().querySelector('.gradient-name');
  name.value = 'Trail: colors; 🌲';
  await name.oninput();
  const emoji = customItem().querySelector('.gradient-emoji');
  emoji.value = '🌲';
  await emoji.oninput();
  assert.equal(select(0, 'color').options.find((option) => option.value === 'custom-1').textContent,
    '🌲 Trail: colors; 🌲');
  const stops = (index) => customItem(index).querySelectorAll('.gradient-stop');
  const input = (index, stop, kind) => stops(index)[stop].querySelector(`.gradient-stop-${kind}`);
  assert.equal(stops(0).length, 2);
  assert.equal(stops(0)[0].querySelector('.gradient-stop-remove').disabled, true);
  input(0, 0, 'color').value = '#123456';
  await input(0, 0, 'color').onchange();
  assert.deepEqual([...customItem().querySelector('canvas').image.data.slice(0, 4)],
    [18, 52, 86, 255]);
  input(0, 0, 'opacity').value = '20';
  input(0, 0, 'opacity').oninput();
  assert.equal(stops(0)[0].querySelector('output').value, '20%');
  await input(0, 0, 'opacity').onchange();
  assert.deepEqual([...customItem().querySelector('canvas').image.data.slice(0, 4)],
    [18, 52, 86, 51]);
  await stops(0)[0].querySelector('.gradient-stop-add').onclick();
  assert.equal(stops(0).length, 3);
  assert.equal(input(0, 1, 'color').value, '#899aab');
  assert.equal(input(0, 1, 'opacity').value, '60');
  const controls = customItem().querySelector('.gradient-controls');
  controls.children.reverse();
  await gradientSorting.get(controls).onEnd();
  assert.equal(input(0, 0, 'color').value, '#ffffff');
  assert.deepEqual([...customItem().querySelector('canvas').image.data.slice(0, 4)],
    [255, 255, 255, 255]);
  await stops(0)[1].querySelector('.gradient-stop-remove').onclick();
  assert.equal(stops(0).length, 2);

  await customItem().querySelector('.gradient-done').onclick();
  assert.equal(stops(0).length, 0);
  const customPreview = customItem().querySelector('canvas');
  assert.deepEqual([...customPreview.image.data.slice(0, 4)], [255, 255, 255, 255]);
  assert.deepEqual([...customPreview.image.data.slice(1020, 1024)], [18, 52, 86, 51]);
  select(0, 'color').value = 'custom-1';
  await select(0, 'color').onchange();
  assert.equal(list.children[0].querySelector('.gradient-controls'), undefined);
  await ids['add-layer'].onclick();
  select(1, 'period').value = 'weekly';
  await select(1, 'period').onchange();
  select(1, 'activity').value = 'all';
  await select(1, 'activity').onchange();
  select(1, 'color').value = 'custom-1';
  await select(1, 'color').onchange();
  await customItem().querySelector('.gradient-edit').onclick();
  assert.equal(customItem().querySelector('canvas').width, 256);
  assert.equal(customItem().querySelector('canvas').height, 10);
  input(0, 0, 'color').value = '#abcdef';
  await input(0, 0, 'color').onchange();
  input(0, 1, 'opacity').value = '50';
  await input(0, 1, 'opacity').onchange();
  list.children.reverse();
  await sorting.onEnd();
  assert.equal(select(0, 'period').value, 'weekly');
  await ids['apply-settings'].onclick();
  assert.equal(presets[0].gradientId, 'custom-1');
  assert.deepEqual(presets[0].gradientStops, presets[1].gradientStops);
  assert.equal(presets[0].gradientStops[0].color, '#abcdef');
  assert.equal(presets[0].gradientEmoji, '🌲');
  assert.equal(gradients[0].name, 'Trail: colors; 🌲');
  await onReady();
  assert.equal(ids['apply-settings'].disabled, true, 'saved gradients and periods must reload unchanged');
  assert.equal(select(0, 'color').value, 'custom-1');
  assert.equal(select(1, 'color').value, 'custom-1');
  assert.equal(input(0, 1, 'opacity').value, '50');
  select(1, 'period').value = 'weekly';
  await select(1, 'period').onchange();
  assert.equal(ids['apply-settings'].disabled, false);
  await ids['apply-settings'].onclick();
  assert.ok(presets.every((preset) => preset.period === 'weekly'));
  await onReady();
  assert.equal(ids['apply-settings'].disabled, true);
  assert.equal(input(0, 0, 'color').value, '#abcdef');
  const emptyName = customItem().querySelector('.gradient-name');
  emptyName.value = ' ';
  await emptyName.oninput();
  assert.equal(ids['apply-settings'].disabled, true, 'unnamed gradients cannot be saved');
  emptyName.value = 'Renamed';
  await emptyName.oninput();
  assert.equal(ids['apply-settings'].disabled, false);
  await customItem().querySelector('.gradient-done').onclick();
  assert.equal(customItem().querySelector('.gradient-label').textContent, '🌲 Renamed');
  await ids['apply-settings'].onclick();
  await ids['reset-settings'].onclick();
  assert.equal(gradients.length, 1, 'resetting layers preserves custom palettes');
  assert.equal(select(0, 'color').value, 'orange');
  assert.equal(ids['apply-settings'].disabled, true);

  await ids['add-gradient'].onclick();
  await ids['apply-settings'].onclick();
  assert.equal(gradients.length, 2, 'unused custom palettes are saved');
  await onReady();
  assert.equal(ids['apply-settings'].disabled, true);
});
