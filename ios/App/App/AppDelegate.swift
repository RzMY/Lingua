import UIKit
import Capacitor
import AVFoundation
import WebKit

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
        do { try AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback, options: [.allowAirPlay]) }
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
class DevelopmentViewController: UIViewController, WKNavigationDelegate {
    let url: URL?
    private var web: WKWebView!
    private var status: UILabel!
    static func validURL(_ raw: String) -> URL? {
        guard let url = URL(string: raw), ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
              url.host != nil, url.user == nil, url.password == nil else { return nil }
        return url
    }
    init(url: URL?) { self.url = url; super.init(nibName: nil, bundle: nil) }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.allowsPictureInPictureMediaPlayback = true
        config.websiteDataStore = .default()
        config.preferences.isElementFullscreenEnabled = true
        web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.allowsBackForwardNavigationGestures = true
        let back = UIButton(type: .system)
        back.setTitle("返回正式分支", for: .normal)
        back.addTarget(self, action: #selector(returnToApp), for: .touchUpInside)
        let reload = UIButton(type: .system)
        reload.setTitle("重新加载", for: .normal)
        reload.addTarget(self, action: #selector(reloadPage), for: .touchUpInside)
        status = UILabel(); status.text = "开发分支 · 远端网页"; status.font = .systemFont(ofSize: 12)
        status.adjustsFontSizeToFitWidth = true
        let bar = UIStackView(arrangedSubviews: [back, status, reload]); bar.spacing = 12
        for item in [bar, web!] as [UIView] { item.translatesAutoresizingMaskIntoConstraints = false; view.addSubview(item) }
        NSLayoutConstraint.activate([
            bar.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            bar.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 12),
            bar.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -12),
            bar.heightAnchor.constraint(equalToConstant: 44), web.topAnchor.constraint(equalTo: bar.bottomAnchor),
            web.leadingAnchor.constraint(equalTo: view.leadingAnchor), web.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            web.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])
        reloadPage()
    }
    @objc private func reloadPage() {
        guard let url = url else { status.text = "调试地址无效，请返回设置"; return }
        web.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 30))
    }
    @objc private func returnToApp() {
        UserDefaults.standard.set("stable", forKey: "CapacitorStorage.lingua.channel")
        view.window?.rootViewController = LinguaViewController()
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        status.text = "加载失败，可重试或返回设置"
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        status.text = "开发分支 · " + (webView.url?.host ?? "远端网页")
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        status.text = "网页进程已停止，可重新加载或返回"
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let allowed = navigationAction.request.url.map { ["http", "https", "about", "blob"].contains($0.scheme ?? "") } ?? false
        decisionHandler(allowed ? .allow : .cancel)
    }
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
