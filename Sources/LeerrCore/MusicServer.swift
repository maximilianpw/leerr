import Foundation

/// IDs are opaque and scoped to the configured server, not global release identities.
public struct Album: Identifiable, Equatable, Sendable {
    public let id: String
    public let title: String
    public let artist: String

    public init(id: String, title: String, artist: String) {
        self.id = id
        self.title = title
        self.artist = artist
    }
}

public struct Track: Identifiable, Equatable, Sendable {
    public let id: String
    public let title: String
    public let artist: String
    public let duration: TimeInterval?

    public init(id: String, title: String, artist: String, duration: TimeInterval?) {
        self.id = id
        self.title = title
        self.artist = artist
        self.duration = duration
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
