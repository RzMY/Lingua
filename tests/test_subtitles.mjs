import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSubtitles, plainTrack } from '../web/js/subtitles.js';
import { createTrack, savePreparedTranscript, trackData, transcriptBlob, getTrack } from '../web/js/library.js';
import { Track } from '../web/js/track.js';

test('local SRT and VTT preserve timed text without interpreting markup', () => {
  const srt = '\uFEFF1\r\n00:00:01,000 --> 00:00:03,500\r\n<b>Hello</b> &amp; welcome.\r\nSecond line.\r\n';
  assert.deepEqual(parseSubtitles(srt, 'a.srt'), [
    { start: 1, end: 3.5, text: 'Hello & welcome. Second line.' },
  ]);
  assert.deepEqual(parseSubtitles('WEBVTT\n\nNOTE ignore\n00:00:00.000 --> 00:00:01.000\nignore\n\ncue\n00:01.000 --> 00:03.500 align:start\n<00:01.200>こんにちは\n', 'a.vtt'),
    [{ start: 1, end: 3.5, text: 'こんにちは' }]);
});

test('JSON aliases and overlapping cues produce a monotonic timeline', () => {
  const rows = parseSubtitles(JSON.stringify({ segments: [
    { start_time: 2, end_time: 4, text: 'World' },
    { start: 0, end: 3, text: 'Hello' },
    { start: 0, end: 2, text: '你好' },
    { start: -1, end: 2, text: 'bad' },
  ] }), 'test.json');
  assert.deepEqual(rows, [{ start: 0, end: 2, text: 'Hello\n你好' }, { start: 2, end: 4, text: 'World' }]);
  assert.deepEqual(parseSubtitles('{"words":[{"word":"Hi","start":0,"end":1}]}', 'words.json'),
    [{ start: 0, end: 1, text: 'Hi' }]);
  assert.throws(() => parseSubtitles('{broken', 'bad.json'), /JSON/);
  assert.throws(() => parseSubtitles('no timings', 'bad.srt'), /时间戳/);
});

test('media-only and raw-subtitle tracks work with the existing playback index', () => {
  const record = { id: 'raw', title: 'Lesson', lang: 'ja', duration: 30 };
  const empty = Track.fromData(plainTrack(record));
  assert.equal(empty.S, 0);
  assert.equal(empty.duration, 30);
  const raw = plainTrack(record, [{ start: 1, end: 4, text: '今日は Hello world.' }]);
  assert.equal(raw.sentences[0].words.map((w) => w.text).join(''), '今日は Hello world.');
  const track = Track.fromData(raw);
  assert.equal(track.S, 1);
  assert.equal(track.N, 0);
  for (const feature of ['read', 'roman', 'pos', 'card', 'tr']) assert.equal(track.supports(feature), false);
});

test('subtitle import saves playable raw data and rejects invalid replacements without losing it', async (t) => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('No network allowed'); });
  const record = await createTrack(new File(['media'], 'optional.mp3', { type: 'audio/mpeg' }), { lang: 'en' });
  const file = new File(['1\n00:00:00,000 --> 00:00:02,000\nHello world.\n'], 'optional.srt');
  const saved = await savePreparedTranscript(record.id, file, 'en');
  assert.equal(saved.status, 'subtitles');
  assert.equal(saved.words, 0);
  assert.equal((await trackData(record.id)).subtitleMode, 'plain');
  assert.equal(await (await transcriptBlob(record.id)).text(), await file.text());
  await assert.rejects(savePreparedTranscript(record.id, new File(['broken'], 'bad.srt')), /时间戳/);
  assert.equal((await getTrack(record.id)).status, 'subtitles');
  assert.equal((await trackData(record.id)).sentences[0].text, 'Hello world.');
});
