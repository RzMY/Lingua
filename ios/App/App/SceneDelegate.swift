import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        if UserDefaults.standard.string(forKey: "CapacitorStorage.lingua.channel") == "development" {
            let raw = UserDefaults.standard.string(forKey: "CapacitorStorage.lingua.development-url") ?? ""
            window?.rootViewController = DevelopmentViewController(url: DevelopmentViewController.validURL(raw))
        } else {
            let defaults = UserDefaults.standard
            let channel = defaults.string(forKey: "CapacitorStorage.lingua.channel") ?? "stable"
            if ["stable", "own", "preview"].contains(channel) {
                defaults.set(channel, forKey: "CapacitorStorage.lingua.previous-channel")
            }
            window?.rootViewController = LinguaViewController()
        }
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
