import AVFoundation
import MediaPlayer
import Capacitor
import WebKit
import UIKit

/// File-backed audio playback lives outside WKWebView, including when the web process is suspended.
@objc(AudioPlayerPlugin)
final class AudioPlayerPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "AudioPlayerPlugin"
    let jsName = "AudioPlayer"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "capabilities", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "begin", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "append", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "prepare", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "command", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "state", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "release", returnType: CAPPluginReturnPromise)
    ]
    private static weak var instance: AudioPlayerPlugin?
    private var player: AVPlayer?
    private var file: URL?, handle: FileHandle?
    private var session = "", title = ""
    private var expectedBytes = 0, writtenBytes = 0, revision = 0, serial = 0
    private var desiredRate: Float = 1
    private var desiredPlaying = false, ended = false, interrupted = false, resumeAfterInterruption = false
    private var seekTarget: Double?
    private var loopStart: Double?, loopEnd: Double?, repeatAll = false
    private var readyCall: CAPPluginCall?, readyTimeout: DispatchWorkItem?
    private var lastNowPlaying = ""
    private var observations: [NSKeyValueObservation] = []
    private var notifications: [NSObjectProtocol] = []
    private var remoteTargets: [(MPRemoteCommand, Any)] = []
    private var timeObserver: Any?
    private var appActive = true

    @objc func capabilities(_ call: CAPPluginCall) {
        call.resolve(["videoAudio": true])
    }

    static func clock(session: String) -> (position: Double, duration: Double, rate: Double, paused: Bool)? {
        guard let audio = instance, audio.session == session, audio.player?.currentItem?.status == .readyToPlay else { return nil }
        return (audio.position, audio.duration, Double(audio.desiredRate), !audio.desiredPlaying || audio.interrupted || audio.waiting)
    }
    private var duration: Double {
        let value = player?.currentItem?.duration.seconds ?? 0
        return value.isFinite ? max(0, value) : 0
    }
    private var position: Double {
        let value = seekTarget ?? player?.currentTime().seconds ?? 0
        return value.isFinite ? max(0, value) : 0
    }
    private var waiting: Bool { player?.timeControlStatus == .waitingToPlayAtSpecifiedRate }
    private func snapshot() -> [String: Any] {
        serial += 1
        return ["session": session, "serial": serial, "revision": revision,
                "position": position, "duration": duration, "rate": desiredRate,
                "paused": !desiredPlaying || interrupted, "ended": ended,
                "waiting": waiting, "seeking": seekTarget != nil,
                "ready": player?.currentItem?.status == .readyToPlay]
    }
    private func publish(_ event: String = "timeupdate") {
        guard !session.isEmpty else { return }
        var state = snapshot(); state["event"] = event
        if event != "timeupdate" || appActive { notifyListeners("stateChanged", data: state) }
        updateNowPlaying()
    }
    private func matches(_ call: CAPPluginCall) -> Bool {
        guard call.getString("session") == session, !session.isEmpty else {
            call.reject("音频会话已更换", "AUDIO_STALE"); return false
        }
        return true
    }

    @objc func begin(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let id = call.getString("session"), UUID(uuidString: id) != nil,
                  let size = call.getInt("size"), size > 0 else { call.reject("音频文件无效"); return }
            self.cleanup()
            do {
                let folder = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
                    .appendingPathComponent("LinguaPlayback", isDirectory: true)
                try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                // This directory is exclusively our transient audio cache, never the user's library.
                for file in try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil) {
                    try? FileManager.default.removeItem(at: file)
                }
                let ext = call.getString("extension")?.lowercased() ?? "m4a"
                let safeExt = ["mp3", "m4a", "mp4", "m4v", "mov", "wav", "aac", "flac", "aiff", "aif", "caf", "ogg", "webm"].contains(ext) ? ext : "m4a"
                let file = folder.appendingPathComponent(id).appendingPathExtension(safeExt)
                guard FileManager.default.createFile(atPath: file.path, contents: nil,
                    attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]) else {
                    call.reject("无法准备本地音频文件"); return
                }
                self.file = file; self.handle = try FileHandle(forWritingTo: file)
                self.session = id; self.expectedBytes = size
                self.title = call.getString("title") ?? "Lingua"
                AudioPlayerPlugin.instance = self
                call.resolve()
            } catch { self.cleanup(); call.reject("无法准备音频：\(error.localizedDescription)") }
        }
    }
    @objc func append(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard self.matches(call) else { return }
            guard let offset = call.getInt("offset"), offset == self.writtenBytes,
                  let encoded = call.getString("data"), encoded.utf8.count <= 700000,
                  let data = Data(base64Encoded: encoded), !data.isEmpty, data.count <= 512 * 1024,
                  self.writtenBytes + data.count <= self.expectedBytes, let handle = self.handle else {
                call.reject("音频分块不完整"); return
            }
            do { try handle.write(contentsOf: data); self.writtenBytes += data.count; call.resolve() }
            catch { call.reject("音频写入失败：\(error.localizedDescription)") }
        }
    }
    @objc func prepare(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard self.matches(call) else { return }
            guard self.player == nil, self.writtenBytes == self.expectedBytes, let file = self.file else {
                call.reject("音频尚未传输完整"); return
            }
            do { try self.handle?.close(); self.handle = nil }
            catch { call.reject("音频文件写入失败"); return }
            let item = AVPlayerItem(url: file)
            item.allowedAudioSpatializationFormats = []
            item.audioTimePitchAlgorithm = .timeDomain
            let player = AVPlayer(playerItem: item)
            player.audiovisualBackgroundPlaybackPolicy = .continuesIfPossible
            self.player = player; self.readyCall = call
            self.observations = [
                item.observe(\.status, options: [.new]) { [weak self] _, _ in
                    DispatchQueue.main.async { self?.readyChanged(player) }
                },
                player.observe(\.timeControlStatus, options: [.new]) { [weak self] _, _ in
                    DispatchQueue.main.async {
                        guard let self = self, self.player === player else { return }
                        self.publish(self.waiting ? "waiting" : "state")
                    }
                }
            ]
            self.timeObserver = player.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.1, preferredTimescale: 600), queue: .main) { [weak self] _ in
                guard let self = self, self.player === player else { return }
                if self.desiredPlaying, self.seekTarget == nil, let start = self.loopStart, let end = self.loopEnd,
                   self.position >= end || self.position < start - 0.2 {
                    self.seek(start); return
                }
                self.publish()
            }
            self.installSystemControls(item)
            let task = DispatchWorkItem { [weak self] in
                guard let self = self, self.player === player, let pending = self.readyCall else { return }
                self.readyCall = nil; pending.reject("音频准备超时"); self.cleanup()
            }
            self.readyTimeout = task
            DispatchQueue.main.asyncAfter(deadline: .now() + 15, execute: task)
            self.readyChanged(player)
        }
    }
    private func readyChanged(_ expected: AVPlayer) {
        guard player === expected else { return }
        if expected.currentItem?.status == .readyToPlay, let call = readyCall {
            // WebKit renders the frames; this player owns only the sound and clock.
            // Disable video tracks to avoid an invisible video presentation in background.
            expected.currentItem?.tracks.forEach { track in
                if track.assetTrack?.mediaType == .video { track.isEnabled = false }
            }
            readyCall = nil; readyTimeout?.cancel(); readyTimeout = nil
            call.resolve(snapshot()); publish("loadedmetadata")
        } else if expected.currentItem?.status == .failed {
            let message = expected.currentItem?.error?.localizedDescription ?? "不支持此音频格式"
            if let call = readyCall { readyCall = nil; call.reject(message); cleanup() }
            else { desiredPlaying = false; publish("error") }
        }
    }
    @objc func command(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard self.matches(call) else { return }
            guard self.player != nil else { call.reject("音频尚未准备好"); return }
            let revision = call.getInt("revision") ?? 0
            guard revision > self.revision else { call.resolve(self.snapshot()); return }
            self.revision = revision
            do {
                switch call.getString("action") {
                case "play": try self.play()
                case "pause": self.pause()
                case "seek": self.seek(call.getDouble("position") ?? self.position)
                case "rate":
                    let rate = call.getDouble("rate") ?? 1
                    guard rate.isFinite, rate >= 0.1, rate <= 4 else { call.reject("播放速度无效"); return }
                    self.desiredRate = Float(rate)
                    if self.desiredPlaying && !self.interrupted { self.player?.rate = self.desiredRate }
                    self.publish("ratechange")
                case "metadata": self.title = call.getString("title") ?? self.title; self.updateNowPlaying()
                case "volume":
                    let volume = call.getDouble("volume") ?? 1
                    guard volume.isFinite else { call.reject("音量无效"); return }
                    self.player?.volume = Float(max(0, min(1, volume)))
                    self.player?.isMuted = call.getBool("muted") ?? false
                case "loop":
                    let start = call.getDouble("start"), end = call.getDouble("end")
                    if let start = start, let end = end, start.isFinite, end.isFinite, start >= 0,
                       min(end, self.duration) > start {
                        self.loopStart = start; self.loopEnd = min(end, self.duration)
                    } else { self.loopStart = nil; self.loopEnd = nil }
                    self.repeatAll = call.getBool("all") ?? false
                default: call.reject("未知播放指令"); return
                }
                call.resolve(self.snapshot())
            } catch { self.desiredPlaying = false; self.publish("pause"); call.reject(error.localizedDescription) }
        }
    }
    private func play() throws {
        try PlaybackSession.activate()
        interrupted = false; desiredPlaying = true; ended = false
        if duration > 0 && position >= duration - 0.01 { seek(0) }
        else { player?.playImmediately(atRate: desiredRate) }
        publish("play")
    }
    private func pause() {
        desiredPlaying = false; resumeAfterInterruption = false
        player?.pause(); publish("pause")
    }
    private func seek(_ value: Double) {
        guard value.isFinite, let player = player else { return }
        let target = max(0, min(value, duration)), expectedSession = session
        seekTarget = target; ended = false
        player.seek(to: CMTime(seconds: target, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] finished in
            DispatchQueue.main.async {
                guard let self = self, self.session == expectedSession, self.player === player,
                      finished, self.seekTarget == target else { return }
                self.seekTarget = nil
                if self.desiredPlaying && !self.interrupted { player.playImmediately(atRate: self.desiredRate) }
                self.publish("seeked")
            }
        }
        publish("seeking")
    }
    @objc func state(_ call: CAPPluginCall) {
        DispatchQueue.main.async { if self.matches(call) { call.resolve(self.snapshot()) } }
    }
    @objc func release(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if call.getString("session") == self.session { self.cleanup() }
            call.resolve()
        }
    }
    private func installSystemControls(_ item: AVPlayerItem) {
        let center = NotificationCenter.default
        appActive = UIApplication.shared.applicationState == .active
        notifications.append(center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            self?.appActive = false // AVPlayer continues; stop queueing web-only progress events.
        })
        notifications.append(center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            self?.appActive = true; self?.publish("state")
        })
        notifications.append(center.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main) { [weak self] _ in
            guard let self = self else { return }
            if self.repeatAll || self.loopStart != nil { self.seek(self.loopStart ?? 0) }
            else { self.desiredPlaying = false; self.ended = true; self.publish("ended") }
        })
        notifications.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] event in
            guard let self = self, let type = event.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt else { return }
            if type == AVAudioSession.InterruptionType.began.rawValue {
                self.resumeAfterInterruption = self.desiredPlaying; self.interrupted = true
                self.player?.pause(); self.publish("pause")
            } else {
                let options = AVAudioSession.InterruptionOptions(rawValue: event.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0)
                let resume = self.resumeAfterInterruption && options.contains(.shouldResume)
                self.interrupted = false; self.resumeAfterInterruption = false
                if resume { do { try self.play() } catch { self.pause() } } else { self.pause() }
            }
        })
        notifications.append(center.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] event in
            if event.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue { self?.pause() }
        })
        let remote = MPRemoteCommandCenter.shared()
        func add(_ command: MPRemoteCommand, _ action: @escaping (MPRemoteCommandEvent) -> Void) {
            command.isEnabled = true
            let target = command.addTarget { event in
                DispatchQueue.main.async { action(event) }
                return .success
            }
            remoteTargets.append((command, target))
        }
        add(remote.playCommand) { [weak self] _ in do { try self?.play() } catch { self?.pause() } }
        add(remote.pauseCommand) { [weak self] _ in self?.pause() }
        add(remote.togglePlayPauseCommand) { [weak self] _ in
            guard let self = self else { return }
            if self.desiredPlaying { self.pause() } else { do { try self.play() } catch { self.pause() } }
        }
        add(remote.changePlaybackPositionCommand) { [weak self] event in
            if let event = event as? MPChangePlaybackPositionCommandEvent { self?.seek(event.positionTime) }
        }
        add(remote.skipForwardCommand) { [weak self] event in
            guard let self = self else { return }; self.seek(self.position + ((event as? MPSkipIntervalCommandEvent)?.interval ?? 10))
        }
        add(remote.skipBackwardCommand) { [weak self] event in
            guard let self = self else { return }; self.seek(self.position - ((event as? MPSkipIntervalCommandEvent)?.interval ?? 10))
        }
    }
    private func updateNowPlaying() {
        guard player != nil else { return }
        let key = "\(title)|\(Int(position))|\(desiredRate)|\(desiredPlaying)|\(interrupted)|\(waiting)|\(duration)"
        if key == lastNowPlaying { return }
        lastNowPlaying = key
        MPNowPlayingInfoCenter.default().nowPlayingInfo = [MPMediaItemPropertyTitle: title,
            MPMediaItemPropertyArtist: "Lingua", MPMediaItemPropertyPlaybackDuration: duration,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: position,
            MPNowPlayingInfoPropertyPlaybackRate: desiredPlaying && !interrupted && !waiting ? desiredRate : 0]
    }
    private func cleanup() {
        readyTimeout?.cancel(); readyTimeout = nil
        readyCall?.reject("音频已关闭"); readyCall = nil
        observations = []; notifications.forEach { NotificationCenter.default.removeObserver($0) }; notifications = []
        remoteTargets.forEach { $0.0.removeTarget($0.1) }; remoteTargets = []
        if let observer = timeObserver { player?.removeTimeObserver(observer) }; timeObserver = nil
        let hadPlayer = player != nil
        player?.pause(); player?.replaceCurrentItem(with: nil); player = nil
        try? handle?.close(); handle = nil
        if let file = file { try? FileManager.default.removeItem(at: file) }; file = nil
        if hadPlayer { MPNowPlayingInfoCenter.default().nowPlayingInfo = nil }
        session = ""; revision = 0; serial = 0; writtenBytes = 0; expectedBytes = 0
        desiredRate = 1; desiredPlaying = false; ended = false; interrupted = false; resumeAfterInterruption = false
        lastNowPlaying = ""
        seekTarget = nil; loopStart = nil; loopEnd = nil; repeatAll = false
    }
    override func shouldOverrideLoad(_ navigationAction: WKNavigationAction) -> NSNumber? {
        if navigationAction.targetFrame?.isMainFrame == true { DispatchQueue.main.async { self.cleanup() } }
        return nil
    }
    deinit { cleanup() }
}
