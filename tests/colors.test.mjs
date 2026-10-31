import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { injectHeatmapColorFilters } from '../src/clients/common/colors.js';
import { getLayerConfigs } from '../src/clients/common/layers.js';
import { PALETTES } from '../src/clients/common/palettes.js';

const root = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');
const palettes = Object.keys(PALETTES);
const clients = [
  'www.openstreetmap.org',
  'caltopo.com',
  'tjasz.github.io',
  'brouter.de',
];

function createElement(namespaceURI, localName) {
  return {
    namespaceURI,
    localName,
    style: {},
    attributes: {},
    children: [],
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    appendChild(child) {
      this.children.push(child);
    },
  };
}

test('shared filters preserve every Strava palette channel and opacity', (t) => {
  const body = createElement(null, 'body');
  globalThis.document = {
    body,
    createElementNS: createElement,
  };
  t.after(() => { delete globalThis.document; });
  injectHeatmapColorFilters();

  const [svg] = body.children;
  assert.equal(svg.namespaceURI, 'http://www.w3.org/2000/svg');
  assert.equal(svg.id, 'strava-heatmap-filters');
  assert.deepEqual(svg.attributes, { width: '0', height: '0' });
  assert.equal(svg.style.position, 'absolute');
  assert.equal(svg.children.length, palettes.length);

  for (const [index, name] of palettes.entries()) {
    const filter = svg.children[index];
    assert.equal(filter.id, `strava-heatmap-${name}`);
    assert.equal(filter.attributes['color-interpolation-filters'], 'sRGB');
    const [matrix, transfer] = filter.children;
    assert.equal(matrix.localName, 'feColorMatrix');
    assert.equal(matrix.attributes.type, 'matrix');
    assert.equal(
      matrix.attributes.values,
      '1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0'
    );
    assert.equal(transfer.localName, 'feComponentTransfer');
    const bytes = PALETTES[name].match(/../g).map((hex) => parseInt(hex, 16));
    assert.equal(bytes.length, 256 * 4);
    assert.equal(transfer.children.length, 4);
    transfer.children.forEach((channel, offset) => {
      assert.equal(channel.localName, `feFunc${'RGBA'[offset]}`);
      assert.equal(channel.attributes.type, 'table');
      const values = channel.attributes.tableValues.split(' ').map(Number);
      assert.equal(values.length, 256);
      values.forEach((value, intensity) => {
        assert.equal(
          value,
          Number((bytes[intensity * 4 + offset] / 255).toFixed(4)),
          `${name} channel ${offset}, intensity ${intensity}`
        );
      });
    });
  }
});

test('each grayscale-tile client loads the shared palette filters and CSS', async () => {
  const manifest = JSON.parse(await read('manifest.json'));
  const sharedResources = manifest.web_accessible_resources.find(({ resources }) =>
    resources.includes('src/clients/common/colors.js')
  );
  assert.ok(sharedResources);
  assert.ok(sharedResources.resources.includes('src/clients/common/colors.css'));
  assert.ok(sharedResources.resources.includes('src/clients/common/palettes.js'));

  for (const host of clients) {
    const [script, css] = await Promise.all([
      read(`src/clients/${host}/index.js`),
      read(`src/clients/${host}/index.css`),
    ]);
    assert.match(script, /import \{ injectHeatmapColorFilters \} from '\.\.\/common\/colors\.js';/);
    assert.match(script, /injectHeatmapColorFilters\(\);/);
    assert.ok(css.startsWith("@import '../common/colors.css';"));
    assert.ok(sharedResources.matches.includes(`*://${host}/*`), host);
  }
  assert.ok(sharedResources.matches.includes('*://www.caltopo.com/*'));
});

test('every named palette matches its tile URL; custom gradients are not filtered', async () => {
  const css = await read('src/clients/common/colors.css');
  const rules = [...css.matchAll(
    /img:is\(\[src\*='\/globalheat\/'\], \[src\*='\/weeklyheat\/'\]\)\[src\*='([^']+)'\]\s*\{\s*filter: url\(#([^)]+)\);\s*\}/g
  )];
  assert.equal(rules.length, palettes.length);
  const presets = palettes.map((color) => ({ activity: 'ride', color }));
  const configs = getLayerConfigs(presets, true, '0.14.0');
  configs.forEach(({ template }, index) => {
    const name = palettes[index];
    assert.ok(template.includes('/ride/grayscale/'));
    assert.ok(template.includes(`heatmap-color=${name}&`));
    assert.ok(rules.some(([, selector, id]) =>
      template.includes(selector) && id === `strava-heatmap-${name}`
    ));
  });

  const gradient = {
    activity: 'ride',
    color: 'grayscale',
    gradientStops: [
      { color: '#123456', opacity: 0 },
      { color: '#abcdef', opacity: 1 },
    ],
  };
  const [custom] = getLayerConfigs([gradient], true, '0.14.0');
  assert.ok(custom.template.endsWith('#strava-gradient=12345600-abcdefff'));
  assert.ok(rules.every(([, selector]) => !custom.template.includes(selector)));
  const [unauthenticated] = getLayerConfigs(presets, false, '0.14.0');
  assert.ok(rules.every(([, selector]) => !unauthenticated.template.includes(selector)));
});

test('GPX Studio requests grayscale tiles and enables exact palette recoloring', async () => {
  const script = await read('src/clients/gpx.studio/index.js');
  assert.match(script, /getLayerConfigs\(layerPresets, authenticated, version, true\)/);
  assert.match(script, /installGradientTileRecoloring\(\{ recolorPalettes: true \}\)/);
  for (const period of ['global', 'weekly']) {
    const configs = getLayerConfigs(
      palettes.map((color) => ({ activity: 'ride', color, period })),
      true, '0.14.0', true
    );
    configs.forEach(({ template }, index) => {
      assert.ok(template.includes(`heatmap-color=${palettes[index]}&`));
      assert.ok(period === 'weekly'
        ? template.includes('colormap=grayscale')
        : template.includes('/ride/grayscale/'));
    });
  }
});
