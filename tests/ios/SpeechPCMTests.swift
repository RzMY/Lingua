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
        print("Speech PCM: repeated attenuation, mute, stereo, clipping and validation passed")
    }
}
