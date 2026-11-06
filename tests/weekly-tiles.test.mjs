import assert from 'node:assert/strict';
import test from 'node:test';
import { createWeeklyTileLoader, isWeeklyTile } from '../src/clients/common/weekly-tiles.js';

const url = 'https://content-a.strava.com/weeklyheat/12/1/2?sport_types=run';
const tick = () => new Promise(setImmediate);

function fixture(t, fetch) {
  const requests = [];
  const timers = [];
  const messages = [];
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    const timer = { callback, delay };
    timers.push(timer);
    return timer;
  });
  t.mock.method(globalThis, 'clearTimeout', (timer) => {
    const index = timers.indexOf(timer);
    if (index >= 0) timers.splice(index, 1);
  });
  t.mock.method(Math, 'random', () => 0.5);
  t.mock.method(console, 'warn', () => {});
  const previous = globalThis.window;
  globalThis.window = {
    location: { origin: 'https://caltopo.com' },
    postMessage: (message) => messages.push(message),
  };
  t.after(() => {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  });
  const loader = createWeeklyTileLoader(async (...args) => {
    requests.push(args);
    return fetch(requests.length, ...args);
  });
  return { loader, timers, messages, requests, async retry(delay) {
    await tick();
    assert.equal(timers.length, 1);
    const timer = timers.shift();
    assert.equal(timer.delay, delay);
    timer.callback();
    await tick();
  } };
}

test('weekly matching is restricted to Strava HTTPS tile endpoints', () => {
  assert.ok(isWeeklyTile(url));
  for (const other of [
    'https://example.com/weeklyheat/12/1/2',
    'http://content-a.strava.com/weeklyheat/12/1/2',
    'https://content-a.strava.com/weeklyheat/12/1/2/other',
    'https://content-a.strava.com/identified/globalheat/run/grayscale/12/1/2.png',
  ]) assert.equal(isWeeklyTile(other), false);
});

test('503 retries exactly three times with 1/2/4-second backoff and bypasses cached failures', async (t) => {
  const state = fixture(t, async () => new Response('unavailable', { status: 503 }));
  const result = state.loader(url);
  await state.retry(1000);
  await state.retry(2000);
  await state.retry(4000);
  assert.equal((await result).status, 503);
  assert.equal(state.requests.length, 4);
  assert.equal(state.requests[0][1].cache, undefined);
  assert.ok(state.requests.slice(1).every(([, options]) => options.cache === 'reload'));
  assert.equal(state.timers.length, 0);
  assert.equal(console.warn.mock.callCount(), 1);
});

test('backoff has jitter rather than synchronizing failed tiles', async (t) => {
  const state = fixture(t, async (attempt) => new Response('tile', { status: attempt === 1 ? 503 : 200 }));
  t.mock.method(Math, 'random', () => 0);
  const result = state.loader(url);
  await state.retry(750);
  assert.equal((await result).status, 200);
});

test('Retry-After supports seconds and HTTP dates', async (t) => {
  for (const value of ['10', 'Fri, 06 Nov 2026 16:00:10 GMT']) {
    await t.test(value, async (t) => {
      t.mock.method(Date, 'now', () => Date.parse('Fri, 06 Nov 2026 16:00:00 GMT'));
      const state = fixture(t, async (attempt) => new Response('tile', {
        status: attempt === 1 ? 503 : 200, headers: { 'Retry-After': value },
      }));
      const result = state.loader(url);
      await state.retry(10000);
      assert.equal(await (await result).text(), 'tile');
    });
  }
});

test('transient HTTP and network failures recover, while permanent HTTP failures do not retry', async (t) => {
  for (const status of [429, 502, 504, 'network', 401, 403, 404]) {
    await t.test(String(status), async (t) => {
      const transient = [429, 502, 504, 'network'].includes(status);
      const state = fixture(t, async (attempt) => {
        if (attempt === 1 && status === 'network') throw new TypeError('Failed to fetch');
        return new Response('tile', { status: attempt > 1 ? 200 : status });
      });
      const result = state.loader(url);
      if (transient) await state.retry(1000);
      assert.equal((await result).status, transient ? 200 : status);
      assert.equal(state.requests.length, transient ? 2 : 1);
      assert.deepEqual(state.messages, status === 401 || status === 403
        ? [{ type: 'stravaHeatmapTileError', status }] : []);
    });
  }
});

test('concurrent consumers share a raw tile but receive independently readable responses', async (t) => {
  let resolve;
  const state = fixture(t, () => new Promise((done) => { resolve = done; }));
  const first = state.loader(`${url}#strava-gradient=000000-ffffff`);
  const second = state.loader(new Request(`${url}#strava-gradient=ff0000-ffffff`));
  assert.equal(state.requests.length, 1);
  resolve(new Response('pixels'));
  assert.deepEqual(await Promise.all([first, second].map(async (result) =>
    (await result).text())), ['pixels', 'pixels']);
});

test('aborting one consumer does not cancel others; aborting the last cancels the retry timer', async (t) => {
  const state = fixture(t, async () => new Response('unavailable', { status: 503 }));
  const first = new AbortController();
  const second = new AbortController();
  const a = state.loader(url, { signal: first.signal });
  const b = state.loader(url, { signal: second.signal });
  const rejectedA = assert.rejects(a, { name: 'AbortError' });
  const rejectedB = assert.rejects(b, { name: 'AbortError' });
  await tick();
  first.abort();
  await rejectedA;
  assert.equal(state.requests[0][1].signal.aborted, false);
  second.abort();
  await rejectedB;
  await tick();
  assert.equal(state.requests[0][1].signal.aborted, true);
  assert.equal(state.timers.length, 0);
  assert.equal(state.requests.length, 1);
});

test('cancellation in flight aborts native fetch and a new consumer starts a fresh request', async (t) => {
  const state = fixture(t, async (_attempt, _input, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  const controller = new AbortController();
  const result = state.loader(url, { signal: controller.signal });
  const rejected = assert.rejects(result, { name: 'AbortError' });
  controller.abort();
  await rejected;
  assert.equal(state.requests[0][1].signal.aborted, true);
  const nextController = new AbortController();
  const next = state.loader(url, { signal: nextController.signal });
  const rejectedNext = assert.rejects(next, { name: 'AbortError' });
  assert.equal(state.requests.length, 2);
  nextController.abort();
  await rejectedNext;
});

test('nonweekly requests, HEAD checks and distinct request options are not deduplicated', async (t) => {
  const state = fixture(t, async () => new Response('tile'));
  await state.loader('https://example.com/image.png');
  await state.loader(url, { method: 'HEAD' });
  await Promise.all([
    state.loader(url, { credentials: 'include' }),
    state.loader(url, { credentials: 'omit' }),
  ]);
  assert.equal(state.requests.length, 4);
  assert.equal(state.requests[0][0], 'https://example.com/image.png');
  assert.equal(state.requests[1][1].method, 'HEAD');
});

test('network failures stop after three retries and reject explicitly', async (t) => {
  const state = fixture(t, async () => { throw new TypeError('Failed to fetch'); });
  const result = state.loader(url);
  const rejected = assert.rejects(result, /Failed to fetch/);
  await state.retry(1000);
  await state.retry(2000);
  await state.retry(4000);
  await rejected;
  assert.equal(state.requests.length, 4);
  assert.equal(state.timers.length, 0);
  assert.equal(console.warn.mock.callCount(), 1);
});

test('an already-aborted consumer never starts a request', (t) => {
  const state = fixture(t, async () => new Response('tile'));
  const controller = new AbortController();
  controller.abort();
  assert.throws(() => state.loader(url, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(state.requests.length, 0);
});

test('opaque and manual-redirect fetch modes bypass processing to preserve native responses', async (t) => {
  const response = new Response('tile');
  const state = fixture(t, async () => response);
  for (const options of [{ mode: 'no-cors' }, { redirect: 'manual' }]) {
    assert.equal(await state.loader(url, options), response);
    assert.equal(state.requests.at(-1)[1], options);
  }
});

test('buffered tile responses do not retain transport encoding or length headers', async (t) => {
  const state = fixture(t, async () => new Response('decoded pixels', {
    headers: { 'content-encoding': 'gzip', 'content-length': '100', 'content-type': 'image/png' },
  }));
  const response = await state.loader(url);
  assert.equal(response.headers.get('content-encoding'), null);
  assert.equal(response.headers.get('content-length'), null);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(await response.text(), 'decoded pixels');
});
