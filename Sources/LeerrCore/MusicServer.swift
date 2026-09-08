import Foundation

/// IDs are opaque and scoped to the configured server, not global release identities.
public struct Album: Identifiable, Equatable, Sendable {
    public let id: String
    public let title: String
    public let artist: String
    public let releaseGroupMBID: String?
    public let releaseMBID: String?

    public init(id: String, title: String, artist: String,
                releaseGroupMBID: String? = nil, releaseMBID: String? = nil) {
        self.id = id
        self.title = title
        self.artist = artist
        self.releaseGroupMBID = releaseGroupMBID
        self.releaseMBID = releaseMBID
    }
}

public struct Track: Identifiable, Equatable, Sendable {
    public let id: String
    public let title: String
    public let artist: String
    public let duration: TimeInterval?
    /// Library metadata only; none of these fields certify delivered bytes.
    public let sourceCodec: String?
    public let sourceSampleRate: Double?
    public let sourceBitDepth: Int?

    public init(id: String, title: String, artist: String, duration: TimeInterval?,
                sourceCodec: String? = nil, sourceSampleRate: Double? = nil,
                sourceBitDepth: Int? = nil) {
        self.id = id
        self.title = title
        self.artist = artist
        self.duration = duration
        self.sourceCodec = sourceCodec
        self.sourceSampleRate = sourceSampleRate
        self.sourceBitDepth = sourceBitDepth
    }
}

/// First-slice boundary. OpenSubsonic DTOs and authentication stay in the adapter.
/// Cancellation propagates to network requests. An empty page ends enumeration.
public protocol MusicServer: Sendable {
    func connect() async throws
    func albums(offset: Int, limit: Int) async throws -> [Album]
    func searchAlbums(query: String, offset: Int, limit: Int) async throws -> [Album]
    func tracks(in albumID: String) async throws -> [Track]

    /// Request an original stream; this does not prove what the server delivers.
    /// The returned URL can contain credentials: never log or persist it.
    func originalStreamURL(for trackID: String) async throws -> URL
}
