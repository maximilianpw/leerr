import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Navidrome-compatible token authentication. Password stays in memory for fresh salts.
/// No plaintext-authentication fallback. Discard this value when disconnecting.
public struct OpenSubsonicServer: MusicServer {
    private let endpoint: ServerEndpoint
    private let username: String
    private let password: String
    private let transport: any HTTPTransport

    public init(endpoint: ServerEndpoint, username: String, password: String,
                transport: any HTTPTransport = URLSessionHTTPTransport()) {
        self.endpoint = endpoint
        self.username = username
        self.password = password
        self.transport = transport
    }

    public func connect() async throws {
        _ = try await response("ping")
    }

    /// One page, alphabetically by name. Empty pages end enumeration. Limit is 1...500.
    public func albums(offset: Int, limit: Int) async throws -> [Album] {
        try validatePage(offset: offset, limit: limit)
        let result = try await response("getAlbumList2", [
            "type": "alphabeticalByName", "offset": String(offset), "size": String(limit),
        ])
        guard let list = result.albumList2 else { throw MusicServerError.invalidResponse }
        return (list.album ?? []).map(\.model)
    }

    public func searchAlbums(query: String, offset: Int, limit: Int) async throws -> [Album] {
        try validatePage(offset: offset, limit: limit)
        let result = try await response("search3", [
            "query": query, "albumOffset": String(offset), "albumCount": String(limit),
            "artistCount": "0", "songCount": "0",
        ])
        guard let list = result.searchResult3 else { throw MusicServerError.invalidResponse }
        return (list.album ?? []).map(\.model)
    }

    public func tracks(in albumID: String) async throws -> [Track] {
        guard !albumID.isEmpty else { throw MusicServerError.invalidRequest }
        let result = try await response("getAlbum", ["id": albumID])
        guard let album = result.album else { throw MusicServerError.invalidResponse }
        return (album.song ?? []).map {
            Track(id: $0.id, title: $0.title, artist: $0.artist ?? album.artist ?? "",
                  duration: $0.duration,
                  sourceCodec: $0.suffix.flatMap { $0.isEmpty ? nil : $0 },
                  sourceSampleRate: $0.samplingRate.flatMap { $0 > 0 ? $0 : nil },
                  sourceBitDepth: $0.bitDepth.flatMap { $0 > 0 ? $0 : nil })
        }
    }

    /// Contains a reusable credential token: never log or persist. The playback consumer
    /// must independently enforce HTTPS and redirect security; URLSession here does not
    /// govern AVPlayer. Original delivery still requires validation against server policy.
    public func originalStreamURL(for trackID: String) async throws -> URL {
        try Task.checkCancellation()
        guard !trackID.isEmpty else { throw MusicServerError.invalidRequest }
        return try url("stream", ["id": trackID, "format": "raw", "maxBitRate": "0"])
    }

    private func validatePage(offset: Int, limit: Int) throws {
        guard offset >= 0, (1...500).contains(limit) else { throw MusicServerError.invalidRequest }
    }

    private func url(_ method: String, _ parameters: [String: String]) throws -> URL {
        let salt = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
        let token = SubsonicMD5.hex(Data((password + salt).utf8))
        let path = endpoint.baseURL.appendingPathComponent("rest").appendingPathComponent(method + ".view")
        guard var components = URLComponents(url: path, resolvingAgainstBaseURL: false) else {
            throw MusicServerError.invalidRequest
        }
        let auth = ["u": username, "t": token, "s": salt, "v": "1.16.1", "c": "Leerr", "f": "json"]
        components.queryItems = (auth.merging(parameters) { first, _ in first })
            .sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) }
        // Escape '+' too, for servers that interpret query strings as form encoding.
        components.percentEncodedQuery = components.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
        guard let url = components.url else { throw MusicServerError.invalidRequest }
        return url
    }

    private func response(_ method: String, _ parameters: [String: String] = [:]) async throws -> Response {
        try Task.checkCancellation()
        do {
            var request = URLRequest(url: try url(method, parameters))
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
            let envelope: Envelope
            do { envelope = try JSONDecoder().decode(Envelope.self, from: result.data) }
            catch { throw MusicServerError.invalidResponse }
            let response = envelope.response
            switch response.status {
            case "ok":
                guard response.error == nil else { throw MusicServerError.invalidResponse }
                return response
            case "failed":
                guard let code = response.error?.code else { throw MusicServerError.invalidResponse }
                if [40, 41, 42, 43, 44, 50].contains(code) { throw MusicServerError.authentication }
                throw MusicServerError.server(code: code)
            default: throw MusicServerError.invalidResponse
            }
        } catch {
            if Task.isCancelled || error is CancellationError || (error as? URLError)?.code == .cancelled {
                throw CancellationError()
            }
            if let safe = error as? MusicServerError { throw safe }
            throw MusicServerError.transport
        }
    }
}

private struct Envelope: Decodable {
    let response: Response
    enum CodingKeys: String, CodingKey { case response = "subsonic-response" }
}

private struct Response: Decodable {
    let status: String
    let error: ServerFailure?
    let albumList2: AlbumList?
    let searchResult3: AlbumList?
    let album: AlbumTracks?
}
private struct ServerFailure: Decodable { let code: Int }
private struct AlbumList: Decodable { let album: [RemoteAlbum]? }
private struct RemoteAlbum: Decodable {
    let id: String
    let name: String
    let artist: String?
    // Navidrome maps musicBrainzId from MbzAlbumID (a release, NOT a release group).
    // Current Navidrome does not emit musicBrainzReleaseGroupId; accept it only
    // when explicitly supplied by a server. Never derive a group from a release ID.
    let musicBrainzId: String?
    let musicBrainzReleaseGroupId: String?
    var model: Album {
        Album(id: id, title: name, artist: artist ?? "",
              releaseGroupMBID: musicBrainzReleaseGroupId.flatMap { $0.isEmpty ? nil : $0 },
              releaseMBID: musicBrainzId.flatMap { $0.isEmpty ? nil : $0 })
    }
}
private struct AlbumTracks: Decodable {
    let artist: String?
    let song: [RemoteTrack]?
}
private struct RemoteTrack: Decodable {
    let id: String
    let title: String
    let artist: String?
    let duration: Double?
    // Source file extension is a format hint, not verified codec/container delivery.
    let suffix: String?
    let samplingRate: Double?
    let bitDepth: Int?
}

/// RFC 1321 MD5 solely for legacy Subsonic token interoperability, not password storage.
/// Kept dependency-free so the same authentication implementation runs on Linux and Apple.
enum SubsonicMD5 {
    static func hex(_ data: Data) -> String {
        let shifts: [UInt32] = [7,12,17,22, 5,9,14,20, 4,11,16,23, 6,10,15,21]
        let constants: [UInt32] = (1...64).map { UInt32(abs(sin(Double($0))) * 4_294_967_296) }
        var bytes = Array(data)
        let bitCount = UInt64(bytes.count) &* 8
        bytes.append(0x80)
        while bytes.count % 64 != 56 { bytes.append(0) }
        for shift in stride(from: 0, to: 64, by: 8) { bytes.append(UInt8(truncatingIfNeeded: bitCount >> shift)) }
        var state: [UInt32] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476]
        for start in stride(from: 0, to: bytes.count, by: 64) {
            let words: [UInt32] = (0..<16).map { index in
                let i = start + index * 4
                return UInt32(bytes[i]) | UInt32(bytes[i+1]) << 8 | UInt32(bytes[i+2]) << 16 | UInt32(bytes[i+3]) << 24
            }
            var a = state[0], b = state[1], c = state[2], d = state[3]
            for i in 0..<64 {
                let f: UInt32
                let g: Int
                switch i {
                case 0..<16: f = (b & c) | (~b & d); g = i
                case 16..<32: f = (d & b) | (~d & c); g = (5 * i + 1) % 16
                case 32..<48: f = b ^ c ^ d; g = (3 * i + 5) % 16
                default: f = c ^ (b | ~d); g = (7 * i) % 16
                }
                let sum = a &+ f &+ constants[i] &+ words[g]
                let shift = shifts[(i / 16) * 4 + i % 4]
                let next = b &+ ((sum << shift) | (sum >> (32 - shift)))
                a = d; d = c; c = b; b = next
            }
            state[0] &+= a; state[1] &+= b; state[2] &+= c; state[3] &+= d
        }
        return state.flatMap { word in
            (0..<4).map { UInt8(truncatingIfNeeded: word >> ($0 * 8)) }
        }.map { String(format: "%02x", $0) }.joined()
    }
}
