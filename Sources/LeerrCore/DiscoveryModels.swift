import Foundation

/// Entity type is part of the identity. A release is an edition, not an album group.
public enum DiscoveryIdentity: Hashable, Sendable {
    case releaseGroup(mbid: String)
    case release(mbid: String)
    case nameOnly
}

public struct DiscoveryCandidate: Identifiable, Equatable, Sendable {
    public let title: String
    public let artist: String
    public let identity: DiscoveryIdentity
    public let reason: String

    public init(title: String, artist: String, identity: DiscoveryIdentity = .nameOnly, reason: String = "") {
        self.title = title
        self.artist = artist
        switch identity {
        case .releaseGroup(let id):
            self.identity = canonicalMBID(id).map { .releaseGroup(mbid: $0) } ?? .nameOnly
        case .release(let id):
            self.identity = canonicalMBID(id).map { .release(mbid: $0) } ?? .nameOnly
        case .nameOnly: self.identity = .nameOnly
        }
        self.reason = reason
    }

    public var id: String {
        switch identity {
        case .releaseGroup(let id): return "release-group:\(id)"
        case .release(let id): return "release:\(id)"
        case .nameOnly:
            // Length prefixes avoid delimiter collisions without conflating different artists.
            let artist = normalizedDiscoveryName(artist)
            return "name:\(artist.utf8.count):\(artist)\(normalizedDiscoveryName(title))"
        }
    }

    public var releaseGroupMBID: String? {
        if case .releaseGroup(let mbid) = identity { return mbid }
        return nil
    }
}

/// Stable first-occurrence deduplication. Name similarity never proves ownership.
public enum DiscoveryFilter {
    public static func candidates(
        _ candidates: [DiscoveryCandidate],
        ownedReleaseGroupMBIDs: Set<String> = [],
        requestedReleaseGroupMBIDs: Set<String> = []
    ) -> [DiscoveryCandidate] {
        let excluded = Set(ownedReleaseGroupMBIDs.union(requestedReleaseGroupMBIDs).compactMap(canonicalMBID))
        var seen = Set<String>()
        return candidates.filter {
            if let mbid = $0.releaseGroupMBID, excluded.contains(mbid) { return false }
            return seen.insert($0.id).inserted
        }
    }
}

public struct MusicBrainzArtist: Identifiable, Equatable, Sendable {
    public let id: String
    public let name: String
}

public struct MusicBrainzReleaseGroup: Identifiable, Equatable, Sendable {
    public let id: String
    public let title: String
    public let artists: [MusicBrainzArtist]
    public let disambiguation: String
    public let primaryType: String?
    public let firstReleaseDate: String?
}

public struct MusicBrainzRelease: Identifiable, Equatable, Sendable {
    public let id: String
    public let releaseGroupMBID: String
    public let title: String
    public let artists: [MusicBrainzArtist]
    public let date: String?
    public let country: String?
    public let status: String?
    public let disambiguation: String
    public let formats: [String]
}

/// Search results are choices, never an automatically confirmed acquisition identity.
public struct DiscoveryResolution: Equatable, Sendable {
    public let candidate: DiscoveryCandidate
    public let releaseGroups: [MusicBrainzReleaseGroup]
    public let hasMore: Bool
    public var requiresConfirmation: Bool { true }
}

/// Fetch editions only after choosing a group. Pagination never silently hides ambiguity.
public struct MusicBrainzReleasePage: Equatable, Sendable {
    public let releases: [MusicBrainzRelease]
    public let nextOffset: Int?
}

public enum DiscoveryError: Error, Equatable, Sendable, LocalizedError {
    case invalidConfiguration
    case authentication
    case rateLimited
    case notFound
    case unavailable
    case invalidResponse
    case transport

    public var errorDescription: String? {
        switch self {
        case .invalidConfiguration: "Check the discovery account and service configuration."
        case .authentication: "The discovery service rejected the credentials."
        case .rateLimited: "The discovery service is rate limited. Try again later."
        case .notFound: "The requested music identity was not found."
        case .unavailable: "The discovery service is unavailable. Try again later."
        case .invalidResponse: "The discovery service returned an invalid response."
        case .transport: "Could not connect to the discovery service."
        }
    }
}

func canonicalMBID(_ value: String) -> String? {
    UUID(uuidString: value)?.uuidString.lowercased()
}

private func normalizedDiscoveryName(_ value: String) -> String {
    value.split(whereSeparator: \.isWhitespace).joined(separator: " ").lowercased()
}
