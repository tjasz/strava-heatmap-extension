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
let toggleButton;
let controlsCollapse;
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

  const tiles = new Set();
  const tileSize = 512;
  const overlay = {
    tileSize: new window.google.maps.Size(tileSize, tileSize),
    minZoom: 13,
    name: config.name,
    opacity,
    getTile(coord, googleZoom, ownerDocument) {
      const requestedZoom = googleZoom - 1;
      const [minZoom, maxZoom] = config.zoomExtent;
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
  if (toggleButton) {
    toggleButton.setAttribute('aria-pressed', String(enabled));
    toggleButton.classList.toggle('strava-heatmap-active', enabled);
  }
  if (controlsCollapse) {
    controlsCollapse.classList.toggle('MuiCollapse-hidden', !enabled);
    controlsCollapse.style.minHeight = enabled ? '' : '0px';
    controlsCollapse.style.height = enabled ? 'auto' : '0px';
    controlsCollapse.style.visibility = enabled ? 'visible' : 'hidden';
  }
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

  const routeDiscoveryHeading = [...document.querySelectorAll('p')].find(
    ({ textContent }) => textContent.trim() === 'Route Discovery',
  );
  const routeDiscoveryList = routeDiscoveryHeading?.nextElementSibling;
  if (routeDiscoveryList?.tagName !== 'UL') return;

  const ribbon = document.createElement('li');
  ribbon.id = RIBBON_ID;
  ribbon.className =
    'MuiListItem-root MuiListItem-gutters MuiListItem-padding css-5rcv3b';
  ribbon.setAttribute('value', 'Strava Heatmap');

  const stack = document.createElement('div');
  stack.className = 'MuiStack-root css-12mbytc';

  toggleButton = document.createElement('div');
  toggleButton.className = 'MuiButtonBase-root MuiBox-root css-lp7ikr';
  toggleButton.tabIndex = 0;
  toggleButton.setAttribute('role', 'button');
  toggleButton.setAttribute('aria-label', 'Strava Heatmap');
  toggleButton.addEventListener('click', () => {
    if (enabled) removeOverlay();
    else addOverlay();
  });
  toggleButton.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    if (enabled) removeOverlay();
    else removeOverlay();
  });

  const swatch = document.createElement('div');
  swatch.className = 'MuiBox-root strava-heatmap-swatch';

  const titleGrid = document.createElement('div');
  titleGrid.className =
    'MuiGrid-root MuiGrid-container MuiGrid-item MuiGrid-grid-xs-12 css-cjc644';
  const titleItem = document.createElement('div');
  titleItem.className =
    'MuiGrid-root MuiGrid-item MuiGrid-grid-xs-true css-1kofupb';
  const title = document.createElement('span');
  title.setAttribute('aria-label', 'Strava Heatmap');
  title.textContent = 'Strava Heatmap';
  titleItem.appendChild(title);
  titleGrid.appendChild(titleItem);
  toggleButton.append(swatch, titleGrid);

  controlsCollapse = document.createElement('div');
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

  controls.append(layerLabel, opacityLabel);
  collapseInner.appendChild(controls);
  collapseWrapper.appendChild(collapseInner);
  controlsCollapse.appendChild(collapseWrapper);
  stack.append(toggleButton, controlsCollapse);
  ribbon.appendChild(stack);
  routeDiscoveryList.appendChild(ribbon);
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
