import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installBrouterSlide, slideSegment } from '../src/clients/brouter.de/slide.js';
import { project, unproject } from '../src/clients/www.openstreetmap.org/slide/algorithm.js';
import { deflateSync } from 'node:zlib';
import { runInNewContext } from 'node:vm';

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
  id: 'run-blue',
  name: 'Run',
  template: 'https://content-a.strava.com/identified/globalheat/run/grayscale/{z}/{x}/{y}.png',
};
const at = (x, y = 0) => new LatLng(y, x);
function fixture(t, fit, options = {}) {
  const button = new Element();
  const straight = new Element();
  const listeners = {};
  const mapListeners = {};
  const map = {
    on: (names, fn) => {
      for (const name of names.split(' ')) (mapListeners[name] ??= []).push(fn);
    },
    fire: (name) => { for (const fn of mapListeners[name] ?? []) fn(); },
    off() {},
  };
  map.on('routing:beeline-start', () => { straight.active = true; });
  map.on('routing:beeline-end', () => { straight.active = false; });
  straight.active = false;
  const markers = new Set();
  const orderedMarkers = () => {
    const ordered = [];
    let marker = [...markers].find((point) => !point._routing.prevMarker);
    while (marker) {
      ordered.push(marker);
      marker = marker._routing.nextMarker;
    }
    return ordered;
  };
  const routingListeners = {};
  const routing = {
    _waypoints: { hasLayer: (marker) => markers.has(marker) },
    options: {
      tooltips: { waypoint: 'Waypoint' },
      styles: { track: { opacity: 1 }, trackCasing: { opacity: 1 } },
    },
    isDrawing: () => routing._draw._enabled,
    getLast: () => orderedMarkers().at(-1),
    getWaypoints: () => orderedMarkers().map((marker) => marker.getLatLng()),
    _distance: (a, b) => Math.hypot(a.lng - b.lng, a.lat - b.lat),
    toggleBeelineDrawing() {
      if (!this.isDrawing()) return this._draw._beelineMode;
      this._draw._beelineMode = !this._draw._beelineMode;
      map.fire(this._draw._beelineMode ? 'routing:beeline-start' : 'routing:beeline-end');
      return this._draw._beelineMode;
    },
    nativeCalls: 0,
    _routeSegment(a, b, cb) { this.nativeCalls++; cb(); },
    _updateLayer(a, b, line) {
      line._casing = {
        options: { ...line.options, ...this.options.styles.trackCasing },
        setStyle(style) { Object.assign(this.options, style); },
      };
      a._routing.nextLine = line;
    },
    _eachSegment(fn) {
      for (const a of orderedMarkers()) if (a._routing.nextMarker) fn(a, a._routing.nextMarker);
    },
    _updateBeelines() {
      this._eachSegment((a, b) => {
        if (!a._routing.beeline) return;
        const line = {
          options: { dashArray: '1, 5', opacity: 1 },
          points: [a.getLatLng(), b.getLatLng()],
          getLatLngs() { return this.points; },
          setLatLngs(points) { this.points = points; },
          setStyle(style) { Object.assign(this.options, style); },
          feature: { geometry: {}, properties: { messages: [[], [0, 0, null, 0]] } },
        };
        this._updateLayer(a, b, line);
      });
    },
    routeWaypoint(marker, cb) {
      let done = 0;
      const finish = () => {
        if (++done !== 2) return;
        this._updateBeelines();
        this.fire('routing:routeWaypointEnd');
        cb();
      };
      this._routeSegment(marker._routing.prevMarker, marker, finish);
      this._routeSegment(marker, marker._routing.nextMarker, finish);
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
    setWaypoints(points, flags, cb) {
      let done = 0;
      for (const [i, point] of points.entries()) {
        this.addWaypoint(point, flags?.[i], this.getLast() ?? null, null, () => {
          if (++done === points.length) {
            this.fire('routing:setWaypointsEnd');
            cb?.();
          }
        });
      }
    },
    reverse() {
      const points = this.getWaypoints().reverse();
      const flags = orderedMarkers().slice(0, -1).map((m) => m._routing.beeline).reverse();
      this.clear();
      this.setWaypoints(points, flags);
    },
    on(names, fn, ctx) {
      for (const name of names.split(' ')) (routingListeners[name] ??= []).push({ fn, ctx });
    },
    fire(name, event) {
      this.lastEvent = { name, event };
      for (const { fn, ctx } of routingListeners[name] ?? []) fn.call(ctx, event);
    },
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
    location: { hash: options.hash ?? '#map=17/40/-105/standard' },
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
  class Hash {
    movingMap = false;
    additionalCb() {
      const points = routing.getWaypoints();
      const flags = orderedMarkers().slice(0, -1).flatMap((marker, i) => marker._routing.beeline ? [i] : []);
      return points.length ? `&lonlats=${coordinates(points).map((point) => point.join(',')).join(';')}` +
        (flags.length ? `&straight=${flags.join(',')}` : '') + '&profile=custom%20profile' : null;
    }
    onMapMove() {
      if (!this.movingMap) window.location.hash = '#map=17/40/-105/standard' + (this.additionalCb() ?? '');
    }
  }
  window.L.Hash = Hash;
  const hash = new Hash();
  routing._events = { 'routing:routeWaypointEnd': [{ ctx: hash }] };
  routing.on('routing:routeWaypointEnd', hash.onMapMove, hash);
  globalThis.document = {
    querySelector: () => ({ closest: () => straight }),
    createElement: () => new Element(),
    addEventListener: (name, fn) => { listeners[name] = fn; },
  };
  let selectedLayer = options.layer === undefined ? layer : options.layer;
  const restoredLayers = [];
  hash.movingMap = true;
  if (options.points) routing.setWaypoints(options.points, options.flags);
  hash.movingMap = false;
  const integration = installBrouterSlide(routing, map, (id) => {
    if (id) {
      restoredLayers.push(id);
      if (id !== layer.id) return undefined;
      selectedLayer = layer;
    }
    return selectedLayer;
  }, fit, options.initialHash);
  return {
    routing, button, straight, markers, integration, hash, restoredLayers,
    setDrawing: (drawing) => {
      routing._draw._enabled = drawing;
      map.fire(drawing ? 'routing:draw-start' : 'routing:draw-end');
    },
    selectLayer: (value) => { selectedLayer = value; integration.invalidate(); },
    key: (extra = {}) => listeners.keydown({ key: 's', preventDefault() {}, ...extra }),
    click: (point, shiftKey = false) => routing._draw._onMouseClick({ latlng: point, originalEvent: { shiftKey } }),
    settle: () => new Promise((resolve) => setImmediate(resolve)),
  };
}

test('Slide hides like straight-line mode when drawing stops and returns when it resumes', (t) => {
  const f = fixture(t);
  assert.equal(f.button.disabled, false);
  f.key();
  f.setDrawing(false);
  assert.equal(f.button.disabled, true);
  f.key();
  assert.equal(f.button.attributes['aria-pressed'], 'true', 'shortcut does not change mode outside editing');
  f.setDrawing(true);
  assert.equal(f.button.disabled, false);
  assert.equal(f.button.attributes['aria-pressed'], 'true', 'resuming editing preserves Slide mode');
  const css = readFileSync(new URL('../src/clients/brouter.de/index.css', import.meta.url), 'utf8');
  assert.match(css, /button\.slide-active\.disabled\s*\{\s*height:\s*0;\s*border-bottom-width:\s*0;\s*\}/);
});

test('straight and Slide buttons and shortcuts allow only off, straight, or Slide', (t) => {
  const f = fixture(t);
  const check = (mode) => {
    assert.equal(f.straight.active, mode === 'straight');
    assert.equal(f.button.attributes['aria-pressed'], String(mode === 'slide'));
    assert.equal(f.routing._draw._beelineMode, mode !== 'off');
  };
  check('off');
  f.key(); check('slide');
  f.key(); check('off');
  f.routing.toggleBeelineDrawing(); check('straight');
  f.routing.toggleBeelineDrawing(); check('off');
  f.routing.toggleBeelineDrawing(); check('straight');
  f.button.click(); check('slide');
  assert.equal(f.routing.toggleBeelineDrawing(), true); check('straight');
  f.key(); check('slide');
  f.button.click(); check('off');
  f.button.click(); check('slide');
  f.setDrawing(false);
  assert.equal(f.routing.toggleBeelineDrawing(), false);
  check('slide');
  f.setDrawing(true); check('slide');
});

test('S toggles Slide; native straight-line and routed modes remain independent', async (t) => {
  const f = fixture(t, async (points) => ({ coordinates: [points[0], [0.5, 1], points[1]] }));
  f.key({ ctrlKey: true });
  assert.equal(f.button.attributes['aria-pressed'], 'false');
  f.key();
  assert.equal(f.button.attributes['aria-pressed'], 'true');
  assert.equal(f.button['strava-slide-active'], true);
  const css = readFileSync(new URL('../src/clients/brouter.de/index.css', import.meta.url), 'utf8');
  assert.match(css, /\.strava-slide-active \.strava-slide-icon\s*\{\s*color:\s*#2074b6;\s*\}/);
  assert.equal(f.routing._draw._beelineMode, true);
  f.click(at(0)); f.click(at(1));
  await f.settle();
  const first = [...f.markers][0];
  assert.deepEqual(coordinates(first._routing.nextLine.getLatLngs()), [[0, 0], [0.5, 1], [1, 0]]);
  assert.equal(first._routing.nextLine.feature.properties['track-length'], 2 * Math.hypot(0.5, 1));
  assert.deepEqual(first._routing.nextLine.feature.geometry.coordinates, [[0, 0], [0.5, 1], [1, 0]]);
  assert.equal(first._routing.nextLine.options.dashArray, '16, 8');
  assert.equal(first._routing.nextLine._casing.options.dashArray, '16, 8');
  f.routing._updateBeelines();
  assert.equal(first._routing.nextLine.getLatLngs().length, 3, 'native beeline refresh retains Slide');
  assert.equal(first._routing.nextLine.options.dashArray, '16, 8');
  assert.equal(first._routing.nextLine._casing.options.dashArray, '16, 8');
  f.routing.toggleBeelineDrawing();
  assert.equal(f.button.attributes['aria-pressed'], 'false');
  assert.equal(f.routing._draw._beelineMode, true, 'B switches from Slide to straight');
  f.click(at(2));
  await f.settle();
  assert.equal([...f.markers][1]._routing.nextLine.getLatLngs().length, 2);
  assert.equal([...f.markers][1]._routing.nextLine.options.dashArray, '1, 5');
  assert.equal([...f.markers][1]._routing.nextLine._casing.options.dashArray, '1, 5');
  f.key(); f.click(at(3), true);
  await f.settle();
  assert.equal([...f.markers][2]._routing.beeline, false, 'Shift retains native mode inversion');
  const normal = {
    options: { dashArray: null },
    setStyle(style) { Object.assign(this.options, style); },
  };
  const [a, b] = [...f.markers].slice(2);
  f.routing._updateLayer(a, b, normal);
  assert.equal(normal.options.dashArray, null, 'normal routing remains solid');
  assert.equal(normal._casing.options.dashArray, null);
});

test('Slide inherits current track and casing opacity on first render and beeline refresh', async (t) => {
  for (const opacity of [0, 0.4, 1]) {
    let finish;
    const f = fixture(t, (points) => new Promise((resolve) => {
      finish = () => resolve({ coordinates: [points[0], [0.5, 1], points[1]] });
    }));
    const trackOpacity = 1 - Math.sqrt(1 - opacity);
    Object.assign(f.routing.options.styles.track, { opacity: trackOpacity });
    Object.assign(f.routing.options.styles.trackCasing, { opacity: trackOpacity });
    f.key(); f.click(at(0)); f.click(at(1));
    f.routing._updateBeelines();
    const first = [...f.markers][0];
    const check = (expectedTrack, expectedCasing) => {
      assert.equal(first._routing.nextLine.options.opacity, expectedTrack);
      assert.equal(first._routing.nextLine._casing.options.opacity, expectedCasing);
      assert.equal(first._routing.nextLine.options.dashArray, '16, 8');
      assert.equal(first._routing.nextLine._casing.options.dashArray, '16, 8');
    };
    check(trackOpacity, trackOpacity);
    await f.settle();
    // Use the latest styles, even if they change while Slide is calculating.
    f.routing.options.styles.track.opacity = 0.2;
    f.routing.options.styles.trackCasing.opacity = 0.3;
    finish();
    await f.settle();
    check(0.2, 0.3);
    f.routing._updateBeelines();
    check(0.2, 0.3);
  }
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
  f.routing.options.styles.track.opacity = 0.2;
  f.routing.options.styles.trackCasing.opacity = 0.3;
  f.button.click(); f.click(at(0)); f.click(at(1));
  await f.settle();
  assert.equal([...f.markers][0]._routing.nextLine.getLatLngs().length, 2);
  assert.equal([...f.markers][0]._routing.nextLine.options.dashArray, '16, 8');
  assert.equal([...f.markers][0]._routing.nextLine.options.opacity, 0.2);
  assert.equal([...f.markers][0]._routing.nextLine._casing.options.opacity, 0.3);
  const warnings = [];
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args);
  t.after(() => { console.warn = warn; });
  f.selectLayer(undefined);
  await f.settle();
  assert.equal(warnings.length, 1);
  assert.equal([...f.markers][0]._routing.nextLine.getLatLngs().length, 2);
  assert.equal([...f.markers][0]._routing.nextLine.options.dashArray, '16, 8');
  assert.equal([...f.markers][0]._routing.nextLine._casing.options.dashArray, '16, 8');
  assert.equal([...f.markers][0]._routing.nextLine.options.opacity, 0.2);
  assert.equal([...f.markers][0]._routing.nextLine._casing.options.opacity, 0.3);
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

test('URL distinguishes Slide from straight and retains layer and other parameters', async (t) => {
  const f = fixture(t, async (points) => ({ coordinates: [points[0], [0.5, 1], points[1]] }));
  f.key(); f.click(at(0)); f.click(at(1));
  await f.settle();
  f.routing.toggleBeelineDrawing(); f.click(at(2));
  await f.settle();
  const params = new URLSearchParams(window.location.hash.slice(1));
  assert.equal(params.get('slide'), '0');
  assert.equal(params.get('straight'), '1');
  assert.equal(params.get('slide-layer'), layer.id);
  assert.equal(params.get('profile'), 'custom profile');
  assert.match(window.location.hash, /profile=custom%20profile/);
  f.routing.reverse();
  await f.settle();
  const reversed = new URLSearchParams(window.location.hash.slice(1));
  assert.equal(reversed.get('slide'), '1');
  assert.equal(reversed.get('straight'), '0');
});

test('refresh restores already-loaded mixed segments and dragging reroutes both Slide neighbours', async (t) => {
  const fitted = [];
  const fit = async (points) => {
    fitted.push(points);
    return { coordinates: [points[0], [(points[0][0] + points[1][0]) / 2, 1], points[1]] };
  };
  const f = fixture(t, fit, {
    hash: '#map=17/40/-105/standard&lonlats=0,0;1,0;2,0;3,0&straight=2&slide=0,1&slide-layer=run-blue',
    points: [at(0), at(1), at(2), at(3)], flags: [false, false, true], layer: null,
  });
  await f.settle();
  assert.deepEqual(f.restoredLayers, [layer.id]);
  const [a, middle, b] = [...f.markers];
  assert.equal(a._routing.nextLine.getLatLngs().length, 3);
  assert.equal(middle._routing.nextLine.getLatLngs().length, 3);
  assert.equal(b._routing.nextLine.getLatLngs().length, 2);
  assert.equal(fitted.length, 2);
  middle.getLatLng().lat = 0.25;
  await new Promise((resolve) => f.routing.routeWaypoint(middle, resolve));
  assert.deepEqual(fitted.slice(2), [[[0, 0], [1, 0.25]], [[1, 0.25], [2, 0]]]);
  assert.equal(new URLSearchParams(window.location.hash.slice(1)).get('slide'), '0,1');
  assert.equal(a._routing.nextLine.getLatLngs().at(-1).lat, 0.25);
  assert.equal(middle._routing.nextLine.getLatLngs()[0].lat, 0.25);
});

test('URL route loaded after extension startup restores Slide without treating unrelated imports as Slide', async (t) => {
  const fitted = [];
  const f = fixture(t, async (points) => {
    fitted.push(points);
    return { coordinates: [points[0], [0.5, 1], points[1]] };
  });
  window.location.hash = '#map=17/40/-105/standard&lonlats=0,0;1,0;2,0&straight=1&slide=0&slide-layer=run-blue';
  f.hash.movingMap = true;
  f.routing.setWaypoints([at(0), at(1), at(2)], [false, true]);
  f.hash.movingMap = false;
  await f.settle();
  assert.equal(fitted.length, 1);
  assert.equal([...f.markers][0]._routing.nextLine.getLatLngs().length, 3);
  assert.equal([...f.markers][1]._routing.nextLine.getLatLngs().length, 2);
  f.routing.clear();
  f.routing.setWaypoints([at(5), at(6)], [true]);
  await f.settle();
  assert.equal(fitted.length, 1);
  assert.equal(new URLSearchParams(window.location.hash.slice(1)).has('slide'), false);
  assert.equal(new URLSearchParams(window.location.hash.slice(1)).has('slide-layer'), false);
});

test('splitting Slide updates the saved segment indices and clearing removes them', async (t) => {
  const f = fixture(t, async (points) => ({ coordinates: points }));
  f.key(); f.click(at(0)); f.click(at(2));
  await f.settle();
  const [a, b] = [...f.markers];
  const middle = f.routing.addWaypoint(at(1), null, a, b, () => {});
  await f.settle();
  assert.equal(new URLSearchParams(window.location.hash.slice(1)).get('slide'), '0,1');
  assert.equal(middle._routing.beeline, true);
  f.routing.clear();
  f.hash.onMapMove();
  assert.equal(new URLSearchParams(window.location.hash.slice(1)).has('slide'), false);
});

test('early URL snapshot survives BRouter stripping unknown parameters before installation', async (t) => {
  const fit = async (points) => ({ coordinates: [points[0], [0.5, 1], points[1]] });
  const f = fixture(t, fit, {
    initialHash: '#map=17/40/-105/standard&lonlats=0,0;1,0&slide=0&slide-layer=run-blue',
    hash: '#map=17/40/-105/standard&lonlats=0,0;1,0',
    points: [at(0), at(1)], flags: [false],
  });
  await f.settle();
  assert.equal([...f.markers][0]._routing.nextLine.getLatLngs().length, 3);
  assert.equal(new URLSearchParams(window.location.hash.slice(1)).get('slide'), '0');
});

test('early URL snapshot survives stripping before delayed waypoint loading', async (t) => {
  const fit = async (points) => ({ coordinates: [points[0], [0.5, 1], points[1]] });
  const f = fixture(t, fit, {
    initialHash: '#map=17/40/-105/standard&lonlats=0,0;1,0&slide=0&slide-layer=run-blue',
    hash: '#map=17/40/-105/standard&lonlats=0,0;1,0',
  });
  f.routing.setWaypoints([at(0), at(1)], [false]);
  await f.settle();
  assert.equal([...f.markers][0]._routing.nextLine.getLatLngs().length, 3);
  assert.equal(new URLSearchParams(window.location.hash.slice(1)).get('slide'), '0');
  f.routing.clear();
  f.routing.setWaypoints([at(0), at(1)], [false]);
  await f.settle();
  assert.equal(new URLSearchParams(window.location.hash.slice(1)).get('slide'), '0', 'current URL can still restore Slide');
});

test('client injection captures the URL before asynchronous authentication rewrites it', async () => {
  const source = readFileSync(new URL('../src/content/inject-client.js', import.meta.url), 'utf8');
  const initialHash = '#map=17/40/-105/standard&lonlats=0,0;1,0&slide=0';
  const window = { location: { host: 'brouter.de', hash: initialHash } };
  const appended = [];
  await runInNewContext(source, {
    window,
    console: { debug() {}, log() {}, warn() {}, error(error) { throw error; } },
    browser: {
      runtime: {
        getManifest: () => ({ version: '0.15.0.2' }),
        getURL: (path) => `chrome-extension://test/${path}`,
        sendMessage: async ({ type }) => {
          if (type === 'requestLayerPresets') return 'run:blue:global';
          window.location.hash = initialHash.replace('&slide=0', '');
          return true;
        },
      },
      storage: { local: {
        get: async () => ({ layers: 'run:blue:global' }),
        set: async (values) => { assert.equal(values.mapsheetmaxsize, 0); },
      } },
    },
    document: {
      createElement: () => ({ dataset: {} }),
      head: { append: (element) => appended.push(element) },
    },
  });
  assert.equal(appended.find((element) => element.type === 'module').dataset.initialHash, initialHash);
  assert.equal(window.location.hash.includes('slide='), false);
});

test('unavailable saved layer retains Slide flags but does not silently fit another heatmap', async (t) => {
  const warn = console.warn;
  console.warn = () => {};
  t.after(() => { console.warn = warn; });
  let fitted = 0;
  const f = fixture(t, async (points) => {
    fitted++;
    return { coordinates: points };
  }, {
    hash: '#map=17/40/-105/standard&lonlats=0,0;1,0&slide=0&slide-layer=deleted-layer',
    points: [at(0), at(1)], flags: [false],
  });
  await f.settle();
  assert.equal(fitted, 0);
  assert.equal(new URLSearchParams(window.location.hash.slice(1)).get('slide'), '0');
  assert.equal(new URLSearchParams(window.location.hash.slice(1)).get('slide-layer'), 'deleted-layer');
  f.selectLayer(layer);
  await f.settle();
  assert.equal(fitted, 1);
  assert.equal(new URLSearchParams(window.location.hash.slice(1)).get('slide-layer'), layer.id);
});

test('malformed Slide indices are reported instead of routing arbitrary segments', async (t) => {
  const warnings = [];
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args);
  t.after(() => { console.warn = warn; });
  const f = fixture(t, async () => { assert.fail('invalid flags must not run Slide'); }, {
    hash: '#map=17/40/-105/standard&lonlats=0,0;1,0&slide=2,garbage',
    points: [at(0), at(1)], flags: [true],
  });
  await f.settle();
  assert.equal(warnings.length, 1);
  assert.equal([...f.markers][0]._routing.nextLine.getLatLngs().length, 2);
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
  assert.equal(manifest.content_scripts.find((entry) =>
    entry.matches.includes('*://brouter.de/brouter-web/*')).run_at, 'document_start');
  const resources = manifest.web_accessible_resources.filter((entry) =>
    entry.matches.includes('*://brouter.de/*')).flatMap((entry) => entry.resources);
  for (const resource of ['src/clients/brouter.de/slide.js', 'icons/slide.svg',
    'src/clients/www.openstreetmap.org/slide/algorithm.js',
    'src/clients/www.openstreetmap.org/slide/tiles.js',
    'src/clients/www.openstreetmap.org/slide/png.js']) assert.ok(resources.includes(resource));
});
