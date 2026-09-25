package app.linguatrack.mobile;

import android.app.PictureInPictureParams;
import android.app.PendingIntent;
import android.app.RemoteAction;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.graphics.drawable.Icon;
import android.net.Uri;
import android.os.Build;
import android.util.Rational;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebView;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.WebViewListener;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.Arrays;
import java.util.Collections;

@CapacitorPlugin(name = "NativeMedia")
public class NativeMediaPlugin extends Plugin {
    private static final String ACTION = "app.linguatrack.mobile.PIP_CONTROL";
    private String session = "";
    private long sequence = -1;
    private boolean playing, seekable, registered;
    private Rational aspect = new Rational(16, 9);
    private final BroadcastReceiver controls = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) {
            if (!ACTION.equals(intent.getAction()) || session.isEmpty()
                || !session.equals(intent.getStringExtra("session"))
                || Build.VERSION.SDK_INT < Build.VERSION_CODES.O || !getActivity().isInPictureInPictureMode()) return;
            String action = intent.getStringExtra("control");
            if (!Arrays.asList("play", "pause", "seekbackward", "seekforward").contains(action)) return;
            if (action.startsWith("seek") && !seekable) return;
            PlaybackService service = PlaybackService.instance;
            if (service != null && service.matches(nativeSession)) { service.control(action); refreshNative(); return; }
            JSObject value = new JSObject();
            value.put("session", session); value.put("action", action);
            notifyListeners("pipChanged", value);
        }
    };
    private String nativeSession = "";
    private PlaybackService playback;
    private final Runnable playbackChanged = this::refreshNative;
    private void refreshNative() {
        if (playback == null || !playback.matches(nativeSession)) return;
        playing = playback.isPlaying(); seekable = playback.isReady();
        if (Build.VERSION.SDK_INT >= 26 && getActivity().isInPictureInPictureMode()) getActivity().setPictureInPictureParams(parameters());
    }
    private final WebViewListener navigation = new WebViewListener() {
        @Override public void onPageStarted(WebView view) { clear(); }
        @Override public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) { clear(); return false; }
    };

    @Override public void load() {
        IntentFilter filter = new IntentFilter(ACTION);
        filter.addDataScheme("lingua-pip");
        ContextCompat.registerReceiver(getContext(), controls, filter, ContextCompat.RECEIVER_NOT_EXPORTED);
        registered = true;
        bridge.addWebViewListener(navigation);
    }

    @PluginMethod public void enterPip(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O ||
                !getContext().getPackageManager().hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)) {
                call.reject("此设备不支持系统画中画"); return;
            }
            int width = call.getInt("width", 16), height = call.getInt("height", 9);
            float ratio = height > 0 ? (float) width / height : 16f / 9;
            ratio = Math.max(1f / 2.39f, Math.min(2.39f, ratio));
            try {
                session = call.getString("session", ""); sequence = -1;
                if (playback != null) playback.listeners.remove(playbackChanged);
                nativeSession = call.getString("nativeAudioSession", "");
                playback = PlaybackService.instance;
                if (playback != null && playback.matches(nativeSession)) playback.listeners.add(playbackChanged);
                apply(call);
                aspect = new Rational(Math.round(ratio * 1000), 1000);
                boolean entered = getActivity().enterPictureInPictureMode(parameters());
                if (entered) {
                    JSObject result = new JSObject(); result.put("controls", true); call.resolve(result);
                } else { clear(); call.reject("请在系统设置中允许 Lingua 使用画中画"); }
            } catch (Exception error) { session = ""; call.reject("无法进入画中画", error); }
        });
    }

    @PluginMethod public void updatePip(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (!session.isEmpty() && session.equals(call.getString("session")) && apply(call)
                && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && getActivity().isInPictureInPictureMode()) {
                getActivity().setPictureInPictureParams(parameters());
            }
            call.resolve();
        });
    }

    private boolean apply(PluginCall call) {
        long next = call.getData().optLong("sequence", 0);
        if (next <= sequence) return false;
        sequence = next;
        boolean nextPlaying = call.getBoolean("playing", false), nextSeekable = call.getBoolean("seekable", false);
        if (playback != null && playback.matches(nativeSession)) {
            nextPlaying = playback.isPlaying(); nextSeekable = playback.isReady();
        }
        boolean changed = playing != nextPlaying || seekable != nextSeekable;
        playing = nextPlaying; seekable = nextSeekable;
        return changed;
    }

    @androidx.annotation.RequiresApi(Build.VERSION_CODES.O)
    private PictureInPictureParams parameters() {
        PictureInPictureParams.Builder builder = new PictureInPictureParams.Builder().setAspectRatio(aspect);
        if (session.isEmpty()) return builder.setActions(Collections.emptyList()).build();
        return builder.setActions(Arrays.asList(
            action("seekbackward", R.drawable.ic_pip_rewind, R.string.pip_rewind, seekable),
            action(playing ? "pause" : "play", playing ? R.drawable.ic_pip_pause : R.drawable.ic_pip_play,
                playing ? R.string.pip_pause : R.string.pip_play, true),
            action("seekforward", R.drawable.ic_pip_forward, R.string.pip_forward, seekable))).build();
    }

    @androidx.annotation.RequiresApi(Build.VERSION_CODES.O)
    private RemoteAction action(String command, int icon, int label, boolean enabled) {
        Intent intent = new Intent(ACTION).setPackage(getContext().getPackageName())
            .setData(new Uri.Builder().scheme("lingua-pip").authority("control").appendPath(session).appendPath(command).build())
            .putExtra("session", session).putExtra("control", command);
        PendingIntent pending = PendingIntent.getBroadcast(getContext(), 0, intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        String title = getContext().getString(label);
        RemoteAction action = new RemoteAction(Icon.createWithResource(getContext(), icon), title, title, pending);
        action.setEnabled(enabled);
        return action;
    }

    private void clear() {
        session = ""; sequence = -1; playing = seekable = false;
        if (playback != null) playback.listeners.remove(playbackChanged);
        playback = null; nativeSession = "";
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !getActivity().isFinishing()
            && getContext().getPackageManager().hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)) {
            getActivity().setPictureInPictureParams(parameters());
        }
    }

    public void pipChanged(boolean active) {
        JSObject value = new JSObject(); value.put("active", active);
        notifyListeners("pipChanged", value);
    }

    @Override protected void handleOnDestroy() {
        if (registered) { getContext().unregisterReceiver(controls); registered = false; }
        bridge.removeWebViewListener(navigation);
        if (playback != null) playback.listeners.remove(playbackChanged);
        session = "";
    }
}
