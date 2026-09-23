import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeWav, extractMedia, convertMedia, sourceSampleRate, transcriptionEndpoint, transcribe, parseExtraParams } from '../web/js/workbench-media.js';
import { config, DEFAULTS, loadConfig, setConfig } from '../web/js/config.js';
import { randomId } from '../web/js/util.js';

test('storage UUIDs stay unique without the secure-context randomUUID API', (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis.crypto, 'randomUUID');
  Object.defineProperty(globalThis.crypto, 'randomUUID', { configurable: true, value: undefined });
  t.after(() => {
    if (original) Object.defineProperty(globalThis.crypto, 'randomUUID', original);
    else delete globalThis.crypto.randomUUID;
  });
  const ids = Array.from({ length: 100 }, () => randomId());
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every((id) => /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id)));
});

const audio = () => new File(['audio'], 'lesson.wav', { type: 'audio/wav' });
const options = (extra = {}) => ({ asrBaseUrl: 'https://asr.example/v1', asrApiKey: 'asr-secret',
  asrModel: 'whisper-1', asrFormat: 'verbose_json', asrLanguage: '', asrTimeout: 60, ...extra });

test('experimental feature defaults off and persists explicit opt-in with isolated ASR settings', (t) => {
  assert.equal(DEFAULTS.experimental, 0);
  let saved = null;
  globalThis.localStorage = { getItem: () => saved, setItem: (_k, v) => { saved = v; } };
  t.after(() => { delete globalThis.localStorage; Object.assign(config, DEFAULTS); });
  loadConfig(); assert.equal(config.experimental, 0);
  const asrExtraParams = [
    { key: 'temperature', value: '0', enabled: true, preset: true },
    { key: 'condition_on_previous_text', value: 'False', enabled: false, preset: true },
    { key: 'hotwords', value: '', enabled: true, preset: false },
  ];
  setConfig({ experimental: 1, asrBaseUrl: 'https://asr.example', asrApiKey: 'asr-secret',
    asrPrompt: 'Lingua\nTrack', asrWordTimestamps: true, asrExtraParams });
  Object.assign(config, DEFAULTS); loadConfig();
  assert.equal(config.experimental, 1); assert.equal(config.asrApiKey, 'asr-secret');
  assert.equal(config.apiKey, ''); assert.equal(config.apiToken, '');
  assert.equal(config.asrPrompt, 'Lingua\nTrack'); assert.equal(config.asrWordTimestamps, true);
  assert.deepEqual(config.asrExtraParams, asrExtraParams);
  assert.deepEqual(DEFAULTS.asrExtraParams, []);
  setConfig({ experimental: 0 });
  assert.equal(JSON.parse(saved).experimental, 0);
});

test('16 kHz PCM WAV header and interleaving preserve distinct left and right channels', async () => {
  const wav = encodeWav([new Float32Array([-1, 0, 1]), new Float32Array([0.5, -0.5, 0.25])]);
  const buf = await wav.arrayBuffer(); const v = new DataView(buf);
  assert.equal(new TextDecoder().decode(buf.slice(0, 4)), 'RIFF');
  assert.equal(v.getUint16(20, true), 1); assert.equal(v.getUint16(22, true), 2);
  assert.equal(v.getUint32(24, true), 16000); assert.equal(v.getUint32(28, true), 64000);
  assert.equal(v.getUint16(32, true), 4); assert.equal(v.getUint16(34, true), 16);
  assert.equal(v.getUint32(40, true), 12); assert.equal(v.getUint32(4, true), buf.byteLength - 8);
  assert.deepEqual(Array.from({ length: 6 }, (_, i) => v.getInt16(44 + i * 2, true)),
    [-32768, 16384, 0, -16384, 32767, 8192]);
});

test('mono and multichannel WAVs retain channel count and clamp PCM safely', async () => {
  for (const count of [1, 6]) {
    const wav = encodeWav(Array.from({ length: count }, () => new Float32Array([2, -2, NaN])));
    const v = new DataView(await wav.arrayBuffer());
    assert.equal(v.getUint16(22, true), count);
    assert.equal(v.getInt16(44, true), 32767);
    assert.equal(v.getInt16(44 + count * 2, true), -32768);
    assert.equal(v.getInt16(44 + count * 4, true), 0);
  }
  assert.throws(() => encodeWav([]));
  assert.throws(() => encodeWav([new Float32Array(3), new Float32Array(2)]));
});

test('listening WAV preserves original rate and Float32 samples without quantization', async () => {
  const left = new Float32Array([0.123456789, -0.7654321, 1.25]);
  const right = new Float32Array([-0.3333333, 0.00000001, -1.25]);
  const bytes = await encodeWav([left, right], 44100, true).arrayBuffer();
  const v = new DataView(bytes);
  assert.equal(sourceSampleRate(bytes), 44100);
  assert.equal(v.getUint16(20, true), 3); assert.equal(v.getUint16(34, true), 32);
  for (let i = 0; i < left.length; i++) {
    assert.equal(v.getFloat32(44 + i * 8, true), left[i]);
    assert.equal(v.getFloat32(48 + i * 8, true), right[i]);
  }
});

test('source rate is extracted from nested MP4 audio description, not guessed from browser defaults', () => {
  const box = (tag, payload) => {
    const out = Buffer.alloc(8 + payload.length); out.writeUInt32BE(out.length); out.write(tag, 4); payload.copy(out, 8); return out;
  };
  const audio = Buffer.alloc(28); audio.writeUInt32BE(48000 * 65536, 24);
  let inner = box('stsd', Buffer.concat([Buffer.alloc(8), box('mp4a', audio)]));
  for (const name of ['stbl', 'minf', 'mdia', 'trak', 'moov']) inner = box(name, inner);
  const mp4 = Buffer.concat([box('ftyp', Buffer.from('isom')), inner]);
  assert.equal(sourceSampleRate(mp4.buffer.slice(mp4.byteOffset, mp4.byteOffset + mp4.length)), 48000);
  assert.throws(() => sourceSampleRate(new ArrayBuffer(100)), /采样率/);
});

test('conversion validates files before decoding and respects cancellation', async () => {
  await assert.rejects(convertMedia(new Blob()), /非空/);
  const controller = new AbortController(); controller.abort();
  const old = globalThis.OfflineAudioContext;
  globalThis.OfflineAudioContext = class {};
  try { await assert.rejects(convertMedia(audio(), { signal: controller.signal }), { name: 'AbortError' }); }
  finally { if (old) globalThis.OfflineAudioContext = old; else delete globalThis.OfflineAudioContext; }
});

test('PCM WAV reuses original bytes without decoding or changing bit depth', async (t) => {
  const file = new File([encodeWav([new Float32Array([0.25])], 48000)], 'lesson.wav');
  t.mock.method(file, 'arrayBuffer', () => { throw new Error('must only read headers'); });
  const output = await extractMedia(file);
  assert.equal(output.sampleRate, 48000); assert.equal(output.buffer, undefined);
  assert.equal(output.file.size, file.size);
  assert.equal(new DataView(await output.file.arrayBuffer()).getUint16(34, true), 16);
});

test('57 MiB WAV converts through bounded windows without reading the full source', async (t) => {
  const size = 57 * 1024 * 1024;
  const header = await encodeWav([new Float32Array(1), new Float32Array(1)], 48000).slice(0, 44).arrayBuffer();
  const view = new DataView(header); view.setUint32(4, size + 36, true); view.setUint32(40, size, true);
  const chunk = new Blob([new Uint8Array(1024 * 1024)]);
  const file = new File([header, ...Array(57).fill(chunk)], 'lesson.lossless.wav', { type: 'audio/wav' });
  t.mock.method(file, 'arrayBuffer', () => { throw new Error('must not decode whole input'); });
  const windows = [];
  const old = globalThis.OfflineAudioContext;
  t.after(() => { if (old) globalThis.OfflineAudioContext = old; else delete globalThis.OfflineAudioContext; });
  globalThis.OfflineAudioContext = class {
    constructor(_channels, frames, rate) { this.rate = rate; this.frames = frames; this.destination = {}; }
    async decodeAudioData(bytes) {
      windows.push(bytes.byteLength);
      const frames = new DataView(bytes).getUint32(40, true) / 4;
      return { numberOfChannels: 2, duration: frames / this.rate, length: frames, sampleRate: this.rate };
    }
    createBufferSource() { return { connect() {}, start() {}, disconnect() {} }; }
    async startRendering() { return { numberOfChannels: 2, sampleRate: this.rate, length: this.frames,
      duration: this.frames / this.rate, getChannelData: () => new Float32Array(this.frames) }; }
  };
  const out = await convertMedia({ file });
  assert.ok(windows.length > 20); assert.ok(windows.every((bytes) => bytes < 2400000));
  assert.equal(out.file.name, 'lesson.16k.mp3');
  assert.equal(out.file.type, 'audio/mpeg');
  assert.ok(out.file.size < Math.round(size / 4 / 48000 * 16000) * 4 / 7);
  assert.equal(out.sampleRate, 16000); assert.equal(out.bitrate, 64);
  await out.release();
});

test('cancel during full-stream compatibility decode discards its result', async (t) => {
  const controller = new AbortController();
  const file = new File([encodeWav([new Float32Array(4800)], 48000)], 'lesson.lossless.wav');
  const old = globalThis.OfflineAudioContext;
  t.after(() => { if (old) globalThis.OfflineAudioContext = old; else delete globalThis.OfflineAudioContext; });
  let calls = 0;
  globalThis.OfflineAudioContext = class {
    async decodeAudioData() {
      if (++calls === 1) return { numberOfChannels: 1, duration: 0 };
      controller.abort();
      return { getChannelData() { throw new Error('cancelled PCM must not be encoded'); } };
    }
  };
  await assert.rejects(convertMedia({ file }, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls, 2);
});

test('custom fields serialize scalars, structured values and repeated array keys', async (t) => {
  const extraParams = JSON.stringify({ temperature: 0, vad_filter: false, suffix: '',
    options: { beam: 5 }, languages: ['en', 'ja'], 'hotwords[]': ['Lingua', 'Track'] });
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    assert.equal(init.body.get('temperature'), '0');
    assert.equal(init.body.get('vad_filter'), 'false');
    assert.equal(init.body.get('suffix'), '');
    assert.equal(init.body.get('options'), '{"beam":5}');
    assert.equal(init.body.get('languages'), '["en","ja"]');
    assert.deepEqual(init.body.getAll('hotwords[]'), ['Lingua', 'Track']);
    return Response.json({ text: 'Hello' });
  });
  await transcribe(audio(), options({ extraParams }));
  assert.deepEqual(parseExtraParams(''), []);
});

test('malformed custom parameters and built-in collisions fail before any upload', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('must not upload'); });
  for (const extraParams of ['{', '[]', 'null', '"text"', '{"file":"bad"}', '{"model":"bad"}',
    '{"response_format":"srt"}', '{"stream":true}', '{"timestamp_granularities[]":["word"]}', '{"":1}']) {
    await assert.rejects(transcribe(audio(), options({ extraParams })), /自定义参数|流式转录/);
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test('key-value fields send only enabled values, including zero, false and empty strings', async (t) => {
  const extraParams = [
    { key: 'batch_size', value: '24', enabled: false },
    { key: ' temperature ', value: '0', enabled: true },
    { key: 'condition_on_previous_text', value: 'false', enabled: true },
    { key: 'suffix', value: '', enabled: true },
    { key: '', value: '', enabled: false },
    { key: 'model', value: 'ignored', enabled: false },
    { key: '__proto__', value: 'literal', enabled: true },
  ];
  t.mock.method(globalThis, 'fetch', async (_url, { body }) => {
    assert.equal(body.has('batch_size'), false);
    assert.equal(body.get('temperature'), '0');
    assert.equal(body.get('condition_on_previous_text'), 'false');
    assert.equal(body.get('suffix'), '');
    assert.equal(body.get('model'), 'whisper-1');
    assert.equal(body.get('__proto__'), 'literal');
    return Response.json({ text: 'Hello' });
  });
  await transcribe(audio(), options({ extraParams }));
});

test('invalid or conflicting key-value fields fail before upload', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('must not upload'); });
  for (const keys of [[''], ['model'], ['stream[]'], ['--beam_size'], ['bad\nname'], ['temperature', ' temperature ']]) {
    const extraParams = keys.map((key) => ({ key, value: '0', enabled: true }));
    await assert.rejects(transcribe(audio(), options({ extraParams })), /自定义参数|流式转录/);
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test('endpoint normalization accepts root, v1, custom prefix and complete transcription URL', () => {
  for (const base of ['https://asr.example', 'https://asr.example/', 'https://asr.example/v1/',
    'https://asr.example/v1/audio/transcriptions/']) {
    assert.equal(transcriptionEndpoint(base), 'https://asr.example/v1/audio/transcriptions');
  }
  assert.equal(transcriptionEndpoint('https://asr.example/proxy/v1'), 'https://asr.example/proxy/v1/audio/transcriptions');
  assert.equal(transcriptionEndpoint('https://asr.example/custom/audio/transcriptions'), 'https://asr.example/custom/audio/transcriptions');
  for (const invalid of ['', '/api', 'ftp://asr.example', 'https://user:pass@asr.example',
    'https://asr.example?key=secret', 'https://asr.example/#fragment']) assert.throws(() => transcriptionEndpoint(invalid));
});

test('transcription sends multipart audio and only the dedicated ASR key with optional word timestamps', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, 'https://asr.example/v1/audio/transcriptions');
    const headers = new Headers(init.headers);
    assert.equal(headers.get('Authorization'), 'Bearer asr-secret');
    assert.equal(headers.has('Content-Type'), false);
    assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'error');
    assert.equal(init.body.get('file').name, 'lesson.wav');
    assert.equal(await init.body.get('file').text(), 'audio');
    assert.equal(init.body.get('model'), 'whisper-1'); assert.equal(init.body.get('language'), 'ja');
    assert.equal(init.body.get('prompt'), 'Lingua');
    assert.deepEqual(init.body.getAll('timestamp_granularities[]'), ['word', 'segment']);
    return Response.json({ text: 'こんにちは', words: [{ word: 'こんにちは', start: 0, end: 1 }] });
  });
  const result = await transcribe(audio(), options({ asrLanguage: 'ja', prompt: ' Lingua ', wordTimestamps: true,
    apiKey: 'chat-secret', apiToken: 'backend-secret' }));
  assert.equal(result.file.name, 'lesson.json');
  assert.equal(JSON.parse(result.content).words[0].start, 0);
});

test('JSON/text/SRT/VTT results preserve content and omit unsupported timestamps and empty auth', async (t) => {
  for (const [format, raw, ext] of [['json', '{"text":"Hello"}', 'json'], ['text', 'Hello', 'txt'],
    ['srt', '1\n00:00:00,000 --> 00:00:01,000\nHello\n', 'srt'], ['vtt', 'WEBVTT\n\n00:00.000 --> 00:01.000\nHello', 'vtt']]) {
    t.mock.method(globalThis, 'fetch', async (_url, init) => {
      assert.equal(new Headers(init.headers).has('Authorization'), false);
      assert.equal(init.body.has('timestamp_granularities[]'), false);
      assert.equal(init.body.has('language'), false);
      assert.equal(init.body.has('prompt'), false);
      assert.equal(init.body.get('response_format'), format);
      return new Response(raw);
    });
    const result = await transcribe(audio(), options({ asrFormat: format, asrApiKey: '', wordTimestamps: true }));
    assert.equal(result.file.name, 'lesson.' + ext);
    if (format !== 'json') assert.equal(result.content, raw);
    t.mock.restoreAll();
  }
});

test('OpenAI top-level word timestamps remain usable by the subtitle parser', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({
    segments: [{ text: 'Hello.', start: 0, end: 1 }, { text: 'World.', start: 1, end: 2 }],
    words: [{ word: 'Hello.', start: 0, end: 1.02 }, { word: 'World.', start: 1.02, end: 2 }],
  }));
  const data = JSON.parse((await transcribe(audio(), options())).content);
  assert.deepEqual(data.segments[0].words, [data.words[0]]);
  assert.deepEqual(data.segments[1].words, [data.words[1]]);
});

test('failed responses are actionable without echoing server secrets or HTML', async (t) => {
  for (const status of [400, 401, 403, 404, 413, 429, 500]) {
    t.mock.method(globalThis, 'fetch', async () => new Response('<script>secret</script>', { status }));
    await assert.rejects(transcribe(audio(), options()), (e) => e.message.includes('HTTP ' + status)
      && !e.message.includes('secret') && !e.message.includes('<script>'));
    t.mock.restoreAll();
  }
  for (const raw of ['', 'not json', '{}', '{"error":"secret"}']) {
    t.mock.method(globalThis, 'fetch', async () => new Response(raw));
    await assert.rejects(transcribe(audio(), options())); t.mock.restoreAll();
  }
  t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(transcribe(audio(), options()), /CORS/);
});

test('cancellation aborts an in-flight transcription and invalid parameters never reach fetch', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
  }));
  const controller = new AbortController();
  const pending = transcribe(audio(), options(), { signal: controller.signal }); controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  for (const extra of [{ asrModel: '' }, { asrFormat: 'xml' }, { asrLanguage: 'English' }, { asrTimeout: 0 }]) {
    await assert.rejects(transcribe(audio(), options(extra)));
  }
  assert.equal(fetch.mock.callCount(), 1);
});

test('transcription timeout aborts the request with a retry hint', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(globalThis, 'fetch', async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
  }));
  const pending = transcribe(audio(), options({ asrTimeout: 1 }));
  t.mock.timers.tick(1000);
  await assert.rejects(pending, /超时/);
});
