import AVFoundation
import Capacitor
import UIKit

/// iOS system voices rendered to PCM, then matched to measured media loudness.
@objc(SpeechAudioPlugin)
final class SpeechAudioPlugin: CAPPlugin, CAPBridgedPlugin, AVAudioPlayerDelegate {
    let identifier = "SpeechAudioPlugin"
    let jsName = "SpeechAudio"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "capabilities", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "speak", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise)
    ]
    private var job = ""
    private var pending: CAPPluginCall?
    private var synthesizer: AVSpeechSynthesizer?
    private var player: AVAudioPlayer?
    private var samples = [Float]()
    private var rate: Double = 0, channels = 0
    private var gain: Double = 1
    private var targetLufs: Double?
    private var watchdog: DispatchWorkItem?
    private var observers = [NSObjectProtocol]()

    override func load() {
        let center = NotificationCenter.default
        for name in [UIApplication.willResignActiveNotification, AVAudioSession.interruptionNotification] {
            observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                self?.finish(error: "发音已停止", code: "SPEECH_CANCELLED")
            })
        }
        observers.append(center.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] event in
            if event.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue {
                self?.finish(error: "音频输出已断开", code: "SPEECH_CANCELLED")
            }
        })
    }

    deinit {
        watchdog?.cancel()
        synthesizer?.stopSpeaking(at: .immediate)
        player?.stop()
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
    }

    @objc func capabilities(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let voices = AVSpeechSynthesisVoice.speechVoices().map { voice in
                ["voiceURI": voice.identifier, "name": voice.name, "lang": voice.language,
                 "localService": true, "default": voice.language == AVSpeechSynthesisVoice.currentLanguageCode()] as [String: Any]
            }
            call.resolve(["pcmVolume": true, "loudnessNormalization": true, "voices": voices])
        }
    }

    @objc func speak(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let id = call.getString("id"), UUID(uuidString: id) != nil,
                  let text = call.getString("text"), !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  text.utf16.count <= 2000, let volume = call.getDouble("volume"),
                  volume.isFinite, volume >= 0, volume <= 1 else {
                call.reject("发音参数无效", "SPEECH_INVALID"); return
            }
            let target = call.getDouble("targetLufs")
            guard target == nil || (target!.isFinite && target! >= -100 && target! <= 0) else {
                call.reject("目标响度无效", "SPEECH_INVALID"); return
            }
            self.finish(error: "发音已替换", code: "SPEECH_CANCELLED")
            self.job = id; self.pending = call; self.gain = volume
            self.targetLufs = target
            if call.getBool("muted") == true { self.gain = 0; self.targetLufs = nil }
            let utterance = AVSpeechUtterance(string: text)
            let lang = call.getString("lang") ?? "en-US"
            let voiceID = call.getString("voiceURI") ?? ""
            let selected = voiceID.isEmpty ? nil : AVSpeechSynthesisVoice(identifier: voiceID)
            guard let voice = selected ?? AVSpeechSynthesisVoice(language: lang) else {
                self.finish(error: "此语言没有可用的系统音色，请先安装语音包", code: "SPEECH_VOICE"); return
            }
            utterance.voice = voice
            utterance.rate = AVSpeechUtteranceDefaultSpeechRate
            utterance.pitchMultiplier = 1
            utterance.volume = 1 // Always synthesize full scale; apply gain to the resulting PCM.
            let synth = AVSpeechSynthesizer()
            synth.usesApplicationAudioSession = false
            self.synthesizer = synth
            let watchdog = DispatchWorkItem { [weak self] in
                guard let self = self, self.job == id else { return }
                self.finish(error: "原生发音超时，请重试", code: "SPEECH_TIMEOUT")
            }
            self.watchdog = watchdog
            DispatchQueue.main.asyncAfter(deadline: .now() + 45, execute: watchdog)
            synth.write(utterance) { [weak self] buffer in
                // AVFoundation may reuse the supplied buffer. Copy it before crossing queues.
                guard let pcm = buffer as? AVAudioPCMBuffer else {
                    DispatchQueue.main.async {
                        guard let self = self, self.job == id else { return }
                        self.finish(error: "此音色无法生成音频，请更换声音", code: "SPEECH_FORMAT")
                    }
                    return
                }
                let count = Int(pcm.frameLength), channelCount = Int(pcm.format.channelCount)
                let sampleRate = pcm.format.sampleRate
                let copied = Self.copySamples(pcm)
                DispatchQueue.main.async {
                    guard let self = self, self.job == id else { return }
                    if count == 0 { self.playRendered(id: id); return }
                    guard let copied = copied, sampleRate.isFinite, sampleRate >= 8000, sampleRate <= 192000,
                          channelCount > 0, channelCount <= 2,
                          (self.samples.isEmpty || (self.rate == sampleRate && self.channels == channelCount)),
                          self.samples.count + copied.count <= Int(sampleRate) * channelCount * 30 else {
                        self.finish(error: "合成音频格式无效或过长", code: "SPEECH_FORMAT"); return
                    }
                    self.rate = sampleRate; self.channels = channelCount
                    self.samples.append(contentsOf: copied)
                }
            }
        }
    }

    private static func copySamples(_ pcm: AVAudioPCMBuffer) -> [Float]? {
        let frames = Int(pcm.frameLength), channels = Int(pcm.format.channelCount)
        guard frames > 0 else { return [] }
        guard channels > 0, channels <= 2, frames <= 192000 * 30 else { return nil }
        var out = [Float](); out.reserveCapacity(frames * channels)
        for frame in 0..<frames {
            for channel in 0..<channels {
                let plane = pcm.format.isInterleaved ? 0 : channel
                let index = pcm.format.isInterleaved ? frame * channels + channel : frame
                if let data = pcm.floatChannelData { out.append(data[plane][index]) }
                else if let data = pcm.int16ChannelData { out.append(Float(data[plane][index]) / 32768) }
                else if let data = pcm.int32ChannelData { out.append(Float(data[plane][index]) / 2147483648) }
                else { return nil }
            }
        }
        return out
    }

    private func playRendered(id: String) {
        guard job == id, player == nil else { return }
        do {
            let wav = try SpeechPCM.wav(samples, sampleRate: rate, channels: channels, gain: gain, targetLufs: targetLufs)
            samples.removeAll(keepingCapacity: false)
            let output = try AVAudioPlayer(data: wav)
            output.delegate = self; output.volume = 1
            try PlaybackSession.activate()
            player = output
            guard output.play() else { throw SpeechPCM.Failure.invalidFormat }
            notifyListeners("stateChanged", data: ["id": id, "state": "playing"])
        } catch {
            finish(error: "原生发音播放失败，请重试或更换声音", code: "SPEECH_PLAYBACK")
        }
    }

    @objc func cancel(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            // A late stop from an old card must never cancel its replacement.
            if call.getString("id") == self.job { self.finish(error: "发音已停止", code: "SPEECH_CANCELLED") }
            call.resolve()
        }
    }

    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        guard player === self.player else { return }
        finish(error: flag ? nil : "原生发音未能完成", code: "SPEECH_PLAYBACK")
    }
    func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        guard player === self.player else { return }
        finish(error: "原生发音解码失败", code: "SPEECH_PLAYBACK")
    }

    private func finish(error: String? = nil, code: String = "SPEECH_CANCELLED") {
        let call = pending
        job = ""; pending = nil
        watchdog?.cancel(); watchdog = nil
        let synth = synthesizer; synthesizer = nil
        player?.delegate = nil; player?.stop(); player = nil
        synth?.stopSpeaking(at: .immediate)
        samples.removeAll(keepingCapacity: false); rate = 0; channels = 0
        targetLufs = nil; gain = 1
        if let error = error { call?.reject(error, code) } else { call?.resolve() }
        // Do not deactivate the shared session: the main lesson may immediately resume.
    }
}
