package app.linguatrack.mobile;

import android.content.Intent;
import android.content.res.Configuration;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.Settings;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebView;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.WebViewListener;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.ArrayList;

/** Shares the iOS CaptionPip contract, using Android's transparent application overlay. */
@CapacitorPlugin(name = "CaptionPip")
public class CaptionPipPlugin extends Plugin {
    private final Handler handler = new Handler(Looper.getMainLooper());
    private CaptionOverlay overlay;
    private CaptionTimeline timeline = new CaptionTimeline();
    private PluginCall pendingOpen;
    private boolean permissionPending;
    private String session = "";
    private float captionSize = 20;
    private boolean showTranslation = true;
    private final Runnable tick = new Runnable() {
        @Override public void run() {
            if (overlay == null) return;
            if (!Settings.canDrawOverlays(getContext())) { finish(); return; }
            paint();
            handler.postDelayed(this, 100);
        }
    };
    private final WebViewListener navigation = new WebViewListener() {
        @Override public void onPageStarted(WebView view) { finish(); }
        @Override public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            finish(); return false;
        }
    };

    @Override public void load() { bridge.addWebViewListener(navigation); }

    @PluginMethod public void capabilities(PluginCall call) {
        JSObject result = new JSObject();
        // Permission is requestable, not a capability: keep the entry visible before granting it.
        result.put("supported", true);
        result.put("presentation", "android-caption-overlay");
        result.put("permissionGranted", Settings.canDrawOverlays(getContext()));
        call.resolve(result);
    }

    @PluginMethod public void open(PluginCall call) {
        handler.post(() -> {
            if (!session.isEmpty() || permissionPending) { call.reject("字幕小窗正在切换", "PIP_BUSY"); return; }
            String requested = call.getString("session", "");
            if (requested.isEmpty() || getActivity().isFinishing()) {
                call.reject("播放窗口尚未就绪", "PIP_SOURCE_NOT_READY"); return;
            }
            session = requested;
            timeline = new CaptionTimeline();
            pendingOpen = call;
            apply(call);
            if (Settings.canDrawOverlays(getContext())) { attach(); return; }
            try {
                Intent intent = new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    Uri.parse("package:" + getContext().getPackageName()));
                permissionPending = true;
                startActivityForResult(call, intent, "overlayPermissionResult");
            } catch (RuntimeException error) {
                permissionPending = false;
                fail("无法打开悬浮窗设置", "OVERLAY_SETTINGS", error);
            }
        });
    }

    @ActivityCallback private void overlayPermissionResult(PluginCall call, ActivityResult result) {
        permissionPending = false;
        // Navigation/cancellation may have retired this request while Settings was visible.
        if (call == null || call != pendingOpen) return;
        if (!Settings.canDrawOverlays(getContext())) {
            fail("请允许显示在其他应用上层", "OVERLAY_PERMISSION", null); return;
        }
        attach();
    }

    private void attach() {
        if (pendingOpen == null) return;
        try {
            overlay = new CaptionOverlay(getContext(), this::finish);
            paint();
            overlay.show();
            PluginCall call = pendingOpen; pendingOpen = null;
            call.resolve();
            emit(true);
            handler.post(tick);
        } catch (RuntimeException error) {
            fail("字幕小窗启动失败", Settings.canDrawOverlays(getContext()) ? "PIP_START_FAILED" : "OVERLAY_PERMISSION", error);
        }
    }

    @PluginMethod public void update(PluginCall call) {
        handler.post(() -> {
            if (!session.isEmpty() && session.equals(call.getString("session"))) { apply(call); paint(); }
            call.resolve();
        });
    }

    private void apply(PluginCall call) {
        JSObject data = call.getData();
        if (!timeline.sync(data.optLong("sequence", 0), data.optDouble("position", 0),
            data.optDouble("duration", 0), data.optDouble("rate", 1),
            data.optBoolean("paused", true), SystemClock.elapsedRealtime())) return;
        double size = data.optDouble("captionSize", 20);
        if (Double.isFinite(size)) captionSize = (float) Math.max(12, Math.min(36, size));
        showTranslation = data.optBoolean("showTranslation", true);
        JSArray sentences = call.getArray("sentences");
        if (sentences != null) {
            ArrayList<CaptionTimeline.Line> lines = new ArrayList<>();
            for (int i = 0; i < sentences.length(); i++) {
                var row = sentences.optJSONObject(i);
                if (row == null) continue;
                lines.add(new CaptionTimeline.Line(row.optDouble("start", Double.NaN),
                    text(row.optString("text", "")), text(row.optString("translation", ""))));
            }
            timeline.setLines(lines);
        }
    }

    private String text(String value) { return value.substring(0, Math.min(value.length(), 10000)); }

    private void paint() {
        if (overlay == null) return;
        CaptionTimeline.Line line = timeline.lineAt(SystemClock.elapsedRealtime());
        overlay.render(line == null ? "聆听中" : line.text,
            showTranslation && line != null ? line.translation : "", captionSize);
    }

    @PluginMethod public void close(PluginCall call) {
        handler.post(() -> {
            if (session.equals(call.getString("session"))) finish();
            call.resolve();
        });
    }

    private void fail(String message, String code, Exception error) {
        PluginCall call = pendingOpen; pendingOpen = null;
        if (call != null) call.reject(message, code, error);
        finish();
    }

    private void emit(boolean active) {
        JSObject value = new JSObject();
        value.put("session", session); value.put("active", active); value.put("closing", false);
        notifyListeners("stateChanged", value);
    }

    private void finish() {
        handler.removeCallbacks(tick);
        if (pendingOpen != null) {
            pendingOpen.reject("字幕小窗已取消"); pendingOpen = null;
        }
        if (overlay != null) { overlay.dismiss(); overlay = null; }
        if (!session.isEmpty()) emit(false);
        session = "";
        timeline = new CaptionTimeline();
    }

    @Override protected void handleOnResume() {
        if (overlay != null && !Settings.canDrawOverlays(getContext())) finish();
    }

    @Override protected void handleOnConfigurationChanged(Configuration configuration) {
        if (overlay != null) overlay.reflow();
    }

    @Override protected void handleOnDestroy() {
        finish();
        bridge.removeWebViewListener(navigation);
        handler.removeCallbacksAndMessages(null);
    }
}
