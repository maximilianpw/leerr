import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import Testing
@testable import LeerrCore

private let jellyfinAuth = #"{"AccessToken":"token-secret_123","User":{"Id":"user-7"}}"#
private func jellyfinResponse(_ body: String, status: Int = 200) -> HTTPResponse {
    HTTPResponse(data: Data(body.utf8), statusCode: status)
}
private actor JellyfinTransport: HTTPTransport {
    var requests: [URLRequest] = []
    let handler: @Sendable (URLRequest, Int) async throws -> HTTPResponse
    init(_ handler: @escaping @Sendable (URLRequest, Int) async throws -> HTTPResponse) { self.handler = handler }
    func send(_ request: URLRequest) async throws -> HTTPResponse {
        requests.append(request)
        return try await handler(request, requests.count)
    }
}
private func jellyfinServer(_ transport: any HTTPTransport, deviceID: String = "device-8") throws -> JellyfinServer {
    JellyfinServer(endpoint: try ServerEndpoint("https://music.example.test:8443/proxy/jellyfin/"),
                   username: "listener+é&", password: "password-secret", deviceID: deviceID, transport: transport)
}
private func jellyfinQuery(_ request: URLRequest) -> [String: String] {
    Dictionary(uniqueKeysWithValues: (URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!
        .queryItems ?? []).map { ($0.name, $0.value!) })
}

@Test func jellyfinAuthenticationMetadataAndOriginalURL() async throws {
    let transport = JellyfinTransport { _, index in
        jellyfinResponse(index == 1 ? jellyfinAuth : #"{"Items":[]}"#)
    }
    let server = try jellyfinServer(transport)
    await #expect(throws: MusicServerError.authentication) { try await server.originalStreamURL(for: "track-4") }
    try await server.connect()
    _ = try await server.albums(offset: 7, limit: 3)
    let requests = await transport.requests
    let auth = requests[0]
    #expect(auth.httpMethod == "POST")
    #expect(auth.url?.path == "/proxy/jellyfin/Users/AuthenticateByName")
    #expect(auth.url?.port == 8443)
    #expect(auth.url?.query == nil)
    #expect(auth.value(forHTTPHeaderField: "Authorization") == "MediaBrowser Client=\"Leerr\",Device=\"Leerr\",DeviceId=\"device-8\",Version=\"0.1\"")
    #expect(auth.value(forHTTPHeaderField: "Content-Type") == "application/json")
    #expect(try JSONDecoder().decode([String: String].self, from: #require(auth.httpBody)) == [
        "Username": "listener+é&", "Pw": "password-secret",
    ])
    let metadata = requests[1]
    #expect(metadata.httpMethod == "GET")
    #expect(metadata.httpBody == nil)
    #expect(metadata.value(forHTTPHeaderField: "X-Emby-Token") == nil)
    #expect(metadata.value(forHTTPHeaderField: "Authorization") == "MediaBrowser Client=\"Leerr\",Device=\"Leerr\",DeviceId=\"device-8\",Version=\"0.1\",Token=\"token-secret_123\"")
    #expect(!metadata.url!.absoluteString.contains("secret"))
    #expect(jellyfinQuery(metadata) == ["userId": "user-7", "includeItemTypes": "MusicAlbum", "recursive": "true",
        "startIndex": "7", "limit": "3", "sortBy": "SortName", "sortOrder": "Ascending", "fields": "ProviderIds"])
    let names = URLComponents(url: metadata.url!, resolvingAgainstBaseURL: false)!.queryItems!.map(\.name)
    #expect(names == names.sorted())
    let stream = try await server.originalStreamURL(for: "track-4")
    #expect(stream.path == "/proxy/jellyfin/Audio/track-4/stream")
    #expect(stream.scheme == "https" && stream.port == 8443)
    #expect(jellyfinQuery(URLRequest(url: stream)) == ["static": "true", "ApiKey": "token-secret_123"])
    #expect(!stream.absoluteString.contains("password-secret"))
    #expect(await transport.requests.count == 2)
}

@Test func jellyfinSearchPagingAndDistinctMusicBrainzIdentities() async throws {
    let transport = JellyfinTransport { request, index in
        if index == 1 { return jellyfinResponse(jellyfinAuth) }
        let query = jellyfinQuery(request)
        #expect(query["searchTerm"] == "Björk + A&B?")
        #expect(query["limit"] == "2")
        #expect(request.url!.absoluteString.contains("%2B"))
        if query["startIndex"] == "9" {
            return jellyfinResponse(#"{"Items":[{"Id":"a","Name":"One","Artists":["Singer","Guest"],"ProviderIds":{"MusicBrainzAlbum":"A0000000-0000-0000-0000-000000000001","MusicBrainzReleaseGroup":"b0000000-0000-0000-0000-000000000002"}},{"Id":"b","Name":"Two","AlbumArtist":"Fallback","ProviderIds":{"MusicBrainzAlbum":"invalid","MusicBrainzReleaseGroup":""}}]}"#)
        }
        #expect(query["startIndex"] == "11")
        return jellyfinResponse(#"{"Items":[]}"#)
    }
    let server = try jellyfinServer(transport)
    try await server.connect()
    #expect(try await server.searchAlbums(query: "Björk + A&B?", offset: 9, limit: 2) == [
        Album(id: "a", title: "One", artist: "Singer, Guest",
              releaseGroupMBID: "b0000000-0000-0000-0000-000000000002", releaseMBID: "a0000000-0000-0000-0000-000000000001"),
        Album(id: "b", title: "Two", artist: "Fallback"),
    ])
    #expect(try await server.searchAlbums(query: "Björk + A&B?", offset: 11, limit: 2).isEmpty)
}

@Test(arguments: [true, false])
func jellyfinTracksBeyond500AndAuthoritativeTotal(hasTotal: Bool) async throws {
    let transport = JellyfinTransport { request, index in
        if index == 1 { return jellyfinResponse(jellyfinAuth) }
        let query = jellyfinQuery(request)
        #expect(query["parentId"] == "album-8")
        #expect(query["sortBy"] == "ParentIndexNumber,IndexNumber")
        #expect(query["includeItemTypes"] == "Audio")
        #expect(query["fields"] == "MediaSources,MediaStreams,ProviderIds")
        #expect(query["limit"] == "500")
        let items: String
        switch query["startIndex"] {
        case "0": items = (0..<500).map { #"{"Id":"t\#($0)","Name":"Track \#($0)"}"# }.joined(separator: ",")
        case "500": items = #"{"Id":"last","Name":"Final","RunTimeTicks":123456789,"Artists":["Guest"],"MediaStreams":[{"Type":"Video","Codec":"h264"},{"Type":"Audio","Codec":"flac","SampleRate":96000,"BitDepth":24}]}"#
        case "501": items = ""
        default: Issue.record("Unexpected offset"); items = ""
        }
        return jellyfinResponse("{\"Items\":[\(items)]\(hasTotal ? ",\"TotalRecordCount\":501" : "")}")
    }
    let server = try jellyfinServer(transport)
    try await server.connect()
    let tracks = try await server.tracks(in: "album-8")
    #expect(tracks.count == 501)
    #expect(tracks[499].id == "t499")
    #expect(tracks.last == Track(id: "last", title: "Final", artist: "Guest", duration: 12.3456789,
                                sourceCodec: "flac", sourceSampleRate: 96000, sourceBitDepth: 24))
    #expect(await transport.requests.count == (hasTotal ? 3 : 4))
}

@Test func jellyfinShortPagesAndSourceOnlyMetadata() async throws {
    let transport = JellyfinTransport { request, index in
        if index == 1 { return jellyfinResponse(jellyfinAuth) }
        switch jellyfinQuery(request)["startIndex"] {
        case "0": return jellyfinResponse(#"{"Items":[{"Id":"a","Name":"Source","AlbumArtist":"Artist","RunTimeTicks":-1,"MediaSources":[{"MediaStreams":[{"Type":"Audio","Codec":"alac","SampleRate":44100,"BitDepth":16}]}]}]}"#)
        case "1": return jellyfinResponse(#"{"Items":[{"Id":"b","Name":"Unknown","Container":"flac","TranscodingUrl":"secret","MediaStreams":[{"Type":"Video","Codec":"h264"}]},{"Id":"c","Name":"Defaults","MediaStreams":[{"Type":"Audio","Codec":" ","SampleRate":0,"BitDepth":-1}]}]}"#)
        default: return jellyfinResponse(#"{"Items":[]}"#)
        }
    }
    let server = try jellyfinServer(transport)
    try await server.connect()
    #expect(try await server.tracks(in: "album") == [
        Track(id: "a", title: "Source", artist: "Artist", duration: nil, sourceCodec: "alac", sourceSampleRate: 44100, sourceBitDepth: 16),
        Track(id: "b", title: "Unknown", artist: "", duration: nil),
        Track(id: "c", title: "Defaults", artist: "", duration: nil),
    ])
}

@Test(arguments: ["{}", #"{"AccessToken":"","User":{"Id":"u"}}"#,
    #"{"AccessToken":"token","User":{}}"#, #"{"AccessToken":"token","User":{"Id":"../u"}}"#,
    #"{"AccessToken":"bad\r\nheader","User":{"Id":"u"}}"#, "not JSON"])
func jellyfinMalformedAuthentication(body: String) async throws {
    let server = try jellyfinServer(JellyfinTransport { _, _ in jellyfinResponse(body) })
    await #expect(throws: MusicServerError.invalidResponse) { try await server.connect() }
    await #expect(throws: MusicServerError.authentication) { try await server.originalStreamURL(for: "t") }
}

@Test(arguments: ["{}", #"{"Items":null}"#, #"{"Items":[{"Id":"a"}]}"#,
    #"{"Items":[{"Id":"../a","Name":"Bad"}]}"#, #"{"Items":[],"TotalRecordCount":-1}"#])
func jellyfinMalformedItems(body: String) async throws {
    let server = try jellyfinServer(JellyfinTransport { _, index in jellyfinResponse(index == 1 ? jellyfinAuth : body) })
    try await server.connect()
    await #expect(throws: MusicServerError.invalidResponse) { try await server.albums(offset: 0, limit: 2) }
    await #expect(throws: MusicServerError.invalidResponse) { try await server.tracks(in: "a") }
}

@Test(arguments: [(401, MusicServerError.authentication), (403, .authentication), (302, .unsafeRedirect),
                  (307, .unsafeRedirect), (503, .unavailable), (404, .server(code: 404))])
func jellyfinSafeErrorsAndFailedReconnect(fixture: (Int, MusicServerError)) async throws {
    let server = try jellyfinServer(JellyfinTransport { _, index in
        index == 1 ? jellyfinResponse(jellyfinAuth) : jellyfinResponse("password-secret token-secret", status: fixture.0)
    })
    try await server.connect()
    await #expect(throws: fixture.1) { try await server.connect() }
    await #expect(throws: MusicServerError.authentication) { try await server.albums(offset: 0, limit: 1) }
    await #expect(throws: MusicServerError.authentication) { try await server.originalStreamURL(for: "t") }
}

@Test(arguments: ["", "..", "a/b", "a\\b", "%2e%2e", "a?ApiKey=bad", "a\r\nInjected:x", "quote\""])
func jellyfinInvalidIdentifiersDoNotSend(id: String) async throws {
    let transport = JellyfinTransport { _, _ in jellyfinResponse(jellyfinAuth) }
    let server = try jellyfinServer(transport)
    await #expect(throws: MusicServerError.invalidRequest) { try await server.tracks(in: id) }
    await #expect(throws: MusicServerError.invalidRequest) { try await server.originalStreamURL(for: id) }
    let badDevice = try jellyfinServer(transport, deviceID: id)
    await #expect(throws: MusicServerError.invalidRequest) { try await badDevice.connect() }
    #expect(await transport.requests.isEmpty)
}

@Test func jellyfinInvalidPagingAndSearchDoNotSend() async throws {
    let transport = JellyfinTransport { _, _ in jellyfinResponse(jellyfinAuth) }
    let server = try jellyfinServer(transport)
    for (offset, limit) in [(-1, 1), (0, 0), (0, 501)] {
        await #expect(throws: MusicServerError.invalidRequest) { try await server.albums(offset: offset, limit: limit) }
        await #expect(throws: MusicServerError.invalidRequest) { try await server.searchAlbums(query: "x", offset: offset, limit: limit) }
    }
    await #expect(throws: MusicServerError.invalidRequest) { try await server.searchAlbums(query: "x\n", offset: 0, limit: 1) }
    #expect(await transport.requests.isEmpty)
}

@Test func jellyfinSanitizesUnderlyingErrorsAndCancellation() async throws {
    let unsafe = try jellyfinServer(JellyfinTransport { _, _ in
        throw NSError(domain: "https://secret", code: 1, userInfo: [NSLocalizedDescriptionKey: "password-secret"])
    })
    await #expect(throws: MusicServerError.transport) { try await unsafe.connect() }
    let cancelled = try jellyfinServer(JellyfinTransport { _, _ in throw URLError(.cancelled) })
    await #expect(throws: CancellationError.self) { try await cancelled.connect() }
    let transport = JellyfinTransport { _, index in
        if index > 1 {
            // Deliberately violate the injected transport's cancellation contract.
            while !Task.isCancelled { await Task.yield() }
        }
        return jellyfinResponse(jellyfinAuth)
    }
    let server = try jellyfinServer(transport)
    try await server.connect()
    let task = Task { try await server.connect() }
    while await transport.requests.count < 2 { await Task.yield() }
    task.cancel()
    await #expect(throws: CancellationError.self) { try await task.value }
    await #expect(throws: MusicServerError.authentication) { try await server.originalStreamURL(for: "t") }
}

@Test func jellyfinCancelledMetadataCannotPublishSuccessfulResponse() async throws {
    let transport = JellyfinTransport { _, index in
        if index == 1 { return jellyfinResponse(jellyfinAuth) }
        while !Task.isCancelled { await Task.yield() }
        return jellyfinResponse(#"{"Items":[{"Id":"a","Name":"Late"}],"TotalRecordCount":1}"#)
    }
    let server = try jellyfinServer(transport)
    try await server.connect()
    let task = Task { try await server.tracks(in: "a") }
    while await transport.requests.count < 2 { await Task.yield() }
    task.cancel()
    await #expect(throws: CancellationError.self) { try await task.value }
}

private actor JellyfinGate {
    var waiting = false
    private var continuation: CheckedContinuation<Void, Never>?
    func wait() async {
        await withCheckedContinuation { continuation in
            self.continuation = continuation
            waiting = true
        }
    }
    func release() { continuation?.resume(); continuation = nil }
}

@Test func jellyfinOlderConnectCannotRestoreAuthenticationAfterFailedNewerConnect() async throws {
    let gate = JellyfinGate()
    let server = try jellyfinServer(JellyfinTransport { _, index in
        if index == 1 {
            await gate.wait()
            return jellyfinResponse(jellyfinAuth)
        }
        return jellyfinResponse("secret", status: 401)
    })
    let older = Task { try await server.connect() }
    while !(await gate.waiting) { await Task.yield() }
    await #expect(throws: MusicServerError.authentication) { try await server.connect() }
    await gate.release()
    await #expect(throws: CancellationError.self) { try await older.value }
    await #expect(throws: MusicServerError.authentication) { try await server.originalStreamURL(for: "t") }
}

@Test func jellyfinProviderIDsDriveSharedOwnershipAndExactIndexedEdition() async throws {
    let group = "b0000000-0000-0000-0000-000000000002"
    let release = "a0000000-0000-0000-0000-000000000001"
    let server = try jellyfinServer(JellyfinTransport { request, index in
        if index == 1 { return jellyfinResponse(jellyfinAuth) }
        if jellyfinQuery(request)["startIndex"] == "0" {
            return jellyfinResponse(#"{"Items":[{"Id":"wrong-edition","Name":"Same title","AlbumArtists":[{"Name":"A"},{"Name":"B"}],"ProviderIds":{"MusicBrainzAlbum":"a0000000-0000-0000-0000-000000000099","MusicBrainzReleaseGroup":"b0000000-0000-0000-0000-000000000002"}},{"Id":"right-edition","Name":"Different tag","ProviderIds":{"MusicBrainzAlbum":"a0000000-0000-0000-0000-000000000001","MusicBrainzReleaseGroup":"b0000000-0000-0000-0000-000000000002"}}],"TotalRecordCount":2}"#)
        }
        #expect(jellyfinQuery(request)["startIndex"] == "2")
        return jellyfinResponse(#"{"Items":[],"TotalRecordCount":2}"#)
    })
    try await server.connect()
    let library = IndexedMusicLibrary(server: server, resolveRelease: { _ in throw DiscoveryError.unavailable })
    let inventory = try await library.albums()
    #expect(inventory.first?.artist == "A, B")
    #expect(LibraryInventory.album(in: inventory, releaseGroupMBID: group)?.id == "wrong-edition")
    let identity = try ConfirmedAlbumIdentity(artistMBID: "c0000000-0000-0000-0000-000000000003",
        releaseGroupMBID: group, releaseMBID: release, title: "Same title", artist: "A", confirmed: true)
    #expect(try await library.indexedAlbumID(for: identity) == "right-edition")
}
