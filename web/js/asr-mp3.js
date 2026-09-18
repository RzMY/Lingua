/** Local, streaming MP3 encoding; no native codec or secure-context requirement. */
import { mediaWriter } from './media-file.js';

export const ASR_RATE = 16000;

export async function mp3Writer(name, channels, signal) {
  if (![1, 2].includes(channels)) throw new Error('ASR MP3 支持单声道或立体声，请先将多声道音轨转为立体声');
  signal?.throwIfAborted();
  const { Mp3Encoder } = await import('./vendor/lamejs/lame.js');
  signal?.throwIfAborted();
  const bitrate = channels === 1 ? 32 : 64;
  const encoder = new Mp3Encoder(channels, ASR_RATE, bitrate);
  const writer = await mediaWriter(name.replace(/(?:\.lossless)?\.[^.]+$/, '') + '.16k.mp3', 'audio/mpeg', signal);
  let frames = 0;
  return {
    async write(pcm) {
      if (pcm.length !== channels || pcm.some((c) => c.length !== pcm[0].length)) throw new Error('音频声道数据无效');
      for (let start = 0; start < pcm[0].length; start += 16384) {
        signal?.throwIfAborted();
        const end = Math.min(pcm[0].length, start + 16384);
        const input = pcm.map((channel) => Int16Array.from(channel.subarray(start, end), (sample) => {
          const value = Math.max(-1, Math.min(1, sample || 0));
          return Math.round(value * (value < 0 ? 32768 : 32767));
        }));
        const bytes = encoder.encodeBuffer(input[0], input[1]);
        if (bytes.length) await writer.write(new Blob([bytes]));
        frames += end - start;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    },
    async finish() {
      signal?.throwIfAborted();
      if (!frames) throw new Error('音频为空');
      const bytes = encoder.flush();
      if (bytes.length) await writer.write(new Blob([bytes]));
      return { ...await writer.finish(), sampleRate: ASR_RATE, bitrate, channels, duration: frames / ASR_RATE };
    },
    abort: () => writer.abort(),
  };
}

export async function encodeAsrMp3(decoded, name, { signal, onStage = () => {} } = {}) {
  if (decoded.sampleRate !== ASR_RATE) throw new Error('ASR 音频必须先重采样到 16 kHz');
  const writer = await mp3Writer(name, decoded.numberOfChannels, signal);
  try {
    for (let start = 0; start < decoded.length; start += ASR_RATE * 12) {
      onStage(`正在压制 MP3… ${Math.round(start / decoded.length * 100)}%`);
      await writer.write(Array.from({ length: decoded.numberOfChannels }, (_, i) =>
        decoded.getChannelData(i).subarray(start, Math.min(start + ASR_RATE * 12, decoded.length))));
    }
    return await writer.finish();
  } catch (err) { await writer.abort(); throw err; }
}
