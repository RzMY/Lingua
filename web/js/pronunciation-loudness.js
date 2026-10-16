/** File loudness measurement; never routes or changes the main player's audio. */
import { AudioLoudness } from './audio-loudness.js';
import { TTS_CALIBRATION_DEFAULT } from './pronunciation-config.js';

// Web Speech retains its RMS approximation. Native PCM uses the measured reference
// clip's gated K-weighted loudness, and treats the default calibration as unity.
const SPEECH_REFERENCE_RMS = .1;
export const CALIBRATION_REFERENCE_LUFS = -18.13189;

const mediaLevel = (media) => media?.muted ? 0 : Number.isFinite(media?.volume)
  ? Math.max(0, Math.min(1, media.volume)) : 1;

export function speechLoudnessTarget(lufs = CALIBRATION_REFERENCE_LUFS, media, calibration = TTS_CALIBRATION_DEFAULT) {
  const level = mediaLevel(media) * calibration / TTS_CALIBRATION_DEFAULT;
  if (level <= 0 || lufs === -Infinity) return -Infinity;
  return Math.max(-100, Math.min(0, (Number.isFinite(lufs) ? lufs : CALIBRATION_REFERENCE_LUFS) + 20 * Math.log10(level)));
}

export function balancedSpeechVolume(rms, media) {
  const level = mediaLevel(media);
  const gain = Number.isFinite(rms) && rms >= 0
    ? Math.min(1, rms / SPEECH_REFERENCE_RMS) : 1;
  return gain * level;
}

export async function measureAudioLevels(file, { signal } = {}) {
  const Offline = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!Offline) throw new Error('音频响度分析不可用');
  const { audioDecodePlan } = await import('./workbench-media.js');
  signal?.throwIfAborted();
  const plan = await audioDecodePlan(file, { signal });
  // MP4/WAV use bounded windows. Other formats decode once at 16 kHz to limit PCM memory.
  const rate = plan?.sampleRate || 16000;
  let energy = 0, samples = 0, loudness;
  async function add(buffer, start, length) {
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
    loudness ??= new AudioLoudness(buffer.sampleRate, channels.length);
    for (let at = start; at < start + length; at += 65536) {
      signal?.throwIfAborted();
      const end = Math.min(start + length, at + 65536);
      loudness.add(channels, at, end - at);
      for (const channel of channels) {
        for (let i = at; i < end; i++) {
          const sample = channel[i];
          if (!Number.isFinite(sample)) throw new Error('音频采样无效');
          energy += sample * sample;
        }
      }
      samples += (end - at) * channels.length;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  const segments = plan ? plan.segments() : [{ file }];
  for await (const segment of segments) {
    signal?.throwIfAborted();
    if (segment.silence) {
      samples += Math.round(segment.duration * rate) * plan.channels;
      const zeros = Array.from({ length: plan.channels }, () => new Float32Array(65536));
      loudness ??= new AudioLoudness(rate, plan.channels);
      for (let remaining = Math.round(segment.duration * rate); remaining > 0; remaining -= 65536) {
        signal?.throwIfAborted();
        loudness.add(zeros, 0, Math.min(65536, remaining));
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      continue;
    }
    const bytes = await segment.file.arrayBuffer();
    signal?.throwIfAborted();
    const buffer = await new Offline(1, 1, rate).decodeAudioData(bytes);
    signal?.throwIfAborted();
    const start = Math.round((segment.skip || 0) * buffer.sampleRate);
    const length = segment.duration === undefined ? buffer.length : Math.round(segment.duration * buffer.sampleRate);
    if (start + length > buffer.length + 2 || (plan && buffer.numberOfChannels !== plan.channels)) {
      throw new Error('音频片段解码不完整');
    }
    await add(buffer, start, Math.min(length, buffer.length - start));
  }
  if (!samples) throw new Error('音频为空');
  return { rms: Math.sqrt(energy / samples), lufs: loudness.value() };
}

export async function measureAudioRms(file, options) {
  return (await measureAudioLevels(file, options)).rms;
}

/** One reference per attached file. Late decode results cannot affect replacement media. */
export function createPronunciationLoudness(file, media) {
  const controller = new AbortController();
  let levels = null;
  const ready = measureAudioLevels(file, { signal: controller.signal }).then((value) => {
    if (!controller.signal.aborted) levels = value;
  }).catch(() => {}); // Unsupported formats retain ordinary speech and player volume.
  return {
    ready,
    volume: () => balancedSpeechVolume(levels?.rms, media),
    target: (calibration) => speechLoudnessTarget(levels?.lufs, media, calibration),
    dispose() { controller.abort(); levels = null; },
  };
}
