import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public protocol MusicBrainzRequestLimiting: Sendable {
    func waitForTurn() async throws
}

/// Shared by live clients. Rechecks after waking so concurrent sleepers cannot burst.
public actor MusicBrainzRateLimiter: MusicBrainzRequestLimiting {
    public static let shared = MusicBrainzRateLimiter()
    private let clock = ContinuousClock()
    private var nextStart: ContinuousClock.Instant?

    public init() {}

    public func waitForTurn() async throws {
        while let nextStart, clock.now < nextStart {
            try await clock.sleep(until: nextStart)
        }
        try Task.checkCancellation()
        nextStart = clock.now.advanced(by: .seconds(1))
    }
}

public struct MusicBrainzClient: Sendable {
    private let transport: any DiscoveryTransport
    private let limiter: any MusicBrainzRequestLimiting
    private let userAgent: String

    /// Use an identifying app/version and contact URL/email, not a generic HTTP agent.
    public init(
        userAgent: String,
        transport: any DiscoveryTransport = DiscoveryURLSessionTransport(),
        limiter: any MusicBrainzRequestLimiting = MusicBrainzRateLimiter.shared
    ) throws {
        guard userAgent.contains("/"), userAgent.contains("("), userAgent.contains(")"),
              userAgent.contains("https://") || userAgent.contains("@"),
              !userAgent.contains("\r"), !userAgent.contains("\n") else {
            throw DiscoveryError.invalidConfiguration
        }
        self.userAgent = userAgent
        self.transport = transport
        self.limiter = limiter
    }

    /// Resolve Navidrome/Last.fm edition IDs. Cache the result (including nil) in
    /// the caller's account-scoped library snapshot, and discard it on account change.
    /// Nil means MusicBrainz returned 404, not that the album is unowned.
    public func releaseGroup(forReleaseMBID releaseMBID: String) async throws -> MusicBrainzReleaseGroup? {
        guard let id = canonicalMBID(releaseMBID) else { throw DiscoveryError.invalidConfiguration }
        do {
            let release: ReleaseDTO = try await get("release/\(id)", ["inc": "release-groups+artist-credits"])
            guard let group = release.releaseGroup else { throw DiscoveryError.invalidResponse }
            return try group.value(fallback: release.artistCredit)
        } catch DiscoveryError.notFound { return nil }
    }

    public func resolve(_ candidate: DiscoveryCandidate, offset: Int = 0) async throws -> DiscoveryResolution {
        guard offset >= 0 else { throw DiscoveryError.invalidConfiguration }
        switch candidate.identity {
        case .release(let id):
            guard let group = try await releaseGroup(forReleaseMBID: id) else { throw DiscoveryError.notFound }
            return DiscoveryResolution(candidate: candidate, releaseGroups: [group], hasMore: false)
        case .releaseGroup(let id):
            let group: GroupDTO = try await get("release-group/\(id)", ["inc": "artist-credits"])
            return DiscoveryResolution(candidate: candidate, releaseGroups: [try group.value()], hasMore: false)
        case .nameOnly:
            guard !candidate.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  !candidate.artist.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                throw DiscoveryError.invalidConfiguration
            }
            let query = "releasegroup:\(quoted(candidate.title)) AND artist:\(quoted(candidate.artist))"
            let page: GroupSearch = try await get("release-group", ["query": query, "limit": "25", "offset": String(offset)])
            guard offset + page.groups.count >= page.count || !page.groups.isEmpty else { throw DiscoveryError.invalidResponse }
            return DiscoveryResolution(candidate: candidate, releaseGroups: try page.groups.map { try $0.value() },
                                       hasMore: offset + page.groups.count < page.count)
        }
    }

    /// Edition selection remains an explicit UI step even if only one edition is returned.
    public func releases(releaseGroupMBID: String, offset: Int = 0) async throws -> MusicBrainzReleasePage {
        guard let id = canonicalMBID(releaseGroupMBID), offset >= 0 else { throw DiscoveryError.invalidConfiguration }
        let page: ReleaseBrowse = try await get("release", ["release-group": id, "inc": "artist-credits+media",
                                                           "limit": "100", "offset": String(offset)])
        let releases = try page.releases.map { try $0.value(groupID: id) }
        let next = offset + page.releases.count
        guard next >= page.count || !page.releases.isEmpty else { throw DiscoveryError.invalidResponse }
        return MusicBrainzReleasePage(releases: releases, nextOffset: next < page.count ? next : nil)
    }

    private func get<T: Decodable>(_ path: String, _ parameters: [String: String]) async throws -> T {
        try Task.checkCancellation()
        do { try await limiter.waitForTurn() }
        catch { throw safeDiscoveryError(error) }
        var components = URLComponents(string: "https://musicbrainz.org/ws/2/\(path)")!
        components.queryItems = (parameters.merging(["fmt": "json"]) { _, b in b }).sorted { $0.key < $1.key }
            .map { URLQueryItem(name: $0.key, value: $0.value) }
        components.percentEncodedQuery = components.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
        var request = URLRequest(url: components.url!)
        request.setValue(userAgent, forHTTPHeaderField: "User-Agent")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        return try discoveryDecode(T.self, from: await discoveryData(request, transport: transport))
    }

    private func quoted(_ value: String) -> String {
        // Escape Lucene syntax as well as percent-encoding the URL query itself.
        let special = Set("+-!(){}[]^\"~*?:\\/&|")
        return "\"" + value.map { special.contains($0) ? "\\\($0)" : String($0) }.joined() + "\""
    }

    private struct ArtistDTO: Decodable { let id: String; let name: String }
    private struct Credit: Decodable { let artist: ArtistDTO }

    private static func artists(_ credits: [Credit]?) throws -> [MusicBrainzArtist] {
        guard let credits, !credits.isEmpty else { throw DiscoveryError.invalidResponse }
        return try credits.map {
            guard let id = canonicalMBID($0.artist.id) else { throw DiscoveryError.invalidResponse }
            return MusicBrainzArtist(id: id, name: $0.artist.name)
        }
    }

    private struct GroupDTO: Decodable {
        let id: String
        let title: String
        let artistCredit: [Credit]?
        let disambiguation: String?
        let primaryType: String?
        let firstReleaseDate: String?
        enum CodingKeys: String, CodingKey {
            case id, title, disambiguation
            case artistCredit = "artist-credit", primaryType = "primary-type", firstReleaseDate = "first-release-date"
        }
        func value(fallback: [Credit]? = nil) throws -> MusicBrainzReleaseGroup {
            guard let id = canonicalMBID(id) else { throw DiscoveryError.invalidResponse }
            return MusicBrainzReleaseGroup(id: id, title: title, artists: try artists(artistCredit ?? fallback),
                                           disambiguation: disambiguation ?? "", primaryType: primaryType,
                                           firstReleaseDate: firstReleaseDate)
        }
    }

    private struct ReleaseDTO: Decodable {
        let id: String
        let title: String
        let artistCredit: [Credit]?
        let releaseGroup: GroupDTO?
        let date: String?
        let country: String?
        let status: String?
        let disambiguation: String?
        let media: [Medium]?
        struct Medium: Decodable { let format: String? }
        enum CodingKeys: String, CodingKey {
            case id, title, date, country, status, disambiguation, media
            case artistCredit = "artist-credit", releaseGroup = "release-group"
        }
        func value(groupID: String) throws -> MusicBrainzRelease {
            guard let id = canonicalMBID(id) else { throw DiscoveryError.invalidResponse }
            return MusicBrainzRelease(id: id, releaseGroupMBID: groupID, title: title, artists: try artists(artistCredit),
                                      date: date, country: country, status: status, disambiguation: disambiguation ?? "",
                                      formats: media?.compactMap(\.format) ?? [])
        }
    }

    private struct GroupSearch: Decodable {
        let count: Int
        let groups: [GroupDTO]
        enum CodingKeys: String, CodingKey { case count; case groups = "release-groups" }
    }
    private struct ReleaseBrowse: Decodable {
        let count: Int
        let releases: [ReleaseDTO]
        enum CodingKeys: String, CodingKey { case count = "release-count", releases }
    }
}
