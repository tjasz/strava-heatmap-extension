import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../src/content/inject-client.js', import.meta.url), 'utf8');

async function inject(stored, failure) {
  const appended = [];
  const writes = [];
  const warnings = [];
  const errors = [];
  await vm.runInNewContext(source, {
    window: { location: { host: 'caltopo.com', hash: '' } },
    console: {
      debug() {}, log() {},
      warn: (...args) => warnings.push(args),
      error: (...args) => errors.push(args),
    },
    browser: {
      runtime: {
        getManifest: () => ({ version: '0' }),
        getURL: (path) => `chrome-extension://test/${path}`,
        sendMessage: async ({ type }) => type === 'requestLayerPresets' ? 'run:orange' : true,
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
    writes, warnings, errors,
  };
}

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
