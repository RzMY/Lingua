/** Browser-only media processing. Files and credentials never reach the analysis backend. */
import { extractMp4Audio } from './mp4-audio.js';
import { materializeMedia } from './media-file.js';
import { mp3Writer, encodeAsrMp3 } from './asr-mp3.js';
export const SAMPLE_RATE = 16000;

/** Interleave PCM channels without mixing them; channel order stays unchanged. */
export function encodeWav(channels, sampleRate = SAMPLE_RATE, float = false) {
  const frames = channels[0]?.length;
  if (!frames || !channels.length || channels.length > 32
    || channels.some((c) => c.length !== frames)) throw new Error('音频声道数据无效');
  const sampleBytes = float ? 4 : 2;
  const size = frames * channels.length * sampleBytes;
  if (size > 0xffffffff - 36) throw new Error('音频超过 WAV 文件大小上限');
  const bytes = new ArrayBuffer(44 + size);
  const view = new DataView(bytes);
  const ascii = (offset, text) => [...text].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  ascii(0, 'RIFF'); view.setUint32(4, 36 + size, true); ascii(8, 'WAVE');
  ascii(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, float ? 3 : 1, true);
  view.setUint16(22, channels.length, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels.length * sampleBytes, true);
  view.setUint16(32, channels.length * sampleBytes, true); view.setUint16(34, sampleBytes * 8, true);
  ascii(36, 'data'); view.setUint32(40, size, true);
  for (let i = 0, at = 44; i < frames; i++) {
    for (const channel of channels) {
      const v = Math.max(-1, Math.min(1, channel[i] || 0));
      if (float) view.setFloat32(at, channel[i], true);
      else view.setInt16(at, Math.round(v * (v < 0 ? 32768 : 32767)), true);
      at += sampleBytes;
    }
  }
  return new Blob([bytes], { type: 'audio/wav' });
}

/** Read source sampling frequency before decodeAudioData (which resamples to its context).
 * Unsupported containers fail explicitly instead of silently resampling listening audio.
 */
export function sourceSampleRate(bytes) {
  const v = new DataView(bytes), b = new Uint8Array(bytes);
  const tag = (at, text) => [...text].every((c, i) => b[at + i] === c.charCodeAt(0));
  const valid = (n) => Number.isInteger(n) && n >= 8000 && n <= 192000;
  if (tag(0, 'RIFF') && tag(8, 'WAVE')) {
    for (let p = 12; p + 8 <= b.length;) {
      const size = v.getUint32(p + 4, true);
      if (tag(p, 'fmt ') && size >= 16 && p + 24 <= b.length) return v.getUint32(p + 12, true);
      p += 8 + size + (size % 2);
    }
  }
  // ISO BMFF / MP4: audio sample descriptions live inside moov/trak/mdia/minf/stbl/stsd.
  if (tag(4, 'ftyp')) {
    const walk = (start, end, depth = 0) => {
      if (depth > 10) return 0;
      for (let p = start; p + 8 <= end;) {
        let size = v.getUint32(p), header = 8;
        if (size === 1 && p + 16 <= end) { size = Number(v.getBigUint64(p + 8)); header = 16; }
        if (!size) size = end - p;
        if (size < header || p + size > end) break;
        if (['mp4a', 'alac', 'lpcm', 'sowt', 'twos', 'ac-3', 'ec-3'].some((t) => tag(p + 4, t))
          && size >= header + 28) {
          const rate = v.getUint32(p + header + 24) / 65536;
          if (valid(rate)) return rate;
        }
        const container = ['moov', 'trak', 'mdia', 'minf', 'stbl'].some((t) => tag(p + 4, t));
        const rate = container ? walk(p + header, p + size, depth + 1)
          : tag(p + 4, 'stsd') ? walk(p + header + 8, p + size, depth + 1) : 0;
        if (rate) return rate;
        p += size;
      }
      return 0;
    };
    const rate = walk(0, b.length);
    if (rate) return rate;
    throw new Error('此视频没有可识别的音轨采样率，请使用 MP4/AAC 或 WebM');
  }
  if (tag(0, 'fLaC') && b.length >= 22) return v.getUint32(18) >>> 12;
  // WebM / Opus decoder output is always 48 kHz. Vorbis stores its native rate in identification.
  if (v.byteLength >= 4 && v.getUint32(0) === 0x1a45dfa3) {
    for (let p = 0; p < Math.min(b.length - 16, 1024 * 1024); p++) {
      if (tag(p, 'OpusHead')) return 48000;
      if (b[p] === 1 && tag(p + 1, 'vorbis')) return v.getUint32(p + 12, true);
    }
  }
  // MPEG audio frame header, after optional ID3v2 metadata.
  let start = 0;
  if (tag(0, 'ID3') && b.length >= 10) start = 10 + ((b[6] & 127) << 21)
    + ((b[7] & 127) << 14) + ((b[8] & 127) << 7) + (b[9] & 127);
  for (let p = start; p + 4 <= Math.min(b.length, start + 4096); p++) {
    if (b[p] !== 255 || (b[p + 1] & 224) !== 224) continue;
    const version = (b[p + 1] >> 3) & 3, layer = (b[p + 1] >> 1) & 3, index = (b[p + 2] >> 2) & 3;
    if (version !== 1 && layer && index !== 3 && (b[p + 2] >> 4) % 16 !== 15) {
      return [44100, 48000, 32000][index] / (version === 3 ? 1 : version === 2 ? 2 : 4);
    }
  }
  throw new Error('无法读取原音轨采样率，请使用 MP4/AAC、WebM、WAV、MP3 或 FLAC 文件');
}

/** PCM WAV is already lossless: read chunk headers only and reuse the original bytes. */
async function wavInfo(file, signal) {
  const head = new DataView(await file.slice(0, 12).arrayBuffer());
  const tag = (v, p) => String.fromCharCode(...new Uint8Array(v.buffer, p, 4));
  if (head.byteLength < 12 || tag(head, 0) !== 'RIFF' || tag(head, 8) !== 'WAVE') return null;
  const end = head.getUint32(4, true) + 8;
  if (end > file.size) throw new Error('WAV 文件不完整');
  let format, dataSize, dataOffset;
  for (let p = 12, count = 0; p + 8 <= end;) {
    signal?.throwIfAborted();
    if (++count > 10000) throw new Error('WAV 分块过多');
    const v = new DataView(await file.slice(p, Math.min(p + 48, end)).arrayBuffer());
    const size = v.getUint32(4, true);
    if (p + 8 + size > end) throw new Error('WAV 文件不完整');
    if (tag(v, 0) === 'fmt ' && size >= 16) {
      const code = v.getUint16(8, true), bits = v.getUint16(22, true);
      const channels = v.getUint16(10, true), sampleRate = v.getUint32(12, true);
      const block = v.getUint16(20, true);
      if (![1, 3].includes(code)) return null;
      if (!(code === 1 ? [8, 16, 24, 32].includes(bits) : bits === 32)
        || channels < 1 || channels > 32 || sampleRate < 8000 || sampleRate > 192000
        || block !== channels * bits / 8 || v.getUint32(16, true) !== sampleRate * block) throw new Error('WAV 音轨参数无效');
      format = { channels, sampleRate, block, bits, code };
    }
    if (tag(v, 0) === 'data') { dataSize = size; dataOffset = p + 8; }
    if (format && dataSize !== undefined) {
      if (!dataSize || dataSize % format.block) throw new Error('WAV 音轨数据无效');
      return { ...format, dataOffset, dataSize, duration: dataSize / format.block / format.sampleRate };
    }
    p += 8 + size + size % 2;
  }
  throw new Error('WAV 缺少音轨数据');
}

async function decodeMedia(file, { signal, onStage = () => {}, sampleRate } = {}) {
  const Offline = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!Offline) throw new Error('当前浏览器不支持本地音频转换，请使用新版 Chrome、Edge 或 Safari');
  signal?.throwIfAborted();
  onStage('正在读取并解码音轨…');
  const bytes = await file.arrayBuffer();
  signal?.throwIfAborted();
  const rate = sampleRate || sourceSampleRate(bytes);
  let decoded;
  try { decoded = await new Offline(1, 1, rate).decodeAudioData(bytes); }
  catch { throw new Error('无法解码音轨：浏览器可能不支持该编码。请尝试 MP4（AAC）或 WebM'); }
  signal?.throwIfAborted();
  return decoded;
}

// Encode bounded chunks, yielding for cancellation and allowing temporary arrays to die.
async function encodeDecoded(decoded, float, signal) {
  const parts = [], count = decoded.numberOfChannels, chunkFrames = 65536;
  const size = decoded.length * count * (float ? 4 : 2);
  if (!size || size > 0xffffffff - 36) throw new Error('音频为空或超过 WAV 文件大小上限');
  for (let start = 0; start < decoded.length; start += chunkFrames) {
    signal?.throwIfAborted();
    const channels = Array.from({ length: count }, (_, i) => decoded.getChannelData(i)
      .subarray(start, Math.min(start + chunkFrames, decoded.length)));
    parts.push(encodeWav(channels, decoded.sampleRate, float).slice(44));
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const header = await encodeWav(Array.from({ length: count }, () => new Float32Array(1)), decoded.sampleRate, float).slice(0, 44).arrayBuffer();
  const view = new DataView(header); view.setUint32(4, 36 + size, true); view.setUint32(40, size, true);
  signal?.throwIfAborted();
  return new Blob([header, ...parts], { type: 'audio/wav' });
}

export async function extractMedia(file, { signal, onStage = () => {} } = {}) {
  if (!file?.size) throw new Error('请选择非空的视频或音频文件');
  signal?.throwIfAborted();
  onStage('正在读取音轨信息…');
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  signal?.throwIfAborted();
  if (String.fromCharCode(...head.subarray(4, 8)) === 'ftyp' || /\.(mp4|m4a|mov)$/i.test(file.name)) {
    const output = await extractMp4Audio(file, { signal, onStage });
    return { ...output, ...await materializeMedia(output.file, { signal, onStage }) };
  }
  const wav = await wavInfo(file, signal);
  signal?.throwIfAborted();
  if (wav) return { file: new File([file], (file.name.replace(/\.[^.]+$/, '') || 'audio')
    + '.lossless.wav', { type: 'audio/wav' }), ...wav };
  const decoded = await decodeMedia(file, { signal, onStage });
  const sampleRate = decoded.sampleRate;
  onStage('正在生成原采样率无损聆听音频…');
  const blob = await encodeDecoded(decoded, true, signal);
  return { file: new File([blob], (file.name.replace(/\.[^.]+$/, '') || 'audio') + '.lossless.wav',
    { type: 'audio/wav' }), sampleRate, channels: decoded.numberOfChannels, duration: decoded.duration };
}

export async function convertMedia(input, { signal, onStage = () => {} } = {}) {
  const sourceAudio = input?.file ? input : await extractMedia(input, { signal, onStage });
  try {
    try { return await convertAudio(sourceAudio, { signal, onStage }); }
    catch (err) {
      signal?.throwIfAborted();
      if (err.code !== 'SEGMENT_DECODE') throw err;
      // Some decoders trim AAC priming/padding in each remuxed window, or report
      // a different channel count from stsd. Decode the original listening file
      // as one stream so the browser applies its codec metadata only once.
      onStage('正在使用完整音轨兼容转换…');
      const decoded = await decodeMedia(sourceAudio.file, { signal, sampleRate: SAMPLE_RATE });
      return await encodeAsrMp3(decoded, sourceAudio.file.name, { signal, onStage });
    }
  }
  finally { if (!input?.file) await sourceAudio.release?.(); }
}

function segmentDecodeError(message) {
  return Object.assign(new Error(message), { code: 'SEGMENT_DECODE' });
}

async function convertAudio(sourceAudio, { signal, onStage }) {
  const file = sourceAudio.file;
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  let plan;
  if (String.fromCharCode(...head.subarray(4, 8)) === 'ftyp') {
    plan = await extractMp4Audio(file, { signal, onStage, segmented: true });
  } else {
    const info = await wavInfo(file, signal);
    if (info) plan = { ...info, async *segments() {
      const frames = info.dataSize / info.block;
      for (let start = 0; start < frames; start += info.sampleRate * 12) {
        const end = Math.min(frames, start + info.sampleRate * 12);
        const a = Math.max(0, start - 256), b = Math.min(frames, end + 256);
        const header = await encodeWav(Array.from({ length: info.channels }, () => new Float32Array(1)), info.sampleRate, info.code === 3).slice(0, 44).arrayBuffer();
        const v = new DataView(header), size = (b - a) * info.block;
        v.setUint32(4, size + 36, true); v.setUint32(40, size, true);
        v.setUint16(34, info.bits, true); v.setUint16(32, info.block, true); v.setUint32(28, info.sampleRate * info.block, true);
        yield { file: new Blob([header, file.slice(info.dataOffset + a * info.block, info.dataOffset + b * info.block)], { type: 'audio/wav' }),
          skip: (start - a) / info.sampleRate, duration: (end - start) / info.sampleRate, time: start / info.sampleRate };
      }
    } };
  }
  // Other containers still use the browser decoder, directly at the target sample rate.
  if (!plan) {
    const decoded = await decodeMedia(file, { signal, onStage, sampleRate: SAMPLE_RATE });
    return encodeAsrMp3(decoded, file.name, { signal, onStage });
  }
  const Offline = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!Offline) throw new Error('当前浏览器不支持音频转换');
  const count = plan.channels, frames = Math.round(plan.duration * SAMPLE_RATE);
  if (!frames) throw new Error('音频为空');
  const writer = await mp3Writer(file.name, count, signal);
  try {
    let written = 0;
    for await (const segment of plan.segments()) {
      signal?.throwIfAborted();
      const end = Math.min(frames, Math.round(((segment.time || 0) + segment.duration) * SAMPLE_RATE));
      const length = end - written;
      onStage(`正在压制 16 kHz MP3… ${Math.round(written / frames * 100)}%`);
      if (segment.silence) {
        for (let n = 0; n < length; n += SAMPLE_RATE) {
          await writer.write(Array.from({ length: count }, () => new Float32Array(Math.min(SAMPLE_RATE, length - n))));
        }
      } else {
        const bytes = await segment.file.arrayBuffer(); signal?.throwIfAborted();
        let decoded;
        try { decoded = await new Offline(count, 1, plan.sampleRate).decodeAudioData(bytes); }
        catch { throw segmentDecodeError('浏览器无法解码音频片段'); }
        signal?.throwIfAborted();
        if (decoded.numberOfChannels !== count || decoded.duration < segment.skip + segment.duration - 2 / plan.sampleRate) {
          throw segmentDecodeError('音频片段解码不完整');
        }
        const ctx = new Offline(count, length, SAMPLE_RATE), source = ctx.createBufferSource();
        source.buffer = decoded; source.channelInterpretation = ctx.destination.channelInterpretation = 'discrete';
        source.connect(ctx.destination); source.start(0, segment.skip);
        const rendered = await ctx.startRendering();
        source.disconnect(); source.buffer = null; decoded = null;
        const channels = Array.from({ length: count }, (_, i) => {
          const out = new Float32Array(length);
          out.set(rendered.getChannelData(i)); return out;
        });
        await writer.write(channels);
        decoded = null;
      }
      written = end;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (written !== frames) throw new Error('音频时间轴不完整');
    return await writer.finish();
  } catch (err) { await writer.abort(); throw err; }
}

export function transcriptionEndpoint(base) {
  let url;
  try { url = new URL(String(base || '').trim()); } catch { throw new Error('请填写有效的转录接口地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('接口地址须为 HTTP(S)，不能包含用户名、密码、查询参数或片段');
  }
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith('/audio/transcriptions') ? path
    : path + (path.endsWith('/v1') ? '' : '/v1') + '/audio/transcriptions';
  return url.href;
}

const FORMATS = { verbose_json: ['json', 'application/json'], json: ['json', 'application/json'],
  text: ['txt', 'text/plain'], srt: ['srt', 'text/plain'], vtt: ['vtt', 'text/vtt'] };

/** Extra multipart fields; [] names repeat, structured values serialize as JSON. */
export function parseExtraParams(text = '') {
  let params;
  const rows = Array.isArray(text);
  try { params = rows ? text : JSON.parse(text.trim() || '{}'); }
  catch { throw new Error('自定义参数必须是有效的 JSON 对象'); }
  if (!params || typeof params !== 'object' || (!rows && Array.isArray(params))) {
    throw new Error('自定义参数必须是 JSON 对象，例如 {"temperature": 0}');
  }
  const reserved = new Set(['file', 'model', 'response_format', 'language', 'prompt', 'timestamp_granularities', 'stream']);
  const entries = [];
  const names = new Set();
  const fields = rows ? params.filter((row) => row.enabled).map((row) => [String(row.key).trim(), row.value]) : Object.entries(params);
  for (const [key, value] of fields) {
    if (!key.trim() || /[\r\n]/.test(key)) throw new Error('自定义参数名称不能为空或包含换行');
    if (key.startsWith('--')) throw new Error('自定义参数名称无需填写 -- 前缀');
    if (reserved.has(key.replace(/\[\]$/, ''))) throw new Error(`自定义参数 ${key} 与内置选项冲突，请使用上方配置；暂不支持流式转录`);
    if (names.has(key)) throw new Error(`自定义参数 ${key} 重复，请仅启用一个同名参数`);
    names.add(key);
    const values = key.endsWith('[]') && Array.isArray(value) ? value : [value];
    for (const item of values) entries.push([key, typeof item === 'string' ? item : JSON.stringify(item)]);
  }
  return entries;
}

export async function transcribe(file, options, { signal } = {}) {
  if (!file?.size) throw new Error('请选择非空的音频文件');
  const endpoint = transcriptionEndpoint(options.asrBaseUrl);
  const model = String(options.asrModel || '').trim();
  if (!model) throw new Error('请填写转录模型名称');
  const format = options.asrFormat;
  if (!Object.hasOwn(FORMATS, format)) throw new Error('不支持的转录结果格式');
  const language = String(options.asrLanguage || '').trim();
  if (language && !/^[a-z]{2,3}$/i.test(language)) throw new Error('语言请填写 ISO 语言代码，如 ja、en、zh，或留空自动识别');
  const seconds = Number(options.asrTimeout);
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 3600) throw new Error('超时须为 1–3600 秒');
  const body = new FormData();
  body.append('file', file, file.name || 'audio.wav');
  body.append('model', model);
  body.append('response_format', format);
  if (language) body.append('language', language.toLowerCase());
  if (options.prompt?.trim()) body.append('prompt', options.prompt.trim());
  if (format === 'verbose_json' && options.wordTimestamps) {
    body.append('timestamp_granularities[]', 'word');
    body.append('timestamp_granularities[]', 'segment');
  }
  for (const [key, value] of parseExtraParams(options.extraParams)) body.append(key, value);
  const headers = {};
  const key = String(options.asrApiKey || '').trim();
  if (key) headers.Authorization = 'Bearer ' + key;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.throwIfAborted();
  signal?.addEventListener('abort', cancel, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, seconds * 1000);
  try {
    const response = await fetch(endpoint, { method: 'POST', headers, body, signal: controller.signal,
      credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });
    if (!response.ok) {
      const hints = { 401: '请检查转录 API Key', 403: '接口拒绝访问，请检查权限',
        413: '音频超过服务端上限，请裁剪或压缩后重试', 429: '请求过多或配额不足，请稍后重试',
        400: '请检查模型、结果格式与时间戳参数是否被服务支持', 404: '请检查接口地址与模型名称' };
      throw new Error(`转录失败（HTTP ${response.status}）：${hints[response.status] || '服务端异常，请稍后重试'}`);
    }
    const raw = await response.text();
    if (!raw.trim()) throw new Error('转录接口返回了空结果');
    let content = raw;
    if (format.endsWith('json')) {
      let data;
      try { data = JSON.parse(raw); } catch { throw new Error('转录接口未返回有效 JSON，请检查结果格式'); }
      if (!data || typeof data !== 'object' || Array.isArray(data) || data.error
        || (typeof data.text !== 'string' && !Array.isArray(data.segments) && !Array.isArray(data.words))) {
        throw new Error('转录接口返回的 JSON 缺少 text、segments 或 words');
      }
      // OpenAI returns word times beside segments; our subtitle parser expects them inside.
      // Assign each word once by midpoint so small boundary overlaps do not drop it.
      if (Array.isArray(data.words) && Array.isArray(data.segments)) {
        const segments = data.segments.filter((s) => s && Number.isFinite(s.start) && Number.isFinite(s.end));
        const words = data.words.filter((w) => w && Number.isFinite(w.start) && Number.isFinite(w.end));
        let index = 0;
        for (const segment of segments) {
          const matched = [];
          while (index < words.length && (words[index].start + words[index].end) / 2 < segment.end) {
            const word = words[index++];
            if ((word.start + word.end) / 2 >= segment.start) matched.push(word);
          }
          if (!segment.words?.length && matched.length) segment.words = matched;
        }
      }
      content = JSON.stringify(data, null, 2);
    }
    const [extension, type] = FORMATS[format];
    return { content, file: new File([content], (file.name.replace(/\.[^.]+$/, '') || 'transcript')
      + '.' + extension, { type: type + ';charset=utf-8' }) };
  } catch (err) {
    if (timedOut) throw new Error('转录超时，可增加超时秒数后重试');
    if (signal?.aborted) throw new DOMException('已取消', 'AbortError');
    if (err instanceof TypeError) throw new Error('无法连接转录接口，请检查网络、接口 CORS 配置，以及 HTTPS 页面是否使用了 HTTP 接口');
    throw err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}
