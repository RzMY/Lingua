import Foundation

/// Encode an attenuated copy. Playback never relies on AVSpeechUtterance.volume.
enum SpeechPCM {
    enum Failure: Error { case invalidFormat, invalidSamples }

    static func wav(_ samples: [Float], sampleRate: Double, channels: Int, gain: Double) throws -> Data {
        guard sampleRate.isFinite, sampleRate >= 8000, sampleRate <= 192000,
              channels > 0, channels <= 2, !samples.isEmpty, samples.count % channels == 0,
              samples.count <= Int(sampleRate) * channels * 30,
              gain.isFinite, gain >= 0, gain <= 1 else { throw Failure.invalidFormat }
        var data = Data(capacity: 44 + samples.count * 2)
        func tag(_ value: String) { data.append(contentsOf: value.utf8) }
        func u16(_ value: UInt16) {
            var little = value.littleEndian
            withUnsafeBytes(of: &little) { data.append(contentsOf: $0) }
        }
        func u32(_ value: UInt32) {
            var little = value.littleEndian
            withUnsafeBytes(of: &little) { data.append(contentsOf: $0) }
        }
        let bytes = UInt32(samples.count * 2), rate = UInt32(sampleRate.rounded())
        tag("RIFF"); u32(36 + bytes); tag("WAVE"); tag("fmt "); u32(16)
        u16(1); u16(UInt16(channels)); u32(rate); u32(rate * UInt32(channels * 2))
        u16(UInt16(channels * 2)); u16(16); tag("data"); u32(bytes)
        for sample in samples {
            guard sample.isFinite else { throw Failure.invalidSamples }
            let scaled = max(-1, min(1, Double(sample) * gain))
            let pcm = Int16((scaled * (scaled < 0 ? 32768 : 32767)).rounded())
            u16(UInt16(bitPattern: pcm))
        }
        return data
    }
}
