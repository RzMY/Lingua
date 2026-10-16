package app.linguatrack.mobile;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;

/** Same BS.1770 filters/gates and peak protection as the Swift and JavaScript meters. */
final class SpeechPCM {
    private static final class Filter {
        final double b0, b1, b2, a1, a2;
        double z1, z2;
        Filter(double rate, double frequency, double q, boolean shelf) {
            double k = Math.tan(Math.PI * frequency / rate), a0 = 1 + k / q + k * k;
            double vh = Math.pow(10, 3.999843853973347 / 20), vb = Math.pow(vh, .4996667741545416);
            b0 = shelf ? (vh + vb * k / q + k * k) / a0 : 1;
            b1 = shelf ? 2 * (k * k - vh) / a0 : -2;
            b2 = shelf ? (vh - vb * k / q + k * k) / a0 : 1;
            a1 = 2 * (k * k - 1) / a0; a2 = (1 - k / q + k * k) / a0;
        }
        double process(double value) {
            double out = b0 * value + z1;
            z1 = b1 * value - a1 * out + z2; z2 = b2 * value - a2 * out;
            return out;
        }
    }
    private static void validate(float[] samples, int rate, int channels) {
        if (rate < 8000 || rate > 192000 || channels < 1 || channels > 2 || samples.length == 0
            || samples.length % channels != 0 || samples.length > rate * channels * 30) {
            throw new IllegalArgumentException("合成音频格式无效或过长");
        }
        for (float sample : samples) if (!Float.isFinite(sample)) throw new IllegalArgumentException("音频采样无效");
    }
    static double loudness(float[] samples, int rate, int channels) {
        validate(samples, rate, channels);
        Filter[] shelves = new Filter[channels], highpasses = new Filter[channels];
        for (int c = 0; c < channels; c++) {
            shelves[c] = new Filter(rate, 1681.974450955533, .7071752369554196, true);
            highpasses[c] = new Filter(rate, 38.13547087602444, .5003270373238773, false);
        }
        int window = (int) Math.round(rate * .4), hop = (int) Math.round(rate * .1), frames = samples.length / channels;
        double[] ring = new double[window], blocks = new double[Math.max(1, frames / hop + 1)];
        double sum = 0; int count = 0;
        for (int frame = 0; frame < frames; frame++) {
            double energy = 0;
            for (int c = 0; c < channels; c++) {
                double weighted = highpasses[c].process(shelves[c].process(samples[frame * channels + c]));
                energy += weighted * weighted;
            }
            int at = frame % window; sum += energy - ring[at]; ring[at] = energy;
            if (frame + 1 >= window && (frame + 1 - window) % hop == 0) blocks[count++] = Math.max(0, sum / window);
        }
        if (frames < window) blocks[count++] = Math.max(0, sum / frames);
        double absolute = Math.pow(10, (-70 + .691) / 10), audibleSum = 0; int audible = 0;
        for (int i = 0; i < count; i++) if (blocks[i] >= absolute) { audibleSum += blocks[i]; audible++; }
        if (audible == 0) return Double.NEGATIVE_INFINITY;
        double threshold = Math.max(absolute, audibleSum / audible * .1), gatedSum = 0; int gated = 0;
        for (int i = 0; i < count; i++) if (blocks[i] >= threshold) { gatedSum += blocks[i]; gated++; }
        return -.691 + 10 * Math.log10(gatedSum / gated);
    }
    static short[] render(float[] samples, int rate, int channels, double gain, Double targetLufs) {
        validate(samples, rate, channels);
        if (!Double.isFinite(gain) || gain < 0 || gain > 1) throw new IllegalArgumentException("发音音量无效");
        double applied = gain;
        if (targetLufs != null) {
            if (!Double.isFinite(targetLufs) || targetLufs < -100 || targetLufs > 0) throw new IllegalArgumentException("目标响度无效");
            double measured = loudness(samples, rate, channels), peak = 0;
            for (float sample : samples) peak = Math.max(peak, Math.abs(sample));
            applied = Double.isFinite(measured) && peak > 0
                ? Math.min(Math.min(Math.pow(10, (targetLufs - measured) / 20), 4), Math.pow(10, -1.0 / 20) / peak) : 0;
        }
        short[] out = new short[samples.length];
        for (int i = 0; i < samples.length; i++) {
            double scaled = Math.max(-1, Math.min(1, samples[i] * applied));
            out[i] = (short) Math.round(scaled * (scaled < 0 ? 32768 : 32767));
        }
        return out;
    }
    /** Android TTS raw PCM uses native byte order. Encoding constants match AudioFormat. */
    static float[] decode(byte[] bytes, int encoding, int rate, int channels) {
        int width = encoding == 3 ? 1 : encoding == 2 ? 2 : encoding == 4 ? 4 : 0;
        if (width == 0 || bytes.length == 0 || channels < 1 || channels > 2 || rate < 8000 || rate > 192000
            || bytes.length % (width * channels) != 0 || bytes.length / width > rate * channels * 30) {
            throw new IllegalArgumentException("此语音引擎输出的音频格式不受支持");
        }
        ByteBuffer buffer = ByteBuffer.wrap(bytes).order(ByteOrder.nativeOrder());
        float[] samples = new float[bytes.length / width];
        for (int i = 0; i < samples.length; i++) samples[i] = encoding == 3 ? ((buffer.get() & 255) - 128) / 128f
            : encoding == 2 ? buffer.getShort() / 32768f : buffer.getFloat();
        validate(samples, rate, channels);
        return samples;
    }
}
