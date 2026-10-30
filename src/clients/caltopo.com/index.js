import { setupAuthStatusChangeListener } from '../common/auth.js';
import { injectHeatmapColorFilters } from '../common/colors.js';
import { installCalTopoSnap } from './snap.js';
import { installCalTopoMapSheets } from './map-sheet.js';
import {
  getLayerConfigs,
  parseLayerPresets,
  setupLayerPresetsChangeListener,
} from '../common/layers.js';

const OVERLAY_KEY = '__stravaHeatmapCalTopoOverlay';
const RIBBON_ID = 'strava-heatmap-caltopo-ribbon';
const STORAGE_KEY = 'strava-heatmap-extension:caltopo-layer-state';
const RETRY_INTERVAL_MS = 500;
const MAX_ATTEMPTS = 120;

let selectedLayerId;
let layerConfigs = [];
let layerOrder = [];
const layerStates = new Map();
const overlaysById = new Map();
const controlsById = new Map();
let initialLayerState = { enabled: true, opacity: 1 };
let observedOverlayMapTypes;
let overlayMapTypeListeners = [];
let restoreOverlayTimer;
let ribbonObserver;
let snapIntegration;

function loadState() {
  try {
    const state = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!state || typeof state !== 'object') return;

    if (typeof state.layerId === 'string') selectedLayerId = state.layerId;
    if (Array.isArray(state.layerOrder)) {
      layerOrder = [...new Set(state.layerOrder.filter((id) => typeof id === 'string'))];
    }
    if (state.layers && typeof state.layers === 'object') {
      for (const [id, layer] of Object.entries(state.layers)) {
        if (typeof layer?.enabled !== 'boolean' || !Number.isFinite(layer.opacity)) continue;
        layerStates.set(id, {
          enabled: layer.enabled,
          opacity: Math.max(0, Math.min(1, layer.opacity)),
        });
      }
    } else {
      if (typeof state.enabled === 'boolean') initialLayerState.enabled = state.enabled;
      if (Number.isFinite(state.opacity)) {
        initialLayerState.opacity = Math.max(0, Math.min(1, state.opacity));
      }
    }
  } catch (error) {
    console.warn('[StravaHeatmapExt] Could not restore CalTopo layer state.', error);
  }
}

function saveState() {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ layerId: selectedLayerId, layers: Object.fromEntries(layerStates), layerOrder }),
    );
  } catch (error) {
    console.warn('[StravaHeatmapExt] Could not save CalTopo layer state.', error);
  }
}

function getGoogleMap() {
  const googleMap = window.map?.map?.map;
  return window.google?.maps && googleMap?.overlayMapTypes ? googleMap : null;
}

function getLeafletMap() {
  const leafletMap = window.map?.map?.map;
  return window.L?.tileLayer && leafletMap?.addLayer && leafletMap?.removeLayer
    ? leafletMap
    : null;
}

function getActiveLayerConfigs() {
  return layerOrder.map((id) => layerConfigs.find((config) => config.id === id));
}

function restoreOverlayOnTop() {
  restoreOverlayTimer = undefined;
  const activeOverlays = getActiveLayerConfigs().map(({ id }) => overlaysById.get(id)).filter(Boolean);
  for (const overlay of activeOverlays) {
    if (overlay.__stravaHeatmapRenderer === 'leaflet') overlay.bringToFront();
  }
  const googleMap = getGoogleMap();
  if (!activeOverlays.length || !googleMap) return;

  const overlays = googleMap.overlayMapTypes;
  const managed = new Set(activeOverlays);
  const overlayIndexes = [];
  for (let index = 0; index < overlays.getLength(); index++) {
    if (managed.has(overlays.getAt(index))) overlayIndexes.push(index);
  }
  if (
    activeOverlays.every((overlay, index) =>
      overlays.getAt(overlays.getLength() - activeOverlays.length + index) === overlay)
  ) {
    return;
  }

  for (let index = overlayIndexes.length - 1; index >= 0; index--) {
    overlays.removeAt(overlayIndexes[index]);
  }
  for (const overlay of activeOverlays) overlays.push(overlay);
}

function setupOverlayMapTypesListener(googleMap) {
  const overlays = googleMap.overlayMapTypes;
  if (observedOverlayMapTypes === overlays) return;

  for (const listener of overlayMapTypeListeners) listener.remove();
  observedOverlayMapTypes = overlays;
  const scheduleRestore = () => {
    if (restoreOverlayTimer !== undefined) return;
    restoreOverlayTimer = window.setTimeout(restoreOverlayOnTop, 0);
  };
  overlayMapTypeListeners = ['insert_at', 'remove_at', 'set_at'].map((event) =>
    overlays.addListener(event, scheduleRestore),
  );
}

function detachOverlay(id) {
  const overlay = overlaysById.get(id);
  if (!overlay) return;
  if (overlay?.__stravaHeatmapRenderer === 'leaflet') {
    overlay.remove();
  } else {
    const overlays = overlay.__stravaHeatmapMap.overlayMapTypes;
    for (let index = overlays.getLength() - 1; index >= 0; index--) {
      if (overlays.getAt(index) === overlay) overlays.removeAt(index);
    }
  }
  overlaysById.delete(id);
}

function toggleOverlay(id) {
  const state = layerStates.get(id);
  state.enabled = !state.enabled;
  layerOrder = layerOrder.filter((layerId) => layerId !== id);
  if (state.enabled) {
    layerOrder.push(id);
    selectedLayerId = id;
    snapIntegration?.invalidate();
    addOverlay(id);
  } else {
    detachOverlay(id);
  }
  updateControls();
  saveState();
}

function addOverlay(id) {
  const leafletMap = getLeafletMap();
  const googleMap = getGoogleMap();
  const config = layerConfigs.find((config) => config.id === id);
  const state = layerStates.get(id);
  if ((!leafletMap && !googleMap) || !config) {
    return false;
  }

  if (leafletMap) {
    const existingOverlay = overlaysById.get(id);
    if (
      existingOverlay?.__stravaHeatmapRenderer === 'leaflet' &&
      existingOverlay._map === leafletMap
    ) {
      restoreOverlayOnTop();
      updateControls();
      return true;
    }
    if (existingOverlay) detachOverlay(id);

    const [minZoom, maxZoom] = config.zoomExtent;
    const overlay = window.L.tileLayer(config.template, {
      minZoom,
      maxNativeZoom: maxZoom,
      maxZoom: 21,
      opacity: state.opacity,
      tileSize: 256,
      zIndex: 1000,
    });
    overlay.__stravaHeatmapRenderer = 'leaflet';
    overlay.addTo(leafletMap);
    overlaysById.set(id, overlay);
    restoreOverlayOnTop();
    updateControls();
    return true;
  }

  setupOverlayMapTypesListener(googleMap);
  const existingOverlay = overlaysById.get(id);
  if (existingOverlay?.__stravaHeatmapMap === googleMap) {
    restoreOverlayOnTop();
    updateControls();
    return true;
  }
  if (existingOverlay) detachOverlay(id);

  const tiles = new Set();
  const tileSize = 256;
  const [minZoom, maxZoom] = config.zoomExtent;
  const overlay = {
    tileSize: new window.google.maps.Size(tileSize, tileSize),
    minZoom,
    maxZoom: 21,
    name: config.name,
    opacity: state.opacity,
    __stravaHeatmapMap: googleMap,
    getTile(coord, requestedZoom, ownerDocument) {
      const tile = ownerDocument.createElement('div');
      tile.style.width = `${tileSize}px`;
      tile.style.height = `${tileSize}px`;
      tile.style.overflow = 'hidden';
      tile.style.opacity = String(this.opacity);
      tiles.add(tile);

      if (requestedZoom < minZoom) return tile;

      const sourceZoom = Math.min(requestedZoom, maxZoom);
      const scale = 2 ** (requestedZoom - sourceZoom);
      const requestedTileCount = 2 ** requestedZoom;
      const requestedX =
        ((coord.x % requestedTileCount) + requestedTileCount) % requestedTileCount;
      if (coord.y < 0 || coord.y >= requestedTileCount) return tile;

      const sourceX = Math.floor(requestedX / scale);
      const sourceY = Math.floor(coord.y / scale);
      const image = ownerDocument.createElement('img');
      image.src = config.template
        .replace('{z}', sourceZoom)
        .replace('{x}', sourceX)
        .replace('{y}', sourceY);
      image.style.width = `${tileSize}px`;
      image.style.height = `${tileSize}px`;
      image.style.transformOrigin = 'top left';
      image.style.transform = `scale(${scale})`;
      image.style.marginLeft = `${-(requestedX % scale) * tileSize}px`;
      image.style.marginTop = `${-(coord.y % scale) * tileSize}px`;
      tile.appendChild(image);
      return tile;
    },
    releaseTile(tile) {
      tiles.delete(tile);
    },
    setOpacity(value) {
      this.opacity = value;
      for (const tile of tiles) tile.style.opacity = String(value);
    },
  };

  googleMap.overlayMapTypes.push(overlay);
  overlaysById.set(id, overlay);
  restoreOverlayOnTop();
  updateControls();
  return true;
}

function refreshOverlays() {
  snapIntegration?.invalidate();
  for (const id of overlaysById.keys()) detachOverlay(id);
  for (const { id } of getActiveLayerConfigs()) addOverlay(id);
  updateControls();
}

function setOpacity(id, value) {
  const state = layerStates.get(id);
  state.opacity = Math.max(0, Math.min(1, Number(value)));
  overlaysById.get(id)?.setOpacity(state.opacity);
  if (selectedLayerId !== id) {
    selectedLayerId = id;
    snapIntegration?.invalidate();
  }
  updateControls();
  saveState();
}

function updateControls() {
  if (overlaysById.has(selectedLayerId)) window[OVERLAY_KEY] = overlaysById.get(selectedLayerId);
  else delete window[OVERLAY_KEY];
  for (const [id, controls] of controlsById) {
    const { enabled, opacity } = layerStates.get(id);
    const { stack, toggleButton, controlsCollapse, opacityInput, opacityOutput } = controls;
    stack.classList.toggle('strava-heatmap-layer-active', enabled);
    toggleButton.setAttribute('aria-pressed', String(enabled));
    toggleButton.setAttribute('aria-expanded', String(enabled));
    toggleButton.classList.toggle('strava-heatmap-active', enabled);
    controlsCollapse.classList.toggle('MuiCollapse-hidden', !enabled);
    controlsCollapse.style.minHeight = enabled ? '' : '0px';
    controlsCollapse.style.height = enabled ? 'auto' : '0px';
    controlsCollapse.style.visibility = enabled ? 'visible' : 'hidden';
    opacityInput.value = String(Math.round(opacity * 100));
    opacityInput.disabled = !enabled;
    opacityOutput.value = `${Math.round(opacity * 100)}%`;
  }
}

function createRibbon() {
  const routeDiscoveryHeading = [...document.querySelectorAll('p')].find(
    ({ textContent }) => textContent.trim() === 'Route Discovery',
  );
  const routeDiscoveryList = routeDiscoveryHeading?.nextElementSibling;
  if (routeDiscoveryList?.tagName !== 'UL') return;

  for (const config of layerConfigs) {
    const ribbonId = `${RIBBON_ID}-${config.id}`;
    if (document.getElementById(ribbonId)) continue;
    const controls = createLayerControls(config);
    controlsById.set(config.id, controls);
    routeDiscoveryList.appendChild(controls.ribbon);
  }
  updateControls();
}

function createLayerControls(config) {
  const ribbon = document.createElement('li');
  ribbon.id = `${RIBBON_ID}-${config.id}`;
  ribbon.className =
    'MuiListItem-root MuiListItem-gutters MuiListItem-padding css-5rcv3b';
  const label = config.name;
  ribbon.setAttribute('value', label);

  const stack = document.createElement('div');
  stack.className = 'MuiStack-root css-12mbytc';

  const toggleButton = document.createElement('div');
  toggleButton.className = 'MuiButtonBase-root MuiBox-root css-lp7ikr';
  toggleButton.tabIndex = 0;
  toggleButton.setAttribute('role', 'button');
  toggleButton.setAttribute('aria-label', label);
  toggleButton.addEventListener('click', () => toggleOverlay(config.id));
  toggleButton.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    toggleOverlay(config.id);
  });

  const swatch = document.createElement('div');
  swatch.className = 'MuiBox-root strava-heatmap-swatch';
  swatch.setAttribute('aria-hidden', 'true');
  swatch.textContent = '🔥';

  const titleGrid = document.createElement('div');
  titleGrid.className =
    'MuiGrid-root MuiGrid-container MuiGrid-item MuiGrid-grid-xs-12 css-cjc644';
  const titleItem = document.createElement('div');
  titleItem.className =
    'MuiGrid-root MuiGrid-item MuiGrid-grid-xs-true css-1kofupb';
  const title = document.createElement('span');
  title.className = 'strava-heatmap-title';
  title.setAttribute('aria-label', label);
  title.textContent = label;
  titleItem.appendChild(title);
  titleGrid.appendChild(titleItem);
  toggleButton.append(swatch, titleGrid);

  const controlsCollapse = document.createElement('div');
  controlsCollapse.id = `${ribbon.id}-controls`;
  toggleButton.setAttribute('aria-controls', controlsCollapse.id);
  controlsCollapse.className =
    'MuiCollapse-root MuiCollapse-vertical css-a0y2e3';
  const collapseWrapper = document.createElement('div');
  collapseWrapper.className =
    'MuiCollapse-wrapper MuiCollapse-vertical css-hboir5';
  const collapseInner = document.createElement('div');
  collapseInner.className =
    'MuiCollapse-wrapperInner MuiCollapse-vertical css-8atqhb';
  const controls = document.createElement('div');
  controls.className = 'MuiBox-root css-1y82lur strava-heatmap-controls';

  const opacityLabel = document.createElement('label');
  opacityLabel.textContent = 'Opacity';
  const opacityInput = document.createElement('input');
  opacityInput.type = 'range';
  opacityInput.min = '0';
  opacityInput.max = '100';
  opacityInput.step = '1';
  opacityInput.setAttribute('aria-label', `${label} opacity`);
  opacityInput.addEventListener('input', () => {
    setOpacity(config.id, Number(opacityInput.value) / 100);
  });
  const opacityOutput = document.createElement('output');
  opacityOutput.setAttribute('aria-live', 'polite');
  opacityLabel.append(opacityInput, opacityOutput);

  controls.appendChild(opacityLabel);
  collapseInner.appendChild(controls);
  collapseWrapper.appendChild(collapseInner);
  controlsCollapse.appendChild(collapseWrapper);
  stack.append(toggleButton, controlsCollapse);
  ribbon.appendChild(stack);
  return { ribbon, stack, toggleButton, controlsCollapse, opacityInput, opacityOutput };
}

function setupRibbonObserver() {
  createRibbon();
  if (ribbonObserver) return;

  ribbonObserver = new MutationObserver(() => {
    if (layerConfigs.some(({ id }) => !document.getElementById(`${RIBBON_ID}-${id}`))) createRibbon();
  });
  ribbonObserver.observe(document.body, { childList: true, subtree: true });
}

function applyLayerConfigs(layerPresets, authenticated, version) {
  const previousLayerId = selectedLayerId;
  const previousState = layerStates.get(previousLayerId) ?? initialLayerState;
  layerConfigs = getLayerConfigs(layerPresets, authenticated, version, true);
  selectedLayerId = layerConfigs.some(({ id }) => id === previousLayerId)
    ? previousLayerId
    : layerConfigs.find(({ id }) => layerStates.get(id)?.enabled)?.id ?? layerConfigs[0]?.id;
  const ids = new Set(layerConfigs.map(({ id }) => id));
  for (const id of layerStates.keys()) {
    if (!ids.has(id)) layerStates.delete(id);
  }
  for (const { id } of layerConfigs) {
    if (!layerStates.has(id)) {
      layerStates.set(id, id === selectedLayerId ? { ...previousState } : { enabled: false, opacity: 1 });
    }
  }
  layerOrder = layerOrder.filter((id) => ids.has(id) && layerStates.get(id).enabled);
  for (const { id } of layerConfigs) {
    if (layerStates.get(id).enabled && !layerOrder.includes(id)) layerOrder.push(id);
  }
  for (const { ribbon } of controlsById.values()) ribbon.remove();
  controlsById.clear();
  createRibbon();
  refreshOverlays();
  saveState();
}

async function main() {
  if (/^\/print(?:\/|$)/.test(window.location.pathname)) return;

  const script = document.querySelector('script#strava-heatmap-client');
  const version = script.dataset.version;
  let authenticated = script.dataset.authenticated === 'true';
  let layerPresets = parseLayerPresets(script.dataset.layers);

  injectHeatmapColorFilters();
  loadState();
  applyLayerConfigs(layerPresets, authenticated, version);
  setupRibbonObserver();
  installCalTopoMapSheets(
    () => getActiveLayerConfigs()
      .map((config) => ({ ...config, opacity: layerStates.get(config.id).opacity })),
    () => getLeafletMap() || getGoogleMap(),
  );

  setupAuthStatusChangeListener((newAuthenticated) => {
    authenticated = newAuthenticated;
    applyLayerConfigs(layerPresets, authenticated, version);
  });

  setupLayerPresetsChangeListener((layers) => {
    layerPresets = parseLayerPresets(layers);
    applyLayerConfigs(layerPresets, authenticated, version);
  });

  let attempts = 0;
  const timer = window.setInterval(() => {
    attempts += 1;
    const manager = window.imap?.drawingManager;
    if (!snapIntegration && manager) {
      snapIntegration = installCalTopoSnap(manager, () =>
        layerConfigs.find(({ id }) => id === selectedLayerId));
    }
    const overlayReady = getActiveLayerConfigs()
      .every(({ id }) => addOverlay(id));
    if ((overlayReady && snapIntegration) || attempts >= MAX_ATTEMPTS) {
      window.clearInterval(timer);
      if (attempts >= MAX_ATTEMPTS && !overlayReady) {
        console.warn('[StravaHeatmapExt] CalTopo map was not found.');
      }
      if (!snapIntegration) {
        console.warn('[StravaHeatmapExt] CalTopo drawing manager was not found.');
      }
    }
  }, RETRY_INTERVAL_MS);
}

main();
