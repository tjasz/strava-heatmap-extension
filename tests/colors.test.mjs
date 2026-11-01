import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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

function renderWithByteSurfaces(filter, intensity) {
  let previous = [intensity, intensity, intensity, 255];
  const results = new Map();
  const clamp = (value) => Math.min(1, Math.max(0, value));
  for (const { localName, attributes, children } of filter.children) {
    const input = attributes.in ? results.get(attributes.in) : previous;
    const straight = input.map((value, channel) =>
      channel === 3 ? value / 255 : input[3] ? value / input[3] : 0
    );
    let output;
    if (localName === 'feColorMatrix') {
      const matrix = attributes.values.split(' ').map(Number);
      output = [0, 1, 2, 3].map((row) => clamp(
        straight.reduce((sum, value, column) => sum + value * matrix[row * 5 + column], matrix[row * 5 + 4])
      ));
    } else if (localName === 'feComponentTransfer') {
      output = [...straight];
      for (const child of children) {
        const channel = 'RGBA'.indexOf(child.localName.slice(-1));
        const table = child.attributes.tableValues.split(' ').map(Number);
        const position = straight[channel] * (table.length - 1);
        const index = Math.min(Math.floor(position), table.length - 2);
        output[channel] = table[index] + (table[index + 1] - table[index]) * (position - index);
      }
    } else {
      assert.equal(localName, 'feComposite');
      assert.equal(attributes.operator, 'in');
      const mask = results.get(attributes.in2)[3] / 255;
      previous = input.map((value) => Math.round(value * mask));
      continue;
    }
    previous = output.map((value, channel) =>
      Math.round(value * (channel === 3 ? 1 : output[3]) * 255)
    );
    if (attributes.result) results.set(attributes.result, previous);
  }
  return previous;
}

test('Rainbow preserves the exact weekly ramp from Strava engines 34.0.0 and 35.1.0', () => {
  const rgba = Buffer.from(PALETTES.rainbow, 'hex');
  assert.equal(rgba.length, 256 * 4);
  assert.equal(
    createHash('sha256').update(rgba).digest('hex'),
    'c71298dcd3afb1128cb7db93acafac084c9343077604fb09bf266110fc31f98d'
  );
  assert.equal(rgba[3], 0);
  assert.deepEqual([...rgba.subarray(-4)], [223, 0, 0, 161]);
});

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
    const [matrix, transfer, alphaMatrix, alphaTransfer, composite] = filter.children;
    assert.equal(filter.children.length, 5);
    assert.equal(matrix.localName, 'feColorMatrix');
    assert.equal(matrix.attributes.type, 'matrix');
    assert.equal(
      matrix.attributes.values,
      '1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 0 0 0 0 1'
    );
    assert.equal(matrix.attributes.result, 'intensity');
    assert.equal(transfer.localName, 'feComponentTransfer');
    assert.equal(transfer.attributes.in, 'intensity');
    assert.equal(transfer.attributes.result, 'palette-color');
    assert.equal(alphaMatrix.localName, 'feColorMatrix');
    assert.equal(alphaMatrix.attributes.in, 'intensity');
    assert.equal(alphaMatrix.attributes.type, 'matrix');
    assert.equal(alphaMatrix.attributes.values,
      '0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0 0 0 0');
    assert.equal(alphaTransfer.localName, 'feComponentTransfer');
    assert.equal(alphaTransfer.attributes.result, 'palette-alpha');
    assert.equal(alphaTransfer.children.length, 1);
    assert.equal(composite.localName, 'feComposite');
    assert.deepEqual(composite.attributes, {
      in: 'palette-color', in2: 'palette-alpha', operator: 'in',
    });
    const bytes = PALETTES[name].match(/../g).map((hex) => parseInt(hex, 16));
    assert.equal(bytes.length, 256 * 4);
    assert.equal(transfer.children.length, 3);
    [...transfer.children, ...alphaTransfer.children].forEach((channel, offset) => {
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
    for (let intensity = 0; intensity < 256; intensity++) {
      const rgba = bytes.slice(intensity * 4, intensity * 4 + 4);
      const expected = rgba.map((value, channel) =>
        channel === 3 ? value : Math.round(value * rgba[3] / 255)
      );
      assert.deepEqual(
        renderWithByteSurfaces(filter, intensity), expected,
        `${name} intensity ${intensity} must survive 8-bit premultiplied intermediates`
      );
    }
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
