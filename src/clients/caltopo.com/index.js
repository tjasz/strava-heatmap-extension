import { setupAuthStatusChangeListener } from '../common/auth.js';
import {
  getLayerConfigs,
  parseLayerPresets,
  setupLayerPresetsChangeListener,
} from '../common/layers.js';

const OVERLAY_KEY = '__stravaHeatmapCalTopoOverlay';
const RIBBON_ID = 'strava-heatmap-caltopo-ribbon';
const RETRY_INTERVAL_MS = 500;
const MAX_ATTEMPTS = 120;

let enabled = true;
let opacity = 1;
let selectedLayerId;
let layerConfigs = [];
let enabledInput;
let layerInput;
let opacityInput;
let opacityOutput;

function getGoogleMap() {
  const googleMap = window.map?.map?.map;
  return window.google?.maps && googleMap?.overlayMapTypes ? googleMap : null;
}

function detachOverlay() {
  const overlay = window[OVERLAY_KEY];
  const googleMap = getGoogleMap();
  if (!overlay || !googleMap) return false;

  const overlays = googleMap.overlayMapTypes;
  for (let index = overlays.getLength() - 1; index >= 0; index--) {
    if (overlays.getAt(index) === overlay) overlays.removeAt(index);
  }

  delete window[OVERLAY_KEY];
  return true;
}

function removeOverlay() {
  enabled = false;
  detachOverlay();
  updateControls();
}

function addOverlay() {
  enabled = true;
  const googleMap = getGoogleMap();
  const config = layerConfigs.find(({ id }) => id === selectedLayerId);
  if (!googleMap || !config) {
    updateControls();
    return false;
  }
  if (window[OVERLAY_KEY]) {
    updateControls();
    return true;
  }

  const overlay = new window.google.maps.ImageMapType({
    getTileUrl(coord, googleZoom) {
      const zoom = googleZoom - 1;
      if (zoom < 0) return null;

      const tileCount = 2 ** zoom;
      const x = ((coord.x % tileCount) + tileCount) % tileCount;
      if (coord.y < 0 || coord.y >= tileCount) return null;

      return config.template
        .replace('{z}', zoom)
        .replace('{x}', x)
        .replace('{y}', coord.y);
    },
    tileSize: new window.google.maps.Size(512, 512),
    minZoom: 13,
    maxZoom: config.zoomExtent[1] + 1,
    name: config.name,
    opacity,
  });

  googleMap.overlayMapTypes.push(overlay);
  window[OVERLAY_KEY] = overlay;
  updateControls();
  return true;
}

function refreshOverlay() {
  detachOverlay();
  if (enabled) addOverlay();
  updateControls();
}

function setOpacity(value) {
  opacity = Math.max(0, Math.min(1, Number(value)));
  window[OVERLAY_KEY]?.setOpacity(opacity);
  updateControls();
}

function updateControls() {
  if (enabledInput) enabledInput.checked = enabled;
  if (layerInput) layerInput.value = selectedLayerId ?? '';
  if (opacityInput) {
    opacityInput.value = String(Math.round(opacity * 100));
    opacityInput.disabled = !enabled;
  }
  if (opacityOutput) opacityOutput.value = `${Math.round(opacity * 100)}%`;
}

function updateLayerOptions() {
  if (!layerInput) return;

  layerInput.replaceChildren();
  for (const config of layerConfigs) {
    const option = document.createElement('option');
    option.value = config.id;
    option.textContent = config.name;
    layerInput.appendChild(option);
  }
  updateControls();
}

function createRibbon() {
  if (document.getElementById(RIBBON_ID)) return;

  const ribbon = document.createElement('div');
  ribbon.id = RIBBON_ID;
  ribbon.setAttribute('role', 'toolbar');
  ribbon.setAttribute('aria-label', 'Strava heatmap controls');

  const toggleLabel = document.createElement('label');
  toggleLabel.className = 'strava-heatmap-toggle';

  enabledInput = document.createElement('input');
  enabledInput.type = 'checkbox';
  enabledInput.setAttribute('aria-label', 'Show Strava heatmap');
  enabledInput.addEventListener('change', () => {
    if (enabledInput.checked) addOverlay();
    else removeOverlay();
  });

  const title = document.createElement('span');
  title.textContent = 'Strava heatmap';
  toggleLabel.append(enabledInput, title);

  const layerLabel = document.createElement('label');
  layerLabel.textContent = 'Layer';
  layerInput = document.createElement('select');
  layerInput.setAttribute('aria-label', 'Strava heatmap layer');
  layerInput.addEventListener('change', () => {
    selectedLayerId = layerInput.value;
    refreshOverlay();
  });
  layerLabel.appendChild(layerInput);

  const opacityLabel = document.createElement('label');
  opacityLabel.textContent = 'Opacity';
  opacityInput = document.createElement('input');
  opacityInput.type = 'range';
  opacityInput.min = '0';
  opacityInput.max = '100';
  opacityInput.step = '1';
  opacityInput.setAttribute('aria-label', 'Strava heatmap opacity');
  opacityInput.addEventListener('input', () => {
    setOpacity(Number(opacityInput.value) / 100);
  });
  opacityOutput = document.createElement('output');
  opacityOutput.setAttribute('aria-live', 'polite');
  opacityLabel.append(opacityInput, opacityOutput);

  ribbon.append(toggleLabel, layerLabel, opacityLabel);
  document.body.appendChild(ribbon);
  updateLayerOptions();
}

function applyLayerConfigs(layerPresets, authenticated, version) {
  const previousLayerId = selectedLayerId;
  layerConfigs = getLayerConfigs(layerPresets, authenticated, version, true);
  selectedLayerId = layerConfigs.some(({ id }) => id === previousLayerId)
    ? previousLayerId
    : layerConfigs[0]?.id;
  updateLayerOptions();
  refreshOverlay();
}

async function main() {
  const script = document.querySelector('script#strava-heatmap-client');
  const version = script.dataset.version;
  let authenticated = script.dataset.authenticated === 'true';
  let layerPresets = parseLayerPresets(script.dataset.layers);

  applyLayerConfigs(layerPresets, authenticated, version);
  createRibbon();

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
    if (!enabled || addOverlay() || attempts >= MAX_ATTEMPTS) {
      window.clearInterval(timer);
      if (attempts >= MAX_ATTEMPTS && !window[OVERLAY_KEY]) {
        console.warn('[StravaHeatmapExt] CalTopo map was not found.');
      }
    }
  }, RETRY_INTERVAL_MS);
}

main();
