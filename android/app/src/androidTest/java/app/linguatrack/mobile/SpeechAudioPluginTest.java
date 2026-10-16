package app.linguatrack.mobile;

import static org.junit.Assert.*;
import android.content.Context;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import com.getcapacitor.*;
import java.io.File;
import java.util.UUID;
import java.util.concurrent.*;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class SpeechAudioPluginTest {
    static class Call extends PluginCall {
        final CountDownLatch done = new CountDownLatch(1);
        JSObject result; String error, code;
        Call(String method, JSObject data) { super(null, "SpeechAudio", UUID.randomUUID().toString(), method, data); }
        @Override public void resolve(JSObject data) { result = data; done.countDown(); }
        @Override public void resolve() { done.countDown(); }
        @Override public void reject(String message, String code) { error = message; this.code = code; done.countDown(); }
        void await() throws InterruptedException { assertTrue("Native call timed out", done.await(50, TimeUnit.SECONDS)); }
    }
    static Call speech(double target) {
        JSObject data = new JSObject(); data.put("id", UUID.randomUUID().toString()); data.put("text", "Hello! It is a lovely day.");
        data.put("lang", "en-US"); data.put("volume", .5); data.put("targetLufs", target); return new Call("speak", data);
    }
    @Test public void systemTtsRendersRepeatedlyAndCancellationCleansTheSession() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        try (java.io.InputStream input = context.getAssets().open("public/assets/pronunciation-calibration.wav")) {
            java.io.ByteArrayOutputStream wav = new java.io.ByteArrayOutputStream(); byte[] buffer = new byte[8192]; int count;
            while ((count = input.read(buffer)) != -1) wav.write(buffer, 0, count);
            byte[] raw = java.util.Arrays.copyOfRange(wav.toByteArray(), 44, wav.size());
            assertEquals(-18.13189, SpeechPCM.loudness(SpeechPCM.decode(raw, 2, 16000, 1), 16000, 1), .00001);
        }
        try (ActivityScenario<MainActivity> activity = ActivityScenario.launch(MainActivity.class)) {
            SpeechAudioPlugin[] plugin = new SpeechAudioPlugin[1];
            activity.onActivity(a -> plugin[0] = (SpeechAudioPlugin) a.getBridge().getPlugin("SpeechAudio").getInstance());
            assertNotNull(plugin[0]);
            Call capabilities = new Call("capabilities", new JSObject()); plugin[0].capabilities(capabilities); capabilities.await();
            assertNull(capabilities.error); assertTrue(capabilities.result.getBool("loudnessNormalization"));
            assertTrue("Test device needs installed system voices", capabilities.result.getJSONArray("voices").length() > 0);
            for (double target : new double[] {-18.13189, -32, -18.13189}) {
                Call call = speech(target); plugin[0].speak(call); call.await(); assertNull(call.error);
            }
            Call old = speech(-18.13189); plugin[0].speak(old);
            Call replacement = speech(-18.13189); plugin[0].speak(replacement); old.await(); assertEquals("SPEECH_CANCELLED", old.code);
            JSObject oldId = new JSObject(); oldId.put("id", old.getString("id"));
            Call staleCancel = new Call("cancel", oldId); plugin[0].cancel(staleCancel); staleCancel.await();
            replacement.await(); assertNull(replacement.error);
            Call stopped = speech(-18.13189); plugin[0].speak(stopped);
            JSObject id = new JSObject(); id.put("id", stopped.getString("id"));
            Call cancel = new Call("cancel", id); plugin[0].cancel(cancel); cancel.await(); stopped.await(); assertEquals("SPEECH_CANCELLED", stopped.code);
            File[] files = context.getCacheDir().listFiles((dir, name) -> name.startsWith("lingua-speech-"));
            assertNotNull(files); assertEquals("Synthesis files must be deleted", 0, files.length);
        }
    }
}
