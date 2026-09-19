import { Capacitor, CapacitorHttp, registerPlugin, SystemBars, SystemBarType } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { CapacitorUpdater } from '@capgo/capacitor-updater';
import { App } from '@capacitor/app';
import { SplashScreen } from '@capacitor/splash-screen';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { UpdateManager } from './update.js';
import { CHANNELS, CHANNEL_KEY, OWN_KEY, DEV_KEY, normalizeSource, sourceKey, fetchSourceManifest } from './channels.js';

const NativeMedia = registerPlugin('NativeMedia');
const KEY = 'lingua.native.state';
const NativeShell = registerPlugin('NativeShell');
let source = { channel: 'stable', ownUrl: '', developmentUrl: '' };
let manager, target = '', status = '本地版本已就绪', panel, version = '';
const save = (state) => Preferences.set({ key: KEY, value: JSON.stringify(state) });
const node = (tag, text) => { const n = document.createElement(tag); if (text) n.textContent = text; return n; };
function button(text, action) {
  const b = node('button', text); b.type = 'button';
  b.onclick = async () => { b.disabled = true; try { await action(); } catch (e) { setStatus(e.message); } finally { b.disabled = false; } };
  return b;
}
function setStatus(text) {
  status = text;
  document.querySelectorAll('[data-native-status]').forEach((n) => { n.textContent = text; });
}
async function getJson(url) {
  const response = await CapacitorHttp.get({ url, headers: { 'Cache-Control': 'no-cache',
    Accept: url.startsWith('https://api.github.com/') ? 'application/vnd.github+json' : 'application/json' },
    connectTimeout: 15000, readTimeout: 20000, responseType: 'json' });
  if (response.status !== 200) throw Error(`更新服务返回 ${response.status}，请稍后重试`);
  return typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
}
async function readSource() {
  const get = async (key) => (await Preferences.get({ key })).value || '';
  return normalizeSource({ channel: await get(CHANNEL_KEY) || 'stable',
    ownUrl: await get(OWN_KEY), developmentUrl: await get(DEV_KEY) });
}
function clearImplicitBackendToken() {
  const raw = localStorage.getItem('linguatrack.config.v1');
  if (!raw) return;
  let config;
  try { config = JSON.parse(raw); } catch { config = {}; }
  if (!config || typeof config !== 'object' || Array.isArray(config)) config = {};
  if (!config.apiBase) {
    config.apiToken = '';
    localStorage.setItem('linguatrack.config.v1', JSON.stringify(config));
  }
}
async function changeSource(next) {
  if (manager?.busy) throw Error('更新正在下载，请等待完成后再切换分支');
  next = normalizeSource(next);
  if (sourceKey(next) !== sourceKey(source)) clearImplicitBackendToken();
  await save({ source: next, pending: null });
  await Preferences.set({ key: OWN_KEY, value: next.ownUrl });
  await Preferences.set({ key: DEV_KEY, value: next.developmentUrl });
  await Preferences.set({ key: CHANNEL_KEY, value: next.channel });
  if (next.channel === 'development') await NativeShell.openDevelopment({ url: next.developmentUrl });
  else await CapacitorUpdater.reset();
}
function settings(suggested = source) {
  panel?.remove();
  panel = node('dialog'); panel.className = 'native-settings';
  const title = node('h2', '开发人员选项');
  const label = node('label', '代码分支');
  const select = node('select'); select.setAttribute('aria-label', '代码分支');
  for (const channel of CHANNELS) {
    const option = node('option', channel.label); option.value = channel.id; select.append(option);
  }
  select.value = suggested.channel;
  label.append(select);
  const help = node('p');
  const address = node('label');
  const caption = node('span');
  const input = node('input'); input.type = 'url'; input.autocomplete = 'url';
  address.append(caption, input);
  const draft = { ...suggested };
  const refresh = () => {
    const id = select.value;
    help.textContent = CHANNELS.find((c) => c.id === id).description;
    address.hidden = id !== 'own' && id !== 'development';
    caption.textContent = id === 'development' ? '调试网页地址' : '自有站点地址';
    input.value = id === 'development' ? draft.developmentUrl : draft.ownUrl;
    input.placeholder = id === 'development' ? 'http://192.168.1.10:5173/' : 'https://lingua.example.com/';
  };
  select.onchange = refresh;
  input.oninput = () => { draft[select.value === 'development' ? 'developmentUrl' : 'ownUrl'] = input.value; };
  refresh();
  const note = node('p', status); note.dataset.nativeStatus = ''; note.setAttribute('role', 'status');
  const actions = node('div'); actions.className = 'native-actions';
  actions.append(button('保存并切换', () => changeSource({ ...draft, channel: select.value,
    ...(select.value === 'own' ? { ownUrl: input.value } : select.value === 'development' ? { developmentUrl: input.value } : {}),
  })),
    button('检查当前分支更新', check), button('恢复安装包前端', async () => {
      if (manager?.busy) throw Error('请等待当前下载完成');
      if (confirm('恢复随安装包附带的前端并重新载入？学习数据会保留。')) {
        await save({ source, pending: null }); await CapacitorUpdater.reset();
      }
    }));
  if (manager?.state.pending) actions.append(button('重启并使用更新', apply));
  actions.append(button('关闭', () => panel.close()));
  panel.append(title, label, help, address, node('p', `本地版本：${version.slice(0, 12) || '安装包'}`), note, actions);
  document.body.append(panel); panel.showModal();
}
async function apply() {
  if (!confirm('现在重新载入应用以使用新版本？当前播放及未保存的操作会中断。')) return;
  await manager.apply();
}
function announce() {
  if (document.getElementById('native-update')) return;
  const box = node('aside'); box.id = 'native-update'; box.setAttribute('role', 'status');
  box.append(node('span', '新版本已完整下载，下次可离线载入。'),
    button('重启更新', apply), button('稍后', () => box.remove()));
  document.body.append(box);
}
async function check() {
  setStatus('正在检查远端更新…');
  try {
    const pending = await manager.check();
    setStatus(pending ? '更新已校验并保存，重启后生效' : '当前已是最新版本');
    if (pending) announce();
    else document.getElementById('native-update')?.remove();
  } catch (e) { setStatus(`继续使用本地版本：${e.message}`); }
}
async function exportFile(blob, name) {
  // Android's chooser resolves before the receiving app finishes reading the URI.
  // Keep unique cache files for a day; iOS reports completion after the activity finishes.
  const directory = Directory.Cache;
  const { files } = await Filesystem.readdir({ directory, path: 'exports' }).catch(() => ({ files: [] }));
  for (const file of files) {
    if (file.type === 'file' && file.mtime < Date.now() - 86400000 && !/[\\/]/.test(file.name)) {
      await Filesystem.deleteFile({ directory, path: 'exports/' + file.name }).catch(() => {});
    }
  }
  const data = await new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(reader.error || Error('无法读取导出文件')); reader.readAsDataURL(blob);
  });
  const path = 'exports/' + crypto.randomUUID() + '-' + name.replace(/[^\p{L}\p{N}._-]/gu, '_');
  const result = await Filesystem.writeFile({ directory: Directory.Cache, path, data, recursive: true });
  try { await Share.share({ title: name, files: [result.uri] }); }
  finally {
    if (Capacitor.getPlatform() !== 'android') await Filesystem.deleteFile({ directory, path }).catch(() => {});
  }
}
async function initialize() {
  if (!Capacitor.isNativePlatform()) return;
  const style = node('style');
  style.textContent = `.native-settings{color:var(--ink,#1b1f16);background:var(--sheet,#f7f7f1);border:0;border-radius:20px;padding:24px;width:min(90vw,480px);max-height:85dvh;overflow:auto}.native-settings::backdrop{background:#0007}.native-settings p{line-height:1.6}.native-settings input,.native-settings select{display:block;box-sizing:border-box;width:100%;font:inherit;padding:12px;margin:12px 0;border:1px solid #999;border-radius:8px}.native-actions{display:flex;gap:12px;flex-wrap:wrap}.native-settings button,#native-update button{padding:10px 14px;border-radius:12px;border:1px solid #999;font:inherit}#native-update{position:fixed;bottom:calc(env(safe-area-inset-bottom) + 16px);left:16px;right:16px;z-index:10000;background:var(--sheet,#f7f7f1);color:var(--ink,#1b1f16);border:1px solid #999;border-radius:16px;padding:16px;display:flex;gap:12px;align-items:center;flex-wrap:wrap}html.native-app{overscroll-behavior:none}html.native-activity-pip .topbar,html.native-activity-pip .bottom-nav{display:none}`;
  document.head.append(style); document.documentElement.classList.add('native-app');
  let state;
  try { state = JSON.parse((await Preferences.get({ key: KEY })).value || '{}'); } catch { state = {}; }
  if (!state || typeof state !== 'object') state = {};
  // Existing self-hosted installations retain their source; new installs use stable with no dialog.
  if (!(await Preferences.get({ key: CHANNEL_KEY })).value) {
    const legacy = (await Preferences.get({ key: 'lingua.target' })).value;
    if (legacy) {
      await Preferences.set({ key: OWN_KEY, value: legacy });
      await Preferences.set({ key: CHANNEL_KEY, value: 'own' });
    }
  }
  try { source = await readSource(); } catch { setStatus('分支地址无效，已使用正式分支；可在开发人员选项中修改'); }
  if (source.channel === 'development') {
    await NativeShell.openDevelopment({ url: source.developmentUrl });
    await new Promise(() => {});
  }
  target = source.channel === 'own' ? source.ownUrl : '';
  if (!state.source || sourceKey(state.source) !== sourceKey(source)) {
    clearImplicitBackendToken();
    state = { source, pending: null }; await save(state);
    const { bundle } = await CapacitorUpdater.current();
    if (bundle.id !== 'builtin') {
      await CapacitorUpdater.reset();
      await new Promise(() => {});
    }
  }
  const meta = await (await fetch('native-bundle.json')).json();
  version = meta.version;
  // On binary upgrade the plugin discards downloaded bundles; remove stale pending references too.
  const { bundles } = await CapacitorUpdater.list();
  if (state.pending && (state.pending.version === version || !bundles.some((b) => b.id === state.pending.id && b.status !== 'error'))) {
    state.pending = null; await save(state);
  }
  manager = new UpdateManager({ updater: CapacitorUpdater, fetchManifest: (selected) => fetchSourceManifest(selected, getJson), save, state, currentVersion: version });
  let marked = false;
  window.LinguaNative = {
    target, settings, exportFile, channel: source.channel, platform: Capacitor.getPlatform(),
    activityPip: Capacitor.getPlatform() === 'android' ? NativeMedia : null,
    async markReady() {
      if (marked) return; marked = true;
      await CapacitorUpdater.notifyAppReady();
      await SplashScreen.hide();
      if (location.hash === '#native-settings') settings();
      if (state.pending) announce();
      void check();
    },
  };
  // UIKit owns system bars; theme-color alone only changes browser chrome.
  let pageVisible = true;
  let presentationKey = '';
  const syncPresentation = (force = false) => {
    if (Capacitor.getPlatform() !== 'ios') return;
    const root = document.documentElement;
    const state = { immersive: pageVisible && root.classList.contains('video-immersive'), dark: root.dataset.theme === 'dark' };
    const key = JSON.stringify(state);
    if (!force && key === presentationKey) return;
    presentationKey = key;
    // CAPBridgeViewController's Home indicator override is public, not open.
    // Use its built-in plugin instead of overriding that property in the app module.
    void Promise.all([
      NativeShell.setPresentation(state),
      state.immersive ? SystemBars.hide({ bar: SystemBarType.NavigationBar })
        : SystemBars.show({ bar: SystemBarType.NavigationBar }),
    ]).catch((error) => {
      presentationKey = ''; console.warn('Native presentation', error);
    });
  };
  new MutationObserver(() => syncPresentation()).observe(document.documentElement,
    { attributes: true, attributeFilter: ['class', 'data-theme'] });
  window.addEventListener('pagehide', () => { pageVisible = false; syncPresentation(); });
  window.addEventListener('pageshow', () => { pageVisible = true; syncPresentation(true); });
  syncPresentation();
  await App.addListener('backButton', ({ canGoBack }) => {
    if (panel?.open) { panel.close(); return; }
    const overlay = document.querySelector('.menu-scrim') || document.querySelector('.wc-scrim.is-open');
    if (overlay) { overlay.click(); return; }
    const sheet = document.querySelector('.sheet.is-open .sheet-acts button[aria-label="关闭"]');
    if (sheet) { sheet.click(); return; }
    const explain = document.getElementById('explainPanel');
    if (explain && !explain.hidden) { document.getElementById('btnExplainClose')?.click(); return; }
    if (!window.dispatchEvent(new CustomEvent('native-back', { cancelable: true }))) return;
    if (canGoBack) history.back(); else App.minimizeApp();
  });
  await App.addListener('appStateChange', async ({ isActive }) => {
    if (!isActive) return;
    syncPresentation(true);
    try {
      const changed = await readSource();
      if (sourceKey(changed) !== sourceKey(source)) {
        setStatus('系统设置中的代码分支已更改，保存后切换');
        settings(changed);
      }
    } catch (error) { setStatus(error.message); settings(); }
  });
  if (Capacitor.getPlatform() === 'android') {
    await NativeMedia.addListener('pipChanged', ({ active }) => window.dispatchEvent(new CustomEvent('native-pip', { detail: { active } })));
  }
  window.addEventListener('hashchange', () => { if (location.hash === '#native-settings') settings(); });
}
export const ready = initialize().catch(async (error) => {
  console.error('Native startup failed', error);
  // Keep the bundled recovery action independent of the application entry points.
  const box = node('div', `本地应用初始化失败：${error.message}。`);
  box.append(button('恢复安装包前端', () => CapacitorUpdater.reset())); document.body.append(box);
  await SplashScreen.hide().catch(() => {});
  throw error;
});
