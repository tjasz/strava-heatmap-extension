(async function () {
  const initialHash = window.location.hash;
  console.debug('[StravaHeatmapExt] executing content/inject-client.js');

  if (['caltopo.com', 'www.caltopo.com'].includes(window.location.host)) {
    window.addEventListener('message', async (event) => {
      if (event.source !== window || event.origin !== window.location.origin
        || event.data?.type !== 'stravaHeatmapOpenSettings') return;
      try {
        await browser.runtime.sendMessage({ type: 'openSettings' });
      } catch (error) {
        console.error('[StravaHeatmapExt] Error opening heatmap settings:', error);
      }
    });
  }

  function getManifestVersion() {
    try {
      const manifest = browser.runtime.getManifest();
      const manifestVersion = manifest.version;
      console.log(
        `[StravaHeatmapExt] Loaded manifest version ${manifestVersion}`,
        manifest
      );
      return manifestVersion;
    } catch (error) {
      console.error('[StravaHeatmapExt] Error retrieving manifest version:', error);
    }
  }

  async function retrieveLayerPresets() {
    try {
      const layers = await browser.runtime.sendMessage({ type: 'requestLayerPresets' });
      console.log('[StravaHeatmapExt] Layer presets retrieved.', layers);
      return layers;
    } catch (error) {
      console.error('[StravaHeatmapExt] Error retrieving layer presets:', error);
    }
  }

  async function requestCredentials() {
    try {
      // Send message to request credentials
      const authenticated = await browser.runtime.sendMessage({
        type: 'requestCredentials',
      });
      console.log('[StravaHeatmapExt] Credentials requested.', authenticated);
      return authenticated;
    } catch (error) {
      console.error('[StravaHeatmapExt] Error requesting credentials:', error);
    }
  }

  async function retrieveMapSheetMaxSize() {
    try {
      const { mapsheetmaxsize } = await browser.storage.local.get('mapsheetmaxsize');
      if (mapsheetmaxsize === undefined) {
        await browser.storage.local.set({ mapsheetmaxsize: 0 });
        return 0;
      }
      if (!Number.isSafeInteger(mapsheetmaxsize) || mapsheetmaxsize < 0) {
        console.warn('[StravaHeatmapExt] Invalid mapsheetmaxsize; map sheets are disabled.', mapsheetmaxsize);
        return 0;
      }
      return mapsheetmaxsize;
    } catch (error) {
      console.error('[StravaHeatmapExt] Error retrieving map sheet maximum size:', error);
      return 0;
    }
  }

  function injectClientScript(layerPresets, authenticated, manifestVersion, mapSheetMaxSize) {
    try {
      const host = window.location.host === 'www.caltopo.com'
        ? 'caltopo.com'
        : window.location.host;
      const path = `src/clients/${host}/index.js`;
      const script = document.createElement('script');
      script.id = 'strava-heatmap-client';
      script.src = browser.runtime.getURL(path);
      script.type = 'module';
      script.async = false;
      script.dataset.authenticated = authenticated;
      script.dataset.version = manifestVersion;
      script.dataset.layers = layerPresets;
      script.dataset.mapsheetmaxsize = mapSheetMaxSize;
      if (host === 'brouter.de') script.dataset.initialHash = initialHash;
      script.onload = () => {
        // script.remove();
        console.debug('[StravaHeatmapExt] Injected client script.', path);
      };
      script.onerror = () =>
        console.warn('[StravaHeatmapExt] Failed to inject client script', path);

      // Inject the script as early as possible
      (document.head || document.documentElement).append(script);
    } catch (e) {
      console.error('[StravaHeatmapExt] Unexpected error injecting client script:', e);
    }
  }

  function injectClientCSS() {
    try {
      const host = window.location.host === 'www.caltopo.com'
        ? 'caltopo.com'
        : window.location.host;
      const path = `src/clients/${host}/index.css`;
      const href = browser.runtime.getURL(path);

      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = href;
      link.onload = () => {
        console.debug('[StravaHeatmapExt] Injected client CSS.', path);
      };
      link.onerror = () =>
        console.warn('[StravaHeatmapExt] Failed to inject client CSS', path);

      (document.head || document.documentElement).append(link);
    } catch (e) {
      console.error('[StravaHeatmapExt] Unexpected error injecting client CSS:', e);
    }
  }

  const manifestVersion = getManifestVersion();
  const layerPresets = await retrieveLayerPresets();
  const authenticated = await requestCredentials();
  const mapSheetMaxSize = await retrieveMapSheetMaxSize();

  injectClientScript(layerPresets, authenticated, manifestVersion, mapSheetMaxSize);
  injectClientCSS();
})();
