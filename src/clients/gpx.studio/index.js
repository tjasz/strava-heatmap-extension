import { setupAuthStatusChangeListener } from '../common/auth.js';
import { parseLayerPresets, setupLayerPresetsChangeListener, getLayerConfigs } from '../common/layers.js';
import { installGradientTileRecoloring } from '../common/gradient-tiles.js';

installGradientTileRecoloring({ recolorPalettes: true });

async function waitForGpxStudio(maxAttempts = 50, interval = 100) {
  for (let i = 0; i < maxAttempts; i++) {
    // v2 may drop the v1 methods such as ensureLoaded
    if (window.gpxstudio && (window.gpxstudio.version === 2 || typeof window.gpxstudio.ensureLoaded === 'function')) {
      console.log('[StravaHeatmapExt] gpx.studio API detected');
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, interval));
  }
  throw new Error('[StravaHeatmapExt] Timeout waiting for gpx.studio API');
}

// Strava tiles are 512 px; drawing them as 256 keeps the look of the v1 API
const TILE_SIZE = 256;

function getOverlayStyle(config) {
  // The shared tile interceptor applies palettes and custom gradients once.
  return {
    version: 8,
    sources: {
      heatmap: {
        type: 'raster',
        tiles: [config.template],
        tileSize: TILE_SIZE,
        maxzoom: config.zoomExtent[1],
      },
    },
    layers: [{ id: 'heatmap', type: 'raster', source: 'heatmap' }],
  };
}

// gpx.studio leaves remembering the visible overlays to the extension (API v2)
const storageKeyVisible = 'strava-heatmap-visible';

function getSavedVisibility() {
  try {
    return JSON.parse(localStorage.getItem(storageKeyVisible)) ?? {};
  } catch {
    return {};
  }
}

function saveVisibility(visible) {
  try {
    localStorage.setItem(
      storageKeyVisible,
      JSON.stringify({ ...getSavedVisibility(), ...visible })
    );
  } catch {
    // storage unavailable: the overlays are just not remembered
  }
}

async function applyOverlays(layerPresets, authenticated, version, athleteId) {
  console.log('[StravaHeatmapExt] Applying overlays to gpx.studio', { layerPresets, authenticated });

  if (window.gpxstudio.version === 2) {
    const layerConfigs = getLayerConfigs(layerPresets, authenticated, version, true, false, athleteId);
    const saved = getSavedVisibility();
    window.gpxstudio.setOverlays(
      'Strava Heatmap',
      layerConfigs.map((config) => ({
        id: config.id,
        name: config.name,
        style: getOverlayStyle(config),
        visible: saved[config.id],
      }))
    );
    console.log('[StravaHeatmapExt] Successfully applied overlays to gpx.studio (API v2)');
    return;
  }

  // The v1 API can't colorize grayscale tiles, use legacy pre-colored tiles
  const layerConfigs = getLayerConfigs(layerPresets, authenticated, version, true, true);

  window.gpxstudio.filterOverlays(layerConfigs.map((config) => config.id));

  // Add each layer as an overlay
  for (const config of layerConfigs) {
    const overlay = {
      extensionName: "Strava Heatmap",
      id: config.id,
      name: config.name,
      tileUrls: [config.template],
      maxZoom: config.zoomExtent[1],
    };
    
    window.gpxstudio.addOrUpdateOverlay(overlay);
    console.log('[StravaHeatmapExt] Added overlay:', overlay);
  }

  window.gpxstudio.updateOverlaysOrder(layerConfigs.map((config) => config.id));

  console.log('[StravaHeatmapExt] Successfully applied overlays to gpx.studio');
}

async function main() {
  const script = document.querySelector('script#strava-heatmap-client');

  const version = script.dataset.version;
  const athleteId = script.dataset.athleteId;

  let authenticated = script.dataset.authenticated === 'true';
  let layerPresets = parseLayerPresets(script.dataset.layers);

  console.log('[StravaHeatmapExt] Initializing gpx.studio integration', {
    version,
    authenticated,
    layerPresets,
  });

  try {
    // Wait for gpx.studio API to be available
    await waitForGpxStudio();

    // Wait until UI is loaded
    await (window.gpxstudio.version === 2
      ? window.gpxstudio.ready
      : window.gpxstudio.ensureLoaded());

    // Apply initial overlays
    await applyOverlays(layerPresets, authenticated, version, athleteId);

    // Remember the overlays the user shows or hides
    if (window.gpxstudio.version === 2) {
      window.gpxstudio.onVisibilityChange('Strava Heatmap', saveVisibility);
    }

    // Listen for authentication status changes
    setupAuthStatusChangeListener(async (newAuthenticated) => {
      console.log('[StravaHeatmapExt] Authentication status changed:', newAuthenticated);
      authenticated = newAuthenticated;
      await applyOverlays(layerPresets, authenticated, version, athleteId);
    });

    // Listen for layer preset changes
    setupLayerPresetsChangeListener(async (layers) => {
      console.log('[StravaHeatmapExt] Layer presets changed:', layers);
      layerPresets = parseLayerPresets(layers);
      await applyOverlays(layerPresets, authenticated, version, athleteId);
    });
  } catch (error) {
    console.error('[StravaHeatmapExt] Failed to initialize gpx.studio integration:', error);
  }
}

main();
