/** Streaming BS.1770 K weighting and EBU R128 gates (mono/stereo, no PCM retained). */
export class AudioLoudness {
  constructor(sampleRate, channels) {
    if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000 ||
        !Number.isInteger(channels) || channels < 1 || channels > 2) throw Error('音频格式不支持响度测量');
    const coefficients = (frequency, q, shelf) => {
      const k = Math.tan(Math.PI * frequency / sampleRate), a0 = 1 + k / q + k * k;
      const vh = 10 ** (3.999843853973347 / 20), vb = vh ** .4996667741545416;
      return shelf
        ? [(vh + vb * k / q + k * k) / a0, 2 * (k * k - vh) / a0,
          (vh - vb * k / q + k * k) / a0, 2 * (k * k - 1) / a0, (1 - k / q + k * k) / a0]
        : [1, -2, 1, 2 * (k * k - 1) / a0, (1 - k / q + k * k) / a0];
    };
    const filter = (c) => ({ c, z1: 0, z2: 0 });
    this.filters = Array.from({ length: channels }, () => [
      filter(coefficients(1681.974450955533, .7071752369554196, true)),
      filter(coefficients(38.13547087602444, .5003270373238773, false)),
    ]);
    this.window = new Float64Array(Math.round(sampleRate * .4));
    this.hop = Math.round(sampleRate * .1);
    this.frames = 0; this.sum = 0; this.blocks = [];
  }

  add(channels, start = 0, length = channels[0].length - start) {
    if (channels.length !== this.filters.length) throw Error('音频声道数变化');
    for (let i = start; i < start + length; i++) {
      let energy = 0;
      for (let channel = 0; channel < channels.length; channel++) {
        let value = channels[channel][i];
        if (!Number.isFinite(value)) throw Error('音频采样无效');
        for (const filter of this.filters[channel]) {
          const [b0, b1, b2, a1, a2] = filter.c;
          const output = b0 * value + filter.z1;
          filter.z1 = b1 * value - a1 * output + filter.z2;
          filter.z2 = b2 * value - a2 * output;
          value = output;
        }
        energy += value * value;
      }
      const at = this.frames % this.window.length;
      this.sum += energy - this.window[at]; this.window[at] = energy;
      this.frames++;
      if (this.frames >= this.window.length && (this.frames - this.window.length) % this.hop === 0) {
        this.blocks.push(Math.max(0, this.sum / this.window.length));
      }
    }
  }

  value() {
    const blocks = this.frames < this.window.length && this.frames > 0
      ? [Math.max(0, this.sum / this.frames)] : this.blocks;
    const absolute = 10 ** ((-70 + .691) / 10);
    const audible = blocks.filter((energy) => energy >= absolute);
    if (!audible.length) return -Infinity;
    const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
    const threshold = Math.max(absolute, mean(audible) * .1);
    return -.691 + 10 * Math.log10(mean(audible.filter((energy) => energy >= threshold)));
  }
}
