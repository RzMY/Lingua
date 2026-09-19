package app.linguatrack.mobile;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.view.ViewGroup;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebChromeClient;
import android.webkit.ValueCallback;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

/** Direct remote browsing with no Capacitor JavaScript bridge or local-code fallback. */
public class DevelopmentActivity extends Activity {
    private WebView web;
    private String url;
    private TextView status;
    private ValueCallback<Uri[]> files;
    static boolean validUrl(String raw) {
        Uri uri = Uri.parse(raw);
        return ("https".equals(uri.getScheme()) || "http".equals(uri.getScheme()))
            && uri.getHost() != null && uri.getUserInfo() == null;
    }
    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        url = getSharedPreferences("CapacitorStorage", MODE_PRIVATE).getString("lingua.development-url", "");
        LinearLayout root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(0xfff2f2ea);
        ViewCompat.setOnApplyWindowInsetsListener(root, (view, insets) -> {
            var bars = insets.getInsets(WindowInsetsCompat.Type.systemBars());
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom); return insets;
        });
        LinearLayout bar = new LinearLayout(this);
        Button back = new Button(this); back.setText("返回正式分支"); back.setOnClickListener(v -> returnToApp());
        Button reload = new Button(this); reload.setText("重新加载"); reload.setOnClickListener(v -> loadPage());
        bar.addView(back); bar.addView(reload);
        status = new TextView(this); status.setText("开发分支 · 远端网页");
        web = new WebView(this);
        web.getSettings().setJavaScriptEnabled(true);
        web.getSettings().setDomStorageEnabled(true);
        web.getSettings().setCacheMode(WebSettings.LOAD_NO_CACHE);
        web.getSettings().setAllowFileAccess(false);
        web.getSettings().setAllowContentAccess(false);
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (files != null) files.onReceiveValue(null);
                files = callback;
                try { startActivityForResult(params.createIntent(), 100); }
                catch (Exception error) { files.onReceiveValue(null); files = null; status.setText("无法打开系统文件选择器"); }
                return true;
            }
        });
        web.setWebViewClient(new WebViewClient() {
            @Override public void onPageFinished(WebView view, String address) { status.setText("开发分支 · " + address); }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !validUrl(request.getUrl().toString());
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) status.setText("加载失败，可重新加载或返回设置");
            }
        });
        root.addView(bar); root.addView(status);
        root.addView(web, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        setContentView(root); loadPage();
    }
    private void loadPage() {
        if (validUrl(url)) { status.setText("正在加载开发网页…"); web.loadUrl(url); }
        else status.setText("调试地址无效，请返回设置");
    }
    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request == 100 && files != null) { files.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result, data)); files = null; }
    }
    private void returnToApp() {
        getSharedPreferences("CapacitorStorage", MODE_PRIVATE).edit().putString("lingua.channel", "stable").apply();
        startActivity(new Intent(this, MainActivity.class).setAction(Intent.ACTION_APPLICATION_PREFERENCES)); finish();
    }
    @Override public void onBackPressed() { if (web.canGoBack()) web.goBack(); else returnToApp(); }
    @Override protected void onDestroy() {
        if (files != null) { files.onReceiveValue(null); files = null; }
        if (web != null) web.destroy();
        super.onDestroy();
    }
}
