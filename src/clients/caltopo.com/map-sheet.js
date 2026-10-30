import { PALETTES } from '../common/palettes.js';
import { slideTileURL } from '../www.openstreetmap.org/slide/tiles.js';

const MAX_ZOOM = 15;
const TILE_SIZE = 512;
const TILE_COUNT = 2 ** MAX_ZOOM;
const MAX_TILES = 100;
const MAX_LATITUDE = 85.0511287798066;
const MENU_ID = 'strava-heatmap-map-sheet';

function checkAbort(signal) {
  if (signal.aborted) throw new DOMException('Map sheet cancelled.', 'AbortError');
}

function longitude(x) {
  return x / TILE_COUNT * 360 - 180;
}

function latitude(y) {
  return Math.atan(Math.sinh(Math.PI * (1 - 2 * y / TILE_COUNT))) * 180 / Math.PI;
}

export function mapSheetRegion({ west, south, east, north } = {}) {
  if (![west, south, east, north].every(Number.isFinite) ||
      south >= north || south < -MAX_LATITUDE || north > MAX_LATITUDE ||
      west < -180 || east > 180 || west >= east) {
    throw new Error('Move the view inside the world map, away from the poles and date line.');
  }
  const tileY = (lat) => {
    const radians = lat * Math.PI / 180;
    return (1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2 * TILE_COUNT;
  };
  // Snap round-off at exact tile edges before selecting intersecting tiles.
  const snap = (value) => Math.abs(value - Math.round(value)) < 1e-8
    ? Math.round(value) : value;
  const minX = Math.floor(snap((west + 180) / 360 * TILE_COUNT));
  const maxX = Math.ceil(snap((east + 180) / 360 * TILE_COUNT)) - 1;
  const minY = Math.max(0, Math.floor(snap(tileY(north))));
  const maxY = Math.min(TILE_COUNT - 1, Math.ceil(snap(tileY(south))) - 1);
  const columns = maxX - minX + 1;
  const rows = maxY - minY + 1;
  return {
    minX, maxX, minY, maxY, columns, rows, count: columns * rows,
    width: columns * TILE_SIZE, height: rows * TILE_SIZE,
  };
}

export function mapSheetAlignment(region, id, title) {
  const { minX, minY, width, height } = region;
  return {
    properties: {
      title, url: `/tmpgeo/${encodeURIComponent(id)}`, taskid: id,
      x1: 0, y1: 0, x2: width - 1, y2: height - 1,
      lat1: latitude(minY), lng1: longitude(minX),
      // The opposite reference is the last pixel, not the outer tile edge.
      lat2: latitude(minY + (height - 1) / TILE_SIZE),
      lng2: longitude(minX + (width - 1) / TILE_SIZE),
    },
  };
}

export function colorizeMapSheetPixels(pixels, color) {
  const ramp = PALETTES[color];
  if (!ramp) throw new Error('Choose a supported Strava heatmap color.');
  const palette = Uint8ClampedArray.from(ramp.match(/../g), (hex) => parseInt(hex, 16));
  for (let i = 0; i < pixels.length; i += 4) {
    const offset = pixels[i] * 4;
    pixels[i] = palette[offset];
    pixels[i + 1] = palette[offset + 1];
    pixels[i + 2] = palette[offset + 2];
    pixels[i + 3] = palette[offset + 3];
  }
}

async function request(url, options, signal, timeout, read) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const timer = setTimeout(abort, timeout);
  try {
    checkAbort(controller.signal);
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Request failed (HTTP ${response.status}). Check your sign-in and try again.`);
    }
    const result = await read(response);
    checkAbort(controller.signal);
    return result;
  } catch (error) {
    if (error.name === 'AbortError' && !signal.aborted) {
      throw new Error('Request timed out. Check your connection and try again.');
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}

async function api(url, data, signal) {
  const json = await request(url, {
    credentials: 'same-origin',
    headers: { 'X-Requested-With': 'XMLHttpRequest' },
    ...(data ? { method: 'POST', body: new URLSearchParams({ json: JSON.stringify(data) }) } : {}),
  }, signal, data ? 60000 : 20000, (response) => response.json());
  if (json.status !== 'ok' || !json.result) {
    throw new Error(`CalTopo: ${json.message || json.error || 'The map sheet request was rejected.'}`);
  }
  return json.result;
}

export async function renderMapSheet(region, layer, signal, progress) {
  if (region.count > MAX_TILES || region.count < 1) {
    throw new Error(`Zoom in until the view contains at most ${MAX_TILES} zoom-${MAX_ZOOM} tiles.`);
  }
  const color = new URL(layer.template).searchParams.get('heatmap-color');
  if (!PALETTES[color]) throw new Error('Choose a supported Strava heatmap color.');
  const source = {
    url: ([x, y, z]) => layer.template.replace('{z}', z).replace('{x}', x).replace('{y}', y),
  };
  const canvas = document.createElement('canvas');
  canvas.width = region.width;
  canvas.height = region.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not create the map sheet image.');
  const jobs = [];
  for (let y = region.minY; y <= region.maxY; y++) {
    for (let x = region.minX; x <= region.maxX; x++) jobs.push({ x, y });
  }
  let next = 0;
  let done = 0;
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const worker = async () => {
    while (next < jobs.length) {
      checkAbort(controller.signal);
      const { x, y } = jobs[next++];
      const blob = await request(slideTileURL(source, x, y, MAX_ZOOM), {
        credentials: 'omit',
      }, controller.signal, 20000, (response) => response.blob());
      const image = await createImageBitmap(blob);
      try {
        if (image.width !== TILE_SIZE || image.height !== TILE_SIZE) {
          throw new Error('Strava returned an unexpected heatmap tile size.');
        }
        checkAbort(controller.signal);
        const left = (x - region.minX) * TILE_SIZE;
        const top = (y - region.minY) * TILE_SIZE;
        context.drawImage(image, left, top);
        const pixels = context.getImageData(left, top, TILE_SIZE, TILE_SIZE);
        colorizeMapSheetPixels(pixels.data, color);
        context.putImageData(pixels, left, top);
        progress(`Preparing heatmap tiles (${++done}/${region.count})...`);
      } finally {
        image.close();
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(4, jobs.length) }, worker));
    checkAbort(signal);
    const image = canvas.toDataURL('image/png');
    if (!image.startsWith('data:image/png;base64,')) {
      throw new Error('The browser could not encode this map sheet. Zoom in and try again.');
    }
    return image;
  } finally {
    controller.abort();
    signal.removeEventListener('abort', abort);
  }
}

export async function uploadMapSheet({ region, title, image, accountId, signal, progress,
  pause = () => new Promise((resolve) => setTimeout(resolve, 1000)) }) {
  if (!accountId) throw new Error('Sign into your CalTopo Pro account first.');
  progress('Uploading private map sheet...');
  const upload = await api('/api/v1/rendergeo', {
    url: image, title, shared: false, accountId, mapId: null,
  }, signal);
  if (typeof upload.id !== 'string' || !upload.id) {
    throw new Error('CalTopo did not return a map sheet task ID.');
  }
  const task = encodeURIComponent(upload.id);
  if (upload.manual) {
    progress('Aligning map sheet...');
    const alignment = mapSheetAlignment(region, upload.id, title);
    // This endpoint uses GET, matching CalTopo's native manual alignment form.
    const result = await api(`/rendermanualgeo?${new URLSearchParams({
      json: JSON.stringify(alignment),
    })}`, null, signal);
    if (result.id !== upload.id) throw new Error('CalTopo returned an unexpected alignment task.');
  }
  for (let attempt = 0; attempt < 180; attempt++) {
    checkAbort(signal);
    const result = await api(`/api/v1/geoprogress/${task}`, null, signal);
    if (result.state === 'error') {
      throw new Error(`CalTopo could not render the map sheet: ${result.message || 'Unknown error'}`);
    }
    if (result.state === 'done') {
      if (!result.image?.id) throw new Error('CalTopo finished without returning a map sheet.');
      return result.image;
    }
    if (typeof result.state !== 'string') throw new Error('CalTopo returned invalid rendering progress.');
    progress(`CalTopo: ${result.state}`);
    await pause();
  }
  throw new Error('CalTopo is still rendering. Check your account before trying again.');
}

export function mapSheetBounds(map) {
  const bounds = map?.getBounds?.();
  if (!bounds) throw new Error('Wait for the map to finish loading.');
  const sw = bounds.getSouthWest();
  const ne = bounds.getNorthEast();
  const value = (point, key) => typeof point[key] === 'function' ? point[key]() : point[key];
  return {
    west: value(sw, 'lng'), south: value(sw, 'lat'),
    east: value(ne, 'lng'), north: value(ne, 'lat'),
  };
}

export function mapSheetAvailability({ pro, accountId, layer, bounds, busy }) {
  if (!pro || !accountId) return { enabled: false, pro: false, message: 'Save a private heatmap to your CalTopo account (Pro required).' };
  if (busy) return { enabled: false, pro: true, message: 'A Strava map sheet is being saved...' };
  if (!layer || !new URL(layer.template).pathname.startsWith('/identified/globalheat/')) {
    return { enabled: false, pro: true, message: 'Sign into Strava using the extension and choose a heatmap layer.' };
  }
  try {
    const region = mapSheetRegion(bounds);
    return {
      enabled: region.count <= MAX_TILES, pro: true, region,
      message: region.count <= MAX_TILES
        ? `Save ${region.count} heatmap tiles privately for mobile, downloads, and printing.`
        : `Zoom in to include ${MAX_TILES} or fewer zoom-${MAX_ZOOM} heatmap tiles.`,
    };
  } catch (error) {
    return { enabled: false, pro: true, message: error.message };
  }
}

async function addToMap(image, title, signal) {
  const native = window.org?.sarsoft;
  if (typeof native?.MapObjectDAO?.save !== 'function' ||
      typeof native?.mapViewStore?.addToStack !== 'function') {
    throw new Error('CalTopo map controls are unavailable. Add the saved sheet using Map Sheet > From Account.');
  }
  const feature = {
    type: 'Feature', bbox: image.bbox,
    properties: {
      class: 'MapGeoImage', backendImageId: image.id, title,
      maxZoom: image.properties.maxZoom,
      downloadableSize: image.properties.downloadableSize,
      croppable: image.properties.croppable ?? false,
    },
  };
  await new Promise((resolve, reject) => {
    let timer;
    const finish = (error) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve();
    };
    const abort = () => finish(new DOMException('Adding to map cancelled.', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => finish(new Error('Adding the sheet to this map timed out.')), 20000);
    if (signal.aborted) finish(new DOMException('Adding to map cancelled.', 'AbortError'));
    else {
      try {
        native.MapObjectDAO.save(feature, 'MapGeoImage', () => finish(),
          () => finish(new Error('Could not add the saved sheet to this map. Use Map Sheet > From Account on an editable map.')));
      } catch (error) {
        finish(error);
      }
    }
  });
  checkAbort(signal);
  native.mapViewStore.addToStack(`geoimage_${image.id}`, 1);
}

export function installCalTopoMapSheets(getLayer, getMap) {
  let busy = false;
  let menu;
  let line;
  let title;
  let description;
  const availability = () => {
    const pro = !!window.sarsoft?.features?.pro;
    const accountId = window.sarsoft?.account?.id;
    if (!pro || !accountId) return mapSheetAvailability({ pro, accountId });
    let bounds;
    try {
      bounds = mapSheetBounds(getMap());
    } catch (error) {
      return { enabled: false, pro: true, message: error.message };
    }
    return mapSheetAvailability({
      pro, accountId,
      layer: getLayer(), bounds, busy,
    });
  };
  const refresh = () => {
    if (!menu?.isConnected) return;
    const state = availability();
    const text = `Map Sheet from Strava Heatmap${state.pro ? '' : ' (Pro)'}`;
    if (title.textContent !== text) title.textContent = text;
    if (description.textContent !== state.message) description.textContent = state.message;
    line.classList.toggle('strava-heatmap-map-sheet-disabled', !state.enabled);
    line.setAttribute('aria-disabled', String(!state.enabled));
    line.tabIndex = state.enabled ? 0 : -1;
  };
  const save = async () => {
    const state = availability();
    if (!state.enabled) return;
    busy = true;
    refresh();
    const layer = getLayer();
    const color = new URL(layer.template).searchParams.get('heatmap-color');
    const activity = layer.name.replace(/^\S+\s*/, '');
    const sheetTitle = `Strava Global Heatmap ${activity} ${color} ${new Date().toISOString()}`;
    const accountId = window.sarsoft.account.id;
    const controller = new AbortController();
    const dialog = document.createElement('dialog');
    dialog.className = 'strava-heatmap-map-sheet-dialog';
    const heading = document.createElement('h2');
    heading.textContent = 'Map Sheet from Strava Heatmap';
    const name = document.createElement('p');
    name.textContent = sheetTitle;
    const privacy = document.createElement('p');
    privacy.textContent = 'Share publicly: Off. Heatmap map sheets are saved privately.';
    const status = document.createElement('p');
    status.setAttribute('role', 'status');
    const close = document.createElement('button');
    close.textContent = 'Cancel';
    let uploading = false;
    close.addEventListener('click', () => {
      controller.abort();
      dialog.close();
    });
    dialog.addEventListener('cancel', (event) => {
      if (uploading) event.preventDefault();
      else controller.abort();
    });
    dialog.addEventListener('close', () => dialog.remove());
    dialog.append(heading, name, privacy, status, close);
    document.body.appendChild(dialog);
    dialog.showModal();
    const timer = setTimeout(() => controller.abort(), 5 * 60 * 1000);
    let saved = false;
    try {
      const progress = (message) => { status.textContent = message; };
      const image = await renderMapSheet(state.region, layer, controller.signal, progress);
      uploading = true;
      close.disabled = true;
      const result = await uploadMapSheet({
        region: state.region, title: sheetTitle, image, accountId,
        signal: controller.signal, progress,
      });
      saved = true;
      progress('Saved privately to your CalTopo account. Adding to this map...');
      await addToMap(result, sheetTitle, controller.signal);
      progress('Map sheet saved privately to your CalTopo account and added to this map.');
    } catch (error) {
      if (!uploading && controller.signal.aborted && !dialog.open) return;
      console.warn('[StravaHeatmapExt] Could not finish saving CalTopo map sheet.', error);
      status.setAttribute('role', 'alert');
      status.textContent = saved
        ? `Saved privately to your CalTopo account, but not added to this map. ${error.message}`
        : `${controller.signal.aborted ? 'Saving timed out.' : error.message}${uploading
          ? ' CalTopo may have saved the sheet; check your account before retrying.' : ''}`;
    } finally {
      clearTimeout(timer);
      busy = false;
      uploading = false;
      close.disabled = false;
      close.textContent = 'Close';
      refresh();
    }
  };
  const discover = () => {
    if (document.getElementById(MENU_ID)) return;
    const icon = document.querySelector('.menuPanel img[src$="/layer-mapsheets.svg"]');
    const item = icon?.closest('.line')?.parentElement;
    if (!item) return;
    menu = document.createElement('div');
    menu.id = MENU_ID;
    line = document.createElement('div');
    line.className = 'line';
    line.setAttribute('role', 'button');
    const first = document.createElement('div');
    first.className = 'line1';
    const image = icon.cloneNode();
    image.alt = '';
    title = document.createElement('div');
    description = document.createElement('div');
    description.className = 'line2';
    first.append(image, title);
    line.append(first, description);
    menu.appendChild(line);
    line.addEventListener('click', () => { void save(); });
    line.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      void save();
    });
    item.after(menu);
    refresh();
  };
  discover();
  const observer = new MutationObserver(discover);
  observer.observe(document.body, { childList: true, subtree: true });
  // Bounds and sign-in state can change independently of the Add menu DOM.
  window.setInterval(refresh, 500);
  return { refresh };
}
