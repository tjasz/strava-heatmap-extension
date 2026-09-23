import { setupAuthStatusChangeListener } from '../common/auth.js';
import { installGradientTileRecoloring } from '../common/gradient-tiles.js';
import {
  getLayerConfigs,
  parseLayerPresets,
  setupLayerPresetsChangeListener,
} from '../common/layers.js';

const MAX_ATTEMPTS = 100;
const RETRY_INTERVAL = 100;

installGradientTileRecoloring();

function findMap(container) {
  const fiberKey = Object.getOwnPropertyNames(container).find(
    (key) =>
      key.startsWith('__reactFiber$') ||
      key.startsWith('__reactInternalInstance$')
  );
  let fiber = fiberKey ? container[fiberKey] : null;

  while (fiber) {
    let hook = fiber.memoizedState;
    while (hook) {
      const map = hook.memoizedState?.map;
      if (map instanceof window.L.Map) return map;
      hook = hook.next;
    }
    fiber = fiber.return;
  }

  return null;
}

async function waitForGeotab() {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const container = document.querySelector('.leaflet-container');
    const overlays = document.querySelector('.leaflet-control-layers-overlays');
    if (window.L && container && overlays) {
      const map = findMap(container);
      if (map) return { map, overlays };
    }
    await new Promise((resolve) => setTimeout(resolve, RETRY_INTERVAL));
  }

  throw new Error(
    '[StravaHeatmapExt] Timeout waiting for the Geotab Leaflet map.'
  );
}

function getRequestedOverlayIds() {
  return new Set(
    new URLSearchParams(window.location.search)
      .get('o')
      ?.split(',')
      .filter(Boolean) ?? []
  );
}

function createOverlayControl(map, overlays, layerConfigs, enabledIds) {
  const control = window.L.control.layers();
  control.addTo(map);
  const container = control.getContainer();
  container.remove();

  const layers = layerConfigs.map((config) => {
    const layer = window.L.tileLayer(config.template, {
      geotabId: config.id,
      maxNativeZoom: config.zoomExtent[1],
    });
    control.addOverlay(layer, config.name);
    return { config, layer };
  });

  const labels = Array.from(
    container.querySelectorAll('.leaflet-control-layers-overlays label')
  );
  labels.forEach((label) => {
    label.classList.add('strava-heatmap-layer');
    overlays.append(label);
  });

  layers.forEach(({ config, layer }, index) => {
    if (!enabledIds.has(config.id)) return;
    const input = labels[index]?.querySelector('input');
    if (input && !map.hasLayer(layer)) input.click();
  });

  return { control, labels, layers };
}

function removeOverlayControl(map, state) {
  if (!state) return new Set();

  const enabledIds = new Set(
    state.layers
      .filter(({ layer }) => map.hasLayer(layer))
      .map(({ config }) => config.id)
  );

  state.layers.forEach(({ layer }) => {
    if (map.hasLayer(layer)) map.removeLayer(layer);
  });
  state.labels.forEach((label) => label.remove());
  state.control.remove();
  return enabledIds;
}

async function main() {
  const script = document.querySelector('script#strava-heatmap-client');
  const version = script.dataset.version;
  let authenticated = script.dataset.authenticated === 'true';
  let layerPresets = parseLayerPresets(script.dataset.layers);
  const { map, overlays } = await waitForGeotab();
  let controlState;

  function applyOverlays() {
    const enabledIds = controlState
      ? removeOverlayControl(map, controlState)
      : getRequestedOverlayIds();
    const layerConfigs = getLayerConfigs(
      layerPresets,
      authenticated,
      version,
      true
    );
    controlState = createOverlayControl(
      map,
      overlays,
      layerConfigs,
      enabledIds
    );
    console.log('[StravaHeatmapExt] Applied overlays to Geotab.', layerConfigs);
  }

  applyOverlays();

  setupAuthStatusChangeListener((newAuthenticated) => {
    authenticated = newAuthenticated;
    applyOverlays();
  });

  setupLayerPresetsChangeListener((layers) => {
    layerPresets = parseLayerPresets(layers);
    applyOverlays();
  });
}

main().catch((error) => {
  console.error('[StravaHeatmapExt] Failed to initialize Geotab integration:', error);
});
