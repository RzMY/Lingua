/** File-average RMS estimate; never routes or changes the main player's audio. */
// System speech has no PCM output API. -20 dBFS is an estimated reference, not
// a measured voice level or LUFS calibration; SpeechSynthesis only allows 0..1.
const SPEECH_REFERENCE_RMS = .1;

export function balancedSpeechVolume(rms, media) {
  const level = media?.muted ? 0 : Number.isFinite(media?.volume)
    ? Math.max(0, Math.min(1, media.volume)) : 1;
  const gain = Number.isFinite(rms) && rms >= 0
    ? Math.min(1, rms / SPEECH_REFERENCE_RMS) : 1;
  return gain * level;
}

export async function measureAudioRms(file, { signal } = {}) {
  const Offline = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!Offline) throw new Error('音频响度分析不可用');
  const { audioDecodePlan } = await import('./workbench-media.js');
  signal?.throwIfAborted();
  const plan = await audioDecodePlan(file, { signal });
  // MP4/WAV use bounded windows. Other formats decode once at 16 kHz to limit PCM memory.
  const rate = plan?.sampleRate || 16000;
  let energy = 0, samples = 0;
  async function add(buffer, start, length) {
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
    for (let at = start; at < start + length; at += 65536) {
      signal?.throwIfAborted();
      const end = Math.min(start + length, at + 65536);
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
  return Math.sqrt(energy / samples);
}

/** One reference per attached file. Late decode results cannot affect replacement media. */
export function createPronunciationLoudness(file, media) {
  const controller = new AbortController();
  let rms = null;
  const ready = measureAudioRms(file, { signal: controller.signal }).then((value) => {
    if (!controller.signal.aborted) rms = value;
  }).catch(() => {}); // Unsupported formats retain ordinary speech and player volume.
  return {
    ready,
    volume: () => balancedSpeechVolume(rms, media),
    dispose() { controller.abort(); rms = null; },
  };
}
