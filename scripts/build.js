const fs = require('fs');
const path = require('path');
const { program } = require('commander');
const AdmZip = require('adm-zip');

const DIST = path.join(process.cwd(), 'dist');
const MANIFEST = 'manifest.json';
const FOLDERS = ['icons', 'lib', 'src'];

// Function to create a zip file
function createZip(zipFileName, manifest) {
  const zip = new AdmZip();
  zip.addFile(MANIFEST, Buffer.from(JSON.stringify(manifest, null, 2)));

  for (const folder of FOLDERS) {
    zip.addLocalFolder(path.join(process.cwd(), folder), folder);
  }
  zip.writeZip(path.join(DIST, zipFileName));
}

// Function to remove [DEV] suffix from name if present
function getProductionName(name) {
  return name.replace(/\s*\[DEV\]\s*$/, '').trim();
}

// Read the original manifest file
const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf-8'));
const { version } = manifest;

// Generate zip filenames
const chromeZip = `${version}-chrome.zip`;
const firefoxZip = `${version}-firefox.zip`;
const chromeUnzipped = path.join(DIST, `${version}-chrome`);

// Set up the CLI options (kept for future options)
program.parse(process.argv);

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
console.log(`Chrome build unzipped to: dist/${version}-chrome`);
