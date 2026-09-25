import { Capacitor, CapacitorHttp, registerPlugin, SystemBars, SystemBarType } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { CapacitorUpdater } from '@capgo/capacitor-updater';
import { App } from '@capacitor/app';
import { SplashScreen } from '@capacitor/splash-screen';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { UpdateManager } from './update.js';
import { nativeStyles } from './ui.js';
import { errorMessage } from '../../web/js/errors.js';
import { CHANNELS, CHANNEL_KEY, OWN_KEY, DEV_KEY, PREVIOUS_CHANNEL_KEY, normalizeSource, sourceKey, fetchSourceManifest } from './channels.js';

const NativeMedia = registerPlugin('NativeMedia');
const CaptionPip = registerPlugin('CaptionPip');
const AudioPlayer = registerPlugin('AudioPlayer');
const KEY = 'lingua.native.state';
const NativeShell = registerPlugin('NativeShell');
let source = { channel: 'stable', ownUrl: '', developmentUrl: '' };
let manager, target = '', status = '', panel, updatePanel, version = '', updating = false;
let manualChecks = 0;
const SESSION_CHECK = 'lingua.native.startup-check';
const save = (state) => Preferences.set({ key: KEY, value: JSON.stringify(state) });
const node = (tag, text) => { const n = document.createElement(tag); if (text) n.textContent = text; return n; };
function button(text, action, className = 'native-button') {
  const b = node('button', text); b.type = 'button';
  b.className = className;
  if (className === 'native-tool') b.setAttribute('aria-label', text);
  b.onclick = async () => { b.disabled = true; try { await action(); } catch (e) { setStatus(errorMessage(e)); } finally { b.disabled = false; } };
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
  if (response.status !== 200) throw Error(`更新服务暂时不可用（HTTP ${response.status}），请稍后重试`);
  return typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
}
async function readSource() {
  const get = async (key) => (await Preferences.get({ key })).value || '';
  const [channel, ownUrl, developmentUrl] = await Promise.all([get(CHANNEL_KEY), get(OWN_KEY), get(DEV_KEY)]);
  return normalizeSource({ channel: channel || 'stable', ownUrl, developmentUrl });
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
  if (manager?.busy || updating) throw Error('请等待更新完成后再切换分支');
  next = normalizeSource(next);
  if (next.channel === 'development') {
    // The remote view is temporary: retain the local bundle, pending update and source.
    if (source.channel !== 'development') await Preferences.set({ key: PREVIOUS_CHANNEL_KEY, value: source.channel });
  } else {
    if (sourceKey(next) !== sourceKey(source)) clearImplicitBackendToken();
    await save({ source: next, pending: null });
  }
  await Preferences.set({ key: OWN_KEY, value: next.ownUrl });
  await Preferences.set({ key: DEV_KEY, value: next.developmentUrl });
  await Preferences.set({ key: CHANNEL_KEY, value: next.channel });
  if (next.channel === 'development') await NativeShell.openDevelopment({ url: next.developmentUrl });
  else await CapacitorUpdater.reset();
}
function dialog(className, title) {
  const box = node('dialog'); box.className = `native-dialog ${className}`;
  const heading = node('h2', title); heading.id = className + '-title';
  box.setAttribute('aria-labelledby', heading.id);
  box.addEventListener('close', () => box.remove());
  return { box, heading };
}
function settings(suggested = source) {
  panel?.remove();
  const { box, heading } = dialog('native-settings', '开发人员选项'); panel = box;
  const head = node('div'); head.className = 'native-head';
  const close = button('×', () => box.close(), 'native-close'); close.setAttribute('aria-label', '关闭');
  head.append(heading, close);
  const label = node('label'); label.className = 'native-field'; label.append(node('span', '代码分支'));
  const select = node('select'); select.setAttribute('aria-label', '代码分支');
  for (const channel of CHANNELS) {
    const option = node('option', channel.label); option.value = channel.id; select.append(option);
  }
  select.value = suggested.channel;
  label.append(select);
  const address = node('label'); address.className = 'native-field';
  const caption = node('span');
  const input = node('input'); input.type = 'url'; input.autocomplete = 'url';
  input.autocapitalize = 'none'; input.spellcheck = false;
  address.append(caption, input);
  const draft = { ...suggested };
  const refresh = () => {
    const id = select.value;
    address.hidden = id !== 'own' && id !== 'development';
    caption.textContent = id === 'development' ? '开发网页地址' : '站点地址';
    input.value = id === 'development' ? draft.developmentUrl : draft.ownUrl;
    input.placeholder = id === 'development' ? 'http://192.168.1.10:5173/' : 'https://lingua.example.com/';
  };
  select.onchange = refresh;
  input.oninput = () => { draft[select.value === 'development' ? 'developmentUrl' : 'ownUrl'] = input.value; };
  refresh();
  const note = node('p', status); note.className = 'native-status'; note.dataset.nativeStatus = ''; note.setAttribute('role', 'status');
  const actions = node('div'); actions.className = 'native-actions';
  actions.append(button('保存并切换', () => changeSource({ ...draft, channel: select.value,
    ...(select.value === 'own' ? { ownUrl: input.value } : select.value === 'development' ? { developmentUrl: input.value } : {}),
  }), 'native-button native-button-primary'));
  const tools = node('div'); tools.className = 'native-tools';
  tools.append(button('检查更新', () => check(true), 'native-tool'), button('恢复内置版本', async () => {
      if (manager?.busy || updating) throw Error('请等待更新完成');
      if (confirm('恢复内置版本并重新打开应用？学习数据会保留。')) {
        await save({ source, pending: null }); await CapacitorUpdater.reset();
      }
    }, 'native-tool'));
  if (manager?.state.pending) tools.append(button('安装已下载的更新', () => offerUpdate(), 'native-tool'));
  panel.append(head, label, address, note, actions, tools);
  document.body.append(panel); panel.showModal();
}
function updateDialog(title) {
  updatePanel?.remove();
  const { box, heading } = dialog('native-update', title); box.id = 'native-update'; updatePanel = box;
  const mark = node('div'); mark.className = 'native-update-mark'; mark.setAttribute('aria-hidden', 'true');
  // Static, trusted icon; all service-provided text is rendered with textContent.
  mark.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 16V3m-5 5 5-5 5 5M4 15v5a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5"/></svg>';
  const note = node('p'); note.className = 'native-status'; note.setAttribute('role', 'status');
  const actions = node('div'); actions.className = 'native-actions';
  box.append(mark, heading, note, actions);
  box.addEventListener('cancel', (event) => { if (updating) event.preventDefault(); });
  document.body.append(box); box.showModal();
  return { box, heading, note, actions };
}
function offerUpdate(manifest, view = updateDialog('发现新版本')) {
  const { box, heading, note, actions } = view;
  heading.textContent = '发现新版本'; note.textContent = '更新后将重新打开应用。';
  const later = button('稍后', () => box.close());
  const install = button('立即更新', async () => {
    updating = true; later.disabled = true;
    heading.textContent = '正在更新'; note.textContent = '正在下载并校验…';
    box.setAttribute('aria-busy', 'true');
    try {
      if (manifest) await manager.download(manifest);
      note.textContent = '正在重新打开…';
      await manager.apply();
    } catch (error) {
      heading.textContent = '更新未完成'; note.textContent = errorMessage(error, '更新失败，请检查网络后重试');
      install.textContent = '重试';
    } finally { updating = false; later.disabled = false; box.removeAttribute('aria-busy'); }
  }, 'native-button native-button-primary');
  actions.replaceChildren(later, install);
}
async function check(manual = false) {
  if (updating) return;
  if (manual) manualChecks++;
  const manualGeneration = manualChecks;
  const view = manual ? updateDialog('正在检查更新') : null;
  if (view) view.actions.append(button('取消', () => view.box.close()));
  try {
    const manifest = await manager.check();
    if (manual && !view.box.open) return;
    // A manual check owns its dialog if it overlaps the silent startup check.
    if (!manual && (updatePanel?.open || manualGeneration !== manualChecks)) return;
    if (manifest) offerUpdate(manifest, view || undefined);
    else if (view) {
      view.heading.textContent = '已是最新版本';
      view.actions.replaceChildren(button('完成', () => view.box.close(), 'native-button native-button-primary'));
    }
  } catch (error) {
    if (!view?.box.open) return;
    view.heading.textContent = '无法检查更新'; view.note.textContent = errorMessage(error, '无法连接更新服务，请检查网络后重试');
    view.actions.replaceChildren(button('关闭', () => view.box.close()),
      button('重试', () => check(true), 'native-button native-button-primary'));
  }
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
  style.textContent = nativeStyles;
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
  await Preferences.set({ key: PREVIOUS_CHANNEL_KEY, value: source.channel });
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
  const { bundles } = state.pending ? await CapacitorUpdater.list() : { bundles: [] };
  if (state.pending && (state.pending.version === version || !bundles.some((b) => b.id === state.pending.id && b.status !== 'error'))) {
    state.pending = null; await save(state);
  }
  manager = new UpdateManager({ updater: CapacitorUpdater, fetchManifest: (selected) => fetchSourceManifest(selected, getJson), save, state, currentVersion: version });
  let marked = false;
  const audioPlayer = Capacitor.isPluginAvailable('AudioPlayer') ? AudioPlayer : null;
  if (audioPlayer) {
    await audioPlayer.addListener('stateChanged', (detail) => window.dispatchEvent(new CustomEvent('native-audio-state', { detail })));
  }
  // Build 7 has audio only. Hot-updated JS must not send new video/volume
  // commands to that binary, even though the AudioPlayer plugin exists.
  let nativeVideoAudio = false;
  if (audioPlayer) {
    try { nativeVideoAudio = (await audioPlayer.capabilities()).videoAudio === true; } catch { /* Older IPA. */ }
  }
  // The optional bridge requires a new APK/IPA; old binaries must never pretend to support it.
  let captionPip = null;
  const captionPluginAvailable = Capacitor.isPluginAvailable('CaptionPip');
  let captionProbe = null;
  const refreshCaptionPip = () => {
    if (!captionPluginAvailable) return Promise.resolve();
    if (!captionProbe) captionProbe = (async () => {
      try { captionPip = (await CaptionPip.capabilities()).supported === true ? CaptionPip : null; }
      catch { captionPip = null; }
      if (window.LinguaNative) {
        window.LinguaNative.captionPip = captionPip;
        window.dispatchEvent(new Event('native-caption-capabilities'));
      }
    })().finally(() => { captionProbe = null; });
    return captionProbe;
  };
  if (captionPluginAvailable) {
    await CaptionPip.addListener('stateChanged', (detail) => window.dispatchEvent(new CustomEvent('native-caption-pip', { detail })));
    await refreshCaptionPip();
  }
  window.LinguaNative = {
    target, settings, checkUpdates: () => check(true), exportFile, channel: source.channel, platform: Capacitor.getPlatform(),
    activityPip: Capacitor.getPlatform() === 'android' ? NativeMedia : null,
    captionPip,
    audioPlayer,
    nativeVideoAudio,
    refreshCaptionPip,
    async markReady() {
      if (marked) return; marked = true;
      await CapacitorUpdater.notifyAppReady();
      await SplashScreen.hide();
      if (location.hash === '#native-settings') settings();
      // sessionStorage follows this WebView across full-document navigation, but not a cold launch.
      // Include the source so switching channels still checks the newly selected version.
      const key = sourceKey(source);
      let shouldCheck = true;
      try {
        shouldCheck = sessionStorage.getItem(SESSION_CHECK) !== key;
        sessionStorage.setItem(SESSION_CHECK, key);
      } catch { /* Storage unavailable: still permit this startup's single check. */ }
      if (shouldCheck) void check();
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
    if (updatePanel?.open) { if (!updating) updatePanel.close(); return; }
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
    window.dispatchEvent(new CustomEvent('native-app-state', { detail: { active: isActive } }));
    if (!isActive) return;
    syncPresentation(true);
    void refreshCaptionPip();
    try {
      const changed = await readSource();
      if (sourceKey(changed) !== sourceKey(source)) {
        setStatus('系统设置中的代码分支已更改，保存后切换');
        settings(changed);
      }
    } catch (error) { setStatus(errorMessage(error, '分支设置读取失败，请重新选择')); settings(); }
  });
  if (Capacitor.getPlatform() === 'android') {
    await NativeMedia.addListener('pipChanged', (detail) => window.dispatchEvent(new CustomEvent('native-pip', { detail })));
  }
  window.addEventListener('hashchange', () => { if (location.hash === '#native-settings') settings(); });
}
export const ready = initialize().catch(async (error) => {
  console.error('Native startup failed', error);
  // Keep the bundled recovery action independent of the application entry points.
  const box = node('div', '应用启动失败：' + errorMessage(error, '请重启应用或恢复内置版本'));
  box.append(button('恢复内置版本', () => CapacitorUpdater.reset())); document.body.append(box);
  await SplashScreen.hide().catch(() => {});
  throw error;
});
