package app.linguatrack.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;
import android.widget.Button;
import android.widget.TextView;
import androidx.test.core.app.ActivityScenario;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.json.*;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicReference;
import static org.junit.Assert.*;

public class DevelopmentActivityTest {
    private static final class Source implements AutoCloseable {
        final ServerSocket socket = new ServerSocket(0, 20, InetAddress.getByName("127.0.0.1"));
        volatile Map<String, byte[]> files;
        volatile byte[] manifest;
        final Thread thread;
        Source() throws Exception {
            version("first");
            thread = new Thread(() -> {
                while (!socket.isClosed()) try (Socket client = socket.accept()) {
                    BufferedReader input = new BufferedReader(new InputStreamReader(client.getInputStream(), StandardCharsets.UTF_8));
                    String path = input.readLine().split(" ")[1].split("\\?")[0];
                    String line; while ((line = input.readLine()) != null && !line.isEmpty()) { }
                    byte[] data = path.equals("/development-cache.json") ? manifest : files.get(path.equals("/") ? "/index.html" : path);
                    String mime = path.endsWith(".js") ? "text/javascript" : "text/html";
                    int status = data == null ? 404 : 200; if (data == null) data = new byte[0];
                    OutputStream output = client.getOutputStream();
                    output.write(("HTTP/1.1 " + status + " Test\r\nContent-Type: " + mime + "\r\nCache-Control: no-store\r\nContent-Length: " + data.length + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.UTF_8));
                    output.write(data);
                } catch (Exception ignored) { }
            });
            thread.start();
        }
        void version(String value) throws Exception {
            Map<String, byte[]> next = new LinkedHashMap<>();
            next.put("/index.html", ("<!doctype html><body><p>Cache fixture</p><script type='module'>import {version} from './js/main.js';document.body.dataset.version=version;window.testLazy=async()=>{document.body.dataset.lazy=(await import('./js/lazy.js')).version;};</script>").getBytes(StandardCharsets.UTF_8));
            next.put("/player.html", "<!doctype html><body>player".getBytes(StandardCharsets.UTF_8));
            next.put("/js/main.js", ("export const version='" + value + "';").getBytes(StandardCharsets.UTF_8));
            next.put("/js/lazy.js", ("export const version='" + value + "';").getBytes(StandardCharsets.UTF_8));
            JSONArray list = new JSONArray();
            for (Map.Entry<String, byte[]> file : next.entrySet()) list.put(new JSONObject().put("path", file.getKey().substring(1))
                .put("size", file.getValue().length).put("sha256", DevelopmentCache.hash(file.getValue())));
            files = next; manifest = new JSONObject().put("schema", 1).put("files", list).toString().getBytes(StandardCharsets.UTF_8);
        }
        public void close() throws Exception { socket.close(); thread.join(2000); }
    }
    private static View find(View view, java.util.function.Predicate<View> match) {
        if (match.test(view)) return view;
        if (view instanceof ViewGroup) {
            ViewGroup group = (ViewGroup) view;
            for (int i = 0; i < group.getChildCount(); i++) { View found = find(group.getChildAt(i), match); if (found != null) return found; }
        }
        return null;
    }
    private static void click(ActivityScenario<DevelopmentActivity> scenario, String text) {
        scenario.onActivity(activity -> {
            View button = find(activity.getWindow().getDecorView(), view -> view instanceof Button && text.contentEquals(((Button) view).getText()));
            assertNotNull(text, button); assertTrue(button.isEnabled()); button.performClick();
        });
    }
    private static String evaluate(ActivityScenario<DevelopmentActivity> scenario, String script) throws Exception {
        AtomicReference<String> value = new AtomicReference<>(); CountDownLatch ready = new CountDownLatch(1);
        scenario.onActivity(activity -> {
            WebView web = (WebView) find(activity.getWindow().getDecorView(), view -> view instanceof WebView);
            web.evaluateJavascript(script, result -> { value.set(result); ready.countDown(); });
        });
        // WebView may discard an evaluation queued while a document is replaced.
        ready.await(1, TimeUnit.SECONDS); return value.get();
    }
    private static void awaitVersion(ActivityScenario<DevelopmentActivity> scenario, String property, String version) throws Exception {
        for (int i = 0; i < 75; i++) {
            if (("\"" + version + "\"").equals(evaluate(scenario, "document.body?.dataset." + property))) return;
            Thread.sleep(200);
        }
        fail("Expected " + property + "=" + version + ", got " + evaluate(scenario, "document.body?.dataset." + property));
    }
    private static void awaitCached(ActivityScenario<DevelopmentActivity> scenario) throws Exception {
        for (int i = 0; i < 75; i++) {
            AtomicReference<Boolean> complete = new AtomicReference<>(false);
            scenario.onActivity(activity -> complete.set(find(activity.getWindow().getDecorView(), view -> view instanceof TextView
                && ((TextView) view).getText().toString().startsWith("已缓存 ")) != null));
            if (complete.get()) return;
            Thread.sleep(200);
        }
        fail("Cache completion not shown");
    }
    @Test public void cacheRefreshOfflineRestartAndLazyImportsUseTheExplicitSavedVersion() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        SharedPreferences preferences = context.getSharedPreferences("CapacitorStorage", Context.MODE_PRIVATE);
        String previous = preferences.getString("lingua.development-url", null);
        try (Source source = new Source()) {
            String target = "http://127.0.0.1:" + source.socket.getLocalPort() + "/index.html?debug=1#fixture";
            preferences.edit().putString("lingua.development-url", target).commit();
            try {
                try (ActivityScenario<DevelopmentActivity> scenario = ActivityScenario.launch(DevelopmentActivity.class)) {
                    awaitVersion(scenario, "version", "first");
                    click(scenario, "‹/›"); click(scenario, "缓存前端源码"); awaitCached(scenario);
                    source.version("latest"); click(scenario, "刷新网页"); awaitVersion(scenario, "version", "latest");
                    source.close(); click(scenario, "刷新网页"); awaitVersion(scenario, "version", "first");
                    evaluate(scenario, "window.testLazy()"); awaitVersion(scenario, "lazy", "first");
                    assertTrue(evaluate(scenario, "location.search+location.hash").contains("debug=1#fixture"));
                }
                try (ActivityScenario<DevelopmentActivity> restarted = ActivityScenario.launch(DevelopmentActivity.class)) {
                    awaitVersion(restarted, "version", "first");
                    evaluate(restarted, "window.testLazy()"); awaitVersion(restarted, "lazy", "first");
                }
            } finally {
                new File(new File(context.getFilesDir(), "development-cache"), DevelopmentCache.hash(target.getBytes(StandardCharsets.UTF_8)) + ".json").delete();
            }
        } finally {
            if (previous == null) preferences.edit().remove("lingua.development-url").commit();
            else preferences.edit().putString("lingua.development-url", previous).commit();
        }
    }
    @Test public void recacheActivatesNewSourceEvenForAnUnchangedPageWithAFragment() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        SharedPreferences preferences = context.getSharedPreferences("CapacitorStorage", Context.MODE_PRIVATE);
        String previous = preferences.getString("lingua.development-url", null);
        try (Source source = new Source()) {
            String target = "http://127.0.0.1:" + source.socket.getLocalPort() + "/index.html#fixture";
            preferences.edit().putString("lingua.development-url", target).commit();
            try (ActivityScenario<DevelopmentActivity> scenario = ActivityScenario.launch(DevelopmentActivity.class)) {
                awaitVersion(scenario, "version", "first");
                click(scenario, "‹/›"); click(scenario, "缓存前端源码"); awaitCached(scenario);
                source.version("latest"); click(scenario, "缓存前端源码"); awaitCached(scenario);
                awaitVersion(scenario, "version", "latest");
                source.close(); evaluate(scenario, "window.testLazy()"); awaitVersion(scenario, "lazy", "latest");
            } finally {
                new File(new File(context.getFilesDir(), "development-cache"), DevelopmentCache.hash(target.getBytes(StandardCharsets.UTF_8)) + ".json").delete();
            }
        } finally {
            if (previous == null) preferences.edit().remove("lingua.development-url").commit();
            else preferences.edit().putString("lingua.development-url", previous).commit();
        }
    }
}
