import Testing
@testable import LeerrCore

@Test func trackMetadataPopulatesOnlySource() {
    let track = Track(id: "source", title: "Fixture", artist: "Artist", duration: 13,
                      sourceCodec: "FLAC", sourceSampleRate: 96_000, sourceBitDepth: 24)
    let quality = PlaybackQuality(track: track)
    #expect(quality.source == .init(codec: "FLAC", sampleRate: 96_000, bitDepth: 24))
    #expect(quality.delivered == nil)
    #expect(quality.description.contains("Delivered: unknown"))
    let observed = PlaybackQuality(track: track, delivered: .init(codec: "AAC", sampleRate: 44_100))
    #expect(observed.source == quality.source)
    #expect(observed.delivered == .init(codec: "AAC", sampleRate: 44_100))
    #expect(observed.delivered?.bitDepth == nil)
}

@Test func absentOrInvalidTrackMetadataStaysUnknown() {
    let absent = Track(id: "absent", title: "Fixture", artist: "Artist", duration: nil)
    #expect(PlaybackQuality(track: absent) == PlaybackQuality())
    let invalid = Track(id: "invalid", title: "Fixture", artist: "Artist", duration: nil,
                        sourceCodec: " ", sourceSampleRate: .nan, sourceBitDepth: 0)
    #expect(PlaybackQuality(track: invalid) == PlaybackQuality())
    let partial = Track(id: "partial", title: "Fixture", artist: "Artist", duration: nil,
                        sourceBitDepth: 16)
    #expect(PlaybackQuality(track: partial).source == .init(bitDepth: 16))
    #expect(PlaybackQuality(track: partial).delivered == nil)
}

@Test func sourceFLACDoesNotCertifyDelivery() {
    let quality = PlaybackQuality(source: .init(codec: "FLAC", sampleRate: 96_000, bitDepth: 24))
    #expect(quality.delivered == nil)
    #expect(quality.description.contains("Delivered: unknown"))
    #expect(!quality.description.lowercased().contains("lossless"))
}

@Test func deliveredFormatRemainsIndependentOfSource() {
    let quality = PlaybackQuality(
        source: .init(codec: "FLAC", sampleRate: 96_000, bitDepth: 24),
        delivered: .init(codec: "AAC", sampleRate: 44_100))
    #expect(quality.source?.bitDepth == 24)
    #expect(quality.delivered?.bitDepth == nil)
    #expect(quality.description.contains("Delivered: AAC"))
    #expect(quality.description.contains("bit depth unknown"))
    #expect(quality.description.contains("Transcoding: unknown"))
    #expect(quality.description.contains("Hardware output: unknown"))
}

@Test func unknownQualityDoesNotInventSourceMetadata() {
    #expect(PlaybackQuality().description == "Source: unknown. Delivered: unknown. Transcoding: unknown. Hardware output: unknown.")
    let observed = PlaybackQuality(delivered: .init(codec: "FLAC", sampleRate: 48_000, bitDepth: 16))
    #expect(observed.source == nil)
    #expect(observed.description.contains("Source: unknown"))
    #expect(observed.description.contains("Delivered: FLAC"))
}

@Test(arguments: [Double.nan, .infinity, -.infinity, 0, -44_100])
func invalidRatesAreUnknown(rate: Double) {
    #expect(PlaybackQuality.Format(sampleRate: rate).sampleRate == nil)
}

@Test func partialAndInvalidFormatsStayHonest() {
    #expect(PlaybackQuality.Format(codec: " \n", bitDepth: -1).description == "codec unknown, sample rate unknown, bit depth unknown")
    #expect(PlaybackQuality.Format(bitDepth: 0).bitDepth == nil)
    let format = PlaybackQuality.Format(sampleRate: 44_100.5, bitDepth: 24)
    #expect(format.sampleRate == 44_100.5)
    #expect(format.bitDepth == 24)
    #expect(format.codec == nil)
}
