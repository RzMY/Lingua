import Foundation

@main struct SpeechPCMTests {
    static func pcm(_ wav: Data) -> [Double] {
        let bytes = [UInt8](wav)
        precondition(String(bytes: bytes[0..<4], encoding: .ascii) == "RIFF")
        precondition(String(bytes: bytes[36..<40], encoding: .ascii) == "data")
        return stride(from: 44, to: bytes.count, by: 2).map { index in
            Double(Int16(bitPattern: UInt16(bytes[index]) | UInt16(bytes[index + 1]) << 8)) / 32768
        }
    }
    static func rms(_ samples: [Double]) -> Double {
        sqrt(samples.reduce(0) { $0 + $1 * $1 } / Double(samples.count))
    }
    static func rejected(_ action: () throws -> Data) {
        do { _ = try action(); fatalError("Expected invalid audio to be rejected") } catch {}
    }
    static func tone(_ amplitude: Double, rate: Int = 16000, seconds: Double = 2, frequency: Double = 1000) -> [Float] {
        (0..<Int(Double(rate) * seconds)).map { Float(sin(Double($0) * 2 * .pi * frequency / Double(rate)) * amplitude) }
    }
    static func measured(_ samples: [Float], rate: Double = 16000, channels: Int = 1) throws -> Double {
        try SpeechPCM.loudness(samples, sampleRate: rate, channels: channels)
    }
    static func main() throws {
        let source = (0..<16000).map { Float(sin(Double($0) * 2 * .pi * 440 / 16000) * 0.6) }
        let full = try SpeechPCM.wav(source, sampleRate: 16000, channels: 1, gain: 1)
        let baseline = rms(pcm(full))
        // Check real encoded amplitudes over repeated calls, not an utterance.volume mock.
        for gain in [0.5, 0.5, 0.1, 0.8, 0.1, 0.5] {
            let encoded = try SpeechPCM.wav(source, sampleRate: 16000, channels: 1, gain: gain)
            precondition(encoded.count == full.count)
            precondition(abs(rms(pcm(encoded)) - baseline * gain) < 2 / 32768)
        }
        let muted = try pcm(SpeechPCM.wav(source, sampleRate: 16000, channels: 1, gain: 0))
        precondition(muted.allSatisfy { $0 == 0 })
        let stereo = try SpeechPCM.wav([0.5, -0.25, 0.25, -0.5], sampleRate: 48000, channels: 2, gain: 0.5)
        let decoded = pcm(stereo)
        for (sample, expected) in zip(decoded, [0.25, -0.125, 0.125, -0.25]) {
            precondition(abs(sample - expected) < 1 / 32768)
        }
        let clipped = try pcm(SpeechPCM.wav([2, -2], sampleRate: 16000, channels: 1, gain: 1))
        precondition(clipped[0] <= 1 && clipped[1] == -1)
        rejected { try SpeechPCM.wav([.nan], sampleRate: 16000, channels: 1, gain: 0.5) }
        rejected { try SpeechPCM.wav([1], sampleRate: 16000, channels: 2, gain: 0.5) }
        rejected { try SpeechPCM.wav([], sampleRate: 16000, channels: 1, gain: 0.5) }
        for gain in [Double.nan, .infinity, -0.1, 1.1] {
            rejected { try SpeechPCM.wav(source, sampleRate: 16000, channels: 1, gain: gain) }
        }
        // Same published 1 kHz loudness anchor as the streaming JavaScript meter.
        for rate in [16000, 44100, 48000] {
            let input = tone(0.1, rate: rate)
            let level = try measured(input, rate: Double(rate))
            precondition(abs(level - (-23.0036)) < 0.06)
            let stereoTone = input.flatMap { [$0, $0] }
            let stereoLevel = try measured(stereoTone, rate: Double(rate), channels: 2)
            precondition(abs(stereoLevel - level - 10 * log10(2.0)) < 0.00001)
        }
        // Different synthesized voice amplitudes reach the same actual encoded loudness.
        for amplitude in [0.06, 0.1, 0.4, 0.1, 0.06] {
            let rendered = try pcm(SpeechPCM.wav(tone(amplitude), sampleRate: 16000, channels: 1,
                                                gain: 0.5, targetLufs: -18.13189)).map { Float($0) }
            let level = try measured(rendered)
            precondition(abs(level - (-18.13189)) < 0.01)
        }
        let normal = tone(0.1)
        let padded = [Float](repeating: 0, count: 80000) + normal + tone(0.0005, seconds: 8)
        let paddedLevel = try measured(padded), normalLevel = try measured(normal)
        precondition(abs(paddedLevel - normalLevel) < 0.7)
        let shortLevel = try measured(tone(0.1, seconds: 0.08))
        precondition(shortLevel.isFinite)
        let silent = [Float](repeating: 0, count: 16000)
        let silentLevel = try measured(silent)
        precondition(silentLevel == -.infinity)
        let silentOutput = try pcm(SpeechPCM.wav(silent, sampleRate: 16000, channels: 1, gain: 1, targetLufs: -18))
        precondition(silentOutput.allSatisfy { $0 == 0 })
        var spiky = tone(0.01); spiky[5000] = 0.9
        let protected = try pcm(SpeechPCM.wav(spiky, sampleRate: 16000, channels: 1, gain: 1, targetLufs: -10))
        precondition(protected.allSatisfy { abs($0) <= pow(10.0, -1 / 20) + 1 / 32768 })
        let quiet = tone(0.001)
        let boosted = try pcm(SpeechPCM.wav(quiet, sampleRate: 16000, channels: 1, gain: 1, targetLufs: -10))
        precondition(rms(boosted) <= rms(quiet.map { Double($0) }) * 4 + 1 / 32768)
        for target in [Double.nan, .infinity, -101, 1] {
            rejected { try SpeechPCM.wav(normal, sampleRate: 16000, channels: 1, gain: 1, targetLufs: target) }
        }
        // Read the shipped reference itself, so changes to the asset cannot drift from the target.
        if CommandLine.arguments.count > 1 {
            let reference = try pcm(Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))).map { Float($0) }
            let referenceLevel = try measured(reference)
            precondition(abs(referenceLevel - (-18.13189)) < 0.00001)
        }
        print("Speech PCM: gain, gated loudness matching, channel weighting, short speech, silence and peak protection passed")
    }
}
