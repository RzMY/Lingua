package app.linguatrack.mobile;

import com.getcapacitor.BridgeActivity;
import android.content.Intent;
import android.content.res.Configuration;
import android.os.Bundle;

public class MainActivity extends BridgeActivity {
    @Override public void onCreate(Bundle state) {
        registerPlugin(NativeMediaPlugin.class);
        registerPlugin(CaptionPipPlugin.class);
        registerPlugin(NativeShellPlugin.class);
        super.onCreate(state);
    }

    @Override protected void load() {
        if (getSharedPreferences("CapacitorStorage", MODE_PRIVATE).getString("lingua.channel", "stable").equals("development")
                && !Intent.ACTION_APPLICATION_PREFERENCES.equals(getIntent().getAction())) {
            startActivity(new Intent(this, DevelopmentActivity.class));
            finish();
            return; // No Capacitor bridge or local HTML is loaded in development mode.
        }
        if (Intent.ACTION_APPLICATION_PREFERENCES.equals(getIntent().getAction())
                && getSharedPreferences("CapacitorStorage", MODE_PRIVATE).getString("lingua.channel", "stable").equals("development")) {
            DevelopmentActivity.restorePreviousChannel(this);
        }
        super.load();
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (intent != null && Intent.ACTION_APPLICATION_PREFERENCES.equals(intent.getAction())) openPreferences();
    }

    private void openPreferences() {
        // This route works both before and after JS bridge initialization.
        if (getBridge() != null) getBridge().getWebView().loadUrl("https://localhost/index.html#native-settings");
    }

    @Override public void onPictureInPictureModeChanged(boolean active, Configuration config) {
        super.onPictureInPictureModeChanged(active, config);
        if (getBridge() == null) return;
        var handle = getBridge().getPlugin("NativeMedia");
        if (handle != null) ((NativeMediaPlugin) handle.getInstance()).pipChanged(active);
    }
}
