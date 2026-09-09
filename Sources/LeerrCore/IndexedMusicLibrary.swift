import Foundation

/// Account-owned identity bridge for any music server. Prefer explicit groups;
/// resolve edition-only tags through MusicBrainz when necessary. Cache only
/// public identity mappings, never stream URLs.
public actor IndexedMusicLibrary: AcquisitionLibrary {
    private let inventory: LibraryInventory
    private let resolveRelease: @Sendable (String) async throws -> String?
    private var groups: [String: String] = [:]
    private var unresolved: Set<String> = []

    public init(server: any MusicServer,
                resolveRelease: @escaping @Sendable (String) async throws -> String? = { release in
                    let client = try MusicBrainzClient(userAgent: "Leerr/0.1 (https://ampcode.com/@maxpw/leerr)")
                    return try await client.releaseGroup(forReleaseMBID: release)?.id
                }) {
        inventory = LibraryInventory(server: server)
        self.resolveRelease = resolveRelease
    }

    public func albums() async throws -> [Album] {
        let raw = try await inventory.albums()
        var result: [Album] = []
        for album in raw {
            try Task.checkCancellation()
            var group = album.releaseGroupMBID.flatMap(canonicalMBID)
            if group == nil, let release = album.releaseMBID.flatMap(canonicalMBID) {
                if groups[release] == nil, !unresolved.contains(release) {
                    let resolved = try await resolveRelease(release)
                    try Task.checkCancellation()
                    if let resolved = resolved.flatMap(canonicalMBID) { groups[release] = resolved }
                    else { unresolved.insert(release) }
                }
                group = groups[release]
            }
            result.append(Album(id: album.id, title: album.title, artist: album.artist,
                releaseGroupMBID: group, releaseMBID: album.releaseMBID))
        }
        return result
    }

    public func indexedAlbumID(for identity: ConfirmedAlbumIdentity) async throws -> String? {
        // An exact edition ID already fixes its group; no title/name inference.
        // Conflicting explicit group metadata fails closed.
        if let release = identity.releaseMBID {
            return try await inventory.albums().first {
                $0.releaseMBID?.lowercased() == release &&
                    ($0.releaseGroupMBID == nil || $0.releaseGroupMBID?.lowercased() == identity.releaseGroupMBID)
            }?.id
        }
        return LibraryInventory.album(in: try await albums(), releaseGroupMBID: identity.releaseGroupMBID)?.id
    }
}
