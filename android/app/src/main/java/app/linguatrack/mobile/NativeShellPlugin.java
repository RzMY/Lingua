package app.linguatrack.mobile;

import android.content.Intent;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "NativeShell")
public class NativeShellPlugin extends Plugin {
    @PluginMethod public void openDevelopment(PluginCall call) {
        if (!DevelopmentActivity.validUrl(call.getString("url", ""))) {
            call.reject("请输入 HTTP 或 HTTPS 调试地址"); return;
        }
        getActivity().runOnUiThread(() -> {
            call.resolve();
            getActivity().startActivity(new Intent(getActivity(), DevelopmentActivity.class));
            getActivity().finish();
        });
    }
}
