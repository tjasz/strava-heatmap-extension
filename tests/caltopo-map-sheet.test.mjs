import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mapSheetRegion, mapSheetAlignment, colorizeMapSheetPixels,
  mapSheetBounds, mapSheetAvailability, renderMapSheet, uploadMapSheet,
  installCalTopoMapSheets,
} from '../src/clients/caltopo.com/map-sheet.js';
import { getLayerConfigs } from '../src/clients/common/layers.js';
import { PALETTES } from '../src/clients/common/palettes.js';

const lng = (x) => x / 32768 * 360 - 180;
const lat = (y) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y / 32768))) * 180 / Math.PI;
const boundsFor = (x, y, columns, rows) => ({
  west: lng(x), north: lat(y), east: lng(x + columns), south: lat(y + rows),
});
const layer = getLayerConfigs([{ activity: 'run', color: 'orange' }], true, '0', true)[0];
const region = mapSheetRegion(boundsFor(6200, 12000, 2, 3));
const reply = (result, status = 'ok') => new Response(JSON.stringify({ result, status }));

function globalValue(t, name, value) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, name, previous);
    else delete globalThis[name];
  });
}

test('tile selection covers partial tiles, excludes touching edges, and enforces the exact 49-tile limit', () => {
  assert.deepEqual(region, {
    minX: 6200, maxX: 6201, minY: 12000, maxY: 12002,
    columns: 2, rows: 3, count: 6, width: 1024, height: 1536,
  });
  assert.equal(mapSheetRegion(boundsFor(6200.2, 12000.2, 1, 1)).count, 4);
  assert.equal(mapSheetRegion(boundsFor(6200.1, 12000.1, 0.1, 0.1)).count, 1);
  const available = (bounds) => mapSheetAvailability({
    pro: true, accountId: 'account', layer, bounds,
  });
  assert.equal(available(boundsFor(6200, 12000, 7, 7)).enabled, true);
  assert.equal(available(boundsFor(6200, 12000, 1, 49)).enabled, true);
  assert.equal(available(boundsFor(6200, 12000, 5, 10)).enabled, false);
  assert.match(available(boundsFor(6200, 12000, 5, 10)).message, /Zoom in/);
  for (const bounds of [
    { west: 179, east: -179, south: 40, north: 41 },
    { west: 0, east: 1, south: 85, north: 90 },
    { west: NaN, east: 1, south: 40, north: 41 },
    { west: 0, east: 0, south: 40, north: 41 },
  ]) {
    assert.throws(() => mapSheetRegion(bounds), /Move the view/);
    assert.equal(available(bounds).enabled, false);
  }
});

test('availability requires CalTopo Pro, an account, and real Strava tiles, and prevents duplicate saves', () => {
  const state = { pro: true, accountId: 'account', layer, bounds: boundsFor(1, 1, 1, 1) };
  assert.equal(mapSheetAvailability(state).enabled, true);
  assert.equal(mapSheetAvailability({ ...state, pro: false }).pro, false);
  assert.equal(mapSheetAvailability({ ...state, accountId: null }).pro, false);
  assert.match(mapSheetAvailability({ ...state, layer: null }).message, /Sign into Strava/);
  const fallback = getLayerConfigs([{ activity: 'run', color: 'orange' }], false, '0')[0];
  assert.equal(mapSheetAvailability({ ...state, layer: fallback }).enabled, false);
  assert.equal(mapSheetAvailability({ ...state, busy: true }).enabled, false);
});

test('both map engines provide the same geographic bounds', () => {
  const bounds = { getSouthWest: () => ({ lat: 40, lng: -112 }), getNorthEast: () => ({ lat: 41, lng: -111 }) };
  const expected = { west: -112, south: 40, east: -111, north: 41 };
  assert.deepEqual(mapSheetBounds({ getBounds: () => bounds }), expected);
  assert.deepEqual(mapSheetBounds({ getBounds: () => ({
    getSouthWest: () => ({ lat: () => 40, lng: () => -112 }),
    getNorthEast: () => ({ lat: () => 41, lng: () => -111 }),
  }) }), expected);
  assert.throws(() => mapSheetBounds(null), /Wait for the map/);
});

test('automatic alignment maps actual image pixels to exact Mercator coordinates, including high latitudes', () => {
  for (const y of [100, 12000, 30000]) {
    const area = mapSheetRegion(boundsFor(6200, y, 7, 7));
    const { properties: p } = mapSheetAlignment(area, 'task', 'title');
    assert.equal(p.x1, 0);
    assert.equal(p.y1, 0);
    assert.equal(p.x2, 3583);
    assert.equal(p.y2, 3583);
    assert.ok(Math.abs(p.lat1 - lat(y)) < 1e-10);
    assert.ok(Math.abs(p.lng1 - lng(6200)) < 1e-10);
    assert.ok(Math.abs(p.lat2 - lat(y + 3583 / 512)) < 1e-10);
    assert.ok(Math.abs(p.lng2 - lng(6200 + 3583 / 512)) < 1e-10);
    assert.equal(p.url, '/tmpgeo/task');
    assert.equal(p.taskid, 'task');
    assert.equal(p.title, 'title');
  }
});

test('all colors reproduce all 256 entries of the displayed RGBA palette, including transparency', () => {
  for (const [color, ramp] of Object.entries(PALETTES)) {
    const pixels = new Uint8ClampedArray(1024);
    for (let i = 0; i < 256; i++) pixels[i * 4] = i;
    colorizeMapSheetPixels(pixels, color);
    assert.equal(Buffer.from(pixels).toString('hex'), ramp.toLowerCase());
  }
  assert.throws(() => colorizeMapSheetPixels(new Uint8ClampedArray(4), 'unknown'), /supported/);
});

function canvasFixture(t) {
  const draws = [];
  const puts = [];
  globalValue(t, 'document', {
    createElement: () => ({
      width: 0, height: 0,
      getContext: () => ({
        drawImage: (image, left, top) => draws.push([image, left, top]),
        getImageData: () => ({ data: new Uint8ClampedArray([128, 128, 128, 255]) }),
        putImageData: (data, left, top) => puts.push([data, left, top]),
      }),
      toDataURL: (type) => { assert.equal(type, 'image/png'); return 'data:image/png;base64,cG5n'; },
    }),
  });
  let closed = 0;
  globalValue(t, 'createImageBitmap', async () => ({
    width: 512, height: 512, close: () => closed++,
  }));
  return { draws, puts, closed: () => closed };
}

test('rendering fetches every z15 tile once, stitches by position, colorizes, and releases bitmaps', async (t) => {
  const fixture = canvasFixture(t);
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push(url);
    assert.equal(options.credentials, 'omit');
    return new Response('png');
  });
  const progress = [];
  const image = await renderMapSheet(region, layer, new AbortController().signal, (message) => progress.push(message));
  assert.equal(image, 'data:image/png;base64,cG5n');
  assert.equal(new Set(requests).size, 6);
  assert.equal(fixture.closed(), 6);
  assert.equal(progress.length, 6);
  assert.deepEqual(fixture.draws.map(([, x, y]) => [x, y]).sort(), [
    [0, 0], [512, 0], [0, 512], [512, 512], [0, 1024], [512, 1024],
  ].sort());
  const paletteEntry = PALETTES.orange.slice(128 * 8, 129 * 8);
  for (const [data] of fixture.puts) assert.equal(Buffer.from(data.data).toString('hex'), paletteEntry);
  for (const url of requests) assert.match(url, /\/run\/grayscale\/15\/620[01]\/1200[012]\.png/);
});

test('rendering rejects oversized views, invalid sources, expired auth, missing tiles, and cancelled work', async (t) => {
  canvasFixture(t);
  const controller = new AbortController();
  await assert.rejects(renderMapSheet({ count: 50 }, layer, controller.signal, () => {}), /49/);
  let requested = 0;
  t.mock.method(globalThis, 'fetch', async () => { requested++; return new Response('', { status: 403 }); });
  await assert.rejects(renderMapSheet(region, layer, controller.signal, () => {}), /HTTP 403/);
  assert.ok(requested <= 4);
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 404 }));
  await assert.rejects(renderMapSheet(region, layer, controller.signal, () => {}), /HTTP 404/);
  const invalid = { ...layer, template: layer.template.replace('content-a.strava.com', 'example.com') };
  await assert.rejects(renderMapSheet(region, invalid, controller.signal, () => {}), /Log into Strava/);
  controller.abort();
  await assert.rejects(renderMapSheet(region, layer, controller.signal, () => {}), { name: 'AbortError' });
});

function uploadOptions(overrides = {}) {
  return {
    region, title: 'Strava Global Heatmap All Foot Sports orange 2026-10-30',
    image: 'data:image/png;base64,cG5n', accountId: 'account',
    signal: new AbortController().signal, progress() {}, pause: async () => {},
    ...overrides,
  };
}

test('upload saves privately to the account, aligns automatically, and polls through completion', async (t) => {
  const requests = [];
  const states = ['Queued . . .', 'Initializing', 'Rendering', 'done'];
  const image = { id: 'image', properties: { maxZoom: 15 }, bbox: [-112, 40, -111, 41] };
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push([url, options]);
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.headers['X-Requested-With'], 'XMLHttpRequest');
    if (url === '/api/v1/rendergeo') {
      assert.equal(options.method, 'POST');
      const payload = JSON.parse(options.body.get('json'));
      assert.equal(payload.shared, false);
      assert.equal(payload.accountId, 'account');
      assert.equal(payload.mapId, null);
      assert.match(payload.title, /^Strava Global Heatmap/);
      assert.match(payload.url, /^data:image\/png;base64,/);
      return reply({ id: 'task', manual: true });
    }
    if (url.startsWith('/rendermanualgeo?')) {
      assert.equal(options.method, undefined);
      assert.deepEqual(JSON.parse(new URL(url, 'https://caltopo.com').searchParams.get('json')),
        mapSheetAlignment(region, 'task', uploadOptions().title));
      return reply({ id: 'task' });
    }
    assert.equal(url, '/api/v1/geoprogress/task');
    return reply({ state: states.shift(), image });
  });
  assert.deepEqual(await uploadMapSheet(uploadOptions()), image);
  assert.equal(requests.length, 6);
});

test('already georeferenced uploads skip manual alignment', async (t) => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requests.push(url);
    return reply(url.includes('rendergeo') ? { id: 'task', manual: false } : { state: 'done', image: { id: 'image' } });
  });
  assert.equal((await uploadMapSheet(uploadOptions())).id, 'image');
  assert.deepEqual(requests, ['/api/v1/rendergeo', '/api/v1/geoprogress/task']);
});

test('upload rejects HTTP, API, render, malformed response, and polling-timeout failures', async (t) => {
  for (const [response, expected] of [
    [() => new Response('', { status: 401 }), /HTTP 401/],
    [() => reply(null, 'error'), /rejected/],
    [() => new Response('<html>Sign in</html>'), /JSON|Unexpected token/],
    [() => reply({}), /task ID/],
  ]) {
    t.mock.method(globalThis, 'fetch', async () => response());
    await assert.rejects(uploadMapSheet(uploadOptions()), expected);
  }
  for (const [result, expected] of [
    [{ state: 'error', message: 'Bad image' }, /Bad image/],
    [{ state: 'done' }, /without returning/],
    [{}, /invalid rendering progress/],
    [{ state: 'Rendering' }, /still rendering/],
  ]) {
    t.mock.method(globalThis, 'fetch', async (url) => reply(
      url.includes('rendergeo') ? { id: 'task', manual: false } : result));
    await assert.rejects(uploadMapSheet(uploadOptions()), expected);
  }
  await assert.rejects(uploadMapSheet(uploadOptions({ accountId: null })), /Pro account/);
});

test('cancellation stops polling and never reports a saved sheet', async (t) => {
  const controller = new AbortController();
  let count = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    count++;
    return reply({ id: 'task', manual: false });
  });
  controller.abort();
  await assert.rejects(uploadMapSheet(uploadOptions({ signal: controller.signal })), { name: 'AbortError' });
  assert.equal(count, 0);
});

class Element {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.attributes = {};
    this.handlers = {};
    this.textContent = '';
    this.isConnected = true;
    this.classList = { toggle() {} };
  }
  append(...elements) { this.children.push(...elements); for (const el of elements) el.parentElement = this; }
  appendChild(el) { this.append(el); return el; }
  after(el) { const i = this.parentElement.children.indexOf(this); this.parentElement.children.splice(i + 1, 0, el); el.parentElement = this.parentElement; }
  cloneNode() { return new Element(this.tagName); }
  closest() { return this.parentElement; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, callback) { this.handlers[name] = callback; }
  showModal() { this.open = true; }
  close() { this.open = false; this.handlers.close?.(); }
  remove() { this.isConnected = false; }
}

test('Add menu integrates Pro and zoom gating, automatically saves, and adds the result through native controls', async (t) => {
  const fixture = canvasFixture(t);
  const canvas = document.createElement('canvas');
  const body = new Element('body');
  const group = new Element('div');
  const item = new Element('div');
  const nativeLine = new Element('div');
  const icon = new Element('img');
  group.append(item);
  item.append(nativeLine);
  nativeLine.append(icon);
  const find = (root, id) => root.id === id ? root : root.children.map((el) => find(el, id)).find(Boolean);
  globalValue(t, 'document', {
    body,
    createElement: (tag) => tag === 'canvas' ? canvas : new Element(tag),
    querySelector: () => icon,
    getElementById: (id) => find(group, id),
  });
  let refresh;
  let observer;
  const added = [];
  let savedFeature;
  const native = {
    MapObjectDAO: { save: (feature, type, success) => { savedFeature = feature; assert.equal(type, 'MapGeoImage'); success(); } },
    mapViewStore: { addToStack: (...args) => added.push(args) },
  };
  const window = {
    sarsoft: { features: { pro: false }, account: { id: 'account' } },
    org: { sarsoft: native },
    setInterval: (callback) => { refresh = callback; },
  };
  globalValue(t, 'window', window);
  globalValue(t, 'MutationObserver', class {
    constructor(callback) { observer = callback; }
    observe() {}
  });
  let bounds = boundsFor(6200, 12000, 1, 1);
  const map = { getBounds: () => ({
    getSouthWest: () => ({ lng: bounds.west, lat: bounds.south }),
    getNorthEast: () => ({ lng: bounds.east, lat: bounds.north }),
  }) };
  installCalTopoMapSheets(() => layer, () => map);
  const menu = group.children[1];
  assert.equal(menu.id, 'strava-heatmap-map-sheet');
  const button = menu.children[0];
  const title = button.children[0].children[1];
  const description = button.children[1];
  assert.match(title.textContent, /\(Pro\)$/);
  assert.equal(button.attributes['aria-disabled'], 'true');
  assert.equal(button.tabIndex, -1);
  window.sarsoft.features.pro = true;
  refresh();
  assert.equal(button.attributes['aria-disabled'], 'false');
  assert.doesNotMatch(title.textContent, /\(Pro\)/);
  bounds = boundsFor(6200, 12000, 5, 10);
  refresh();
  assert.equal(button.attributes['aria-disabled'], 'true');
  assert.match(description.textContent, /Zoom in/);
  button.handlers.click();
  assert.equal(body.children.length, 0);
  bounds = boundsFor(6200, 12000, 1, 1);
  refresh();
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.startsWith('https:')) return new Response('png');
    if (url === '/api/v1/rendergeo') {
      const payload = JSON.parse(options.body.get('json'));
      assert.match(payload.title, /^Strava Global Heatmap All Foot Sports orange \d{4}-\d\d-\d\dT/);
      assert.equal(payload.shared, false);
      return reply({ id: 'task', manual: true });
    }
    if (url.startsWith('/rendermanualgeo?')) return reply({ id: 'task' });
    return reply({ state: 'done', image: { id: 'image', bbox: [-112, 40, -111, 41],
      properties: { maxZoom: 15, downloadableSize: 1024 } } });
  });
  button.handlers.keydown({ key: 'Enter', preventDefault() {} });
  assert.equal(button.attributes['aria-disabled'], 'true', 'disable repeat activation immediately');
  const dialog = body.children[0];
  for (let i = 0; i < 100 && !dialog.children[3].textContent.includes('and added'); i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.match(dialog.children[3].textContent, /saved privately.*and added/i);
  assert.match(dialog.children[2].textContent, /Share publicly: Off/);
  assert.equal(savedFeature.properties.backendImageId, 'image');
  assert.equal(savedFeature.properties.maxZoom, 15);
  assert.deepEqual(added, [['geoimage_image', 1]]);
  assert.equal(fixture.closed(), 1);
  assert.equal(dialog.children[4].textContent, 'Close');
  assert.equal(button.attributes['aria-disabled'], 'false');
  observer();
  assert.equal(group.children.length, 2, 'do not duplicate the menu item');
  t.mock.method(console, 'warn', () => {});
  native.MapObjectDAO.save = (feature, type, success, failure) => failure();
  button.handlers.click();
  const failedDialog = body.children[1];
  for (let i = 0; i < 100 && failedDialog.children[3].attributes.role !== 'alert'; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.match(failedDialog.children[3].textContent, /Saved privately.*but not added/);
  assert.match(failedDialog.children[3].textContent, /editable map/);
  assert.equal(added.length, 1, 'failed map additions must not be put on the layer stack');
});
