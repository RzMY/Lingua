import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeAsrMp3, mp3Writer } from '../web/js/asr-mp3.js';

for (const channels of [1, 2]) test(`real MP3 frames are 16 kHz with ${channels} channels at the configured bitrate`, async () => {
  const pcm = Array.from({ length: channels }, (_, ch) => Float32Array.from({ length: 16000 * 3 },
    (_, i) => 0.3 * Math.sin(2 * Math.PI * (440 + ch * 440) * i / 16000)));
  const result = await encodeAsrMp3({ numberOfChannels: channels, sampleRate: 16000, length: pcm[0].length,
    getChannelData: (ch) => pcm[ch] }, 'lesson.lossless.m4a');
  try {
    assert.equal(result.file.name, 'lesson.16k.mp3'); assert.equal(result.file.type, 'audio/mpeg');
    assert.ok(result.file.size < pcm[0].length * channels * 2 / 7);
    const data = new Uint8Array(await result.file.arrayBuffer());
    let frames = 0;
    for (let at = 0; at < data.length;) {
      assert.equal(data[at], 255); assert.equal(data[at + 1] & 0xfe, 0xf2); // MPEG-2 Layer III
      const rate = [22050, 24000, 16000][(data[at + 2] >> 2) & 3];
      const kbps = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160][data[at + 2] >> 4];
      assert.equal(rate, 16000); assert.equal(kbps, channels === 1 ? 32 : 64);
      assert.equal(data[at + 3] >> 6 === 3 ? 1 : 2, channels);
      at += Math.floor(72000 * kbps / rate) + ((data[at + 2] >> 1) & 1);
      assert.ok(at <= data.length); frames++;
    }
    assert.ok(Math.abs(frames * 576 - pcm[0].length) < 2048);
  } finally { await result.release(); }
});

test('unsupported channel counts fail explicitly instead of dropping channels', async () => {
  await assert.rejects(mp3Writer('surround.wav', 6), /多声道/);
});
