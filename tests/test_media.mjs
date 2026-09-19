import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mediaKind, isMediaFile, MEDIA_ACCEPT } from '../web/js/media.js';
import { createTrack, audioBlob, getTrack } from '../web/js/library.js';

test('video detection honors MIME types and falls back to container extensions', () => {
  for (const name of ['lesson.MP4', 'lesson.webm', 'lesson.mov', 'lesson.m4v', 'lesson.ogv', 'lesson.mkv']) {
    assert.equal(mediaKind({ name }), 'video');
    assert.equal(isMediaFile({ name, type: 'application/octet-stream' }), true);
  }
  assert.equal(mediaKind({ name: 'recording', type: 'video/webm' }), 'video');
  assert.equal(mediaKind({ name: 'recording.webm', type: 'audio/webm' }), 'audio');
  assert.equal(mediaKind({ name: 'lecture.mp4', type: 'audio/mp4' }), 'audio');
  for (const name of ['song.mp3', 'lesson.m4a', 'lecture.ogg']) assert.equal(mediaKind({ name }), 'audio');
  assert.equal(isMediaFile({ name: 'subtitle.srt', type: 'text/plain' }), false);
  assert.ok(MEDIA_ACCEPT.includes('video/*'));
});

test('direct video import preserves original bytes and metadata for playback', async () => {
  const bytes = new Uint8Array([0, 1, 2, 255]);
  const file = new File([bytes], 'video-import.webm', { type: 'video/webm' });
  const record = await createTrack(file, { lang: 'en' });
  assert.equal(record.status, 'new');
  assert.equal(mediaKind((await getTrack(record.id)).audio), 'video');
  assert.deepEqual(new Uint8Array(await (await audioBlob(record.id)).arrayBuffer()), bytes);
  await assert.rejects(createTrack(new File(['text'], 'not-media.txt')), /音频或视频/);
  await assert.rejects(createTrack(new File([], 'empty.mp4')), /非空/);
});
