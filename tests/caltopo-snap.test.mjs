import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { project, unproject } from '../src/clients/www.openstreetmap.org/slide/algorithm.js';
import {
  installCalTopoSnap,
  traceHeatmap,
} from '../src/clients/caltopo.com/snap.js';

function setup(t, trace) {
  const status = { setAttribute(key, value) { this[key] = value; } };
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: () => status };
  t.after(() => { globalThis.document = previousDocument; });
  const listeners = {};
  const select = {
    style: {},
    after() {},
    addEventListener(name, fn) { listeners[name] = fn; },
  };
  let layer = { template: 'https://content-a.strava.com/identified/globalheat/run/blue/{z}/{x}/{y}.png' };
  const manager = {
    handler: { mode: 'polyline' },
    polyline: [[0, 0], [1, 0]],
    actions: [],
    lastAdditionPoint: true,
    override: false,
    $div: { offset: () => ({ left: 10, top: 20 }) },
    map: {
      getCoordinates: (line) => line,
      fromContainerPixel: (pixel) => pixel,
    },
    autoDrawOverlay: {
      source: 'strava',
      data: {},
      dropMenu: {
        container: [select],
        addItem(label, value) { this.item = { label, value }; },
      },
      fetch() { this.fetches = (this.fetches || 0) + 1; },
    },
    addPath(path, freehand, replacePreview) {
      const line = this.polyline;
      if (replacePreview) line.pop();
      const cursor = line[line.length - 1];
      line[line.length - 1] = path[0];
      this.actions.push(line.length - 1);
      line.push(...path.slice(1), cursor);
    },
    handleClick(event) {
      this.clicks = (this.clicks || 0) + 1;
      if (this.ignoreNextClick) { this.ignoreNextClick = false; return; }
      if (event.target.closest()) return;
      const auto = this.autoDrawOverlay;
      if (!this.polyline) {
        this.polyline = [[0, 0], [0, 0]];
      } else if (auto.coordinates) {
        this.addPath(auto.coordinates, false, this.lastAdditionPoint);
        auto.coordinates = undefined;
        this.lastAdditionPoint = false;
      }
    },
    setOverride(value) { this.override = value; },
    handleMouseMove() { this.moves = (this.moves || 0) + 1; },
    handleDblClick() { this.doubles = (this.doubles || 0) + 1; },
    undo() { this.polyline.splice(this.actions.pop() + 1); },
    cancel() { this.polyline = undefined; this.handler = undefined; },
    release() { this.handler = undefined; },
    finish() { this.finished = true; },
  };
  const getLayer = () => layer;
  const integration = installCalTopoSnap(manager, getLayer, trace);
  const event = (x = 2, y = 0) => ({
    pageX: x + 10, pageY: y + 20, target: { closest: () => false },
  });
  return {
    manager, status, select, integration, getLayer, event,
    changeSource(source) {
      manager.autoDrawOverlay.source = source;
      listeners.change();
    },
    changeLayer(value) { layer = value; },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('Strava is installed once, never fetched as a CalTopo vector source', (t) => {
  const { manager, integration, getLayer, select } = setup(t);
  assert.equal(installCalTopoSnap(manager, getLayer), integration);
  assert.deepEqual(manager.autoDrawOverlay.dropMenu.item, { label: 'Strava', value: 'strava' });
  assert.equal(select.style.width, 'auto');
  manager.autoDrawOverlay.fetch();
  assert.equal(manager.autoDrawOverlay.fetches, undefined);
  manager.autoDrawOverlay.source = 'osm';
  manager.autoDrawOverlay.fetch();
  assert.equal(manager.autoDrawOverlay.fetches, 1);
});

for (const mode of ['polyline', 'polygon']) {
  test(`${mode} segments replace only the cursor and use native undo boundaries`, async (t) => {
    const { manager, event, getLayer } = setup(t, async ([start, end], layer) => {
      assert.equal(layer, getLayer());
      return [start, [(start[0] + end[0]) / 2, 0.1], end];
    });
    manager.handler.mode = mode;
    await manager.handleClick(event());
    assert.deepEqual(manager.polyline.slice(0, -1), [[0, 0], [1, 0.1], [2, 0]]);
    assert.deepEqual(manager.actions, [1]);
    await manager.handleClick(event(4));
    assert.deepEqual(manager.polyline.slice(0, -1), [
      [0, 0], [1, 0.1], [2, 0], [3, 0.1], [4, 0],
    ]);
    assert.deepEqual(manager.actions, [1, 3]);
    manager.undo();
    assert.deepEqual(manager.polyline.slice(0, -1), [[0, 0], [1, 0.1], [2, 0]]);
    manager.handleMouseMove();
    await manager.handleClick(event(5));
    assert.deepEqual(manager.polyline.slice(0, -1), [
      [0, 0], [1, 0.1], [2, 0], [3.5, 0.1], [5, 0],
    ]);
    manager.undo();
    manager.undo();
    assert.deepEqual(manager.polyline.slice(0, -1), [[0, 0]]);
  });
}

test('first point, other snap modes, inactive drawing, and post-drag clicks remain native', async (t) => {
  let traces = 0;
  const { manager, event } = setup(t, () => { traces++; });
  manager.polyline = undefined;
  await manager.handleClick(event());
  manager.ignoreNextClick = true;
  await manager.handleClick(event());
  manager.autoDrawOverlay.source = 'osm';
  await manager.handleClick(event());
  manager.autoDrawOverlay.source = 'strava';
  manager.handler = undefined;
  await manager.handleClick(event());
  assert.equal(traces, 0);
  assert.equal(manager.clicks, 4);
});

test('polygon and buffer mode traces a closing edge and delegates finishing to CalTopo', async (t) => {
  const { manager, event } = setup(t, async ([start, end]) =>
    [start, [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2 + 0.1], end]);
  manager.handler.mode = 'polygon';
  const handler = manager.handler;
  await manager.handleClick(event(2, 0));
  await manager.handleClick(event(2, 2));
  await manager.handleClick(event(0, 0));
  assert.deepEqual(manager.polyline.slice(0, -1), [
    [0, 0], [1, 0.1], [2, 0], [2, 1.1], [2, 2], [1, 1.1], [0, 0],
  ]);
  assert.equal(manager.handler, handler);
  manager.finish();
  assert.equal(manager.finished, true);
});

test('pending tracing blocks extra commits, cursor edits, and double-click finish', async (t) => {
  const job = deferred();
  const { manager, event, status } = setup(t, () => job.promise);
  const first = manager.handleClick(event());
  await manager.handleClick(event(4));
  manager.handleMouseMove();
  manager.handleDblClick();
  assert.equal(manager.clicks, undefined);
  assert.equal(manager.moves, undefined);
  assert.equal(manager.doubles, undefined);
  assert.match(status.textContent, /Loading/);
  job.resolve([[0, 0], [2, 0]]);
  await first;
  assert.equal(manager.clicks, 1);
  manager.handleMouseMove();
  manager.handleDblClick();
  assert.equal(manager.moves, 1);
  assert.equal(manager.doubles, 1);
});

for (const mode of ['polyline', 'polygon']) {
  for (const action of ['undo', 'cancel', 'release', 'finish', 'source', 'invalidate']) {
    test(`${mode} ${action} aborts a pending trace and rejects its late result`, async (t) => {
      const job = deferred();
      let signal;
      const context = setup(t, (locations, layer, value) => {
        signal = value;
        return job.promise;
      });
      const { manager, event, status } = context;
      manager.handler.mode = mode;
      manager.actions.push(0);
      const work = manager.handleClick(event());
      if (action === 'source') context.changeSource('osm');
      else if (action === 'invalidate') context.integration.invalidate();
      else manager[action]();
      assert.equal(signal.aborted, true);
      job.resolve([[0, 0], [2, 0]]);
      await work;
      assert.equal(manager.clicks, undefined);
      assert.equal(status.textContent, '');
    });
  }
}

for (const change of ['layer', 'session', 'geometry']) {
  test(`changed ${change} cannot receive a stale route`, async (t) => {
    const job = deferred();
    const { manager, event, changeLayer, status } = setup(t, () => job.promise);
    const warn = console.warn;
    const warnings = [];
    console.warn = (...args) => warnings.push(args);
    t.after(() => { console.warn = warn; });
    const work = manager.handleClick(event());
    if (change === 'layer') changeLayer({ template: 'different' });
    else if (change === 'session') manager.handler = { mode: 'polyline' };
    else manager.polyline[0] = [1, 1];
    job.resolve([[0, 0], [2, 0]]);
    await work;
    assert.equal(manager.clicks, undefined);
    if (change === 'geometry') {
      assert.match(status.textContent, /line changed/);
      assert.equal(warnings.length, 1);
    } else assert.equal(status.textContent, '');
  });
}

test('errors are visible and never commit a straight-line fallback', async (t) => {
  const warn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args);
  t.after(() => { console.warn = warn; });
  const { manager, event, status } = setup(t, async () => {
    throw new Error('Strava access expired.');
  });
  const before = structuredClone(manager.polyline);
  await manager.handleClick(event());
  assert.deepEqual(manager.polyline, before);
  assert.equal(manager.clicks, undefined);
  assert.equal(status.role, 'alert');
  assert.match(status.textContent, /Strava access expired/);
  assert.equal(warnings.length, 1);
});

test('logged-out fallback imagery cannot be used as heat data', async () => {
  await assert.rejects(traceHeatmap([[0, 0], [0.0001, 0]], {
    template: 'https://example.com/fallback/{z}/{x}/{y}.png',
  }, new AbortController().signal, () => {}), /Log into Strava/);
});

for (const [status, message] of [
  [401, /Strava access expired/],
  [403, /Strava access expired/],
  [404, /No heatmap tiles/],
  [500, /HTTP 500/],
]) {
  test(`tile HTTP ${status} is surfaced instead of committing fake heat data`, async (t) => {
    const fetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(null, { status });
    t.after(() => { globalThis.fetch = fetch; });
    await assert.rejects(traceHeatmap([[0, 0], [0.0001, 0]], {
      template: 'https://content-a.strava.com/identified/globalheat/run/blue/{z}/{x}/{y}.png',
    }, new AbortController().signal, () => {}), message);
  });
}

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

test('real tile decoding and Slide follow a curved centerline, not the clicked chord', async (t) => {
  const curve = (x) => 256 + 5 * Math.sin((x - 190) * Math.PI / 100);
  const rows = Buffer.alloc(513 * 512);
  for (let y = 0; y < 512; y++) {
    for (let x = 180; x <= 300; x++) {
      rows[y * 513 + x + 1] = Math.round(
        255 * Math.exp(-((y - curve(x)) ** 2) / (2 * 1.5 ** 2)));
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(512);
  header.writeUInt32BE(512, 4);
  header[8] = 8;
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(rows)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  const fetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return new Response(png, { status: 200 });
  };
  t.after(() => { globalThis.fetch = fetch; });
  const [x, y] = project([-105.29, 39.97]).map((v) => Math.floor(v / 512) * 512);
  const locations = [[190, 256], [290, 256]].map(([dx, dy]) => unproject([x + dx, y + dy]));
  const progress = [];
  const result = await traceHeatmap(locations, {
    template: 'https://content-a.strava.com/identified/globalheat/run/gray/{z}/{x}/{y}.png?v=20#strava-gradient=000000-ffffff',
  }, new AbortController().signal, (message) => progress.push(message));
  assert.deepEqual(result[0], locations[0]);
  assert.deepEqual(result.at(-1), locations[1]);
  assert.ok(result.length > 2);
  const pixels = result.map((loc) => project(loc).map((v, i) => v - [x, y][i]));
  assert.ok(Math.max(...pixels.map((p) => p[1])) > 259, 'must follow the curved heat ridge');
  for (const [px, py] of pixels) {
    assert.ok(Math.abs(py - curve(px)) < 2, 'vertices stay within two pixels of centerline');
  }
  assert.ok(progress.includes('Following Strava heat centerline...'));
  assert.ok(requests.length > 0);
  assert.ok(requests.every(({ url, options }) =>
    url.includes('/run/gray/15/') && options.credentials === 'omit'));
});

test('CalTopo can load all transitive Slide modules in packaged extensions', async () => {
  const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url)));
  const resources = manifest.web_accessible_resources
    .filter(({ matches }) => matches.includes('*://caltopo.com/*') &&
      matches.includes('*://www.caltopo.com/*'))
    .flatMap(({ resources }) => resources);
  for (const file of [
    'src/clients/caltopo.com/snap.js',
    ...['algorithm', 'tiles', 'png'].map((name) =>
      `src/clients/www.openstreetmap.org/slide/${name}.js`),
  ]) assert.ok(resources.includes(file), `${file} must be accessible on CalTopo`);
});
