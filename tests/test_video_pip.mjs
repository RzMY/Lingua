import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pipCues, pipLines } from '../web/js/video-pip.js';

test('pip subtitle lines collapse whitespace and follow the translation switch', () => {
  const sentence = { text: '  Keep\n  practising\t every day.  ', translation: ' 每天\n都练习。 ',
    words: [{ text: 'Keep' }, { text: 'practising' }] };
  assert.deepEqual(pipLines(sentence, true),
    { text: 'Keep practising every day.', translation: '每天都练习。' });
  assert.deepEqual(pipLines(sentence, false), { text: 'Keep practising every day.', translation: '' });
  assert.deepEqual(pipLines(null), { text: '', translation: '' });
});

test('sentences without text fall back to their words, punctuation included', () => {
  const sentence = { words: [{ text: 'Tap' }, { text: 'a' }, { text: 'word' }, { text: '。' }] };
  assert.equal(pipLines(sentence).text, 'Tap a word 。');
});

test('the classic track gets one cue per sentence, original over translation', () => {
  const track = {
    S: 3,
    sStart: new Float32Array([0, 4, 9]),
    sEnd: new Float32Array([4, 8, 8.5]),
    sentences: [
      { text: 'Welcome.', translation: '欢迎。' },
      { text: 'Listen.', translation: '' },
      { text: '   ', translation: '空句不出 cue' },
      { text: 'Zero length.', translation: '零长度。' },
    ],
  };
  assert.deepEqual(pipCues(track, true), [
    { start: 0, end: 4, text: 'Welcome.\n欢迎。' },
    { start: 4, end: 8, text: 'Listen.' },
  ]);
  assert.deepEqual(pipCues(track, false).map((cue) => cue.text), ['Welcome.', 'Listen.']);
});

test('zero-length sentences still get a displayable cue, and the switch hides translations', () => {
  const track = {
    S: 1,
    sStart: new Float32Array([3]),
    sEnd: new Float32Array([3]),
    sentences: [{ text: 'Hi.', translation: '你好。' }],
  };
  assert.deepEqual(pipCues(track, true), [{ start: 3, end: 3.4, text: 'Hi.\n你好。' }]);
  assert.deepEqual(pipCues(null), []);
});
