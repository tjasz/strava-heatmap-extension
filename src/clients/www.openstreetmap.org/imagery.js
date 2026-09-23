import { getLayerConfigs } from '../common/layers.js';
import {
  restoreOverlays,
  bindOverlaysShortcuts,
  getDefaultOverlaysHash,
} from './overlays.js';

export async function applyImagery(context, layerPresets, authenticated, version) {
  const stravaConfigs = getLayerConfigs(layerPresets, authenticated, version);
  const background = context.background();
  const imagery = await background.ensureLoaded();

  // remember layer selection
  const defaultOverlaysHash = getDefaultOverlaysHash();

  // toggle off all layers
  background
    .overlayLayerSources()
    .forEach((layer) => background.toggleOverlayLayer(layer));

  // remove all strava heatmap layers from background sources array
  imagery.backgrounds = imagery.backgrounds.filter(
    (b) => !b.id.startsWith('strava-heatmap-')
  );

  // re-add configured strava heatmap layers
  stravaConfigs.forEach((config) => {
    const source = iD.rendererBackgroundSource({
      ...config,
      overlay: true,
      terms_url:
        'https://wiki.openstreetmap.org/wiki/Strava#Data_Permission_-_Allowed_for_tracing!',
    });
    preserveGradientFragment(source, config.template);
    imagery.backgrounds.push(source);
  });

  // update background sources
  await background.init();

  // rebuild UI
  if (!context.history().hasRestorableChanges()) {
    await context.ui().restart();
    // restart() clears keybindings and kicks off an async re-render without
    // awaiting it; wait for it to finish so our re-bind below isn't racing it
    await context.ui().ensureLoaded();
  }

  // re-toggle selected overlays
  restoreOverlays(background, defaultOverlaysHash);

  // ensure overlay shortcuts are re-binded
  bindOverlaysShortcuts(context);

  console.log(
    `[StravaHeatmapExt] Updated iD imagery with Strava layer configs`,
    stravaConfigs
  );
}

function preserveGradientFragment(source, template) {
  const fragmentIndex = template.indexOf('#strava-gradient=');
  if (fragmentIndex === -1) return;

  const gradientFragment = template.slice(fragmentIndex);
  const getTileUrl = source.url;
  source.url = function (coord) {
    const url = getTileUrl.call(this, coord);
    return url && !url.includes('#strava-gradient=')
      ? `${url}${gradientFragment}`
      : url;
  };
}
