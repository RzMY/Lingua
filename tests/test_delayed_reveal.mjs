import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DelayedRevealProgress } from '../web/js/delayed-reveal.js';

test('words wait for their exact ends; translation leads the last word, excluding trailing punctuation', () => {
  const progress = new DelayedRevealProgress({ sentences: [{ start: 2, end: 10, wordTiming: true, words: [
    { text: 'One', start: 2, end: 3 }, { text: 'two', start: 4, end: 8 },
    { text: '.', pos: 'punct', start: 8, end: 10 },
  ] }] });
  progress.setTime(2.999);
  assert.equal(progress.has(0, 0), false);
  progress.setTime(3);
  assert.equal(progress.has(0, 0), true);
  assert.equal(progress.has(0, 1), false);
  progress.setTime(7.499);
  assert.equal(progress.hasTranslation(0), false);
  progress.setTime(7.5);
  assert.equal(progress.hasTranslation(0), true);
  assert.equal(progress.has(0, 1), false);
  progress.setTime(8);
  assert.equal(progress.has(0, 1), true);
  assert.equal(progress.has(0, 2), false);
  const endState = progress.state(0);
  progress.setTime(20);
  assert.equal(progress.state(0), endState, 'a gap needs no DOM repaint');
  progress.setTime(2.5);
  assert.equal(progress.state(0), 0);
  assert.equal(progress.has(0, 0), false);
  assert.equal(progress.hasTranslation(0), false);
});

test('mixed timing falls back per word and short sentence translations never appear at the start', () => {
  const progress = new DelayedRevealProgress({ sentences: [
    { start: 0, end: 0.2, wordTiming: false, words: [{ text: 'Yes', start: 0, end: 0.1 }] },
    { start: 1, end: 2, wordTiming: true, words: [
      { text: 'A', start: 1, end: 1.2 }, { text: 'B' }, { text: ' ', pos: 'other' },
    ] },
  ] });
  progress.setTime(0);
  assert.equal(progress.hasTranslation(0), false);
  progress.setTime(0.19);
  assert.equal(progress.hasTranslation(0), true);
  assert.equal(progress.has(0, 0), false);
  progress.setTime(0.2);
  assert.equal(progress.has(0, 0), true);
  progress.setTime(1.5);
  assert.equal(progress.has(1, 0), true);
  assert.equal(progress.has(1, 1), false);
  progress.setTime(2);
  assert.equal(progress.has(1, 1), true);
  assert.equal(progress.has(1, 2), false);
});
