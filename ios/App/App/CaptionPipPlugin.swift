import UIKit
import AVKit
import AVFoundation
import Capacitor
import WebKit

// Only application-owned views are changed. No private PiP window/KVC customization.
private final class CaptionContentView: UIView {
    // Public UIKit material softens the fallback black surface without dimming the glyphs.
    // It cannot force the system PiP container to expose another app behind it.
    private let material = UIVisualEffectView(effect: UIBlurEffect(style: .systemUltraThinMaterialLight))
    private let original = UILabel()
    private let translation = UILabel()
    private let stack = UIStackView()
    private var text = "", translated = "", size: CGFloat = 20
    private var renderedSize: CGFloat = -1

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .clear
        isOpaque = false
        layer.isOpaque = false
        layer.backgroundColor = UIColor.clear.cgColor
        isUserInteractionEnabled = false
        // Ultra-thin material is already translucent. Fading the effect view's alpha can
        // break UIKit's backdrop rendering; keep the text and effect hierarchies at alpha 1.
        // material.contentView.backgroundColor = UIColor.white.withAlphaComponent(0.12)
        material.isOpaque = false
        material.translatesAutoresizingMaskIntoConstraints = false
        addSubview(material)
        NSLayoutConstraint.activate([
            material.leadingAnchor.constraint(equalTo: leadingAnchor),
            material.trailingAnchor.constraint(equalTo: trailingAnchor),
            material.topAnchor.constraint(equalTo: topAnchor),
            material.bottomAnchor.constraint(equalTo: bottomAnchor)
        ])
        stack.axis = .vertical
        stack.spacing = 4
        stack.backgroundColor = .clear
        stack.isOpaque = false
        stack.translatesAutoresizingMaskIntoConstraints = false
        for label in [original, translation] {
            label.backgroundColor = .clear
            label.isOpaque = false
            label.textAlignment = .center
            label.numberOfLines = 2
            label.lineBreakMode = .byTruncatingTail
            label.adjustsFontSizeToFitWidth = true
            label.minimumScaleFactor = 0.7
            label.setContentCompressionResistancePriority(.defaultLow, for: .vertical)
            stack.addArrangedSubview(label)
        }
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
            stack.centerYAnchor.constraint(equalTo: centerYAnchor),
            stack.topAnchor.constraint(greaterThanOrEqualTo: topAnchor, constant: 6),
            stack.bottomAnchor.constraint(lessThanOrEqualTo: bottomAnchor, constant: -6)
        ])
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func render(text: String, translation: String, size: CGFloat) {
        guard self.text != text || translated != translation || self.size != size else { return }
        self.text = text
        translated = translation
        self.size = size
        renderedSize = -1
        setNeedsLayout()
    }
    override func layoutSubviews() {
        super.layoutSubviews()
        // Small windows remain legible; the glyph outline replaces a rectangular backdrop.
        // let scale = max(0.65, min(1.5, bounds.width / 480))
        let scale = max(0.85, min(1.5, bounds.width / 320))
        guard renderedSize != size * scale else { return }
        renderedSize = size * scale
        func caption(_ value: String, pointSize: CGFloat) -> NSAttributedString {
            let paragraph = NSMutableParagraphStyle()
            paragraph.alignment = .center
            paragraph.lineBreakMode = .byTruncatingTail
            let shadow = NSShadow()
            shadow.shadowColor = UIColor.black.withAlphaComponent(0.7)
            shadow.shadowOffset = CGSize(width: 0, height: 1)
            shadow.shadowBlurRadius = 2
            return NSAttributedString(string: value, attributes: [
                .font: UIFont.systemFont(ofSize: pointSize, weight: .semibold),
                .foregroundColor: UIColor.white, .strokeColor: UIColor.black,
                // .strokeWidth: -3,
                 .paragraphStyle: paragraph, .shadow: shadow
            ])
        }
        original.attributedText = caption(text, pointSize: size * scale)
        translation.attributedText = caption(translated, pointSize: size * scale * 0.8)
        translation.isHidden = translated.isEmpty
    }
}

private final class CaptionCallController: AVPictureInPictureVideoCallViewController {
    let captions = CaptionContentView(frame: .zero)
    override func viewDidLoad() {
        super.viewDidLoad()
        preferredContentSize = CGSize(width: 600, height: 252)
        // Preserve AVKit's root view/lifecycle. Add our content using the documented API.
        view.backgroundColor = .clear
        view.isOpaque = false
        view.layer.isOpaque = false
        captions.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(captions)
        NSLayoutConstraint.activate([
            captions.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            captions.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            captions.topAnchor.constraint(equalTo: view.topAnchor),
            captions.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])
    }
}

@objc(CaptionPipPlugin)
final class CaptionPipPlugin: CAPPlugin, CAPBridgedPlugin, AVPictureInPictureControllerDelegate {
    let identifier = "CaptionPipPlugin"
    let jsName = "CaptionPip"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "capabilities", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "update", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "close", returnType: CAPPluginReturnPromise)
    ]
    private struct Line {
        let start: Double
        let text: String
        let translation: String
    }
    private var controller: AVPictureInPictureController?
    private var content: CaptionCallController?
    private var sourceView: UIView?
    private var possibleObservation: NSKeyValueObservation?
    private var timer: Timer?
    private var timeout: DispatchWorkItem?
    private var pendingOpen: CAPPluginCall?
    private var pendingClose: [CAPPluginCall] = []
    private var started = false
    private var willStart = false
    private var stopping = false
    private var retiring = false
    private var session = ""
    private var lines: [Line] = []
    private var position = 0.0, duration = 0.0, rate = 1.0, anchoredAt = 0.0
    private var paused = true, showTranslation = true
    private var fontSize: CGFloat = 20
    private var lastSequence = -1
    private var audioSessionID = ""
    private var readinessTimeout: DispatchWorkItem?
    private var probeCalls: [CAPPluginCall] = []

    @objc func capabilities(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard !self.stopping, self.prepare() else {
                call.resolve(["supported": false]); return
            }
            if self.controller?.isPictureInPictureActive == true || self.controller?.isPictureInPicturePossible == true {
                call.resolve(["supported": true, "presentation": "native-caption-view"]); return
            }
            self.probeCalls.append(call)
            guard self.readinessTimeout == nil else { return }
            let expected = self.controller
            let timeout = DispatchWorkItem { [weak self] in
                guard let self = self, self.controller === expected else { return }
                self.finishProbe(self.controller?.isPictureInPicturePossible == true)
            }
            self.readinessTimeout = timeout
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5, execute: timeout)
        }
    }

    // Preparation and open share this exact controller. Never discard a successful probe and
    // immediately create another AVKit session while the previous one is still tearing down.
    private func prepare() -> Bool {
        guard AVPictureInPictureController.isPictureInPictureSupported(),
              let host = bridge?.viewController?.view, host.window != nil else { return false }
        if controller != nil { return sourceView?.window != nil }
        let content = CaptionCallController()
        content.loadViewIfNeeded()
        content.view.frame = CGRect(origin: .zero, size: content.preferredContentSize)
        content.view.layoutIfNeeded()
        let source = UIView(frame: .zero)
        source.backgroundColor = .clear
        source.isOpaque = false
        source.layer.isOpaque = false
        source.isUserInteractionEnabled = false
        let width = min(max(1, host.bounds.width - 24), 600)
        let height = min(host.bounds.height * 0.4, width * 252 / 600)
        source.frame = CGRect(x: (host.bounds.width - width) / 2,
                              y: max(0, (host.bounds.height - height) / 2), width: width, height: height)
        source.autoresizingMask = [.flexibleLeftMargin, .flexibleRightMargin, .flexibleTopMargin, .flexibleBottomMargin]
        host.addSubview(source)
        host.layoutIfNeeded()
        self.sourceView = source
        self.content = content
        let sourceConfig = AVPictureInPictureController.ContentSource(
            activeVideoCallSourceView: source, contentViewController: content)
        let controller = AVPictureInPictureController(contentSource: sourceConfig)
        controller.delegate = self
        controller.canStartPictureInPictureAutomaticallyFromInline = false
        self.controller = controller
        possibleObservation = controller.observe(\.isPictureInPicturePossible, options: [.new]) { [weak self] current, _ in
            DispatchQueue.main.async {
                guard let self = self, self.controller === current else { return }
                if current.isPictureInPicturePossible { self.finishProbe(true) }
                self.startIfPossible()
            }
        }
        return true
    }

    private func finishProbe(_ supported: Bool) {
        readinessTimeout?.cancel(); readinessTimeout = nil
        let calls = probeCalls; probeCalls = []
        calls.forEach { $0.resolve(["supported": supported, "presentation": "native-caption-view"]) }
        // Keep the prepared controller and source view alive for the user's click.
    }

    override func shouldOverrideLoad(_ navigationAction: WKNavigationAction) -> NSNumber? {
        if navigationAction.targetFrame?.isMainFrame == true {
            DispatchQueue.main.async {
                self.finishProbe(false)
                if self.controller != nil { self.retiring = true; self.stop() }
            }
        }
        return nil
    }

    @objc func open(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard self.session.isEmpty, self.pendingOpen == nil, !self.stopping, !self.retiring else {
                call.reject("字幕小窗正在打开或关闭，请稍后重试", "PIP_BUSY"); return
            }
            guard AVPictureInPictureController.isPictureInPictureSupported() else {
                call.reject("此设备不支持原生字幕画中画", "PIP_UNSUPPORTED"); return
            }
            guard let session = call.getString("session"), !session.isEmpty, self.prepare() else {
                call.reject("播放窗口尚未就绪", "PIP_SOURCE_NOT_READY"); return
            }
            self.session = session
            self.lastSequence = -1
            self.started = false
            self.willStart = false
            self.apply(call)
            self.paint()
            self.content?.view.layoutIfNeeded()
            self.sourceView?.superview?.layoutIfNeeded()
            // This is a user-initiated PiP request, not a launch-time audio-focus grab.
            // The media keeps ownership after PiP closes; never deactivate its shared session.
            do {
                try PlaybackSession.activate()
            } catch {
                self.reject(call, message: "画中画音频会话未能就绪", code: "PIP_AUDIO_SESSION", error: error)
                self.finish(reuse: true); return
            }
            self.pendingOpen = call
            self.scheduleStartTimeout()
            self.startIfPossible()
        }
    }

    private func scheduleStartTimeout() {
        timeout?.cancel()
        let expected = controller, expectedSession = session
        let task = DispatchWorkItem { [weak self] in
            guard let self = self, self.controller === expected, self.session == expectedSession,
                  self.pendingOpen != nil, !self.stopping else { return }
            if self.controller?.isPictureInPictureActive == true {
                if let controller = self.controller { self.pictureInPictureControllerDidStartPictureInPicture(controller) }
            } else if !self.started {
                self.fail("字幕画中画内容源尚未就绪，系统未进入启动阶段", code: "PIP_NOT_READY")
            } else if !self.willStart {
                self.fail("已请求系统小窗，但没有收到启动回调", code: "PIP_START_NO_CALLBACK")
            } else {
                self.fail("系统小窗已开始启动，但未完成呈现", code: "PIP_PRESENTATION_TIMEOUT")
            }
        }
        timeout = task
        DispatchQueue.main.asyncAfter(deadline: .now() + 5, execute: task)
    }

    private func startIfPossible() {
        guard pendingOpen != nil, !started, !stopping, controller?.isPictureInPicturePossible == true else { return }
        guard sourceView?.window != nil else {
            fail("字幕小窗的来源窗口已离开屏幕", code: "PIP_SOURCE_DETACHED"); return
        }
        started = true
        scheduleStartTimeout()
        controller?.startPictureInPicture()
    }

    private func reject(_ call: CAPPluginCall, message: String, code: String, error: Error? = nil) {
        let details: [String: Any] = [
            "stage": code, "possible": controller?.isPictureInPicturePossible ?? false,
            "startRequested": started, "willStart": willStart,
            "sourceAttached": sourceView?.window != nil,
            "ios": UIDevice.current.systemVersion,
            "build": Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "?"
        ]
        var suffix = code
        if let error = error as NSError? { suffix += " / \(error.domain):\(error.code)" }
        call.reject("\(message)（\(suffix)）", code, error, details)
    }

    @objc func update(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard call.getString("session") == self.session, self.controller != nil, !self.stopping else {
                call.resolve(); return
            }
            self.apply(call)
            self.paint()
            call.resolve()
        }
    }

    private func apply(_ call: CAPPluginCall) {
        let sequence = call.getInt("sequence") ?? 0
        guard sequence > lastSequence else { return }
        lastSequence = sequence
        if let value = call.getDouble("position"), value.isFinite { position = max(0, value) }
        if let value = call.getDouble("duration"), value.isFinite { duration = max(0, value) }
        if let value = call.getDouble("rate"), value.isFinite { rate = max(0.1, min(16, value)) }
        paused = call.getBool("paused") ?? paused
        audioSessionID = call.getString("nativeAudioSession") ?? ""
        anchoredAt = ProcessInfo.processInfo.systemUptime
        if let value = call.getDouble("captionSize"), value.isFinite { fontSize = CGFloat(max(12, min(36, value))) }
        showTranslation = call.getBool("showTranslation") ?? showTranslation
        if let data = call.getArray("sentences", JSObject.self) {
            lines = data.compactMap { row -> Line? in
                guard let start = row["start"] as? Double, start.isFinite, start >= 0 else { return nil }
                return Line(start: start, text: String((row["text"] as? String ?? "").prefix(10000)),
                            translation: String((row["translation"] as? String ?? "").prefix(10000)))
            }.sorted { $0.start < $1.start }
        }
    }

    private func paint() {
        // The AVPlayer clock remains authoritative when WKWebView no longer sends events.
        let native = AudioPlayerPlugin.clock(session: audioSessionID)
        let elapsed = paused ? 0 : max(0, ProcessInfo.processInfo.systemUptime - anchoredAt) * rate
        let time = (native?.position ?? min(duration, position + elapsed)) + 0.004
        var lo = 0, hi = lines.count - 1, index = 0
        while lo <= hi {
            let mid = (lo + hi) / 2
            if lines[mid].start <= time { index = mid; lo = mid + 1 } else { hi = mid - 1 }
        }
        let line = lines.isEmpty ? nil : lines[index]
        let original = line?.text ?? "聆听中"
        let translation = showTranslation ? line?.translation ?? "" : ""
        content?.captions.render(text: original, translation: translation, size: fontSize)
    }

    @objc func close(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard self.controller != nil, call.getString("session") == self.session else { call.resolve(); return }
            self.pendingClose.append(call)
            self.stop()
        }
    }

    private func stop() {
        if stopping { return }
        stopping = true
        finishProbe(false)
        timeout?.cancel()
        pendingOpen?.reject("字幕小窗已取消")
        pendingOpen = nil
        if started || controller?.isPictureInPictureActive == true {
            // Late start callbacks are also stopped. Do not overlap two system controllers.
            scheduleStopTimeout()
            controller?.stopPictureInPicture()
        } else { finish() }
    }

    private func scheduleStopTimeout() {
        timeout?.cancel()
        let expected = controller, expectedSession = session
        let task = DispatchWorkItem { [weak self] in
            guard let self = self, self.controller === expected, self.session == expectedSession else { return }
            if self.controller?.isPictureInPictureActive == true {
                let calls = self.pendingClose; self.pendingClose = []; self.stopping = false
                self.confirmStarted()
                calls.forEach { $0.reject("请使用系统小窗的关闭按钮退出") }
            } else { self.finish() }
        }
        timeout = task
        DispatchQueue.main.asyncAfter(deadline: .now() + 3, execute: task)
    }

    private func fail(_ message: String, code: String) {
        if let call = pendingOpen { reject(call, message: message, code: code) }
        pendingOpen = nil
        stop()
    }

    private func finish(reuse: Bool = false) {
        guard controller != nil else { return }
        let endedSession = session
        timeout?.cancel(); timeout = nil
        finishProbe(false)
        timer?.invalidate(); timer = nil
        // A normal didStop ends the presentation, not the content source. Reuse the
        // probed controller on the next click instead of creating a competing AVKit
        // session from inside the previous controller's didStop callback.
        if !reuse || retiring {
            possibleObservation = nil
            controller?.delegate = nil
            controller?.contentSource = nil
            controller = nil; content = nil
            sourceView?.removeFromSuperview(); sourceView = nil
        }
        started = false; willStart = false; stopping = false; session = ""; lines = []; audioSessionID = ""
        retiring = false
        lastSequence = -1; position = 0; duration = 0; paused = true
        pendingOpen?.reject("字幕小窗已关闭"); pendingOpen = nil
        let calls = pendingClose; pendingClose = []
        calls.forEach { $0.resolve() }
        notifyListeners("stateChanged", data: ["session": endedSession, "active": false])
    }

    func pictureInPictureControllerWillStartPictureInPicture(_ pictureInPictureController: AVPictureInPictureController) {
        guard controller === pictureInPictureController else { return }
        if stopping { pictureInPictureController.stopPictureInPicture(); return }
        guard pendingOpen != nil else { return }
        willStart = true
        scheduleStartTimeout()
    }

    func pictureInPictureControllerDidStartPictureInPicture(_ pictureInPictureController: AVPictureInPictureController) {
        guard controller === pictureInPictureController else { return }
        if stopping || session.isEmpty { pictureInPictureController.stopPictureInPicture(); return }
        confirmStarted()
    }

    private func confirmStarted() {
        timeout?.cancel(); timeout = nil
        finishProbe(true)
        timer?.invalidate()
        let timer = Timer(timeInterval: 0.1, repeats: true) { [weak self] _ in self?.paint() }
        self.timer = timer
        RunLoop.main.add(timer, forMode: .common)
        paint()
        pendingOpen?.resolve(); pendingOpen = nil
        notifyListeners("stateChanged", data: ["session": session, "active": true, "closing": false])
    }
    func pictureInPictureControllerDidStopPictureInPicture(_ pictureInPictureController: AVPictureInPictureController) {
        if controller === pictureInPictureController { finish(reuse: true) }
    }
    func pictureInPictureControllerWillStopPictureInPicture(_ pictureInPictureController: AVPictureInPictureController) {
        guard controller === pictureInPictureController else { return }
        stopping = true
        scheduleStopTimeout()
        notifyListeners("stateChanged", data: ["session": session, "active": true, "closing": true])
    }
    func pictureInPictureController(_ pictureInPictureController: AVPictureInPictureController, failedToStartPictureInPictureWithError error: Error) {
        guard controller === pictureInPictureController else { return }
        if let call = pendingOpen {
            reject(call, message: "系统小窗启动失败：\(error.localizedDescription)", code: "PIP_START_FAILED", error: error)
        }
        pendingOpen = nil
        finish()
    }
    func pictureInPictureController(_ pictureInPictureController: AVPictureInPictureController,
        restoreUserInterfaceForPictureInPictureStopWithCompletionHandler completionHandler: @escaping (Bool) -> Void) {
        completionHandler(bridge?.viewController?.view.window != nil)
    }

    deinit {
        timer?.invalidate()
        timeout?.cancel()
        readinessTimeout?.cancel()
    }
}
