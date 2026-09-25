package app.linguatrack.mobile;

import static org.junit.Assert.*;
import android.content.*;
import android.os.IBinder;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import com.getcapacitor.JSObject;
import java.io.*;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class PlaybackServiceTest {
    @Test public void nativeClockAndControlsContinueWithoutWebView() throws Exception {
        var instrumentation = InstrumentationRegistry.getInstrumentation();
        Context context = instrumentation.getTargetContext();
        CountDownLatch connected = new CountDownLatch(1), prepared = new CountDownLatch(1);
        PlaybackService[] service = new PlaybackService[1];
        String[] error = new String[1];
        ServiceConnection connection = new ServiceConnection() {
            @Override public void onServiceConnected(ComponentName name, IBinder binder) {
                service[0] = ((PlaybackService.LocalBinder) binder).service(); connected.countDown();
            }
            @Override public void onServiceDisconnected(ComponentName name) { }
        };
        context.startActivity(new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        assertTrue(context.bindService(new Intent(context, PlaybackService.class), connection, Context.BIND_AUTO_CREATE));
        assertTrue(connected.await(5, TimeUnit.SECONDS));
        File file = File.createTempFile("test-playback-", ".wav", context.getCacheDir());
        int samples = 8000 * 20;
        ByteBuffer bytes = ByteBuffer.allocate(44 + samples * 2).order(ByteOrder.LITTLE_ENDIAN);
        bytes.put("RIFF".getBytes()).putInt(36 + samples * 2).put("WAVEfmt ".getBytes()).putInt(16)
            .putShort((short) 1).putShort((short) 1).putInt(8000).putInt(16000).putShort((short) 2).putShort((short) 16)
            .put("data".getBytes()).putInt(samples * 2);
        try (FileOutputStream out = new FileOutputStream(file)) { out.write(bytes.array()); }
        try {
            instrumentation.runOnMainSync(() -> service[0].prepare("test-session", "Playback test", file, message -> {
                error[0] = message; prepared.countDown();
            }));
            assertTrue(prepared.await(10, TimeUnit.SECONDS)); assertNull(error[0]);
            double[] positions = new double[3];
            instrumentation.runOnMainSync(() -> {
                service[0].play(); service[0].setAppActive(false); positions[0] = service[0].position();
            });
            Thread.sleep(700);
            instrumentation.runOnMainSync(() -> { service[0].pause(); positions[1] = service[0].position(); });
            assertTrue(positions[1] > positions[0] + .3);
            Thread.sleep(200);
            instrumentation.runOnMainSync(() -> positions[2] = service[0].position());
            assertEquals(positions[1], positions[2], .05);
            instrumentation.runOnMainSync(() -> service[0].control("play"));
            Thread.sleep(500);
            instrumentation.runOnMainSync(() -> {
                positions[2] = service[0].position(); service[0].pause(); service[0].seek(10);
            });
            assertTrue(positions[2] > positions[1] + .2);
            Thread.sleep(250);
            instrumentation.runOnMainSync(() -> { assertEquals(10, service[0].position(), .1); service[0].control("seekbackward"); });
            Thread.sleep(250);
            instrumentation.runOnMainSync(() -> { assertEquals(5, service[0].position(), .1); service[0].control("seekforward"); });
            Thread.sleep(250);
            instrumentation.runOnMainSync(() -> {
                assertEquals(10, service[0].position(), .1);
                JSObject command = new JSObject(); command.put("revision", 2); command.put("action", "rate"); command.put("rate", 1.5);
                service[0].command(command); assertEquals(1.5, service[0].rate(), .001);
                command.put("revision", 1); command.put("rate", 2); service[0].command(command);
                assertEquals(1.5, service[0].rate(), .001);
            });
        } finally {
            instrumentation.runOnMainSync(() -> service[0].release()); context.unbindService(connection);
        }
        assertFalse(file.exists());
    }
}
