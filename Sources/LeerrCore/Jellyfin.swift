import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Read-only Jellyfin library access. Tokens stay in memory; stream URLs are secrets.
public actor JellyfinServer: MusicServer {
    private let endpoint: ServerEndpoint
    private let username: String
    private let password: String
    private let deviceID: String
    private let transport: any HTTPTransport
    private var authentication: Authentication?
    private var connection = UUID()

    public init(endpoint: ServerEndpoint, username: String, password: String, deviceID: String,
                transport: any HTTPTransport = URLSessionHTTPTransport()) {
        self.endpoint = endpoint
        self.username = username
        self.password = password
        self.deviceID = deviceID
        self.transport = transport
    }

    public func connect() async throws {
        authentication = nil
        connection = UUID()
        let attempt = connection
        try Task.checkCancellation()
        guard Self.safeID(deviceID), !username.isEmpty, !password.isEmpty else {
            throw MusicServerError.invalidRequest
        }
        var request = URLRequest(url: try url("Users/AuthenticateByName"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(clientAuthorization, forHTTPHeaderField: "Authorization")
        request.httpBody = try JSONEncoder().encode(Credentials(Username: username, Pw: password))
        let result: Authentication = try await response(request)
        guard attempt == connection else { throw CancellationError() }
        guard Self.safeID(result.AccessToken), Self.safeID(result.User.Id) else {
            throw MusicServerError.invalidResponse
        }
        authentication = result
    }

    public func albums(offset: Int, limit: Int) async throws -> [Album] {
        try await albumPage(query: nil, offset: offset, limit: limit)
    }

    public func searchAlbums(query: String, offset: Int, limit: Int) async throws -> [Album] {
        guard !query.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else {
            throw MusicServerError.invalidRequest
        }
        return try await albumPage(query: query, offset: offset, limit: limit)
    }

    private func albumPage(query: String?, offset: Int, limit: Int) async throws -> [Album] {
        guard offset >= 0, (1...500).contains(limit) else { throw MusicServerError.invalidRequest }
        var parameters = ["includeItemTypes": "MusicAlbum", "sortBy": "SortName", "fields": "ProviderIds"]
        parameters["searchTerm"] = query
        return try await items(parameters, offset: offset, limit: limit).Items.map {
            Album(id: $0.Id, title: $0.Name, artist: $0.artist,
                  releaseGroupMBID: $0.ProviderIds?["MusicBrainzReleaseGroup"].flatMap(canonicalMBID),
                  releaseMBID: $0.ProviderIds?["MusicBrainzAlbum"].flatMap(canonicalMBID))
        }
    }

    public func tracks(in albumID: String) async throws -> [Track] {
        guard Self.safeID(albumID) else { throw MusicServerError.invalidRequest }
        let session = connection
        var tracks: [Track] = []
        while true {
            let page = try await items([
                "parentId": albumID, "includeItemTypes": "Audio",
                "sortBy": "ParentIndexNumber,IndexNumber", "fields": "MediaSources,MediaStreams,ProviderIds",
            ], offset: tracks.count, limit: 500)
            guard session == connection else { throw CancellationError() }
            tracks.append(contentsOf: page.Items.map(\.track))
            if page.Items.isEmpty || page.TotalRecordCount.map({ tracks.count >= $0 }) == true { return tracks }
        }
    }

    /// Original-byte request, not evidence of lossless delivery. The player must enforce
    /// HTTPS, no media redirects and range-only loading independently of this adapter.
    public func originalStreamURL(for trackID: String) async throws -> URL {
        try Task.checkCancellation()
        guard Self.safeID(trackID) else { throw MusicServerError.invalidRequest }
        guard let authentication else { throw MusicServerError.authentication }
        return try url("Audio/\(trackID)/stream", ["static": "true", "ApiKey": authentication.AccessToken])
    }

    private func items(_ parameters: [String: String], offset: Int, limit: Int) async throws -> ItemPage {
        try Task.checkCancellation()
        guard let authentication else { throw MusicServerError.authentication }
        let session = connection
        let parameters = parameters.merging([
            "userId": authentication.User.Id, "recursive": "true", "startIndex": String(offset),
            "limit": String(limit), "sortOrder": "Ascending",
        ]) { _, value in value }
        var request = URLRequest(url: try url("Items", parameters))
        request.setValue(clientAuthorization + ",Token=\"\(authentication.AccessToken)\"",
                         forHTTPHeaderField: "Authorization")
        let page: ItemPage = try await response(request)
        guard session == connection else { throw CancellationError() }
        guard page.Items.allSatisfy({ Self.safeID($0.Id) }),
              page.TotalRecordCount.map({ $0 >= 0 && (page.Items.isEmpty || ($0 >= offset && $0 - offset >= page.Items.count)) }) ?? true else {
            throw MusicServerError.invalidResponse
        }
        return page
    }

    private var clientAuthorization: String {
        "MediaBrowser Client=\"Leerr\",Device=\"Leerr\",DeviceId=\"\(deviceID)\",Version=\"0.1\""
    }

    private static func safeID(_ value: String) -> Bool {
        !value.isEmpty && value.utf8.allSatisfy {
            (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 45 || $0 == 95
        }
    }

    private func url(_ path: String, _ parameters: [String: String] = [:]) throws -> URL {
        guard var components = URLComponents(url: endpoint.baseURL.appendingPathComponent(path),
                                             resolvingAgainstBaseURL: false) else {
            throw MusicServerError.invalidRequest
        }
        if !parameters.isEmpty {
            components.queryItems = parameters.sorted { $0.key < $1.key }
                .map { URLQueryItem(name: $0.key, value: $0.value) }
            components.percentEncodedQuery = components.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
        }
        guard let url = components.url else { throw MusicServerError.invalidRequest }
        return url
    }

    private func response<T: Decodable>(_ request: URLRequest) async throws -> T {
        try Task.checkCancellation()
        do {
            var request = request
            request.setValue("application/json", forHTTPHeaderField: "Accept")
            let result = try await transport.send(request)
            try Task.checkCancellation()
            switch result.statusCode {
            case 200..<300: break
            case 401, 403: throw MusicServerError.authentication
            case 300..<400: throw MusicServerError.unsafeRedirect
            case 500..<600: throw MusicServerError.unavailable
            default: throw MusicServerError.server(code: result.statusCode)
            }
            do { return try JSONDecoder().decode(T.self, from: result.data) }
            catch { throw MusicServerError.invalidResponse }
        } catch {
            if Task.isCancelled || error is CancellationError || (error as? URLError)?.code == .cancelled {
                throw CancellationError()
            }
            if let safe = error as? MusicServerError { throw safe }
            throw MusicServerError.transport
        }
    }
}

private struct Credentials: Encodable { let Username: String; let Pw: String }
private struct Authentication: Decodable {
    let AccessToken: String
    let User: UserIdentity
}
private struct UserIdentity: Decodable { let Id: String }
private struct ItemPage: Decodable { let Items: [JellyfinItem]; let TotalRecordCount: Int? }
private struct JellyfinItem: Decodable {
    let Id: String
    let Name: String
    let Artists: [String]?
    let AlbumArtist: String?
    let AlbumArtists: [NamedArtist]?
    let RunTimeTicks: Double?
    let ProviderIds: [String: String]?
    let MediaStreams: [AudioStream]?
    let MediaSources: [MediaSource]?

    var artist: String {
        let artists = (Artists ?? []).filter { !$0.isEmpty }
        if !artists.isEmpty { return artists.joined(separator: ", ") }
        if let AlbumArtist, !AlbumArtist.isEmpty { return AlbumArtist }
        return (AlbumArtists ?? []).compactMap(\.Name).filter { !$0.isEmpty }.joined(separator: ", ")
    }

    var track: Track {
        // Never infer codec from a container, bitrate, or transcoding URL. Do not combine
        // fields from different sources into a format that no source actually has.
        let stream = MediaStreams?.first(where: { $0.Type == "Audio" })
            ?? MediaSources?.lazy.compactMap { $0.MediaStreams?.first(where: { $0.Type == "Audio" }) }.first
        let format = PlaybackQuality.Format(codec: stream?.Codec, sampleRate: stream?.SampleRate,
                                            bitDepth: stream?.BitDepth)
        return Track(id: Id, title: Name, artist: artist,
                     duration: RunTimeTicks.flatMap { $0.isFinite && $0 >= 0 ? $0 / 10_000_000 : nil },
                     sourceCodec: format.codec, sourceSampleRate: format.sampleRate, sourceBitDepth: format.bitDepth)
    }
}
private struct NamedArtist: Decodable { let Name: String? }
private struct MediaSource: Decodable { let MediaStreams: [AudioStream]? }
private struct AudioStream: Decodable {
    let `Type`: String?
    let Codec: String?
    let SampleRate: Double?
    let BitDepth: Int?
}
