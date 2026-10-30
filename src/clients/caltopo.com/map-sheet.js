import { PALETTES } from '../common/palettes.js';
import { slideTileURL } from '../www.openstreetmap.org/slide/tiles.js';

const MAX_ZOOM = 15;
const TILE_SIZE = 512;
const TILE_COUNT = 2 ** MAX_ZOOM;
const MAX_TILES = 100;
const INITIAL_TILE_SIDE = 5;
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

function tileY(lat) {
  const radians = lat * Math.PI / 180;
  return (1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2 * TILE_COUNT;
}

function snapTileEdge(value) {
  return Math.abs(value - Math.round(value)) < 1e-8 ? Math.round(value) : value;
}

function regionFromTiles(minX, maxX, minY, maxY) {
  const columns = maxX - minX + 1;
  const rows = maxY - minY + 1;
  return {
    minX, maxX, minY, maxY, columns, rows, count: columns * rows,
    width: columns * TILE_SIZE, height: rows * TILE_SIZE,
  };
}

export function mapSheetRegion({ west, south, east, north } = {}) {
  if (![west, south, east, north].every(Number.isFinite) ||
      south >= north || south < -MAX_LATITUDE || north > MAX_LATITUDE ||
      west < -180 || east > 180 || west >= east) {
    throw new Error('Move the view inside the world map, away from the poles and date line.');
  }
  // Snap round-off at exact tile edges before selecting intersecting tiles.
  const minX = Math.floor(snapTileEdge((west + 180) / 360 * TILE_COUNT));
  const maxX = Math.ceil(snapTileEdge((east + 180) / 360 * TILE_COUNT)) - 1;
  const minY = Math.max(0, Math.floor(snapTileEdge(tileY(north))));
  const maxY = Math.min(TILE_COUNT - 1, Math.ceil(snapTileEdge(tileY(south))) - 1);
  return regionFromTiles(minX, maxX, minY, maxY);
}

function tilePoint([lng, lat]) {
  if (!Number.isFinite(lng) || !Number.isFinite(lat) || lng < -180 || lng > 180 ||
      Math.abs(lat) > MAX_LATITUDE) {
    throw new Error('Select an area inside the world map, away from the poles and date line.');
  }
  return [(lng + 180) / 360 * TILE_COUNT, tileY(lat)].map(snapTileEdge);
}

export function limitMapSheetSelection(anchor, corner) {
  const start = tilePoint(anchor);
  const end = tilePoint(corner);
  const at = (fraction) => {
    const point = start.map((value, i) => value + (end[i] - value) * fraction);
    const clamp = (value) => Math.max(0, Math.min(TILE_COUNT - 1, value));
    const min = start.map((value, i) => clamp(Math.floor(snapTileEdge(Math.min(value, point[i])))));
    const max = start.map((value, i) => Math.max(min[i],
      clamp(Math.ceil(snapTileEdge(Math.max(value, point[i]))) - 1)));
    return regionFromTiles(min[0], max[0], min[1], max[1]);
  };
  const requested = at(1);
  if (requested.count <= MAX_TILES) return { region: requested, limited: false };
  // Keep the drag's direction and aspect ratio, stopping at the last legal tile edge.
  let low = 0;
  let high = 1;
  for (let i = 0; i < 48; i++) {
    const middle = (low + high) / 2;
    if (at(middle).count <= MAX_TILES) low = middle;
    else high = middle;
  }
  return { region: at(low), limited: true };
}

export function resizeMapSheetSelection(region, handle, point) {
  const [x, y] = tilePoint(point);
  let left = region.minX;
  let right = region.maxX + 1;
  let top = region.minY;
  let bottom = region.maxY + 1;
  if (handle.includes('w')) left = Math.max(0, Math.min(right - 1, Math.floor(x)));
  if (handle.includes('e')) right = Math.min(TILE_COUNT, Math.max(left + 1, Math.ceil(x)));
  if (handle.includes('n')) top = Math.max(0, Math.min(bottom - 1, Math.floor(y)));
  if (handle.includes('s')) bottom = Math.min(TILE_COUNT, Math.max(top + 1, Math.ceil(y)));
  const requested = regionFromTiles(left, right - 1, top, bottom - 1);
  if (requested.count <= MAX_TILES) return { region: requested, limited: false };
  if (handle.length === 2) {
    return limitMapSheetSelection(
      [longitude(handle.includes('w') ? right : left), latitude(handle.includes('n') ? bottom : top)],
      [longitude(handle.includes('w') ? left : right), latitude(handle.includes('n') ? top : bottom)],
    );
  }
  const columns = Math.floor(MAX_TILES / region.rows);
  const rows = Math.floor(MAX_TILES / region.columns);
  if (handle === 'w') left = right - columns;
  if (handle === 'e') right = left + columns;
  if (handle === 'n') top = bottom - rows;
  if (handle === 's') bottom = top + rows;
  return { region: regionFromTiles(left, right - 1, top, bottom - 1), limited: true };
}

export function selectMapSheetRegion(map, signal, suggestedTitle) {
  const container = map?.getContainer?.() || map?.getDiv?.();
  const leaflet = typeof map?.containerPointToLatLng === 'function';
  const wrapper = window.map;
  if (!container || (!leaflet && (
    typeof wrapper?.fromContainerPixel !== 'function' ||
    typeof wrapper?.toContainerPixel !== 'function'
  ))) {
    return Promise.reject(new Error('CalTopo area selection is unavailable. Reload the map and try again.'));
  }
  const fromPixel = (x, y) => {
    if (!leaflet) {
      if (typeof map.getProjection === 'function' && !map.getProjection()) {
        throw new Error('Wait for the map to finish loading before adjusting the area.');
      }
      return wrapper.fromContainerPixel([x, y]);
    }
    const point = map.containerPointToLatLng([x, y]);
    return [point.lng, point.lat];
  };
  const toPixel = (x, y) => {
    if (!leaflet) return wrapper.toContainerPixel([longitude(x), latitude(y)]);
    const point = map.latLngToContainerPoint([latitude(y), longitude(x)]);
    return [point.x, point.y];
  };
  return new Promise((resolve, reject) => {
    const overlay = document.createElement('div');
    overlay.className = 'strava-heatmap-map-sheet-selection';
    const box = document.createElement('div');
    box.className = 'strava-heatmap-map-sheet-box';
    box.hidden = true;
    const panel = document.createElement('section');
    panel.className = 'strava-heatmap-map-sheet-selection-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Select heatmap area');
    const heading = document.createElement('h2');
    heading.textContent = 'Map Sheet from Strava Heatmap';
    const instructions = document.createElement('p');
    instructions.textContent = `Drag the edge or corner handles to adjust the capture area (up to ${MAX_TILES} zoom-${MAX_ZOOM} tiles).`;
    const nameLabel = document.createElement('label');
    nameLabel.className = 'strava-heatmap-map-sheet-name';
    nameLabel.textContent = 'Sheet name';
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.required = true;
    nameInput.value = suggestedTitle;
    nameInput.addEventListener('input', () => nameInput.setCustomValidity(''));
    nameLabel.appendChild(nameInput);
    const status = document.createElement('p');
    status.setAttribute('role', 'status');
    const confirm = document.createElement('button');
    confirm.className = 'strava-heatmap-map-sheet-button strava-heatmap-map-sheet-primary';
    confirm.type = 'button';
    confirm.textContent = 'Capture';
    confirm.setAttribute('aria-label', 'Capture selected area');
    confirm.disabled = true;
    const cancel = document.createElement('button');
    cancel.className = 'strava-heatmap-map-sheet-button';
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    const actions = document.createElement('div');
    actions.className = 'strava-heatmap-map-sheet-actions';
    actions.append(cancel, confirm);
    panel.append(heading, instructions, nameLabel, status, actions);
    overlay.append(box, panel);
    let drag;
    let region;
    let listener;
    let finished = false;
    const showSelection = (limited = false) => {
      status.setAttribute('role', 'status');
      status.textContent = `${region.count}/${MAX_TILES} tiles selected.${limited
        ? ' Limit reached; the box cannot grow further.' : ''}`;
      confirm.disabled = !!drag;
    };
    const draw = () => {
      if (finished) return;
      try {
        if (!region) {
          const rect = container.getBoundingClientRect();
          if (!rect.width || !rect.height) throw new Error('Wait for the map to finish loading.');
          const center = tilePoint(fromPixel(rect.width / 2, rect.height / 2));
          const [x, y] = center.map((value) => Math.max(0,
            Math.min(TILE_COUNT - INITIAL_TILE_SIDE, Math.floor(value) - Math.floor(INITIAL_TILE_SIDE / 2))));
          region = regionFromTiles(x, x + INITIAL_TILE_SIDE - 1, y, y + INITIAL_TILE_SIDE - 1);
          showSelection();
        }
        const a = toPixel(region.minX, region.minY);
        const b = toPixel(region.maxX + 1, region.maxY + 1);
        box.hidden = false;
        box.style.left = `${Math.min(a[0], b[0])}px`;
        box.style.top = `${Math.min(a[1], b[1])}px`;
        box.style.width = `${Math.abs(b[0] - a[0])}px`;
        box.style.height = `${Math.abs(b[1] - a[1])}px`;
        if (!drag && status.getAttribute('role') === 'alert') showSelection();
      } catch (error) {
        status.setAttribute('role', 'alert');
        status.textContent = error.message;
        confirm.disabled = true;
      }
    };
    const releasePointer = () => {
      const active = drag;
      drag = undefined;
      if (active?.element.hasPointerCapture(active.pointer)) active.element.releasePointerCapture(active.pointer);
    };
    const finish = (result, error) => {
      if (finished) return;
      finished = true;
      releasePointer();
      signal.removeEventListener('abort', abort);
      document.removeEventListener('keydown', keydown, true);
      if (leaflet) map.off('move zoom resize', draw);
      else listener?.remove();
      overlay.remove();
      if (error) reject(error);
      else resolve(result);
    };
    const abort = () => finish(null, new DOMException('Area selection cancelled.', 'AbortError'));
    const keydown = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      finish(null);
    };
    const update = (event) => {
      try {
        const rect = container.getBoundingClientRect();
        const corner = fromPixel(
          Math.max(0, Math.min(rect.width, event.clientX - rect.left)),
          Math.max(0, Math.min(rect.height, event.clientY - rect.top)),
        );
        const selection = resizeMapSheetSelection(drag.region, drag.handle, corner);
        region = selection.region;
        showSelection(selection.limited);
        draw();
      } catch (error) {
        status.setAttribute('role', 'alert');
        status.textContent = error.message;
        confirm.disabled = true;
      }
    };
    for (const [direction, label, x, y] of [
      ['nw', 'northwest corner', 0, 0], ['n', 'north edge', 50, 0], ['ne', 'northeast corner', 100, 0],
      ['e', 'east edge', 100, 50], ['se', 'southeast corner', 100, 100],
      ['s', 'south edge', 50, 100], ['sw', 'southwest corner', 0, 100], ['w', 'west edge', 0, 50],
    ]) {
      const handle = document.createElement('button');
      handle.type = 'button';
      handle.className = `strava-heatmap-map-sheet-handle strava-heatmap-map-sheet-handle-${direction}`;
      handle.setAttribute('aria-label', `Resize ${label}`);
      handle.style.left = `${x}%`;
      handle.style.top = `${y}%`;
      handle.addEventListener('pointerdown', (event) => {
        if (drag || !region || event.button !== 0 || !event.isPrimary) return;
        event.preventDefault();
        event.stopPropagation();
        handle.setPointerCapture(event.pointerId);
        drag = { element: handle, pointer: event.pointerId, handle: direction, region };
        confirm.disabled = true;
      });
      handle.addEventListener('pointermove', (event) => {
        if (!drag || event.pointerId !== drag.pointer || drag.element !== handle) return;
        event.stopPropagation();
        update(event);
      });
      handle.addEventListener('pointerup', (event) => {
        if (!drag || event.pointerId !== drag.pointer || drag.element !== handle) return;
        event.stopPropagation();
        update(event);
        releasePointer();
        confirm.disabled = status.getAttribute('role') === 'alert';
      });
      const cancelDrag = () => {
        if (drag?.element !== handle) return;
        region = drag.region;
        releasePointer();
        showSelection();
        draw();
      };
      handle.addEventListener('pointercancel', cancelDrag);
      handle.addEventListener('lostpointercapture', cancelDrag);
      handle.addEventListener('keydown', (event) => {
        const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
        if (!delta || !region || drag) return;
        event.preventDefault();
        event.stopPropagation();
        const edgeX = direction.includes('w') ? region.minX : region.maxX + 1;
        const edgeY = direction.includes('n') ? region.minY : region.maxY + 1;
        const selection = resizeMapSheetSelection(region, direction,
          [longitude(Math.max(0, Math.min(TILE_COUNT, edgeX + delta[0]))),
            latitude(Math.max(0, Math.min(TILE_COUNT, edgeY + delta[1])))]);
        region = selection.region;
        showSelection(selection.limited);
        draw();
      });
      for (const name of ['click', 'dblclick', 'mousedown', 'mouseup', 'contextmenu', 'touchstart', 'touchmove', 'touchend']) {
        handle.addEventListener(name, (event) => event.stopPropagation());
      }
      box.appendChild(handle);
    }
    for (const name of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'keydown']) {
      panel.addEventListener(name, (event) => event.stopPropagation());
    }
    confirm.addEventListener('click', () => {
      if (confirm.disabled) return;
      const title = nameInput.value.trim();
      nameInput.setCustomValidity(title ? '' : 'Enter a sheet name.');
      if (!nameInput.reportValidity()) return;
      finish({ region, title });
    });
    cancel.addEventListener('click', () => finish(null));
    panel.addEventListener('wheel', (event) => event.stopPropagation());
    try {
      checkAbort(signal);
      if (leaflet) {
        map.on('move zoom resize', draw);
      } else {
        listener = map.addListener('bounds_changed', draw);
      }
      signal.addEventListener('abort', abort, { once: true });
      document.addEventListener('keydown', keydown, true);
      container.appendChild(overlay);
      draw();
      nameInput.focus();
      nameInput.select();
    } catch (error) {
      finish(null, error);
    }
  });
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
    throw new Error(`Select an area containing at most ${MAX_TILES} zoom-${MAX_ZOOM} tiles.`);
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
      throw new Error('The browser could not encode this map sheet. Select a smaller area and try again.');
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

export function mapSheetAvailability({ pro, accountId, layer, busy }) {
  if (!pro || !accountId) return { enabled: false, pro: false, message: 'Save a private heatmap to your CalTopo account.' };
  if (busy) return { enabled: false, pro: true, message: 'A Strava map sheet is being saved...' };
  if (!layer || !new URL(layer.template).pathname.startsWith('/identified/globalheat/')) {
    return { enabled: false, pro: true, message: 'Sign into Strava using the extension and choose a heatmap layer.' };
  }
  return {
    enabled: true, pro: true,
    message: `Adjust an area of up to ${MAX_TILES} zoom-${MAX_ZOOM} heatmap tiles to save privately.`,
  };
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

function reserveMapSheetCreation() {
  const cards = window.org?.sarsoft?.MapState?.controllers?.MapGeoImage?.cardsUiStore;
  const selected = cards?.selectedStore;
  if (typeof selected?.hasInProgressNewObject !== 'boolean' ||
      typeof cards?.showNewCard !== 'function') {
    throw new Error('CalTopo item creation controls are unavailable. Reload the map and try again.');
  }
  if (selected.hasInProgressNewObject) {
    cards.showNewCard({ type: 'Feature', properties: { class: 'MapGeoImage' } });
    return null;
  }
  const original = Object.getOwnPropertyDescriptor(selected, 'hasInProgressNewObject');
  if (original && !original.configurable) {
    throw new Error('CalTopo item creation controls are unavailable. Reload the map and try again.');
  }
  // Native new-item cards consult this getter before opening.
  Object.defineProperty(selected, 'hasInProgressNewObject', { configurable: true, get: () => true });
  return () => {
    if (original) Object.defineProperty(selected, 'hasInProgressNewObject', original);
    else delete selected.hasInProgressNewObject;
  };
}

export function installCalTopoMapSheets(getLayer, getMap) {
  let busy = false;
  let menu;
  let line;
  let titleText;
  let proBadge;
  let description;
  const availability = () => {
    const pro = !!window.sarsoft?.features?.pro;
    const accountId = window.sarsoft?.account?.id;
    if (!pro || !accountId) return mapSheetAvailability({ pro, accountId });
    if (!getMap()) return { enabled: false, pro: true, message: 'Wait for the map to finish loading.' };
    return mapSheetAvailability({
      pro, accountId,
      layer: getLayer(), busy,
    });
  };
  const refresh = () => {
    if (!menu?.isConnected) return;
    const state = availability();
    titleText.classList.toggle('disabled', !state.pro);
    proBadge.hidden = state.pro;
    proBadge.style.display = state.pro ? 'none' : '';
    proBadge.tabIndex = state.pro ? -1 : 0;
    if (description.textContent !== state.message) description.textContent = state.message;
    line.classList.toggle('strava-heatmap-map-sheet-disabled', !state.enabled);
    line.setAttribute('role', state.pro ? 'button' : 'group');
    if (state.pro) line.setAttribute('aria-disabled', String(!state.enabled));
    else line.removeAttribute('aria-disabled');
    line.tabIndex = state.enabled ? 0 : -1;
  };
  const save = async () => {
    const state = availability();
    if (!state.enabled) return;
    busy = true;
    refresh();
    document.querySelector('.expandedMenu img[src$="/menu-close.svg"]')?.click();
    const layer = getLayer();
    const color = new URL(layer.template).searchParams.get('heatmap-color');
    const activity = layer.name.replace(/^\S+\s*/, '');
    const suggestedTitle = `Strava Global Heatmap ${activity} ${color} ${new Date().toISOString()}`;
    const accountId = window.sarsoft.account.id;
    const controller = new AbortController();
    const dialog = document.createElement('dialog');
    dialog.className = 'strava-heatmap-map-sheet-dialog';
    const heading = document.createElement('h2');
    heading.textContent = 'Map Sheet from Strava Heatmap';
    const name = document.createElement('p');
    name.textContent = suggestedTitle;
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
    let timer;
    let releaseCreation;
    let saved = false;
    try {
      releaseCreation = reserveMapSheetCreation();
      if (!releaseCreation) return;
      const progress = (message) => { status.textContent = message; };
      const selection = await selectMapSheetRegion(getMap(), controller.signal, suggestedTitle);
      if (!selection) return;
      const { region, title: sheetTitle } = selection;
      name.textContent = sheetTitle;
      document.body.appendChild(dialog);
      dialog.showModal();
      timer = setTimeout(() => controller.abort(), 5 * 60 * 1000);
      const image = await renderMapSheet(region, layer, controller.signal, progress);
      uploading = true;
      close.disabled = true;
      const result = await uploadMapSheet({
        region, title: sheetTitle, image, accountId,
        signal: controller.signal, progress,
      });
      saved = true;
      progress('Saved privately to your CalTopo account. Adding to this map...');
      await addToMap(result, sheetTitle, controller.signal);
      progress('Map sheet saved privately to your CalTopo account and added to this map.');
    } catch (error) {
      if (!uploading && controller.signal.aborted && !dialog.open) return;
      console.warn('[StravaHeatmapExt] Could not finish saving CalTopo map sheet.', error);
      if (!dialog.isConnected) {
        document.body.appendChild(dialog);
        dialog.showModal();
      }
      status.setAttribute('role', 'alert');
      status.textContent = saved
        ? `Saved privately to your CalTopo account, but not added to this map. ${error.message}`
        : `${controller.signal.aborted ? 'Saving timed out.' : error.message}${uploading
          ? ' CalTopo may have saved the sheet; check your account before retrying.' : ''}`;
    } finally {
      clearTimeout(timer);
      releaseCreation?.();
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
    const title = document.createElement('div');
    titleText = document.createElement('span');
    titleText.textContent = 'Map Sheet from Strava Heatmap ';
    proBadge = document.createElement('a');
    proBadge.className = 'upgradeCtaButton';
    proBadge.textContent = 'Pro';
    proBadge.setAttribute('role', 'link');
    proBadge.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const nativeBadge = item.querySelector('.upgradeCtaButton');
      if (!nativeBadge) {
        console.warn('[StravaHeatmapExt] CalTopo Pro upgrade link was not found.');
        return;
      }
      nativeBadge.click();
    });
    proBadge.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      event.stopPropagation();
      proBadge.click();
    });
    title.append(titleText, proBadge);
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
