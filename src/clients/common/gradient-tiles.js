import { PALETTES } from './palettes.js';
import { createWeeklyTileLoader, isWeeklyTile } from './weekly-tiles.js';

const PALETTE_RAMPS = Object.fromEntries(
  Object.entries(PALETTES).map(([name, ramp]) => [
    name,
    ramp.match(/.{8}/g).map(hexToRgba),
  ])
);

const GRADIENT_HASH_PATTERN =
  /(?:^|&)strava-gradient=([0-9a-f]{6}(?:[0-9a-f]{2})?(?:-[0-9a-f]{6}(?:[0-9a-f]{2})?)+)(?:&|$)/i;

function getGradient(url) {
  if (typeof url !== 'string') return null;

  const hashIndex = url.indexOf('#');
  if (hashIndex === -1) return null;

  const match = url.slice(hashIndex + 1).match(GRADIENT_HASH_PATTERN);
  if (!match) return null;

  return match[1].split('-').map(hexToRgba);
}

function hexToRgba(hex) {
  const rgba = [0, 2, 4].map((offset) =>
    Number.parseInt(hex.slice(offset, offset + 2), 16)
  );
  rgba.push(hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) : 255);
  return rgba;
}

function getColorRamp(url, recolorPalettes) {
  const gradient = getGradient(url);
  if (gradient) return { stops: gradient, palette: false };
  if (typeof url !== 'string') return null;

  // Fallback images use the canvas path even on clients with CSS palettes.
  const fallback = /^https:\/\/raw\.githubusercontent\.com\/tjasz\/strava-heatmap-extension\/refs\/(?:tags|heads)\/v[^/]+\/assets\/heatmap-fallback-grayscale\.png(?:[?#]|$)/.test(url);
  if (
    !fallback && (
      !recolorPalettes ||
      !/^https:\/\/content-[a-c]\.strava\.com\/(?:identified\/globalheat|weeklyheat)\//.test(url)
    )
  ) return null;

  const color = new URL(url).searchParams.get('heatmap-color');
  return Object.hasOwn(PALETTE_RAMPS, color)
    ? { stops: PALETTE_RAMPS[color], palette: true }
    : null;
}

async function recolorBlob(blob, { stops: gradient, palette }) {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Could not create a canvas context.');

    context.drawImage(bitmap, 0, 0);
    const imageData = context.getImageData(0, 0, bitmap.width, bitmap.height);
    const { data } = imageData;

    for (let offset = 0; offset < data.length; offset += 4) {
      // Named palettes match the SVG filters: red indexes both color and alpha.
      const intensity = palette
        ? data[offset] / 255
        : (data[offset] + data[offset + 1] + data[offset + 2]) / (3 * 255);
      const scaledIntensity = intensity * (gradient.length - 1);
      const stopIndex = Math.min(
        Math.floor(scaledIntensity),
        gradient.length - 2
      );
      const segmentIntensity = scaledIntensity - stopIndex;
      const start = gradient[stopIndex];
      const end = gradient[stopIndex + 1];
      data[offset] = interpolate(start[0], end[0], segmentIntensity);
      data[offset + 1] = interpolate(start[1], end[1], segmentIntensity);
      data[offset + 2] = interpolate(start[2], end[2], segmentIntensity);
      data[offset + 3] = Math.round(
        (palette ? 1 : data[offset + 3] / 255) *
          interpolate(start[3], end[3], segmentIntensity)
      );
    }

    context.putImageData(imageData, 0, 0);
    return await new Promise((resolve, reject) => {
      canvas.toBlob(
        (result) =>
          result ? resolve(result) : reject(new Error('Could not encode tile PNG.')),
        'image/png'
      );
    });
  } finally {
    bitmap.close();
  }
}

function interpolate(start, end, intensity) {
  return Math.round(start + (end - start) * intensity);
}

function installFetchInterceptor(nativeFetch, getColors) {
  window.fetch = async function (...args) {
    const input = args[0];
    const url =
      typeof input === 'string' || input instanceof URL ? String(input) : input?.url;
    const gradient = getColors(url);
    if (!gradient) return nativeFetch(...args);

    const response = await nativeFetch(...args);
    if (!response.ok) return response;

    const recolored = await recolorBlob(await response.blob(), gradient);
    const headers = new Headers(response.headers);
    headers.delete('content-encoding');
    headers.delete('content-length');
    headers.set('content-type', 'image/png');

    return new Response(recolored, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}

function installImageInterceptor(nativeFetch, getColors) {
  const imageStates = new WeakMap();
  const sourceDescriptor = Object.getOwnPropertyDescriptor(
    HTMLImageElement.prototype,
    'src'
  );
  const transparentTile =
    'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';

  function cancelPendingImage(image, source) {
    const state = imageStates.get(image);
    if (!state || (state.outputSource !== undefined && state.outputSource === source)) return;

    state.controller.abort();
    state.cleanupOutput?.();
    if (state.outputSource?.startsWith('blob:')) URL.revokeObjectURL(state.outputSource);
    image.style.visibility = state.visibility;
    imageStates.delete(image);
  }

  async function processImage(image, source) {
    if (source === null && imageStates.has(image)) return;

    const weekly = isWeeklyTile(source);
    const gradient = weekly ? getColorRamp(source, true) : getColors(source);
    if (!gradient && !weekly) {
      cancelPendingImage(image, source);
      return;
    }
    const previousState = imageStates.get(image);
    if (previousState?.source === source) return;
    cancelPendingImage(image, source);

    const state = {
      source,
      visibility: previousState?.visibility ?? image.style.visibility,
      outputSource: undefined,
      failed: false,
      controller: new AbortController(),
    };
    imageStates.set(image, state);
    image.style.visibility = 'hidden';

    try {
      const response = await nativeFetch(source, { signal: state.controller.signal });
      if (!response.ok) {
        throw new Error(`Tile request failed with status ${response.status}.`);
      }
      const blob = await response.blob();
      const recolored = gradient ? await recolorBlob(blob, gradient) : blob;
      if (imageStates.get(image) !== state) return;

      const objectUrl = URL.createObjectURL(recolored);
      state.outputSource = objectUrl;
      const onLoad = () => {
        state.cleanupOutput();
        if (imageStates.get(image) === state) {
          image.style.visibility = state.visibility;
          imageStates.delete(image);
        }
      };
      const onError = () => {
        state.cleanupOutput();
        if (imageStates.get(image) !== state) return;
        state.failed = true;
        state.outputSource = transparentTile;
        sourceDescriptor.set.call(image, transparentTile);
        console.warn('[StravaHeatmapExt] Could not decode weekly heatmap tile.');
      };
      state.cleanupOutput = () => {
        image.removeEventListener('load', onLoad);
        if (weekly) image.removeEventListener('error', onError);
        URL.revokeObjectURL(objectUrl);
        state.outputSource = undefined;
        state.cleanupOutput = undefined;
      };
      image.addEventListener('load', onLoad, { once: true });
      if (weekly) image.addEventListener('error', onError, { once: true });
      sourceDescriptor.set.call(image, objectUrl);
    } catch (error) {
      if (state.controller.signal.aborted) return;
      if (imageStates.get(image) === state) {
        state.failed = true;
        if (weekly) {
          state.outputSource = transparentTile;
          sourceDescriptor.set.call(image, transparentTile);
        } else {
          image.style.visibility = state.visibility;
          sourceDescriptor.set.call(image, source);
        }
      }
      console.error('[StravaHeatmapExt] Failed to load heatmap tile.', error);
    }
  }

  Object.defineProperty(HTMLImageElement.prototype, 'src', {
    ...sourceDescriptor,
    set(value) {
      const source = String(value);
      if (getColors(source) || isWeeklyTile(source)) {
        const state = imageStates.get(this);
        if (state?.source === source && state.failed && !isWeeklyTile(source)) {
          sourceDescriptor.set.call(this, value);
          return;
        }
        processImage(this, source);
      } else {
        cancelPendingImage(this, source);
        sourceDescriptor.set.call(this, value);
      }
    },
  });

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'attributes') {
        if (record.target instanceof HTMLImageElement) {
          const source = record.target.getAttribute('src');
          const state = imageStates.get(record.target);
          if (source === null) {
            cancelPendingImage(record.target);
          } else if (state?.source !== source || !state.failed) {
            processImage(record.target, source);
          }
        }
        continue;
      }
      for (const node of record.removedNodes ?? []) {
        if (!(node instanceof Element) || node.isConnected) continue;
        if (node instanceof HTMLImageElement) cancelPendingImage(node);
        node.querySelectorAll('img').forEach((image) => cancelPendingImage(image));
      }
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        if (node instanceof HTMLImageElement) {
          processImage(node, node.getAttribute('src'));
        }
        node
          .querySelectorAll('img')
          .forEach((image) => processImage(image, image.getAttribute('src')));
      }
    }
  });

  observer.observe(document.documentElement, {
    attributeFilter: ['src'],
    attributes: true,
    childList: true,
    subtree: true,
  });
  document
    .querySelectorAll('img')
    .forEach((image) => processImage(image, image.getAttribute('src')));
}

export function installGradientTileRecoloring({ recolorPalettes = false } = {}) {
  if (window.__stravaGradientTileRecoloringInstalled) return;
  window.__stravaGradientTileRecoloringInstalled = true;

  const nativeFetch = window.fetch.bind(window);
  const fetchTile = createWeeklyTileLoader(nativeFetch);
  const getColors = (url) => getColorRamp(url, recolorPalettes);
  installFetchInterceptor(fetchTile, getColors);
  installImageInterceptor(fetchTile, getColors);
}
