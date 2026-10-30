import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { metersPerPixel, project, unproject, slidePaths, smoothSlidePath } from '../src/clients/www.openstreetmap.org/slide/algorithm.js';
import { loadSlideOptions, sampleSlideTargets, selectSlideOptions } from '../src/clients/caltopo.com/snap-network.js';
import { installCalTopoSnap } from '../src/clients/caltopo.com/snap.js';

const layer = {
  name: 'All Foot Sports (Blue)',
  template: 'https://content-a.strava.com/identified/globalheat/run/blue/{z}/{x}/{y}.png',
};
const origin = project([-105, 40]).map(Math.floor);
const loc = ([x, y]) => unproject([origin[0] + x, origin[1] + y]);
const pixel = (location) => project(location).map((value, i) => value - origin[i]);
const near = (a, b, tolerance = 1e-6) => Math.abs(a - b) <= tolerance;
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function image(size, paint) {
  const density = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) density[y * size + x] = paint(x, y);
  return {
    x: origin[0], y: origin[1], width: size, height: size, zoom: 15,
    density, coverage: new Uint8Array(density.length).fill(1),
  };
}
const pathOptions = () => ({ signal: new AbortController().signal, yield: async () => {} });
function path(points, costPerPixel = 1, scale = 2) {
  points = points.map(([x, y]) => [origin[0] + x, origin[1] + y]);
  const lengths = [0];
  for (let i = 1; i < points.length; i++) lengths.push(lengths.at(-1) +
    Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
  return { points, lengths, costs: lengths.map((length) => length * costPerPixel), scale };
}
function maxTurn(points) {
  let maximum = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i].map((value, k) => value - points[i - 1][k]);
    const b = points[i + 1].map((value, k) => value - points[i][k]);
    if (Math.hypot(...a) < 1e-8 || Math.hypot(...b) < 1e-8) continue;
    maximum = Math.max(maximum, Math.abs(Math.atan2(a[0] * b[1] - a[1] * b[0],
      a[0] * b[0] + a[1] * b[1])) * 180 / Math.PI);
  }
  return maximum;
}

test('selected paths smooth pixel stairs into a gently bending centerline', async () => {
  const center = (y) => 60 + 4 * Math.sin((y - 10) * Math.PI / 100);
  const raster = image(128, (x, y) => Math.exp(-((x - center(y)) ** 2) / 8));
  const paths = await slidePaths(loc([60, 10]), [loc([60, 110])], raster, pathOptions());
  const raw = selectSlideOptions(paths)[0], smoothed = selectSlideOptions(paths, raster)[0];
  assert.ok(maxTurn(paths[0].points) >= 40, 'fixture must contain raster stair steps');
  const points = smoothed.coordinates.map(pixel);
  assert.ok(maxTurn(points) < 30, 'smoothing must remove the 45-degree pixel turns');
  assert.ok(points.length < paths[0].points.length / 2);
  assert.ok(points.every(([x, y]) => Math.abs(x - center(y)) < 1));
  assert.deepEqual(smoothed.coordinates[0], raw.coordinates[0]);
  assert.deepEqual(smoothed.coordinates.at(-1), raw.coordinates.at(-1));
  assert.equal(smoothed.score, raw.score);
});

test('smoothing preserves shared forks and deduplicated branch endpoints exactly', () => {
  const raster = image(128, () => 1);
  const trunk = [[20, 60], [40, 60], [41, 61], [60, 61], [61, 60], [70, 60]];
  const options = selectSlideOptions([
    path([...trunk, [80, 55], [100, 40]]),
    path([...trunk, [80, 65], [100, 80]]),
  ], raster);
  assert.equal(options.length, 2);
  for (const option of options) {
    assert.ok(option.coordinates.some((point) => point.every((value, k) => value === loc([70, 60])[k])));
  }
  const merged = selectSlideOptions([
    path([...trunk, [110, 60], [114, 61]]),
    path([...trunk, [110, 60], [114, 59]]),
  ], raster);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].coordinates.at(-1), loc([110, 60]));
});

test('smoothing does not shortcut a narrow hairpin into the dark space between its arms', () => {
  const raster = image(128, (x, y) => {
    const distance = Math.min(
      Math.hypot(x - Math.max(20, Math.min(100, x)), y - 40),
      Math.hypot(x - 100, y - Math.max(40, Math.min(46, y))),
      Math.hypot(x - Math.max(20, Math.min(100, x)), y - 46));
    return Math.exp(-(distance ** 2) / 0.32);
  });
  const result = smoothSlidePath([[20, 40], [100, 40], [100, 46], [20, 46]].map(loc), raster).map(pixel);
  assert.ok(result.some(([x]) => x >= 99), 'the path must still reach the far end of the hairpin');
  for (let i = 1; i < result.length; i++) {
    const a = result[i - 1], b = result[i], steps = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) * 4);
    for (let j = 0; j <= steps; j++) {
      const x = a[0] + (b[0] - a[0]) * j / steps, y = a[1] + (b[1] - a[1]) * j / steps;
      assert.ok(Math.min(Math.abs(y - 40), Math.abs(y - 46), Math.abs(x - 100)) < 0.6);
    }
  }
});

test('smoothing never rounds a covered path across a missing-imagery corner', () => {
  const raster = image(128, () => 1);
  for (let y = 0; y < 80; y++) for (let x = 61; x < 128; x++) raster.coverage[y * 128 + x] = 0;
  const result = smoothSlidePath([[20, 40], [60, 40], [60, 80], [100, 80]].map(loc), raster).map(pixel);
  for (let i = 1; i < result.length; i++) {
    const a = result[i - 1], b = result[i], steps = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) * 4);
    for (let j = 0; j <= steps; j++) {
      const x = Math.floor(a[0] + (b[0] - a[0]) * j / steps + 1e-7);
      const y = Math.floor(a[1] + (b[1] - a[1]) * j / steps + 1e-7);
      assert.equal(raster.coverage[y * 128 + x], 1);
    }
  }
});

for (const latitude of [0, 40, 65]) test(`samples all 48 positions in a 1 km grid at latitude ${latitude}`, () => {
  const anchor = [-105, latitude], center = project(anchor), scale = metersPerPixel(latitude, 15);
  const targets = sampleSlideTargets(anchor).map((point) => project(point).map((value, i) => (value - center[i]) * scale));
  assert.equal(targets.length, 48);
  const actual = new Set(targets.map(([x, y]) => `${Math.round(x * 6 / 1000)},${Math.round(y * 6 / 1000)}`));
  assert.equal(actual.size, 48);
  for (let row = -3; row <= 3; row++) for (let col = -3; col <= 3; col++) {
    assert.equal(actual.has(`${col},${row}`), !!(row || col));
  }
  for (const [x, y] of targets) {
    assert.ok(near(x, Math.round(x * 6 / 1000) * 1000 / 6));
    assert.ok(near(y, Math.round(y * 6 / 1000) * 1000 / 6));
  }
  assert.ok(near(Math.max(...targets.map(([x]) => x)) - Math.min(...targets.map(([x]) => x)), 1000));
  assert.ok(near(Math.max(...targets.map(([, y]) => y)) - Math.min(...targets.map(([, y]) => y)), 1000));
});

test('90-percent shared paths merge into the exact common trunk ending at the fork', () => {
  const options = selectSlideOptions([
    path([[0, 0], [95, 0], [100, 5]]),
    path([[0, 0], [95, 0], [100, -5]]),
  ]);
  assert.equal(options.length, 1);
  assert.ok(near(pixel(options[0].coordinates.at(-1))[0], 95));
  assert.ok(near(pixel(options[0].coordinates.at(-1))[1], 0));
  assert.equal(options[0].length, 190);
});

test('a fully contained path is removed even when it is much shorter and cheaper', () => {
  const options = selectSlideOptions([
    path([[0, 0], [90, 0]], 0.1), path([[0, 0], [90, 0], [200, 0]]),
  ]);
  assert.equal(options.length, 1);
  assert.deepEqual(options[0].coordinates.at(-1), loc([200, 0]));
});

test('sharing 90 percent of only the shorter path is not enough to merge distinct branches', () => {
  assert.equal(selectSlideOptions([
    path([[0, 0], [90, 0], [90, 10]]), path([[0, 0], [90, 0], [200, 0]]),
  ]).length, 2);
});

test('containment ignores vertex spacing and removes trunks made redundant by merging', () => {
  assert.equal(selectSlideOptions([
    path([[0, 0], [50, 0]]), path([[0, 0], [100, 0]]),
  ]).length, 1);
  const options = selectSlideOptions([
    path([[0, 0], [95, 0], [100, 5]]),
    path([[0, 0], [95, 0], [100, -5]]),
    path([[0, 0], [90, 0]]), path([[0, 0], [90, 0], [200, 0]]),
  ]);
  assert.equal(options.length, 1);
  assert.deepEqual(options[0].coordinates.at(-1), loc([200, 0]));
});

test('deduplication repeats when truncation makes two trunks overlap by 90 percent', () => {
  const options = selectSlideOptions([
    path([[0, 0], [89, 0], [89, 6], [94, 6]]),
    path([[0, 0], [89, 0], [89, 6], [89, 11]]),
    path([[0, 0], [89, 0], [89, -6], [94, -6]]),
    path([[0, 0], [89, 0], [89, -6], [89, -11]]),
  ]);
  assert.equal(options.length, 1);
  assert.deepEqual(options[0].coordinates.at(-1), loc([89, 0]));
});

test('the 90-percent boundary merges, but less than 90 percent remains separate', () => {
  for (const [trunk, expected] of [[90, 1], [89, 2]]) {
    const options = selectSlideOptions([
      path([[0, 0], [trunk, 0], [trunk, 100 - trunk]]),
      path([[0, 0], [trunk, 0], [trunk, trunk - 100]]),
    ]);
    assert.equal(options.length, expected);
  }
});

test('shared trajectories tolerate one heatmap pixel and still stop at the exact fork', () => {
  const options = selectSlideOptions([
    path([[0, 0], [89, 0], [100, 1]]),
    path([[0, 0], [89, 0], [100, -1]]),
  ]);
  assert.equal(options.length, 1);
  assert.ok(near(pixel(options[0].coordinates.at(-1))[0], 89));
});

test('all substantial branches remain visible, ordered by cost per metre rather than total cost', () => {
  const options = selectSlideOptions([
    path([[0, 0], [100, 0]], 0.5),
    path([[0, 0], [0, 10]], 1),
    ...Array.from({ length: 5 }, (_, i) =>
      path([[0, 0], [-20 - i * 10, 30 - i * 15]], 2 + i)),
  ]);
  assert.equal(options.length, 7);
  assert.equal(options[0].cost, 50);
  assert.equal(options[0].score, 0.25);
  assert.equal(options[1].cost, 10);
  assert.equal(options[1].score, 0.5);
});

test('identical paths produce one full option, not an empty or shortened path', () => {
  const value = path([[0, 0], [50, 0], [100, 0]]);
  const options = selectSlideOptions([value, value, value]);
  assert.equal(options.length, 1);
  assert.ok(near(pixel(options[0].coordinates.at(-1))[0], 100));
});

test('a shared Slide search follows an asymmetric intensity maximum, not the band outline', async () => {
  const raster = image(128, (x, y) => y >= 8 && y <= 119
    ? Math.exp(-((x - 64) ** 2) / (2 * (x < 64 ? 2 : 8) ** 2)) : 0);
  const results = await slidePaths(loc([64, 20]), [loc([64, 110])], raster, pathOptions());
  assert.equal(results.length, 1);
  assert.ok(results[0].points.every(([x]) => Math.abs(x - origin[0] - 64) < 1));
});

test('the least-cost path follows a curved heat ridge rather than the radial chord', async () => {
  const curve = (x) => 64 - 20 * Math.sin((x - 20) * Math.PI / 88);
  const raster = image(128, (x, y) => x >= 18 && x <= 110
    ? 0.8 * Math.exp(-((y - curve(x)) ** 2) / 4.5) : 0);
  const results = await slidePaths(loc([20, 64]), [loc([108, 64])], raster, pathOptions());
  assert.equal(results.length, 1);
  assert.ok(results[0].points.some(([, y]) => y - origin[1] < 46));
  assert.ok(results[0].points.every(([x, y]) => Math.abs(y - origin[1] - curve(x - origin[0])) < 2));
});

test('clicked anchors stay exact while sample endpoints snap locally to heat', async () => {
  const raster = image(128, (x, y) => x >= 8 && x <= 119 ? Math.exp(-((y - 64) ** 2) / 4.5) : 0);
  const anchor = loc([20.25, 70.5]);
  const results = await slidePaths(anchor, [loc([110, 70])], raster, pathOptions());
  assert.equal(results.length, 1);
  assert.deepEqual(results[0].points[0], project(anchor));
  assert.ok(Math.abs(results[0].points.at(-1)[1] - origin[1] - 64) <= 1);
});

test('paths across missing coverage or long dark gaps are not proposed', async () => {
  for (const missing of [false, true]) {
    const raster = image(128, (x, y) =>
      (!missing && x >= 58 && x <= 70) ? 0 : Math.exp(-((y - 64) ** 2) / 2));
    if (missing) for (let y = 0; y < 128; y++) for (let x = 58; x <= 70; x++) raster.coverage[y * 128 + x] = 0;
    await assert.rejects(slidePaths(loc([20, 64]), [loc([110, 64])], raster, pathOptions()),
      { code: 'SLIDE_NO_SIGNAL' });
  }
});

test('empty heat and cancellation are explicit failures', async () => {
  await assert.rejects(slidePaths(loc([20, 20]), [loc([100, 100])], image(128, () => 0), pathOptions()),
    { code: 'SLIDE_NO_SIGNAL' });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(slidePaths(loc([20, 20]), [loc([100, 100])], image(128, () => 1),
    { signal: controller.signal }), { name: 'AbortError' });
});

test('a fractional anchor at the raster edge does not wrap into the next row', async () => {
  const start = loc([127.8, 64.2]);
  const results = await slidePaths(start, [loc([100, 64])], image(128, () => 1), pathOptions());
  assert.equal(results.length, 1);
  assert.deepEqual(results[0].points[0], project(start));
  assert.ok(results[0].points.every(([x]) => x - origin[0] >= 100));
});

function setup(t, propose = async () => []) {
  const status = { setAttribute(key, value) { this[key] = value; } };
  const previous = globalThis.document;
  globalThis.document = { createElement: () => status };
  t.after(() => { globalThis.document = previous; });
  let currentLayer = layer, zoom = 15;
  const changes = [];
  const select = { style: {}, after() {}, addEventListener(name, fn, capture) { changes.push({ fn, capture }); } };
  const map = {
    getZoom: () => zoom,
    getCoordinates: (line) => line,
    setCoordinates(line, coordinates) { line.splice(0, line.length, ...coordinates); },
    fromContainerPixel: ([x, y]) => loc([x * 2, y * 2]),
    setStyle(overlay, style) { Object.assign(overlay.style, style); },
    addOverlay(geometry, style) { return { geometry, style: { ...style } }; },
    removeOverlay(overlay) { overlay.removed = true; },
  };
  const auto = {
    source: 'strava', data: {}, map, mapObjs: {}, stroke: '#FF0000',
    dropMenu: { container: [select], addItem(label, value) { this.item = { label, value }; } },
    fetch() { this.nativeFetches = (this.nativeFetches || 0) + 1; },
    postFetch() { this.nativePostFetches = (this.nativePostFetches || 0) + 1; },
    clear() { this.nativeClears = (this.nativeClears || 0) + 1; },
    click() { this.nativeClicks = (this.nativeClicks || 0) + 1; },
    backup() { this.nativeBackups = (this.nativeBackups || 0) + 1; },
    select() { this.nativeSelects = (this.nativeSelects || 0) + 1; },
    unselect() { this.nativeUnselects = (this.nativeUnselects || 0) + 1; },
    add(id) { this.mapObjs[id] = map.addOverlay(this.features[id].geometry, {}); },
  };
  const manager = {
    map, autoDrawOverlay: auto, handler: { mode: 'polyline' }, actions: [], override: false,
    $div: { offset: () => ({ left: 10, top: 20 }) },
    setOverride(value) {
      if (this.override === value) return;
      this.override = value;
      if (!this.polyline) return;
      if (value) this.lastPoint = this.polyline.pop();
      else if (this.lastPoint) this.polyline.push(this.lastPoint);
    },
    addPath(path, freehand, replace) {
      if (!this.polyline) {
        this.polyline = path.map((p) => p.slice());
        if (path.length === 1) this.polyline.push(path[0].slice());
        this.actions = [];
        return;
      }
      if (replace) this.polyline.pop();
      let cursor;
      if (!this.override) {
        cursor = this.polyline.at(-1);
        this.polyline[this.polyline.length - 1] = path[0];
      }
      if (!replace) this.actions.push(this.polyline.length - 1);
      this.polyline.push(...path.slice(this.override ? 0 : 1));
      if (cursor) this.polyline.push(cursor);
    },
    handleClick(event) {
      if (this.ignoreNextClick) { this.ignoreNextClick = false; return; }
      if (!this.handler || event.target.closest()) return;
      const point = map.fromContainerPixel([event.pageX - 10, event.pageY - 20]);
      if (this.mobilePreview) auto.select(point, 'strava-option-0');
      if (auto.coordinates) {
        this.addPath(auto.coordinates, false, this.lastAdditionPoint);
        auto.coordinates = undefined;
        this.lastAdditionPoint = false;
      } else {
        this.addPath([point], false);
        this.lastAdditionPoint = true;
      }
      auto.click(point);
    },
    handleMouseMove(event) {
      if (this.polyline && !this.override) this.polyline[this.polyline.length - 1] =
        map.fromContainerPixel([event.pageX - 10, event.pageY - 20]);
    },
    handleDblClick() { return this.finish(auto.reference?.snap != null); },
    undo() {
      auto.backup();
      if (this.actions.length && this.polyline) this.polyline.splice(this.actions.pop() + 1);
      else this.polyline = undefined;
    },
    cancel() { this.polyline = undefined; this.release(); },
    release() { this.handler = undefined; auto.map = null; },
    finish(removeCursor) {
      this.finishedCoordinates = this.polyline?.slice() ?? [];
      if (removeCursor) this.finishedCoordinates.pop();
      if (this.declineFinish) return false;
      this.polyline = undefined;
      this.release();
      return true;
    },
  };
  const integration = installCalTopoSnap(manager, () => currentLayer, propose);
  Object.assign(auto, auto.data.strava);
  const event = (x = 20, y = 64) => ({
    pageX: x / 2 + 10, pageY: y / 2 + 20, target: { closest: () => false }, detail: 1,
  });
  return {
    auto, manager, status, integration, event, select,
    zoom(value) { zoom = value; auto.fetch(); },
    source(value) {
      for (const { fn, capture } of changes) if (capture) fn();
      auto.source = value;
      for (const { fn, capture } of changes) if (!capture) fn();
    },
    layer(value) { currentLayer = value; integration.invalidate(); },
  };
}
const option = (start = [20, 64], end = [110, 64]) => ({
  coordinates: [loc(start), loc([60, 63]), loc(end)], score: 0.1, cost: 10, length: 100,
});

test('instructs users to click anywhere and loads no tiles before the first anchor', (t) => {
  let calls = 0;
  const { auto, status, integration, manager } = setup(t, async () => { calls++; return []; });
  auto.fetch();
  assert.equal(calls, 0);
  assert.match(status.textContent, /Click anywhere to begin/);
  assert.equal(installCalTopoSnap(manager, () => layer), integration);
});

test('identifies the snapping layer on initialization, source changes and progress updates', async (t) => {
  const pending = deferred();
  const f = setup(t, async (anchor, layer, signal, progress) => {
    progress('Loading tiles...');
    return pending.promise;
  });
  assert.equal(f.status.textContent,
    `Snapping to ${layer.name}. Click anywhere to begin. Strava will suggest paths within a 1 km grid.`);
  f.source('osm');
  assert.equal(f.status.textContent, '');
  f.source('strava');
  assert.ok(f.status.textContent.startsWith(`Snapping to ${layer.name}.`));
  const weekly = { ...layer, name: 'All Foot Sports (Weekly, Orange)' };
  f.layer(weekly);
  assert.ok(f.status.textContent.startsWith(`Snapping to ${weekly.name}.`));
  assert.ok(!f.status.textContent.includes(layer.name));
  f.manager.handleClick(f.event());
  assert.equal(f.status.textContent, `Snapping to ${weekly.name}. Finding Slide options...`);
  await Promise.resolve();
  assert.equal(f.status.textContent, `Snapping to ${weekly.name}. Loading tiles...`);
  pending.resolve([]);
  await f.integration.ready;
  assert.equal(f.status.textContent,
    `Snapping to ${weekly.name}. No Slide options found here. Click anywhere to add a straight segment.`);
  f.manager.cancel();
  assert.equal(f.status.textContent, '');
});

test('every click proposes from the exact anchor and layer without direction or zoom inputs', async (t) => {
  const calls = [];
  const { manager, integration, event } = setup(t, async (...args) => { calls.push(args); return []; });
  manager.handleClick(event());
  await integration.ready;
  manager.handleClick(event(40, 80));
  await integration.ready;
  assert.deepEqual(calls[0].slice(0, 2), [loc([20, 64]), layer]);
  assert.deepEqual(calls[1].slice(0, 2), [loc([40, 80]), layer]);
  assert.equal(calls[0].length, 4);
  assert.equal(calls[1].length, 4);
  assert.deepEqual(manager.polyline.slice(0, -1), [loc([20, 64]), loc([40, 80])]);
});

test('the drawing overlay displays every returned option rather than clipping at five', async (t) => {
  const { auto, manager, integration, event, status } = setup(t, async () => Array.from({ length: 12 }, () => option()));
  assert.doesNotMatch(status.textContent, /five|5/);
  manager.handleClick(event());
  await integration.ready;
  assert.equal(Object.keys(auto.features).length, 12);
  assert.equal(Object.keys(auto.mapObjs).length, 12);
});

test('hover previews without committing; clicking commits the prefix as one undo action', async (t) => {
  const { auto, manager, integration, event } = setup(t, async () => [option()]);
  manager.handleClick(event());
  await integration.ready;
  assert.equal(auto.mapObjs['strava-option-0'].style['stroke-width'], 7);
  assert.equal(auto.mapObjs['strava-option-0'].style['stroke-opacity'], 0.4);
  auto.select(loc([90, 64]), 'strava-option-0');
  assert.equal(auto.mapObjs['strava-option-0'].style['stroke-width'], 10);
  assert.equal(auto.mapObjs['strava-option-0'].style['stroke-opacity'], 0.8);
  assert.equal(manager.polyline.length, 1);
  assert.ok(auto.coordinates.length >= 2);
  manager.handleClick(event(90, 63.6));
  await integration.ready;
  const committed = manager.polyline.slice(0, -1);
  assert.equal(committed.length, 3);
  assert.ok(near(pixel(committed.at(-1))[0], 90));
  manager.undo();
  await integration.ready;
  assert.deepEqual(manager.polyline.slice(0, -1), [loc([20, 64])]);
});

test('clicking off an option adds a straight segment even before hover-out timeout', async (t) => {
  const { auto, manager, integration, event } = setup(t, async () => [option()]);
  manager.handleClick(event());
  await integration.ready;
  auto.select(loc([90, 64]), 'strava-option-0');
  manager.handleClick(event(90, 100));
  await integration.ready;
  assert.deepEqual(manager.polyline.slice(0, -1), [loc([20, 64]), loc([90, 100])]);
});

test('native touch previews cannot replace a prepared click or its undo boundary', async (t) => {
  const { auto, manager, integration, event } = setup(t, async () => [option()]);
  manager.handleClick(event());
  await integration.ready;
  manager.mobilePreview = true;
  auto.select(loc([90, 64]), 'strava-option-0');
  manager.handleClick(event(90, 63.6));
  await integration.ready;
  assert.equal(manager.polyline.slice(0, -1).length, 3);
  assert.deepEqual(manager.actions, [1]);
  manager.undo();
  await integration.ready;
  assert.deepEqual(manager.polyline.slice(0, -1), [loc([20, 64])]);
  manager.handleClick(event(90, 100));
  await integration.ready;
  assert.deepEqual(manager.polyline.slice(0, -1), [loc([20, 64]), loc([90, 100])]);
});

for (const action of ['click', 'undo', 'cancel', 'release', 'finish', 'source', 'layer', 'zoom']) {
  test(`${action} rejects stale suggestions and aborts their calculation`, async (t) => {
    const job = deferred();
    let signal, calls = 0;
    const context = setup(t, (...args) => {
      if (calls++ === 0) { signal = args[2]; return job.promise; }
      return [];
    });
    const { manager, integration, event, auto } = context;
    manager.handleClick(event());
    const stale = integration.ready;
    await Promise.resolve();
    if (action === 'click') manager.handleClick(event(40, 100));
    else if (action === 'source') context.source('osm');
    else if (action === 'layer') context.layer({ template: 'different' });
    else if (action === 'zoom') context.zoom(14);
    else await manager[action]();
    assert.equal(signal.aborted, true);
    job.resolve([option()]);
    await stale;
    await integration.ready;
    assert.equal(Object.keys(auto.mapObjs).length, 0);
  });
}

test('panning and changing eligible zoom levels do not rerun the fixed grid', async (t) => {
  let calls = 0;
  const { auto, manager, integration, event, zoom } = setup(t, async () => { calls++; return []; });
  manager.handleClick(event());
  await integration.ready;
  auto.fetch();
  await integration.ready;
  assert.equal(calls, 1);
  zoom(17);
  await integration.ready;
  assert.equal(calls, 1);
});

test('below zoom 15, clicks remain available but no Slide search runs', async (t) => {
  let calls = 0;
  const { manager, integration, event, zoom, status } = setup(t, async () => { calls++; return []; });
  zoom(14);
  manager.handleClick(event());
  await integration.ready;
  assert.equal(calls, 0);
  assert.match(status.textContent, /level 15/);
  assert.equal(manager.polyline.length, 2);
});

test('double-click finishes without saving a stale cursor or starting a second search', async (t) => {
  let calls = 0;
  const { manager, integration, event } = setup(t, async () => { calls++; return []; });
  manager.handleClick(event());
  await integration.ready;
  manager.handleClick({ ...event(80, 90), detail: 1 });
  await integration.ready;
  manager.handleClick({ ...event(81, 91), detail: 2 });
  await manager.handleDblClick(event(81, 91));
  assert.equal(calls, 2);
  assert.deepEqual(manager.finishedCoordinates, [loc([20, 64]), loc([80, 90])]);
});

test('undo restores the previous anchor and undoing the first returns to the initial prompt', async (t) => {
  const calls = [];
  const { manager, integration, event, status } = setup(t, async (...args) => { calls.push(args); return []; });
  for (const point of [[20, 64], [40, 80], [80, 100]]) {
    manager.handleClick(event(...point));
    await integration.ready;
  }
  manager.undo();
  await integration.ready;
  assert.deepEqual(calls.at(-1).slice(0, 2), [loc([40, 80]), layer]);
  manager.undo();
  await integration.ready;
  manager.undo();
  await integration.ready;
  assert.equal(manager.polyline, undefined);
  assert.match(status.textContent, /Click anywhere to begin/);
});

test('declining finish regenerates options without changing the drawing', async (t) => {
  let calls = 0;
  const { auto, manager, integration, event } = setup(t, async () => { calls++; return [option()]; });
  manager.handleClick(event());
  await integration.ready;
  const before = manager.polyline.map((point) => point.slice());
  manager.declineFinish = true;
  assert.equal(await manager.finish(true), false);
  await integration.ready;
  assert.equal(calls, 2);
  assert.deepEqual(manager.polyline, before);
  assert.deepEqual(Object.keys(auto.features), ['strava-option-0']);
});

test('enabling Strava during a drawing starts suggestions at its last confirmed point', async (t) => {
  const calls = [];
  const { manager, integration, event, source } = setup(t, async (...args) => { calls.push(args); return []; });
  source('osm');
  manager.handleClick(event());
  manager.handleClick(event(40, 80));
  source('strava');
  await integration.ready;
  assert.deepEqual(calls.at(-1).slice(0, 2), [loc([40, 80]), layer]);
});

test('errors remain visible and do not prevent subsequent straight clicks', async (t) => {
  const previous = console.warn;
  console.warn = () => {};
  t.after(() => { console.warn = previous; });
  const { manager, integration, event, status } = setup(t, async () => { throw new Error('Strava access expired.'); });
  manager.handleClick(event());
  await integration.ready;
  assert.equal(status.role, 'alert');
  assert.match(status.textContent, /access expired/);
  manager.handleClick(event(100, 100));
  await integration.ready;
  assert.equal(manager.polyline.slice(0, -1).length, 2);
});

test('non-Strava sources retain native fetch, selection, click, and undo routing', (t) => {
  const { auto, source } = setup(t);
  source('osm');
  auto.fetch(); auto.postFetch(); auto.select(); auto.unselect(); auto.click(); auto.backup(); auto.clear();
  assert.equal(auto.nativeFetches, 1);
  assert.equal(auto.nativePostFetches, 1);
  assert.equal(auto.nativeSelects, 1);
  assert.equal(auto.nativeUnselects, 1);
  assert.equal(auto.nativeClicks, 1);
  assert.equal(auto.nativeBackups, 1);
  assert.equal(auto.nativeClears, 1);
});

test('late native-source tile responses cannot populate Slide options', async (t) => {
  const { auto, manager, integration, event } = setup(t, async () => [option()]);
  manager.handleClick(event());
  await integration.ready;
  auto.postFetch('old-osm-tile', []);
  assert.equal(auto.nativePostFetches, undefined);
  assert.deepEqual(Object.keys(auto.features), ['strava-option-0']);
});

function pngChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff;
  for (const byte of body) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  const chunk = Buffer.alloc(body.length + 8);
  chunk.writeUInt32BE(data.length); body.copy(chunk, 4);
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, body.length + 4);
  return chunk;
}

test('the 1 km grid fits the existing tile budget and drops contained interior targets', async (t) => {
  const anchor = loc([64, 64]), heatY = Math.round(project(anchor)[1]);
  const previous = globalThis.fetch, requests = [];
  globalThis.fetch = async (url) => {
    const [, z, tx, ty] = new URL(url).pathname.match(/\/(\d+)\/(\d+)\/(\d+)\.png$/).map(Number);
    requests.push(z);
    const rows = Buffer.alloc(513 * 512);
    for (let y = 0; y < 512; y++) for (let x = 0; x < 512; x++) {
      rows[y * 513 + x + 1] = Math.round(255 * Math.exp(-((ty * 512 + y - heatY) ** 2) / 4.5));
    }
    const header = Buffer.alloc(13);
    header.writeUInt32BE(512); header.writeUInt32BE(512, 4); header[8] = 8;
    return new Response(Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header),
      pngChunk('IDAT', deflateSync(rows)), pngChunk('IEND', Buffer.alloc(0)),
    ]));
  };
  t.after(() => { globalThis.fetch = previous; });
  const options = await loadSlideOptions(anchor, layer, new AbortController().signal);
  assert.equal(options.length, 2);
  assert.ok(requests.length <= 16);
  assert.ok(requests.every((zoom) => zoom === 15));
  for (const option of options) {
    assert.deepEqual(option.coordinates[0], anchor);
    assert.ok(option.coordinates.every((point) => Math.abs(project(point)[1] - heatY) <= 1.5));
    assert.ok(option.length > 0 && Number.isFinite(option.score));
  }
});

test('logged-out imagery and tile errors are surfaced, not used as suggestions', async (t) => {
  const signal = new AbortController().signal, anchor = [-105, 40];
  await assert.rejects(loadSlideOptions(anchor,
    { template: 'https://example.com/fallback/{z}/{x}/{y}.png' }, signal), /Log into Strava/);
  const previous = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 401 });
  t.after(() => { globalThis.fetch = previous; });
  await assert.rejects(loadSlideOptions(anchor, layer, signal), /Strava access expired/);
});

test('cancelling the grid search surfaces an abort', async (t) => {
  const previous = globalThis.fetch, controller = new AbortController();
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    controller.abort();
    throw new DOMException('Cancelled', 'AbortError');
  };
  t.after(() => { globalThis.fetch = previous; });
  await assert.rejects(loadSlideOptions([-105, 40], layer, controller.signal), { name: 'AbortError' });
  assert.ok(calls <= 16);
});
