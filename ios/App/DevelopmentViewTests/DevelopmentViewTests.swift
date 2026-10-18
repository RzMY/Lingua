import XCTest
import UIKit
import WebKit
@testable import App

final class DevelopmentViewTests: XCTestCase {
    @MainActor
    private func window() throws -> UIWindow {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        return try XCTUnwrap(scenes.flatMap { $0.windows }.first { $0.isKeyWindow })
    }

    private func snapshot(_ target: URL) throws -> URL {
        let base = URL(string: ".", relativeTo: target)!.absoluteURL
        let files = [
            "index.html": DevelopmentCache.Entry(data: Data("""
                <!doctype html><html><head><script src="js/ready.js"></script></head>
                <body>Cached home<a href="player.html?track=123">Play</a></body></html>
                """.utf8), mime: "text/html"),
            "player.html": DevelopmentCache.Entry(data: Data("""
                <!doctype html><html><head><script src="js/ready.js"></script></head>
                <body>Cached player</body></html>
                """.utf8), mime: "text/html"),
            "js/ready.js": DevelopmentCache.Entry(data: Data("""
                window.snapshotReady = true;
                window.snapshotLoads = Number(localStorage.getItem('snapshotLoads') || 0) + 1;
                localStorage.setItem('snapshotLoads', String(window.snapshotLoads));
                """.utf8), mime: "text/javascript"),
            "assets/test.txt": DevelopmentCache.Entry(data: Data("snapshot-resource".utf8), mime: "text/plain")
        ]
        let entries = Dictionary(uniqueKeysWithValues: files.map { path, entry in
            (URL(string: path, relativeTo: base)!.absoluteURL.absoluteString, entry)
        })
        let saved = DevelopmentCache.Snapshot(target: target.absoluteString, entries: entries)
        let folder = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("development-cache", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let file = folder.appendingPathComponent(DevelopmentCache.hash(Data(target.absoluteString.utf8)) + ".json")
        try JSONEncoder().encode(saved).write(to: file, options: .atomic)
        return file
    }

    @MainActor
    private func web(_ controller: DevelopmentViewController) throws -> WKWebView {
        controller.loadViewIfNeeded()
        return try XCTUnwrap(controller.view.subviews.compactMap { $0 as? WKWebView }.first)
    }

    @MainActor
    private func waitForSnapshot(_ web: WKWebView, path: String) async throws {
        for _ in 0..<100 {
            if let ready = try? await web.evaluateJavaScript("window.snapshotReady === true && location.pathname === '\(path)'"),
               ready as? Bool == true { return }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        XCTFail("Snapshot failed to load; simulated navigation may have been recursively intercepted")
    }

    @MainActor
    func testPersistedSnapshotReopensAndNavigatesOnItsOriginalOrigin() async throws {
        let target = URL(string: "http://\(UUID().uuidString.lowercased()).invalid:5173/lingua/index.html?debug=1")!
        let file = try snapshot(target)
        let window = try self.window()
        let original = window.rootViewController
        defer { window.rootViewController = original; try? FileManager.default.removeItem(at: file) }
        // First entry and the same persisted cache on the next controller start.
        for round in 0..<2 {
            let controller = DevelopmentViewController(url: target)
            window.rootViewController = controller
            let web = try self.web(controller)
            try await waitForSnapshot(web, path: "/lingua/index.html")
            XCTAssertEqual(web.url, target)
            let homeLoads = try await web.evaluateJavaScript("window.snapshotLoads") as? Int
            let retained = try await web.evaluateJavaScript("localStorage.getItem('retained')") as? String
            XCTAssertEqual(homeLoads, round * 2 + 1)
            XCTAssertEqual(retained, round == 0 ? nil : "user-data")
            _ = try await web.evaluateJavaScript("localStorage.setItem('retained', 'user-data');document.querySelector('a').click();true")
            try await waitForSnapshot(web, path: "/lingua/player.html")
            XCTAssertEqual(web.url?.scheme, target.scheme)
            XCTAssertEqual(web.url?.host, target.host)
            let playerLoads = try await web.evaluateJavaScript("window.snapshotLoads") as? Int
            XCTAssertEqual(playerLoads, round * 2 + 2)
            var fetched = false
            _ = try await web.evaluateJavaScript("window.resourceText='';fetch('./assets/test.txt').then(r=>r.text()).then(t=>window.resourceText=t);true")
            for _ in 0..<100 {
                if try await web.evaluateJavaScript("window.resourceText") as? String == "snapshot-resource" {
                    fetched = true; break
                }
                try await Task.sleep(nanoseconds: 50_000_000)
            }
            XCTAssertTrue(fetched, "Snapshot fetch must use the custom scheme under a subdirectory")
            window.rootViewController = original
        }
    }

    @MainActor
    func testReturnRestoresEachLocalBranchAndRetainsUpdateState() async throws {
        let defaults = UserDefaults.standard
        let keys = ["lingua.channel", "lingua.previous-channel", "lingua.own-url", "lingua.native.state"]
            .map { "CapacitorStorage." + $0 }
        let saved = keys.map { defaults.object(forKey: $0) }
        let window = try self.window()
        let original = window.rootViewController
        defer {
            window.rootViewController = original
            for (key, value) in zip(keys, saved) {
                if let value = value { defaults.set(value, forKey: key) }
                else { defaults.removeObject(forKey: key) }
            }
        }
        for previous in ["stable", "own", "preview", "invalid"] {
            defaults.set("development", forKey: keys[0])
            defaults.set(previous, forKey: keys[1])
            defaults.set("https://site.example/", forKey: keys[2])
            let state = "{\"pending\":{\"id\":\"retained-bundle\"}}"
            defaults.set(state, forKey: keys[3])
            let controller = DevelopmentViewController(url: nil)
            window.rootViewController = controller
            controller.loadViewIfNeeded()
            let menu = try XCTUnwrap(controller.view.subviews.compactMap { $0 as? UIStackView }.first)
            let button = try XCTUnwrap(menu.arrangedSubviews.compactMap { $0 as? UIButton }
                .first { $0.title(for: .normal) == "返回上一个分支" })
            button.sendActions(for: .touchUpInside)
            XCTAssertTrue(window.rootViewController is LinguaViewController)
            XCTAssertEqual(defaults.string(forKey: keys[0]), previous == "invalid" ? "stable" : previous)
            XCTAssertEqual(defaults.string(forKey: keys[3]), state)
            XCTAssertEqual(defaults.string(forKey: keys[2]), "https://site.example/")
        }
    }
}
