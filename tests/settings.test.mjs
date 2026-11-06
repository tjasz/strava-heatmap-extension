import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { ACTIVITY_OPTIONS, COLOR_OPTIONS, normalizeGradientStops } from '../src/clients/common/layers.js';
import {
  formatLayerPresets, validateLayerPresets, validateCustomGradients, resolveGradientLayers,
  getGradientOrder,
} from '../src/background/layers.js';
import { PALETTES } from '../src/clients/common/palettes.js';

function element(tagName) {
  const node = {
    tagName, children: [], className: '', dataset: {}, disabled: false,
    appendChild(child) { child.parentElement = this; this.children.push(child); },
    append(...children) { children.forEach((child) => this.appendChild(child)); },
    remove() {
      this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    },
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
  if (tagName === 'dialog') {
    node.showModal = () => { node.open = true; };
    node.close = () => { node.open = false; node.onclose(); };
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
      set: (value) => {
        const selected = node.options.find((option) => option.value === value);
        node.options.forEach((option) => { option.selected = option === selected; });
      },
    });
  }
  return node;
}

test('palette popup shows exact light/dark previews and supports selection and dismissal', async () => {
  const source = (await readFile(new URL('../src/popups/settings.js', import.meta.url), 'utf8'))
    .replace(/^import[\s\S]*?from ['"][^'"]+['"];?/gm, '');
  const context = vm.createContext({
    document: {
      createElement: element,
      getElementById: () => element('h1'),
      addEventListener() {},
    },
    getExtensionName: () => 'Strava Heatmap',
    COLOR_OPTIONS, PALETTES, getGradientOrder, normalizeGradientStops,
  });
  vm.runInContext(source, context);
  vm.runInContext(`gradients = [{
    id: 'custom-test', name: 'Trail', emoji: 'T',
    gradientStops: [{ color: '#123456', opacity: 0.2 }, { color: '#abcdef', opacity: 1 }],
  }];`, context);
  let changes = 0;
  const picker = context.createColorPicker('blue_dark', () => { changes++; });
  const select = picker.querySelector('.layer-color');
  const trigger = picker.querySelector('.palette-trigger');
  assert.equal(select.hidden, true);
  assert.equal(trigger.textContent, '🔵 Blue (Dark)');
  assert.equal(trigger['aria-haspopup'], 'dialog');
  trigger.onclick();
  const dialog = picker.querySelector('dialog');
  assert.equal(dialog.open, true);
  assert.equal(trigger['aria-expanded'], 'true');
  const light = dialog.querySelector('.palette-light').querySelectorAll('.palette-option');
  const dark = dialog.querySelector('.palette-dark').querySelectorAll('.palette-option');
  assert.deepEqual(light.map((button) => button.dataset.id),
    [...COLOR_OPTIONS.filter(([id]) => id in PALETTES && !id.endsWith('_dark')).map(([id]) => id),
      'custom-test']);
  assert.deepEqual(dark.map((button) => button.dataset.id),
    COLOR_OPTIONS.filter(([id]) => id.endsWith('_dark')).map(([id]) => id));
  assert.equal(dark.find((button) => button.dataset.id === 'blue_dark').focused, true);
  for (const button of [...light, ...dark]) {
    const preview = button.querySelector('canvas');
    assert.equal(preview.width, 256);
    assert.equal(preview.height, 10);
    assert.equal(button['aria-pressed'], String(button.dataset.id === 'blue_dark'));
    if (button.dataset.id in PALETTES) {
      for (let row = 0; row < 10; row++) {
        assert.equal(Buffer.from(preview.image.data.slice(row * 1024, (row + 1) * 1024))
          .toString('hex'), PALETTES[button.dataset.id]);
      }
    } else {
      assert.deepEqual([...preview.image.data.slice(0, 4)], [18, 52, 86, 51]);
    }
  }
  let prevented = false;
  light[0].onkeydown({ key: 'ArrowRight', preventDefault() { prevented = true; } });
  assert.equal(dark[0].focused, true);
  assert.equal(prevented, true);
  dark[0].onkeydown({ key: 'End', preventDefault() {} });
  assert.equal(dark.at(-1).focused, true);
  await dark[0].onclick();
  assert.equal(select.value, dark[0].dataset.id);
  assert.equal(changes, 1);
  assert.equal(picker.querySelector('dialog'), undefined);
  assert.equal(trigger['aria-expanded'], 'false');
  trigger.onclick();
  picker.querySelector('dialog').querySelector('.palette-close').onclick();
  assert.equal(changes, 1, 'dismissal does not change the selection');
  assert.equal(trigger.focused, true);
  trigger.onclick();
  picker.querySelector('dialog').onkeydown({ key: 'Escape', preventDefault() {} });
  assert.equal(picker.querySelector('dialog'), undefined);
  assert.equal(changes, 1, 'Escape dismisses without selecting');
  trigger.onclick();
  await picker.querySelector('dialog').querySelector('.palette-light')
    .querySelectorAll('.palette-option').at(-1).onclick();
  assert.equal(select.value, 'custom-test');
  assert.equal(changes, 2, 'custom gradients remain selectable');

  const empty = context.createColorPicker(undefined, () => {});
  assert.ok(empty.querySelector('.palette-trigger').className.includes('invalid'));
  assert.equal(empty.querySelector('.layer-color').value, '');
});

test('activity selects restore the first occurrence and preserve duplicate choices', async () => {
  const source = (await readFile(new URL('../src/popups/settings.js', import.meta.url), 'utf8'))
    .replace(/^import[\s\S]*?from ['"][^'"]+['"];?/gm, '');
  const context = vm.createContext({
    document: {
      createElement: element,
      getElementById: () => element('h1'),
      addEventListener() {},
    },
    getExtensionName: () => 'Strava Heatmap',
    ACTIVITY_OPTIONS,
  });
  vm.runInContext(source, context);

  for (const activity of ['all', 'run', 'ride', 'water', 'winter', 'sport_Hike']) {
    const select = context.createActivitySelect(activity);
    const matches = select.options.filter((option) => option.value === activity);
    assert.equal(select.value, activity);
    assert.deepEqual(select.options.filter((option) => option.selected), [matches[0]]);
    assert.equal(select.className.includes('invalid'), false);
    if (['run', 'ride', 'water', 'winter'].includes(activity)) {
      assert.equal(matches.length, 2);
      assert.ok(select.children[1].children.includes(matches[0]), 'restore Top Categories');
    }
  }

  const empty = context.createActivitySelect(undefined);
  assert.equal(empty.value, '');
  assert.equal(empty.options[0].selected, true);
  assert.equal(empty.options[0].disabled, true);
  assert.equal(empty.className.includes('invalid'), true);
});

test('custom gradient tabs are hidden by default and require an explicit opt-in', async () => {
  const html = await readFile(new URL('../src/popups/settings.html', import.meta.url), 'utf8');
  assert.match(html, /<div id="settings-tabs"[^>]* hidden>/, 'hide tabs before settings load');
  assert.match(html, /<div id="gradients-panel"[^>]* hidden>/);
  const source = (await readFile(new URL('../src/popups/settings.js', import.meta.url), 'utf8'))
    .replace(/^import[\s\S]*?from ['"][^'"]+['"];?/gm, '');
  for (const stored of [undefined, false, true]) {
    const ids = new Map();
    const writes = [];
    let onReady;
    const context = vm.createContext({
      document: {
        createElement: element,
        getElementById(id) {
          if (!ids.has(id)) ids.set(id, element('div'));
          return ids.get(id);
        },
        addEventListener(name, callback) { onReady = callback; },
        querySelectorAll: () => [],
      },
      browser: { storage: { local: {
        async get(key) {
          assert.equal(key, 'customgradients');
          return stored === undefined ? {} : { customgradients: stored };
        },
        async set(value) { writes.push(structuredClone(value)); },
      } } },
      Sortable: { create() {} },
      getExtensionName: () => 'Strava Heatmap',
      getGradientSettings: async () => ({ layers: [], gradients: [], gradientOrder: [] }),
      getGradientOrder, formatLayerPresets, validateLayerPresets, validateCustomGradients,
      ACTIVITY_OPTIONS, COLOR_OPTIONS, PALETTES, normalizeGradientStops,
      console,
    });
    vm.runInContext(source, context);
    await onReady();
    assert.equal(ids.get('settings-tabs').hidden, stored !== true);
    assert.equal(ids.get('layers-panel').hidden, false, 'layers remain available');
    assert.equal(ids.get('gradients-panel').hidden, true);
    assert.deepEqual(writes, stored === undefined ? [{ customgradients: false }] : []);
    if (stored === true) {
      ids.get('gradients-tab').onclick();
      assert.equal(ids.get('gradients-panel').hidden, false);
      assert.equal(ids.get('layers-panel').hidden, true);
    }
  }
});

test('settings preserve weekly types through editing, adding, sorting, applying and resetting', async () => {
  const ids = Object.fromEntries([
    'layer-list', 'settings-title', 'add-layer', 'apply-settings',
    'close-settings', 'reset-settings', 'gradient-list', 'add-gradient',
    'reset-gradients',
    'layers-tab', 'gradients-tab', 'layers-panel', 'gradients-panel', 'settings-error',
    'settings-tabs',
  ].map((id) => [id, element(id === 'layer-list' ? 'ul' : 'button')]));
  const list = ids['layer-list'];
  let onReady;
  let sorting;
  let paletteSorting;
  const gradientSorting = new WeakMap();
  let closed = false;
  let gradients = [];
  let gradientOrder = getGradientOrder([]);
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
      if (selector === '#gradient-list .gradient-remove') {
        return ids['gradient-list'].querySelectorAll('.gradient-remove');
      }
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
      else if (node === ids['gradient-list']) paletteSorting = options;
      else {
        assert.equal(node.className, 'gradient-controls');
        gradientSorting.set(node, options);
      }
    } },
    ACTIVITY_OPTIONS, COLOR_OPTIONS, PALETTES, normalizeGradientStops,
    formatLayerPresets, validateLayerPresets, validateCustomGradients, resolveGradientLayers,
    getGradientOrder,
    crypto: { randomUUID: () => `custom-${++nextGradient}` },
    console,
    browser: { storage: { local: {
      get: async () => ({ customgradients: true }),
    } } },
    getExtensionName: () => 'Strava Heatmap',
    getGradientSettings: async () => structuredClone({ layers: presets, gradients, gradientOrder }),
    setGradientSettings: async (value, palettes, order) => {
      presets = structuredClone(value);
      gradients = structuredClone(palettes);
      gradientOrder = structuredClone(order);
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

  await list.children[0].querySelector('.layer-remove').onclick();
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
  const builtinColors = COLOR_OPTIONS.filter(([id]) => id in PALETTES);
  for (const [index, [id]] of builtinColors.entries()) {
    const item = gradientList.children[index];
    assert.equal(item.querySelector('.gradient-edit'), undefined);
    assert.equal(item.querySelector('.gradient-remove'), undefined);
    assert.ok(item.querySelector('.gradient-label').textContent.length > 0);
    const preview = item.querySelector('canvas');
    assert.equal(preview.width, 256);
    assert.equal(preview.height, 10);
    assert.equal(Buffer.from(preview.image.data.slice(0, 1024)).toString('hex'), PALETTES[id]);
  }

  await ids['add-gradient'].onclick();
  const customItem = (index = 0) => gradientList.children[Object.keys(PALETTES).length + index];
  assert.equal(customItem().querySelector('canvas').width, 256);
  assert.equal(customItem().querySelector('canvas').height, 10);
  const name = customItem().querySelector('.gradient-name');
  assert.equal(name['aria-description'], 'Maximum 20 characters');
  name.value = 'a'.repeat(20);
  await name.oninput();
  assert.equal(name.value, 'a'.repeat(20));
  name.value += 'b';
  await name.oninput();
  assert.equal(name.value, 'a'.repeat(20), 'names cannot exceed 20 characters');
  name.value = 'e\u0301'.repeat(21);
  await name.oninput();
  assert.equal(name.value, 'e\u0301'.repeat(20), 'names do not split combining characters');
  name.value = 'Trail: colors; 🌲';
  await name.oninput();
  const emoji = customItem().querySelector('.gradient-emoji');
  assert.equal(emoji['aria-description'], 'Maximum 2 characters');
  for (const pair of ['🌲🔥', '👩🏽‍🚀🇸🇮', '👨‍👩‍👧‍👦❤️']) {
    emoji.value = pair;
    await emoji.oninput();
    assert.equal(emoji.value, pair, 'two visible emoji fit, including combined emoji');
    emoji.value += '🌲';
    await emoji.oninput();
    assert.equal(emoji.value, pair, 'extra emoji are removed without splitting the first two');
    assert.ok(select(0, 'color').options.find((option) => option.value === 'custom-1')
      .textContent.startsWith(`${pair} `), 'the dropdown receives the limited value');
  }
  emoji.value = 'abc';
  await emoji.oninput({ isComposing: true });
  assert.equal(emoji.value, 'abc', 'active composition is not interrupted');
  await emoji.oncompositionend();
  assert.equal(emoji.value, 'ab', 'the limit is applied when composition finishes');
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
  assert.ok(customItem().className.split(' ').includes('gradient-summary'));
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
  assert.ok(!customItem().className.split(' ').includes('gradient-summary'));
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

  await customItem(1).querySelector('.gradient-done').onclick();
  const remove = () => customItem().querySelector('.gradient-remove');
  assert.equal(remove().textContent, '🗑️');
  assert.equal(remove()['aria-label'], 'Delete Renamed');
  assert.equal(remove().disabled, false);
  assert.deepEqual(customItem().querySelector('.gradient-actions').children.map((button) => button.className),
    ['gradient-edit', 'gradient-remove']);
  select(0, 'color').value = 'custom-1';
  await select(0, 'color').onchange();
  assert.equal(remove().disabled, true, 'a gradient in use cannot be deleted');
  assert.match(remove().title, /Choose another color/);
  await ids['add-layer'].onclick();
  select(1, 'activity').value = 'run';
  select(1, 'period').value = 'weekly';
  select(1, 'color').value = 'custom-1';
  await select(1, 'color').onchange();
  select(0, 'color').value = 'orange';
  await select(0, 'color').onchange();
  assert.equal(remove().disabled, true, 'every referencing layer must switch colors');
  select(1, 'color').value = 'custom-2';
  await select(1, 'color').onchange();
  assert.equal(remove().disabled, false);
  await ids['apply-settings'].onclick();
  await onReady();
  assert.equal(ids['apply-settings'].disabled, true);
  await remove().onclick();
  assert.equal(gradientList.children.length, Object.keys(PALETTES).length + 1);
  assert.equal(customItem().dataset.id, 'custom-2', 'deletion preserves other custom gradients');
  assert.equal(customItem().querySelector('.gradient-remove').disabled, true);
  assert.ok(list.children.every((item) =>
    !item.querySelector('.layer-color').options.some((option) => option.value === 'custom-1')));
  assert.equal(select(0, 'color').value, 'orange');
  assert.equal(select(1, 'color').value, 'custom-2');
  assert.equal(select(1, 'period').value, 'weekly');
  assert.equal(ids['apply-settings'].disabled, false, 'deleting an unused gradient enables Apply');
  assert.equal(gradients.length, 2, 'deletion is not persisted before Apply');
  await ids['apply-settings'].onclick();
  assert.equal(gradients.length, 1);
  assert.equal(gradients[0].id, 'custom-2');
  await onReady();
  assert.equal(gradientList.children.length, Object.keys(PALETTES).length + 1);
  assert.equal(customItem().dataset.id, 'custom-2');
  assert.equal(select(1, 'color').value, 'custom-2');
  assert.equal(ids['apply-settings'].disabled, true, 'deleted gradients stay deleted after reload');
  select(1, 'color').value = 'blue';
  await select(1, 'color').onchange();
  await customItem().querySelector('.gradient-remove').onclick();
  await ids['apply-settings'].onclick();
  await onReady();
  assert.equal(gradients.length, 0, 'the last custom gradient can be deleted');
  assert.equal(gradientList.children.length, Object.keys(PALETTES).length);

  const defaultOrder = getGradientOrder([]);
  const displayedOrder = () => gradientList.children.map((item) => item.dataset.id);
  assert.equal(paletteSorting.handle, '.gradient-reorder-handle');
  assert.equal(paletteSorting.draggable, '.gradient');
  assert.ok(gradientList.children.every((item) => item.querySelector('.gradient-reorder-handle')));
  gradientList.children.reverse();
  await paletteSorting.onEnd();
  assert.deepEqual(displayedOrder(), [...defaultOrder].reverse());
  assert.deepEqual(select(0, 'color').options.slice(1).map((option) => option.value), displayedOrder());
  assert.equal(select(0, 'color').value, 'orange', 'sorting preserves selected colors');
  assert.equal(ids['apply-settings'].disabled, false);
  await ids['apply-settings'].onclick();
  await onReady();
  assert.deepEqual(displayedOrder(), [...defaultOrder].reverse(), 'preset order persists');
  assert.equal(ids['apply-settings'].disabled, true);

  await ids['add-gradient'].onclick();
  const added = gradientList.children.find((item) => item.dataset.id === 'custom-3');
  await added.querySelector('.gradient-done').onclick();
  gradientList.children.reverse();
  await paletteSorting.onEnd();
  assert.equal(displayedOrder()[0], 'custom-3', 'custom and preset gradients can be interleaved');
  select(0, 'color').value = 'custom-3';
  await select(0, 'color').onchange();
  assert.equal(ids['reset-gradients'].disabled, true);
  select(1, 'color').value = 'custom-3';
  await select(1, 'color').onchange();
  select(0, 'color').value = 'orange';
  await select(0, 'color').onchange();
  assert.equal(ids['reset-gradients'].disabled, true, 'reset checks every referencing layer');
  await ids['apply-settings'].onclick();
  await onReady();
  assert.equal(displayedOrder()[0], 'custom-3', 'mixed order persists');
  select(1, 'color').value = 'blue';
  await select(1, 'color').onchange();
  assert.equal(ids['reset-gradients'].disabled, false);
  const currentPeriods = [select(0, 'period').value, select(1, 'period').value];
  await ids['reset-gradients'].onclick();
  assert.equal(gradients.length, 0, 'reset deletes custom gradients immediately');
  assert.deepEqual(displayedOrder(), defaultOrder);
  assert.deepEqual(gradientOrder, defaultOrder, 'reset persists the preset order immediately');
  assert.deepEqual(presets.map(({ color }) => color), ['orange', 'blue']);
  assert.deepEqual(presets.map(({ period }) => period), currentPeriods);
  assert.equal(ids['apply-settings'].disabled, true);
  await onReady();
  assert.deepEqual(displayedOrder(), defaultOrder);
  assert.equal(gradients.length, 0);
  gradientList.children.reverse();
  await paletteSorting.onEnd();
  await ids['reset-gradients'].onclick();
  assert.deepEqual(displayedOrder(), defaultOrder, 'reset also works without custom gradients');
  assert.equal(ids['apply-settings'].disabled, true);
});
