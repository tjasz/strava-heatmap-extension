const GLOBAL_TILES =
  '^https://[^/]+\\.strava\\.com/(identified/globalheat/[^/]+/[^/]+/[0-9]+/[0-9]+/[0-9]+\\.png|weeklyheat/[0-9]+/[0-9]+/[0-9]+)(\\?|$)';
const PERSONAL_TILES =
  '^https://personal-heatmaps-external\\.strava\\.com/tiles/[0-9]+/[^/]+/[0-9]+/[0-9]+/[0-9]+(@2x)?\\.png(\\?|$)';

// Personal tiles carry the login session and the response is readable
// cross-origin, so only the sites the extension runs on may trigger that rule.
const PERSONAL_TILE_INITIATORS = [
  'caltopo.com',
  'openstreetmap.org',
  'gpx.studio',
  'brouter.de',
  'tjasz.github.io',
];

// Personal tiles also need the login session, so only that rule carries it.
export async function updateHeatmapRules(credentials, personalCredentials = credentials) {
  const rules = [
    buildRule(1, GLOBAL_TILES, credentials),
    buildRule(2, PERSONAL_TILES, personalCredentials, PERSONAL_TILE_INITIATORS),
  ];

  await browser.declarativeNetRequest.updateDynamicRules(
    {
      removeRuleIds: Array.from({ length: 10 }, (_, i) => i + 1),
      addRules: rules,
    },
    () => {
      if (browser.runtime.lastError) {
        console.error(
          '[StravaHeatmapExt] Failed to remove heatmap rule.',
          browser.runtime.lastError
        );
      } else {
        console.log('[StravaHeatmapExt] Added heatmap rules.', rules.length, Boolean(credentials));
      }
    }
  );

  return rules;
}

function buildRule(id, regexFilter, credentials, initiatorDomains) {
  const condition = {
    regexFilter,
    resourceTypes: ['image', 'xmlhttprequest'],
    ...(initiatorDomains ? { initiatorDomains } : { excludedInitiatorDomains: ['strava.com'] }),
  };

  return {
    id,
    priority: 1,
    condition,
    action: {
      type: 'modifyHeaders',
      requestHeaders: credentials
        ? [
            {
              header: 'Cookie',
              operation: 'set',
              value: credentials,
            },
          ]
        : undefined,
      responseHeaders: [
        {
          header: 'Access-Control-Allow-Origin',
          operation: 'set',
          value: '*',
        },
        {
          header: 'Access-Control-Expose-Headers',
          operation: 'append',
          value: 'Retry-After',
        },
      ],
    },
  };
}
