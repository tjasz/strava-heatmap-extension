(async function () {
  console.debug('[StravaHeatmapExt] Setting up tile error watcher...');

  let lastErrorTime = 0;
  const COOLDOWN = 10000; // 10 seconds

  async function revalidateCredentials(status) {
    const now = Date.now();
    if (now - lastErrorTime < COOLDOWN) return;
    lastErrorTime = now;
    console.log('[StravaHeatmapExt] Auth or network error detected:', status);
    try {
      await browser.runtime.sendMessage({ type: 'requestCredentials' });
      console.log('[StravaHeatmapExt] Credentials re-validated, fallback tiles will load');
    } catch (error) {
      console.error('[StravaHeatmapExt] Error handling tile failure:', error);
    }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.type !== 'stravaHeatmapTileError') return;
    const status = event.data.status;
    if (status === 401 || status === 403) revalidateCredentials(status);
  });

  // Fetch the image to check status code
  async function checkTileStatus(url) {
    try {
      const response = await fetch(url, { method: 'HEAD' });
      return response.status;
    } catch (error) {
      // Catch CORS/ORB/network errors
      console.debug('[StravaHeatmapExt] Fetch error (likely CORS/ORB):', error.message);
      return 'NETWORK_ERROR';
    }
  }

  // Listen for failed image loads
  document.addEventListener(
    'error',
    async (event) => {
      const target = event.target;

      // Weekly requests report their actual status through the shared loader.
      if (target.tagName === 'IMG' && target.src?.includes('strava.com/weeklyheat/')) return;

      // Check if it's a Strava heatmap tile
      if (
        target.tagName === 'IMG' &&
        target.src &&
        (target.src.includes('strava.com/identified/globalheat/') ||
          target.src.includes('strava.com/weeklyheat/'))
      ) {
        const now = Date.now();

        // Throttle error handling
        if (now - lastErrorTime < COOLDOWN) {
          return;
        }

        console.log('[StravaHeatmapExt] Strava tile failed to load:', target.src);

        // Check the actual status code
        const status = await checkTileStatus(target.src);
        console.log('[StravaHeatmapExt] Tile status:', status);

        // Trigger on auth errors (403, 401) OR network/CORS errors
        if (status === 403 || status === 401 || status === 'NETWORK_ERROR') {
          await revalidateCredentials(status);
        } else if (status === 404) {
          console.debug('[StravaHeatmapExt] Tile not found (404), ignoring');
        }
      }
    },
    true // Use capture phase to catch all errors
  );

  console.log('[StravaHeatmapExt] Tile error watcher active');
})();
