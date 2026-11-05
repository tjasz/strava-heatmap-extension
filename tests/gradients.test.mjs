import test from 'node:test';
import assert from 'node:assert/strict';
import { getLayerConfigs, parseLayerPresets } from '../src/clients/common/layers.js';
import {
  getGradientSettings, setGradientSettings, formatLayerPresets,
  validateCustomGradients, resolveGradientLayers, resetLayerPresets,
  requestLayerPresets,
} from '../src/background/layers.js';

const gradient = {
  id: 'custom-test',
  name: 'Forest: mist; 🌲',
  emoji: '🌲',
  gradientStops: [
    { color: '#123456', opacity: 0 },
    { color: '#abcdef', opacity: 0.5 },
    { color: '#ffffff', opacity: 1 },
  ],
};

test('named gradients round-trip safely and update every referencing layer', async (t) => {
  const previous = globalThis.browser;
  const state = {};
  globalThis.browser = { storage: { local: {
    get: async () => structuredClone(state),
    set: async (value) => Object.assign(state, structuredClone(value)),
  } } };
  t.after(() => { globalThis.browser = previous; });
  const layers = ['global', 'weekly'].map((period) => ({
    activity: 'run', color: 'grayscale', gradientId: gradient.id,
    gradientEmoji: gradient.emoji, gradientStops: gradient.gradientStops, period,
    gradientName: gradient.name,
  }));
  await setGradientSettings(layers, [gradient]);
  const loaded = await getGradientSettings();
  assert.equal(formatLayerPresets(loaded.layers), formatLayerPresets(layers));
  assert.deepEqual(loaded.gradients, [gradient]);
  assert.deepEqual(parseLayerPresets(state.layers), loaded.layers);
  for (const legacy of [false, true]) {
    for (const config of getLayerConfigs(loaded.layers, true, 'test', false, legacy)) {
      assert.ok(config.name.includes('🌲'));
      assert.equal(config.emoji, gradient.emoji);
      assert.equal(config.label, `Strava Heatmap All Foot Sports${config.id.endsWith('-weekly') ? ' (Weekly)' : ''}`);
      assert.equal(config.gradientName, gradient.name);
      assert.ok(config.template.endsWith('#strava-gradient=12345600-abcdef80-ffffffff'));
    }
  }
  const changed = { ...gradient, name: 'Renamed gradient', emoji: '🎨', gradientStops: gradient.gradientStops.slice(0, 2) };
  await setGradientSettings(loaded.layers, [changed]);
  assert.ok(parseLayerPresets(state.layers).every((layer) =>
    layer.gradientEmoji === '🎨' && layer.gradientName === changed.name && layer.gradientStops.length === 2));
  await resetLayerPresets(true);
  assert.deepEqual(state.gradients, [changed]);
  assert.equal((await getGradientSettings()).layers.length, 5);
});

test('client layer requests resolve names for already saved gradients without name metadata', async (t) => {
  const previous = globalThis.browser;
  const layers = [{ activity: 'run', color: 'grayscale', gradientId: gradient.id,
    gradientEmoji: gradient.emoji, gradientStops: gradient.gradientStops }];
  const state = { layers: formatLayerPresets(layers), gradients: [gradient] };
  globalThis.browser = { storage: { local: {
    get: async () => structuredClone(state),
    set: async () => assert.fail('named gradients do not need migration'),
  } } };
  t.after(() => { globalThis.browser = previous; });
  const loaded = parseLayerPresets(await requestLayerPresets());
  assert.equal(loaded[0].gradientName, gradient.name);
  assert.equal(getLayerConfigs(loaded, true, 'test')[0].gradientName, gradient.name);
});

test('old per-layer gradients migrate without losing independent stops or periods', async (t) => {
  const previous = globalThis.browser;
  const state = {
    layers: 'run:grayscale:#123456:#abcdef:0:0.5;run:grayscale:weekly:#ffffff,1|#000000,0.2',
  };
  let writes = 0;
  globalThis.browser = { storage: { local: {
    get: async () => structuredClone(state),
    set: async (value) => { writes++; Object.assign(state, structuredClone(value)); },
  } } };
  t.after(() => { globalThis.browser = previous; });
  const loaded = await getGradientSettings();
  assert.equal(loaded.gradients.length, 2);
  assert.notEqual(loaded.gradients[0].id, loaded.gradients[1].id);
  assert.deepEqual(loaded.gradients[0].gradientStops, gradient.gradientStops.slice(0, 2));
  assert.equal(loaded.layers[1].period, 'weekly');
  assert.deepEqual(loaded.layers[1].gradientStops, [
    { color: '#ffffff', opacity: 1 }, { color: '#000000', opacity: 0.2 },
  ]);
  assert.deepEqual(await getGradientSettings(), loaded);
  assert.equal(writes, 1, 'migration is persistent and idempotent');
});

test('invalid gradients and missing references fail explicitly', async () => {
  assert.equal(validateCustomGradients([gradient]), true);
  for (const invalid of [
    { ...gradient, name: ' ' }, { ...gradient, emoji: '' },
    { ...gradient, gradientStops: [gradient.gradientStops[0]] },
    { ...gradient, gradientStops: [{ color: '#bad', opacity: 2 }, gradient.gradientStops[0]] },
  ]) assert.equal(validateCustomGradients([invalid]), false);
  assert.equal(validateCustomGradients([gradient, gradient]), false);
  assert.throws(() => resolveGradientLayers([
    { activity: 'all', color: 'grayscale', gradientId: 'missing' },
  ], [gradient]), /Unknown gradient/);
  await assert.rejects(setGradientSettings([], [{ ...gradient, name: '' }]), /Invalid/);
});
