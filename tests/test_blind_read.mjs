import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BlindReadProgress, normalizeBlindRead } from '../web/js/blind-read.js';

const fixture = () => ({ sentences: [
  { start: 0, end: 5, text: 'We were running.', words: [
    { text: 'We', pos: 'pron' }, { text: 'were', pos: 'aux', read: 'wɜː', roman: 'be' },
    { text: 'running', pos: 'verb', read: 'ˈrʌnɪŋ', roman: 'run' }, { text: '.', pos: 'punct' },
  ] },
  { start: 5, end: 10, text: 'Again', words: [{ text: 'Again', pos: 'adv' }] },
] });

test('reveal progress restores individual segmented words and excludes punctuation/whitespace', () => {
  const track = fixture(), progress = new BlindReadProgress(track);
  assert.equal(progress.reveal(0, 2), true);
  assert.equal(progress.reveal(0, 2), false);
  assert.equal(progress.reveal(0, 3), false);
  assert.equal(progress.reveal(12, 0), false);
  track.sentences[1].words.push({ text: ' ', pos: 'other' });
  assert.equal(progress.reveal(1, 1), false);
  const restored = new BlindReadProgress(track, JSON.parse(JSON.stringify(progress.snapshot(true))));
  assert.equal(restored.has(0, 2), true);
  assert.equal(restored.has(0, 1), false);
  assert.equal(restored.snapshot(false).enabled, false);
  assert.equal(restored.snapshot(false).revealed[0].words.length, 1);
});

test('changed segmentation, phonetics, forms or boundaries invalidate only the edited sentence', () => {
  const track = fixture(), progress = new BlindReadProgress(track);
  progress.reveal(0, 2); progress.reveal(1, 0);
  const saved = progress.snapshot(true);
  for (const edit of [
    (s) => s.words.splice(0, 1), (s) => { s.words[2].read = 'changed'; },
    (s) => { s.words[2].roman = 'changed'; }, (s) => { s.start = 1; },
    (s) => { s.text = 'Changed'; },
  ]) {
    const changed = fixture(); edit(changed.sentences[0]);
    const restored = new BlindReadProgress(changed, saved);
    assert.equal(restored.has(0, 2), false);
    assert.equal(restored.has(1, 0), true);
  }
  track.sentences[0].translation = '译文';
  assert.equal(new BlindReadProgress(track, saved).has(0, 2), true);
});

test('corrupt reveal records normalize safely and out-of-range indices are discarded on restore', () => {
  for (const value of [null, [], 'blind', { enabled: 'false', revealed: [] }]) {
    assert.deepEqual(normalizeBlindRead(value), { enabled: false, revealed: {} });
  }
  const track = fixture(), progress = new BlindReadProgress(track);
  progress.reveal(0, 1);
  const saved = progress.snapshot(true);
  saved.revealed[0].words.push(-1, '2', 1, 400, NaN);
  saved.revealed.bad = { signature: 'bad', words: [0] };
  assert.deepEqual(new BlindReadProgress(track, saved).snapshot(true).revealed[0].words, [1]);
});

test('translation reveals restore independently and follow the exact translation language/content', () => {
  const track = fixture(), progress = new BlindReadProgress(track), s = track.sentences[0];
  assert.equal(progress.revealTranslation(0), false);
  Object.assign(s, { translation: '我们在跑步。', translationLang: 'zh-CN' });
  assert.equal(progress.revealTranslation(0), true);
  assert.equal(progress.has(0, 0), false);
  const saved = progress.snapshot(false), restored = new BlindReadProgress(track, saved);
  assert.equal(restored.hasTranslation(0), true);
  s.translationLang = 'zh-TW';
  assert.equal(restored.hasTranslation(0), false);
  restored.revealTranslation(0);
  s.translationLang = 'zh-CN';
  assert.equal(restored.hasTranslation(0), true);
  s.translation = '修改后的译文';
  assert.equal(restored.hasTranslation(0), false);
  s.words[0].text = 'Changed';
  assert.equal(new BlindReadProgress(track, saved).translations.size, 0);
});

test('whole-sentence reveal includes translation and preserves other sentences across restore', () => {
  const track = fixture(), progress = new BlindReadProgress(track);
  Object.assign(track.sentences[0], { translation: '我们在跑步。', translationLang: 'zh-CN' });
  progress.reveal(1, 0);
  assert.equal(progress.revealSentence(0), true);
  assert.equal(progress.revealSentence(0), false);
  assert.equal(progress.revealSentence(99), false);
  const restored = new BlindReadProgress(track, progress.snapshot(true));
  assert.deepEqual(restored.snapshot(true).revealed[0].words, [0, 1, 2]);
  assert.equal(restored.hasTranslation(0), true);
  assert.equal(restored.has(1, 0), true);
});

test('hiding a sentence clears partial reveals and all its translation variants durably', () => {
  const track = fixture(), progress = new BlindReadProgress(track), s = track.sentences[0];
  progress.reveal(0, 1); progress.reveal(1, 0);
  Object.assign(s, { translation: '我们在跑步。', translationLang: 'zh-CN' });
  progress.revealTranslation(0);
  s.translationLang = 'zh-TW'; progress.revealTranslation(0);
  assert.equal(progress.hideSentence(0), true);
  assert.equal(progress.hideSentence(0), false);
  assert.equal(progress.hideSentence(99), false);
  const saved = progress.snapshot(true), restored = new BlindReadProgress(track, saved);
  assert.equal(saved.revealed[0], undefined);
  assert.equal(saved.translations, undefined);
  assert.equal(restored.has(0, 1), false);
  assert.equal(restored.hasTranslation(0), false);
  s.translationLang = 'zh-CN';
  assert.equal(restored.hasTranslation(0), false);
  assert.equal(restored.has(1, 0), true);
  progress.revealTranslation(0);
  assert.equal(progress.hideSentence(0), true, 'translation-only reveals can also be hidden');
});
