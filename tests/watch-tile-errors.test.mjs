import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/content/watch-tile-errors.js', import.meta.url), 'utf8');

function fixture() {
  const handlers = {};
  const messages = [];
  const requests = [];
  const window = { addEventListener: (type, handler) => { handlers[type] = handler; } };
  vm.runInNewContext(source, {
    window, Date,
    document: { addEventListener: (type, handler) => { handlers[type] = handler; } },
    console: { debug() {}, log() {}, error() {} },
    browser: { runtime: { sendMessage: async (message) => { messages.push(message); } } },
    fetch: async (url) => { requests.push(url); return { status: 403 }; },
  });
  return { window, handlers, messages, requests };
}

test('managed weekly auth failures revalidate once without issuing a second HEAD request', async () => {
  const state = fixture();
  await state.handlers.error({ target: {
    tagName: 'IMG', src: 'https://content-a.strava.com/weeklyheat/12/1/2?sport_types=run',
  } });
  assert.equal(state.requests.length, 0);
  state.handlers.message({
    source: state.window, data: { type: 'stravaHeatmapTileError', status: 403 },
  });
  state.handlers.message({
    source: state.window, data: { type: 'stravaHeatmapTileError', status: 401 },
  });
  assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0].type, 'requestCredentials');
});

test('server and network failures, unrelated messages and other frames do not invalidate weekly credentials', () => {
  const state = fixture();
  for (const status of [503, 502, 504, 429, 404, 'NETWORK_ERROR']) {
    state.handlers.message({
      source: state.window, data: { type: 'stravaHeatmapTileError', status },
    });
  }
  state.handlers.message({
    source: {}, data: { type: 'stravaHeatmapTileError', status: 403 },
  });
  state.handlers.message({
    source: state.window, data: { type: 'other', status: 403 },
  });
  assert.equal(state.messages.length, 0);
});

test('global image errors preserve the existing auth status check', async () => {
  const state = fixture();
  await state.handlers.error({ target: {
    tagName: 'IMG', src: 'https://content-a.strava.com/identified/globalheat/run/grayscale/12/1/2.png',
  } });
  assert.equal(state.requests.length, 1);
  assert.equal(state.messages.length, 1);
});
