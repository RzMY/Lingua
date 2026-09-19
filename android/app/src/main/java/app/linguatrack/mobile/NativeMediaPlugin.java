package app.linguatrack.mobile;

import android.app.PictureInPictureParams;
import android.content.pm.PackageManager;
import android.os.Build;
import android.util.Rational;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "NativeMedia")
public class NativeMediaPlugin extends Plugin {
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
                boolean entered = getActivity().enterPictureInPictureMode(new PictureInPictureParams.Builder()
                    .setAspectRatio(new Rational(Math.round(ratio * 1000), 1000)).build());
                if (entered) call.resolve(); else call.reject("请在系统设置中允许 Lingua 使用画中画");
            } catch (Exception error) { call.reject("无法进入画中画", error); }
        });
    }

    public void pipChanged(boolean active) {
        JSObject value = new JSObject(); value.put("active", active);
        notifyListeners("pipChanged", value);
    }
}
