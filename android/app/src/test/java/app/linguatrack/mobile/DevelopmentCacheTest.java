package app.linguatrack.mobile;

import org.junit.*;
import org.junit.rules.TemporaryFolder;
import org.json.*;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import static org.junit.Assert.*;

public class DevelopmentCacheTest {
    @Rule public TemporaryFolder directory = new TemporaryFolder();
    private ServerSocket server;
    private Thread worker;
    private String target;
    private volatile Map<String, byte[]> resources;
    private volatile byte[] manifest;
    private final List<String> requests = Collections.synchronizedList(new ArrayList<>());

    @Before public void start() throws Exception {
        server = new ServerSocket(0, 20, InetAddress.getByName("127.0.0.1"));
        target = "http://127.0.0.1:" + server.getLocalPort() + "/lingua/index.html?debug=1#settings";
        version("first");
        worker = new Thread(() -> {
            while (!server.isClosed()) try (Socket socket = server.accept()) {
                BufferedReader input = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8));
                String path = input.readLine().split(" ")[1];
                String header; while ((header = input.readLine()) != null && !header.isEmpty()) { }
                requests.add(path);
                byte[] bytes = path.equals("/lingua/development-cache.json") ? manifest : resources.get(path.split("\\?")[0]);
                int status = bytes == null ? 404 : 200;
                if (bytes == null) bytes = new byte[0];
                OutputStream output = socket.getOutputStream();
                output.write(("HTTP/1.1 " + status + " Test\r\nContent-Length: " + bytes.length + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.UTF_8));
                output.write(bytes);
            } catch (Exception ignored) { }
        });
        worker.start();
    }
    @After public void stop() throws Exception { server.close(); worker.join(2000); }
    private void version(String value) throws Exception {
        Map<String, byte[]> files = new LinkedHashMap<>();
        files.put("/lingua/index.html", value.getBytes(StandardCharsets.UTF_8));
        files.put("/lingua/player.html", "player".getBytes(StandardCharsets.UTF_8));
        files.put("/lingua/js/lazy.js", ("export const version = '" + value + "';").getBytes(StandardCharsets.UTF_8));
        files.put("/lingua/assets/sample.wav", new byte[] { 0, 1, -1, -128, 127 });
        resources = files;
        JSONArray list = new JSONArray();
        for (Map.Entry<String, byte[]> item : files.entrySet()) list.put(new JSONObject()
            .put("path", item.getKey().substring("/lingua/".length())).put("size", item.getValue().length)
            .put("sha256", DevelopmentCache.hash(item.getValue())));
        manifest = new JSONObject().put("schema", 1).put("files", list).toString().getBytes(StandardCharsets.UTF_8);
    }
    private String text(DevelopmentCache cache, String url) { return new String(cache.entry(url).bytes, StandardCharsets.UTF_8); }

    @Test public void explicitSnapshotSurvivesServerShutdownAndLazyNavigation() throws Exception {
        DevelopmentCache cache = new DevelopmentCache(directory.getRoot(), target);
        assertFalse(cache.available()); assertTrue(requests.isEmpty());
        assertEquals(4, cache.download());
        assertTrue(requests.contains("/lingua/index.html?debug=1"));
        int count = requests.size();
        version("latest");
        assertEquals("first", text(cache, target));
        assertEquals(count, requests.size()); // Reading/navigation never updates or fetches.
        server.close();
        DevelopmentCache reopened = new DevelopmentCache(directory.getRoot(), target);
        assertEquals("first", text(reopened, target));
        String root = target.substring(0, target.indexOf("index.html"));
        assertEquals("first", text(reopened, root));
        assertEquals("player", text(reopened, root + "player.html?track=123"));
        assertTrue(text(reopened, root + "js/lazy.js?v=2").contains("first"));
        assertArrayEquals(new byte[] { 0, 1, -1, -128, 127 }, reopened.entry(root + "assets/sample.wav").bytes);
        assertNull(reopened.entry(root + "api/health"));
        assertNull(reopened.entry("https://other.example/lingua/index.html"));
        assertFalse(new DevelopmentCache(directory.getRoot(), target.replace("debug=1", "debug=2")).available());
    }
    @Test public void onlySuccessfulManualRecacheReplacesTheSavedSource() throws Exception {
        DevelopmentCache cache = new DevelopmentCache(directory.getRoot(), target);
        cache.download(); version("second"); cache.download();
        assertEquals("second", text(cache, target));
        version("third");
        resources = new HashMap<>(resources); resources.put("/lingua/js/lazy.js", "changed".getBytes(StandardCharsets.UTF_8));
        assertThrows(IOException.class, cache::download);
        assertEquals("second", text(new DevelopmentCache(directory.getRoot(), target), target));
        server.close(); assertThrows(IOException.class, cache::download);
        assertEquals("second", text(cache, target));
    }
    @Test public void incompleteUnsafeAndOversizedManifestsLeaveTheOldSnapshot() throws Exception {
        DevelopmentCache cache = new DevelopmentCache(directory.getRoot(), target); cache.download();
        for (String path : Arrays.asList("../.env", "js/../../.env", "https://evil.test/x", "/index.html", "data/track.json")) {
            assertFalse(DevelopmentCache.validPath(path));
            manifest = new JSONObject().put("schema", 1).put("files", new JSONArray().put(new JSONObject()
                .put("path", path).put("size", 1).put("sha256", "a"))).toString().getBytes(StandardCharsets.UTF_8);
            assertThrows(IOException.class, cache::download);
        }
        version("second"); resources = new HashMap<>(resources); resources.remove("/lingua/player.html");
        assertThrows(IOException.class, cache::download);
        version("second"); JSONObject data = new JSONObject(new String(manifest, StandardCharsets.UTF_8));
        data.getJSONArray("files").getJSONObject(0).put("size", DevelopmentCache.LIMIT + 1);
        manifest = data.toString().getBytes(StandardCharsets.UTF_8);
        assertThrows(IOException.class, cache::download);
        assertEquals("first", text(new DevelopmentCache(directory.getRoot(), target), target));
    }
    @Test public void interruptedCommitBackupRemainsReadable() throws Exception {
        DevelopmentCache cache = new DevelopmentCache(directory.getRoot(), target); cache.download();
        File file = new File(directory.getRoot(), DevelopmentCache.hash(target.getBytes(StandardCharsets.UTF_8)) + ".json");
        assertTrue(file.renameTo(new File(file.getPath() + ".bak")));
        DevelopmentCache recovered = new DevelopmentCache(directory.getRoot(), target);
        assertEquals("first", text(recovered, target));
        version("second"); recovered.download();
        assertEquals("second", text(new DevelopmentCache(directory.getRoot(), target), target));
    }
}
