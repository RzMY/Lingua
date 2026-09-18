/**
 * 音频库 —— 全部数据都在浏览器里.
 *
 * 后端不存东西, 所以「一条音频」= IndexedDB 里的三条记录及可选字幕原件:
 *
 * * `tracks`  元数据 (标题 / 源语言 / 状态 / 统计), 首页列表读它;
 * * `audio`   原始音频 Blob, 播放时用 `URL.createObjectURL` 喂给 `<audio>`;
 * * `data`    分析后端返回的 track.json, 播放页读它。
 * * `transcripts` 字幕原件, 重新分析时可直接复用。
 *
 * 音频走 blob URL 而不是 HTTP, 所以 seek 天生可用 —— 不再需要服务端的 Range 支持,
 * 也不再需要联网就能重听已经导入过的音频。
 */

import { del, get, put, values, wipeTrack, wipeTrackAll, writeBatch } from './store.js';
import { dropTrackCfg } from './trackcfg.js';
import { randomId } from './util.js';

const now = () => new Date().toISOString();

/** 文件名 -> URL 安全的短 id (与后端 `slug_id` 同一套规则). */
export function slugId(name) {
  const stem = String(name || '').replace(/\.[^.]+$/, '');
  const ascii = stem.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  const out = ascii.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
  return out.slice(0, 40) || 'audio';
}

/** 新到旧; 首页按天分组就靠 createdAt. */
export async function listTracks() {
  const rows = await values('tracks');
  return rows
    .filter((t) => t && t.id)
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))
      || String(a.title || '').localeCompare(String(b.title || '')));
}

export const getTrack = (id) => get('tracks', id);
export const trackData = (id) => get('data', id);
export async function audioBlob(id) {
  const audio = await get('audio', id);
  if (!audio || audio.storage !== 'chunks-v1') return audio;
  const parts = [];
  for (let i = 0; i < audio.count; i++) {
    const bytes = await get('audioChunks', `${audio.prefix}|${i}`);
    if (!(bytes instanceof ArrayBuffer)) throw new Error('音频数据不完整，请重新导入');
    parts.push(new Blob([bytes]));
  }
  return new Blob(parts, { type: audio.type });
}
export const transcriptBlob = (id) => get('transcripts', id);

/** 播放页拿到的是 blob URL; 用完记得 `URL.revokeObjectURL`. */
export async function audioUrl(id) {
  const blob = await audioBlob(id);
  return blob ? URL.createObjectURL(blob) : '';
}

async function uniqueId(base) {
  const taken = new Set((await listTracks()).map((t) => t.id));
  let id = base;
  let n = 1;
  while (taken.has(id)) {
    n += 1;
    id = n <= 99 ? `${base}-${n}` : `${base}-${Math.random().toString(36).slice(2, 8)}`;
    if (n > 99) break;
  }
  return id;
}

/** 导入一个音频文件; 只写库, 不做任何分析. */
export async function createTrack(file, { title = '', lang = 'ja' } = {}) {
  const id = await uniqueId(slugId(file.name));
  const record = {
    id,
    title: (title || file.name.replace(/\.[^.]+$/, '') || id).slice(0, 200),
    lang,
    status: 'new',                 // new | ready | failed
    error: '',
    audio: { name: file.name, size: file.size || 0, type: file.type || '' },
    duration: 0,
    sentences: 0,
    words: 0,
    hasWordTiming: false,
    transcript: null,
    createdAt: now(),
    updatedAt: now(),
  };
  await put('audio', id, file, id);
  await put('tracks', id, record, id);
  return record;
}

export async function patchTrack(id, fields) {
  const record = await getTrack(id);
  if (!record) return null;
  const next = { ...record, id, updatedAt: now() };
  // undefined 表示「这次不改」而不是「清空」—— 展开对象会把 undefined 也盖上去
  for (const [k, v] of Object.entries(fields || {})) if (v !== undefined) next[k] = v;
  await put('tracks', id, next, id);
  return next;
}

/** 分析结果落库, 并把统计回填进元数据. */
export async function saveAnalysis(id, track, { transcriptName = '', transcriptFile = null } = {}) {
  const record = await getTrack(id);
  if (!record) throw new Error('找不到这条音频');
  const stats = track.stats || {};
  const audio = track.audio || {};
  const next = { ...record,
    status: 'ready',
    error: '',
    lang: (track.lang && track.lang.code) || record.lang,
    sentences: stats.sentences || (track.sentences || []).length,
    words: stats.words || 0,
    hasWordTiming: !!track.hasWordTiming,
    duration: audio.duration || record.duration,
    transcript: transcriptName ? { name: transcriptName, at: now(), missing: !transcriptFile }
      : record.transcript,
    schemaVersion: track.schemaVersion || 0,
    updatedAt: now(),
  };
  const batches = {
    data: [{ key: id, value: track, track: id }],
    tracks: [{ key: id, value: next, track: id }],
  };
  if (transcriptFile) batches.transcripts = [{ key: id, value: transcriptFile, track: id }];
  await writeBatch(batches);
  return next;
}

/** Workbench import: commit the listening master and subtitle together, never the ASR proxy. */
export async function createPreparedTrack(file, transcript, { title = '', lang = 'ja', duration = 0, onStage } = {}) {
  if (!(file instanceof Blob) || !file.size || !file.name) throw new Error('缺少聆听音频');
  if (transcript && (!(transcript instanceof Blob) || !transcript.size || !SUB_RE.test(transcript.name))) {
    throw new Error('缺少有效的 JSON / SRT / VTT 字幕');
  }
  const id = await uniqueId(slugId(file.name));
  const record = { id, title: (title || file.name.replace(/\.[^.]+$/, '')).slice(0, 200), lang,
    status: 'new', error: '', duration, sentences: 0, words: 0, hasWordTiming: false,
    audio: { name: file.name, size: file.size, type: file.type },
    transcript: transcript ? { name: transcript.name, at: now(), missing: false } : null,
    createdAt: now(), updatedAt: now() };
  // Safari can stall preparing a compound Blob for IDB. Store small ArrayBuffers,
  // then atomically publish the manifest + track only after every chunk commits.
  const prefix = `${id}|${randomId()}`, chunkSize = 1024 * 1024;
  const keys = [];
  try {
    for (let p = 0, i = 0; p < file.size; p += chunkSize, i++) {
      const bytes = await file.slice(p, p + chunkSize).arrayBuffer(), key = `${prefix}|${i}`;
      keys.push(key);
      await writeBatch({ audioChunks: [{ key, value: bytes, track: id }] },
        { persistent: true, addOnly: true, timeoutMs: 15000 });
      onStage?.(`正在保存聆听音频… ${Math.round(Math.min(p + chunkSize, file.size) / file.size * 100)}%`);
    }
    const manifest = { storage: 'chunks-v1', prefix, count: keys.length, type: file.type, size: file.size };
    const batches = { tracks: [{ key: id, value: record, track: id }], audio: [{ key: id, value: manifest, track: id }] };
    if (transcript) batches.transcripts = [{ key: id, value: transcript, track: id }];
    await writeBatch(batches, { addOnly: true, persistent: true, timeoutMs: 15000 });
    return record;
  } catch (err) {
    for (const key of keys) await del('audioChunks', key);
    throw err;
  }
}

export const SUB_EXT = ['json', 'srt', 'vtt', 'webvtt'];
export const SUB_RE = /\.(json|srt|vtt|webvtt)$/i;

/** Save a replacement subtitle before analysis so failures can retry from the player. */
export async function savePreparedTranscript(id, file, lang) {
  const record = await getTrack(id);
  if (!record) throw new Error('找不到这条音频，请重新选择');
  if (!(file instanceof Blob) || !file.size || !SUB_RE.test(file.name)) throw new Error('请选择 JSON / SRT / VTT 字幕');
  const next = { ...record, lang: lang || record.lang, status: 'new', error: '',
    sentences: 0, words: 0, hasWordTiming: false, schemaVersion: 0,
    transcript: { name: file.name, at: now(), missing: false }, updatedAt: now() };
  await writeBatch({ tracks: [{ key: id, value: next, track: id }],
    transcripts: [{ key: id, value: file, track: id }],
    data: [{ key: id, value: null, track: id }] }, { persistent: true });
  await wipeTrack(id);
  return next;
}
export const AUDIO_ACCEPT = 'audio/*,.wav,.mp3,.m4a,.flac,.ogg,.opus,.aac,.mp4,.webm';

export const missingFiles = (records) => records.flatMap((record) =>
  ['audio', 'transcript'].filter((kind) => record[kind]?.missing)
    .map((kind) => ({ id: record.id, kind, name: record[kind].name })));

/** Filename-only backups cannot disambiguate two different files with the same name. */
export function matchFiles(records, files) {
  const wanted = missingFiles(records);
  const matches = [], ambiguous = [], unmatched = [];
  const names = new Set(files.map((f) => f.name));
  for (const name of names) {
    const picked = files.filter((f) => f.name === name);
    const targets = wanted.filter((f) => f.name === name);
    if (!targets.length) unmatched.push(name);
    else if (picked.length !== 1 || targets.length !== 1) ambiguous.push(name);
    else matches.push({ ...targets[0], file: picked[0] });
  }
  return { matches, ambiguous, unmatched };
}

/** Reattach files without changing analysis, cache keys, or the track ID. */
export async function attachFiles(id, files) {
  const record = await getTrack(id);
  if (!record) throw new Error('找不到这条音频');
  const next = { ...record, updatedAt: now() };
  const batches = {};
  for (const kind of ['audio', 'transcript']) {
    const file = files[kind];
    if (!file) continue;
    if (!(file instanceof Blob) || !file.name || !file.size) throw new Error('请选择非空文件');
    if (kind === 'transcript' && !SUB_RE.test(file.name)) throw new Error('请选择 JSON / SRT / VTT 字幕');
    if (kind === 'audio' && !/^audio\//i.test(file.type)
      && !/\.(wav|mp3|m4a|flac|ogg|opus|aac|mp4|webm|aiff?|wma)$/i.test(file.name)) {
      throw new Error('请选择音频文件');
    }
    next[kind] = { name: file.name, size: file.size, type: file.type, missing: false };
    batches[kind === 'audio' ? 'audio' : 'transcripts'] = [{ key: id, value: file, track: id }];
  }
  batches.tracks = [{ key: id, value: next, track: id }];
  await writeBatch(batches, { persistent: true });
  return next;
}

/** 前端读到 `<audio>` 元数据后补一次真实时长 (字幕给的只是最后一句的结束时间). */
export async function setDuration(id, seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return null;
  const record = await getTrack(id);
  if (!record || Math.abs((record.duration || 0) - value) < 0.05) return record;
  return patchTrack(id, { duration: Math.round(value * 1000) / 1000 });
}

/**
 * 播放进度落库 —— 记住上次停下的秒数, 下次打开这条音频时接着放.
 *
 * 和 `setDuration` 一样只回填元数据: 音频与分析结果都不动, 所以首页列表读到的还是
 * 同一条记录, 删音频时它跟着一起走。`positionAt` 是写入时刻, 便于以后显示
 * 「几天前听到这里」; 进度字段不参与首页排序。
 */
export async function setPosition(id, seconds) {
  const value = Number(seconds);
  if (!id || !Number.isFinite(value) || value < 0) return null;
  const record = await getTrack(id);
  if (!record) return null;
  return patchTrack(id, { position: Math.round(value * 10) / 10, positionAt: now() });
}

/** 彻底删掉一条音频: 音频 / 分析结果 / 元数据 / 大模型缓存 / 显示配置. */
export async function removeTrack(id) {
  if (!id) return 0;
  const n = await wipeTrackAll(id);
  // 老记录可能没带 track 索引 (v1 时代), 按主键再删一次兜底
  for (const store of ['tracks', 'audio', 'data', 'transcripts']) await del(store, id);
  dropTrackCfg(id);
  return n;
}
