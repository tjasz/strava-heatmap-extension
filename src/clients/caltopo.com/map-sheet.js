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

export function limitMapSheetSelection(anchor, corner) {
  const project = ([lng, lat]) => {
    if (!Number.isFinite(lng) || !Number.isFinite(lat) || lng < -180 || lng > 180 ||
        Math.abs(lat) > MAX_LATITUDE) {
      throw new Error('Draw inside the world map, away from the poles and date line.');
    }
    return [(lng + 180) / 360 * TILE_COUNT, tileY(lat)];
  };
  const start = project(anchor);
  const end = project(corner);
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
        throw new Error('Wait for the map to finish loading before drawing.');
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
    const instructions = document.createElement('p');
    instructions.textContent = `Drag a box around the area to capture (up to ${MAX_TILES} zoom-${MAX_ZOOM} tiles). Use the zoom buttons or mouse wheel for precision.`;
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
    status.textContent = 'Draw a box, then confirm. Drag again to replace it.';
    const confirm = document.createElement('button');
    confirm.textContent = 'Capture selected area';
    confirm.disabled = true;
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    const zoomOut = document.createElement('button');
    zoomOut.textContent = '-';
    zoomOut.setAttribute('aria-label', 'Zoom out');
    const zoomIn = document.createElement('button');
    zoomIn.textContent = '+';
    zoomIn.setAttribute('aria-label', 'Zoom in');
    panel.append(instructions, nameLabel, status, confirm, cancel, zoomOut, zoomIn);
    overlay.append(box, panel);
    let anchor;
    let pointer;
    let region;
    let listener;
    let wheelTimer;
    let restoreDragging = () => {};
    const draw = () => {
      if (!region) return;
      const a = toPixel(region.minX, region.minY);
      const b = toPixel(region.maxX + 1, region.maxY + 1);
      box.hidden = false;
      box.style.left = `${Math.min(a[0], b[0])}px`;
      box.style.top = `${Math.min(a[1], b[1])}px`;
      box.style.width = `${Math.abs(b[0] - a[0])}px`;
      box.style.height = `${Math.abs(b[1] - a[1])}px`;
    };
    const finish = (result, error) => {
      if (pointer !== undefined && overlay.hasPointerCapture(pointer)) overlay.releasePointerCapture(pointer);
      pointer = undefined;
      clearTimeout(wheelTimer);
      signal.removeEventListener('abort', abort);
      document.removeEventListener('keydown', keydown, true);
      if (leaflet) map.off('move zoom resize', draw);
      else listener?.remove();
      overlay.remove();
      restoreDragging();
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
        if (corner[0] === anchor[0] && corner[1] === anchor[1]) return;
        const selection = limitMapSheetSelection(anchor, corner);
        region = selection.region;
        status.setAttribute('role', 'status');
        status.textContent = `${region.count}/${MAX_TILES} tiles selected.${selection.limited
          ? ' Limit reached; the box cannot grow further. Zoom in for a more precise selection.' : ''}`;
        draw();
      } catch (error) {
        region = undefined;
        box.hidden = true;
        status.setAttribute('role', 'alert');
        status.textContent = error.message;
      }
    };
    overlay.addEventListener('pointerdown', (event) => {
      if (pointer !== undefined || event.button !== 0 || !event.isPrimary) return;
      event.preventDefault();
      event.stopPropagation();
      region = undefined;
      box.hidden = true;
      confirm.disabled = true;
      try {
        const rect = container.getBoundingClientRect();
        anchor = fromPixel(event.clientX - rect.left, event.clientY - rect.top);
        limitMapSheetSelection(anchor, anchor);
      } catch (error) {
        status.setAttribute('role', 'alert');
        status.textContent = error.message;
        return;
      }
      pointer = event.pointerId;
      overlay.setPointerCapture(pointer);
    });
    overlay.addEventListener('pointermove', (event) => {
      if (event.pointerId !== pointer) return;
      event.stopPropagation();
      update(event);
    });
    overlay.addEventListener('pointerup', (event) => {
      if (event.pointerId !== pointer) return;
      event.stopPropagation();
      update(event);
      overlay.releasePointerCapture(pointer);
      pointer = undefined;
      confirm.disabled = !region;
    });
    overlay.addEventListener('pointercancel', (event) => {
      if (event.pointerId !== pointer) return;
      overlay.releasePointerCapture(pointer);
      pointer = undefined;
      region = undefined;
      box.hidden = true;
      confirm.disabled = true;
      status.setAttribute('role', 'status');
      status.textContent = 'Drawing cancelled. Drag again to select an area.';
    });
    const zoom = (direction) => {
      if (region) {
        const lat = latitude((region.minY + region.maxY + 1) / 2);
        const lng = longitude((region.minX + region.maxX + 1) / 2);
        if (leaflet) map.panTo([lat, lng], { animate: false });
        else map.setCenter({ lat, lng });
      }
      map.setZoom(Math.max(0, Math.min(21, map.getZoom() + direction)));
    };
    overlay.addEventListener('wheel', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!event.deltaY || wheelTimer !== undefined) return;
      zoom(-Math.sign(event.deltaY));
      wheelTimer = setTimeout(() => { wheelTimer = undefined; }, 150);
    }, { passive: false });
    for (const name of ['click', 'dblclick', 'mousedown', 'mouseup', 'contextmenu']) {
      overlay.addEventListener(name, (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
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
    zoomOut.addEventListener('click', () => zoom(-1));
    zoomIn.addEventListener('click', () => zoom(1));
    try {
      checkAbort(signal);
      if (leaflet) {
        const draggable = map.dragging.enabled();
        if (draggable) {
          map.dragging.disable();
          restoreDragging = () => map.dragging.enable();
        }
        map.on('move zoom resize', draw);
      } else {
        const draggable = map.get('draggable');
        map.setOptions({ draggable: false });
        restoreDragging = () => map.setOptions({ draggable: draggable ?? true });
        listener = map.addListener('bounds_changed', draw);
      }
      signal.addEventListener('abort', abort, { once: true });
      document.addEventListener('keydown', keydown, true);
      container.appendChild(overlay);
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
    message: `Draw an area of up to ${MAX_TILES} zoom-${MAX_ZOOM} heatmap tiles to save privately.`,
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
    let saved = false;
    try {
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
