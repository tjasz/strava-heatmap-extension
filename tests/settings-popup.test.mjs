import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = (await readFile(new URL('../src/background/tabs.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\r?\n/gm, '')
  .replace(/^export /gm, '');

test('settings opens the existing extension page in a popup window', async () => {
  let options;
  const context = vm.createContext({
    browser: {
      runtime: { getURL: (path) => `chrome-extension://test/${path}` },
      windows: { create: async (value) => { options = value; } },
    },
  });
  vm.runInContext(source, context);
  await context.openSettings();
  assert.deepEqual(JSON.parse(JSON.stringify(options)), {
    url: 'chrome-extension://test/src/popups/settings.html',
    type: 'popup', width: 615, height: 770,
  });
});

test('settings propagates window creation failures to the caller', async () => {
  const context = vm.createContext({
    browser: {
      runtime: { getURL: (path) => path },
      windows: { create: async () => { throw new Error('Popup failed'); } },
    },
  });
  vm.runInContext(source, context);
  await assert.rejects(context.openSettings(), /Popup failed/);
});
