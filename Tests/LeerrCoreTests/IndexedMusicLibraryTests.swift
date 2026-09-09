import Foundation
import Testing
@testable import LeerrCore

private let bridgeArtist = "10000000-0000-0000-0000-000000000001"
private let bridgeGroup = "20000000-0000-0000-0000-000000000001"
private let bridgeRelease = "30000000-0000-0000-0000-000000000001"
private let bridgeUnknown = "30000000-0000-0000-0000-000000000002"

private struct BridgeServer: MusicServer {
    var values: [Album]
    func connect() async throws {}
    func albums(offset: Int, limit: Int) async throws -> [Album] { offset == 0 ? values : [] }
    func searchAlbums(query: String, offset: Int, limit: Int) async throws -> [Album] { [] }
    func tracks(in albumID: String) async throws -> [Track] { [] }
    func originalStreamURL(for trackID: String) async throws -> URL { throw CancellationError() }
}

private actor BridgeResolver {
    var calls: [String] = []
    func resolve(_ id: String) -> String? {
        calls.append(id)
        return id == bridgeRelease ? bridgeGroup : nil
    }
}

@Test func bridgeCachesEditionMappingsAndUnresolvedWithinAccountOnly() async throws {
    let resolver = BridgeResolver()
    let server = BridgeServer(values: [
        Album(id: "a", title: "Same", artist: "A", releaseMBID: bridgeRelease),
        Album(id: "b", title: "Same", artist: "A", releaseMBID: bridgeRelease),
        Album(id: "c", title: "Same", artist: "A", releaseMBID: bridgeUnknown),
        Album(id: "d", title: "Same", artist: "A"),
    ])
    let bridge = IndexedMusicLibrary(server: server, resolveRelease: { await resolver.resolve($0) })
    let first = try await bridge.albums()
    #expect(first.map(\.releaseGroupMBID) == [bridgeGroup, bridgeGroup, nil, nil])
    _ = try await bridge.albums()
    #expect(await resolver.calls == [bridgeRelease, bridgeUnknown])
    let otherAccount = IndexedMusicLibrary(server: server, resolveRelease: { await resolver.resolve($0) })
    _ = try await otherAccount.albums()
    #expect(await resolver.calls.count == 4)
}

@Test func exactIndexedEditionDoesNotDependOnMusicBrainzAvailability() async throws {
    let bridge = IndexedMusicLibrary(server: BridgeServer(values: [
        Album(id: "indexed", title: "Tag differs", artist: "Tag differs", releaseMBID: bridgeRelease),
    ]), resolveRelease: { _ in throw DiscoveryError.unavailable })
    let identity = try ConfirmedAlbumIdentity(artistMBID: bridgeArtist, releaseGroupMBID: bridgeGroup,
        releaseMBID: bridgeRelease, title: "Confirmed", artist: "Artist", confirmed: true)
    #expect(try await bridge.indexedAlbumID(for: identity) == "indexed")
    let wrong = try ConfirmedAlbumIdentity(artistMBID: bridgeArtist, releaseGroupMBID: bridgeGroup,
        releaseMBID: bridgeUnknown, title: "Tag differs", artist: "Tag differs", confirmed: true)
    #expect(try await bridge.indexedAlbumID(for: wrong) == nil)
    await #expect(throws: DiscoveryError.unavailable) { try await bridge.albums() }
}

@Test func explicitGroupTagsNeedNoLookupAndConflictingEditionCannotMatch() async throws {
    let bridge = IndexedMusicLibrary(server: BridgeServer(values: [
        Album(id: "conflicting", title: "Same", artist: "A", releaseGroupMBID: bridgeUnknown, releaseMBID: bridgeRelease),
        Album(id: "group-only", title: "Same", artist: "A", releaseGroupMBID: bridgeGroup),
    ]), resolveRelease: { _ in throw DiscoveryError.unavailable })
    #expect(try await bridge.albums().map(\.releaseGroupMBID) == [bridgeUnknown, bridgeGroup])
    let exact = try ConfirmedAlbumIdentity(artistMBID: bridgeArtist, releaseGroupMBID: bridgeGroup,
        releaseMBID: bridgeRelease, title: "Same", artist: "A", confirmed: true)
    #expect(try await bridge.indexedAlbumID(for: exact) == nil)
    let group = try ConfirmedAlbumIdentity(artistMBID: bridgeArtist, releaseGroupMBID: bridgeGroup,
        releaseMBID: nil, title: "Different", artist: "B", confirmed: true)
    #expect(try await bridge.indexedAlbumID(for: group) == "group-only")
}
