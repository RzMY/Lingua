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
      export const { Capacitor, CapacitorHttp, registerPlugin, SystemBars, SystemBarType, Preferences, CapacitorUpdater,
        App, SplashScreen, Filesystem, Directory, Share } = window.adapters;`, loader: 'js' }));
  } }],
});
const code = result.outputFiles[0].text;
async function harness(saved = {}, options = {}) {
  const dom = new JSDOM('<html><head></head><body></body></html>', { url: 'https://localhost/index.html', runScripts: 'outside-only' });
  const { window } = dom;
  const values = new Map(Object.entries(saved));
  const calls = [], events = {}, presentations = [], systemBars = [], exports = new Map(), shares = [];
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  window.confirm = () => true;
  window.fetch = async () => ({ json: async () => ({ version: 'a'.repeat(64) }) });
  window.adapters = {
    Capacitor: { isNativePlatform: () => true, getPlatform: () => options.platform || 'ios' },
    CapacitorHttp: { get: async () => { calls.push('network'); throw Error('offline'); } },
    SystemBars: {
      hide: async (options) => { systemBars.push({ action: 'hide', ...options }); },
      show: async (options) => { systemBars.push({ action: 'show', ...options }); },
    },
    SystemBarType: { NavigationBar: 'NavigationBar' },
    registerPlugin: () => ({ openDevelopment: async ({ url }) => { calls.push(['development', url]); },
      setPresentation: async (value) => { presentations.push({ ...value }); }, addListener: async () => {} }),
    Preferences: { get: async ({ key }) => ({ value: values.get(key) ?? null }),
      set: async ({ key, value }) => { values.set(key, value); } },
    CapacitorUpdater: { current: async () => ({ bundle: { id: 'builtin' } }), list: async () => ({ bundles: [] }),
      notifyAppReady: async () => { calls.push('ready'); }, reset: async () => { calls.push('reset'); } },
    App: { addListener: async (name, handler) => { events[name] = handler; }, minimizeApp: () => { calls.push('minimize'); } },
    SplashScreen: { hide: async () => { calls.push('splash'); } },
    Filesystem: {
      readdir: async () => ({ files: [...exports].map(([path, value]) => ({ name: path.slice(8), ...value })) }),
      writeFile: async ({ path, data }) => { exports.set(path, { data, type: 'file', mtime: Date.now() }); return { uri: 'file:///' + path }; },
      deleteFile: async ({ path }) => { exports.delete(path); },
    }, Directory: { Cache: 'CACHE' }, Share: { share: async (value) => { shares.push(value); } },
  };
  window.eval(code);
  if (!options.development) await window.NativeTest.ready;
  else await new Promise((resolve) => setImmediate(resolve));
  return { window, values, calls, events, presentations, systemBars, exports, shares, close: () => window.close() };
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

test('iOS system presentation follows immersion, theme, navigation and foreground restoration', async (t) => {
  const h = await harness(); t.after(h.close);
  const root = h.window.document.documentElement;
  assert.deepEqual(h.presentations.at(-1), { immersive: false, dark: false });
  root.classList.add('video-immersive'); await flush();
  assert.deepEqual(h.presentations.at(-1), { immersive: true, dark: false });
  const count = h.presentations.length;
  root.classList.add('sheet-open'); await flush();
  assert.equal(h.presentations.length, count, 'unrelated overlay state must not relayout UIKit');
  root.dataset.theme = 'dark'; await flush();
  assert.deepEqual(h.presentations.at(-1), { immersive: true, dark: true });
  h.window.dispatchEvent(new h.window.Event('pagehide'));
  assert.deepEqual(h.presentations.at(-1), { immersive: false, dark: true });
  h.window.dispatchEvent(new h.window.Event('pageshow'));
  assert.deepEqual(h.presentations.at(-1), { immersive: true, dark: true });
  root.classList.remove('video-immersive'); await flush();
  await h.events.appStateChange({ isActive: true });
  assert.deepEqual(h.presentations.at(-1), { immersive: false, dark: true });
  assert.deepEqual(h.systemBars, h.presentations.map(({ immersive }) => ({
    action: immersive ? 'hide' : 'show', bar: 'NavigationBar',
  })), 'Home indicator must follow native presentation through the built-in SystemBars plugin');
});

test('Android back closes topmost overlays and lets the player exit manual fullscreen first', async (t) => {
  const h = await harness({}, { platform: 'android' }); t.after(h.close);
  const doc = h.window.document;
  doc.body.innerHTML = '<div class="wc-scrim is-open"></div><div class="sheet is-open"><div class="sheet-acts"><button aria-label="关闭"></button></div></div>';
  const card = doc.querySelector('.wc-scrim'), sheet = doc.querySelector('.sheet');
  card.onclick = () => card.remove();
  sheet.querySelector('button').onclick = () => sheet.remove();
  h.events.backButton({ canGoBack: false });
  assert.equal(card.isConnected, false); assert.equal(sheet.isConnected, true);
  h.events.backButton({ canGoBack: false });
  assert.equal(sheet.isConnected, false);
  h.window.addEventListener('native-back', (e) => e.preventDefault(), { once: true });
  h.events.backButton({ canGoBack: false });
  assert.equal(h.calls.includes('minimize'), false);
  h.events.backButton({ canGoBack: false });
  assert.equal(h.calls.includes('minimize'), true);
  assert.equal(h.presentations.length, 0);
  assert.equal(h.systemBars.length, 0);
});

test('Android exports survive chooser completion, use unique paths and remove expired cache files', async (t) => {
  const h = await harness({}, { platform: 'android' }); t.after(h.close);
  h.exports.set('exports/old.json', { type: 'file', mtime: Date.now() - 86400001 });
  const blob = new h.window.Blob(['backup'], { type: 'application/json' });
  await h.window.LinguaNative.exportFile(blob, '学习记录.json');
  await h.window.LinguaNative.exportFile(blob, '学习记录.json');
  assert.equal(h.exports.has('exports/old.json'), false);
  assert.equal(h.exports.size, 2);
  for (const share of h.shares) assert.ok(h.exports.has(share.files[0].slice('file:///'.length)));
});

test('iOS exports are removed after the sharing activity completes', async (t) => {
  const h = await harness(); t.after(h.close);
  await h.window.LinguaNative.exportFile(new h.window.Blob(['backup']), 'backup.json');
  assert.equal(h.shares.length, 1); assert.equal(h.exports.size, 0);
});
