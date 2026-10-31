import { setupAuthStatusChangeListener } from '../common/auth.js';
import { injectHeatmapColorFilters } from '../common/colors.js';
import { installGradientTileRecoloring } from '../common/gradient-tiles.js';
import { installBrouterSlide } from './slide.js';
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
    const contexts = Object.values(map?._events ?? {}).flat().map(({ ctx }) => ctx);
    const routing = contexts.find((ctx) => window.BR.Routing && ctx instanceof window.BR.Routing) ??
      contexts.map((ctx) => ctx?._parent).find(
        (ctx) => window.BR.Routing && ctx instanceof window.BR.Routing
      );
    if (window.L && map && control && routing &&
        document.querySelector('#mdi-vector-line')) return { map, control, routing };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('[StravaHeatmapExt] Timeout waiting for the BRouter layers control.');
}

async function main() {
  injectHeatmapColorFilters();
  const script = document.querySelector('script#strava-heatmap-client');
  const version = script.dataset.version;
  let authenticated = script.dataset.authenticated === 'true';
  let layerPresets = parseLayerPresets(script.dataset.layers);
  const { map, control, routing } = await waitForBrouter();
  const pane = map.getPane(HEATMAP_PANE) ?? map.createPane(HEATMAP_PANE);
  pane.style.zIndex = '300';
  pane.style.pointerEvents = 'none';
  let layers = [];
  let selectedId;
  let slide;
  let applyingOverlays = false;
  const getSlideLayer = () => {
    const entry = layers.find(({ id, layer }) => id === selectedId && map.hasLayer(layer)) ??
      layers.find(({ layer }) => map.hasLayer(layer));
    return entry?.config;
  };
  map.on('overlayadd', ({ layer }) => {
    if (applyingOverlays) return;
    const entry = layers.find((entry) => entry.layer === layer);
    if (!entry) return;
    selectedId = entry.id;
    slide?.invalidate();
  });
  map.on('overlayremove', ({ layer }) => {
    if (applyingOverlays) return;
    if (layers.some((entry) => entry.layer === layer)) slide?.invalidate();
  });

  function applyOverlays() {
    applyingOverlays = true;
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
        maxZoom: 19,
        opacity: previous?.layer.options.opacity ?? 1,
      });
      control.addOverlay(layer, config.name);
      if (enabledIds.has(config.id)) map.addLayer(layer);
      return { id: config.id, layer, config };
    });
    applyingOverlays = false;
    console.log('[StravaHeatmapExt] Applied overlays to BRouter.');
  }

  applyOverlays();
  slide = installBrouterSlide(routing, map, getSlideLayer);
  setupAuthStatusChangeListener((newAuthenticated) => {
    authenticated = newAuthenticated;
    applyOverlays();
    slide.invalidate();
  });
  setupLayerPresetsChangeListener((presets) => {
    layerPresets = parseLayerPresets(presets);
    applyOverlays();
    slide.invalidate();
  });
}

main().catch((error) => {
  console.error('[StravaHeatmapExt] Failed to initialize BRouter integration:', error);
});
