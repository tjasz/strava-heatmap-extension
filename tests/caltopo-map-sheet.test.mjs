import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mapSheetRegion, mapSheetAlignment, colorizeMapSheetPixels,
  mapSheetAvailability, renderMapSheet, uploadMapSheet,
  installCalTopoMapSheets, limitMapSheetSelection, resizeMapSheetSelection, moveMapSheetSelection, selectMapSheetRegion,
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

test('tile selection covers partial tiles and excludes touching edges', () => {
  assert.deepEqual(region, {
    minX: 6200, maxX: 6201, minY: 12000, maxY: 12002,
    columns: 2, rows: 3, count: 6, width: 1024, height: 1536,
  });
  assert.equal(mapSheetRegion(boundsFor(6200.2, 12000.2, 1, 1)).count, 4);
  assert.equal(mapSheetRegion(boundsFor(6200.1, 12000.1, 0.1, 0.1)).count, 1);
  for (const bounds of [
    { west: 179, east: -179, south: 40, north: 41 },
    { west: 0, east: 1, south: 85, north: 90 },
    { west: NaN, east: 1, south: 40, north: 41 },
    { west: 0, east: 0, south: 40, north: 41 },
  ]) {
    assert.throws(() => mapSheetRegion(bounds), /Move the view/);
  }
});

test('availability ignores viewport zoom and size but requires Pro, Strava tiles, and no existing capture', () => {
  const state = { pro: true, accountId: 'account', layer, bounds: boundsFor(1, 1, 1, 1) };
  assert.equal(mapSheetAvailability(state).enabled, true);
  assert.equal(mapSheetAvailability({ ...state, pro: false }).pro, false);
  assert.equal(mapSheetAvailability({ ...state, accountId: null }).pro, false);
  assert.match(mapSheetAvailability({ ...state, layer: null }).message, /Sign into Strava/);
  const fallback = getLayerConfigs([{ activity: 'run', color: 'orange' }], false, '0')[0];
  assert.equal(mapSheetAvailability({ ...state, layer: fallback }).enabled, false);
  assert.equal(mapSheetAvailability({ ...state, busy: true }).enabled, false);
  for (const bounds of [
    boundsFor(6200, 12000, 1000, 1000),
    { west: -180, south: -90, east: 180, north: 90 },
    undefined,
  ]) {
    const available = mapSheetAvailability({ ...state, bounds });
    assert.equal(available.enabled, true);
    assert.match(available.message, /Adjust an area/);
  }
});

test('selection clamps every drag direction to at most 100 tiles and allows shrinking or redrawing', () => {
  const anchor = [lng(6200.25), lat(12000.25)];
  for (const dx of [-500, -20, -1, 0, 1, 20, 500]) {
    for (const dy of [-500, -20, -1, 0, 1, 20, 500]) {
      const { region: selected } = limitMapSheetSelection(anchor,
        [lng(6200.25 + dx), lat(12000.25 + dy)]);
      assert.ok(selected.count >= 1 && selected.count <= 100, `${dx},${dy}: ${selected.count}`);
      assert.ok(selected.minX <= 6200 && selected.maxX >= 6200);
      assert.ok(selected.minY <= 12000 && selected.maxY >= 12000);
    }
  }
  const exact = limitMapSheetSelection([lng(6200), lat(12000)], [lng(6210), lat(12010)]);
  assert.equal(exact.region.count, 100);
  assert.equal(exact.limited, false);
  const capped = limitMapSheetSelection(anchor, [lng(6220), lat(12020)]);
  assert.equal(capped.region.count, 100);
  assert.equal(capped.limited, true);
  const small = limitMapSheetSelection(anchor, [lng(6201), lat(12001)]);
  assert.equal(small.region.count, 1);
  assert.equal(small.limited, false);
  assert.throws(() => limitMapSheetSelection(anchor, [181, 40]), /world map/);
});

test('all eight resize handles preserve their opposite edges and enforce the tile limit', () => {
  const initial = mapSheetRegion(boundsFor(6200, 12000, 5, 5));
  for (const handle of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) {
    const point = [lng(handle.includes('w') ? 6000 : 6400), lat(handle.includes('n') ? 11800 : 12200)];
    const { region: resized, limited } = resizeMapSheetSelection(initial, handle, point);
    assert.equal(limited, true, handle);
    assert.ok(resized.count >= 1 && resized.count <= 100, `${handle}: ${resized.count}`);
    if (!handle.includes('w')) assert.equal(resized.minX, initial.minX);
    if (!handle.includes('e')) assert.equal(resized.maxX, initial.maxX);
    if (!handle.includes('n')) assert.equal(resized.minY, initial.minY);
    if (!handle.includes('s')) assert.equal(resized.maxY, initial.maxY);
    if (handle.length === 1) assert.equal(resized.count, 100, handle);
    const { region: crossed } = resizeMapSheetSelection(initial, handle,
      [lng(handle.includes('w') ? 6400 : 6000), lat(handle.includes('n') ? 12200 : 11800)]);
    assert.equal(crossed.columns, /[we]/.test(handle) ? 1 : 5);
    assert.equal(crossed.rows, /[ns]/.test(handle) ? 1 : 5);
  }
  const exact = resizeMapSheetSelection(initial, 'se', [lng(6210), lat(12010)]);
  assert.equal(exact.region.count, 100);
  assert.equal(exact.limited, false);
  for (const [x, y] of [[0, 0], [32763, 32763]]) {
    const edge = mapSheetRegion(boundsFor(x, y, 5, 5));
    for (const handle of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) {
      const { region: resized } = resizeMapSheetSelection(edge, handle,
        [lng(handle.includes('w') ? 0 : 32768), lat(handle.includes('n') ? 0 : 32768)]);
      assert.ok(resized.minX >= 0 && resized.maxX < 32768);
      assert.ok(resized.minY >= 0 && resized.maxY < 32768);
      assert.ok(resized.count <= 100);
    }
  }
});

test('moving a selection snaps to whole tiles and clamps at world edges without resizing', () => {
  for (const [columns, rows] of [[1, 1], [2, 3], [10, 10]]) {
    const initial = mapSheetRegion(boundsFor(6200, 12000, columns, rows));
    for (const [dx, dy, x, y] of [
      [2.4, -3.6, 6202, 11996],
      [0.2, -0.2, 6200, 12000],
      [-1e6, -1e6, 0, 0],
      [1e6, 1e6, 32768 - columns, 32768 - rows],
    ]) {
      const moved = moveMapSheetSelection(initial, dx, dy);
      assert.equal(moved.minX, x);
      assert.equal(moved.minY, y);
      for (const key of ['columns', 'rows', 'count', 'width', 'height']) {
        assert.equal(moved[key], initial[key], key);
      }
    }
  }
  assert.throws(() => moveMapSheetSelection(region, NaN, 1), /position/);
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
  const composites = [];
  let canvasCount = 0;
  const createCanvas = () => {
    const index = canvasCount++;
    const canvas = {
      width: 0, height: 0,
      getContext: () => context,
      toDataURL: (type) => { assert.equal(type, 'image/png'); return 'data:image/png;base64,cG5n'; },
    };
    const context = {
      globalAlpha: 1,
      clearRect() {},
      drawImage(image, left, top) {
        if (index === 0) draws.push([image, left, top]);
        else if (image.getContext) composites.push({ opacity: this.globalAlpha, pixels: image.pixels });
      },
      getImageData: () => ({ data: new Uint8ClampedArray([128, 128, 128, 255]) }),
      putImageData(data, left, top) {
        canvas.pixels = Buffer.from(data.data).toString('hex');
        puts.push([data, left, top]);
      },
    };
    return canvas;
  };
  globalValue(t, 'document', {
    createElement: createCanvas,
  });
  let closed = 0;
  globalValue(t, 'createImageBitmap', async () => ({
    width: 512, height: 512, close: () => closed++,
  }));
  return { draws, puts, composites, closed: () => closed, createCanvas };
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

test('map sheets composite every enabled layer in configured order at its own opacity', async (t) => {
  const fixture = canvasFixture(t);
  const layers = getLayerConfigs([
    { activity: 'run', color: 'orange' },
    { activity: 'run', color: 'blue', period: 'weekly' },
  ], true, '0', true).map((layer, index) => ({ ...layer, opacity: index ? 0.7 : 0.3 }));
  const selected = mapSheetRegion(boundsFor(6200, 12000, 1, 1));
  const requests = [];
  const progress = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requests.push(url);
    return new Response('png');
  });
  assert.equal(mapSheetAvailability({ pro: true, accountId: 'account', layer: layers }).enabled, true);
  assert.equal(mapSheetAvailability({ pro: true, accountId: 'account', layer: [] }).enabled, false);
  await renderMapSheet(selected, layers, new AbortController().signal, (message) => progress.push(message));
  assert.equal(requests.length, 2);
  assert.match(requests[0], /identified\/globalheat\/run/);
  assert.match(requests[1], /weeklyheat.*sport_types=run/);
  assert.deepEqual(fixture.composites, [
    { opacity: 0.3, pixels: PALETTES.orange.slice(128 * 8, 129 * 8) },
    { opacity: 0.7, pixels: PALETTES.blue.slice(128 * 8, 129 * 8) },
  ]);
  assert.equal(fixture.draws.length, 1);
  assert.equal(fixture.closed(), 2);
  assert.match(progress.at(-1), /2\/2/);
  await assert.rejects(renderMapSheet(selected, [], new AbortController().signal, () => {}), /Enable/);
  await assert.rejects(renderMapSheet(selected, [{ ...layer, opacity: NaN }],
    new AbortController().signal, () => {}), /opacity/);
});

test('rendering rejects oversized selections, invalid sources, expired auth, missing tiles, and cancelled work', async (t) => {
  canvasFixture(t);
  const controller = new AbortController();
  await assert.rejects(renderMapSheet({ count: 101 }, layer, controller.signal, () => {}), /100/);
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
    this.isConnected = tagName !== 'dialog';
    this.classList = { toggle() {} };
    this.style = {};
    this.pointers = new Set();
  }
  append(...elements) {
    this.children.push(...elements);
    for (const el of elements) {
      if (el.parentElement) {
        el.parentElement.children.splice(el.parentElement.children.indexOf(el), 1);
      }
      el.parentElement = this;
      el.isConnected = this.isConnected;
    }
  }
  appendChild(el) { this.append(el); return el; }
  after(el) { const i = this.parentElement.children.indexOf(this); this.parentElement.children.splice(i + 1, 0, el); el.parentElement = this.parentElement; }
  cloneNode() { return new Element(this.tagName); }
  closest() { return this.parentElement; }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(name, callback) { this.handlers[name] = callback; }
  click() { this.handlers.click?.({ preventDefault() {}, stopPropagation() {} }); }
  removeEventListener(name) { delete this.handlers[name]; }
  focus() {}
  select() {}
  setCustomValidity(message) { this.validationMessage = message; }
  reportValidity() { return !this.validationMessage; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 1000, height: 1000 }; }
  setPointerCapture(id) { this.pointers.add(id); }
  hasPointerCapture(id) { return this.pointers.has(id); }
  releasePointerCapture(id) { this.pointers.delete(id); }
  showModal() { this.open = true; }
  close() { this.open = false; this.handlers.close?.(); }
  remove() {
    this.isConnected = false;
    if (this.parentElement) this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1);
  }
}

function selectionMap(renderer = 'google', initiallyDraggable = true, deferOverlay = false) {
  const container = new Element('div');
  let draggable = initiallyDraggable;
  let zoom = 1;
  let renderedZoom = 1;
  let originX = 6200;
  let originY = 12000;
  let centered = 0;
  let move;
  let boundsChanged;
  let paneX = 0;
  let paneY = 0;
  let attachOverlay;
  let removed = 0;
  const wrapper = {
    fromContainerPixel: ([x, y]) => [lng(originX + x / (100 * 2 ** (renderedZoom - 1))),
      lat(originY + y / (100 * 2 ** (renderedZoom - 1)))],
    toContainerPixel: ([longitude, latitude]) => {
      const x = (longitude + 180) / 360 * 32768;
      const y = (1 - Math.asinh(Math.tan(latitude * Math.PI / 180)) / Math.PI) / 2 * 32768;
      return [(x - originX) * 100 * 2 ** (renderedZoom - 1), (y - originY) * 100 * 2 ** (renderedZoom - 1)];
    },
  };
  const map = renderer === 'google' ? {
    getDiv: () => container,
    get: () => draggable,
    setOptions: (options) => { draggable = options.draggable; },
    addListener: (name, callback) => {
      assert.equal(name, 'bounds_changed');
      boundsChanged = callback;
      return { remove: () => removed++ };
    },
  } : {
    getContainer: () => container,
    containerPointToLatLng: (point) => {
      const [lng, lat] = wrapper.fromContainerPixel(point);
      return { lng, lat };
    },
    latLngToContainerPoint: ([lat, lng]) => {
      const [x, y] = wrapper.toContainerPixel([lng, lat]);
      return { x, y };
    },
    dragging: {
      enabled: () => draggable,
      enable: () => { draggable = true; },
      disable: () => { draggable = false; },
    },
    on: (names, callback) => { move = callback; },
    off: () => removed++,
  };
  map.getZoom = () => zoom;
  map.setZoom = (value) => { zoom = value; boundsChanged?.(); };
  map.setCenter = () => centered++;
  map.panTo = () => centered++;
  const render = () => { renderedZoom = zoom; move?.(); };
  const pane = new Element('div');
  if (renderer === 'google') container.selectionPane = pane;
  const google = { maps: {
    Point: class { constructor(x, y) { this.x = x; this.y = y; } },
    LatLng: class {
      constructor(latitude, longitude) { this.latitude = latitude; this.longitude = longitude; }
      lat() { return this.latitude; }
      lng() { return this.longitude; }
    },
    OverlayView: class {
      getProjection() {
        if (map.getProjection?.() === null) return undefined;
        return {
          fromContainerPixelToLatLng: ({ x, y }, noClampNoWrap) => {
            assert.equal(noClampNoWrap, true);
            const [lng, lat] = wrapper.fromContainerPixel([x, y]);
            return { lng: () => lng, lat: () => lat };
          },
          fromLatLngToDivPixel: (point) => {
            const [x, y] = wrapper.toContainerPixel([point.lng(), point.lat()]);
            return { x: x - paneX, y: y - paneY };
          },
        };
      }
      getPanes() { return { overlayMouseTarget: pane }; }
      setMap(value) {
        if (value) {
          move = () => this.draw();
          attachOverlay = () => { this.onAdd(); render(); };
          if (!deferOverlay) attachOverlay();
        } else {
          move = undefined;
          this.onRemove();
          removed++;
        }
      }
    },
  } };
  return { map, wrapper, container, google, pane, draggable: () => draggable,
    move: render, removed: () => removed, centered: () => centered,
    attachOverlay: () => attachOverlay(),
    pan: (x, y) => { originX += x; originY += y; render(); },
    shiftPane: (x, y) => { paneX = x; paneY = y; render(); } };
}

function selectionBox(container) {
  return container.selectionPane ? container.selectionPane.children[0] : container.children[0].children[0];
}

function selectionPanel(container) {
  return container.children[0].children.at(-1);
}

function pointer(overlay, type, x, y, overrides = {}) {
  overlay.handlers[type]({
    clientX: x, clientY: y, pointerId: 1, button: 0, isPrimary: true,
    preventDefault() {}, stopPropagation() {}, ...overrides,
  });
}

function resizeSelection(container) {
  const box = selectionBox(container);
  const handle = box.children[4];
  const end = [parseFloat(box.style.left) + 100, parseFloat(box.style.top) + 100];
  pointer(handle, 'pointerdown', 0, 0);
  pointer(handle, 'pointermove', ...end);
  pointer(handle, 'pointerup', ...end);
  return selectionPanel(container);
}

function selectionControls(panel) {
  const [heading, instructions, nameLabel, status, actions] = panel.children;
  return {
    heading, instructions, nameInput: nameLabel.children[0], status,
    cancel: actions.children[0], confirm: actions.children[1],
  };
}

for (const renderer of ['google', 'leaflet']) {
  test(`${renderer} starts with up to 100 tiles and resizes through handles without blocking normal map navigation`, async (t) => {
    const document = new Element('document');
    document.createElement = (tag) => new Element(tag);
    const fixture = selectionMap(renderer);
    fixture.container.getBoundingClientRect = () => ({ left: 0, top: 0, width: 2000, height: 2000 });
    globalValue(t, 'document', document);
    globalValue(t, 'window', { map: fixture.wrapper, google: fixture.google });
    let completed = false;
    const work = selectMapSheetRegion(fixture.map, new AbortController().signal, 'Suggested sheet name')
      .then((result) => { completed = true; return result; });
    assert.equal(fixture.draggable(), true);
    const overlay = fixture.container.children[0];
    const box = selectionBox(fixture.container);
    const handle = box.children[4];
    const panel = selectionPanel(fixture.container);
    const { heading, instructions, nameInput, status, confirm } = selectionControls(panel);
    assert.equal(heading.textContent, 'Map Sheet from Strava Heatmap');
    assert.doesNotMatch(instructions.textContent, /zoom buttons|mouse wheel/);
    assert.equal(panel.children.length, 5, 'no separate zoom controls');
    assert.match(confirm.className, /strava-heatmap-map-sheet-primary/);
    assert.equal(confirm.type, 'button');
    assert.equal(box.children.length, 9);
    assert.match(status.textContent, /100\/100 tiles selected/);
    assert.equal(parseFloat(box.style.left), 500);
    assert.ok(Math.abs(parseFloat(box.style.width) - 1000) < 1e-6);
    for (const name of ['pointerdown', 'pointermove', 'pointerup', 'wheel', 'mousedown', 'click']) {
      assert.equal(overlay.handlers[name], undefined, `${name} must remain available to the map`);
    }
    for (const name of ['click', 'dblclick', 'mousedown', 'mouseup', 'contextmenu']) {
      let blocked = false;
      handle.handlers[name]({ preventDefault() {}, stopPropagation() { blocked = true; } });
      assert.equal(blocked, true, `${name} on a resize handle must not reach the map`);
      let stopped = false;
      let defaultPrevented = false;
      const event = {
        stopPropagation() { stopped = true; },
        preventDefault() { defaultPrevented = true; },
      };
      panel.handlers[name]?.(event);
      assert.equal(stopped, true, `${name} in the panel must not reach the map`);
      assert.equal(defaultPrevented, false, `${name} must preserve native text-field editing`);
    }
    assert.equal(nameInput.value, 'Suggested sheet name');
    assert.equal(nameInput.required, true);
    assert.equal(confirm.disabled, false);
    pointer(handle, 'pointerdown', 1300, 1300);
    pointer(handle, 'pointermove', 100000, 100000);
    assert.match(status.textContent, /100\/100 tiles selected/);
    assert.match(status.textContent, /Limit reached/);
    assert.equal(confirm.disabled, true, 'cannot confirm during a drag');
    assert.equal(fixture.draggable(), true, 'resizing must not change native map settings');
    assert.ok(parseFloat(box.style.width) <= 1000.00001);
    pointer(handle, 'pointerup', 100000, 100000);
    handle.handlers.lostpointercapture();
    assert.match(status.textContent, /100\/100 tiles selected/, 'normal capture release must not undo the resize');
    assert.equal(confirm.disabled, false);
    await Promise.resolve();
    assert.equal(completed, false);
    resizeSelection(fixture.container);
    assert.match(status.textContent, /1\/100 tiles selected/);
    const left = parseFloat(box.style.left);
    fixture.pan(1, 0);
    assert.ok(Math.abs(parseFloat(box.style.left) - (left - 100)) < 1e-6);
    fixture.map.setZoom(2);
    fixture.move();
    assert.ok(Math.abs(parseFloat(box.style.width) - 200) < 1e-6);
    assert.match(status.textContent, /1\/100 tiles selected/, 'navigation must not change the selected tiles');
    assert.equal(fixture.centered(), 0, 'selection must not recenter the map while zooming');
    nameInput.value = '   ';
    confirm.handlers.click();
    await Promise.resolve();
    assert.equal(completed, false, 'blank names must not confirm the capture');
    assert.equal(nameInput.validationMessage, 'Enter a sheet name.');
    nameInput.value = renderer === 'google' ? '  My trail map  ' : 'Suggested sheet name';
    nameInput.handlers.input();
    assert.equal(nameInput.validationMessage, '');
    confirm.handlers.click();
    const result = await work;
    assert.equal(result.region.count, 1);
    assert.equal(result.region.minX, 6205);
    assert.equal(result.region.minY, 12005);
    assert.equal(result.title, renderer === 'google' ? 'My trail map' : 'Suggested sheet name');
    assert.equal(fixture.container.children.length, 0);
    assert.equal(fixture.draggable(), true);
    assert.equal(fixture.removed(), 1);
    assert.equal(document.handlers.keydown, undefined);
  });

  test(`${renderer} cancelled resize restores the previous box and Escape preserves an initially locked map`, async (t) => {
    const document = new Element('document');
    document.createElement = (tag) => new Element(tag);
    const fixture = selectionMap(renderer, false);
    globalValue(t, 'document', document);
    globalValue(t, 'window', { map: fixture.wrapper, google: fixture.google });
    const work = selectMapSheetRegion(fixture.map, new AbortController().signal, 'Suggested sheet name');
    const overlay = fixture.container.children[0];
    const box = selectionBox(fixture.container);
    const handle = box.children[4];
    pointer(handle, 'pointerdown', 800, 800);
    pointer(handle, 'pointermove', 1000, 1000);
    pointer(handle, 'pointercancel', 1000, 1000);
    const { status, confirm } = selectionControls(selectionPanel(fixture.container));
    assert.equal(status.textContent, '64/100 tiles selected (8x8).');
    assert.equal(confirm.disabled, false);
    assert.equal(box.hidden, false);
    assert.equal(handle.pointers.size, 0);
    const east = box.children[3];
    east.handlers.keydown({ key: 'ArrowRight', preventDefault() {}, stopPropagation() {} });
    assert.equal(status.textContent, '72/100 tiles selected (9x8).', 'edge handles also support keyboard resizing');
    const south = box.children[5];
    south.handlers.keydown({ key: 'ArrowDown', preventDefault() {}, stopPropagation() {} });
    east.handlers.keydown({ key: 'ArrowRight', preventDefault() {}, stopPropagation() {} });
    east.handlers.keydown({ key: 'ArrowRight', preventDefault() {}, stopPropagation() {} });
    assert.equal(status.textContent, '99/100 tiles selected (11x9).');
    document.handlers.keydown({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
    assert.equal(await work, null);
    assert.equal(fixture.draggable(), false);
    assert.equal(fixture.container.children.length, 0);
    assert.equal(fixture.removed(), 1);
  });

  test(`${renderer} center handle moves without jumping or resizing and supports cancellation and arrow keys`, async (t) => {
    const document = new Element('document');
    document.createElement = (tag) => new Element(tag);
    const fixture = selectionMap(renderer);
    globalValue(t, 'document', document);
    globalValue(t, 'window', { map: fixture.wrapper, google: fixture.google });
    const work = selectMapSheetRegion(fixture.map, new AbortController().signal, 'Moved selection');
    const box = selectionBox(fixture.container);
    const handle = box.children[8];
    const { status, confirm } = selectionControls(selectionPanel(fixture.container));
    assert.equal(handle.attributes['aria-label'], 'Move selected area');
    assert.equal(handle.style.left, '50%');
    assert.equal(handle.style.top, '50%');
    const width = box.style.width;
    const height = box.style.height;
    const left = parseFloat(box.style.left);
    const top = parseFloat(box.style.top);
    pointer(handle, 'pointerdown', 500, 500);
    assert.equal(confirm.disabled, true);
    pointer(handle, 'pointermove', 700, 800, { pointerId: 2 });
    assert.equal(parseFloat(box.style.left), left, 'ignore unrelated pointers');
    pointer(handle, 'pointermove', 500, 500);
    assert.equal(parseFloat(box.style.left), left, 'grabbing the handle must not move the box');
    pointer(handle, 'pointermove', 700, 800);
    assert.ok(Math.abs(parseFloat(box.style.left) - left - 200) < 1e-6);
    assert.ok(Math.abs(parseFloat(box.style.top) - top - 300) < 1e-6);
    assert.equal(box.style.width, width);
    assert.equal(box.style.height, height);
    assert.match(status.textContent, /64\/100 tiles selected/);
    pointer(handle, 'pointercancel', 700, 800);
    assert.ok(Math.abs(parseFloat(box.style.left) - left) < 1e-6);
    assert.ok(Math.abs(parseFloat(box.style.top) - top) < 1e-6);
    assert.equal(handle.hasPointerCapture(1), false);
    assert.equal(confirm.disabled, false);
    handle.handlers.keydown({ key: 'ArrowRight', preventDefault() {}, stopPropagation() {} });
    pointer(handle, 'pointerdown', 500, 500);
    pointer(handle, 'pointermove', 700, 800);
    pointer(handle, 'pointerup', 700, 800);
    handle.handlers.lostpointercapture();
    handle.handlers.keydown({ key: 'ArrowUp', preventDefault() {}, stopPropagation() {} });
    assert.equal(box.style.width, width);
    assert.equal(box.style.height, height);
    assert.equal(fixture.draggable(), true);
    confirm.handlers.click();
    const result = await work;
    assert.equal(result.region.minX, 6204);
    assert.equal(result.region.minY, 12003);
    assert.equal(result.region.columns, 8);
    assert.equal(result.region.rows, 8);
    assert.equal(result.region.count, 64);
  });

  test(`${renderer} can confirm the largest initial centered square without resizing`, async (t) => {
    const document = new Element('document');
    document.createElement = (tag) => new Element(tag);
    const fixture = selectionMap(renderer);
    globalValue(t, 'document', document);
    globalValue(t, 'window', { map: fixture.wrapper, google: fixture.google });
    const work = selectMapSheetRegion(fixture.map, new AbortController().signal, 'Initial selection');
    selectionControls(selectionPanel(fixture.container)).confirm.handlers.click();
    const result = await work;
    assert.equal(result.region.columns, 8);
    assert.equal(result.region.rows, 8);
    assert.equal(result.region.count, 64);
    assert.equal(result.region.minX, 6201);
    assert.equal(result.region.minY, 12001);
  });

  test(`${renderer} initial selection fits the viewport at close zooms with a one-tile minimum`, async (t) => {
    const document = new Element('document');
    document.createElement = (tag) => new Element(tag);
    const window = {};
    globalValue(t, 'document', document);
    globalValue(t, 'window', window);
    for (const [width, height, zoom, columns, rows] of [
      [1000, 1000, 1, 8, 8],
      [1000, 600, 1, 4, 4],
      [400, 1000, 1, 2, 2],
      [2000, 2000, 1, 10, 10],
      [4000, 3000, 1, 10, 10],
      [1000, 1000, 2, 3, 3],
      [1600, 1000, 2, 3, 3],
      [1000, 1000, 3, 1, 1],
      [1000, 1000, 6, 1, 1],
    ]) {
      const fixture = selectionMap(renderer);
      fixture.container.getBoundingClientRect = () => ({ left: 0, top: 0, width, height });
      fixture.map.setZoom(zoom);
      fixture.move();
      Object.assign(window, { map: fixture.wrapper, google: fixture.google });
      const work = selectMapSheetRegion(fixture.map, new AbortController().signal, 'Viewport selection');
      const { confirm } = selectionControls(selectionPanel(fixture.container));
      assert.equal(confirm.disabled, false);
      confirm.handlers.click();
      const { region } = await work;
      const label = `${width}x${height}, zoom ${zoom}`;
      assert.equal(region.columns, columns, label);
      assert.equal(region.rows, rows, label);
      const start = fixture.wrapper.toContainerPixel([lng(region.minX), lat(region.minY)]);
      const end = fixture.wrapper.toContainerPixel([lng(region.maxX + 1), lat(region.maxY + 1)]);
      if (zoom < 6) {
        assert.ok(start[0] >= 16 - 1e-6 && end[0] <= width - 16 + 1e-6, `${label}: horizontal handles`);
        assert.ok(start[1] >= 16 - 1e-6 && end[1] <= height - 16 + 1e-6, `${label}: vertical handles`);
      } else {
        assert.equal(region.count, 1, 'keep one tile even when it cannot fit in the viewport');
      }
    }
  });

  test(`${renderer} viewport fitting stays inside the world near the poles and date line`, async (t) => {
    const document = new Element('document');
    document.createElement = (tag) => new Element(tag);
    const window = {};
    globalValue(t, 'document', document);
    globalValue(t, 'window', window);
    for (const center of [0.5, 32767.5]) {
      const fixture = selectionMap(renderer);
      fixture.pan(center - 5 - 6200, center - 5 - 12000);
      Object.assign(window, { map: fixture.wrapper, google: fixture.google });
      const work = selectMapSheetRegion(fixture.map, new AbortController().signal, 'World edge selection');
      const { confirm } = selectionControls(selectionPanel(fixture.container));
      assert.equal(confirm.disabled, false);
      confirm.handlers.click();
      const { region } = await work;
      assert.equal(region.columns, 5);
      assert.equal(region.rows, 5);
      assert.equal(region.minX, center < 1 ? 0 : 32763);
      assert.equal(region.minY, center < 1 ? 0 : 32763);
    }
  });

  test(`${renderer} fitting does not wrap viewport bounds when the view spans multiple worlds`, async (t) => {
    const document = new Element('document');
    document.createElement = (tag) => new Element(tag);
    const fixture = selectionMap(renderer);
    fixture.container.getBoundingClientRect = () => ({ left: 0, top: 0, width: 6553600, height: 1000 });
    fixture.pan(-16384 - 6200, 0);
    globalValue(t, 'document', document);
    globalValue(t, 'window', { map: fixture.wrapper, google: fixture.google });
    const work = selectMapSheetRegion(fixture.map, new AbortController().signal, 'World-spanning view');
    selectionControls(selectionPanel(fixture.container)).confirm.handlers.click();
    const { region } = await work;
    assert.equal(region.columns, 8);
    assert.equal(region.rows, 8);
    assert.equal(region.minX, 16380);
  });
}

test('initial selection waits for the Google projection and recovers when the map loads', async (t) => {
  const document = new Element('document');
  document.createElement = (tag) => new Element(tag);
  const fixture = selectionMap();
  fixture.map.getProjection = () => null;
  globalValue(t, 'document', document);
  globalValue(t, 'window', { map: fixture.wrapper, google: fixture.google });
  const work = selectMapSheetRegion(fixture.map, new AbortController().signal, 'Initial selection');
  const { status, confirm, cancel } = selectionControls(selectionPanel(fixture.container));
  assert.match(status.textContent, /finish loading/);
  assert.equal(confirm.disabled, true);
  fixture.map.getProjection = () => ({});
  fixture.move();
  assert.match(status.textContent, /64\/100 tiles selected/);
  assert.equal(confirm.disabled, false);
  cancel.handlers.click();
  assert.equal(await work, null);
});

test('Google selection follows render-time projection and native pane offsets through zoom in and out', async (t) => {
  const document = new Element('document');
  document.createElement = (tag) => new Element(tag);
  const fixture = selectionMap();
  globalValue(t, 'document', document);
  globalValue(t, 'window', { map: fixture.wrapper, google: fixture.google });
  const work = selectMapSheetRegion(fixture.map, new AbortController().signal, 'Anchored selection');
  const box = selectionBox(fixture.container);
  const { confirm, status } = selectionControls(selectionPanel(fixture.container));
  assert.equal(box.parentElement, fixture.pane, 'geometry must share the basemap pane transforms');
  assert.ok(Math.abs(parseFloat(box.style.width) - 800) < 1e-6);
  fixture.map.setZoom(2);
  assert.ok(Math.abs(parseFloat(box.style.width) - 800) < 1e-6,
    'zoom state can change before the rendered projection updates');
  fixture.move();
  assert.ok(Math.abs(parseFloat(box.style.width) - 1600) < 1e-6);
  fixture.shiftPane(75, -40);
  fixture.pan(1, 2);
  assert.ok(Math.abs(parseFloat(box.style.left) + 75) < 1e-6);
  assert.ok(Math.abs(parseFloat(box.style.top) + 160) < 1e-6);
  fixture.map.setZoom(0);
  fixture.move();
  assert.ok(Math.abs(parseFloat(box.style.width) - 400) < 1e-6);
  assert.ok(Math.abs(parseFloat(box.style.left) + 75) < 1e-6);
  assert.ok(Math.abs(parseFloat(box.style.top) + 10) < 1e-6);
  assert.match(status.textContent, /64\/100 tiles selected/);
  confirm.handlers.click();
  const result = await work;
  assert.equal(result.region.minX, 6201);
  assert.equal(result.region.minY, 12001);
  assert.equal(result.region.count, 64);
  assert.equal(fixture.pane.children.length, 0, 'remove native geometry when selection ends');
  assert.equal(fixture.removed(), 1);
});

test('Google selection waits for native overlay attachment before initializing its geographic bounds', async (t) => {
  const document = new Element('document');
  document.createElement = (tag) => new Element(tag);
  const fixture = selectionMap('google', true, true);
  globalValue(t, 'document', document);
  globalValue(t, 'window', { map: fixture.wrapper, google: fixture.google });
  const work = selectMapSheetRegion(fixture.map, new AbortController().signal, 'Deferred selection');
  const { status, confirm } = selectionControls(selectionPanel(fixture.container));
  assert.equal(confirm.disabled, true);
  assert.match(status.textContent, /finish loading/);
  fixture.map.setZoom(2);
  fixture.attachOverlay();
  assert.equal(selectionBox(fixture.container).parentElement, fixture.pane);
  assert.equal(confirm.disabled, false);
  confirm.handlers.click();
  const result = await work;
  assert.equal(result.region.minX, 6201);
  assert.equal(result.region.minY, 12001);
  assert.equal(result.region.count, 9);
});

test('aborting an active resize releases pointer capture and leaves map dragging unchanged', async (t) => {
  const document = new Element('document');
  document.createElement = (tag) => new Element(tag);
  const fixture = selectionMap();
  globalValue(t, 'document', document);
  globalValue(t, 'window', { map: fixture.wrapper, google: fixture.google });
  const controller = new AbortController();
  const work = selectMapSheetRegion(fixture.map, controller.signal, 'Suggested sheet name');
  const handle = selectionBox(fixture.container).children[4];
  pointer(handle, 'pointerdown', 800, 800);
  assert.equal(handle.hasPointerCapture(1), true);
  controller.abort();
  await assert.rejects(work, { name: 'AbortError' });
  assert.equal(handle.hasPointerCapture(1), false);
  assert.equal(fixture.container.children.length, 0);
  assert.equal(fixture.draggable(), true);
  assert.equal(document.handlers.keydown, undefined);
});

test('Add menu selects at any zoom, waits for confirmation, then saves privately through native controls', async (t) => {
  const fixture = canvasFixture(t);
  const body = new Element('body');
  const group = new Element('div');
  const item = new Element('div');
  const nativeLine = new Element('div');
  const icon = new Element('img');
  let upgrades = 0;
  item.querySelector = (selector) => {
    assert.equal(selector, '.upgradeCtaButton');
    return { click: () => upgrades++ };
  };
  group.append(item);
  item.append(nativeLine);
  nativeLine.append(icon);
  const find = (root, id) => root.id === id ? root : root.children.map((el) => find(el, id)).find(Boolean);
  const document = new Element('document');
  Object.assign(document, {
    body,
    createElement: (tag) => tag === 'canvas' ? fixture.createCanvas() : new Element(tag),
    querySelector: (selector) => selector.includes('layer-mapsheets.svg') ? icon : null,
    getElementById: (id) => find(group, id),
  });
  globalValue(t, 'document', document);
  let refresh;
  let observer;
  const added = [];
  let savedFeature;
  let blockedCreations = 0;
  const selectedStore = {
    editingObjects: [],
    get hasInProgressNewObject() { return this.editingObjects.some((object) => object.isNewObject); },
  };
  const creationDescriptor = Object.getOwnPropertyDescriptor(selectedStore, 'hasInProgressNewObject');
  const cardsUiStore = {
    selectedStore,
    showNewCard() {
      if (selectedStore.hasInProgressNewObject) blockedCreations++;
      else selectedStore.editingObjects.push({ isNewObject: true });
    },
  };
  const native = {
    MapState: { controllers: { MapGeoImage: { cardsUiStore } } },
    MapObjectDAO: { save: (feature, type, success) => { savedFeature = feature; assert.equal(type, 'MapGeoImage'); success(); } },
    mapViewStore: { addToStack: (...args) => added.push(args) },
  };
  const selection = selectionMap();
  const window = {
    sarsoft: { features: { pro: false }, account: { id: 'account' } },
    org: { sarsoft: native },
    map: selection.wrapper,
    google: selection.google,
    setInterval: (callback) => { refresh = callback; },
  };
  globalValue(t, 'window', window);
  globalValue(t, 'MutationObserver', class {
    constructor(callback) { observer = callback; }
    observe() {}
  });
  installCalTopoMapSheets(() => layer, () => selection.map);
  const menu = group.children[1];
  assert.equal(menu.id, 'strava-heatmap-map-sheet');
  const button = menu.children[0];
  const title = button.children[0].children[1];
  const description = button.children[1];
  const [titleText, badge] = title.children;
  assert.equal(titleText.textContent.trim(), 'Map Sheet from Strava Heatmap');
  assert.equal(badge.className, 'upgradeCtaButton');
  assert.equal(badge.textContent, 'Pro');
  assert.equal(badge.attributes.role, 'link');
  assert.equal(badge.hidden, false);
  assert.equal(badge.style.display, '');
  assert.equal(badge.tabIndex, 0);
  assert.doesNotMatch(description.textContent, /Pro required|\(Pro\)/);
  assert.equal(button.attributes.role, 'group');
  assert.equal(button.attributes['aria-disabled'], undefined, 'the upgrade link must not inherit a disabled state');
  assert.equal(button.tabIndex, -1);
  let stopped = false;
  badge.handlers.click({ preventDefault() {}, stopPropagation() { stopped = true; } });
  assert.equal(stopped, true, 'upgrade clicks must not activate capture');
  assert.equal(upgrades, 1, 'forward to the native Map Sheet upgrade badge');
  badge.handlers.keydown({ key: 'Enter', preventDefault() {}, stopPropagation() {} });
  assert.equal(upgrades, 2, 'allow keyboard activation of the upgrade link');
  assert.equal(body.children.length, 0);
  refresh();
  assert.equal(title.children.length, 2, 'refresh must not duplicate the badge');
  window.sarsoft.features.pro = true;
  refresh();
  assert.equal(button.attributes['aria-disabled'], 'false');
  assert.equal(button.attributes.role, 'button');
  assert.equal(badge.hidden, true);
  assert.equal(badge.style.display, 'none');
  assert.equal(badge.tabIndex, -1);
  refresh();
  assert.equal(button.attributes['aria-disabled'], 'false');
  assert.match(description.textContent, /Adjust an area/);
  cardsUiStore.showNewCard();
  button.handlers.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(blockedCreations, 1, 'reuse the native creation guard when another form is open');
  assert.equal(selection.container.children.length, 0, 'do not open selection over a native creation form');
  assert.equal(body.children.length, 0);
  selectedStore.editingObjects = [];
  button.handlers.click();
  assert.equal(selectedStore.hasInProgressNewObject, true);
  cardsUiStore.showNewCard();
  assert.equal(blockedCreations, 2, 'native forms must be blocked during heatmap selection');
  assert.equal(selectedStore.editingObjects.length, 0);
  assert.equal(body.children.length, 0, 'selection must precede the upload dialog');
  selectionControls(selectionPanel(selection.container)).cancel.handlers.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(selectedStore.hasInProgressNewObject, false);
  assert.deepEqual(Object.getOwnPropertyDescriptor(selectedStore, 'hasInProgressNewObject'), creationDescriptor,
    'restore the native getter on cancel');
  assert.equal(button.attributes['aria-disabled'], 'false', 'cancel permits another selection');
  button.handlers.click();
  document.handlers.keydown({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(selectedStore.hasInProgressNewObject, false, 'Escape releases the native creation guard');
  let requests = 0;
  let expectedTitle;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests++;
    if (url.startsWith('https:')) return new Response('png');
    if (url === '/api/v1/rendergeo') {
      const payload = JSON.parse(options.body.get('json'));
      assert.equal(payload.title, expectedTitle);
      assert.equal(payload.shared, false);
      return reply({ id: 'task', manual: true });
    }
    if (url.startsWith('/rendermanualgeo?')) {
      const alignment = JSON.parse(new URL(url, 'https://caltopo.com').searchParams.get('json'));
      assert.equal(alignment.properties.title, expectedTitle);
      return reply({ id: 'task' });
    }
    return reply({ state: 'done', image: { id: 'image', bbox: [-112, 40, -111, 41],
      properties: { maxZoom: 15, downloadableSize: 1024 } } });
  });
  button.handlers.keydown({ key: 'Enter', preventDefault() {} });
  assert.equal(button.attributes['aria-disabled'], 'true', 'disable repeat activation immediately');
  const panel = resizeSelection(selection.container);
  assert.equal(requests, 0, 'no downloads or uploads before confirmation');
  assert.equal(body.children.length, 0);
  const { nameInput, confirm } = selectionControls(panel);
  assert.match(nameInput.value, /^All Foot Sports orange \d{4}-\d{2}-\d{2}$/);
  expectedTitle = 'Wasatch & <hike> "Loop"';
  nameInput.value = `  ${expectedTitle}  `;
  nameInput.handlers.input();
  confirm.handlers.click();
  await new Promise((resolve) => setImmediate(resolve));
  const dialog = body.children[0];
  for (let i = 0; i < 100 && !dialog.children[3].textContent.includes('and added'); i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.match(dialog.children[3].textContent, /saved privately.*and added/i);
  assert.equal(selectedStore.hasInProgressNewObject, false);
  assert.deepEqual(Object.getOwnPropertyDescriptor(selectedStore, 'hasInProgressNewObject'), creationDescriptor,
    'restore the native getter after capture');
  assert.equal(dialog.children[1].textContent, expectedTitle);
  assert.match(dialog.children[2].textContent, /Share publicly: Off/);
  assert.equal(savedFeature.properties.backendImageId, 'image');
  assert.equal(savedFeature.properties.maxZoom, 15);
  assert.equal(savedFeature.properties.title, expectedTitle);
  assert.deepEqual(added, [['geoimage_image', 1]]);
  assert.equal(fixture.closed(), 1);
  const actions = dialog.children[4];
  const close = actions.children[0];
  assert.equal(actions.className, 'strava-heatmap-map-sheet-actions');
  assert.equal(close.textContent, 'Close');
  assert.equal(close.type, 'button');
  assert.equal(close.disabled, false);
  assert.equal(close.className, 'strava-heatmap-map-sheet-button strava-heatmap-map-sheet-primary');
  assert.equal(button.attributes['aria-disabled'], 'false');
  observer();
  assert.equal(group.children.length, 2, 'do not duplicate the menu item');
  t.mock.method(console, 'warn', () => {});
  native.MapObjectDAO.save = (feature, type, success, failure) => failure();
  button.handlers.click();
  const nextPanel = resizeSelection(selection.container);
  const nextControls = selectionControls(nextPanel);
  expectedTitle = nextControls.nameInput.value;
  assert.match(expectedTitle, /^All Foot Sports orange \d{4}-\d{2}-\d{2}$/);
  nextControls.confirm.handlers.click();
  await new Promise((resolve) => setImmediate(resolve));
  const failedDialog = body.children[1];
  for (let i = 0; i < 100 && failedDialog.children[3].attributes.role !== 'alert'; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.match(failedDialog.children[3].textContent, /Saved privately.*but not added/);
  assert.match(failedDialog.children[3].textContent, /editable map/);
  assert.equal(failedDialog.children[4].children[0].className, close.className);
  assert.equal(failedDialog.children[4].children[0].textContent, 'Close');
  assert.equal(added.length, 1, 'failed map additions must not be put on the layer stack');
  assert.equal(selectedStore.hasInProgressNewObject, false, 'save errors release the native creation guard');
  dialog.close();
  failedDialog.close();
  selection.google.maps.OverlayView = class { constructor() { throw new Error('Selection setup failed.'); } };
  button.handlers.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(body.children[0].children[3].textContent, /Selection setup failed/);
  assert.equal(selection.container.children.length, 0);
  assert.equal(selectedStore.hasInProgressNewObject, false, 'selection errors release the native creation guard');
  assert.deepEqual(Object.getOwnPropertyDescriptor(selectedStore, 'hasInProgressNewObject'), creationDescriptor);
});
