import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PALETTES } from '../src/clients/common/palettes.js';

function element(tagName) {
  return {
    tagName,
    style: {},
    children: [],
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    appendChild(child) { this.children.push(child); },
  };
}

for (const renderer of ['leaflet', 'google']) {
  test(`CalTopo ${renderer} uses unshifted 256px tiles and preserves palettes across layer/auth changes`, async (t) => {
    const body = element('body');
    const document = {
      body,
      createElement: element,
      createElementNS: (namespace, tagName) => element(tagName),
      getElementById: () => null,
      querySelectorAll: () => [],
      querySelector: () => ({
        dataset: { version: '0.15.0', authenticated: 'true', layers: 'run:orange' },
      }),
    };
    const listeners = [];
    const overlays = [];
    const map = renderer === 'leaflet' ? {
      addLayer() {},
      removeLayer() {},
    } : {
      overlayMapTypes: {
        getLength: () => overlays.length,
        getAt: (index) => overlays[index],
        push: (overlay) => overlays.push(overlay),
        removeAt: (index) => overlays.splice(index, 1),
        addListener: () => ({ remove() {} }),
      },
    };
    const window = {
      map: { map: { map } },
      addEventListener: (name, callback) => listeners.push(callback),
      setInterval() {},
      clearInterval() {},
      setTimeout() {},
    };
    if (renderer === 'leaflet') {
      window.L = {
        tileLayer: (template, options) => ({
          template,
          options,
          addTo(map) { this._map = map; },
          remove() {},
        }),
      };
    } else {
      window.google = { maps: { Size: class {
        constructor(width, height) {
          this.width = width;
          this.height = height;
        }
      } } };
    }
    const globals = {
      document,
      window,
      localStorage: { getItem: () => null, setItem() {} },
      MutationObserver: class { observe() {} },
    };
    for (const [name, value] of Object.entries(globals)) {
      const previous = Object.getOwnPropertyDescriptor(globalThis, name);
      Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
      t.after(() => {
        if (previous) Object.defineProperty(globalThis, name, previous);
        else delete globalThis[name];
      });
    }

    await import(`../src/clients/caltopo.com/index.js?colors=${renderer}`);
    function assertTiling(maxNativeZoom) {
      const overlay = window.__stravaHeatmapCalTopoOverlay;
      if (renderer === 'leaflet') {
        assert.equal(overlay.options.tileSize, 256);
        assert.equal(overlay.options.zoomOffset ?? 0, 0);
        assert.equal(overlay.options.minZoom, 0);
        assert.equal(overlay.options.maxNativeZoom, maxNativeZoom);
        assert.equal(overlay.options.maxZoom, 21);
        return;
      }

      assert.equal(overlay.tileSize.width, 256);
      assert.equal(overlay.tileSize.height, 256);
      assert.equal(overlay.minZoom, 0);
      assert.equal(overlay.maxZoom, 21);
      for (const zoom of [0, 1, 2, maxNativeZoom]) {
        const count = 2 ** zoom;
        for (const x of [0, count - 1]) {
          for (const y of [0, count - 1]) {
            const tile = overlay.getTile({ x, y }, zoom, document);
            assert.equal(tile.style.width, '256px');
            assert.equal(tile.style.height, '256px');
            assert.equal(tile.children.length, 1);
            const image = tile.children[0];
            const url = new URL(image.src);
            if (maxNativeZoom === 15) {
              assert.ok(url.pathname.endsWith(`/${zoom}/${x}/${y}.png`));
            } else {
              assert.equal(url.searchParams.get('z'), String(zoom));
              assert.equal(url.searchParams.get('x'), String(x));
              assert.equal(url.searchParams.get('y'), String(y));
            }
            assert.equal(image.style.width, '256px');
            assert.equal(image.style.height, '256px');
            assert.equal(image.style.transform, 'scale(1)');
          }
        }
      }
      assert.equal(overlay.getTile({ x: 0, y: -1 }, 2, document).children.length, 0);
      assert.equal(overlay.getTile({ x: 0, y: 4 }, 2, document).children.length, 0);
      assert.equal(overlay.getTile({ x: 0, y: 0 }, -1, document).children.length, 0);
      for (const x of [-1, 7]) {
        const image = overlay.getTile({ x, y: 1 }, 2, document).children[0];
        const url = new URL(image.src);
        if (maxNativeZoom === 15) assert.ok(url.pathname.endsWith('/2/3/1.png'));
        else assert.equal(url.searchParams.get('x'), '3');
      }
      const image = overlay.getTile({ x: 3, y: 5 }, maxNativeZoom + 1, document).children[0];
      const url = new URL(image.src);
      if (maxNativeZoom === 15) {
        assert.ok(url.pathname.endsWith('/15/1/2.png'));
      } else {
        assert.equal(url.searchParams.get('z'), '20');
        assert.equal(url.searchParams.get('x'), '1');
        assert.equal(url.searchParams.get('y'), '2');
      }
      assert.equal(image.style.transform, 'scale(2)');
      assert.equal(image.style.marginLeft, '-256px');
      assert.equal(image.style.marginTop, '-256px');
    }
    assertTiling(15);
    const svg = body.children.find(({ id }) => id === 'strava-heatmap-filters');
    assert.ok(svg, 'filters must be installed before rendering the overlay');
    assert.equal(svg.children.length, Object.keys(PALETTES).length);
    for (const [name, ramp] of Object.entries(PALETTES)) {
      const filter = svg.children.find(({ id }) => id === `strava-heatmap-${name}`);
      assert.equal(filter.attributes['color-interpolation-filters'], 'sRGB');
      assert.equal(filter.children[0].attributes.values,
        '1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0');
      const functions = filter.children[1].children;
      assert.deepEqual(functions.map(({ tagName }) => tagName),
        ['feFuncR', 'feFuncG', 'feFuncB', 'feFuncA']);
      functions.forEach((func, channel) => {
        assert.equal(func.attributes.type, 'table');
        const values = func.attributes.tableValues.split(' ').map(Number);
        assert.equal(values.length, 256);
        values.forEach((value, index) => {
          const offset = (index * 4 + channel) * 2;
          assert.ok(Math.abs(value - parseInt(ramp.slice(offset, offset + 2), 16) / 255) < 0.000051);
        });
      });
    }

    function tileURL() {
      const overlay = window.__stravaHeatmapCalTopoOverlay;
      if (renderer === 'leaflet') return overlay.template;
      return overlay.getTile({ x: 1, y: 1 }, 16, document).children[0].src;
    }
    function message(type, payload) {
      for (const callback of listeners) callback({ source: window, data: { type, payload } });
    }
    assert.match(tileURL(), /\/run\/grayscale\/.*heatmap-color=orange&/);
    message('layerPresetsChanged', 'ride:purple');
    assert.match(tileURL(), /\/ride\/grayscale\/.*heatmap-color=purple&/);
    message('authStatusChanged', false);
    assertTiling(20);
    assert.match(tileURL(), /heatmap-fallback\.png/);
    assert.doesNotMatch(tileURL(), /heatmap-color=/);
    message('authStatusChanged', true);
    assertTiling(15);
    assert.match(tileURL(), /\/ride\/grayscale\/.*heatmap-color=purple&/);
    assert.equal(body.children.filter(({ id }) => id === svg.id).length, 1);
  });
}

test('both clients load shared palette CSS and expose its extension resources', async () => {
  const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url)));
  const css = await readFile(new URL('../src/clients/common/colors.css', import.meta.url), 'utf8');
  for (const color of Object.keys(PALETTES)) {
    assert.ok(css.includes(`[src*='heatmap-color=${color}&']`));
    assert.ok(css.includes(`filter: url(#strava-heatmap-${color});`));
  }
  for (const [client, hosts] of [
    ['caltopo.com', ['*://caltopo.com/*', '*://www.caltopo.com/*']],
    ['www.openstreetmap.org', ['*://www.openstreetmap.org/*']],
  ]) {
    const clientCSS = await readFile(new URL(`../src/clients/${client}/index.css`, import.meta.url), 'utf8');
    assert.ok(clientCSS.startsWith("@import url('../common/colors.css');"));
    for (const host of hosts) {
      const resources = manifest.web_accessible_resources
        .filter(({ matches }) => matches.includes(host))
        .flatMap(({ resources }) => resources);
      for (const file of ['colors.js', 'colors.css', 'palettes.js']) {
        assert.ok(resources.includes(`src/clients/common/${file}`), `${host} must expose ${file}`);
      }
    }
  }
});
