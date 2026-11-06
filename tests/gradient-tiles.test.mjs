import assert from 'node:assert/strict';
import test from 'node:test';
import { installGradientTileRecoloring } from '../src/clients/common/gradient-tiles.js';
import { getLayerConfigs } from '../src/clients/common/layers.js';
import { PALETTES } from '../src/clients/common/palettes.js';

function setup(t, pixels, recolorPalettes = true, fetchTile) {
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
    if (fetchTile) return fetchTile(...args);
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
      for (const { type, listener } of [...this.listeners]) {
        if (type === 'load') listener();
      }
      this.resolveLoad();
    }
    getAttribute() { return this.source ?? null; }
    addEventListener(type, listener) {
      this.listeners.push({ type, listener });
    }
    removeEventListener(type, listener) {
      this.listeners = this.listeners.filter((entry) => entry.type !== type || entry.listener !== listener);
    }
  }
  const messages = [];
  replace(globalThis, 'window', {
    fetch: nativeFetch, location: { origin: 'https://caltopo.com' },
    postMessage: (message) => messages.push(message),
  });
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
    requests, blobs, revoked, messages, Image,
    notify: (records) => observer(records),
    closed: () => closed,
  };
}

const tile = (color, period = 'global', authenticated = true) => getLayerConfigs(
  [{ activity: 'ride', color, period }], authenticated, 'test', true
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

test('fallback fetches use every palette entry, including on CSS clients', async (t) => {
  const pixels = Array.from({ length: 256 }, (_, intensity) =>
    [intensity, intensity, intensity, 255]).flat();
  for (const recolorPalettes of [false, true]) {
    await t.test(String(recolorPalettes), async (t) => {
      const state = setup(t, pixels, recolorPalettes);
      for (const [color, ramp] of Object.entries(PALETTES)) {
        for (const period of ['global', 'weekly']) {
          const url = tile(color, period, false);
          assert.match(url, /\/heatmap-fallback-grayscale\.png\?/);
          assert.equal(new URL(url).searchParams.get('heatmap-color'), color);
          const response = await window.fetch(new Request(url));
          assert.deepEqual(await bytes(await response.blob()),
            ramp.match(/../g).map((hex) => Number.parseInt(hex, 16)),
            `${color} ${period}`);
        }
      }
      assert.equal(state.closed(), Object.keys(PALETTES).length * 2);
    });
  }
});

test('fallback images retain custom gradient stops and opacity without authentication', async (t) => {
  for (const recolorPalettes of [false, true]) {
    await t.test(String(recolorPalettes), async (t) => {
      setup(t, [0, 0, 0, 255, 255, 255, 255, 255], recolorPalettes);
      for (const period of ['global', 'weekly']) {
        for (const legacy of [false, true]) {
          const [config] = getLayerConfigs([{
            activity: 'ride', color: 'grayscale', period,
            gradientStops: [
              { color: '#123456', opacity: 0 },
              { color: '#abcdef', opacity: 0.5 },
            ],
          }], false, 'test', true, legacy);
          assert.ok(config.template.endsWith('#strava-gradient=12345600-abcdef80'));
          assert.deepEqual(config.zoomExtent, [0, 20]);
          const response = await window.fetch(config.template);
          assert.deepEqual(await bytes(await response.blob()), [
            0x12, 0x34, 0x56, 0, 0xab, 0xcd, 0xef, 128,
          ]);
        }
      }
    });
  }
});

test('fallback image sources and attribute mutations use palettes on CSS clients', async (t) => {
  const state = setup(t, [0, 0, 0, 255, 128, 128, 128, 255, 255, 255, 255, 255], false);
  for (const mutation of [false, true]) {
    const image = new state.Image();
    const url = tile('pink', mutation ? 'weekly' : 'global', false);
    if (mutation) {
      image.source = url;
      state.notify([{ type: 'attributes', target: image }]);
    } else {
      image.src = url;
    }
    assert.equal(image.style.visibility, 'hidden');
    await image.loaded;
    assert.equal(image.style.visibility, 'visible');
    assert.deepEqual(await bytes(state.blobs.at(-1)), [0, 128, 255].flatMap((intensity) =>
      PALETTES.pink.slice(intensity * 8, (intensity + 1) * 8)
        .match(/../g).map((hex) => Number.parseInt(hex, 16))));
    assert.equal(state.revoked.at(-1), image.src);
  }
});

test('CSS clients leave named Strava palettes untouched; unrelated and old fallback URLs bypass recoloring', async (t) => {
  for (const recolorPalettes of [false, true]) {
    await t.test(String(recolorPalettes), async (t) => {
      const state = setup(t, [128, 128, 128, 255], recolorPalettes);
      const urls = [
        'https://example.com/weeklyheat/1/2/3?heatmap-color=pink',
        'https://raw.githubusercontent.com/example/fallback.png',
        'https://raw.githubusercontent.com/example/heatmap-fallback-grayscale.png?heatmap-color=pink',
        'https://raw.githubusercontent.com/tjasz/strava-heatmap-extension/refs/tags/vtest/assets/heatmap-fallback.png?heatmap-color=pink',
        tile('unknown'),
        tile('unknown', 'global', false),
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

test('weekly CSS palette images are recolored after their source becomes a blob URL', async (t) => {
  const state = setup(t, [128, 17, 43, 128], false);
  const image = new state.Image();
  image.src = tile('pink', 'weekly');
  await image.loaded;
  assert.equal(image.style.visibility, 'visible');
  assert.deepEqual(await bytes(state.blobs[0]),
    PALETTES.pink.slice(128 * 8, 129 * 8).match(/../g).map((hex) => parseInt(hex, 16)));
});

test('weekly image failures stay hidden and load a transparent placeholder, without retrying auth or 404', async (t) => {
  for (const status of [401, 403, 404]) {
    await t.test(String(status), async (t) => {
      const state = setup(t, [], false, async () => new Response('failed', { status }));
      const image = new state.Image();
      image.src = tile('pink', 'weekly');
      await image.loaded;
      assert.equal(image.style.visibility, 'hidden');
      assert.match(image.src, /^data:image\/gif/);
      assert.equal(state.requests.length, 1);
      assert.deepEqual(state.messages, status === 404 ? [] :
        [{ type: 'stravaHeatmapTileError', status }]);
      image.src = 'https://example.com/image.png';
      assert.equal(image.style.visibility, 'visible');
    });
  }
});

test('discarding one weekly image leaves a shared download alive until all consumers cancel', async (t) => {
  let signal;
  const state = setup(t, [], false, async (_input, options) => {
    signal = options.signal;
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  });
  const images = [new state.Image(), new state.Image()];
  const url = tile('pink', 'weekly');
  for (const image of images) image.src = url;
  assert.equal(state.requests.length, 1);
  images[0].isConnected = false;
  images[0].querySelectorAll = () => [];
  state.notify([{ removedNodes: [images[0]], addedNodes: [] }]);
  assert.equal(signal.aborted, false);
  images[1].src = 'https://example.com/replacement.png';
  assert.equal(signal.aborted, true);
  await new Promise(setImmediate);
  assert.equal(state.blobs.length, 0);
});

test('a replaced weekly image never receives a stale download', async (t) => {
  let resolve;
  const state = setup(t, [], false, () => new Promise((done) => { resolve = done; }));
  const image = new state.Image();
  image.src = tile('pink', 'weekly');
  image.src = 'https://example.com/replacement.png';
  resolve(new Response('tile'));
  await new Promise(setImmediate);
  assert.equal(image.src, 'https://example.com/replacement.png');
  assert.equal(image.style.visibility, 'visible');
  assert.equal(state.blobs.length, 0);
});

test('removing the src attribute cancels a pending weekly tile', async (t) => {
  let signal;
  const state = setup(t, [], false, async (_input, options) => {
    signal = options.signal;
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  });
  const image = new state.Image();
  image.src = tile('pink', 'weekly');
  state.notify([{ type: 'attributes', target: image }]);
  assert.equal(signal.aborted, true);
  await new Promise(setImmediate);
});
