package app.linguatrack.mobile;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.webkit.*;
import android.widget.*;
import androidx.core.graphics.Insets;
import androidx.core.view.*;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import org.json.JSONObject;

/** Remote browsing has no Capacitor bridge; its only message is a presentation hint. */
public class DevelopmentActivity extends Activity {
    private WebView web;
    private FrameLayout root;
    private Button bubble, reload, back;
    private LinearLayout menu;
    private TextView errorLabel;
    private String url;
    private ValueCallback<Uri[]> files;
    private Insets safe = Insets.NONE;
    private boolean dark, immersive, placed, dragging;
    private float downX, downY, startX, startY;
    private androidx.webkit.ScriptHandler presentationScript;
    private String insetValues = "";

    static boolean validUrl(String raw) {
        Uri uri = Uri.parse(raw);
        return ("https".equals(uri.getScheme()) || "http".equals(uri.getScheme()))
            && uri.getHost() != null && uri.getUserInfo() == null;
    }
    private int dp(float value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    private GradientDrawable surface(int color, int radius) {
        GradientDrawable shape = new GradientDrawable(); shape.setColor(color); shape.setCornerRadius(dp(radius)); return shape;
    }
    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        getWindow().setStatusBarColor(Color.TRANSPARENT);
        getWindow().setNavigationBarColor(Color.TRANSPARENT);
        if (Build.VERSION.SDK_INT >= 29) getWindow().setNavigationBarContrastEnforced(false);
        url = getSharedPreferences("CapacitorStorage", MODE_PRIVATE).getString("lingua.development-url", "");
        root = new FrameLayout(this);
        web = new WebView(this);
        web.getSettings().setJavaScriptEnabled(true);
        web.getSettings().setDomStorageEnabled(true);
        web.getSettings().setCacheMode(WebSettings.LOAD_NO_CACHE);
        web.getSettings().setAllowFileAccess(false);
        web.getSettings().setAllowContentAccess(false);
        root.addView(web, new FrameLayout.LayoutParams(-1, -1));
        createControls(); setContentView(root);
        ViewCompat.setOnApplyWindowInsetsListener(root, (view, insets) -> {
            // The canvas fills the window; only controls consume physical safe areas.
            safe = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            injectInsets(); placeControls(); return insets;
        });
        root.addOnLayoutChangeListener((v, l, t, r, b, ol, ot, or, ob) -> placeControls());
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(web, "LinguaPresentation", java.util.Collections.singleton("*"), (view, message, origin, mainFrame, reply) -> {
                if (!mainFrame) return;
                try {
                    JSONObject state = new JSONObject(message.getData());
                    dark = state.optBoolean("dark"); immersive = state.optBoolean("immersive"); applyTheme();
                } catch (Exception ignored) { }
            });
        }
        injectInsets();
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (files != null) files.onReceiveValue(null);
                files = callback;
                try { startActivityForResult(params.createIntent(), 100); }
                catch (Exception error) { files.onReceiveValue(null); files = null; showError("无法打开文件选择器"); }
                return true;
            }
        });
        web.setWebViewClient(new WebViewClient() {
            @Override public void onPageStarted(WebView view, String address, android.graphics.Bitmap icon) {
                immersive = false; applyTheme(); errorLabel.setVisibility(View.GONE); injectInsets();
            }
            @Override public void onPageFinished(WebView view, String address) {
                web.evaluateJavascript(PRESENTATION_SCRIPT, null); injectInsets();
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !validUrl(request.getUrl().toString());
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) showError("网页加载失败");
            }
            @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
                if (request.isForMainFrame()) showError("网页暂时无法访问");
            }
        });
        applyTheme(); ViewCompat.requestApplyInsets(root); loadPage();
    }
    private void createControls() {
        menu = new LinearLayout(this); menu.setOrientation(LinearLayout.VERTICAL); menu.setPadding(dp(12), dp(8), dp(12), dp(8));
        menu.setElevation(dp(12)); menu.setVisibility(View.GONE);
        errorLabel = new TextView(this); errorLabel.setTextSize(14); errorLabel.setPadding(dp(8), dp(8), dp(8), dp(8)); errorLabel.setVisibility(View.GONE);
        reload = action("刷新网页", () -> { menu.setVisibility(View.GONE); if (web.getUrl() == null) loadPage(); else web.reload(); });
        back = action("返回正式分支", this::returnToApp);
        menu.addView(errorLabel); menu.addView(reload); menu.addView(back);
        root.addView(menu, new FrameLayout.LayoutParams(dp(208), -2));
        bubble = new Button(this); bubble.setText("‹/›"); bubble.setTextSize(18); bubble.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        bubble.setPadding(0, 0, 0, 0); bubble.setMinWidth(0); bubble.setMinHeight(0); bubble.setElevation(dp(8));
        bubble.setContentDescription("开发控制");
        root.addView(bubble, new FrameLayout.LayoutParams(dp(52), dp(52)));
        bubble.setOnClickListener(v -> { menu.setVisibility(menu.getVisibility() == View.VISIBLE ? View.GONE : View.VISIBLE); menu.post(this::placeControls); });
        bubble.setOnTouchListener((v, event) -> {
            switch (event.getActionMasked()) {
                case MotionEvent.ACTION_DOWN:
                    downX = event.getRawX(); downY = event.getRawY(); startX = bubble.getX(); startY = bubble.getY(); dragging = false; return true;
                case MotionEvent.ACTION_MOVE:
                    float dx = event.getRawX() - downX, dy = event.getRawY() - downY;
                    if (Math.hypot(dx, dy) > ViewConfiguration.get(this).getScaledTouchSlop()) dragging = true;
                    if (dragging) { menu.setVisibility(View.GONE); bubble.setX(startX + dx); bubble.setY(startY + dy); placeControls(); }
                    return true;
                case MotionEvent.ACTION_UP:
                    if (!dragging) v.performClick(); else placeControls(); return true;
                case MotionEvent.ACTION_CANCEL: placeControls(); return true;
                default: return false;
            }
        });
    }
    private Button action(String text, Runnable run) {
        Button button = new Button(this); button.setText(text); button.setTextSize(15); button.setAllCaps(false);
        button.setGravity(Gravity.START | Gravity.CENTER_VERTICAL); button.setPadding(dp(8), 0, dp(8), 0);
        button.setBackgroundColor(Color.TRANSPARENT); button.setMinHeight(dp(48)); button.setOnClickListener(v -> run.run()); return button;
    }
    private float clamp(float value, float min, float max) { return Math.max(min, Math.min(value, Math.max(min, max))); }
    private void placeControls() {
        if (root.getWidth() == 0) return;
        float left = safe.left + dp(12), top = safe.top + dp(12);
        float right = root.getWidth() - safe.right - dp(12), bottom = root.getHeight() - safe.bottom - dp(12);
        if (!placed) { bubble.setX(right - dp(52)); bubble.setY(top + (bottom - top) * .65f); placed = true; }
        bubble.setX(clamp(bubble.getX(), left, right - dp(52))); bubble.setY(clamp(bubble.getY(), top, bottom - dp(52)));
        menu.setX(clamp(bubble.getX() + dp(52) - menu.getWidth(), left, right - menu.getWidth()));
        float above = bubble.getY() - menu.getHeight() - dp(10);
        menu.setY(clamp(above >= top ? above : bubble.getY() + dp(62), top, bottom - menu.getHeight()));
    }
    private void applyTheme() {
        int bg = immersive ? Color.BLACK : dark ? 0xff15170f : 0xfff2f2ea;
        root.setBackgroundColor(bg); web.setBackgroundColor(bg);
        menu.setBackground(surface(dark ? 0xff262b1b : 0xfff7f7f1, 20));
        for (TextView label : new TextView[] { reload, back, errorLabel }) label.setTextColor(dark ? 0xffeef1e3 : 0xff1b1f16);
        bubble.setBackground(surface(dark ? 0xff33421f : 0xffd7e6c4, 26)); bubble.setTextColor(dark ? 0xffa8d68a : 0xff4f7a37);
        WindowInsetsControllerCompat bars = WindowCompat.getInsetsController(getWindow(), root);
        bars.setAppearanceLightStatusBars(!dark && !immersive); bars.setAppearanceLightNavigationBars(!dark && !immersive);
        bars.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        if (immersive) bars.hide(WindowInsetsCompat.Type.systemBars()); else bars.show(WindowInsetsCompat.Type.systemBars());
    }
    private void injectInsets() {
        float density = getResources().getDisplayMetrics().density;
        String values = "[" + safe.top / density + "," + safe.right / density + "," + safe.bottom / density + "," + safe.left / density + "]";
        if (!values.equals(insetValues) && WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            insetValues = values;
            if (presentationScript != null) presentationScript.remove();
            presentationScript = WebViewCompat.addDocumentStartJavaScript(web,
                "window.__linguaInsets=" + values + ";" + PRESENTATION_SCRIPT, java.util.Collections.singleton("*"));
        }
        web.evaluateJavascript("window.__linguaInsets=" + values + ";window.__linguaApplyInsets?.();", null);
    }
    private void showError(String message) {
        errorLabel.setText(message); errorLabel.setVisibility(View.VISIBLE); menu.setVisibility(View.VISIBLE); menu.post(this::placeControls);
    }
    private void loadPage() { if (validUrl(url)) web.loadUrl(url); else showError("开发地址无效"); }
    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request == 100 && files != null) { files.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result, data)); files = null; }
    }
    private void returnToApp() {
        getSharedPreferences("CapacitorStorage", MODE_PRIVATE).edit().putString("lingua.channel", "stable").apply();
        startActivity(new Intent(this, MainActivity.class).setAction(Intent.ACTION_APPLICATION_PREFERENCES)); finish();
    }
    @Override public void onBackPressed() {
        if (menu.getVisibility() == View.VISIBLE) menu.setVisibility(View.GONE);
        else web.evaluateJavascript("window.dispatchEvent(new CustomEvent('native-back',{cancelable:true}))", (unhandled) -> {
            if ("false".equals(unhandled)) return;
            if (web.canGoBack()) web.goBack(); else returnToApp();
        });
    }
    @Override protected void onDestroy() {
        if (files != null) { files.onReceiveValue(null); files = null; }
        if (web != null) { root.removeView(web); web.destroy(); }
        super.onDestroy();
    }
    private static final String PRESENTATION_SCRIPT = """
        (() => {
          if (window.__linguaPresentation) return;
          window.__linguaPresentation = true;
          const install = () => {
            const root = document.documentElement;
            if (!root) return;
            root.classList.add('native-app');
            window.__linguaApplyInsets = () => {
              (window.__linguaInsets || [0,0,0,0]).forEach((v,i) => root.style.setProperty('--native-safe-' + ['t','r','b','l'][i], v + 'px'));
            };
            window.__linguaApplyInsets();
            const sync = () => window.LinguaPresentation?.postMessage(JSON.stringify({dark:root.dataset.theme === 'dark',immersive:root.classList.contains('video-immersive')}));
            new MutationObserver(sync).observe(root,{attributes:true,attributeFilter:['class','data-theme']});
            sync();
          };
          if (document.documentElement) install(); else document.addEventListener('DOMContentLoaded',install,{once:true});
        })();
        """;
}
