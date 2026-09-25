package app.linguatrack.mobile;

import android.content.*;
import android.os.*;
import android.util.Base64;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebView;
import com.getcapacitor.*;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.*;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** File transfer runs off the UI thread; all player operations run on the service's main looper. */
@CapacitorPlugin(name = "AudioPlayer")
public class AudioPlayerPlugin extends Plugin {
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private PlaybackService playback;
    private boolean bound, destroyed;
    private String session = "", title = "Lingua";
    private File file;
    private OutputStream output;
    private long expected, written;
    private final ServiceConnection connection = new ServiceConnection() {
        @Override public void onServiceConnected(ComponentName name, IBinder binder) {
            playback = ((PlaybackService.LocalBinder) binder).service();
            playback.setSink(value -> notifyListeners("stateChanged", value));
        }
        @Override public void onServiceDisconnected(ComponentName name) { playback = null; }
    };
    private final WebViewListener navigation = new WebViewListener() {
        @Override public void onPageStarted(WebView view) { clear(); }
        @Override public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) { clear(); return false; }
    };
    @Override public void load() {
        bound = getContext().bindService(new Intent(getContext(), PlaybackService.class), connection, Context.BIND_AUTO_CREATE);
        bridge.addWebViewListener(navigation);
    }
    @PluginMethod public void capabilities(PluginCall call) {
        JSObject value = new JSObject(); value.put("videoAudio", true); value.put("backgroundPlayback", true); call.resolve(value);
    }
    @PluginMethod public void begin(PluginCall call) {
        main.post(() -> { if (playback != null) playback.release(); });
        io.execute(() -> {
            closeFile();
            String id = call.getString("session", "");
            long size = call.getData().optLong("size", -1);
            if (destroyed || id.isEmpty() || size <= 0) { call.reject("媒体文件无效"); return; }
            try {
                String ext = call.getString("extension", "bin").replaceAll("[^a-zA-Z0-9]", "");
                if (ext.length() > 12) ext = "bin";
                file = File.createTempFile("lingua-playback-", "." + ext, getContext().getCacheDir());
                output = new BufferedOutputStream(new FileOutputStream(file));
                session = id; title = call.getString("title", "Lingua"); expected = size; written = 0;
                call.resolve();
            } catch (IOException error) { closeFile(); call.reject("无法准备本地媒体文件", error); }
        });
    }
    @PluginMethod public void append(PluginCall call) {
        io.execute(() -> {
            if (!matches(call)) return;
            String encoded = call.getString("data", "");
            long offset = call.getData().optLong("offset", -1);
            try {
                if (output == null || encoded.length() > 700000 || offset != written) throw new IOException("媒体分块不完整");
                byte[] bytes = Base64.decode(encoded, Base64.DEFAULT);
                if (bytes.length == 0 || bytes.length > 512 * 1024 || written + bytes.length > expected) throw new IOException("媒体分块大小无效");
                output.write(bytes); written += bytes.length; call.resolve();
            } catch (Exception error) { call.reject("媒体写入失败", error); }
        });
    }
    @PluginMethod public void prepare(PluginCall call) {
        io.execute(() -> {
            if (!matches(call)) return;
            if (output == null || written != expected) { call.reject("媒体尚未传输完整"); return; }
            try { output.close(); output = null; }
            catch (IOException error) { call.reject("媒体文件写入失败", error); return; }
            File source = file; file = null;
            String id = session, name = title;
            main.post(() -> {
                if (destroyed || playback == null) { source.delete(); call.reject("原生播放器尚未连接，请重试"); return; }
                playback.prepare(id, name, source, error -> {
                    if (error != null) call.reject(error);
                    else call.resolve(playback.snapshot("loadedmetadata"));
                });
            });
        });
    }
    private boolean matches(PluginCall call) {
        if (!session.isEmpty() && session.equals(call.getString("session"))) return true;
        call.reject("媒体会话已切换"); return false;
    }
    private boolean ready(PluginCall call) {
        if (playback != null && playback.matches(call.getString("session")) && playback.isReady()) return true;
        call.reject("媒体尚未准备好"); return false;
    }
    @PluginMethod public void command(PluginCall call) {
        main.post(() -> {
            if (!ready(call)) return;
            try { playback.command(call.getData()); call.resolve(playback.snapshot("state")); }
            catch (RuntimeException error) { call.reject(error.getMessage(), error); }
        });
    }
    @PluginMethod public void state(PluginCall call) { main.post(() -> { if (ready(call)) call.resolve(playback.snapshot("state")); }); }
    @PluginMethod public void release(PluginCall call) {
        main.post(() -> {
            if (playback != null && playback.matches(call.getString("session"))) playback.release();
            io.execute(() -> { if (session.equals(call.getString("session"))) closeFile(); call.resolve(); });
        });
    }
    private void closeFile() {
        try { if (output != null) output.close(); } catch (IOException ignored) { }
        output = null;
        if (file != null) { file.delete(); file = null; }
        session = ""; written = expected = 0;
    }
    private void clear() {
        if (playback != null) playback.release();
        if (!io.isShutdown()) io.execute(this::closeFile);
    }
    @Override protected void handleOnResume() { if (playback != null) playback.setAppActive(true); }
    @Override protected void handleOnStop() { if (playback != null) playback.setAppActive(false); }
    @Override protected void handleOnDestroy() {
        destroyed = true; clear();
        if (playback != null) playback.setSink(null);
        if (bound) { getContext().unbindService(connection); bound = false; }
        bridge.removeWebViewListener(navigation); io.shutdown();
    }
}
