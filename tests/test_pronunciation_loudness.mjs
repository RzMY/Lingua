import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { balancedSpeechVolume, measureAudioRms, createPronunciationLoudness } from '../web/js/pronunciation-loudness.js';
import { encodeWav } from '../web/js/workbench-media.js';

test('bundled calibration speech has the RMS reference level and unclipped PCM', async () => {
  const wav = await readFile(new URL('../web/assets/pronunciation-calibration.wav', import.meta.url));
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.readUInt16LE(20), 1);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.readUInt32LE(40), wav.length - 44);
  let energy = 0, peak = 0;
  for (let i = 44; i < wav.length; i += 2) {
    const sample = wav.readInt16LE(i) / 32768;
    energy += sample * sample; peak = Math.max(peak, Math.abs(sample));
  }
  const samples = (wav.length - 44) / 2;
  assert.ok(samples / 16000 > 2 && samples / 16000 < 10);
  assert.ok(Math.abs(Math.sqrt(energy / samples) - .1) < .00001);
  assert.ok(peak < .99);
});

function wavDecoder(t, beforeDecode = async () => {}) {
  const calls = [];
  const original = globalThis.OfflineAudioContext;
  globalThis.OfflineAudioContext = class {
    async decodeAudioData(bytes) {
      calls.push(bytes.byteLength);
      await beforeDecode();
      const v = new DataView(bytes), count = v.getUint16(22, true), rate = v.getUint32(24, true);
      const frames = v.getUint32(40, true) / (count * 4);
      assert.equal(v.getUint16(20, true), 3);
      const channels = Array.from({ length: count }, (_, c) => Float32Array.from({ length: frames },
        (_, i) => v.getFloat32(44 + (i * count + c) * 4, true)));
      return { numberOfChannels: count, sampleRate: rate, length: frames,
        getChannelData: (i) => channels[i] };
    }
  };
  t.after(() => {
    if (original === undefined) delete globalThis.OfflineAudioContext;
    else globalThis.OfflineAudioContext = original;
  });
  return calls;
}

test('RMS accounts for all channels, silence and unequal final windows without full WAV reads', async (t) => {
  const calls = wavDecoder(t), rate = 8000, frames = rate * 25;
  const left = new Float32Array(frames), right = new Float32Array(frames);
  left.fill(.04, 0, rate * 12); right.fill(-.08, 0, rate * 12);
  left.fill(.02, rate * 24); right.fill(.02, rate * 24);
  const wav = encodeWav([left, right], rate, true);
  wav.arrayBuffer = () => { throw Error('must not read whole source'); };
  const rms = await measureAudioRms(wav);
  const expected = Math.sqrt(((.04 ** 2 + .08 ** 2) * 12 + (.02 ** 2 * 2)) / 50);
  assert.ok(Math.abs(rms - expected) < 1e-8);
  assert.equal(calls.length, 3);
  assert.ok(calls.every((size) => size < wav.size));
});

test('speech gain is finite, bounded, proportional to RMS and follows live player controls', () => {
  assert.equal(balancedSpeechVolume(.05), .5);
  assert.equal(balancedSpeechVolume(.2), 1);
  assert.equal(balancedSpeechVolume(0), 0);
  assert.equal(balancedSpeechVolume(.05, { volume: .4 }), .2);
  assert.equal(balancedSpeechVolume(.05, { volume: .4, muted: true }), 0);
  for (const invalid of [null, undefined, NaN, Infinity, -1]) {
    assert.equal(balancedSpeechVolume(invalid, { volume: .4 }), .4);
  }
});

test('one file measurement is reused for repeated speech and the player volume stays unchanged', async (t) => {
  const calls = wavDecoder(t), media = { volume: .8, muted: false, currentTime: 7, playbackRate: 1.5 };
  const file = encodeWav([new Float32Array(800).fill(.05)], 8000, true);
  const reference = createPronunciationLoudness(file, media);
  assert.equal(reference.volume(), .8, 'pending analysis follows player volume');
  await reference.ready;
  assert.ok(Math.abs(reference.volume() - .4) < 1e-7);
  media.volume = .2;
  assert.ok(Math.abs(reference.volume() - .1) < 1e-7);
  media.muted = true;
  assert.equal(reference.volume(), 0);
  assert.equal(calls.length, 1);
  assert.equal(media.currentTime, 7); assert.equal(media.playbackRate, 1.5);
  reference.dispose();
});

test('cancelled or failed decoding falls back without publishing a late measurement', async (t) => {
  let release, started;
  const decoding = new Promise((resolve) => { started = resolve; });
  const blocked = new Promise((resolve) => { release = resolve; });
  wavDecoder(t, () => { started(); return blocked; });
  const file = encodeWav([new Float32Array(800).fill(.02)], 8000, true);
  const old = createPronunciationLoudness(file, { volume: .7 });
  await decoding; old.dispose(); release(); await old.ready;
  assert.equal(old.volume(), .7);
  globalThis.OfflineAudioContext = class { decodeAudioData() { throw Error('unsupported codec'); } };
  const failed = createPronunciationLoudness(file, { volume: .6 });
  await failed.ready; assert.equal(failed.volume(), .6);
  failed.dispose();
});
