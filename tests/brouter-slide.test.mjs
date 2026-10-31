import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installBrouterSlide, slideSegment } from '../src/clients/brouter.de/slide.js';
import { project, unproject } from '../src/clients/www.openstreetmap.org/slide/algorithm.js';
import { deflateSync } from 'node:zlib';

class Element {
  constructor() {
    this.attributes = {};
    this.classList = { toggle: (name, enabled) => { this[name] = enabled; } };
  }
  setAttribute(name, value) { this.attributes[name] = value; }
  after(button) { this.afterButton = button; }
  closest() { return this; }
}
class LatLng {
  constructor(lat, lng) { Object.assign(this, { lat, lng }); }
}
const coordinates = (points) => points.map(({ lng, lat }) => [lng, lat]);
const layer = {
  name: 'Run',
  template: 'https://content-a.strava.com/identified/globalheat/run/grayscale/{z}/{x}/{y}.png',
};
const at = (x, y = 0) => new LatLng(y, x);
function fixture(t, fit) {
  const button = new Element();
  const straight = new Element();
  const listeners = {};
  const mapListeners = {};
  const map = {
    on: (names, fn) => { for (const name of names.split(' ')) mapListeners[name] = fn; },
    off() {},
  };
  const markers = new Set();
  const routing = {
    _waypoints: { hasLayer: (marker) => markers.has(marker) },
    options: { tooltips: { waypoint: 'Waypoint' } },
    isDrawing: () => routing._draw._enabled,
    getLast: () => [...markers].at(-1),
    getWaypoints: () => [...markers].map((marker) => marker.getLatLng()),
    _distance: (a, b) => Math.hypot(a.lng - b.lng, a.lat - b.lat),
    toggleBeelineDrawing() { return this._draw._beelineMode = !this._draw._beelineMode; },
    nativeCalls: 0,
    _routeSegment(a, b, cb) { this.nativeCalls++; cb(); },
    _updateLayer(a, b, line) { a._routing.nextLine = line; },
    _eachSegment(fn) {
      for (const a of markers) if (a._routing.nextMarker) fn(a, a._routing.nextMarker);
    },
    _updateBeelines() {
      this._eachSegment((a, b) => {
        if (!a._routing.beeline) return;
        const line = {
          points: [a.getLatLng(), b.getLatLng()],
          getLatLngs() { return this.points; },
          setLatLngs(points) { this.points = points; },
          feature: { geometry: {}, properties: { messages: [[], [0, 0, null, 0]] } },
        };
        this._updateLayer(a, b, line);
      });
    },
    routeWaypoint(marker, cb) {
      this._routeSegment(marker._routing.prevMarker, marker, () => {
        this._updateBeelines();
        cb();
      });
    },
    addWaypoint(point, beeline, prev, next, cb) {
      const marker = point instanceof LatLng ? { getLatLng: () => point } : point;
      marker._routing = { prevMarker: prev, nextMarker: next, beeline: !!beeline };
      if (prev) prev._routing.nextMarker = marker;
      if (next) {
        next._routing.prevMarker = marker;
        if (prev?._routing.beeline) marker._routing.beeline = true;
      }
      markers.add(marker);
      this.routeWaypoint(marker, cb);
      return marker;
    },
    clear() { markers.clear(); },
    reverse() {
      const points = this.getWaypoints().reverse();
      const flags = [...markers].slice(0, -1).map((m) => m._routing.beeline).reverse();
      this.clear();
      for (const [i, point] of points.entries()) this.addWaypoint(point, flags[i], this.getLast() ?? null, null, () => {});
    },
    fire(name, event) { this.lastEvent = { name, event }; },
  };
  routing._draw = {
    _enabled: true, _hidden: false, _beelineMode: false, _parent: routing,
    options: { shortcut: { draw: { beelineModifierName: 'shiftKey' } } },
    _onMouseClick(event) {
      const last = routing.getLast();
      if (last) last._routing.beeline = event.originalEvent.shiftKey ? !this._beelineMode : this._beelineMode;
      routing.addWaypoint(event.latlng, null, last ?? null, null, () => {});
    },
  };
  const previousWindow = globalThis.window, previousDocument = globalThis.document;
  t.after(() => { globalThis.window = previousWindow; globalThis.document = previousDocument; });
  globalThis.window = {
    L: {
      LatLng, latLng: (lat, lng) => new LatLng(lat, lng),
      marker: (point) => ({ getLatLng: () => point }),
      control: () => ({ addTo() { this.onAdd(); } }),
      easyButton: ({ states }) => {
        button.click = states[0].onClick;
        return { button, enable() { button.disabled = false; }, disable() { button.disabled = true; } };
      },
    },
    BR: { Util: { keyboardShortcutsAllowed: (e) => !e.repeat && !e.ctrlKey },
      TrackEdges: { getFeature: () => ({}) } },
  };
  globalThis.document = {
    querySelector: () => ({ closest: () => straight }),
    createElement: () => new Element(),
    addEventListener: (name, fn) => { listeners[name] = fn; },
  };
  let selectedLayer = layer;
  const integration = installBrouterSlide(routing, map, () => selectedLayer, fit);
  return {
    routing, button, markers, integration,
    selectLayer: (value) => { selectedLayer = value; integration.invalidate(); },
    key: (extra = {}) => listeners.keydown({ key: 's', preventDefault() {}, ...extra }),
    click: (point, shiftKey = false) => routing._draw._onMouseClick({ latlng: point, originalEvent: { shiftKey } }),
    settle: () => new Promise((resolve) => setImmediate(resolve)),
  };
}

test('S toggles Slide; native straight-line and routed modes remain independent', async (t) => {
  const f = fixture(t, async (points) => ({ coordinates: [points[0], [0.5, 1], points[1]] }));
  f.key({ ctrlKey: true });
  assert.equal(f.button.attributes['aria-pressed'], 'false');
  f.key();
  assert.equal(f.button.attributes['aria-pressed'], 'true');
  assert.equal(f.routing._draw._beelineMode, true);
  f.click(at(0)); f.click(at(1));
  await f.settle();
  const first = [...f.markers][0];
  assert.deepEqual(coordinates(first._routing.nextLine.getLatLngs()), [[0, 0], [0.5, 1], [1, 0]]);
  assert.equal(first._routing.nextLine.feature.properties['track-length'], 2 * Math.hypot(0.5, 1));
  assert.deepEqual(first._routing.nextLine.feature.geometry.coordinates, [[0, 0], [0.5, 1], [1, 0]]);
  f.routing._updateBeelines();
  assert.equal(first._routing.nextLine.getLatLngs().length, 3, 'native beeline refresh retains Slide');
  f.routing.toggleBeelineDrawing();
  assert.equal(f.button.attributes['aria-pressed'], 'false');
  assert.equal(f.routing._draw._beelineMode, true, 'B switches from Slide to straight');
  f.click(at(2));
  await f.settle();
  assert.equal([...f.markers][1]._routing.nextLine.getLatLngs().length, 2);
  f.key(); f.click(at(3), true);
  await f.settle();
  assert.equal([...f.markers][2]._routing.beeline, false, 'Shift retains native mode inversion');
});

test('Slide recalculates moved endpoints and layer changes; ignores stale and cleared work', async (t) => {
  const requests = [];
  const f = fixture(t, (points, source, signal) => new Promise((resolve) => {
    requests.push({ points, source, signal, resolve });
  }));
  f.key(); f.click(at(0)); f.click(at(1));
  await f.settle();
  const [a, b] = [...f.markers];
  b.getLatLng().lng = 2;
  f.routing._routeSegment(a, b, () => f.routing._updateBeelines());
  await f.settle();
  assert.equal(requests[0].signal.aborted, true);
  requests[0].resolve({ coordinates: [[0, 0], [0.5, 9], [1, 0]] });
  requests[1].resolve({ coordinates: [[0, 0], [1, 1], [2, 0]] });
  await f.settle();
  assert.deepEqual(a._routing.nextLine.feature.geometry.coordinates, [[0, 0], [1, 1], [2, 0]]);
  f.selectLayer({ ...layer, name: 'Ride', template: layer.template.replace('/run/', '/ride/') });
  await f.settle();
  assert.equal(requests[2].source.name, 'Ride');
  f.routing.clear();
  assert.equal(requests[2].signal.aborted, true);
  requests[2].resolve({ coordinates: [[0, 0], [1, 8], [2, 0]] });
  await f.settle();
  assert.equal(f.markers.size, 0);
});

test('no-trail results and explicit failures keep straight geometry', async (t) => {
  const f = fixture(t, async (points) => ({ coordinates: points, message: 'No trail.' }));
  f.button.click(); f.click(at(0)); f.click(at(1));
  await f.settle();
  assert.equal([...f.markers][0]._routing.nextLine.getLatLngs().length, 2);
  const warnings = [];
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args);
  t.after(() => { console.warn = warn; });
  f.selectLayer(undefined);
  await f.settle();
  assert.equal(warnings.length, 1);
  assert.equal([...f.markers][0]._routing.nextLine.getLatLngs().length, 2);
});

test('reversing preserves Slide segment modes, while splitting inherits Slide', async (t) => {
  const f = fixture(t, async (points) => ({ coordinates: [points[0], [0.5, 1], points[1]] }));
  f.key(); f.click(at(0)); f.click(at(1));
  await f.settle();
  f.routing.reverse();
  await f.settle();
  const [a, b] = [...f.markers];
  assert.equal(a._routing.nextLine.getLatLngs().length, 3);
  const middle = f.routing.addWaypoint(at(0.5), null, a, b, () => {});
  await f.settle();
  await new Promise((resolve) => f.routing._routeSegment(middle, b, resolve));
  f.routing._updateBeelines();
  assert.equal(a._routing.nextLine.getLatLngs().length, 3);
  assert.equal(middle._routing.nextLine.getLatLngs().length, 3);
});

function png(paint) {
  const size = 512;
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = y * (size * 4 + 1) + 1 + x * 4;
    const heat = paint(x, y);
    rows[i] = rows[i + 1] = rows[i + 2] = heat;
    rows[i + 3] = 255;
  }
  const chunk = (name, data) => {
    const buffer = Buffer.alloc(data.length + 12);
    buffer.writeUInt32BE(data.length); buffer.write(name, 4); data.copy(buffer, 8);
    return buffer;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size); header.writeUInt32BE(size, 4);
  header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

test('real tile-to-Slide pipeline traces a curved ridge and fixes both clicked endpoints', async (t) => {
  const origin = project([-105, 40]).map((v) => Math.floor(v / 512) * 512);
  const center = (y) => 220 + 24 * Math.sin((y - 180) * Math.PI / 140);
  const tile = png((x, y) => Math.round(255 * Math.exp(-((x - center(y)) ** 2) / 8)));
  const fetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = fetch; });
  globalThis.fetch = async (url) => {
    const path = new URL(url).pathname.split('/');
    const x = Number(path.at(-2)), y = Number(path.at(-1).replace('.png', ''));
    return x * 512 === origin[0] && y * 512 === origin[1]
      ? new Response(tile) : new Response(null, { status: 404 });
  };
  const points = [[220, 180], [220, 320]].map(([x, y]) => unproject([origin[0] + x, origin[1] + y]));
  const result = await slideSegment(points, layer, new AbortController().signal, () => {});
  assert.deepEqual(result.coordinates[0], points[0]);
  assert.deepEqual(result.coordinates.at(-1), points[1]);
  assert.ok(result.coordinates.length > 2);
  assert.ok(result.coordinates.some((point) => project(point)[0] - origin[0] > 240));
  assert.ok(result.coordinates.every((point) => {
    const [x, y] = project(point).map((v, i) => v - origin[i]);
    return Math.abs(x - center(y)) < 3;
  }), 'path must follow the ridge, not merely produce extra vertices');
});

test('missing tiles are an expected straight fallback, but HTTP failures remain errors', async (t) => {
  const fetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = fetch; });
  const points = [[-105, 40], [-105.001, 40]];
  globalThis.fetch = async () => new Response(null, { status: 404 });
  const result = await slideSegment(points, layer, new AbortController().signal, () => {});
  assert.deepEqual(result.coordinates, points);
  assert.match(result.message, /stays straight/);
  globalThis.fetch = async () => new Response(null, { status: 403 });
  await assert.rejects(slideSegment(points, layer, new AbortController().signal, () => {}), /Log in again/);
});

test('BRouter can load all imported Slide modules and icon from the extension', () => {
  const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url)));
  const resources = manifest.web_accessible_resources.filter((entry) =>
    entry.matches.includes('*://brouter.de/*')).flatMap((entry) => entry.resources);
  for (const resource of ['src/clients/brouter.de/slide.js', 'icons/slide.svg',
    'src/clients/www.openstreetmap.org/slide/algorithm.js',
    'src/clients/www.openstreetmap.org/slide/tiles.js',
    'src/clients/www.openstreetmap.org/slide/png.js']) assert.ok(resources.includes(resource));
});
