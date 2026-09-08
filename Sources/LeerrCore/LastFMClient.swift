import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Read-only public API. Credentials are supplied per operation and never cached.
public struct LastFMClient: Sendable {
    private let transport: any DiscoveryTransport

    public init(transport: any DiscoveryTransport = DiscoveryURLSessionTransport()) {
        self.transport = transport
    }

    /// A bounded recommendation pass: 3 listening seeds, 2 similar artists each,
    /// 3 catalog albums each. No claim of Last.fm's authenticated recommendations API.
    public func discover(username: String, apiKey: String) async throws -> [DiscoveryCandidate] {
        guard !username.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw DiscoveryError.invalidConfiguration
        }
        let seeds: TopArtists = try await call("user.getTopArtists", apiKey: apiKey,
                                             parameters: ["user": username, "period": "3month", "limit": "3"])
        var candidates: [DiscoveryCandidate] = []
        var seenArtists = Set<String>()
        for seed in seeds.topartists.artist.prefix(3) {
            let similar: SimilarArtists = try await call("artist.getSimilar", apiKey: apiKey,
                                                        parameters: ["artist": seed.name, "limit": "2"])
            for artist in similar.similarartists.artist.prefix(2) {
                guard seenArtists.insert(artist.name.lowercased()).inserted else { continue }
                let albums: TopAlbums = try await call("artist.getTopAlbums", apiKey: apiKey,
                                                       parameters: ["artist": artist.name, "limit": "3"])
                for album in albums.topalbums.album.prefix(3) where !album.name.isEmpty && album.name != "(null)" {
                    let identity: DiscoveryIdentity = album.mbid.flatMap(canonicalMBID)
                        .map { .release(mbid: $0) } ?? .nameOnly
                    candidates.append(DiscoveryCandidate(title: album.name, artist: album.artist?.name ?? artist.name,
                                                         identity: identity, reason: "Similar to \(seed.name)"))
                }
            }
        }
        return DiscoveryFilter.candidates(candidates)
    }

    private func call<T: Decodable>(_ method: String, apiKey: String, parameters: [String: String]) async throws -> T {
        var url = URLComponents(string: "https://ws.audioscrobbler.com/2.0/")!
        url.queryItems = (["method": method, "api_key": apiKey, "format": "json"].merging(parameters) { a, _ in a })
            .sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) }
        // Form-style query parsers interpret a literal '+' as a space.
        url.percentEncodedQuery = url.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
        var request = URLRequest(url: url.url!)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let data = try await discoveryData(request, transport: transport)
        let envelope = try discoveryDecode(ErrorEnvelope.self, from: data)
        if let code = envelope.error {
            switch code {
            case 4, 9, 10, 26: throw DiscoveryError.authentication
            case 29: throw DiscoveryError.rateLimited
            case 6, 7: throw DiscoveryError.notFound
            default: throw DiscoveryError.unavailable
            }
        }
        return try discoveryDecode(T.self, from: data)
    }

    private struct ErrorEnvelope: Decodable { let error: Int? }
    private struct Artist: Decodable { let name: String }
    private struct ArtistList: Decodable {
        let artist: [Artist]
        enum CodingKeys: CodingKey { case artist }
        init(from decoder: any Decoder) throws {
            artist = try decoder.container(keyedBy: CodingKeys.self).decodeIfPresent([Artist].self, forKey: .artist) ?? []
        }
    }
    private struct TopArtists: Decodable { let topartists: ArtistList }
    private struct SimilarArtists: Decodable { let similarartists: ArtistList }
    private struct AlbumDTO: Decodable { let name: String; let mbid: String?; let artist: Artist? }
    private struct AlbumList: Decodable {
        let album: [AlbumDTO]
        enum CodingKeys: CodingKey { case album }
        init(from decoder: any Decoder) throws {
            album = try decoder.container(keyedBy: CodingKeys.self).decodeIfPresent([AlbumDTO].self, forKey: .album) ?? []
        }
    }
    private struct TopAlbums: Decodable { let topalbums: AlbumList }
}
