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
  window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new window.Event('close')); };
  window.confirm = () => true;
  for (const [key, value] of Object.entries(options.session || {})) window.sessionStorage.setItem(key, value);
  window.fetch = async () => ({ json: async () => ({ version: 'a'.repeat(64) }) });
  window.adapters = {
    Capacitor: { isNativePlatform: () => true, getPlatform: () => options.platform || 'ios',
      isPluginAvailable: (name) => (name === 'CaptionPip' && !!options.captionPip) || (name === 'AudioPlayer' && !!options.audioPlayer) },
    CapacitorHttp: { get: async () => { calls.push('network'); if (options.response) return options.response(); throw Error('offline'); } },
    SystemBars: {
      hide: async (options) => { systemBars.push({ action: 'hide', ...options }); },
      show: async (options) => { systemBars.push({ action: 'show', ...options }); },
    },
    SystemBarType: { NavigationBar: 'NavigationBar' },
    registerPlugin: (name) => name === 'AudioPlayer' && options.audioPlayer ? options.audioPlayer
      : name === 'CaptionPip' && options.captionPip ? options.captionPip : ({ openDevelopment: async ({ url }) => { calls.push(['development', url]); },
      setPresentation: async (value) => { presentations.push({ ...value }); }, addListener: async () => {} }),
    Preferences: { get: async ({ key }) => ({ value: values.get(key) ?? null }),
      set: async ({ key, value }) => { values.set(key, value); } },
    CapacitorUpdater: { current: async () => ({ bundle: { id: 'builtin' } }), list: async () => ({ bundles: [] }),
      ...options.updater,
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
const ownSource = { channel: 'own', ownUrl: 'https://site.example/', developmentUrl: '' };
const ownSaved = { 'lingua.channel': 'own', 'lingua.own-url': ownSource.ownUrl,
  'lingua.native.state': JSON.stringify({ source: ownSource, pending: null }) };
const updateManifest = { schema: 1, appId: 'app.linguatrack.mobile', nativeRevision: 3,
  version: 'b'.repeat(64), checksum: 'c'.repeat(64), bundle: `bundle-${'b'.repeat(64)}.zip`, size: 100 };
const updateResponse = async () => ({ status: 200, data: updateManifest });
const clickText = (h, text) => [...h.window.document.querySelectorAll('button')].find((b) => b.textContent === text).click();

test('native audio is independent of PiP support and forwards native events to the player', async (t) => {
  let listener;
  const bridge = { addListener: async (name, handler) => { assert.equal(name, 'stateChanged'); listener = handler; } };
  const h = await harness({}, { audioPlayer: bridge }); t.after(h.close);
  assert.ok(h.window.LinguaNative.audioPlayer); assert.equal(h.window.LinguaNative.captionPip, null);
  let received;
  h.window.addEventListener('native-audio-state', ({ detail }) => { received = detail; });
  listener({ session: 'lesson', position: 15, paused: false });
  assert.equal(received.position, 15); assert.equal(received.paused, false);
  const browser = await harness({}, { platform: 'android', audioPlayer: bridge }); t.after(browser.close);
  assert.equal(browser.window.LinguaNative.audioPlayer, null);
});

test('caption PiP is exposed only by an iOS binary reporting native support', async (t) => {
  for (const [platform, available, supported] of [['ios', true, true], ['ios', true, false], ['ios', false, false], ['android', true, true]]) {
    let listener, probes = 0;
    const bridge = { capabilities: async () => { probes++; return { supported }; },
      addListener: async (name, handler) => { assert.equal(name, 'stateChanged'); listener = handler; } };
    const h = await harness({}, { platform, captionPip: available ? bridge : null }); t.after(h.close);
    const exposed = platform === 'ios' && available && supported;
    assert.equal(!!h.window.LinguaNative.captionPip, exposed);
    assert.equal(probes, platform === 'ios' && available ? 1 : 0);
    if (exposed) {
      let event;
      h.window.addEventListener('native-caption-pip', (value) => { event = value.detail; });
      listener({ active: true, session: 'lesson' });
      assert.equal(event.session, 'lesson'); assert.equal(event.active, true);
    }
  }
});

test('failed native capability detection leaves the player usable with its caption entry hidden', async (t) => {
  const h = await harness({}, { captionPip: { addListener: async () => {}, capabilities: async () => { throw Error('unsupported'); } } }); t.after(h.close);
  assert.equal(h.window.LinguaNative.captionPip, null);
  await h.window.LinguaNative.markReady();
  assert.ok(h.calls.includes('ready'));
});

test('foreground and playback probes can enable a temporarily unavailable native caption entry', async (t) => {
  let supported = false, events = 0;
  const h = await harness({}, { captionPip: { addListener: async () => {}, capabilities: async () => ({ supported }) } }); t.after(h.close);
  assert.equal(h.window.LinguaNative.captionPip, null);
  h.window.addEventListener('native-caption-capabilities', () => events++);
  supported = true;
  await h.window.LinguaNative.refreshCaptionPip();
  assert.ok(h.window.LinguaNative.captionPip); assert.equal(events, 1);
  supported = false;
  await h.events.appStateChange({ isActive: true }); await flush();
  assert.equal(h.window.LinguaNative.captionPip, null);
});

test('startup asks before downloading; later, foreground and document navigation stay quiet', async (t) => {
  let downloads = 0;
  const options = { response: updateResponse, updater: { download: async () => { downloads++; } } };
  const h = await harness(ownSaved, options); t.after(h.close);
  await h.window.LinguaNative.markReady(); await flush();
  assert.match(h.window.document.querySelector('#native-update').textContent, /发现新版本/);
  assert.equal(downloads, 0);
  clickText(h, '稍后'); await flush();
  await h.window.LinguaNative.markReady();
  await h.events.appStateChange({ isActive: true });
  assert.equal(h.window.document.querySelector('#native-update'), null);
  assert.equal(h.calls.filter((c) => c === 'network').length, 1);
  const session = Object.fromEntries(Object.entries(h.window.sessionStorage));
  const navigated = await harness(Object.fromEntries(h.values), { ...options, session }); t.after(navigated.close);
  await navigated.window.LinguaNative.markReady(); await flush();
  assert.equal(navigated.calls.includes('network'), false);
  await navigated.window.LinguaNative.checkUpdates();
  assert.match(navigated.window.document.querySelector('#native-update').textContent, /发现新版本/);
  assert.equal(downloads, 0);
  const relaunched = await harness(Object.fromEntries(h.values), options); t.after(relaunched.close);
  await relaunched.window.LinguaNative.markReady(); await flush();
  assert.equal(relaunched.calls.includes('network'), true);
});

test('confirmed update downloads once, blocks dismiss while busy and applies after verification', async (t) => {
  let finish, downloads = 0, activated = 0;
  const bundles = [];
  const bundle = { id: 'downloaded', version: updateManifest.version, checksum: updateManifest.checksum, status: 'pending' };
  const h = await harness(ownSaved, { response: updateResponse, updater: {
    list: async () => ({ bundles }),
    download: async () => { downloads++; await new Promise((resolve) => { finish = resolve; }); bundles.push(bundle); return bundle; },
    set: async () => { activated++; },
  } }); t.after(h.close);
  await h.window.LinguaNative.checkUpdates();
  clickText(h, '立即更新'); await flush();
  const dialog = h.window.document.querySelector('#native-update');
  assert.match(dialog.textContent, /正在下载并校验/);
  assert.equal([...dialog.querySelectorAll('button')].every((b) => b.disabled), true);
  const cancel = new h.window.Event('cancel', { cancelable: true }); dialog.dispatchEvent(cancel);
  assert.equal(cancel.defaultPrevented, true);
  h.events.backButton({ canGoBack: false }); assert.equal(dialog.open, true);
  assert.equal(downloads, 1); assert.equal(activated, 0);
  finish(); await flush();
  assert.equal(activated, 1);
});

test('failed download stays retryable without activation and a dismissed check does not reopen', async (t) => {
  let downloads = 0, activated = 0;
  const h = await harness(ownSaved, { response: updateResponse, updater: {
    download: async () => { downloads++; throw Error('下载失败'); }, set: async () => { activated++; },
  } }); t.after(h.close);
  await h.window.LinguaNative.checkUpdates(); clickText(h, '立即更新'); await flush();
  assert.match(h.window.document.querySelector('#native-update').textContent, /更新未完成.*下载失败.*重试/);
  clickText(h, '重试'); await flush(); assert.equal(downloads, 2); assert.equal(activated, 0);
  clickText(h, '稍后'); await flush();
  let finish;
  h.window.adapters.CapacitorHttp.get = () => new Promise((resolve) => { finish = resolve; });
  const check = h.window.LinguaNative.checkUpdates();
  clickText(h, '取消'); await flush(); finish(await updateResponse()); await check;
  assert.equal(h.window.document.querySelector('#native-update'), null);
});

test('dismissing a manual check also suppresses an overlapping startup prompt', async (t) => {
  let finish;
  const h = await harness(ownSaved, { response: () => new Promise((resolve) => { finish = resolve; }) }); t.after(h.close);
  await h.window.LinguaNative.markReady(); await flush();
  const manual = h.window.LinguaNative.checkUpdates(); clickText(h, '取消'); await flush();
  finish(await updateResponse()); await manual; await flush();
  assert.equal(h.window.document.querySelector('#native-update'), null);
});

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
test('offline startup is silent while manual checks expose a recoverable error', async (t) => {
  const ownUrl = 'https://site.example/';
  const source = { channel: 'own', ownUrl, developmentUrl: '' };
  const h = await harness({ 'lingua.channel': 'own', 'lingua.own-url': ownUrl,
    'lingua.native.state': JSON.stringify({ source }) }); t.after(h.close);
  assert.deepEqual(h.calls, []); assert.equal(h.window.LinguaNative.target, ownUrl);
  await h.window.LinguaNative.markReady(); await flush();
  assert.deepEqual(h.calls, ['ready', 'splash', 'network']);
  h.window.LinguaNative.settings();
  assert.equal(h.window.document.querySelector('[data-native-status]').textContent, '');
  await h.window.LinguaNative.checkUpdates();
  assert.match(h.window.document.querySelector('#native-update').textContent, /暂时无法检查更新.*offline/);
  assert.ok(!h.calls.includes('reset'));
});
test('changing channel clears pending and implicit backend token while retaining user model configuration', async (t) => {
  const h = await harness(); t.after(h.close);
  h.window.localStorage.setItem('linguatrack.config.v1', JSON.stringify({ apiBase: '', apiToken: 'old-secret', apiKey: 'llm-key' }));
  h.window.LinguaNative.settings();
  const dialog = h.window.document.querySelector('dialog');
  const select = dialog.querySelector('select'); select.value = 'own'; select.dispatchEvent(new h.window.Event('change'));
  const input = dialog.querySelector('input'); input.value = 'https://new.example/'; input.dispatchEvent(new h.window.Event('input'));
  dialog.querySelector('.native-button-primary').click(); await flush();
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
