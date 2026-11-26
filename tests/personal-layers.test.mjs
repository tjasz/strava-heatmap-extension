import test from 'node:test';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { getLayerConfigs, parseLayerPresets } from '../src/clients/common/layers.js';
import { validateLayerPresets } from '../src/background/layers.js';
import { athleteIdFromCredentials } from '../src/background/cookies.js';
import { updateHeatmapRules } from '../src/background/rules.js';

const presets = [
  { activity: 'all', color: 'orange' },
  { activity: 'all', color: 'blue', period: 'personal' },
];

test('personal layer targets the athlete\'s tiles and keeps the palette color', () => {
  const configs = getLayerConfigs(presets, true, '0.15.2.0', true, false, '12345');
  assert.equal(configs.length, 2);
  const url = new URL(configs[1].template.replace('{z}/{x}/{y}', '11/330/715'));
  assert.equal(url.origin, 'https://personal-heatmaps-external.strava.com');
  assert.equal(url.pathname, '/tiles/12345/grayscale/11/330/715@2x.png');
  assert.equal(url.searchParams.get('heatmap-color'), 'blue');
  assert.equal(url.searchParams.get('filter_type'), 'all');
  assert.equal(configs[1].id, 'strava-heatmap-all-personal');
  assert.deepEqual(configs[1].zoomExtent, [0, 14]);
  assert.deepEqual(configs[0].zoomExtent, [0, 15]);
});

test('personal layer is hidden without authentication or an athlete id', () => {
  for (const [authenticated, athleteId] of [[true, null], [false, '12345']]) {
    const configs = getLayerConfigs(presets, authenticated, '0.15.2.0', true, false, athleteId);
    assert.deepEqual(configs.map(({ id }) => id), ['strava-heatmap-all']);
  }
});

test('personal layers filter by the chosen sport', () => {
  const layer = { activity: 'sport_Hike', color: 'blue', period: 'personal' };
  const [hike] = getLayerConfigs([layer], true, '0.15.2.0', true, false, '12345');
  assert.equal(new URL(hike.template.replace(/{[xyz]}/g, '1')).searchParams.get('filter_type'), 'sport_Hike');
  assert.equal(validateLayerPresets([layer]), true);
});

test('request rules authenticate personal tiles and nothing else on that host', async (t) => {
  const previous = globalThis.browser;
  globalThis.browser = {
    declarativeNetRequest: { updateDynamicRules: async () => {} },
  };
  t.after(() => {
    if (previous === undefined) delete globalThis.browser;
    else globalThis.browser = previous;
  });
  const rules = await updateHeatmapRules('test-cookie=value');
  const [{ template }] = getLayerConfigs([presets[1]], true, '0.15.2.0', true, false, '12345');
  const tile = template.replace('{z}/{x}/{y}', '11/330/715');
  const matches = (url) => rules.some(({ condition }) => new RegExp(condition.regexFilter).test(url));
  assert.ok(matches(tile));
  assert.equal(matches('https://personal-heatmaps-external.strava.com/other/12345/x.png'), false);
  assert.equal(matches('https://example.com/tiles/12345/grayscale/11/330/715@2x.png'), false);
});

test('personal presets survive storage validation and parsing', () => {
  const [layer] = parseLayerPresets('all:blue:personal');
  assert.equal(layer.period, 'personal');
  assert.equal(validateLayerPresets([layer]), true);
});

test('athlete id is read from the _strava_idcf session token', () => {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const token = `${part({ typ: 'JWT' })}.${part({ athleteId: 12345 })}.signature`;
  assert.equal(athleteIdFromCredentials(`CloudFront-Policy=x; _strava_idcf=${token}; other=y`), '12345');
  for (const credentials of [null, '', 'other=y', '_strava_idcf=not-a-jwt']) {
    assert.equal(athleteIdFromCredentials(credentials), null);
  }
});

test('only the personal rule carries the login session cookie', async (t) => {
  const previous = globalThis.browser;
  globalThis.browser = {
    declarativeNetRequest: { updateDynamicRules: async () => {} },
  };
  t.after(() => {
    if (previous === undefined) delete globalThis.browser;
    else globalThis.browser = previous;
  });
  const [global, personal] = await updateHeatmapRules('a=1', 'a=1; _strava4_session=s');
  const cookie = (rule) => rule.action.requestHeaders[0].value;
  assert.equal(cookie(global), 'a=1');
  assert.equal(cookie(personal), 'a=1; _strava4_session=s');
  const [, defaulted] = await updateHeatmapRules('a=1');
  assert.equal(cookie(defaulted), 'a=1');
});

test('personal layers are flagged, including repeated layers', () => {
  const personal = { activity: 'all', color: 'blue', period: 'personal' };
  const configs = getLayerConfigs(
    [{ activity: 'all', color: 'blue' }, personal, personal],
    true, '0.15.2.0', true, false, '12345'
  );
  assert.deepEqual(configs.map(({ personal }) => personal === true), [false, true, true]);
});

test('the personal rule, which carries the login session, only fires for supported sites', async (t) => {
  const previous = globalThis.browser;
  globalThis.browser = { declarativeNetRequest: { updateDynamicRules: async () => {} } };
  t.after(() => {
    if (previous === undefined) delete globalThis.browser;
    else globalThis.browser = previous;
  });
  const [, personal] = await updateHeatmapRules('a=1', 'a=1; _strava4_session=s');
  const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
  const sites = manifest.host_permissions
    .map((pattern) => new URL(pattern.replace('*://', 'https://').replace('/*', '/')).hostname)
    .filter((host) => !host.endsWith('strava.com'));
  assert.ok(sites.length > 0);
  for (const site of sites) {
    assert.ok(
      personal.condition.initiatorDomains.some((domain) => site === domain || site.endsWith(`.${domain}`)),
      `${site} must be an allowed initiator`
    );
  }
  assert.equal(personal.condition.excludedInitiatorDomains, undefined);
});
