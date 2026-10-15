import UIKit
import Capacitor
import AVFoundation
import WebKit

// Playback includes AirPlay implicitly. Explicit .allowAirPlay is only valid
// with .playAndRecord and can make setCategory fail before playback starts.
enum PlaybackSession {
    static func configure() throws {
        let audio = AVAudioSession.sharedInstance()
        if audio.category != .playback || audio.mode != .default {
            try audio.setCategory(.playback, mode: .default, options: [])
        }
    }
    static func activate() throws {
        try configure()
        try AVAudioSession.sharedInstance().setActive(true)
    }
}

// Kept in this existing Xcode source so native registration survives `cap sync`.
@objc(LinguaViewController)
class LinguaViewController: CAPBridgeViewController {
    override func webViewConfiguration(for configuration: InstanceConfiguration) -> WKWebViewConfiguration {
        let config = super.webViewConfiguration(for: configuration)
        config.allowsInlineMediaPlayback = true
        config.allowsPictureInPictureMediaPlayback = true
        config.allowsAirPlayForMediaPlayback = true
        // The local player already owns its full-screen canvas and subtitle overlays.
        // WebKit's element fullscreen presents another controller and can restore stale insets.
        config.preferences.isElementFullscreenEnabled = false
        return config
    }

    private func restoreEdgeToEdge() {
        guard let scroll = webView?.scrollView else { return }
        scroll.contentInsetAdjustmentBehavior = .never
        if scroll.contentInset != .zero { scroll.contentInset = .zero }
        if scroll.verticalScrollIndicatorInsets != .zero { scroll.verticalScrollIndicatorInsets = .zero }
        if scroll.horizontalScrollIndicatorInsets != .zero { scroll.horizontalScrollIndicatorInsets = .zero }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        restoreEdgeToEdge()
    }

    override func viewSafeAreaInsetsDidChange() {
        super.viewSafeAreaInsetsDidChange()
        restoreEdgeToEdge()
    }

    // Capacitor's SystemBars plugin owns Home indicator visibility.
    func setPresentation(immersive: Bool, dark: Bool) {
        isStatusBarVisible = !immersive
        statusBarStyle = dark ? .lightContent : .darkContent
        let color: UIColor = immersive ? .black : (dark
            ? UIColor(red: 21/255, green: 23/255, blue: 15/255, alpha: 1)
            : UIColor(red: 242/255, green: 242/255, blue: 234/255, alpha: 1))
        webView?.backgroundColor = color
        webView?.scrollView.backgroundColor = color
        setNeedsStatusBarAppearanceUpdate()
        restoreEdgeToEdge()
    }

    override func capacitorDidLoad() {
        // WebKit activates/deactivates the session with media playback. Do not grab audio focus on launch.
        do { try PlaybackSession.configure() }
        catch { NSLog("Lingua audio session: %@", error.localizedDescription) }
        webView?.allowsBackForwardNavigationGestures = true
        webView?.scrollView.bounces = false
        edgesForExtendedLayout = .all
        extendedLayoutIncludesOpaqueBars = true
        restoreEdgeToEdge()
        webView?.isOpaque = false
        webView?.backgroundColor = UIColor(red: 242/255, green: 242/255, blue: 234/255, alpha: 1)
        webView?.scrollView.backgroundColor = webView?.backgroundColor
        bridge?.registerPluginInstance(NativeShellPlugin())
        bridge?.registerPluginInstance(CaptionPipPlugin())
        bridge?.registerPluginInstance(AudioPlayerPlugin())
        bridge?.registerPluginInstance(SpeechAudioPlugin())
    }
}

@objc(NativeShellPlugin)
class NativeShellPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "NativeShellPlugin"
    let jsName = "NativeShell"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "openDevelopment", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setPresentation", returnType: CAPPluginReturnPromise)
    ]
    @objc func setPresentation(_ call: CAPPluginCall) {
        let immersive = call.getBool("immersive") ?? false
        let dark = call.getBool("dark") ?? false
        DispatchQueue.main.async {
            guard let controller = self.bridge?.viewController as? LinguaViewController else {
                call.reject("窗口尚未就绪"); return
            }
            controller.setPresentation(immersive: immersive, dark: dark)
            call.resolve()
        }
    }
    @objc func openDevelopment(_ call: CAPPluginCall) {
        guard let raw = call.getString("url"), let url = DevelopmentViewController.validURL(raw) else {
            call.reject("请输入 HTTP 或 HTTPS 调试地址"); return
        }
        DispatchQueue.main.async {
            guard let window = self.bridge?.viewController?.view.window else { call.reject("窗口尚未就绪"); return }
            call.resolve()
            window.rootViewController = DevelopmentViewController(url: url)
        }
    }
}

// Remote debugging stays separate from the privileged local Capacitor bridge.
private class DevelopmentPresentationHandler: NSObject, WKScriptMessageHandler {
    weak var owner: DevelopmentViewController?
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, let state = message.body as? [String: Bool] else { return }
        owner?.setPresentation(dark: state["dark"] ?? false, immersive: state["immersive"] ?? false)
    }
}

private class DevelopmentSchemeHandler: NSObject, WKURLSchemeHandler {
    let cache: DevelopmentCache
    init(cache: DevelopmentCache) { self.cache = cache }
    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url, urlSchemeTask.request.httpMethod == "GET",
              let entry = cache.entry(url) else {
            urlSchemeTask.didFailWithError(NSError(domain: NSURLErrorDomain, code: NSURLErrorFileDoesNotExist)); return
        }
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: [
            "Content-Type": entry.mime, "Content-Length": String(entry.data.count), "Cache-Control": "no-store",
            "Access-Control-Allow-Origin": "*"
        ])!
        urlSchemeTask.didReceive(response); urlSchemeTask.didReceive(entry.data); urlSchemeTask.didFinish()
    }
    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) { }
}

class DevelopmentViewController: UIViewController, WKNavigationDelegate, WKUIDelegate {
    let url: URL?
    private var web: WKWebView!
    private let bubble = UIButton(type: .system)
    private let menu = UIStackView()
    private let errorLabel = UILabel()
    private var dark = false, immersive = false, placed = false
    private var insetKey = ""
    private var presentationHandler: DevelopmentPresentationHandler!
    private var cache: DevelopmentCache?
    private let cacheButton = UIButton(type: .system)
    private var cacheTask: Task<Void, Never>?
    private var cached = false, cacheNotice = false
    private var liveTarget: URL?
    private var pendingNotice: String?
    private var reloadGeneration = 0
    override var preferredStatusBarStyle: UIStatusBarStyle { dark || immersive ? .lightContent : .darkContent }
    override var prefersStatusBarHidden: Bool { immersive }
    override var prefersHomeIndicatorAutoHidden: Bool { immersive }

    static func validURL(_ raw: String) -> URL? {
        guard let url = URL(string: raw), ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
              url.host != nil, url.user == nil, url.password == nil else { return nil }
        return url
    }
    init(url: URL?) { self.url = url; super.init(nibName: nil, bundle: nil) }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override func viewDidLoad() {
        super.viewDidLoad()
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.allowsPictureInPictureMediaPlayback = true
        config.allowsAirPlayForMediaPlayback = true
        config.websiteDataStore = .default()
        config.preferences.isElementFullscreenEnabled = false
        if let url = url {
            cache = DevelopmentCache(target: url)
            config.setURLSchemeHandler(DevelopmentSchemeHandler(cache: cache!), forURLScheme: "lingua-dev")
        }
        presentationHandler = DevelopmentPresentationHandler(); presentationHandler.owner = self
        config.userContentController.add(presentationHandler, name: "linguaPresentation")
        web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.scrollView.bounces = false
        web.isOpaque = false
        web.allowsBackForwardNavigationGestures = true
        web.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(web)
        NSLayoutConstraint.activate([
            web.topAnchor.constraint(equalTo: view.topAnchor), web.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            web.leadingAnchor.constraint(equalTo: view.leadingAnchor), web.trailingAnchor.constraint(equalTo: view.trailingAnchor)
        ])
        menu.axis = .vertical; menu.spacing = 0
        menu.isLayoutMarginsRelativeArrangement = true
        menu.layoutMargins = UIEdgeInsets(top: 8, left: 12, bottom: 8, right: 12)
        menu.layer.cornerRadius = 20; menu.layer.shadowOpacity = 0.16; menu.layer.shadowRadius = 18
        menu.layer.shadowOffset = CGSize(width: 0, height: 6); menu.isHidden = true
        errorLabel.font = .systemFont(ofSize: 14); errorLabel.numberOfLines = 0; errorLabel.isHidden = true
        menu.addArrangedSubview(errorLabel)
        for (title, action) in [("刷新网页", #selector(reloadPage)), ("缓存前端源码", #selector(cachePage)), ("返回上一个分支", #selector(returnToApp))] {
            let button = title == "缓存前端源码" ? cacheButton : UIButton(type: .system)
            button.setTitle(title, for: .normal); button.titleLabel?.font = .systemFont(ofSize: 15, weight: .medium)
            button.contentHorizontalAlignment = .leading
            button.heightAnchor.constraint(greaterThanOrEqualToConstant: 48).isActive = true
            button.addTarget(self, action: action, for: .touchUpInside); menu.addArrangedSubview(button)
        }
        view.addSubview(menu)
        bubble.setImage(UIImage(systemName: "chevron.left.forwardslash.chevron.right"), for: .normal)
        bubble.accessibilityLabel = "开发控制"
        bubble.layer.cornerRadius = 26; bubble.layer.shadowOpacity = 0.15; bubble.layer.shadowRadius = 10
        bubble.layer.shadowOffset = CGSize(width: 0, height: 4)
        bubble.addTarget(self, action: #selector(toggleMenu), for: .touchUpInside)
        bubble.addGestureRecognizer(UIPanGestureRecognizer(target: self, action: #selector(moveBubble(_:))))
        view.addSubview(bubble)
        setPresentation(dark: false, immersive: false)
        updateInsets()
        if let url = url, cache?.available == true, loadCachedDocument(url) {
            cached = true; liveTarget = url
        } else { reloadPage() }
    }
    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        web.scrollView.contentInset = .zero
        web.scrollView.verticalScrollIndicatorInsets = .zero
        web.scrollView.horizontalScrollIndicatorInsets = .zero
        updateInsets(); placeControls()
    }
    override func viewSafeAreaInsetsDidChange() {
        super.viewSafeAreaInsetsDidChange()
        guard web != nil else { return }
        updateInsets(); placeControls()
    }
    fileprivate func setPresentation(dark: Bool, immersive: Bool) {
        let changed = self.dark != dark || self.immersive != immersive
        self.dark = dark; self.immersive = immersive
        let background = UIColor(white: 0, alpha: 1)
        let pageColor = dark ? color(0x15170f) : color(0xf2f2ea)
        view.backgroundColor = immersive ? background : pageColor
        web.backgroundColor = view.backgroundColor; web.scrollView.backgroundColor = view.backgroundColor
        menu.backgroundColor = dark ? color(0x262b1b) : color(0xf7f7f1)
        menu.tintColor = dark ? color(0xeef1e3) : color(0x1b1f16); errorLabel.textColor = menu.tintColor
        bubble.backgroundColor = dark ? color(0x33421f) : color(0xd7e6c4)
        bubble.tintColor = dark ? color(0xa8d68a) : color(0x4f7a37)
        if changed { setNeedsStatusBarAppearanceUpdate(); setNeedsUpdateOfHomeIndicatorAutoHidden() }
        updateInsets()
    }
    private func color(_ hex: UInt32) -> UIColor {
        UIColor(red: CGFloat((hex >> 16) & 255) / 255, green: CGFloat((hex >> 8) & 255) / 255,
                blue: CGFloat(hex & 255) / 255, alpha: 1)
    }
    private func updateInsets() {
        let safe = view.safeAreaInsets
        let values = "[\(safe.top),\(safe.right),\(safe.bottom),\(safe.left)]"
        // Refresh the document-start script too, so subsequent pages get insets before first paint.
        if values != insetKey {
            insetKey = values
            web.configuration.userContentController.removeAllUserScripts()
            web.configuration.userContentController.addUserScript(WKUserScript(
                source: "window.__linguaInsets=" + values + ";" + cacheTargetScript + Self.presentationScript,
                injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        web.evaluateJavaScript("window.__linguaInsets=" + values + ";window.__linguaApplyInsets?.();", completionHandler: nil)
    }
    private func clamp(_ value: CGFloat, _ minValue: CGFloat, _ maxValue: CGFloat) -> CGFloat {
        max(minValue, min(value, max(minValue, maxValue)))
    }
    private func placeControls() {
        let bounds = view.bounds.inset(by: view.safeAreaInsets).insetBy(dx: 12, dy: 12)
        if !placed {
            bubble.frame = CGRect(x: bounds.maxX - 52, y: bounds.minY + bounds.height * 0.65, width: 52, height: 52)
            placed = true
        }
        bubble.frame.origin.x = clamp(bubble.frame.minX, bounds.minX, bounds.maxX - 52)
        bubble.frame.origin.y = clamp(bubble.frame.minY, bounds.minY, bounds.maxY - 52)
        let width = min(208, bounds.width)
        let size = menu.systemLayoutSizeFitting(CGSize(width: width, height: 0),
            withHorizontalFittingPriority: .required, verticalFittingPriority: .fittingSizeLevel)
        let above = bubble.frame.minY - size.height - 10
        menu.frame = CGRect(x: clamp(bubble.frame.maxX - width, bounds.minX, bounds.maxX - width),
            y: clamp(above >= bounds.minY ? above : bubble.frame.maxY + 10, bounds.minY, bounds.maxY - size.height),
            width: width, height: size.height)
    }
    @objc private func toggleMenu() { menu.isHidden.toggle(); placeControls() }
    @objc private func moveBubble(_ gesture: UIPanGestureRecognizer) {
        menu.isHidden = true
        let delta = gesture.translation(in: view)
        bubble.center = CGPoint(x: bubble.center.x + delta.x, y: bubble.center.y + delta.y)
        gesture.setTranslation(.zero, in: view); placeControls()
    }
    private func showError(_ message: String) {
        errorLabel.text = message; errorLabel.isHidden = false; menu.isHidden = false; placeControls()
    }
    @objc private func reloadPage() {
        reloadGeneration += 1
        menu.isHidden = true; errorLabel.isHidden = true
        guard let target = web.url.flatMap({ cache?.remoteURL($0) ?? Self.validURL($0.absoluteString) }) ?? liveTarget ?? url else { showError("开发地址无效"); return }
        cached = false; cacheNotice = false; pendingNotice = nil; liveTarget = target
        if web.url == target { web.reloadFromOrigin() }
        else { web.load(URLRequest(url: target, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 30)) }
    }
    private var cacheTargetScript: String {
        guard let cache = cache else { return "" }
        // The analysis service remains the remote site's root; snapshots contain frontend files only.
        var parts = URLComponents(url: cache.base, resolvingAgainstBaseURL: true)!
        parts.path = ""; parts.query = nil; parts.fragment = nil
        let origin = parts.url!.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard let bytes = try? JSONSerialization.data(withJSONObject: [origin]),
              let value = String(data: bytes, encoding: .utf8),
              let cachedHost = cache.localURL(cache.target)?.host,
              let hostData = try? JSONSerialization.data(withJSONObject: cachedHost),
              let host = String(data: hostData, encoding: .utf8) else { return "" }
        return """
        (() => {
          window.__linguaDevelopmentTarget=(value)[0];
          window.__linguaCachedHost=(host);
          const map = (raw) => {
            try {
              const value = new URL(String(raw), location.href);
              if (value.origin !== location.origin || !(value.pathname.startsWith('/js/') || value.pathname.startsWith('/css/') || value.pathname.startsWith('/icons/') || value.pathname.startsWith('/assets/'))) return raw;
              value.protocol = 'lingua-dev:'; value.host = window.__linguaCachedHost;
              return value.href;
            } catch (_) { return raw; }
          };
          const nativeFetch = window.fetch;
          window.fetch = (input, init) => {
            if (typeof input === 'string' || input instanceof URL) return nativeFetch(map(input), init);
            if (input && input.url) return nativeFetch(new Request(map(input.url), input), init);
            return nativeFetch(input, init);
          };
          const nativeOpen = XMLHttpRequest.prototype.open;
          XMLHttpRequest.prototype.open = function(method, raw, ...rest) { return nativeOpen.call(this, method, map(raw), ...rest); };
        })();
        """
    }
    @objc private func cachePage() {
        guard let cache = cache, cacheTask == nil else { return }
        cacheButton.isEnabled = false; cacheButton.setTitle("正在缓存…", for: .normal)
        let generation = reloadGeneration
        showError("正在下载完整前端源码…")
        cacheTask = Task { [weak self, cache] in
            do {
                let saved = try await cache.download()
                guard let self = self, !Task.isCancelled else { return }
                cache.activate(saved)
                if generation == self.reloadGeneration {
                    self.cached = true; self.cacheNotice = true
                    self.pendingNotice = "已缓存 \(saved.entries.count) 个文件，可关闭开发服务器测试"
                    let target = self.web.url.flatMap { cache.remoteURL($0) } ?? self.url!
                    self.liveTarget = target
                    _ = self.loadCachedDocument(target)
                } else { self.showError("已缓存 \(saved.entries.count) 个文件；当前继续使用联网源码") }
            } catch {
                if !Task.isCancelled { self?.showError("缓存失败，原有缓存保留；请确认服务器在线且支持缓存清单") }
            }
            self?.cacheButton.isEnabled = true; self?.cacheButton.setTitle("缓存前端源码", for: .normal)
            self?.cacheTask = nil
        }
    }
    private func recoverCached(_ message: String) {
        if !cached, let target = liveTarget ?? url, loadCachedDocument(target) {
            cached = true; cacheNotice = true; pendingNotice = "开发服务器不可用，已使用缓存源码"
        } else { showError(message) }
    }
    @discardableResult
    private func loadCachedDocument(_ target: URL) -> Bool {
        guard let cache = cache, let data = cache.document(target) else { return false }
        let request = URLRequest(url: target)
        let response = URLResponse(url: target, mimeType: "text/html", expectedContentLength: data.count, textEncodingName: "UTF-8")
        web.loadSimulatedRequest(request, response: response, responseData: data)
        return true
    }
    @objc private func returnToApp() {
        cacheTask?.cancel()
        let defaults = UserDefaults.standard
        let previous = defaults.string(forKey: "CapacitorStorage.lingua.previous-channel") ?? "stable"
        let channel = ["stable", "own", "preview"].contains(previous) ? previous : "stable"
        defaults.set(channel, forKey: "CapacitorStorage.lingua.channel")
        view.window?.rootViewController = LinguaViewController()
    }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        // A remote page may use window.confirm instead of the bundled sheet implementation.
        // WKWebView silently cancels it when no UI delegate handles the request.
        let dialog = UIAlertController(title: webView.url.flatMap { cache?.remoteURL($0) }?.host ?? webView.url?.host, message: message, preferredStyle: .alert)
        dialog.addAction(UIAlertAction(title: "取消", style: .cancel) { _ in completionHandler(false) })
        dialog.addAction(UIAlertAction(title: "确定", style: .default) { _ in completionHandler(true) })
        guard presentedViewController == nil, view.window != nil else { completionHandler(false); return }
        present(dialog, animated: true)
    }
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let dialog = UIAlertController(title: webView.url.flatMap { cache?.remoteURL($0) }?.host ?? webView.url?.host, message: message, preferredStyle: .alert)
        dialog.addAction(UIAlertAction(title: "确定", style: .default) { _ in completionHandler() })
        guard presentedViewController == nil, view.window != nil else { completionHandler(); return }
        present(dialog, animated: true)
    }
    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        errorLabel.isHidden = true; setPresentation(dark: dark, immersive: false)
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code != NSURLErrorCancelled { recoverCached("网页加载失败") }
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code != NSURLErrorCancelled { recoverCached("网页加载失败") }
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        updateInsets()
        if let message = pendingNotice { pendingNotice = nil; showError(message) }
        else if cached && !cacheNotice { cacheNotice = true; showError("正在使用已缓存源码；刷新可加载最新源码") }
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { showError("网页已停止响应") }
    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if navigationResponse.isForMainFrame, let response = navigationResponse.response as? HTTPURLResponse, response.statusCode >= 400 {
            decisionHandler(.cancel); recoverCached("网页暂时无法访问"); return
        }
        decisionHandler(.allow)
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let target = navigationAction.request.url, navigationAction.targetFrame?.isMainFrame == true {
            if cached, target.scheme != "lingua-dev", loadCachedDocument(target) {
                decisionHandler(.cancel); return
            }
            if let remote = cache?.remoteURL(target) ?? Self.validURL(target.absoluteString) { liveTarget = remote }
        }
        let allowed = navigationAction.request.url.map { ["http", "https", "about", "blob", "lingua-dev"].contains($0.scheme ?? "") } ?? false
        decisionHandler(allowed ? .allow : .cancel)
    }
    deinit { cacheTask?.cancel() }
    private static let presentationScript = """
        (() => {
          const install = () => {
            const root = document.documentElement;
            root.classList.add('native-app');
            window.__linguaApplyInsets = () => {
              (window.__linguaInsets || [0,0,0,0]).forEach((v,i) => root.style.setProperty('--native-safe-' + ['t','r','b','l'][i], v + 'px'));
            };
            window.__linguaApplyInsets();
            const sync = () => window.webkit.messageHandlers.linguaPresentation.postMessage({dark:root.dataset.theme === 'dark',immersive:root.classList.contains('video-immersive')});
            new MutationObserver(sync).observe(root,{attributes:true,attributeFilter:['class','data-theme']});
            sync();
          };
          if (document.documentElement) install(); else document.addEventListener('DOMContentLoaded',install,{once:true});
        })();
        """
}

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Override point for customization after application launch.
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: "Default Configuration",
                                          sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }
}
