import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../src/content/inject-client.js', import.meta.url), 'utf8');

async function inject(stored, failure, host = 'caltopo.com') {
  const appended = [];
  const writes = [];
  const warnings = [];
  const errors = [];
  const messages = [];
  const listeners = {};
  const window = {
    location: { host, hash: '', origin: `https://${host}` },
    addEventListener: (type, handler) => { listeners[type] = handler; },
  };
  await vm.runInNewContext(source, {
    window,
    console: {
      debug() {}, log() {},
      warn: (...args) => warnings.push(args),
      error: (...args) => errors.push(args),
    },
    browser: {
      runtime: {
        getManifest: () => ({ version: '0' }),
        getURL: (path) => `chrome-extension://test/${path}`,
        sendMessage: async ({ type }) => {
          messages.push(type);
          if (type === 'openSettings' && failure === 'settings') throw new Error('Popup failed');
          return type === 'requestLayerPresets' ? 'run:orange' : true;
        },
      },
      storage: { local: {
        get: async (key) => {
          assert.equal(key, 'mapsheetmaxsize');
          if (failure === 'get') throw new Error('Storage read failed');
          return stored === undefined ? {} : { mapsheetmaxsize: stored };
        },
        set: async (values) => {
          if (failure === 'set') throw new Error('Storage write failed');
          writes.push(JSON.parse(JSON.stringify(values)));
        },
      } },
    },
    document: {
      createElement: () => ({ dataset: {} }),
      head: { append: (element) => appended.push(element) },
    },
  });
  return {
    script: appended.find((element) => element.type === 'module'),
    writes, warnings, errors, messages, listeners, window,
  };
}

test('CalTopo forwards only same-window, same-origin settings requests', async () => {
  for (const host of ['caltopo.com', 'www.caltopo.com']) {
    const f = await inject(0, undefined, host);
    const event = {
      source: f.window, origin: f.window.location.origin,
      data: { type: 'stravaHeatmapOpenSettings' },
    };
    await f.listeners.message({ ...event, source: {} });
    await f.listeners.message({ ...event, origin: 'https://other.example' });
    await f.listeners.message({ ...event, data: { type: 'openLogin' } });
    assert.ok(!f.messages.includes('openSettings'));
    await f.listeners.message(event);
    assert.equal(f.messages.filter((type) => type === 'openSettings').length, 1);
  }
  const other = await inject(0, undefined, 'brouter.de');
  assert.equal(other.listeners.message, undefined);
});

test('settings popup failures are reported', async () => {
  const f = await inject(0, 'settings');
  await f.listeners.message({
    source: f.window, origin: f.window.location.origin,
    data: { type: 'stravaHeatmapOpenSettings' },
  });
  assert.match(f.errors[0][0], /Error opening heatmap settings/);
});

test('client injection persists a missing map-sheet limit as zero and passes it to CalTopo', async () => {
  const result = await inject();
  assert.deepEqual(result.writes, [{ mapsheetmaxsize: 0 }]);
  assert.equal(result.script.dataset.mapsheetmaxsize, 0);
  assert.equal(result.script.dataset.layers, 'run:orange');
  assert.equal(result.errors.length, 0);
});

test('client injection preserves zero and positive integer limits without overwriting storage', async () => {
  for (const limit of [0, 1, 7, 100, 225]) {
    const result = await inject(limit);
    assert.equal(result.script.dataset.mapsheetmaxsize, limit);
    assert.deepEqual(result.writes, []);
    assert.equal(result.warnings.length, 0);
    assert.equal(result.errors.length, 0);
  }
});

test('invalid map-sheet limits remain hidden and are reported without overwriting storage', async () => {
  for (const limit of [-1, 1.5, '100', null, true, Number.MAX_SAFE_INTEGER + 1]) {
    const result = await inject(limit);
    assert.equal(result.script.dataset.mapsheetmaxsize, 0);
    assert.deepEqual(result.writes, []);
    assert.match(result.warnings[0][0], /Invalid mapsheetmaxsize/);
  }
});

test('storage failures are reported and do not expose map sheets or block heatmap injection', async () => {
  for (const failure of ['get', 'set']) {
    const result = await inject(undefined, failure);
    assert.equal(result.script.dataset.mapsheetmaxsize, 0);
    assert.equal(result.script.dataset.layers, 'run:orange');
    assert.match(result.errors[0][0], /Error retrieving map sheet maximum size/);
  }
});
