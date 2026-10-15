import Foundation
import CryptoKit

/// Explicit source snapshots, separate from both WebKit's HTTP cache and release updates.
final class DevelopmentCache {
    static let limit = 32 * 1024 * 1024
    struct Entry: Codable {
        let data: Data
        let mime: String
    }
    struct Snapshot: Codable {
        let target: String
        let entries: [String: Entry]
    }
    private struct Manifest: Decodable {
        struct File: Decodable { let path: String; let size: Int; let sha256: String }
        let schema: Int
        let files: [File]
    }
    let target: URL
    let base: URL
    private let file: URL
    private let cacheHost: String
    private(set) var snapshot: Snapshot?
    var available: Bool { snapshot != nil }

    init(target: URL, directory: URL? = nil) {
        self.target = target
        base = URL(string: ".", relativeTo: target)!.absoluteURL
        cacheHost = Self.hash(Data(target.absoluteString.utf8))
        let folder = directory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("development-cache", isDirectory: true)
        file = folder.appendingPathComponent(cacheHost + ".json")
        if let bytes = try? Data(contentsOf: file), bytes.count <= Self.limit * 2,
           let stored = try? JSONDecoder().decode(Snapshot.self, from: bytes),
           stored.target == target.absoluteString, stored.entries[Self.key(target)] != nil {
            snapshot = stored
        }
    }
    static func hash(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    static func validPath(_ path: String) -> Bool {
        guard path.range(of: #"^[A-Za-z0-9_./-]+$"#, options: .regularExpression) != nil,
              !path.hasPrefix("/"), !path.split(separator: "/").contains("..") else { return false }
        return ["index.html", "player.html", "favicon.ico", "manifest.webmanifest"].contains(path)
            || ["js/", "css/", "icons/", "assets/"].contains(where: { path.hasPrefix($0) })
    }
    private static func key(_ url: URL) -> String {
        var parts = URLComponents(url: url, resolvingAgainstBaseURL: true)!
        parts.query = nil; parts.fragment = nil
        if parts.path.isEmpty { parts.path = "/" }
        if parts.path.hasSuffix("/") { parts.path += "index.html" }
        return parts.url!.absoluteString
    }
    private func sameOrigin(_ url: URL) -> Bool {
        url.scheme == base.scheme && url.host == base.host && url.port == base.port && url.user == nil && url.password == nil
    }
    func remoteURL(_ url: URL) -> URL? {
        if sameOrigin(url) { return url }
        guard url.scheme == "lingua-dev", url.host == cacheHost else { return nil }
        var parts = URLComponents(url: url, resolvingAgainstBaseURL: true)!
        parts.scheme = base.scheme; parts.host = base.host; parts.port = base.port
        return parts.url
    }
    func localURL(_ url: URL) -> URL? {
        guard let remote = remoteURL(url), snapshot?.entries[Self.key(remote)] != nil else { return nil }
        var parts = URLComponents(url: remote, resolvingAgainstBaseURL: true)!
        parts.scheme = "lingua-dev"; parts.host = cacheHost; parts.port = nil
        return parts.url
    }
    func entry(_ url: URL) -> Entry? {
        guard let remote = remoteURL(url) else { return nil }
        return snapshot?.entries[Self.key(remote)]
    }

    /// Returns a cached HTML document while keeping its navigation URL on the
    /// original development origin. Relative document resources are redirected
    /// to the private scheme handler; the document's localStorage/IndexedDB
    /// therefore continue to use the development site's existing origin.
    func document(_ url: URL) -> Data? {
        guard let entry = entry(url), entry.mime == "text/html",
              let source = String(data: entry.data, encoding: .utf8) else { return nil }
        let pattern = #"(?i)(\b(?:src|href|poster)\s*=\s*[\"'])([^\"']+)([\"'])"#
        guard let expression = try? NSRegularExpression(pattern: pattern) else { return entry.data }
        let range = NSRange(source.startIndex..<source.endIndex, in: source)
        var output = source
        for match in expression.matches(in: source, range: range).reversed() {
            guard let valueRange = Range(match.range(at: 2), in: source) else { continue }
            let value = String(source[valueRange])
            guard !value.hasPrefix("#"), !value.hasPrefix("data:"), !value.hasPrefix("blob:") else { continue }
            guard let resolved = URL(string: value, relativeTo: url)?.absoluteURL,
                  sameOrigin(resolved), let local = localURL(resolved),
                  let fullRange = Range(match.range(at: 2), in: source) else { continue }
            let start = source.distance(from: source.startIndex, to: fullRange.lowerBound)
            let end = source.distance(from: source.startIndex, to: fullRange.upperBound)
            let outputStart = output.index(output.startIndex, offsetBy: start)
            let outputEnd = output.index(output.startIndex, offsetBy: end)
            output.replaceSubrange(outputStart..<outputEnd, with: local.absoluteString)
        }
        // Inline module imports and dynamic imports do not pass through the
        // fetch/XHR wrappers. Rewrite their quoted static paths as well.
        let pathPattern = #"([\"'`])((?:\./)?(?:js|css|icons|assets)/[^\"'`]+)([\"'`])"#
        if let pathExpression = try? NSRegularExpression(pattern: pathPattern) {
            let original = output
            let outputRange = NSRange(original.startIndex..<original.endIndex, in: original)
            for match in pathExpression.matches(in: original, range: outputRange).reversed() {
                guard let pathRange = Range(match.range(at: 2), in: original),
                      let resolved = URL(string: String(original[pathRange]), relativeTo: url)?.absoluteURL,
                      sameOrigin(resolved), let local = localURL(resolved),
                      let replacementRange = Range(match.range(at: 2), in: original) else { continue }
                let start = original.distance(from: original.startIndex, to: replacementRange.lowerBound)
                let end = original.distance(from: original.startIndex, to: replacementRange.upperBound)
                let outputStart = output.index(output.startIndex, offsetBy: start)
                let outputEnd = output.index(output.startIndex, offsetBy: end)
                output.replaceSubrange(outputStart..<outputEnd, with: local.absoluteString)
            }
        }
        return output.data(using: .utf8)
    }

    func download(configuration: URLSessionConfiguration = .ephemeral) async throws -> Snapshot {
        configuration.urlCache = nil; configuration.httpCookieStorage = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 15; configuration.timeoutIntervalForResource = 120
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let deadline = Date().addingTimeInterval(120)
        func fetch(_ url: URL, limit: Int) async throws -> Data {
            try Task.checkCancellation()
            guard Date() < deadline, sameOrigin(url) else { throw failure("缓存超时或资源地址无效") }
            var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData)
            request.setValue("no-cache, no-store", forHTTPHeaderField: "Cache-Control")
            let (bytes, response) = try await session.data(for: request)
            guard let response = response as? HTTPURLResponse, response.statusCode == 200,
                  response.url == url, bytes.count <= limit else { throw failure("开发服务器未返回可缓存的源码") }
            return bytes
        }
        let manifestData = try await fetch(base.appendingPathComponent("development-cache.json"), limit: 1024 * 1024)
        let manifest = try JSONDecoder().decode(Manifest.self, from: manifestData)
        guard manifest.schema == 1, !manifest.files.isEmpty, manifest.files.count <= 2048 else { throw failure("缓存清单无效") }
        var entries: [String: Entry] = [:]
        var total = 0
        var home = false, player = false
        for item in manifest.files {
            guard Self.validPath(item.path), item.size >= 0, item.size <= Self.limit - total else { throw failure("缓存资源无效或超过 32 MiB") }
            total += item.size
            let resource = URL(string: item.path, relativeTo: base)!.absoluteURL
            guard entries[Self.key(resource)] == nil else { throw failure("缓存资源重复") }
            var request = Self.key(resource) == Self.key(target) ? target : resource
            var parts = URLComponents(url: request, resolvingAgainstBaseURL: true)!
            parts.fragment = nil; request = parts.url!
            let bytes = try await fetch(request, limit: item.size + 1)
            guard bytes.count == item.size, Self.hash(bytes) == item.sha256 else { throw failure("源码已变化，请重试缓存") }
            entries[Self.key(resource)] = Entry(data: bytes, mime: Self.mime(item.path))
            home = home || item.path == "index.html"; player = player || item.path == "player.html"
        }
        guard home, player, entries[Self.key(target)] != nil else { throw failure("缓存缺少前端入口") }
        try Task.checkCancellation()
        guard Date() < deadline else { throw failure("缓存超时，请重试") }
        let result = Snapshot(target: target.absoluteString, entries: entries)
        let bytes = try JSONEncoder().encode(result)
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try bytes.write(to: file, options: .atomic)
        return result
    }
    // Publish on the UI thread only after the complete snapshot has been committed.
    func activate(_ saved: Snapshot) { snapshot = saved }
    private func failure(_ message: String) -> NSError { NSError(domain: "DevelopmentCache", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
    private static func mime(_ path: String) -> String {
        switch (path as NSString).pathExtension {
        case "js", "mjs": return "text/javascript"
        case "html": return "text/html"
        case "css": return "text/css"
        case "json", "webmanifest": return "application/json"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        case "ico": return "image/x-icon"
        case "wav": return "audio/wav"
        default: return "application/octet-stream"
        }
    }
}
