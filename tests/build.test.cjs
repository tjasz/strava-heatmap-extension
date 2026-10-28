const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
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

test('CalTopo-only packages retain their dependencies without other client integrations', async (t) => {
  const repository = path.resolve(__dirname, '..');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'heatmap caltopo build '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const entry of ['manifest.json', 'manifest-firefox.json', 'icons', 'lib', 'src']) {
    fs.cpSync(path.join(repository, entry), path.join(root, entry), { recursive: true });
  }
  const original = fs.readFileSync(path.join(root, 'manifest.json'), 'utf8');
  const manifest = JSON.parse(original);
  const version = manifest.version;
  const dist = path.join(root, 'dist');
  fs.mkdirSync(dist);
  const fullBuild = path.join(dist, `${version}-chrome.zip`);
  fs.writeFileSync(fullBuild, 'existing full build');
  const build = () => execFileSync(
    process.execPath,
    [path.join(repository, 'scripts', 'build.js'), '--caltopo-only'],
    { cwd: root, env: { ...process.env, PATH: path.dirname(process.execPath) } }
  );
  assert.match(build().toString(), /builds created successfully/);
  const sharedSlideFiles = ['algorithm.js', 'png.js', 'tiles.js']
    .map((file) => `src/clients/www.openstreetmap.org/slide/${file}`);
  const clientFiles = [
    'src/clients/caltopo.com/index.js',
    'src/clients/caltopo.com/index.css',
    'src/clients/caltopo.com/snap.js',
    ...['auth.js', 'colors.js', 'colors.css', 'layers.js', 'palettes.js']
      .map((file) => `src/clients/common/${file}`),
    ...sharedSlideFiles,
  ];
  let chromeManifest;
  for (const browser of ['chrome', 'firefox']) {
    const zip = new AdmZip(path.join(dist, `${version}-caltopo-only-${browser}.zip`));
    const built = JSON.parse(zip.readAsText('manifest.json'));
    assert.equal(built.name, manifest.name.replace(/\s*\[DEV\]\s*$/, '').trim());
    assert.equal(built.description, 'Overlay Strava Global Heatmap in CalTopo to reveal popular routes and patterns.');
    assert.deepEqual(built.host_permissions, [
      '*://www.strava.com/*', '*://content-a.strava.com/*',
      '*://caltopo.com/*', '*://www.caltopo.com/*',
    ]);
    assert.deepEqual(built.content_scripts, manifest.content_scripts.filter(
      (entry) => !entry.matches.some((match) => /openstreetmap|gpx\.studio/.test(match))
    ));
    assert.deepEqual(built.web_accessible_resources, manifest.web_accessible_resources
      .filter((entry) => entry.matches.includes('*://caltopo.com/*'))
      .map((entry) => ({
        ...entry,
        matches: ['*://caltopo.com/*', '*://www.caltopo.com/*'],
        resources: entry.resources.filter((file) => file !== 'src/clients/common/hash.js'),
      })));
    if (browser === 'chrome') {
      assert.deepEqual(built.background, manifest.background);
      chromeManifest = built;
    } else {
      const firefox = JSON.parse(fs.readFileSync(path.join(root, 'manifest-firefox.json'), 'utf8'));
      assert.deepEqual(built.background, firefox.background);
      assert.deepEqual(built.browser_specific_settings, firefox.browser_specific_settings);
      assert.equal('minimum_chrome_version' in built, false);
    }
    const entries = zip.getEntries().filter((entry) => !entry.isDirectory);
    const names = entries.map((entry) => entry.entryName);
    assert.deepEqual(names.filter((file) => file.startsWith('src/clients/')).sort(), clientFiles.sort());
    assert.equal(names.includes('icons/slide.svg'), false);
    for (const file of [
      ...clientFiles,
      'src/background/index.js', 'src/background/permissions.js', 'src/extension.js',
      'src/about/index.html', 'src/about/index.js', 'src/about/index.css',
      'src/popups/settings.html', 'src/popups/settings.js', 'src/popups/settings.css',
      'lib/browser-polyfill.min.js', 'lib/sortablejs@1.15.0.esm.min.js',
      'icons/icon-48.png', 'icons/icon-48-grayscale.png',
      'icons/icon-128.png', 'icons/icon-128-grayscale.png',
      ...built.content_scripts.flatMap((entry) => entry.js),
    ]) {
      assert.ok(zip.getEntry(file), `missing ${file}`);
      assert.deepEqual(zip.readFile(file), fs.readFileSync(path.join(root, file)));
    }
    // Check static imports and local HTML/CSS references against the actual archive.
    for (const entry of entries.filter((entry) => /\.(js|html|css)$/.test(entry.entryName))) {
      const source = zip.readAsText(entry);
      const references = source.matchAll(/(?:\bfrom\s*|\bimport\s*|@import\s+url\(\s*|\b(?:src|href)=)["'](\.[^"']+)["']/g);
      for (const [, reference] of references) {
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(entry.entryName), reference));
        assert.ok(zip.getEntry(target), `${entry.entryName} needs ${target}`);
      }
    }
  }
  const unpacked = path.join(dist, `${version}-caltopo-only-chrome`);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(unpacked, 'manifest.json'), 'utf8')), chromeManifest);
  fs.writeFileSync(path.join(unpacked, 'stale.js'), 'stale');
  build();
  assert.equal(fs.existsSync(path.join(unpacked, 'stale.js')), false);
  assert.equal(fs.readFileSync(fullBuild, 'utf8'), 'existing full build');
  assert.equal(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'), original);
  assert.deepEqual(fs.readdirSync(dist).sort(), [
    `${version}-caltopo-only-chrome`, `${version}-caltopo-only-chrome.zip`,
    `${version}-caltopo-only-firefox.zip`, `${version}-chrome.zip`,
  ].sort());

  const previousBrowser = globalThis.browser;
  t.after(() => {
    if (previousBrowser === undefined) delete globalThis.browser;
    else globalThis.browser = previousBrowser;
  });
  for (const [variant, built] of [['full', manifest], ['caltopo', chromeManifest]]) {
    let granted = true;
    const notifications = [];
    globalThis.browser = {
      runtime: { getManifest: () => built },
      permissions: {
        contains: async ({ origins }) => {
          assert.deepEqual(origins, built.host_permissions);
          return granted;
        },
      },
      notifications: { create: async (options) => notifications.push(options) },
    };
    const url = pathToFileURL(path.join(repository, 'src', 'background', 'permissions.js'));
    const { checkPermissions } = await import(`${url.href}?build-test=${variant}`);
    assert.equal(await checkPermissions(), true);
    assert.equal(notifications.length, 0);
    granted = false;
    assert.equal(await checkPermissions(), false);
    assert.equal(notifications.length, 1);
  }
});
