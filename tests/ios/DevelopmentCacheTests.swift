import Foundation

private final class SourceProtocol: URLProtocol {
    static var files: [String: Data] = [:]
    static var manifest = Data()
    static var unavailable = false
    static var requests: [URL] = []
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard let url = request.url else { return }
        Self.requests.append(url)
        guard !Self.unavailable else {
            client?.urlProtocol(self, didFailWithError: NSError(domain: NSURLErrorDomain, code: NSURLErrorCannotConnectToHost)); return
        }
        let data = url.path.hasSuffix("development-cache.json") ? Self.manifest : Self.files[url.path]
        let response = HTTPURLResponse(url: url, statusCode: data == nil ? 404 : 200, httpVersion: "HTTP/1.1", headerFields: [:])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data ?? Data())
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() { }
    static func version(_ value: String) throws {
        files = ["/lingua/index.html": Data("<script src=\"js/lazy.js\"></script><link href=\"css/base.css\"><a href=\"player.html?track=123\">Play</a>".utf8), "/lingua/player.html": Data("player".utf8),
                 "/lingua/js/lazy.js": Data("export const version = '\(value)'".utf8),
                 "/lingua/css/base.css": Data("body{background:url(icons/a.svg)}".utf8),
                 "/lingua/icons/a.svg": Data("<svg/ >".utf8),
                 "/lingua/assets/test.wav": Data([0, 1, 255, 128, 127])]
        let list = files.map { path, data in
            ["path": String(path.dropFirst("/lingua/".count)), "size": data.count, "sha256": DevelopmentCache.hash(data)] as [String: Any]
        }
        manifest = try JSONSerialization.data(withJSONObject: ["schema": 1, "files": list])
    }
}

@main struct DevelopmentCacheTests {
    static func main() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: folder) }
        let url = URL(string: "http://dev.example:5173/lingua/index.html?debug=1#settings")!
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [SourceProtocol.self]
        try SourceProtocol.version("first")
        let cache = DevelopmentCache(target: url, directory: folder)
        precondition(!cache.available && SourceProtocol.requests.isEmpty)
        precondition(cache.resourceScript(enabled: true).isEmpty)
        let saved = try await cache.download(configuration: config)
        cache.activate(saved)
        precondition(SourceProtocol.requests.contains { $0.query == "debug=1" })
        let local = cache.localURL(url)!
        precondition(local.scheme == "lingua-dev" && local.query == url.query && local.fragment == url.fragment)
        precondition(cache.remoteURL(local) == url)
        let document = String(data: cache.document(url)!, encoding: .utf8)!
        precondition(document.contains("lingua-dev://") && document.contains("js/lazy.js"))
        precondition(document.contains("href=\"player.html?track=123\""))
        precondition(cache.resourceScript(enabled: false).isEmpty)
        let script = cache.resourceScript(enabled: true)
        let stateJSON = script.components(separatedBy: "const settings = ")[1].components(separatedBy: ";")[0]
        let settings = try JSONSerialization.jsonObject(with: Data(stateJSON.utf8)) as! [String: Any]
        precondition(settings["origin"] as? String == "http://dev.example:5173")
        precondition(settings["host"] as? String == local.host)
        precondition(Set(settings["paths"] as! [String]) == Set(["/lingua/js/lazy.js", "/lingua/css/base.css", "/lingua/icons/a.svg", "/lingua/assets/test.wav"]))
        let count = SourceProtocol.requests.count
        try SourceProtocol.version("latest")
        precondition(String(data: cache.document(url)!, encoding: .utf8)!.contains("lingua-dev://"))
        precondition(SourceProtocol.requests.count == count)
        let reopened = DevelopmentCache(target: url, directory: folder)
        precondition(String(data: reopened.document(url)!, encoding: .utf8)!.contains("lingua-dev://"))
        precondition(reopened.resourceScript(enabled: true) == script)
        let player = URL(string: "player.html?track=123", relativeTo: local)!.absoluteURL
        precondition(reopened.entry(player)?.data == Data("player".utf8))
        let lazy = URL(string: "js/lazy.js?v=2", relativeTo: local)!.absoluteURL
        precondition(String(data: reopened.entry(lazy)!.data, encoding: .utf8)!.contains("first"))
        let binary = URL(string: "assets/test.wav", relativeTo: local)!.absoluteURL
        precondition(reopened.entry(binary)?.data == Data([0, 1, 255, 128, 127]))
        precondition(reopened.entry(URL(string: "https://other.example/lingua/index.html")!) == nil)
        precondition(reopened.entry(URL(string: "api/health", relativeTo: local)!.absoluteURL) == nil)
        let other = DevelopmentCache(target: URL(string: url.absoluteString.replacingOccurrences(of: "debug=1", with: "debug=2"))!, directory: folder)
        precondition(!other.available && other.remoteURL(local) == nil)
        let latest = try await cache.download(configuration: config)
        cache.activate(latest)
        precondition(String(data: cache.entry(URL(string: "js/lazy.js", relativeTo: local)!.absoluteURL)!.data, encoding: .utf8)!.contains("latest"))
        try SourceProtocol.version("third")
        SourceProtocol.files["/lingua/js/lazy.js"] = Data("changed".utf8)
        do { _ = try await cache.download(configuration: config); fatalError("Expected checksum rejection") } catch { }
        SourceProtocol.unavailable = true
        do { _ = try await cache.download(configuration: config); fatalError("Expected offline rejection") } catch { }
        let retained = DevelopmentCache(target: url, directory: folder)
        precondition(String(data: retained.entry(URL(string: "js/lazy.js", relativeTo: local)!.absoluteURL)!.data, encoding: .utf8)!.contains("latest"))
        for path in ["../.env", "js/../../.env", "data/private.json", "/index.html", "https://evil.example/x"] {
            precondition(!DevelopmentCache.validPath(path))
        }
        print("Development cache: explicit downloads, source isolation, offline navigation and atomic replacement passed")
    }
}
