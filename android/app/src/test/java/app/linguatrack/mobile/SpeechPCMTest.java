package app.linguatrack.mobile;

import static org.junit.Assert.*;
import java.nio.*;
import org.junit.Test;

public class SpeechPCMTest {
    static float[] tone(int rate, double amplitude, double seconds) {
        float[] out = new float[(int) (rate * seconds)];
        for (int i = 0; i < out.length; i++) out[i] = (float) (amplitude * Math.sin(2 * Math.PI * 1000 * i / rate));
        return out;
    }
    static float[] decoded(short[] pcm) {
        float[] out = new float[pcm.length];
        for (int i = 0; i < pcm.length; i++) out[i] = pcm[i] / 32768f;
        return out;
    }
    @Test public void loudnessMatchesOtherPlatformsAcrossRatesAndChannelLayouts() {
        for (int rate : new int[] {16000, 44100, 48000}) {
            float[] mono = tone(rate, .1, 2), stereo = new float[mono.length * 2];
            for (int i = 0; i < mono.length; i++) { stereo[i * 2] = mono[i]; stereo[i * 2 + 1] = mono[i]; }
            double level = SpeechPCM.loudness(mono, rate, 1);
            assertEquals(-23.0036, level, .06);
            assertEquals(level + 10 * Math.log10(2), SpeechPCM.loudness(stereo, rate, 2), 1e-6);
        }
    }
    @Test public void differentVoiceStrengthsReachTheSameOutputLoudnessAndCalibrationIsMonotonic() {
        for (double amplitude : new double[] {.06, .1, .4, .1, .06}) {
            short[] pcm = SpeechPCM.render(tone(16000, amplitude, 2), 16000, 1, .5, -18.13189);
            assertEquals(-18.13189, SpeechPCM.loudness(decoded(pcm), 16000, 1), .01);
        }
        for (double target : new double[] {-32.11129, -18.13189, -12.11129}) {
            assertEquals(target, SpeechPCM.loudness(decoded(SpeechPCM.render(tone(16000, .1, 2), 16000, 1, .5, target)), 16000, 1), .01);
        }
    }
    @Test public void gatesIgnoreSilenceAndQuietNoiseAndShortWordsRemainMeasurable() {
        float[] source = tone(16000, .1, 2), padded = new float[16000 * 15];
        System.arraycopy(source, 0, padded, 16000 * 5, source.length);
        System.arraycopy(tone(16000, .0005, 8), 0, padded, 16000 * 7, 16000 * 8);
        assertEquals(SpeechPCM.loudness(source, 16000, 1), SpeechPCM.loudness(padded, 16000, 1), .7);
        assertTrue(Double.isFinite(SpeechPCM.loudness(tone(16000, .1, .08), 16000, 1)));
        assertEquals(Double.NEGATIVE_INFINITY, SpeechPCM.loudness(new float[16000], 16000, 1), 0);
        for (short sample : SpeechPCM.render(new float[16000], 16000, 1, 1, -18.0)) assertEquals(0, sample);
    }
    @Test public void gainMuteBoostAndPeakProtectionApplyToActualEncodedSamples() {
        float[] source = tone(16000, .1, 2);
        for (double gain : new double[] {.5, .5, .1, .8, 0}) {
            float[] out = decoded(SpeechPCM.render(source, 16000, 1, gain, null));
            for (int i = 0; i < out.length; i++) assertEquals(source[i] * gain, out[i], 2.0 / 32768);
        }
        float[] spiky = tone(16000, .01, 2); spiky[5000] = .9f;
        for (short sample : SpeechPCM.render(spiky, 16000, 1, 1, -10.0)) assertTrue(Math.abs(sample / 32768.0) <= Math.pow(10, -1.0 / 20) + 1.0 / 32768);
        float[] quiet = tone(16000, .001, 2), boosted = decoded(SpeechPCM.render(quiet, 16000, 1, 1, -10.0));
        for (int i = 0; i < quiet.length; i++) assertEquals(quiet[i] * 4, boosted[i], 2.0 / 32768);
    }
    @Test public void enginePcmFormatsDecodeAndInvalidDataIsRejected() {
        assertArrayEquals(new float[] {-1, 0, 127 / 128f}, SpeechPCM.decode(new byte[] {0, (byte) 128, (byte) 255}, 3, 16000, 1), 0);
        ByteBuffer s16 = ByteBuffer.allocate(6).order(ByteOrder.nativeOrder()); s16.putShort((short) -32768).putShort((short) 0).putShort((short) 16384);
        assertArrayEquals(new float[] {-1, 0, .5f}, SpeechPCM.decode(s16.array(), 2, 16000, 1), 0);
        ByteBuffer f32 = ByteBuffer.allocate(8).order(ByteOrder.nativeOrder()); f32.putFloat(.25f).putFloat(-.5f);
        assertArrayEquals(new float[] {.25f, -.5f}, SpeechPCM.decode(f32.array(), 4, 48000, 2), 0);
        assertThrows(IllegalArgumentException.class, () -> SpeechPCM.decode(new byte[3], 2, 16000, 1));
        assertThrows(IllegalArgumentException.class, () -> SpeechPCM.render(new float[] {Float.NaN}, 16000, 1, 1, null));
        for (double target : new double[] {Double.NaN, Double.POSITIVE_INFINITY, -101, 1})
            assertThrows(IllegalArgumentException.class, () -> SpeechPCM.render(tone(16000, .1, 2), 16000, 1, 1, target));
    }
}
