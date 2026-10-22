import { setupAuthStatusChangeListener } from '../common/auth.js';
import { installGradientTileRecoloring } from '../common/gradient-tiles.js';
import {
  getLayerConfigs,
  parseLayerPresets,
  setupLayerPresetsChangeListener,
} from '../common/layers.js';

const HEATMAP_PANE = 'stravaHeatmapPane';

installGradientTileRecoloring();

async function waitForBrouter() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const map = window.BR?.debug?.map;
    // BRouter registers its sidebar control as the baselayerchange listener context.
    const control = map?._events?.baselayerchange?.find(
      ({ ctx }) => window.BR.LayersTab && ctx instanceof window.BR.LayersTab
    )?.ctx;
    if (window.L && map && control) return { map, control };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('[StravaHeatmapExt] Timeout waiting for the BRouter layers control.');
}

async function main() {
  const script = document.querySelector('script#strava-heatmap-client');
  const version = script.dataset.version;
  let authenticated = script.dataset.authenticated === 'true';
  let layerPresets = parseLayerPresets(script.dataset.layers);
  const { map, control } = await waitForBrouter();
  const pane = map.getPane(HEATMAP_PANE) ?? map.createPane(HEATMAP_PANE);
  pane.style.zIndex = '300';
  pane.style.pointerEvents = 'none';
  let layers = [];

  function applyOverlays() {
    const previousLayers = layers;
    const enabledIds = new Set(
      previousLayers.filter(({ layer }) => map.hasLayer(layer)).map(({ id }) => id)
    );
    previousLayers.forEach(({ layer }) => {
      if (map.hasLayer(layer)) map.removeLayer(layer);
      control.removeLayer(layer);
    });

    layers = getLayerConfigs(layerPresets, authenticated, version).map((config) => {
      const previous = previousLayers.find(({ id }) => id === config.id);
      const layer = window.L.tileLayer(config.template, {
        pane: HEATMAP_PANE,
        maxNativeZoom: config.zoomExtent[1],
        opacity: previous?.layer.options.opacity ?? 1,
      });
      control.addOverlay(layer, config.name);
      if (enabledIds.has(config.id)) map.addLayer(layer);
      return { id: config.id, layer };
    });
    console.log('[StravaHeatmapExt] Applied overlays to BRouter.');
  }

  applyOverlays();
  setupAuthStatusChangeListener((newAuthenticated) => {
    authenticated = newAuthenticated;
    applyOverlays();
  });
  setupLayerPresetsChangeListener((presets) => {
    layerPresets = parseLayerPresets(presets);
    applyOverlays();
  });
}

main().catch((error) => {
  console.error('[StravaHeatmapExt] Failed to initialize BRouter integration:', error);
});
