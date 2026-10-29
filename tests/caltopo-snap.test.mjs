import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { project } from '../src/clients/www.openstreetmap.org/slide/algorithm.js';
import { heatmapNetwork, loadHeatmapNetwork } from '../src/clients/caltopo.com/snap-network.js';
import { installCalTopoSnap } from '../src/clients/caltopo.com/snap.js';

const layer = { template: 'https://content-a.strava.com/identified/globalheat/run/blue/{z}/{x}/{y}.png' };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function setup(t, loader = async () => []) {
  const status = { setAttribute(key, value) { this[key] = value; } };
  const previous = globalThis.document;
  globalThis.document = { createElement: () => status };
  t.after(() => { globalThis.document = previous; });
  let change;
  const select = {
    style: {}, after() {},
    addEventListener(name, fn) { change = fn; },
  };
  let currentLayer = layer;
  const nativeClick = () => {};
  const nativeMove = () => {};
  const auto = {
    source: 'strava', data: {}, mapObjs: {}, zoomThreshold: 13, targetZoom: 14,
    map: {
      getZoom: () => 15,
      setStyle(object, style) { Object.assign(object, style); },
      removeOverlay() {},
    },
    getMapBounds: () => [],
    getTileBounds: () => [[1, 2], [1, 2]],
    dropMenu: { container: [select], addItem(label, value) { this.item = { label, value }; } },
    fetch() { this.nativeFetches = (this.nativeFetches || 0) + 1; },
    postFetch(key, features) { (this.results ??= []).push({ key, features }); },
    draw() {},
    clear() { this.mapObjs = {}; this.reference = undefined; this.routing = undefined; },
    rebuildGlobalNodeGrid() {},
    add(id) { this.mapObjs[id] = {}; },
    select(point, id) {
      this.id = id;
      const feature = this.features[id];
      if (this.reference && (!this.routing ||
          !this.routing.solution[feature?.startNodeId] || !this.routing.solution[feature?.endNodeId])) return;
      this.coordinates = [point];
    },
    unselect() { this.id = undefined; },
  };
  const manager = {
    autoDrawOverlay: auto, handleClick: nativeClick, handleMouseMove: nativeMove,
    setOverride(value) { this.override = value; },
    cancel() {}, release() {}, finish() {},
  };
  const integration = installCalTopoSnap(manager, () => currentLayer, loader);
  Object.assign(auto, auto.data.strava);
  return {
    auto, manager, status, select, integration, nativeClick, nativeMove,
    changeSource(source) { auto.source = source; change(); },
    changeLayer(value) { currentLayer = value; },
  };
}

test('installs once and preserves native drawing, previews, commits and undo', (t) => {
  const { auto, manager, select, integration, nativeClick, nativeMove } = setup(t);
  assert.equal(installCalTopoSnap(manager, () => layer), integration);
  assert.deepEqual(auto.dropMenu.item, { label: 'Strava', value: 'strava' });
  assert.equal(select.style.width, 'auto');
  assert.equal(manager.handleClick, nativeClick);
  assert.equal(manager.handleMouseMove, nativeMove);
});

test('loads visible heat network tiles into the native router without fetching vector data', async (t) => {
  const features = [{ geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] } }];
  const calls = [];
  const { auto, status } = setup(t, async (...args) => { calls.push(args); return features; });
  auto.fetch();
  auto.fetch();
  await tick();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 4), [1, 2, 14, layer]);
  assert.deepEqual(auto.results, [{ key: '1-2', features }]);
  assert.equal(auto.nativeFetches, undefined);
  assert.equal(status.textContent, '');
  auto.source = 'osm';
  auto.fetch();
  assert.equal(auto.nativeFetches, 1);
});

test('yellow highlights become wider and brighter on hover and restore on exit', (t) => {
  const { auto } = setup(t);
  auto.add('a');
  auto.add('b');
  assert.deepEqual(auto.mapObjs.a, { stroke: '#F0F000', 'stroke-opacity': 0.4, 'stroke-width': 7 });
  auto.select([1, 2], 'a');
  assert.deepEqual(auto.coordinates, [[1, 2]]);
  assert.deepEqual(auto.mapObjs.a, { stroke: '#FFFF00', 'stroke-opacity': 0.8, 'stroke-width': 10 });
  auto.select([2, 3], 'b');
  assert.equal(auto.mapObjs.a['stroke-width'], 7);
  auto.unselect('b');
  assert.equal(auto.mapObjs.b['stroke-width'], 7);
  auto.source = 'osm';
  auto.select([1, 2], 'a');
  assert.equal(auto.mapObjs.a['stroke-width'], 7);
});

test('hovering a disconnected trail clears the previous draft instead of committing it', (t) => {
  const { auto, manager } = setup(t);
  auto.add('disconnected');
  auto.features.disconnected = { startNodeId: 'c', endNodeId: 'd' };
  auto.reference = { id: 'connected' };
  auto.routing = { solution: { a: {}, b: {} } };
  auto.coordinates = [[1, 1], [2, 2]];
  auto.selected = {};
  manager.override = true;
  auto.select([9, 9], 'disconnected');
  assert.equal(auto.coordinates, undefined);
  assert.equal(auto.selected, undefined);
  assert.equal(manager.override, false);
  assert.equal(auto.mapObjs.disconnected['stroke-width'], 10);
});

for (const action of ['source', 'layer', 'invalidate', 'cancel', 'release', 'finish']) {
  test(`${action} discards a late network response`, async (t) => {
    const job = deferred();
    let signal;
    const context = setup(t, (...args) => { signal = args[4]; return job.promise; });
    const { auto, manager, integration } = context;
    auto.fetch();
    await tick();
    if (action === 'source') context.changeSource('osm');
    else if (action === 'layer') context.changeLayer({ template: 'different' });
    else if (action === 'invalidate') integration.invalidate(false);
    else manager[action]();
    if (action !== 'layer') assert.equal(signal.aborted, true);
    job.resolve([]);
    await tick();
    assert.equal(auto.results, undefined);
  });
}

test('layer refresh clears the old network and draft before reloading', async (t) => {
  const { auto, integration } = setup(t);
  auto.reference = { id: 'old' };
  auto.coordinates = [[1, 1], [2, 2]];
  auto.add('old');
  integration.invalidate();
  assert.deepEqual(auto.mapObjs, {});
  assert.equal(auto.reference, undefined);
  assert.equal(auto.coordinates, undefined);
  await tick();
  assert.equal(auto.results.length, 1);
});

test('network failures are visible and can be retried', async (t) => {
  const previous = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args);
  t.after(() => { console.warn = previous; });
  const { auto, status } = setup(t, async () => { throw new Error('Strava access expired.'); });
  auto.fetch();
  await tick();
  assert.equal(status.role, 'alert');
  assert.match(status.textContent, /Strava access expired/);
  assert.equal(auto.tiles['1-2'], undefined);
  auto.fetch();
  await tick();
  assert.equal(warnings.length, 2);
  assert.equal(auto.results, undefined);
});

test('a successful tile cannot hide another tile failure', async (t) => {
  const previous = console.warn;
  console.warn = () => {};
  t.after(() => { console.warn = previous; });
  const job = deferred();
  const { auto, status } = setup(t, (x) => {
    if (x === 0) throw new Error('Strava access expired.');
    return job.promise;
  });
  auto.getTileBounds = () => [[0, 0], [1, 0]];
  auto.fetch();
  await tick();
  job.resolve([]);
  await tick();
  assert.equal(status.role, 'alert');
  assert.match(status.textContent, /Strava access expired/);
});

test('low zoom and oversized views do not request unbounded imagery', async (t) => {
  let calls = 0;
  const { auto, status } = setup(t, async () => { calls++; return []; });
  auto.map.getZoom = () => 12;
  auto.fetch();
  assert.match(status.textContent, /Zoom in/);
  auto.map.getZoom = () => 15;
  auto.getTileBounds = () => [[0, 20], [20, 0]];
  auto.fetch();
  await tick();
  assert.equal(calls, 0);
  assert.match(status.textContent, /Zoom in/);
});

test('network downloads are limited to two concurrent tiles', async (t) => {
  const jobs = [];
  const { auto } = setup(t, () => {
    const job = deferred();
    jobs.push(job);
    return job.promise;
  });
  auto.getTileBounds = () => [[0, 0], [3, 0]];
  auto.fetch();
  await tick();
  assert.equal(jobs.length, 2);
  jobs[0].resolve([]);
  await tick();
  assert.equal(jobs.length, 3);
  jobs[1].resolve([]);
  await tick();
  assert.equal(jobs.length, 4);
  jobs[2].resolve([]);
  jobs[3].resolve([]);
  await tick();
  assert.equal(auto.results.length, 4);
});

function raster(size, paint) {
  const density = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    density[y * size + x] = paint(x, y);
  }
  return {
    width: size, height: size, x: 10000, y: 10000, zoom: 15,
    density, coverage: new Uint8Array(density.length).fill(1),
  };
}
function pixelFeatures(features) {
  return features.map((feature) => feature.geometry.coordinates.map((loc) =>
    project(loc).map((value) => Math.round(value - 10000))));
}
async function network(image, bounds) {
  return pixelFeatures(await heatmapNetwork(image, bounds ?? {
    minX: image.x, minY: image.y, maxX: image.x + image.width, maxY: image.y + image.height,
  }, new AbortController().signal));
}

test('a broad curved heat band becomes a centerline, not a straight chord', async () => {
  const curve = (x) => 24 + 9 * Math.sin((x - 5) * Math.PI / 50);
  const lines = await network(raster(64, (x, y) =>
    x >= 5 && x <= 55 && Math.abs(y - curve(x)) <= 2 ? 0.8 : 0));
  assert.equal(lines.length, 1);
  assert.ok(lines[0].length > 40);
  for (const [x, y] of lines[0]) assert.ok(Math.abs(y - curve(x)) <= 1.5);
  assert.ok(lines[0].some(([, y]) => y >= 32));
});

test('forks share endpoints and disconnected heat stays disconnected', async () => {
  const lines = await network(raster(32, (x, y) =>
    (y === 10 && x >= 3 && x <= 25) ||
    (x === 14 && y >= 10 && y <= 25) ||
    (y === 28 && x >= 3 && x <= 8) ? 1 : 0));
  assert.equal(lines.length, 4);
  assert.equal(lines.filter((line) => [line[0], line.at(-1)].some(
    ([x, y]) => x === 14 && y === 10)).length, 3);
});

test('a closed heat loop remains a routable closed line', async () => {
  const lines = await network(raster(32, (x, y) =>
    ((x === 8 || x === 24) && y >= 8 && y <= 24) ||
    ((y === 8 || y === 24) && x >= 8 && x <= 24) ? 1 : 0));
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0][0], lines[0].at(-1));
});

test('tile boundaries share exact centerline endpoints', async () => {
  const image = raster(64, (x, y) => y >= 29 && y <= 33 && x > 3 && x < 60 ? 1 : 0);
  const left = await network(image, { minX: 10000, minY: 10000, maxX: 10032, maxY: 10064 });
  const right = await network(image, { minX: 10032, minY: 10000, maxX: 10064, maxY: 10064 });
  const endpoint = (lines) => [lines[0][0], lines[0].at(-1)].find(([x]) => x === 32);
  assert.deepEqual(endpoint(left), endpoint(right));
  assert.ok(endpoint(left));
});

test('empty heat, weak heat, and uncovered pixels create no eligible lines', async () => {
  assert.deepEqual(await network(raster(32, () => 0)), []);
  assert.deepEqual(await network(raster(32, () => 0.01)), []);
  const image = raster(32, (x, y) => y === 10 ? 1 : 0);
  image.coverage.fill(0);
  assert.deepEqual(await network(image), []);
});

test('network extraction respects cancellation', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(heatmapNetwork(raster(32, () => 1), {}, controller.signal), { name: 'AbortError' });
});

test('logged-out fallback imagery cannot become a snap network', async () => {
  await assert.rejects(loadHeatmapNetwork(100, 100, 14, {
    template: 'https://example.com/fallback/{z}/{x}/{y}.png',
  }, new AbortController().signal), /Log into Strava/);
});

function pngChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff;
  for (const byte of body) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  const chunk = Buffer.alloc(body.length + 8);
  chunk.writeUInt32BE(data.length);
  body.copy(chunk, 4);
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, body.length + 4);
  return chunk;
}

test('real PNG tiles produce an eligible centerline at the native tile longitude and latitude', async (t) => {
  const tileX = 3000, tileY = 6000, size = 1024;
  const left = tileX * size, top = tileY * size;
  const heatY = top + 500;
  const previous = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url) => {
    const [, z, tx, ty] = new URL(url).pathname.match(/\/(\d+)\/(\d+)\/(\d+)\.png$/).map(Number);
    requests.push([z, tx, ty]);
    const rows = Buffer.alloc(513 * 512);
    for (let y = 0; y < 512; y++) {
      if (Math.abs(ty * 512 + y - heatY) > 2) continue;
      for (let x = 0; x < 512; x++) {
        const px = tx * 512 + x;
        if (px >= left + 100 && px <= left + 924) rows[y * 513 + x + 1] = 255;
      }
    }
    const header = Buffer.alloc(13);
    header.writeUInt32BE(512);
    header.writeUInt32BE(512, 4);
    header[8] = 8;
    return new Response(Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      pngChunk('IHDR', header),
      pngChunk('IDAT', deflateSync(rows)),
      pngChunk('IEND', Buffer.alloc(0)),
    ]));
  };
  t.after(() => { globalThis.fetch = previous; });
  const features = await loadHeatmapNetwork(tileX, tileY, 14, layer, new AbortController().signal);
  assert.equal(features.length, 1);
  const points = features[0].geometry.coordinates.map((loc) => project(loc));
  assert.ok(points.length > 800);
  for (const [x, y] of points) {
    assert.ok(x >= left + 99 && x <= left + 925);
    assert.ok(Math.abs(y - heatY) <= 1);
  }
  assert.ok(requests.every(([z, x, y]) =>
    z === 15 && Math.abs(x - tileX * 2) <= 2 && Math.abs(y - tileY * 2) <= 2));
});

for (const [status, message] of [
  [401, /Strava access expired/], [403, /Strava access expired/],
  [404, /No heatmap tiles/], [500, /HTTP 500/],
]) {
  test(`HTTP ${status} is surfaced instead of inventing snap lines`, async (t) => {
    const previous = globalThis.fetch;
    globalThis.fetch = async () => new Response(null, { status });
    t.after(() => { globalThis.fetch = previous; });
    await assert.rejects(loadHeatmapNetwork(100, 100, 14, layer,
      new AbortController().signal), message);
  });
}
