import AVFoundation
import XCTest
@testable import App

final class PlaybackSessionTests: XCTestCase {
    @MainActor
    func testPlaybackRemovesDuckingAndMixingEvenWhenCategoryAndModeAlreadyMatch() throws {
        let audio = AVAudioSession.sharedInstance()
        defer { try? audio.setCategory(.playback, mode: .default, options: []) }
        let residualOptions: [AVAudioSession.CategoryOptions] = [.mixWithOthers, .duckOthers, [.mixWithOthers, .duckOthers]]
        for options in residualOptions {
            try audio.setCategory(.playback, mode: .default, options: options)
            XCTAssertEqual(audio.category, .playback)
            XCTAssertEqual(audio.mode, .default)
            XCTAssertFalse(audio.categoryOptions.isEmpty)
            try PlaybackSession.configure()
            XCTAssertTrue(audio.categoryOptions.isEmpty, "Residual options change the volume without changing category or mode")
        }
    }

    @MainActor
    func testRepeatedSpeechRenderingUsesTheApplicationPlaybackSession() throws {
        let audio = AVAudioSession.sharedInstance()
        defer { try? audio.setActive(false); try? audio.setCategory(.playback, mode: .default, options: []) }
        for _ in 0..<3 {
            // Represent the media category inherited after another output finishes.
            try audio.setCategory(.ambient, mode: .default, options: [])
            let synth = try SpeechAudioPlugin.makeSynthesizer()
            XCTAssertTrue(synth.usesApplicationAudioSession, "System-managed speech creates an independent ducking session")
            XCTAssertEqual(audio.category, .playback)
            XCTAssertEqual(audio.mode, .default)
            XCTAssertTrue(audio.categoryOptions.isEmpty)
            // PCM playback must retain the exact same category and options.
            try PlaybackSession.activate()
            XCTAssertEqual(audio.category, .playback)
            XCTAssertTrue(audio.categoryOptions.isEmpty)
        }
    }
}
