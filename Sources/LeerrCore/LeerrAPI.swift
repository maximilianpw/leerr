import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public enum LeerrAPIError: Error, Equatable, Sendable, LocalizedError {
    case authentication
    case upstreamAuthentication
    case forbidden
    case notFound
    case invalidRequest
    case invalidResponse
    case unavailable
    case server(code: String)

    public var errorDescription: String? {
        switch self {
        case .authentication: "Your Leerr session is invalid or has been revoked. Sign in again."
        case .upstreamAuthentication: "A connected service needs to be reconnected."
        case .forbidden: "This account is not allowed to perform that action."
        case .notFound: "The requested item was not found."
        case .invalidRequest: "The request is invalid."
        case .invalidResponse: "Leerr returned an unsupported response."
        case .unavailable: "Leerr is currently unavailable."
        case .server: "Leerr could not complete the request."
        }
    }
}

public struct LeerrUser: Codable, Equatable, Sendable {
    public let id: String
    public let username: String
    public let role: String
}

public struct LeerrSession: Equatable, Sendable {
    public let token: String
    public let user: LeerrUser
}

public struct LeerrConnections: Codable, Equatable, Sendable {
    public let jellyfin: Bool
    public let lastfm: Bool
}

public struct LeerrRequest: Identifiable, Codable, Equatable, Sendable {
    public let id: String
    public let releaseGroupMBID: String
    public let releaseMBID: String
    public let title: String
    public let artist: String
    public let status: String
    public let albumID: String?
}

public struct LeerrResolveItem: Identifiable, Codable, Equatable, Sendable {
    public let id: String
    public let title: String
    public let artist: String
    public let artistMBID: String
}

public struct LeerrEdition: Identifiable, Codable, Equatable, Sendable {
    public let id: String
    public let title: String
    public let date: String?
    public let country: String?
}

/// Typed client for the native shared-server contract. The supplied endpoint may
/// contain a deployment subpath, but API and ticket URLs are always rooted at the
/// HTTPS origin as required by the server contract.
public struct LeerrAPI: MusicServer, Sendable {
    public let origin: URL
    public let token: String
    private let transport: any HTTPTransport

    public init(endpoint: ServerEndpoint, token: String, transport: any HTTPTransport = URLSessionHTTPTransport()) {
        var parts = URLComponents(url: endpoint.baseURL, resolvingAgainstBaseURL: false)!
        parts.path = ""; parts.query = nil; parts.fragment = nil
        self.origin = parts.url!
        self.token = token
        self.transport = transport
    }

    public static func login(endpoint: ServerEndpoint, username: String, password: String,
                             name: String, transport: any HTTPTransport = URLSessionHTTPTransport()) async throws -> LeerrSession {
        struct Body: Encodable { let username: String; let password: String; let device = "native"; let name: String }
        struct Response: Decodable { let token: String; let user: LeerrUser; let csrf: String? }
        let anonymous = LeerrAPI(endpoint: endpoint, token: "", transport: transport)
        let result: Response = try await anonymous.call("sessions", method: "POST", body: Body(username: username, password: password, name: name), authenticated: false)
        guard !result.token.isEmpty else { throw LeerrAPIError.invalidResponse }
        return LeerrSession(token: result.token, user: result.user)
    }

    public func connect() async throws { _ = try await me() }
    public func me() async throws -> LeerrUser { let value: UserEnvelope = try await call("me"); return value.user }
    public func logout() async throws { let _: Empty = try await call("sessions/current", method: "DELETE") }
    public func connections() async throws -> LeerrConnections { try await call("connections") }

    public func albums(offset: Int, limit: Int) async throws -> [Album] {
        try await library(offset: offset, limit: limit, query: nil).items
    }
    public func searchAlbums(query: String, offset: Int, limit: Int) async throws -> [Album] {
        try await library(offset: offset, limit: limit, query: query).items
    }
    public func library(offset: Int, limit: Int, query: String?) async throws -> (items: [Album], total: Int) {
        guard offset >= 0, limit > 0 else { throw LeerrAPIError.invalidRequest }
        var queryItems = [URLQueryItem(name: "offset", value: String(offset)), URLQueryItem(name: "limit", value: String(limit))]
        if let query { queryItems.append(URLQueryItem(name: "q", value: query)) }
        let value: LibraryEnvelope = try await call("library", query: queryItems)
        return (value.items.map(\.model), value.total)
    }
    public func tracks(in albumID: String) async throws -> [Track] {
        let value: AlbumEnvelope = try await call("albums/\(escape(albumID))")
        return value.tracks.map(\.model)
    }
    public func originalStreamURL(for trackID: String) async throws -> URL {
        struct Body: Encodable { let trackID: String }
        let ticket: Ticket = try await call("stream-tickets", method: "POST", body: Body(trackID: trackID))
        guard ticket.expiresAt > 0, let url = URL(string: ticket.path, relativeTo: origin)?.absoluteURL,
              url.scheme?.lowercased() == "https", url.host?.lowercased() == origin.host?.lowercased(),
              (url.port ?? 443) == (origin.port ?? 443), url.user == nil, url.password == nil,
              url.query == nil, url.fragment == nil,
              url.path.hasPrefix("/api/v1/streams/"),
              !url.path.dropFirst("/api/v1/streams/".count).isEmpty,
              !url.path.dropFirst("/api/v1/streams/".count).contains("/") else { throw LeerrAPIError.invalidResponse }
        return url
    }

    public func requests() async throws -> [LeerrRequest] { let value: RequestEnvelope = try await call("requests"); return value.items }
    public func resolve(query: String) async throws -> [LeerrResolveItem] { let value: ResolveEnvelope = try await call("resolve", query: [.init(name: "q", value: query)]); return value.items }
    public func recommendations() async throws -> [LeerrResolveItem] { let value: ResolveEnvelope = try await call("recommendations"); return value.items }
    public func editions(groupID: String) async throws -> [LeerrEdition] { let value: EditionEnvelope = try await call("resolve/\(escape(groupID))/editions"); return value.items }
    public func request(releaseGroupMBID: String, releaseMBID: String, artistMBID: String) async throws {
        struct Body: Encodable { let releaseGroupMBID: String; let releaseMBID: String; let artistMBID: String; let confirmed = true }
        let _: Empty = try await call("requests", method: "POST", body: Body(releaseGroupMBID: releaseGroupMBID, releaseMBID: releaseMBID, artistMBID: artistMBID))
    }

    private func call<Response: Decodable>(_ path: String, method: String = "GET", query: [URLQueryItem] = [], authenticated: Bool = true) async throws -> Response {
        try await call(path, method: method, query: query, bodyData: nil, authenticated: authenticated)
    }
    private func call<Response: Decodable, Body: Encodable>(_ path: String, method: String, body: Body, authenticated: Bool = true) async throws -> Response {
        try await call(path, method: method, query: [], bodyData: try JSONEncoder().encode(body), authenticated: authenticated)
    }
    private func call<Response: Decodable>(_ path: String, method: String, query: [URLQueryItem], bodyData: Data?, authenticated: Bool) async throws -> Response {
        try Task.checkCancellation()
        var parts = URLComponents(url: origin, resolvingAgainstBaseURL: false)!
        parts.path = "/api/v1/" + path
        parts.queryItems = query.isEmpty ? nil : query
        guard let url = parts.url else { throw LeerrAPIError.invalidRequest }
        var request = URLRequest(url: url); request.httpMethod = method; request.httpBody = bodyData
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if bodyData != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        if authenticated { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        let response: HTTPResponse
        do { response = try await transport.send(request) }
        catch is CancellationError { throw CancellationError() }
        catch { throw LeerrAPIError.unavailable }
        try Task.checkCancellation()
        guard (200..<300).contains(response.statusCode) else { throw decodeError(response) }
        if Response.self == Empty.self, response.data.isEmpty { return Empty() as! Response }
        do { return try JSONDecoder().decode(Response.self, from: response.data) }
        catch { throw LeerrAPIError.invalidResponse }
    }
    private func decodeError(_ response: HTTPResponse) -> LeerrAPIError {
        let code = (try? JSONDecoder().decode(ErrorEnvelope.self, from: response.data))?.error.code
        if code == "upstream_auth" { return .upstreamAuthentication }
        if response.statusCode == 401 { return .authentication }
        if response.statusCode == 403 { return .forbidden }
        if response.statusCode == 404 { return .notFound }
        return code.map(LeerrAPIError.server) ?? .invalidResponse
    }
    private func escape(_ value: String) -> String { value.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/?#"))) ?? "" }
}

private struct UserEnvelope: Decodable { let user: LeerrUser }
private struct Empty: Codable {}
private struct ErrorEnvelope: Decodable { struct Detail: Decodable { let code: String; let message: String }; let error: Detail }
private struct AlbumDTO: Decodable { let id, title, artist: String; let releaseGroupMBID, releaseMBID: String?; var model: Album { Album(id: id, title: title, artist: artist, releaseGroupMBID: releaseGroupMBID, releaseMBID: releaseMBID) } }
private struct TrackDTO: Decodable { let id, title, artist: String; let duration: Double?; let sourceCodec: String?; let sourceSampleRate: Double?; let sourceBitDepth: Int?; var model: Track { Track(id: id, title: title, artist: artist, duration: duration, sourceCodec: sourceCodec, sourceSampleRate: sourceSampleRate, sourceBitDepth: sourceBitDepth) } }
private struct LibraryEnvelope: Decodable { let items: [AlbumDTO]; let total: Int }
private struct AlbumEnvelope: Decodable { let album: AlbumDTO; let tracks: [TrackDTO] }
private struct Ticket: Decodable { let path: String; let expiresAt: Double }
private struct RequestEnvelope: Decodable { let items: [LeerrRequest] }
private struct ResolveEnvelope: Decodable { let items: [LeerrResolveItem] }
private struct EditionEnvelope: Decodable { let items: [LeerrEdition] }
