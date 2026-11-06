const RETRY_STATUSES = new Set([429, 502, 503, 504]);

export function isWeeklyTile(url) {
  return typeof url === 'string' &&
    /^https:\/\/content-[a-c]\.strava\.com\/weeklyheat\/\d+\/\d+\/\d+(?:\?|$)/.test(url);
}

function wait(delay, signal) {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, delay);
    signal.addEventListener('abort', abort, { once: true });
  });
}

function retryDelay(response, attempt) {
  const value = response?.headers.get('retry-after');
  const seconds = value === null || value === undefined ? NaN : Number(value);
  const retryAfter = Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(value) - Date.now();
  return Math.max(
    1000 * 2 ** attempt * (0.75 + Math.random() * 0.5),
    Number.isFinite(retryAfter) ? retryAfter : 0
  );
}

export function createWeeklyTileLoader(nativeFetch) {
  const pending = new Map();

  async function load(request, signal) {
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      let response;
      try {
        response = await nativeFetch(request, {
          signal,
          ...(attempt ? { cache: 'reload' } : {}),
        });
        signal.throwIfAborted();
        if (!RETRY_STATUSES.has(response.status) || attempt === 3) {
          const body = response.status === 204 || response.status === 205
            ? null : await response.blob();
          if (!response.ok) {
            console.warn(`[StravaHeatmapExt] Weekly tile failed with status ${response.status}.`);
            if (response.status === 401 || response.status === 403) {
              window.postMessage({
                type: 'stravaHeatmapTileError', status: response.status,
              }, window.location.origin);
            }
          }
          const headers = new Headers(response.headers);
          headers.delete('content-encoding');
          headers.delete('content-length');
          return {
            body, status: response.status, statusText: response.statusText, headers,
          };
        }
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        if (!(error instanceof TypeError) || attempt === 3) {
          console.warn('[StravaHeatmapExt] Weekly tile request failed.', error);
          throw error;
        }
      }
      const delay = retryDelay(response, attempt);
      await response?.body?.cancel();
      await wait(delay, signal);
    }
  }

  return function fetchTile(input, options) {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input?.url;
    if (!isWeeklyTile(url)) return nativeFetch(input, options);
    const request = new Request(input, options);
    if (request.method !== 'GET' || request.mode === 'no-cors' || request.redirect === 'manual') {
      return nativeFetch(input, options);
    }
    request.signal.throwIfAborted();
    // Fragments affect recoloring, not the underlying tile request.
    const key = JSON.stringify([
      request.url.split('#')[0], [...request.headers], request.credentials,
      request.cache, request.mode, request.redirect, request.referrer,
      request.referrerPolicy, request.integrity, request.keepalive,
    ]);
    let entry = pending.get(key);
    if (!entry) {
      const controller = new AbortController();
      entry = { controller, consumers: 0 };
      entry.promise = load(request, controller.signal).finally(() => {
        if (pending.get(key) === entry) pending.delete(key);
      });
      pending.set(key, entry);
    }
    entry.consumers++;
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = () => {
        if (finished) return false;
        finished = true;
        request.signal.removeEventListener('abort', abort);
        if (--entry.consumers === 0) {
          entry.controller.abort();
          if (pending.get(key) === entry) pending.delete(key);
        }
        return true;
      };
      const abort = () => {
        if (finish()) reject(request.signal.reason);
      };
      request.signal.addEventListener('abort', abort, { once: true });
      entry.promise.then(
        ({ body, ...init }) => {
          if (finish()) resolve(new Response(body, init));
        },
        (error) => { if (finish()) reject(error); }
      );
    });
  };
}
