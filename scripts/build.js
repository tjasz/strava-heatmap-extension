const fs = require('fs');
const path = require('path');
const { program } = require('commander');
const AdmZip = require('adm-zip');

const DIST = path.join(process.cwd(), 'dist');
const MANIFEST = 'manifest.json';
const FOLDERS = ['icons', 'lib', 'src'];

program.option('--caltopo-only', 'Build only the CalTopo client and its dependencies');
program.parse(process.argv);
const { caltopoOnly } = program.opts();

function getCalTopoManifest(manifest) {
  const excludedMatches = new Set([
    '*://www.openstreetmap.org/*',
    '*://www.openstreetmap.org/id*',
    '*://gpx.studio/*',
    '*://gpx.studio/app*',
    '*://gpx.studio/*/app*',
    "*://tjasz.github.io/*",
    "*://brouter.de/*",
  ]);
  const filterMatches = (entries) => entries
    .map((entry) => ({
      ...entry,
      matches: entry.matches.filter((match) => !excludedMatches.has(match)),
    }))
    .filter((entry) => entry.matches.length > 0);

  return {
    ...manifest,
    description: 'Overlay Strava Global Heatmap in CalTopo to reveal popular routes and patterns.',
    host_permissions: manifest.host_permissions.filter((match) => !excludedMatches.has(match)),
    content_scripts: filterMatches(manifest.content_scripts),
    web_accessible_resources: filterMatches(manifest.web_accessible_resources).map((entry) => ({
      ...entry,
      resources: entry.resources.filter((resource) => resource !== 'src/clients/common/hash.js'),
    })),
  };
}

// Function to create a zip file
function createZip(zipFileName, manifest) {
  const zip = new AdmZip();
  zip.addFile(MANIFEST, Buffer.from(JSON.stringify(manifest, null, 2)));

  if (caltopoOnly) {
    const folders = ['src/about', 'src/background', 'src/content', 'src/popups'];
    const files = new Set([
      'src/extension.js',
      'lib/browser-polyfill.min.js',
      'lib/sortablejs@1.15.0.esm.min.js',
      'icons/icon-48.png',
      'icons/icon-48-grayscale.png',
      'icons/icon-128.png',
      'icons/icon-128-grayscale.png',
      ...manifest.web_accessible_resources.flatMap((entry) => entry.resources),
    ]);
    for (const folder of folders) {
      zip.addLocalFolder(path.join(process.cwd(), folder), folder);
    }
    for (const file of files) {
      zip.addLocalFile(path.join(process.cwd(), file), path.posix.dirname(file));
    }
  } else {
    for (const folder of FOLDERS) {
      zip.addLocalFolder(path.join(process.cwd(), folder), folder);
    }
  }
  zip.writeZip(path.join(DIST, zipFileName));
}

// Function to remove [DEV] suffix from name if present
function getProductionName(name) {
  return name.replace(/\s*\[DEV\]\s*$/, '').trim();
}

// Read the original manifest file
const originalManifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf-8'));
const manifest = caltopoOnly ? getCalTopoManifest(originalManifest) : originalManifest;
const { version } = manifest;

// Generate zip filenames
const buildName = `${version}${caltopoOnly ? '-caltopo-only' : ''}`;
const chromeZip = `${buildName}-chrome.zip`;
const firefoxZip = `${buildName}-firefox.zip`;
const chromeUnzipped = path.join(DIST, `${buildName}-chrome`);

// make sure dist folder exists, if not create it
if (!fs.existsSync(DIST)) {
  fs.mkdirSync(DIST);
}

// Remove existing zips (force by default)
if (fs.existsSync(path.join(DIST, chromeZip))) {
  fs.rmSync(path.join(DIST, chromeZip));
}

if (fs.existsSync(path.join(DIST, firefoxZip))) {
  fs.rmSync(path.join(DIST, firefoxZip));
}

// Remove existing unzipped Chrome folder
if (fs.existsSync(chromeUnzipped)) {
  fs.rmSync(chromeUnzipped, { recursive: true, force: true });
}

// Create Chrome build (remove [DEV] from name)
const manifestChrome = {
  ...manifest,
  name: getProductionName(manifest.name),
};
createZip(chromeZip, manifestChrome);

// Create Firefox build (remove [DEV] from name)
const manifestFirefox = Object.fromEntries(
  Object.entries({
    ...manifest,
    ...JSON.parse(fs.readFileSync('manifest-firefox.json', 'utf-8')),
  }).filter(([, value]) => value !== null)
);
manifestFirefox.name = getProductionName(manifest.name);
createZip(firefoxZip, manifestFirefox);

// Unzip Chrome version
new AdmZip(path.join(DIST, chromeZip)).extractAllTo(chromeUnzipped, true);

console.log(`Chrome and Firefox v${version} builds created successfully!`);
console.log(`Chrome build unzipped to: dist/${buildName}-chrome`);
