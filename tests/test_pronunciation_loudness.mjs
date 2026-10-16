import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { balancedSpeechVolume, measureAudioRms, measureAudioLevels, createPronunciationLoudness,
  speechLoudnessTarget, CALIBRATION_REFERENCE_LUFS } from '../web/js/pronunciation-loudness.js';
import { AudioLoudness } from '../web/js/audio-loudness.js';
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
  const pcm = new Float32Array((wav.length - 44) / 2);
  for (let i = 44; i < wav.length; i += 2) {
    const sample = wav.readInt16LE(i) / 32768;
    pcm[(i - 44) / 2] = sample;
    energy += sample * sample; peak = Math.max(peak, Math.abs(sample));
  }
  const samples = (wav.length - 44) / 2;
  assert.ok(samples / 16000 > 2 && samples / 16000 < 10);
  assert.ok(Math.abs(Math.sqrt(energy / samples) - .1) < .00001);
  assert.ok(peak < .99);
  const meter = new AudioLoudness(16000, 1); meter.add([pcm]);
  assert.ok(Math.abs(meter.value() - CALIBRATION_REFERENCE_LUFS) < .00001,
    'native calibration target must equal the actual bundled clip loudness');
});

function tone(rate, amplitude, seconds = 2, frequency = 1000) {
  return Float32Array.from({ length: Math.round(rate * seconds) },
    (_, i) => amplitude * Math.sin(2 * Math.PI * frequency * i / rate));
}

test('K weighting matches the BS.1770 1 kHz anchor and channel energy, independent of decode chunks', () => {
  for (const rate of [16000, 44100, 48000]) {
    const source = tone(rate, .1), mono = new AudioLoudness(rate, 1), stereo = new AudioLoudness(rate, 2);
    mono.add([source]); stereo.add([source, source]);
    assert.ok(Math.abs(mono.value() - (-23.0036)) < .06);
    assert.ok(Math.abs(stereo.value() - mono.value() - 10 * Math.log10(2)) < 1e-8);
    const streaming = new AudioLoudness(rate, 1);
    for (let at = 0; at < source.length; at += 1237) streaming.add([source], at, Math.min(1237, source.length - at));
    assert.equal(streaming.value(), mono.value());
  }
});

test('gates reject long silence and quiet noise without diluting audible speech', () => {
  const rate = 16000, source = tone(rate, .1), reference = new AudioLoudness(rate, 1);
  reference.add([source]);
  const padded = new AudioLoudness(rate, 1);
  padded.add([new Float32Array(rate * 5)]); padded.add([source]);
  padded.add([tone(rate, .0005, 8)]);
  // The 400 ms blocks at speech/silence boundaries retain partial speech energy.
  assert.ok(Math.abs(padded.value() - reference.value()) < .7);
  const silent = new AudioLoudness(rate, 1); silent.add([new Float32Array(rate)]);
  assert.equal(silent.value(), -Infinity);
  const short = new AudioLoudness(rate, 1); short.add([tone(rate, .1, .08)]);
  assert.ok(Number.isFinite(short.value()), 'short words still have a loudness measurement');
  const bass = new AudioLoudness(rate, 1); bass.add([tone(rate, .1, 2, 60)]);
  assert.ok(bass.value() < reference.value() - 2, 'equal RMS bass has lower perceptual weight');
});

test('native targets center default calibration on the reference and follow gain in decibels', () => {
  assert.equal(speechLoudnessTarget(), CALIBRATION_REFERENCE_LUFS);
  assert.equal(speechLoudnessTarget(-22, { volume: 1 }, .5), -22);
  assert.ok(Math.abs(speechLoudnessTarget(-22, { volume: .5 }, .5) - (-28.0206)) < .00001);
  assert.ok(Math.abs(speechLoudnessTarget(-22, undefined, 1) - (-15.9794)) < .00001);
  assert.equal(speechLoudnessTarget(-22, { volume: 1, muted: true }), -Infinity);
  assert.equal(speechLoudnessTarget(-Infinity), -Infinity);
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

test('bounded WAV decoding measures gated loudness across window boundaries without averaging window dB', async (t) => {
  const calls = wavDecoder(t), rate = 8000;
  const source = new Float32Array(rate * 25);
  source.set(tone(rate, .1, 1), rate * 11.5);
  source.set(tone(rate, .05, .5), rate * 24.5);
  const wav = encodeWav([source], rate, true);
  wav.arrayBuffer = () => { throw Error('must not read whole source'); };
  const levels = await measureAudioLevels(wav), meter = new AudioLoudness(rate, 1);
  meter.add([source]);
  assert.ok(Math.abs(levels.lufs - meter.value()) < 1e-8);
  assert.equal(calls.length, 3);
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
