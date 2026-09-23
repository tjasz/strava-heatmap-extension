const GRADIENT_HASH_PATTERN =
  /(?:^|&)strava-gradient=([0-9a-f]{6})-([0-9a-f]{6})(?:&|$)/i;

function getGradient(url) {
  if (typeof url !== 'string') return null;

  const hashIndex = url.indexOf('#');
  if (hashIndex === -1) return null;

  const match = url.slice(hashIndex + 1).match(GRADIENT_HASH_PATTERN);
  if (!match) return null;

  return {
    start: hexToRgb(match[1]),
    end: hexToRgb(match[2]),
  };
}

function hexToRgb(hex) {
  return [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
}

async function recolorBlob(blob, gradient) {
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
      const intensity =
        (data[offset] + data[offset + 1] + data[offset + 2]) / (3 * 255);
      data[offset] = interpolate(gradient.start[0], gradient.end[0], intensity);
      data[offset + 1] = interpolate(
        gradient.start[1],
        gradient.end[1],
        intensity
      );
      data[offset + 2] = interpolate(
        gradient.start[2],
        gradient.end[2],
        intensity
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

function installFetchInterceptor(nativeFetch) {
  window.fetch = async function (...args) {
    const input = args[0];
    const url =
      typeof input === 'string' || input instanceof URL ? String(input) : input?.url;
    const gradient = getGradient(url);
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

function installImageInterceptor(nativeFetch) {
  const imageStates = new WeakMap();
  const sourceDescriptor = Object.getOwnPropertyDescriptor(
    HTMLImageElement.prototype,
    'src'
  );

  function cancelPendingImage(image, source) {
    const state = imageStates.get(image);
    if (!state || state.outputSource === source) return;

    image.style.visibility = state.visibility;
    imageStates.delete(image);
  }

  async function processImage(image, source) {
    if (source === null && imageStates.has(image)) return;

    const gradient = getGradient(source);
    if (!gradient) {
      cancelPendingImage(image, source);
      return;
    }
    const previousState = imageStates.get(image);
    if (previousState?.source === source) return;

    const state = {
      source,
      visibility: previousState?.visibility ?? image.style.visibility,
      outputSource: undefined,
      failed: false,
    };
    imageStates.set(image, state);
    image.style.visibility = 'hidden';

    try {
      const response = await nativeFetch(source);
      if (!response.ok) {
        throw new Error(`Tile request failed with status ${response.status}.`);
      }
      const recolored = await recolorBlob(await response.blob(), gradient);
      if (imageStates.get(image) !== state) return;

      const objectUrl = URL.createObjectURL(recolored);
      state.outputSource = objectUrl;
      image.addEventListener(
        'load',
        () => {
          URL.revokeObjectURL(objectUrl);
          if (imageStates.get(image) === state) {
            image.style.visibility = state.visibility;
            imageStates.delete(image);
          }
        },
        { once: true }
      );
      sourceDescriptor.set.call(image, objectUrl);
    } catch (error) {
      if (imageStates.get(image) === state) {
        image.style.visibility = state.visibility;
        state.failed = true;
        sourceDescriptor.set.call(image, source);
      }
      console.error('[StravaHeatmapExt] Failed to recolor grayscale tile.', error);
    }
  }

  Object.defineProperty(HTMLImageElement.prototype, 'src', {
    ...sourceDescriptor,
    set(value) {
      const source = String(value);
      if (getGradient(source)) {
        const state = imageStates.get(this);
        if (state?.source === source && state.failed) {
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
          if (state?.source !== source || !state.failed) {
            processImage(record.target, source);
          }
        }
        continue;
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

export function installGradientTileRecoloring() {
  if (window.__stravaGradientTileRecoloringInstalled) return;
  window.__stravaGradientTileRecoloringInstalled = true;

  const nativeFetch = window.fetch.bind(window);
  installFetchInterceptor(nativeFetch);
  installImageInterceptor(nativeFetch);
}
