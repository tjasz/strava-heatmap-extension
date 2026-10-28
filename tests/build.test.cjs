const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const AdmZip = require('adm-zip');

test('builds both packages and replaces unpacked output without shell tools', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'heatmap build '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manifest = {
    manifest_version: 3,
    name: 'Strava Heatmap [DEV]',
    version: '0.14.0',
    minimum_chrome_version: '88',
    background: { service_worker: 'src/background/index.js', type: 'module' },
  };
  const firefox = {
    background: { scripts: ['src/background/index.js'], type: 'module' },
    browser_specific_settings: { gecko: { id: 'test@example.com' } },
    minimum_chrome_version: null,
  };
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(root, 'manifest-firefox.json'), JSON.stringify(firefox));
  const files = {
    'icons/icon.png': Buffer.from([0, 1, 128, 255]),
    'lib/library.js': Buffer.from('/* library */'),
    'src/background/index.js': Buffer.from('/* background */'),
    'src/clients/common/colors.css': Buffer.from('/* palette filters */'),
  };
  for (const [file, contents] of Object.entries(files)) {
    const destination = path.join(root, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, contents);
  }

  const build = () => execFileSync(
    process.execPath,
    [path.resolve(__dirname, '..', 'scripts', 'build.js')],
    { cwd: root, env: { ...process.env, PATH: path.dirname(process.execPath) } }
  );
  assert.match(build().toString(), /builds created successfully/);
  const dist = path.join(root, 'dist');
  const unpacked = path.join(dist, '0.14.0-chrome');
  const chromeManifest = { ...manifest, name: 'Strava Heatmap' };
  for (const browser of ['chrome', 'firefox']) {
    const zip = new AdmZip(path.join(dist, `0.14.0-${browser}.zip`));
    const expectedManifest = browser === 'chrome' ? chromeManifest : {
      ...chromeManifest,
      background: firefox.background,
      browser_specific_settings: firefox.browser_specific_settings,
    };
    if (browser === 'firefox') delete expectedManifest.minimum_chrome_version;
    assert.deepEqual(JSON.parse(zip.readAsText('manifest.json')), expectedManifest);
    assert.deepEqual(
      zip.getEntries().filter((entry) => !entry.isDirectory).map((entry) => entry.entryName).sort(),
      ['manifest.json', ...Object.keys(files)].sort()
    );
    for (const [file, contents] of Object.entries(files)) {
      assert.deepEqual(zip.readFile(file), contents);
    }
  }
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(unpacked, 'manifest.json'), 'utf8')),
    chromeManifest
  );
  for (const [file, contents] of Object.entries(files)) {
    assert.deepEqual(fs.readFileSync(path.join(unpacked, file)), contents);
  }
  assert.equal(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'), JSON.stringify(manifest));
  assert.deepEqual(fs.readdirSync(dist).sort(), [
    '0.14.0-chrome', '0.14.0-chrome.zip', '0.14.0-firefox.zip',
  ]);

  fs.writeFileSync(path.join(unpacked, 'stale.js'), 'stale');
  fs.unlinkSync(path.join(root, 'lib', 'library.js'));
  build();
  assert.equal(fs.existsSync(path.join(unpacked, 'stale.js')), false);
  assert.equal(fs.existsSync(path.join(unpacked, 'lib', 'library.js')), false);
  for (const browser of ['chrome', 'firefox']) {
    const zip = new AdmZip(path.join(dist, `0.14.0-${browser}.zip`));
    assert.equal(zip.getEntry('lib/library.js'), null);
  }
});
