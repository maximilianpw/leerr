import Foundation

/// Library metadata and observations of delivered media are independent evidence.
/// Neither an original-stream request nor decoded PCM proves original delivery.
public struct PlaybackQuality: Equatable, Sendable {
    public struct Format: Equatable, Sendable {
        public let codec: String?
        public let sampleRate: Double?
        public let bitDepth: Int?

        public init(codec: String? = nil, sampleRate: Double? = nil, bitDepth: Int? = nil) {
            self.codec = codec.flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0 }
            self.sampleRate = sampleRate.flatMap { $0.isFinite && $0 > 0 ? $0 : nil }
            self.bitDepth = bitDepth.flatMap { $0 > 0 ? $0 : nil }
        }

        public var description: String {
            [codec ?? "codec unknown",
             sampleRate.map { "\($0.formatted(.number.precision(.fractionLength(0...3)))) Hz" } ?? "sample rate unknown",
             bitDepth.map { "\($0)-bit" } ?? "bit depth unknown"].joined(separator: ", ")
        }
    }

    public let source: Format?
    public let delivered: Format?

    public init(source: Format? = nil, delivered: Format? = nil) {
        self.source = source
        self.delivered = delivered
    }

    /// Track fields describe the library source, never the delivered stream.
    public init(track: Track, delivered: Format? = nil) {
        let source = Format(codec: track.sourceCodec, sampleRate: track.sourceSampleRate,
                            bitDepth: track.sourceBitDepth)
        self.source = source == Format() ? nil : source
        self.delivered = delivered
    }

    public var description: String {
        "Source: \(source?.description ?? "unknown"). Delivered: \(delivered?.description ?? "unknown"). Transcoding: unknown. Hardware output: unknown."
    }
}
