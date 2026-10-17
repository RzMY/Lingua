import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { createFakeIndexedDB } from './idb_fake.mjs';
import { VOICE_PACKS, VOICE_REVISION, VOICE_RUNTIME_KEY, SUPERTONIC_GROUP, SUPERTONIC_REVISION, packKey } from '../web/js/voice-pack-catalog.js';
import { normalizedSpeechPCM } from '../web/js/speech-pcm.js';
import { AudioLoudness } from '../web/js/audio-loudness.js';

const fake = createFakeIndexedDB();
globalThis.indexedDB = fake;
const store = await import('../web/js/store.js');
const packs = await import('../web/js/voice-packs.js');
const tone = (amplitude) => Float32Array.from({ length: 16000 }, (_, i) => amplitude * Math.sin(2 * Math.PI * 1000 * i / 16000));
const loudness = (pcm) => { const meter = new AudioLoudness(16000, 1); meter.add([pcm]); return meter.value(); };

test('package PCM matches actual loudness rather than applying the Web Speech 50% attenuation', () => {
  for (const amplitude of [.03, .08, .2]) {
    const original = tone(amplitude), rendered = normalizedSpeechPCM(original, 16000, -24);
    assert.ok(Math.abs(loudness(rendered) - (-24)) < .001);
    assert.deepEqual(normalizedSpeechPCM(original, 16000), original, 'disabled balance is unity');
    assert.equal(original[4], tone(amplitude)[4], 'input is not changed');
  }
  assert.ok(normalizedSpeechPCM(tone(.8), 16000, 0).every((n) => Math.abs(n) <= 10 ** (-1 / 20) + 1e-7));
  assert.ok(normalizedSpeechPCM(tone(.001), 16000, -10).every((n) => Math.abs(n) <= .00400001));
  assert.ok(normalizedSpeechPCM(tone(.2), 16000, -Infinity).every((n) => n === 0));
  assert.ok(normalizedSpeechPCM(new Float32Array(400), 16000, -20).every((n) => n === 0));
  assert.throws(() => normalizedSpeechPCM(Float32Array.of(NaN), 16000), /采样/);
  assert.throws(() => normalizedSpeechPCM(new Float32Array(480001), 16000), /30 秒/);
});

test('stream downloads validate HTTP, exact bytes and SHA-256 and propagate cancellation', async () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const file = { url: 'https://example.test/model', size: 4, hash: createHash('sha256').update(bytes).digest('hex') };
  const progress = [];
  const output = await packs.downloadVoiceFile(file, { fetcher: async () => new Response(bytes), onProgress: (n) => progress.push(n) });
  assert.deepEqual(new Uint8Array(output), bytes); assert.deepEqual(progress, [4]);
  for (const response of [new Response(bytes, { status: 404 }), new Response(bytes.slice(0, 3)), new Response(new Uint8Array(5)), new Response(new Uint8Array(4))]) {
    await assert.rejects(packs.downloadVoiceFile(file, { fetcher: async () => response }), /下载|校验/);
  }
  const controller = new AbortController();
  await assert.rejects(packs.downloadVoiceFile(file, { signal: controller.signal, fetcher: async () => new Response(bytes),
    onProgress: () => controller.abort() }), { name: 'AbortError' });
});

test('voice assets commit separately from lessons and caches; deletion preserves the shared runtime', async () => {
  const id = VOICE_PACKS[0].id;
  await store.writeBatch({ voicePacks: [{ key: id, value: { revision: VOICE_REVISION, model: new ArrayBuffer(2), config: new ArrayBuffer(2) } },
    { key: VOICE_RUNTIME_KEY, value: {} }], voicePackMeta: [{ key: id, value: { id, revision: VOICE_REVISION } }] }, { persistent: true });
  await packs.refreshVoicePacks(); assert.ok(packs.installedVoicePack(id));
  await store.clearAll(); assert.ok(await store.get('voicePacks', id));
  fake.holdRequest = (tx, request) => {
    if (tx.mode === 'readwrite') request.error = new DOMException('disk unavailable', 'UnknownError');
    return false;
  };
  await assert.rejects(packs.removeVoicePack(id), { name: 'UnknownError' });
  fake.holdRequest = null;
  assert.ok(await store.get('voicePacks', id)); assert.ok(packs.installedVoicePack(id));
  await packs.removeVoicePack(id);
  assert.equal(await store.get('voicePacks', id), undefined);
  assert.equal(await store.get('voicePackMeta', id), undefined);
  assert.equal(packs.installedVoicePack(id), false);
  assert.ok(await store.get('voicePacks', VOICE_RUNTIME_KEY), 'common runtime remains reusable');
});

test('missing/deleted or wrong-language packages fail explicitly without system TTS fallback', async (t) => {
  globalThis.Worker = class {};
  globalThis.AudioContext = class {};
  t.after(() => { delete globalThis.Worker; delete globalThis.AudioContext; });
  const key = packKey(VOICE_PACKS[0].id);
  await assert.rejects(packs.synthesizeVoicePack(key, 'Hello', 'ja'), /当前语言/);
  await assert.rejects(packs.synthesizeVoicePack(key, 'Hello', 'en'), /尚未下载或已删除/);
  await assert.rejects(packs.synthesizeVoicePack(key, 'a'.repeat(2001), 'en'), /2000/);
});

test('shared Japanese/Korean models delete atomically only with the last related style', async () => {
  const ids = ['ja_JP-supertonic3-female', 'ko_KR-supertonic3-male'];
  await store.writeBatch({
    voicePacks: [...ids.map((key) => ({ key, value: { revision: SUPERTONIC_REVISION } })),
      { key: SUPERTONIC_GROUP, value: { revision: SUPERTONIC_REVISION } }],
    voicePackMeta: [...ids.map((id) => ({ key: id, value: { id, revision: SUPERTONIC_REVISION, group: SUPERTONIC_GROUP } })),
      { key: SUPERTONIC_GROUP, value: { id: SUPERTONIC_GROUP, revision: SUPERTONIC_REVISION } }],
  });
  await packs.refreshVoicePacks(); assert.ok(packs.hasSupertonicModels());
  await packs.removeVoicePack(ids[0]); assert.ok(await store.get('voicePacks', SUPERTONIC_GROUP));
  assert.ok(packs.installedVoicePack(ids[1])); assert.ok(packs.hasSupertonicModels());
  fake.holdRequest = (tx, request) => { if (tx.mode === 'readwrite') request.error = new DOMException('disk unavailable', 'UnknownError'); return false; };
  await assert.rejects(packs.removeVoicePack(ids[1]), { name: 'UnknownError' }); fake.holdRequest = null;
  assert.ok(await store.get('voicePacks', SUPERTONIC_GROUP)); assert.ok(packs.installedVoicePack(ids[1]));
  await packs.removeVoicePack(ids[1]); assert.equal(await store.get('voicePacks', SUPERTONIC_GROUP), undefined);
  assert.equal(await store.get('voicePackMeta', SUPERTONIC_GROUP), undefined); assert.equal(packs.hasSupertonicModels(), false);
});
