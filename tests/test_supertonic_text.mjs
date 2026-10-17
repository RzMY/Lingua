import assert from 'node:assert/strict';
import { test } from 'node:test';
import { supertonicText, supertonicIds, supertonicChunks } from '../web/js/supertonic-text.js';
import { VOICE_PACKS, SUPERTONIC_FILES, SUPERTONIC_GROUP, voiceFileURL } from '../web/js/voice-pack-catalog.js';

test('Supertonic keeps Japanese Kanji and decomposes dakuten and Korean Hangul as trained', () => {
  assert.equal(supertonicText('学校で、がんばります。', 'ja'), '<ja>学校で、がんばります。</ja>');
  assert.equal(supertonicText('안녕하세요.', 'ko'), '<ko>안녕하세요.</ko>');
  assert.equal(supertonicText('ＡＢＣ １２３！😀', 'ja'), '<ja>ABC 123!</ja>');
  assert.throws(() => supertonicText('Hello', 'en'), /当前语言/);
  assert.throws(() => supertonicText('😀', 'ja'), /没有可合成/);
  assert.throws(() => supertonicText('< >', 'ja'), /没有可合成/);
  assert.ok(!supertonicText('<ko>学校<laugh>', 'ja').includes('<ko>'), 'lesson text cannot inject control tags');
});

test('Unicode indexing counts codepoints and rejects unsupported characters instead of skipping them', () => {
  const indexer = Array.from({ length: 65536 }, (_, i) => i);
  const ids = supertonicIds('学校', 'ja', indexer);
  assert.equal(ids.length, Array.from('<ja>学校.</ja>').length);
  assert.ok([...ids].includes(BigInt('学'.codePointAt(0))));
  assert.throws(() => supertonicIds('𠮷', 'ja', indexer), /部分字符/);
  indexer['学'.codePointAt(0)] = -1;
  assert.throws(() => supertonicIds('学校', 'ja', indexer), /部分字符/);
});

test('CJK text chunks bound long unspaced runs and preserve all words and punctuation', () => {
  const text = '今日も勉強します。'.repeat(25) + '안녕하세요!';
  const chunks = supertonicChunks(text);
  assert.equal(chunks.join(''), text);
  assert.ok(chunks.every((chunk) => Array.from(chunk).length <= 120));
  const long = 'あ'.repeat(250);
  assert.deepEqual(supertonicChunks(long).map((chunk) => chunk.length), [120, 120, 10]);
  const decomposed = 'あ'.repeat(119) + 'か\u3099' + 'あ'.repeat(20);
  assert.equal(supertonicChunks(decomposed)[0].at(-1), '\u3099');
});

test('Japanese and Korean styles share immutable model files and the correct upstream model license', () => {
  for (const lang of ['ja', 'ko']) {
    const voices = VOICE_PACKS.filter((item) => item.lang.startsWith(lang + '-'));
    assert.equal(voices.length, 2);
    for (const voice of voices) {
      assert.equal(voice.group, SUPERTONIC_GROUP); assert.equal(voice.engine, 'supertonic');
      assert.match(voice.license, /OpenRAIL-M/); assert.match(voice.licenseURL, /archive\/supertonic-3\/blob\/.*\/LICENSE$/);
    }
  }
  assert.equal(SUPERTONIC_FILES.filter((file) => file.path.endsWith('.onnx')).length, 4);
  for (const file of SUPERTONIC_FILES) {
    assert.match(file.hash, /^[0-9a-f]{64}$/); assert.match(file.revision, /^[0-9a-f]{40}$/);
    assert.ok(file.size > 0); assert.match(voiceFileURL(file, 'mirror'), /^https:\/\/hf-mirror.com\//);
  }
});
