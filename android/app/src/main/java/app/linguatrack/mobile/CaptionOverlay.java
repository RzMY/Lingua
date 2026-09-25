package app.linguatrack.mobile;

import android.annotation.SuppressLint;
import android.content.Context;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

/** Small transparent native window. Only its own bounds receive touches; it never takes focus. */
final class CaptionOverlay {
    private final Context context;
    private final WindowManager windows;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final FrameLayout root;
    private final TextView original, translation, close;
    private final WindowManager.LayoutParams params;
    private final Runnable onClose;
    private final Runnable hideControls = () -> showControls(false);
    private final Rect bounds = new Rect();
    private boolean attached, dragging;
    private float downX, downY;
    private int startX, startY;
    private String lastText = "", lastTranslation = "";
    private float lastSize = -1;

    // touch() calls performClick on taps; window x/y are physical screen coordinates even in RTL.
    @SuppressLint({"ClickableViewAccessibility", "RtlHardcoded"})
    CaptionOverlay(Context context, Runnable onClose) {
        this.context = context;
        this.onClose = onClose;
        windows = (WindowManager) context.getSystemService(Context.WINDOW_SERVICE);
        root = new FrameLayout(context);
        root.setPadding(dp(10), dp(8), dp(10), dp(8));
        root.setMinimumHeight(dp(64));
        root.setContentDescription("字幕悬浮窗，拖动调整位置，点按显示关闭按钮");
        root.setOnClickListener(view -> revealControls());
        root.setOnTouchListener(this::touch);

        LinearLayout captions = new LinearLayout(context);
        captions.setOrientation(LinearLayout.VERTICAL);
        captions.setGravity(Gravity.CENTER);
        // Reserve a touch target so closing the window never obscures the text.
        FrameLayout.LayoutParams textLayout = new FrameLayout.LayoutParams(-1, -2);
        textLayout.setMarginEnd(dp(38));
        root.addView(captions, textLayout);
        original = label(Color.WHITE, Typeface.BOLD);
        translation = label(0xffeeeeee, Typeface.NORMAL);
        captions.addView(original, new LinearLayout.LayoutParams(-1, -2));
        LinearLayout.LayoutParams trLayout = new LinearLayout.LayoutParams(-1, -2);
        trLayout.topMargin = dp(5);
        captions.addView(translation, trLayout);
        close = new TextView(context);
        close.setText("×");
        close.setTextColor(Color.WHITE);
        close.setTextSize(26);
        close.setGravity(Gravity.CENTER);
        close.setContentDescription("关闭字幕悬浮窗");
        close.setOnClickListener(view -> onClose.run());
        TypedValue feedback = new TypedValue();
        context.getTheme().resolveAttribute(android.R.attr.selectableItemBackgroundBorderless, feedback, true);
        if (feedback.resourceId != 0) close.setBackgroundResource(feedback.resourceId);
        root.addView(close, new FrameLayout.LayoutParams(dp(48), dp(48), Gravity.END | Gravity.TOP));

        int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY : WindowManager.LayoutParams.TYPE_PHONE;
        params = new WindowManager.LayoutParams(-2, -2, type,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
            PixelFormat.TRANSLUCENT);
        params.gravity = Gravity.TOP | Gravity.LEFT;
        params.setTitle("Lingua 字幕");
        // Explicit opacity keeps touches outside this window compatible with Android 12+.
        params.alpha = 0.8f;
        root.addOnLayoutChangeListener((view, l, t, r, b, ol, ot, or, ob) -> {
            if (attached && b - t != ob - ot) clampAndUpdate();
        });
    }

    private TextView label(int color, int style) {
        TextView view = new TextView(context);
        view.setTextColor(color);
        view.setTypeface(Typeface.DEFAULT, style);
        view.setGravity(Gravity.CENTER);
        view.setIncludeFontPadding(false);
        view.setEllipsize(TextUtils.TruncateAt.END);
        view.setShadowLayer(dp(3), 0, dp(1), Color.BLACK);
        return view;
    }

    void show() {
        measureBounds();
        params.x = bounds.left + (bounds.width() - params.width) / 2;
        params.y = bounds.top + bounds.height() * 2 / 3;
        root.measure(View.MeasureSpec.makeMeasureSpec(params.width, View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(bounds.height(), View.MeasureSpec.AT_MOST));
        clamp(root.getMeasuredHeight());
        windows.addView(root, params);
        attached = true;
        revealControls();
    }

    void render(String text, String tr, float size) {
        if (!lastText.equals(text)) { original.setText(text); lastText = text; }
        if (!lastTranslation.equals(tr)) { translation.setText(tr); lastTranslation = tr; }
        translation.setVisibility(tr.isEmpty() ? View.GONE : View.VISIBLE);
        if (lastSize != size) {
            original.setTextSize(TypedValue.COMPLEX_UNIT_SP, size);
            translation.setTextSize(TypedValue.COMPLEX_UNIT_SP, size * 0.8f);
            lastSize = size;
            if (attached) reflow();
        }
    }

    void reflow() {
        if (!attached) return;
        // A system font-scale change can arrive without a new captionSize value.
        if (lastSize > 0) {
            original.setTextSize(TypedValue.COMPLEX_UNIT_SP, lastSize);
            translation.setTextSize(TypedValue.COMPLEX_UNIT_SP, lastSize * 0.8f);
        }
        measureBounds();
        clampAndUpdate();
    }

    private void measureBounds() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            var metrics = windows.getMaximumWindowMetrics();
            bounds.set(metrics.getBounds());
            var insets = metrics.getWindowInsets().getInsetsIgnoringVisibility(
                WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
            // Default window fitting places x/y inside these system insets already.
            bounds.set(0, 0, bounds.width() - insets.left - insets.right,
                bounds.height() - insets.top - insets.bottom);
        } else {
            android.util.DisplayMetrics metrics = new android.util.DisplayMetrics();
            windows.getDefaultDisplay().getMetrics(metrics);
            bounds.set(0, 0, metrics.widthPixels, metrics.heightPixels);
        }
        bounds.inset(dp(8), dp(8));
        params.width = Math.min(dp(560), Math.round(bounds.width() * 0.92f));
        // Bound long sentences and large accessibility fonts in landscape as well.
        int rows = Math.max(2, (int) (bounds.height() * 0.5f / Math.max(dp(24), original.getTextSize() * 1.4f)));
        original.setMaxLines(Math.min(5, Math.max(1, rows * 2 / 3)));
        translation.setMaxLines(Math.min(3, Math.max(1, rows / 3)));
    }

    private void clamp(int height) {
        params.x = Math.max(bounds.left, Math.min(params.x, bounds.right - params.width));
        params.y = Math.max(bounds.top, Math.min(params.y, bounds.bottom - height));
    }

    private void clampAndUpdate() {
        clamp(root.getHeight());
        try { windows.updateViewLayout(root, params); }
        catch (RuntimeException error) { onClose.run(); }
    }

    private boolean touch(View view, MotionEvent event) {
        switch (event.getActionMasked()) {
            case MotionEvent.ACTION_DOWN:
                downX = event.getRawX(); downY = event.getRawY();
                startX = params.x; startY = params.y; dragging = false;
                handler.removeCallbacks(hideControls);
                return true;
            case MotionEvent.ACTION_MOVE:
                float dx = event.getRawX() - downX, dy = event.getRawY() - downY;
                if (Math.hypot(dx, dy) > ViewConfiguration.get(context).getScaledTouchSlop()) dragging = true;
                if (dragging) {
                    params.x = startX + Math.round(dx); params.y = startY + Math.round(dy);
                    clampAndUpdate();
                }
                return true;
            case MotionEvent.ACTION_UP:
                if (!dragging) view.performClick(); else revealControls();
                return true;
            case MotionEvent.ACTION_CANCEL:
                revealControls(); return true;
            default: return false;
        }
    }

    private void revealControls() {
        handler.removeCallbacks(hideControls);
        showControls(true);
        handler.postDelayed(hideControls, 3000);
    }

    private void showControls(boolean visible) {
        close.setVisibility(visible ? View.VISIBLE : View.INVISIBLE);
        if (visible) {
            GradientDrawable background = new GradientDrawable();
            background.setColor(0xb3222222); background.setCornerRadius(dp(16));
            root.setBackground(background);
        } else root.setBackgroundColor(Color.TRANSPARENT);
    }

    void dismiss() {
        handler.removeCallbacksAndMessages(null);
        if (!attached) return;
        attached = false;
        try { windows.removeViewImmediate(root); }
        catch (IllegalArgumentException ignored) { /* The system already removed the window. */ }
    }

    private int dp(float value) { return Math.round(value * context.getResources().getDisplayMetrics().density); }
}
