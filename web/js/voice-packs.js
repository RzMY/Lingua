/** Local downloadable models; network is used only by explicit download actions. */
import { get, values, writeBatch, deleteRecords, deleteVoiceAssets } from './store.js';
import { speechLanguage } from './pronunciation-config.js';
import { nativeApp } from './native.js';
import { findVoicePack, packKey, packId, VOICE_HOSTS, VOICE_RUNTIME_KEY, VOICE_RUNTIME_FILES,
  SUPERTONIC_FILES, SUPERTONIC_GROUP, SUPERTONIC_REVISION, SUPERTONIC_RUNTIME_KEY, SUPERTONIC_SIMD_FILE, voiceFileURL } from './voice-pack-catalog.js';

export function supportsWasmSIMD() {
  try {
    return WebAssembly.validate(new Uint8Array([0,97,115,109,1,0,0,0,1,4,1,96,0,0,3,2,1,0,10,30,1,28,0,65,0,
      253,15,253,12,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,253,186,1,26,11]));
  } catch { return false; }
}

export const supportsVoicePacks = () => typeof globalThis.Worker === 'function'
  && typeof globalThis.WebAssembly === 'object' && typeof globalThis.BigInt64Array === 'function'
  && !!(nativeApp()?.speechPCM || globalThis.AudioContext || globalThis.webkitAudioContext) && !!globalThis.crypto?.subtle;
const changed = () => globalThis.window?.dispatchEvent(new Event('voice-packs-changed'));
let installed = new Set();
let sharedInstalled = false;
export const hasSupertonicModels = () => sharedInstalled;
// Cache unbalanced PCM, so each replay still reads live calibration/lesson gain.
const pcmCache = new Map();
let pcmBytes = 0;
const forgetPCM = (id) => {
  for (const [key, value] of pcmCache) if (key.startsWith(id + '|')) {
    pcmBytes -= value.samples.byteLength; pcmCache.delete(key);
  }
};
export function installedVoicePack(id) { return installed.has(id); }
export async function refreshVoicePacks() {
  const metadata = await values('voicePackMeta', { strict: true });
  const next = new Set(metadata.filter((item) => item && findVoicePack(item.id)?.revision === item.revision
    && !!findVoicePack(item.id)).map((item) => item.id));
  sharedInstalled = metadata.some((item) => item?.id === SUPERTONIC_GROUP && item.revision === SUPERTONIC_REVISION);
  const different = next.size !== installed.size || [...next].some((id) => !installed.has(id));
  for (const id of installed) if (!next.has(id)) forgetPCM(id);
  installed = next;
  if (different) changed();
  return [...installed];
}
globalThis.window?.addEventListener('focus', () => { void refreshVoicePacks().catch(() => {}); });
export function downloadedVoices() {
  return [...installed].map(findVoicePack).filter(Boolean).map((item) => ({
    voiceURI: packKey(item.id), name: item.name, lang: item.lang, localService: true, provider: 'pack',
  }));
}

/** Exact-length bounded stream, with a watchdog refreshed only by actual progress. */
export async function downloadVoiceFile(file, { signal, onProgress = () => {}, fetcher = globalThis.fetch } = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal?.throwIfAborted(); signal?.addEventListener('abort', abort, { once: true });
  let timer;
  const tick = () => { clearTimeout(timer); timer = setTimeout(() => controller.abort(Error('语音包下载超时，请重试或更换下载源')), 60000); };
  const parts = []; let loaded = 0, reader;
  try {
    tick();
    const response = await fetcher(file.url, { signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!response.ok || !response.body) throw Error(`语音包下载失败（HTTP ${response.status}）`);
    reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      controller.signal.throwIfAborted();
      if (done) break;
      loaded += value.byteLength;
      if (loaded > file.size) throw Error('语音包大小校验失败');
      parts.push(value); tick(); onProgress(loaded, file.size);
    }
    if (loaded !== file.size) throw Error('语音包下载不完整，请重试');
    const bytes = await new Blob(parts).arrayBuffer();
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    controller.signal.throwIfAborted();
    if (Array.from(digest, (n) => n.toString(16).padStart(2, '0')).join('') !== file.hash) throw Error('语音包 SHA-256 校验失败');
    return bytes;
  } catch (error) {
    const reason = controller.signal.aborted ? controller.signal.reason : error;
    controller.abort();
    throw reason;
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort);
    if (reader) { try { await reader.cancel(); } catch {} }
  }
}

const busy = new Set();
let workerSource;
async function localWorkerSource() {
  if (!workerSource) {
    workerSource = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      try {
        const scripts = [];
        for (const path of ['js/vendor/piper/piper_phonemize.js', 'js/vendor/piper/ort.wasm.min.js', 'js/supertonic-text.js', 'js/supertonic-worker.js', 'js/voice-pack-worker.js']) {
          const response = await fetch(new URL(path, document.baseURI), { signal: controller.signal });
          if (!response.ok) throw Error('语音包运行脚本加载失败，请刷新应用');
          // Text helpers also expose ESM exports for frontend contract tests.
          const script = await response.text();
          scripts.push(path.endsWith('supertonic-text.js') ? script.replace(/^export /gm, '') : script);
        }
        return scripts.join('\n;\n');
      } finally { clearTimeout(timer); }
    })();
    workerSource.catch(() => { workerSource = null; });
  }
  return workerSource;
}
export async function downloadVoicePack(id, { signal, onProgress = () => {}, source = 'official' } = {}) {
  const item = findVoicePack(id);
  if (!item || !VOICE_HOSTS[source]) throw Error('未知语音包或下载源');
  if (!supportsVoicePacks()) throw Error('当前环境不支持本地语音包，请使用系统音色');
  if (busy.size) throw Error('请等待当前语音包下载或删除完成');
  busy.add(id);
  try {
    signal?.throwIfAborted();
    const runtime = await get('voicePacks', VOICE_RUNTIME_KEY, { strict: true });
    const savedOrt = await get('voicePacks', SUPERTONIC_RUNTIME_KEY, { strict: true });
    const simd = item.engine === 'supertonic' && supportsWasmSIMD();
    const baseline = runtime ? { onnx: runtime.onnx } : savedOrt && !savedOrt.simd ? savedOrt : null;
    const ortRuntime = simd ? (savedOrt?.simd ? savedOrt : null) : baseline;
    const shared = item.group ? await get('voicePackMeta', item.group, { strict: true }) : null;
    const base = `${VOICE_HOSTS[source]}${item.revision}/${item.path}`;
    const needShared = item.group && shared?.revision !== item.revision;
    const files = item.engine === 'supertonic' ? [
      { ...item.style, url: voiceFileURL(item.style, source) },
      ...(needShared ? SUPERTONIC_FILES.map((file) => ({ ...file, url: voiceFileURL(file, source) })) : []),
      ...(!ortRuntime ? [simd ? SUPERTONIC_SIMD_FILE : VOICE_RUNTIME_FILES.find((file) => file.key === 'onnx')] : []),
    ] : [
      { key: 'model', url: base, size: item.size, hash: item.hash },
      { key: 'config', url: `${base}.json`, size: item.configSize, hash: item.configHash },
      ...(!runtime ? VOICE_RUNTIME_FILES.filter((file) => file.key !== 'onnx' || !ortRuntime) : []),
    ];
    const total = files.reduce((sum, file) => sum + file.size, 0);
    const downloaded = {}; let completed = 0;
    for (const file of files) {
      downloaded[file.key] = await downloadVoiceFile(file, { signal, onProgress: (loaded) => onProgress({ loaded: completed + loaded, total }) });
      completed += file.size;
    }
    signal?.throwIfAborted();
    // Commit model, config, runtime and completion marker in one persistent transaction.
    const assets = [{ key: id, value: { ...(item.engine === 'supertonic' ? { style: downloaded.style }
      : { model: downloaded.model, config: downloaded.config }), revision: item.revision } }];
    const markers = [{ key: id, value: { id, revision: item.revision, group: item.group || '' } }];
    if (item.engine === 'supertonic') {
      if (needShared) {
        assets.push({ key: item.group, value: { ...Object.fromEntries(SUPERTONIC_FILES.map(({ key }) => [key, downloaded[key]])), revision: item.revision } });
        markers.push({ key: item.group, value: { id: item.group, revision: item.revision } });
      }
      if (!ortRuntime) assets.push({ key: SUPERTONIC_RUNTIME_KEY, value: { onnx: downloaded.onnx, simd } });
    } else if (!runtime) {
      assets.push({ key: VOICE_RUNTIME_KEY, value: { phonemizer: downloaded.phonemizer, data: downloaded.data,
        onnx: ortRuntime?.onnx || downloaded.onnx } });
    }
    await writeBatch({ voicePacks: assets, voicePackMeta: markers }, {
      persistent: true, beforeCommit: () => signal?.throwIfAborted(),
    });
    installed.add(id); if (item.group) sharedInstalled = true; changed();
  } finally { busy.delete(id); }
}
export async function removeVoicePack(id) {
  const item = findVoicePack(id);
  if (!item) throw Error('未知语音包');
  if (busy.size) throw Error('请等待当前语音包下载或删除完成');
  busy.add(id);
  try {
    if (item.group) {
      if (await deleteVoiceAssets(id, item.group)) sharedInstalled = false;
    } else await deleteRecords({ voicePacks: [id], voicePackMeta: [id] });
    forgetPCM(id);
    installed.delete(id); changed();
  } finally { busy.delete(id); }
}

/** A worker owns each request, so abort can stop CPU work as well as late playback. */
export async function synthesizeVoicePack(key, text, lang, { signal } = {}) {
  const item = findVoicePack(packId(key));
  if (!item || speechLanguage(item.lang).split('-')[0] !== speechLanguage(lang).split('-')[0]) throw Error('所选语音包不支持当前语言，请重新选择音色');
  if (!supportsVoicePacks()) throw Error('当前环境不支持本地语音包，请选择系统音色');
  if (typeof text !== 'string' || !text.trim() || text.length > 2000) throw Error('发音文本为空或超过 2000 字符');
  signal?.throwIfAborted();
  const cacheKey = `${item.id}|${text}`;
  const cached = pcmCache.get(cacheKey);
  if (cached) {
    // Check the cheap completion marker, not the 60 MB model, on repeat taps.
    const meta = await get('voicePackMeta', item.id, { strict: true });
    signal?.throwIfAborted();
    if (!meta || meta.revision !== item.revision) { forgetPCM(item.id); throw Error('所选语音包尚未下载或已删除，请前往发音设置下载'); }
    pcmCache.delete(cacheKey); pcmCache.set(cacheKey, cached);
    return { sampleRate: cached.sampleRate, samples: cached.samples.slice() };
  }
  const assets = await get('voicePacks', item.id, { strict: true });
  signal?.throwIfAborted();
  if (!assets || assets.revision !== item.revision) throw Error('所选语音包尚未下载或已删除，请前往发音设置下载');
  let runtime = item.engine === 'supertonic' ? await get('voicePacks', SUPERTONIC_RUNTIME_KEY, { strict: true }) : null;
  runtime ||= await get('voicePacks', VOICE_RUNTIME_KEY, { strict: true });
  signal?.throwIfAborted();
  if (!runtime) throw Error('语音包运行文件缺失，请重新下载语音包');
  if (item.engine === 'supertonic') runtime = { onnx: runtime.onnx, simd: runtime.simd === true };
  const shared = item.group ? await get('voicePacks', item.group, { strict: true }) : null;
  signal?.throwIfAborted();
  if (item.group && shared?.revision !== item.revision) throw Error('语音包共用模型缺失，请重新下载');
  const config = item.engine === 'piper' ? JSON.parse(new TextDecoder().decode(assets.config)) : null;
  const source = await localWorkerSource();
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let worker, timer, workerURL, settled = false;
    const finish = (error, output) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); signal?.removeEventListener('abort', abort); worker?.terminate();
      if (workerURL) URL.revokeObjectURL(workerURL);
      if (error) { reject(error); return; }
      if (output.samples.byteLength <= 4 * 1024 * 1024) {
        const previous = pcmCache.get(cacheKey);
        if (previous) { pcmBytes -= previous.samples.byteLength; pcmCache.delete(cacheKey); }
        while (pcmCache.size && (pcmCache.size >= 16 || pcmBytes + output.samples.byteLength > 4 * 1024 * 1024)) {
          const oldest = pcmCache.keys().next().value;
          pcmBytes -= pcmCache.get(oldest).samples.byteLength; pcmCache.delete(oldest);
        }
        pcmCache.set(cacheKey, { sampleRate: output.sampleRate, samples: output.samples.slice() });
        pcmBytes += output.samples.byteLength;
      }
      resolve(output);
    };
    const abort = () => finish(signal.reason || new DOMException('发音已停止', 'AbortError'));
    try {
      // Fetch obeys iOS development-cache mapping and Capacitor custom schemes;
      // the Blob worker itself has the document origin and never imports remote scripts.
      workerURL = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
      worker = new Worker(workerURL);
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => finish(Error('语音包合成超时，请重试或更换音色')), 45000);
      worker.onerror = () => finish(Error('语音包合成运行失败，请检查浏览器支持或更换音色'));
      worker.onmessage = ({ data }) => data.error ? finish(Error(data.error))
        : finish(null, { samples: data.samples, sampleRate: data.sampleRate });
      const buffers = item.engine === 'supertonic' ? [assets.style, ...SUPERTONIC_FILES.map(({ key }) => shared[key]), runtime.onnx]
        : [assets.model, ...Object.values(runtime)];
      worker.postMessage({ text, config, model: assets.model, runtime, engine: item.engine, lang: speechLanguage(lang).split('-')[0],
        assets: item.engine === 'supertonic' ? assets : null, shared }, buffers);
    } catch (error) { finish(error); }
  });
}
