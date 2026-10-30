import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mapSheetRegion, mapSheetAlignment, colorizeMapSheetPixels,
  mapSheetAvailability, renderMapSheet, uploadMapSheet,
  installCalTopoMapSheets, limitMapSheetSelection, selectMapSheetRegion,
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
    assert.match(available.message, /Draw an area/);
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
    this.isConnected = true;
    this.classList = { toggle() {} };
    this.style = {};
    this.pointers = new Set();
  }
  append(...elements) { this.children.push(...elements); for (const el of elements) el.parentElement = this; }
  appendChild(el) { this.append(el); return el; }
  after(el) { const i = this.parentElement.children.indexOf(this); this.parentElement.children.splice(i + 1, 0, el); el.parentElement = this.parentElement; }
  cloneNode() { return new Element(this.tagName); }
  closest() { return this.parentElement; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, callback) { this.handlers[name] = callback; }
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

function selectionMap(renderer = 'google', initiallyDraggable = true) {
  const container = new Element('div');
  let draggable = initiallyDraggable;
  let zoom = 1;
  let centered = 0;
  let move;
  let removed = 0;
  const wrapper = {
    fromContainerPixel: ([x, y]) => [lng(6200 + x / 100), lat(12000 + y / 100)],
    toContainerPixel: ([longitude, latitude]) => {
      const x = (longitude + 180) / 360 * 32768;
      const y = (1 - Math.asinh(Math.tan(latitude * Math.PI / 180)) / Math.PI) / 2 * 32768;
      return [(x - 6200) * 100, (y - 12000) * 100];
    },
  };
  const map = renderer === 'google' ? {
    getDiv: () => container,
    get: () => draggable,
    setOptions: (options) => { draggable = options.draggable; },
    addListener: (name, callback) => {
      assert.equal(name, 'bounds_changed');
      move = callback;
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
  map.setZoom = (value) => { zoom = value; };
  map.setCenter = () => centered++;
  map.panTo = () => centered++;
  return { map, wrapper, container, draggable: () => draggable,
    move: () => move(), removed: () => removed, centered: () => centered };
}

function pointer(overlay, type, x, y, overrides = {}) {
  overlay.handlers[type]({
    clientX: x, clientY: y, pointerId: 1, button: 0, isPrimary: true,
    preventDefault() {}, stopPropagation() {}, ...overrides,
  });
}

function drawSelection(container, start = [10, 10], end = [80, 80]) {
  const overlay = container.children[0];
  pointer(overlay, 'pointerdown', ...start);
  pointer(overlay, 'pointermove', ...end);
  pointer(overlay, 'pointerup', ...end);
  return overlay.children[1];
}

for (const renderer of ['google', 'leaflet']) {
  test(`${renderer} area drawing caps expansion, previews tiles, and requires explicit confirmation`, async (t) => {
    const document = new Element('document');
    document.createElement = (tag) => new Element(tag);
    const fixture = selectionMap(renderer);
    fixture.container.getBoundingClientRect = () => ({ left: 0, top: 0, width: 2000, height: 2000 });
    globalValue(t, 'document', document);
    globalValue(t, 'window', { map: fixture.wrapper });
    let completed = false;
    const work = selectMapSheetRegion(fixture.map, new AbortController().signal, 'Suggested sheet name')
      .then((result) => { completed = true; return result; });
    assert.equal(fixture.draggable(), false);
    const overlay = fixture.container.children[0];
    const panel = overlay.children[1];
    if (renderer === 'google') {
      fixture.map.getProjection = () => null;
      pointer(overlay, 'pointerdown', 10, 10);
      assert.match(panel.children[2].textContent, /finish loading/);
      assert.equal(panel.children[3].disabled, true);
      fixture.map.getProjection = () => ({});
    }
    for (const name of ['click', 'dblclick', 'mousedown', 'mouseup', 'contextmenu']) {
      let blocked = false;
      overlay.handlers[name]({ preventDefault() {}, stopPropagation() { blocked = true; } });
      assert.equal(blocked, true, `${name} must not reach the map's drawing controls`);
      let stopped = false;
      let defaultPrevented = false;
      const event = {
        stopPropagation() { stopped = true; },
        preventDefault() { defaultPrevented = true; },
      };
      panel.handlers[name]?.(event);
      if (!stopped) overlay.handlers[name](event);
      assert.equal(stopped, true, `${name} in the panel must not reach the selection overlay`);
      assert.equal(defaultPrevented, false, `${name} must preserve native text-field editing`);
    }
    const nameInput = panel.children[1].children[0];
    assert.equal(nameInput.value, 'Suggested sheet name');
    assert.equal(nameInput.required, true);
    assert.equal(panel.children[3].disabled, true);
    pointer(overlay, 'pointerdown', 10, 10);
    pointer(overlay, 'pointermove', 100000, 100000);
    assert.match(panel.children[2].textContent, /100\/100 tiles selected/);
    assert.match(panel.children[2].textContent, /Limit reached/);
    assert.equal(panel.children[3].disabled, true, 'cannot confirm during a drag');
    fixture.move();
    assert.ok(parseFloat(overlay.children[0].style.width) <= 1000.00001);
    pointer(overlay, 'pointerup', 100000, 100000);
    assert.equal(panel.children[3].disabled, false);
    panel.children[6].handlers.click();
    assert.equal(fixture.map.getZoom(), 2);
    assert.equal(fixture.centered(), 1);
    overlay.handlers.wheel({ deltaY: -10, preventDefault() {}, stopPropagation() {} });
    assert.equal(fixture.map.getZoom(), 3);
    overlay.handlers.wheel({ deltaY: -10, preventDefault() {}, stopPropagation() {} });
    assert.equal(fixture.map.getZoom(), 3, 'throttle wheel zoom');
    await Promise.resolve();
    assert.equal(completed, false);
    drawSelection(fixture.container);
    assert.match(panel.children[2].textContent, /1\/100 tiles selected/);
    nameInput.value = '   ';
    panel.children[3].handlers.click();
    await Promise.resolve();
    assert.equal(completed, false, 'blank names must not confirm the capture');
    assert.equal(nameInput.validationMessage, 'Enter a sheet name.');
    nameInput.value = renderer === 'google' ? '  My trail map  ' : 'Suggested sheet name';
    nameInput.handlers.input();
    assert.equal(nameInput.validationMessage, '');
    panel.children[3].handlers.click();
    const result = await work;
    assert.equal(result.region.count, 1);
    assert.equal(result.region.minX, 6200);
    assert.equal(result.region.minY, 12000);
    assert.equal(result.title, renderer === 'google' ? 'My trail map' : 'Suggested sheet name');
    assert.equal(fixture.container.children.length, 0);
    assert.equal(fixture.draggable(), true);
    assert.equal(fixture.removed(), 1);
    assert.equal(document.handlers.keydown, undefined);
  });

  test(`${renderer} selection handles touch cancellation and Escape without changing an initially locked map`, async (t) => {
    const document = new Element('document');
    document.createElement = (tag) => new Element(tag);
    const fixture = selectionMap(renderer, false);
    globalValue(t, 'document', document);
    globalValue(t, 'window', { map: fixture.wrapper });
    const work = selectMapSheetRegion(fixture.map, new AbortController().signal, 'Suggested sheet name');
    const overlay = fixture.container.children[0];
    pointer(overlay, 'pointerdown', 10, 10);
    pointer(overlay, 'pointermove', 80, 80);
    pointer(overlay, 'pointercancel', 80, 80);
    assert.equal(overlay.children[1].children[3].disabled, true);
    assert.equal(overlay.children[0].hidden, true);
    document.handlers.keydown({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
    assert.equal(await work, null);
    assert.equal(fixture.draggable(), false);
    assert.equal(fixture.container.children.length, 0);
    assert.equal(fixture.removed(), 1);
  });
}

test('aborting area selection cleans up all listeners and restores map dragging', async (t) => {
  const document = new Element('document');
  document.createElement = (tag) => new Element(tag);
  const fixture = selectionMap();
  globalValue(t, 'document', document);
  globalValue(t, 'window', { map: fixture.wrapper });
  const controller = new AbortController();
  const work = selectMapSheetRegion(fixture.map, controller.signal, 'Suggested sheet name');
  controller.abort();
  await assert.rejects(work, { name: 'AbortError' });
  assert.equal(fixture.container.children.length, 0);
  assert.equal(fixture.draggable(), true);
  assert.equal(document.handlers.keydown, undefined);
});

test('Add menu selects at any zoom, waits for confirmation, then saves privately through native controls', async (t) => {
  const fixture = canvasFixture(t);
  const canvas = globalThis.document.createElement('canvas');
  const body = new Element('body');
  const group = new Element('div');
  const item = new Element('div');
  const nativeLine = new Element('div');
  const icon = new Element('img');
  group.append(item);
  item.append(nativeLine);
  nativeLine.append(icon);
  const find = (root, id) => root.id === id ? root : root.children.map((el) => find(el, id)).find(Boolean);
  const document = new Element('document');
  Object.assign(document, {
    body,
    createElement: (tag) => tag === 'canvas' ? canvas : new Element(tag),
    querySelector: (selector) => selector.includes('layer-mapsheets.svg') ? icon : null,
    getElementById: (id) => find(group, id),
  });
  globalValue(t, 'document', document);
  let refresh;
  let observer;
  const added = [];
  let savedFeature;
  const native = {
    MapObjectDAO: { save: (feature, type, success) => { savedFeature = feature; assert.equal(type, 'MapGeoImage'); success(); } },
    mapViewStore: { addToStack: (...args) => added.push(args) },
  };
  const selection = selectionMap();
  const window = {
    sarsoft: { features: { pro: false }, account: { id: 'account' } },
    org: { sarsoft: native },
    map: selection.wrapper,
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
  assert.match(title.textContent, /\(Pro\)$/);
  assert.equal(button.attributes['aria-disabled'], 'true');
  assert.equal(button.tabIndex, -1);
  window.sarsoft.features.pro = true;
  refresh();
  assert.equal(button.attributes['aria-disabled'], 'false');
  assert.doesNotMatch(title.textContent, /\(Pro\)/);
  refresh();
  assert.equal(button.attributes['aria-disabled'], 'false');
  assert.match(description.textContent, /Draw an area/);
  button.handlers.click();
  assert.equal(body.children.length, 0, 'selection must precede the upload dialog');
  selection.container.children[0].children[1].children[4].handlers.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(button.attributes['aria-disabled'], 'false', 'cancel permits another selection');
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
  const panel = drawSelection(selection.container);
  assert.equal(requests, 0, 'no downloads or uploads before confirmation');
  assert.equal(body.children.length, 0);
  const nameInput = panel.children[1].children[0];
  assert.match(nameInput.value, /^Strava Global Heatmap All Foot Sports orange \d{4}-\d\d-\d\dT/);
  expectedTitle = 'Wasatch & <hike> "Loop"';
  nameInput.value = `  ${expectedTitle}  `;
  nameInput.handlers.input();
  panel.children[3].handlers.click();
  await new Promise((resolve) => setImmediate(resolve));
  const dialog = body.children[0];
  for (let i = 0; i < 100 && !dialog.children[3].textContent.includes('and added'); i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.match(dialog.children[3].textContent, /saved privately.*and added/i);
  assert.equal(dialog.children[1].textContent, expectedTitle);
  assert.match(dialog.children[2].textContent, /Share publicly: Off/);
  assert.equal(savedFeature.properties.backendImageId, 'image');
  assert.equal(savedFeature.properties.maxZoom, 15);
  assert.equal(savedFeature.properties.title, expectedTitle);
  assert.deepEqual(added, [['geoimage_image', 1]]);
  assert.equal(fixture.closed(), 1);
  assert.equal(dialog.children[4].textContent, 'Close');
  assert.equal(button.attributes['aria-disabled'], 'false');
  observer();
  assert.equal(group.children.length, 2, 'do not duplicate the menu item');
  t.mock.method(console, 'warn', () => {});
  native.MapObjectDAO.save = (feature, type, success, failure) => failure();
  button.handlers.click();
  const nextPanel = drawSelection(selection.container);
  expectedTitle = nextPanel.children[1].children[0].value;
  assert.match(expectedTitle, /^Strava Global Heatmap All Foot Sports orange \d{4}-\d\d-\d\dT/);
  nextPanel.children[3].handlers.click();
  await new Promise((resolve) => setImmediate(resolve));
  const failedDialog = body.children[1];
  for (let i = 0; i < 100 && failedDialog.children[3].attributes.role !== 'alert'; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.match(failedDialog.children[3].textContent, /Saved privately.*but not added/);
  assert.match(failedDialog.children[3].textContent, /editable map/);
  assert.equal(added.length, 1, 'failed map additions must not be put on the layer stack');
});
