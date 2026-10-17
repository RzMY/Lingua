import { AudioLoudness } from './audio-loudness.js';

/** Bridge wire format is little-endian Float32, independent of device byte order. */
export function speechPCMBase64(samples) {
  const view = new DataView(new ArrayBuffer(samples.length * 4));
  for (let i = 0; i < samples.length; i++) view.setFloat32(i * 4, samples[i], true);
  const bytes = new Uint8Array(view.buffer), pieces = [];
  for (let at = 0; at < bytes.length; at += 8192) pieces.push(String.fromCharCode(...bytes.subarray(at, at + 8192)));
  return btoa(pieces.join(''));
}

/** Same PCM target/gain limits as Android/iOS; Web Speech's guessed RMS is inapplicable. */
export function normalizedSpeechPCM(samples, sampleRate, target = null) {
  if (!(samples instanceof Float32Array) || !samples.length || samples.length > sampleRate * 30) {
    throw Error('语音包输出为空或超过 30 秒');
  }
  const meter = new AudioLoudness(sampleRate, 1);
  let peak = 0;
  for (const sample of samples) {
    if (!Number.isFinite(sample)) throw Error('语音包输出采样无效');
    peak = Math.max(peak, Math.abs(sample));
  }
  let gain = 1;
  if (target !== null) {
    if (target !== -Infinity && (!Number.isFinite(target) || target < -100 || target > 0)) throw Error('目标响度无效');
    meter.add([samples]);
    const measured = meter.value();
    gain = target === -Infinity || measured === -Infinity ? 0
      : Math.min(4, 10 ** ((target - measured) / 20), peak ? 10 ** (-1 / 20) / peak : 1);
  }
  return Float32Array.from(samples, (sample) => Math.max(-1, Math.min(1, sample * gain)));
}
