const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(
  path.resolve(__dirname, '..', 'src', 'about', 'index.js'), 'utf8'
).replace("import { getExtensionName } from '../extension.js';", '');

function createElement(tagName) {
  return {
    tagName,
    dataset: {},
    textContent: '',
    children: [],
    appendChild(child) { this.children.push(child); },
    set innerHTML(value) { assert.fail(`Unexpected HTML assignment: ${value}`); },
  };
}

for (const [reason, expected] of [
  ['install', 'Welcome to the extension!'],
  ['update', 'Successfully updated!'],
  ['', ''],
  ['unknown', ''],
  ['toString', ''],
]) {
  test(`About page safely renders message for reason ${JSON.stringify(reason)}`, () => {
    const elements = Object.fromEntries(
      ['page-title', 'page-heading', 'message'].map((id) => [id, createElement('div')])
    );
    const links = Object.fromEntries(
      ['a[href*="#readme"]', 'a[href*="#changelog"]', '.actions a[href="#rate"]']
        .map((selector) => [selector, createElement('a')])
    );
    const version = '<img src=x onerror=alert(1)>';
    let onReady;
    vm.runInNewContext(source, {
      getExtensionName: () => 'Strava Heatmap',
      browser: { runtime: { getManifest: () => ({ version }) } },
      navigator: { userAgent: 'Firefox' },
      window: { location: { search: `?reason=${reason}` } },
      URLSearchParams,
      document: {
        addEventListener(event, callback) {
          assert.equal(event, 'DOMContentLoaded');
          onReady = callback;
        },
        getElementById: (id) => elements[id],
        querySelector: (selector) => links[selector],
        createElement,
      },
    });
    onReady();
    assert.equal(elements['page-title'].textContent, 'Strava Heatmap');
    assert.equal(elements['page-heading'].textContent, 'Strava Heatmap');
    assert.equal(elements.message.textContent, expected);
    assert.equal(elements.message.children.length, 1);
    const versionElement = elements.message.children[0];
    assert.equal(versionElement.tagName, 'div');
    assert.equal(versionElement.className, 'version');
    assert.equal(versionElement.textContent, `v${version}`);
    assert.equal(versionElement.children.length, 0);
    assert.equal(links['a[href*="#readme"]'].href,
      `https://github.com/tjasz/strava-heatmap-extension/blob/v${version}/README.md`);
    assert.equal(links['a[href*="#changelog"]'].href,
      `https://github.com/tjasz/strava-heatmap-extension/blob/v${version}/CHANGELOG.md`);
    assert.equal(links['.actions a[href="#rate"]'].href,
      'https://addons.mozilla.org/en-US/firefox/addon/strava-heatmap-for-caltopo/reviews/');
  });
}
