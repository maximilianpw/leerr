import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import Testing
@testable import LeerrCore

private actor Stage1Transport: HTTPTransport {
    var requests: [URLRequest] = []
    let handler: @Sendable (URLRequest) async throws -> HTTPResponse
    init(_ handler: @escaping @Sendable (URLRequest) async throws -> HTTPResponse) { self.handler = handler }
    init(body: String, status: Int = 200) {
        handler = { _ in HTTPResponse(data: Data(body.utf8), statusCode: status) }
    }
    func send(_ request: URLRequest) async throws -> HTTPResponse {
        requests.append(request)
        return try await handler(request)
    }
}

private func stage1Server(_ transport: any HTTPTransport) throws -> OpenSubsonicServer {
    OpenSubsonicServer(endpoint: try ServerEndpoint("https://music.example.test:8443/proxy/navidrome/"),
                      username: "listener+é&", password: "fixture-password", transport: transport)
}

private func stage1Query(_ url: URL) -> [String: String] {
    Dictionary(uniqueKeysWithValues: URLComponents(url: url, resolvingAgainstBaseURL: false)!
        .queryItems!.map { ($0.name, $0.value!) })
}

@Test func stage1PingUsesFreshTokenAndProxyPath() async throws {
    let transport = Stage1Transport(body: #"{"subsonic-response":{"status":"ok","version":"1.16.1"}}"#)
    let server = try stage1Server(transport)
    try await server.connect()
    try await server.connect()
    let requests = await transport.requests
    let first = try #require(requests.first?.url)
    let second = try #require(requests.last?.url)
    #expect(first.path == "/proxy/navidrome/rest/ping.view")
    #expect(first.port == 8443)
    let query = stage1Query(first)
    #expect(query["u"] == "listener+é&")
    #expect(query["p"] == nil)
    #expect(query["v"] == "1.16.1")
    #expect(query["f"] == "json")
    #expect(query["c"] == "Leerr")
    #expect(query["s"]?.count == 32)
    #expect(query["s"] != stage1Query(second)["s"])
    #expect(query["t"] != stage1Query(second)["t"])
    #expect(query["t"] == SubsonicMD5.hex(Data(("fixture-password" + query["s"]!).utf8)))
    #expect(!first.absoluteString.contains("fixture-password"))
    #expect(first.absoluteString.contains("%2B"))
}

@Test(arguments: [
    ("", "d41d8cd98f00b204e9800998ecf8427e"),
    ("abc", "900150983cd24fb0d6963f7d28e17f72"),
    ("message digest", "f96b697d7cb7938d525a2f31aaf161d0"),
    ("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", "d174ab98d277d9f5a5611c2c9f419d9f"),
    ("12345678901234567890123456789012345678901234567890123456789012345678901234567890", "57edf4a22be3c955ac49da2e2107b67a"),
])
func stage1MD5RFC1321Vectors(vector: (String, String)) {
    #expect(SubsonicMD5.hex(Data(vector.0.utf8)) == vector.1)
}

@Test func stage1BrowsePaginationAndEmptyPage() async throws {
    let transport = Stage1Transport { request in
        let query = stage1Query(request.url!)
        #expect(query["size"] == "2")
        #expect(query["type"] == "alphabeticalByName")
        let body = query["offset"] == "7"
            ? #"{"subsonic-response":{"status":"ok","albumList2":{"album":[{"id":"a","name":"First","artist":"One"},{"id":"b","name":"Second"}]}}}"#
            : #"{"subsonic-response":{"status":"ok","albumList2":{}}}"#
        return HTTPResponse(data: Data(body.utf8), statusCode: 200)
    }
    let server = try stage1Server(transport)
    #expect(try await server.albums(offset: 7, limit: 2) == [
        Album(id: "a", title: "First", artist: "One"), Album(id: "b", title: "Second", artist: ""),
    ])
    #expect(try await server.albums(offset: 9, limit: 2).isEmpty)
    #expect(await transport.requests.count == 2)
}

@Test func stage1SearchAndTrackMapping() async throws {
    let transport = Stage1Transport { request in
        let url = request.url!
        let query = stage1Query(url)
        let body: String
        if url.lastPathComponent == "search3.view" {
            #expect(query["query"] == "Björk + A&B?")
            #expect(query["albumOffset"] == "13")
            #expect(query["albumCount"] == "500")
            #expect(query["artistCount"] == "0")
            #expect(query["songCount"] == "0")
            body = #"{"subsonic-response":{"status":"ok","searchResult3":{"album":[{"id":"x","name":"Found","artist":"Singer"}]}}}"#
        } else {
            #expect(url.lastPathComponent == "getAlbum.view")
            #expect(query["id"] == "album&+id")
            body = #"{"subsonic-response":{"status":"ok","album":{"artist":"Album Artist","song":[{"id":"2","title":"Second","artist":"Guest","duration":12.5},{"id":"1","title":"First"}]}}}"#
        }
        return HTTPResponse(data: Data(body.utf8), statusCode: 200)
    }
    let server = try stage1Server(transport)
    #expect(try await server.searchAlbums(query: "Björk + A&B?", offset: 13, limit: 500) == [Album(id: "x", title: "Found", artist: "Singer")])
    #expect(try await server.tracks(in: "album&+id") == [
        Track(id: "2", title: "Second", artist: "Guest", duration: 12.5),
        Track(id: "1", title: "First", artist: "Album Artist", duration: nil),
    ])
}

@Test func stage1OriginalStreamParametersAndNoNetwork() async throws {
    let transport = Stage1Transport(body: "")
    let server = try stage1Server(transport)
    let url = try await server.originalStreamURL(for: "opaque/+&?id")
    #expect(url.path == "/proxy/navidrome/rest/stream.view")
    let query = stage1Query(url)
    #expect(query["id"] == "opaque/+&?id")
    #expect(query["format"] == "raw")
    #expect(query["maxBitRate"] == "0")
    #expect(await transport.requests.isEmpty)
}

@Test func stage1IdentityAndSourceQualityRemainSeparateAndOptional() async throws {
    let transport = Stage1Transport { request in
        let body: String
        if request.url!.lastPathComponent == "getAlbumList2.view" {
            body = #"{"subsonic-response":{"status":"ok","albumList2":{"album":[{"id":"a","name":"Explicit","musicBrainzId":"release-one","musicBrainzReleaseGroupId":"group-two"},{"id":"b","name":"Navidrome","musicBrainzId":"release-three"},{"id":"c","name":"Unknown","musicBrainzId":"","musicBrainzReleaseGroupId":""}]}}}"#
        } else {
            body = #"{"subsonic-response":{"status":"ok","album":{"song":[{"id":"a","title":"Source","suffix":"flac","samplingRate":96000,"bitDepth":24,"transcodedSuffix":"mp3"},{"id":"b","title":"Absent"},{"id":"c","title":"Defaults","suffix":"","samplingRate":0,"bitDepth":0}]}}}"#
        }
        return HTTPResponse(data: Data(body.utf8), statusCode: 200)
    }
    let server = try stage1Server(transport)
    let albums = try await server.albums(offset: 0, limit: 3)
    #expect(albums == [
        Album(id: "a", title: "Explicit", artist: "", releaseGroupMBID: "group-two", releaseMBID: "release-one"),
        Album(id: "b", title: "Navidrome", artist: "", releaseMBID: "release-three"),
        Album(id: "c", title: "Unknown", artist: ""),
    ])
    #expect(try await server.tracks(in: "a") == [
        Track(id: "a", title: "Source", artist: "", duration: nil,
              sourceCodec: "flac", sourceSampleRate: 96000, sourceBitDepth: 24),
        Track(id: "b", title: "Absent", artist: "", duration: nil),
        Track(id: "c", title: "Defaults", artist: "", duration: nil),
    ])
}

@Test(arguments: [(-1, 1), (0, 0), (0, 501)])
func stage1InvalidPagingDoesNotSend(page: (Int, Int)) async throws {
    let transport = Stage1Transport(body: "")
    let server = try stage1Server(transport)
    await #expect(throws: MusicServerError.invalidRequest) { try await server.albums(offset: page.0, limit: page.1) }
    await #expect(throws: MusicServerError.invalidRequest) { try await server.searchAlbums(query: "x", offset: page.0, limit: page.1) }
    #expect(await transport.requests.isEmpty)
}

@Test(arguments: [
    (401, "", MusicServerError.authentication),
    (503, "", MusicServerError.unavailable),
    (302, "", MusicServerError.unsafeRedirect),
    (404, "", MusicServerError.server(code: 404)),
    (200, "not JSON", MusicServerError.invalidResponse),
    (200, #"{"subsonic-response":{"status":"unknown"}}"#, MusicServerError.invalidResponse),
    (200, #"{"subsonic-response":{"status":"failed"}}"#, MusicServerError.invalidResponse),
    (200, #"{"subsonic-response":{"status":"failed","error":{"code":40,"message":"secret URL here"}}}"#, MusicServerError.authentication),
    (200, #"{"subsonic-response":{"status":"failed","error":{"code":70,"message":"secret URL here"}}}"#, MusicServerError.server(code: 70)),
])
func stage1SafeErrors(fixture: (Int, String, MusicServerError)) async throws {
    let server = try stage1Server(Stage1Transport(body: fixture.1, status: fixture.0))
    await #expect(throws: fixture.2) { try await server.connect() }
}

@Test func stage1MissingPayloadIsNotEmptyLibrary() async throws {
    let server = try stage1Server(Stage1Transport(body: #"{"subsonic-response":{"status":"ok"}}"#))
    await #expect(throws: MusicServerError.invalidResponse) { try await server.albums(offset: 0, limit: 1) }
    await #expect(throws: MusicServerError.invalidResponse) { try await server.searchAlbums(query: "x", offset: 0, limit: 1) }
    await #expect(throws: MusicServerError.invalidResponse) { try await server.tracks(in: "x") }
}

@Test func stage1CancellationAndUnsafeUnderlyingError() async throws {
    let cancelled = try stage1Server(Stage1Transport { _ in throw URLError(.cancelled) })
    await #expect(throws: CancellationError.self) { try await cancelled.connect() }
    let unsafe = try stage1Server(Stage1Transport { _ in
        throw NSError(domain: "secret URL here", code: 1, userInfo: [NSLocalizedDescriptionKey: "secret"])
    })
    await #expect(throws: MusicServerError.transport) { try await unsafe.connect() }
    let transport = Stage1Transport { _ in
        try await Task.sleep(for: .seconds(60))
        return HTTPResponse(data: Data(), statusCode: 200)
    }
    let sleeping = try stage1Server(transport)
    let task = Task { try await sleeping.connect() }
    // Wait until the request is in flight, rather than only testing pre-cancellation.
    while await transport.requests.isEmpty { await Task.yield() }
    task.cancel()
    await #expect(throws: CancellationError.self) { try await task.value }
}
