package app.linguatrack.mobile;

import org.json.JSONArray;
import org.json.JSONObject;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;

/** A complete, immutable snapshot. Only download() writes; browsing never populates it. */
final class DevelopmentCache {
    static final int LIMIT = 32 * 1024 * 1024;
    private final URI target, base;
    private final File file;
    private volatile Snapshot snapshot;

    static final class Entry {
        final byte[] bytes;
        final String mime;
        Entry(byte[] bytes, String mime) { this.bytes = bytes; this.mime = mime; }
    }
    static final class Snapshot {
        final Map<String, Entry> entries;
        Snapshot(Map<String, Entry> entries) { this.entries = Collections.unmodifiableMap(entries); }
    }
    DevelopmentCache(File directory, String address) throws Exception {
        target = new URI(address); base = target.resolve(".");
        file = new File(directory, hash(address.getBytes(StandardCharsets.UTF_8)) + ".json");
        try {
            File source = file.isFile() ? file : new File(file.getPath() + ".bak");
            JSONObject stored = new JSONObject(new String(read(new FileInputStream(source), LIMIT * 3), StandardCharsets.UTF_8));
            if (!address.equals(stored.getString("target"))) return;
            JSONObject data = stored.getJSONObject("entries");
            Map<String, Entry> entries = new HashMap<>();
            Iterator<String> keys = data.keys();
            while (keys.hasNext()) {
                String key = keys.next(); JSONObject value = data.getJSONObject(key);
                entries.put(key, new Entry(decode(value.getString("data")), value.getString("mime")));
            }
            if (entries.containsKey(key(target))) snapshot = new Snapshot(entries);
        } catch (Exception ignored) { /* Missing or damaged cache: live page still works. */ }
    }
    boolean available() { return snapshot != null; }
    Entry entry(String address) {
        Snapshot current = snapshot;
        if (current == null) return null;
        try {
            URI uri = new URI(address);
            if (!sameOrigin(base, uri)) return null;
            return current.entries.get(key(uri));
        } catch (Exception ignored) { return null; }
    }
    boolean contains(String address) { return entry(address) != null; }

    int download() throws Exception {
        long deadline = System.nanoTime() + 120_000_000_000L;
        JSONObject manifest = new JSONObject(new String(fetch(base.resolve("development-cache.json"), 1024 * 1024), StandardCharsets.UTF_8));
        if (manifest.getInt("schema") != 1) throw new IOException("缓存清单版本不支持");
        JSONArray files = manifest.getJSONArray("files");
        if (files.length() == 0 || files.length() > 2048) throw new IOException("缓存清单无效");
        Map<String, Entry> entries = new HashMap<>();
        long total = 0;
        boolean home = false, player = false;
        for (int i = 0; i < files.length(); i++) {
            checkCancelled(deadline);
            JSONObject item = files.getJSONObject(i);
            String path = item.getString("path");
            if (!validPath(path)) throw new IOException("缓存资源路径无效");
            long size = item.getLong("size");
            if (size < 0 || (total += size) > LIMIT) throw new IOException("前端缓存超过 32 MiB");
            URI resource = base.resolve(path);
            if (entries.containsKey(key(resource))) throw new IOException("缓存资源重复");
            // Preserve a configured entry's query string without caching API or user responses.
            URI request = key(resource).equals(key(target)) ? target : resource;
            byte[] bytes = fetch(request, (int) size + 1);
            if (bytes.length != size || !hash(bytes).equals(item.getString("sha256"))) {
                throw new IOException("源码已变化，请重试缓存");
            }
            entries.put(key(resource), new Entry(bytes, mime(path)));
            home |= path.equals("index.html"); player |= path.equals("player.html");
        }
        if (!home || !player || !entries.containsKey(key(target))) throw new IOException("缓存缺少前端入口");
        JSONObject data = new JSONObject();
        for (Map.Entry<String, Entry> item : entries.entrySet()) {
            data.put(item.getKey(), new JSONObject().put("mime", item.getValue().mime)
                .put("data", encode(item.getValue().bytes)));
        }
        byte[] stored = new JSONObject().put("target", target.toString()).put("entries", data).toString().getBytes(StandardCharsets.UTF_8);
        if (!file.getParentFile().isDirectory() && !file.getParentFile().mkdirs()) throw new IOException("无法保存缓存");
        File pending = File.createTempFile("snapshot-", ".tmp", file.getParentFile());
        try {
            try (FileOutputStream output = new FileOutputStream(pending)) { output.write(stored); output.getFD().sync(); }
            checkCancelled(deadline);
            // Keep a recoverable old file across both renames, including on filesystems
            // that cannot rename over an existing target. Startup also reads the backup.
            File backup = new File(file.getPath() + ".bak");
            if (file.exists()) {
                if (backup.exists() && !backup.delete()) throw new IOException("无法保存缓存");
                if (!file.renameTo(backup)) throw new IOException("无法保存缓存");
            }
            if (!pending.renameTo(file)) {
                backup.renameTo(file);
                throw new IOException("无法保存缓存");
            }
            snapshot = new Snapshot(entries);
            backup.delete();
        } finally { pending.delete(); }
        return entries.size();
    }
    private byte[] fetch(URI uri, int limit) throws Exception {
        if (!sameOrigin(base, uri)) throw new IOException("缓存资源不属于开发地址");
        HttpURLConnection connection = (HttpURLConnection) uri.toURL().openConnection();
        connection.setConnectTimeout(10000); connection.setReadTimeout(15000);
        connection.setUseCaches(false); connection.setInstanceFollowRedirects(false);
        connection.setRequestProperty("Cache-Control", "no-cache, no-store");
        try {
            if (connection.getResponseCode() != 200) throw new IOException("开发服务器未返回可缓存的源码");
            return read(connection.getInputStream(), limit);
        } finally { connection.disconnect(); }
    }
    private static byte[] read(InputStream source, int limit) throws IOException {
        try (InputStream input = source; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192]; int count;
            while ((count = input.read(buffer)) != -1) {
                if (output.size() + count > limit) throw new IOException("缓存资源大小不匹配");
                output.write(buffer, 0, count);
            }
            return output.toByteArray();
        }
    }
    private static void checkCancelled(long deadline) throws IOException {
        if (Thread.currentThread().isInterrupted()) throw new IOException("缓存已取消");
        if (System.nanoTime() > deadline) throw new IOException("缓存超时，请重试");
    }
    static boolean validPath(String path) {
        if (!path.matches("[A-Za-z0-9_./-]+") || path.startsWith("/")
            || Arrays.asList(path.split("/")).contains("..")) return false;
        return Arrays.asList("index.html", "player.html", "favicon.ico", "manifest.webmanifest").contains(path)
            || path.matches("(?:js|css|icons|assets)/.+");
    }
    private static boolean sameOrigin(URI a, URI b) {
        return Objects.equals(a.getScheme(), b.getScheme()) && Objects.equals(a.getHost(), b.getHost())
            && a.getPort() == b.getPort() && b.getUserInfo() == null;
    }
    private static String key(URI uri) throws URISyntaxException {
        String path = uri.getPath();
        if (path == null || path.isEmpty()) path = "/";
        if (path.endsWith("/")) path += "index.html";
        return new URI(uri.getScheme(), null, uri.getHost(), uri.getPort(), path, null, null).toString();
    }
    static String hash(byte[] bytes) throws Exception {
        return encode(MessageDigest.getInstance("SHA-256").digest(bytes));
    }
    // java.util.Base64 requires API 26; this on-disk encoding also works on Android 7.
    private static String encode(byte[] bytes) {
        char[] digits = "0123456789abcdef".toCharArray(), result = new char[bytes.length * 2];
        for (int i = 0; i < bytes.length; i++) { result[i * 2] = digits[(bytes[i] & 255) >>> 4]; result[i * 2 + 1] = digits[bytes[i] & 15]; }
        return new String(result);
    }
    private static byte[] decode(String value) throws IOException {
        if (value.length() % 2 != 0) throw new IOException("缓存文件损坏");
        byte[] bytes = new byte[value.length() / 2];
        for (int i = 0; i < bytes.length; i++) {
            int high = Character.digit(value.charAt(i * 2), 16), low = Character.digit(value.charAt(i * 2 + 1), 16);
            if (high < 0 || low < 0) throw new IOException("缓存文件损坏");
            bytes[i] = (byte) (high * 16 + low);
        }
        return bytes;
    }
    private static String mime(String path) {
        if (path.endsWith(".js") || path.endsWith(".mjs")) return "text/javascript";
        if (path.endsWith(".html")) return "text/html";
        if (path.endsWith(".css")) return "text/css";
        if (path.endsWith(".json") || path.endsWith(".webmanifest")) return "application/json";
        if (path.endsWith(".svg")) return "image/svg+xml";
        if (path.endsWith(".png")) return "image/png";
        if (path.endsWith(".ico")) return "image/x-icon";
        if (path.endsWith(".wav")) return "audio/wav";
        return "application/octet-stream";
    }
}
