import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  ACTIVITY_OPTIONS, COLOR_OPTIONS, getLayerConfigs, parseLayerPresets,
} from '../src/clients/common/layers.js';
import {
  formatLayerPresets, getLayerPresets, migrateLayerPresets,
  resetLayerPresets, setLayerPresets, validateLayerPresets,
} from '../src/background/layers.js';
import { updateHeatmapRules } from '../src/background/rules.js';
import { slideTileURL } from '../src/clients/www.openstreetmap.org/slide/tiles.js';
import { mapSheetAvailability } from '../src/clients/caltopo.com/map-sheet.js';

const globalLayer = { activity: 'run', color: 'orange' };
const weeklyLayer = { ...globalLayer, period: 'weekly' };
const configs = (presets, authenticated = true, legacy = false) =>
  getLayerConfigs(presets, authenticated, '0.15.0.2', false, legacy);
const tileURL = (layer) => layer.template.replace('{z}', 14).replace('{x}', 3099).replace('{y}', 6161);

test('presets keep old storage compatible and round-trip mixed weekly layers', () => {
  const encoded = 'run:orange;run:orange:weekly';
  assert.deepEqual(parseLayerPresets(encoded), [globalLayer, weeklyLayer]);
  assert.equal(formatLayerPresets([globalLayer, weeklyLayer]), encoded);
  assert.equal(formatLayerPresets([{ ...globalLayer, period: 'global' }]), 'run:orange');
  assert.equal(validateLayerPresets([globalLayer, weeklyLayer]), true);
  assert.equal(validateLayerPresets([{ ...weeklyLayer, period: 'monthly' }]), false);
  assert.equal(validateLayerPresets([{ color: 'orange', period: 'weekly' }]), false);
});

test('storage, color migration and reset preserve the intended heatmap period', async (t) => {
  const previous = globalThis.browser;
  const state = {};
  globalThis.browser = {
    storage: { local: {
      get: async () => ({ ...state }),
      set: async (value) => Object.assign(state, value),
    } },
  };
  t.after(() => {
    if (previous === undefined) delete globalThis.browser;
    else globalThis.browser = previous;
  });
  await setLayerPresets([globalLayer, { ...weeklyLayer, color: 'hot' }]);
  assert.equal(state.layers, 'run:orange;run:hot:weekly');
  assert.equal(await migrateLayerPresets(), true);
  assert.deepEqual(await getLayerPresets(), [globalLayer, weeklyLayer]);
  assert.equal(await migrateLayerPresets(), false);
  assert.equal(await resetLayerPresets(), false);
  await resetLayerPresets(true);
  assert.equal((await getLayerPresets()).length, 5);
  assert.ok((await getLayerPresets()).every((layer) => layer.period === undefined));
});

test('weekly URLs match the supplied endpoint for every sport and color', () => {
  const sports = ACTIVITY_OPTIONS.flatMap(([, values]) => values.map(([value]) => value));
  for (const activity of sports) {
    for (const [color] of COLOR_OPTIONS) {
      const [layer] = configs([{ activity, color, period: 'weekly' }]);
      const url = new URL(tileURL(layer));
      assert.equal(url.origin, 'https://content-a.strava.com');
      assert.equal(url.pathname, '/weeklyheat/14/3099/6161');
      assert.equal(url.searchParams.get('sport_types'), activity);
      assert.equal(url.searchParams.get('format'), 'png');
      assert.equal(url.searchParams.get('colormap'), 'grayscale');
      assert.equal(url.searchParams.get('missing'), 'empty');
      assert.equal(url.searchParams.get('heatmap-color'), color);
      assert.ok(url.searchParams.get('t'));
      assert.deepEqual(layer.zoomExtent, [0, 15]);
    }
  }
});

test('global URLs stay unchanged and weekly layers have distinct names and IDs', () => {
  const [global, weekly] = configs([globalLayer, weeklyLayer]);
  assert.equal(global.id, 'strava-heatmap-run');
  assert.equal(weekly.id, 'strava-heatmap-run-weekly');
  assert.ok(!global.name.includes('Weekly'));
  assert.ok(weekly.name.endsWith(' (Weekly)'));
  assert.ok(global.description.includes('last year'));
  assert.ok(weekly.description.includes('last week'));
  assert.ok(weekly.description.includes('Strava Premium subscribers only'));
  assert.equal(new URL(tileURL(global)).pathname, '/identified/globalheat/run/grayscale/14/3099/6161.png');
  for (const layer of configs([globalLayer, weeklyLayer], false)) {
    const url = new URL(tileURL(layer));
    assert.equal(url.hostname, 'raw.githubusercontent.com');
    assert.equal(url.searchParams.get('z'), '14');
    assert.deepEqual(layer.zoomExtent, [0, 20]);
  }
});

test('duplicate sports retain unique layer IDs across colors, periods and clients', () => {
  const presets = [
    globalLayer,
    { ...globalLayer, color: 'blue' },
    weeklyLayer,
    { ...weeklyLayer, color: 'purple' },
    globalLayer,
    weeklyLayer,
  ];
  const expected = [
    'strava-heatmap-run',
    'strava-heatmap-run-2',
    'strava-heatmap-run-weekly',
    'strava-heatmap-run-weekly-2',
    'strava-heatmap-run-3',
    'strava-heatmap-run-weekly-3',
  ];
  assert.equal(validateLayerPresets(presets), true);
  assert.deepEqual(parseLayerPresets(formatLayerPresets(presets)), presets);
  for (const authenticated of [false, true]) {
    for (const short of [false, true]) {
      for (const legacy of [false, true]) {
        const layers = getLayerConfigs(presets, authenticated, '0.15.0.2', short, legacy);
        assert.deepEqual(layers.map((layer) => layer.id), expected);
      }
    }
  }
});

test('gpx.studio weekly layers use the same pre-colored palettes as global layers', () => {
  for (const [color] of COLOR_OPTIONS) {
    const [global, weekly] = configs([
      { ...globalLayer, color }, { ...weeklyLayer, color },
    ], true, true);
    const globalColor = new URL(tileURL(global)).pathname.split('/')[4];
    assert.equal(new URL(tileURL(weekly)).searchParams.get('colormap'), globalColor);
  }
});

test('authentication and CORS rules cover weekly and global tiles, not unrelated URLs', async (t) => {
  const previous = globalThis.browser;
  let update;
  globalThis.browser = {
    declarativeNetRequest: { updateDynamicRules: async (value) => { update = value; } },
  };
  t.after(() => {
    if (previous === undefined) delete globalThis.browser;
    else globalThis.browser = previous;
  });
  for (const credentials of ['test-cookie=value', null]) {
    const [rule] = await updateHeatmapRules(credentials);
    assert.equal(update.addRules[0], rule);
    assert.equal(rule.action.requestHeaders?.[0].value, credentials ?? undefined);
    assert.equal(rule.action.responseHeaders[0].value, '*');
    assert.deepEqual(rule.condition.excludedInitiatorDomains, ['strava.com']);
    const pattern = new RegExp(rule.condition.regexFilter);
    for (const layer of configs([globalLayer, weeklyLayer])) {
      assert.ok(pattern.test(tileURL(layer)));
    }
    for (const url of [
      'https://example.com/weeklyheat/14/3099/6161',
      'https://content-a.strava.com/weeklyheat/14/3099/6161/other',
      'https://content-a.strava.com/weeklyheat/not/a/tile',
    ]) assert.equal(pattern.test(url), false);
  }
});

test('Slide and CalTopo map sheets accept weekly URLs without losing their sport or color', () => {
  for (const layer of configs([globalLayer, weeklyLayer])) {
    const url = tileURL(layer);
    assert.equal(slideTileURL({ url: () => url }, 3099, 6161, 14), url);
    assert.equal(mapSheetAvailability({ pro: true, accountId: 'test', layer }).enabled, true);
  }
  const [fallback] = configs([weeklyLayer], false);
  assert.throws(() => slideTileURL({ url: () => tileURL(fallback) }, 3099, 6161, 14), /Log into Strava/);
  assert.equal(mapSheetAvailability({ pro: true, accountId: 'test', layer: fallback }).enabled, false);
  for (const url of [
    'https://example.com/weeklyheat/14/3099/6161',
    'http://content-a.strava.com/weeklyheat/14/3099/6161',
    'https://content-a.strava.com/weeklyheat/14/3099/6161/other',
  ]) assert.throws(() => slideTileURL({ url: () => url }, 3099, 6161, 14), /Log into Strava/);
});

test('every color filter applies to weekly and global heatmap images', async () => {
  const css = await readFile(new URL('../src/clients/common/colors.css', import.meta.url), 'utf8');
  for (const [color] of COLOR_OPTIONS) {
    assert.ok(css.includes(`img:is([src*='/globalheat/'], [src*='/weeklyheat/'])[src*='heatmap-color=${color}&']`));
  }
});
