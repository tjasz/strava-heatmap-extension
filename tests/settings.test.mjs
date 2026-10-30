import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { ACTIVITY_OPTIONS, COLOR_OPTIONS } from '../src/clients/common/layers.js';
import { formatLayerPresets, validateLayerPresets } from '../src/background/layers.js';

function element(tagName) {
  const node = {
    tagName, children: [], className: '', dataset: {}, disabled: false,
    appendChild(child) { this.children.push(child); },
    setAttribute(name, value) { this[name] = value; },
    addEventListener(name, callback) { this[`on${name}`] = callback; },
    querySelector(selector) {
      return this.children.find((child) => child.className.split(' ').includes(selector.slice(1)));
    },
    get innerHTML() { return ''; },
    set innerHTML(value) { assert.equal(value, ''); this.children = []; },
  };
  node.classList = {
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
      return list.children[0].children.find((child) => child.tagName === 'button');
    },
  };
  const source = (await readFile(new URL('../src/popups/settings.js', import.meta.url), 'utf8'))
    .replace(/^import[\s\S]*?from ['"][^'"]+['"];?/gm, '');
  vm.runInNewContext(source, {
    document,
    window: { close() { closed = true; } },
    Sortable: { create(node, options) { assert.equal(node, list); sorting = options; } },
    ACTIVITY_OPTIONS, COLOR_OPTIONS, formatLayerPresets, validateLayerPresets,
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

  await list.children[0].children.find((child) => child.tagName === 'button').onclick();
  assert.equal(list.children.length, 2);
  assert.equal(select(0, 'period').value, 'weekly');
  await ids['reset-settings'].onclick();
  assert.equal(list.children.length, 1);
  assert.equal(select(0, 'period').value, 'global');
  assert.equal(ids['apply-settings'].disabled, true);
});
