import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { fileURLToPath } from 'node:url';

const result = await build({
  entryPoints: [fileURLToPath(new URL('../mobile/src/runtime.js', import.meta.url))],
  bundle: true, write: false, format: 'iife', globalName: 'NativeTest',
  plugins: [{ name: 'native-test-adapter', setup(b) {
    b.onResolve({ filter: /^@(capacitor|capgo)\// }, (args) => ({ path: args.path, namespace: 'mock' }));
    b.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({ contents: `
      export const { Capacitor, CapacitorHttp, registerPlugin, Preferences, CapacitorUpdater,
        App, SplashScreen, Filesystem, Directory, Share } = window.adapters;`, loader: 'js' }));
  } }],
});
const code = result.outputFiles[0].text;
async function harness(saved = {}, options = {}) {
  const dom = new JSDOM('<html><head></head><body></body></html>', { url: 'https://localhost/index.html', runScripts: 'outside-only' });
  const { window } = dom;
  const values = new Map(Object.entries(saved));
  const calls = [], events = {};
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  window.confirm = () => true;
  window.fetch = async () => ({ json: async () => ({ version: 'a'.repeat(64) }) });
  window.adapters = {
    Capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios' },
    CapacitorHttp: { get: async () => { calls.push('network'); throw Error('offline'); } },
    registerPlugin: () => ({ openDevelopment: async ({ url }) => { calls.push(['development', url]); } }),
    Preferences: { get: async ({ key }) => ({ value: values.get(key) ?? null }),
      set: async ({ key, value }) => { values.set(key, value); } },
    CapacitorUpdater: { current: async () => ({ bundle: { id: 'builtin' } }), list: async () => ({ bundles: [] }),
      notifyAppReady: async () => { calls.push('ready'); }, reset: async () => { calls.push('reset'); } },
    App: { addListener: async (name, handler) => { events[name] = handler; }, minimizeApp: () => {} },
    SplashScreen: { hide: async () => { calls.push('splash'); } },
    Filesystem: {}, Directory: { Cache: 'CACHE' }, Share: {},
  };
  window.eval(code);
  if (!options.development) await window.NativeTest.ready;
  else await new Promise((resolve) => setImmediate(resolve));
  return { window, values, calls, events, close: () => window.close() };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('fresh boot defaults to stable and checks releases after readiness without a URL dialog', async (t) => {
  const h = await harness(); t.after(h.close);
  assert.deepEqual(h.calls, []);
  await h.window.LinguaNative.markReady(); await flush();
  assert.deepEqual(h.calls, ['ready', 'splash', 'network']);
  assert.equal(h.window.document.querySelector('dialog'), null);
  assert.equal(h.window.LinguaNative.channel, 'stable');
  h.window.LinguaNative.settings();
  const dialog = h.window.document.querySelector('dialog');
  assert.match(dialog.textContent, /开发人员选项/);
  assert.equal(dialog.querySelectorAll('option').length, 4);
  assert.equal(dialog.querySelector('input').parentNode.hidden, true);
});
test('offline configured own branch loads local application and leaves a recoverable status', async (t) => {
  const ownUrl = 'https://site.example/';
  const source = { channel: 'own', ownUrl, developmentUrl: '' };
  const h = await harness({ 'lingua.channel': 'own', 'lingua.own-url': ownUrl,
    'lingua.native.state': JSON.stringify({ source }) }); t.after(h.close);
  assert.deepEqual(h.calls, []); assert.equal(h.window.LinguaNative.target, ownUrl);
  await h.window.LinguaNative.markReady(); await flush();
  assert.deepEqual(h.calls, ['ready', 'splash', 'network']);
  h.window.LinguaNative.settings();
  assert.match(h.window.document.querySelector('[data-native-status]').textContent, /继续使用本地版本.*offline/);
  assert.ok(!h.calls.includes('reset'));
});
test('changing channel clears pending and implicit backend token while retaining user model configuration', async (t) => {
  const h = await harness(); t.after(h.close);
  h.window.localStorage.setItem('linguatrack.config.v1', JSON.stringify({ apiBase: '', apiToken: 'old-secret', apiKey: 'llm-key' }));
  h.window.LinguaNative.settings();
  const dialog = h.window.document.querySelector('dialog');
  const select = dialog.querySelector('select'); select.value = 'own'; select.dispatchEvent(new h.window.Event('change'));
  const input = dialog.querySelector('input'); input.value = 'https://new.example/'; input.dispatchEvent(new h.window.Event('input'));
  dialog.querySelector('button').click(); await flush();
  const config = JSON.parse(h.window.localStorage.getItem('linguatrack.config.v1'));
  assert.equal(config.apiToken, ''); assert.equal(config.apiKey, 'llm-key');
  assert.equal(h.values.get('lingua.channel'), 'own');
  assert.equal(h.values.get('lingua.own-url'), 'https://new.example/');
  assert.equal(JSON.parse(h.values.get('lingua.native.state')).pending, null);
  assert.ok(h.calls.includes('reset'));
});
test('development gate opens remote native view without local entry, updater or network checks', async (t) => {
  const url = 'http://192.168.1.2:5173/player.html?debug=1#test';
  const h = await harness({ 'lingua.channel': 'development', 'lingua.development-url': url }, { development: true });
  t.after(h.close);
  assert.deepEqual(h.calls, [['development', url]]);
  assert.equal(h.window.LinguaNative, undefined);
});
test('legacy target migrates to own channel without a first-run popup', async (t) => {
  const h = await harness({ 'lingua.target': 'https://legacy.example/' }); t.after(h.close);
  assert.equal(h.values.get('lingua.channel'), 'own');
  assert.equal(h.window.LinguaNative.target, 'https://legacy.example/');
  await h.window.LinguaNative.markReady();
  assert.equal(h.window.document.querySelector('dialog'), null);
});
