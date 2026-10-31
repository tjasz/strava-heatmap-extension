import assert from 'node:assert/strict';
import test from 'node:test';
import { installGradientTileRecoloring } from '../src/clients/common/gradient-tiles.js';
import { getLayerConfigs } from '../src/clients/common/layers.js';
import { PALETTES } from '../src/clients/common/palettes.js';

function setup(t, pixels, recolorPalettes = true) {
  const replace = (target, key, value) => {
    const previous = Object.getOwnPropertyDescriptor(target, key);
    Object.defineProperty(target, key, { configurable: true, writable: true, value });
    t.after(() => {
      if (previous) Object.defineProperty(target, key, previous);
      else delete target[key];
    });
  };
  const requests = [];
  const blobs = [];
  const revoked = [];
  let observer;
  let closed = 0;
  const nativeFetch = async (...args) => {
    requests.push(args);
    return new Response(new Blob(['original']), {
      headers: { 'content-length': '8', 'content-encoding': 'gzip' },
    });
  };
  class Image {
    constructor() {
      this.style = { visibility: 'visible' };
      this.listeners = [];
      this.loaded = new Promise((resolve) => { this.resolveLoad = resolve; });
    }
    get src() { return this.source; }
    set src(value) {
      this.source = value;
      for (const listener of this.listeners.splice(0)) listener();
      this.resolveLoad();
    }
    getAttribute() { return this.source ?? null; }
    addEventListener(type, listener) {
      assert.equal(type, 'load');
      this.listeners.push(listener);
    }
  }
  replace(globalThis, 'window', { fetch: nativeFetch });
  replace(globalThis, 'HTMLImageElement', Image);
  replace(globalThis, 'Element', Image);
  replace(globalThis, 'MutationObserver', class {
    constructor(callback) { observer = callback; }
    observe() {}
  });
  replace(globalThis, 'createImageBitmap', async () => ({
    width: pixels.length / 4, height: 1, close() { closed++; },
  }));
  replace(globalThis, 'document', {
    documentElement: {},
    querySelectorAll: () => [],
    createElement(name) {
      assert.equal(name, 'canvas');
      let output;
      return {
        getContext: () => ({
          drawImage() {},
          getImageData: () => ({ data: new Uint8ClampedArray(pixels) }),
          putImageData(image) { output = image.data; },
        }),
        toBlob(callback) { callback(new Blob([output], { type: 'image/png' })); },
      };
    },
  });
  replace(URL, 'createObjectURL', (blob) => {
    blobs.push(blob);
    return `blob:tile-${blobs.length}`;
  });
  replace(URL, 'revokeObjectURL', (url) => revoked.push(url));
  installGradientTileRecoloring({ recolorPalettes });
  return {
    requests, blobs, revoked, Image,
    notify: (records) => observer(records),
    closed: () => closed,
  };
}

const tile = (color, period = 'global') => getLayerConfigs(
  [{ activity: 'ride', color, period }], true, 'test', true
)[0].template.replace('{z}', '12').replace('{x}', '1').replace('{y}', '2');
const bytes = async (blob) => [...new Uint8Array(await blob.arrayBuffer())];

test('fetch recoloring matches every RGBA entry of every preset for both periods', async (t) => {
  const pixels = Array.from({ length: 256 }, (_, red) => [red, 17, 43, 128]).flat();
  const state = setup(t, pixels);
  for (const [color, ramp] of Object.entries(PALETTES)) {
    for (const period of ['global', 'weekly']) {
      const url = tile(color, period);
      const response = await window.fetch(new Request(url));
      assert.deepEqual(
        await bytes(await response.blob()),
        ramp.match(/../g).map((hex) => Number.parseInt(hex, 16)),
        `${color} ${period}`
      );
      assert.equal(response.headers.get('content-type'), 'image/png');
      assert.equal(response.headers.get('content-length'), null);
      assert.equal(response.headers.get('content-encoding'), null);
      assert.equal(state.requests.at(-1)[0].url, url);
    }
  }
  assert.equal(state.closed(), Object.keys(PALETTES).length * 2);
});

test('custom gradients retain interpolation and source alpha with either installation mode', async (t) => {
  for (const recolorPalettes of [false, true]) {
    await t.test(String(recolorPalettes), async (t) => {
      setup(t, [0, 0, 0, 128, 255, 255, 255, 128], recolorPalettes);
      const url = `${tile('pink')}#strava-gradient=12345600-abcdef80`;
      const response = await window.fetch(url);
      assert.deepEqual(await bytes(await response.blob()), [
        0x12, 0x34, 0x56, 0, 0xab, 0xcd, 0xef, 64,
      ]);
    });
  }
});

test('CSS clients leave named palettes untouched; unrelated URLs and fallback images bypass recoloring', async (t) => {
  for (const recolorPalettes of [false, true]) {
    await t.test(String(recolorPalettes), async (t) => {
      const state = setup(t, [128, 128, 128, 255], recolorPalettes);
      const urls = [
        'https://example.com/weeklyheat/1/2/3?heatmap-color=pink',
        'https://raw.githubusercontent.com/example/fallback.png',
        tile('unknown'),
      ];
      if (!recolorPalettes) urls.push(tile('pink'));
      for (const url of urls) {
        assert.equal(await (await window.fetch(url)).text(), 'original');
      }
      assert.equal(state.closed(), 0);
    });
  }
});

test('image src and attribute mutations recolor presets and restore visibility', async (t) => {
  const state = setup(t, [128, 17, 43, 128]);
  for (const mutation of [false, true]) {
    const image = new state.Image();
    const url = tile('pink', mutation ? 'weekly' : 'global');
    if (mutation) {
      image.source = url;
      state.notify([{ type: 'attributes', target: image }]);
    } else {
      image.src = url;
    }
    assert.equal(image.style.visibility, 'hidden');
    await image.loaded;
    assert.equal(image.style.visibility, 'visible');
    assert.equal(image.src, `blob:tile-${state.blobs.length}`);
    assert.deepEqual(
      await bytes(state.blobs.at(-1)),
      PALETTES.pink.slice(128 * 8, 129 * 8).match(/../g).map((hex) => parseInt(hex, 16))
    );
    assert.equal(state.revoked.at(-1), image.src);
  }
});
