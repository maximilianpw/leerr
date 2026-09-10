import Foundation
import Testing
@testable import LeerrCore
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

private actor APIFixture: HTTPTransport {
    var requests: [URLRequest] = []
    let handler: @Sendable (URLRequest) async throws -> HTTPResponse
    init(_ handler: @escaping @Sendable (URLRequest) async throws -> HTTPResponse) { self.handler = handler }
    func send(_ request: URLRequest) async throws -> HTTPResponse { requests.append(request); return try await handler(request) }
}
private func api(_ fixture: APIFixture) throws -> LeerrAPI { LeerrAPI(endpoint: try ServerEndpoint("https://leerr.test/deployed/here"), token: "opaque", transport: fixture) }
private func json(_ value: String, status: Int = 200) -> HTTPResponse { HTTPResponse(data: Data(value.utf8), statusCode: status) }

@Test func leerrLoginAndTypedDecodingUseOriginRoot() async throws {
    let fixture = APIFixture { request in
        #expect(request.url?.path == "/api/v1/sessions")
        #expect(request.value(forHTTPHeaderField: "Authorization") == nil)
        let body = try #require(request.httpBody)
        let object = try #require(JSONSerialization.jsonObject(with: body) as? [String: Any])
        #expect(object["device"] as? String == "native")
        return json(#"{"token":"token","user":{"id":"u","username":"alice","role":"member"},"csrf":null}"#)
    }
    let session = try await LeerrAPI.login(endpoint: try ServerEndpoint("https://leerr.test/subpath"), username: "alice", password: "secret", name: "Phone", transport: fixture)
    #expect(session.token == "token")
    #expect(session.user.username == "alice")
}

@Test func leerrLibraryDecodesPaginationAndMetadata() async throws {
    let fixture = APIFixture { request in
        let components = try #require(URLComponents(url: request.url!, resolvingAgainstBaseURL: false))
        #expect(components.path == "/api/v1/library")
        #expect(components.queryItems?.first { $0.name == "offset" }?.value == "50")
        #expect(components.queryItems?.first { $0.name == "limit" }?.value == "25")
        #expect(components.queryItems?.first { $0.name == "q" }?.value == "a & b")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer opaque")
        return json(#"{"items":[{"id":"a","title":"Album","artist":"Artist","releaseGroupMBID":null,"releaseMBID":"release"}],"total":76}"#)
    }
    let page = try await api(fixture).library(offset: 50, limit: 25, query: "a & b")
    #expect(page.total == 76)
    #expect(page.items == [Album(id: "a", title: "Album", artist: "Artist", releaseMBID: "release")])
}

@Test func leerrRevocationAndUpstreamAuthenticationAreDistinct() async throws {
    let revoked = try api(APIFixture { _ in json(#"{"error":{"code":"session_revoked","message":"secret"}}"#, status: 401) })
    await #expect(throws: LeerrAPIError.authentication) { try await revoked.me() }
    let upstream = try api(APIFixture { _ in json(#"{"error":{"code":"upstream_auth","message":"secret"}}"#, status: 502) })
    await #expect(throws: LeerrAPIError.upstreamAuthentication) { try await upstream.connections() }
}

@Test func leerrCancellationPropagates() async throws {
    let fixture = APIFixture { _ in try await Task.sleep(for: .seconds(30)); return json("{}") }
    let client = try api(fixture)
    let task = Task { try await client.me() }
    task.cancel()
    await #expect(throws: CancellationError.self) { try await task.value }
}

@Test(arguments: [
    "/api/v1/streams/ticket",
    "https://evil.test/api/v1/streams/ticket",
    "//evil.test/api/v1/streams/ticket",
    "/api/v1/streams/a/b",
    "/other/ticket",
    "/api/v1/streams/ticket?token=x",
]) func leerrTicketOnlyAcceptsOpaqueSameOriginEndpoint(path: String) async throws {
    let encoded = try String(data: JSONEncoder().encode(path), encoding: .utf8)!
    let client = try api(APIFixture { request in
        #expect(request.url?.path == "/api/v1/stream-tickets")
        #expect(request.httpMethod == "POST")
        return json("{\"path\":\(encoded),\"expiresAt\":9999999999999}")
    })
    if path == "/api/v1/streams/ticket" {
        #expect(try await client.originalStreamURL(for: "track").absoluteString == "https://leerr.test/api/v1/streams/ticket")
    } else {
        await #expect(throws: LeerrAPIError.invalidResponse) { try await client.originalStreamURL(for: "track") }
    }
}
