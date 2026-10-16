import Foundation

/// K-weighted, gated loudness matching; playback never relies on utterance.volume.
enum SpeechPCM {
    enum Failure: Error { case invalidFormat, invalidSamples }

    // Same BS.1770 filters and 400 ms / 100 ms gates as web/js/audio-loudness.js.
    private struct Filter {
        let b0: Double, b1: Double, b2: Double, a1: Double, a2: Double
        var z1 = 0.0, z2 = 0.0
        init(sampleRate: Double, frequency: Double, q: Double, shelf: Bool) {
            let k = tan(.pi * frequency / sampleRate), a0 = 1 + k / q + k * k
            let vh = pow(10.0, 3.999843853973347 / 20), vb = pow(vh, 0.4996667741545416)
            b0 = shelf ? (vh + vb * k / q + k * k) / a0 : 1
            b1 = shelf ? 2 * (k * k - vh) / a0 : -2
            b2 = shelf ? (vh - vb * k / q + k * k) / a0 : 1
            a1 = 2 * (k * k - 1) / a0; a2 = (1 - k / q + k * k) / a0
        }
        mutating func process(_ value: Double) -> Double {
            let output = b0 * value + z1
            z1 = b1 * value - a1 * output + z2; z2 = b2 * value - a2 * output
            return output
        }
    }

    static func loudness(_ samples: [Float], sampleRate: Double, channels: Int) throws -> Double {
        try validate(samples, sampleRate: sampleRate, channels: channels)
        var shelves = (0..<channels).map { _ in Filter(sampleRate: sampleRate, frequency: 1681.974450955533,
                                                      q: 0.7071752369554196, shelf: true) }
        var highpasses = (0..<channels).map { _ in Filter(sampleRate: sampleRate, frequency: 38.13547087602444,
                                                         q: 0.5003270373238773, shelf: false) }
        let window = Int((sampleRate * 0.4).rounded()), hop = Int((sampleRate * 0.1).rounded())
        var ring = [Double](repeating: 0, count: window), sum = 0.0, blocks = [Double]()
        let frames = samples.count / channels
        for frame in 0..<frames {
            var energy = 0.0
            for channel in 0..<channels {
                let sample = Double(samples[frame * channels + channel])
                let weighted = highpasses[channel].process(shelves[channel].process(sample))
                energy += weighted * weighted
            }
            let at = frame % window
            sum += energy - ring[at]; ring[at] = energy
            if frame + 1 >= window && (frame + 1 - window) % hop == 0 {
                blocks.append(max(0, sum / Double(window)))
            }
        }
        if frames < window { blocks = [max(0, sum / Double(frames))] }
        let absolute = pow(10.0, (-70 + 0.691) / 10)
        let audible = blocks.filter { $0 >= absolute }
        guard !audible.isEmpty else { return -.infinity }
        let threshold = max(absolute, audible.reduce(0, +) / Double(audible.count) * 0.1)
        let gated = audible.filter { $0 >= threshold }
        return -0.691 + 10 * log10(gated.reduce(0, +) / Double(gated.count))
    }

    private static func validate(_ samples: [Float], sampleRate: Double, channels: Int) throws {
        guard sampleRate.isFinite, sampleRate >= 8000, sampleRate <= 192000,
              channels > 0, channels <= 2, !samples.isEmpty, samples.count % channels == 0,
              samples.count <= Int(sampleRate) * channels * 30 else { throw Failure.invalidFormat }
        guard samples.allSatisfy({ $0.isFinite }) else { throw Failure.invalidSamples }
    }

    static func wav(_ samples: [Float], sampleRate: Double, channels: Int, gain: Double, targetLufs: Double? = nil) throws -> Data {
        try validate(samples, sampleRate: sampleRate, channels: channels)
        guard gain.isFinite, gain >= 0, gain <= 1 else { throw Failure.invalidFormat }
        var appliedGain = gain
        if let target = targetLufs {
            guard target.isFinite, target >= -100, target <= 0 else { throw Failure.invalidFormat }
            let measured = try loudness(samples, sampleRate: sampleRate, channels: channels)
            let peak = samples.reduce(0.0) { max($0, abs(Double($1))) }
            // Allow up to +12 dB of boost, and keep sample peaks below -1 dBFS.
            appliedGain = measured.isFinite && peak > 0
                ? min(pow(10.0, (target - measured) / 20), 4, pow(10.0, -1 / 20) / peak) : 0
        }
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
            let scaled = max(-1, min(1, Double(sample) * appliedGain))
            let pcm = Int16((scaled * (scaled < 0 ? 32768 : 32767)).rounded())
            u16(UInt16(bitPattern: pcm))
        }
        return data
    }
}
