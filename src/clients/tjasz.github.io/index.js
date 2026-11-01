import { setupAuthStatusChangeListener } from '../common/auth.js';
import { injectHeatmapColorFilters } from '../common/colors.js';
import { installGradientTileRecoloring } from '../common/gradient-tiles.js';
import {
  getLayerConfigs,
  parseLayerPresets,
  setupLayerPresetsChangeListener,
} from '../common/layers.js';

const MAX_ATTEMPTS = 100;
const RETRY_INTERVAL = 100;
const HEATMAP_PANE = 'stravaHeatmapPane';
const HEATMAP_PANE_Z_INDEX = 300;

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
    const target = findGeotab();
    if (target) return target;
    await new Promise((resolve) => setTimeout(resolve, RETRY_INTERVAL));
  }

  throw new Error(
    '[StravaHeatmapExt] Timeout waiting for the Geotab Leaflet map.'
  );
}

function findGeotab() {
  if (!window.L) return null;
  for (const container of document.querySelectorAll('.leaflet-container')) {
    const overlays = container.querySelector('.leaflet-control-layers-overlays');
    if (!overlays) continue;
    const map = findMap(container);
    if (map) return { map, overlays };
  }
  return null;
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
  const heatmapPane = map.getPane(HEATMAP_PANE) ?? map.createPane(HEATMAP_PANE);
  heatmapPane.style.zIndex = HEATMAP_PANE_Z_INDEX;
  heatmapPane.style.pointerEvents = 'none';

  const control = window.L.control.layers();
  const state = { control, overlays, labels: [], layers: [] };
  const update = control._update;
  // Leaflet regenerates its labels on layer changes, even in a detached control.
  control._update = function () {
    state.labels.forEach((label) => label.remove());
    const result = update.call(this);
    state.labels = Array.from(
      this.getContainer().querySelectorAll('.leaflet-control-layers-overlays label')
    );
    state.labels.forEach((label) => {
      label.classList.add('strava-heatmap-layer');
      state.overlays.append(label);
    });
    return result;
  };
  control.addTo(map);
  const container = control.getContainer();
  container.remove();

  state.layers = layerConfigs.map((config) => {
    const layer = window.L.tileLayer(config.template, {
      geotabId: config.id,
      maxNativeZoom: config.zoomExtent[1],
      pane: HEATMAP_PANE,
    });
    control.addOverlay(layer, config.name);
    return { config, layer };
  });

  state.layers.forEach(({ config, layer }, index) => {
    if (!enabledIds.has(config.id)) return;
    const input = state.labels[index]?.querySelector('input');
    if (input && !map.hasLayer(layer)) input.click();
  });

  return state;
}

function removeOverlayControl(map, state) {
  if (!state) return;

  state.layers.forEach(({ layer }) => {
    if (map.hasLayer(layer)) map.removeLayer(layer);
  });
  state.labels.forEach((label) => label.remove());
  state.control.remove();
}

async function main() {
  injectHeatmapColorFilters();
  const script = document.querySelector('script#strava-heatmap-client');
  const version = script.dataset.version;
  let authenticated = script.dataset.authenticated === 'true';
  let layerPresets = parseLayerPresets(script.dataset.layers);
  let { map, overlays } = await waitForGeotab();
  let controlState;
  let enabledIds = getRequestedOverlayIds();

  function rememberLayer({ layer, type }) {
    const entry = controlState?.layers.find((entry) => entry.layer === layer);
    if (!entry) return;
    if (type === 'layeradd') enabledIds.add(entry.config.id);
    else enabledIds.delete(entry.config.id);
  }

  function stopWatchingMap() {
    map.off('layeradd layerremove', rememberLayer);
    map.off('unload', onMapUnload);
  }

  function onMapUnload() {
    // Leaflet emits unload before removing layers; teardown is not a user toggle.
    stopWatchingMap();
    controlState.labels.forEach((label) => label.remove());
    controlState.control.remove();
    controlState = undefined;
    map = null;
    overlays = null;
  }

  function applyOverlays() {
    if (!map) return;
    stopWatchingMap();
    removeOverlayControl(map, controlState);
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
    enabledIds = new Set(
      controlState.layers.filter(({ layer }) => map.hasLayer(layer))
        .map(({ config }) => config.id)
    );
    map.on('layeradd layerremove', rememberLayer);
    map.on('unload', onMapUnload);
    console.log('[StravaHeatmapExt] Applied overlays to Geotab.', layerConfigs);
  }

  applyOverlays();

  const observer = new MutationObserver(() => {
    try {
      const target = findGeotab();
      if (!target) return;
      if (target.map !== map) {
        if (map) {
          stopWatchingMap();
          removeOverlayControl(map, controlState);
        }
        controlState = undefined;
        ({ map, overlays } = target);
        applyOverlays();
      } else {
        overlays = target.overlays;
        controlState.overlays = overlays;
        controlState.labels.forEach((label) => {
          if (label.parentElement !== overlays) overlays.append(label);
        });
      }
    } catch (error) {
      console.error('[StravaHeatmapExt] Failed to restore Geotab overlays:', error);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

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
