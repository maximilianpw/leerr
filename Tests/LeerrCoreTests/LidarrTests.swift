import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import Testing
@testable import LeerrCore

private let artistID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
private let groupID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
private let editionID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"

private func lidarrIdentity(edition: Bool = false) throws -> ConfirmedAlbumIdentity {
    try ConfirmedAlbumIdentity(artistMBID: artistID, releaseGroupMBID: groupID,
                               releaseMBID: edition ? editionID : nil, title: "Album", artist: "Artist", confirmed: true)
}

private func albumJSON(artist: String = artistID) -> String {
    """
    {"id":31,"foreignAlbumId":"\(groupID)","artist":{"foreignArtistId":"\(artist)"},
    "monitored":false,"anyReleaseOk":true,"title":"Keep title","statistics":{"trackCount":9,"trackFileCount":9},
    "releases":[{"id":5,"foreignReleaseId":"\(editionID)","monitored":false,"title":"Keep edition"},
    {"id":6,"foreignReleaseId":"dddddddd-dddd-4ddd-8ddd-dddddddddddd","monitored":true}]}
    """
}

private actor LidarrFixtureTransport: LidarrHTTPTransport {
    var replies: [(Int, String)]
    var requests: [URLRequest] = []
    init(_ replies: [(Int, String)]) { self.replies = replies }
    func send(_ request: URLRequest) throws -> (Data, HTTPURLResponse) {
        requests.append(request)
        let reply = replies.removeFirst()
        return (Data(reply.1.utf8), HTTPURLResponse(url: request.url!, statusCode: reply.0, httpVersion: nil, headerFields: nil)!)
    }
}

private func client(_ transport: LidarrFixtureTransport, settings: Bool = true) throws -> LidarrClient {
    LidarrClient(endpoint: try ServerEndpoint("https://example.test:8443/lidarr/"), apiKey: "fixture-key",
                 settings: settings ? try LidarrSettings(rootFolderPath: "/music", qualityProfileID: 7, metadataProfileID: 8) : nil,
                 transport: transport)
}

@Test func lidarrHeaderSubpathAndExplicitEditionPreserveResource() async throws {
    let transport = LidarrFixtureTransport([(200, "[\(albumJSON())]"), (202, "{}"), (201, "{\"id\":41}")])
    let client = try client(transport)
    let identity = try lidarrIdentity(edition: true)
    let found = try await client.findAlbum(identity)
    let album = try #require(found)
    #expect(!album.monitored)
    #expect(!album.imported)
    try await client.monitor(album, identity: identity)
    try await client.search(albumID: album.id)
    let requests = await transport.requests
    #expect(requests[0].url?.path == "/lidarr/api/v1/album")
    #expect(requests[0].url?.query == "foreignAlbumId=\(groupID)")
    #expect(requests.allSatisfy { $0.value(forHTTPHeaderField: "X-Api-Key") == "fixture-key" })
    #expect(requests.allSatisfy { !$0.url!.absoluteString.contains("fixture-key") })
    let body = try #require(JSONSerialization.jsonObject(with: requests[1].httpBody!) as? [String: Any])
    #expect(body["title"] as? String == "Keep title")
    #expect(body["anyReleaseOk"] as? Bool == false)
    let releases = try #require(body["releases"] as? [[String: Any]])
    #expect(releases[0]["monitored"] as? Bool == true)
    #expect(releases[1]["monitored"] as? Bool == false)
    #expect(releases[0]["title"] as? String == "Keep edition")
    let command = try #require(JSONSerialization.jsonObject(with: requests[2].httpBody!) as? [String: Any])
    #expect(command["albumIds"] as? [Int] == [31])
}

@Test func lidarrWrongArtistAndDuplicateIdentityDoNotWrite() async throws {
    for json in ["[\(albumJSON(artist: editionID))]", "[\(albumJSON()),\(albumJSON())]"] {
        let transport = LidarrFixtureTransport([(200, json)])
        let client = try client(transport)
        await #expect(throws: AcquisitionError.ambiguousIdentity) { try await client.lookup(lidarrIdentity()) }
        #expect(await transport.requests.allSatisfy { $0.httpMethod == "GET" })
    }
}

@Test func lidarrAddUsesSelectedProfilesAndDoesNotAutomaticallySearch() async throws {
    let transport = LidarrFixtureTransport([(200, "[\(albumJSON())]"), (200, "[{\"id\":2,\"path\":\"/music\"}]"),
        (200, "[{\"id\":7,\"name\":\"Lossless\"}]"), (200, "[{\"id\":8,\"name\":\"Albums\"}]"), (201, "{}")])
    let client = try client(transport)
    try await client.add(client.lookup(lidarrIdentity()))
    let requests = await transport.requests
    let body = try #require(JSONSerialization.jsonObject(with: requests.last!.httpBody!) as? [String: Any])
    let artist = try #require(body["artist"] as? [String: Any])
    #expect(artist["qualityProfileId"] as? Int == 7)
    #expect(artist["metadataProfileId"] as? Int == 8)
    #expect(artist["rootFolderPath"] as? String == "/music")
    #expect(artist["monitored"] as? Bool == true)
    let artistOptions = try #require(artist["addOptions"] as? [String: Any])
    #expect(artistOptions["monitor"] as? String == "unknown")
    #expect(artistOptions["albumsToMonitor"] as? [String] == [groupID])
    #expect(artistOptions["searchForMissingAlbums"] as? Bool == false)
    #expect((body["addOptions"] as? [String: Bool])?["searchForNewAlbum"] == false)
    #expect(body["foreignAlbumId"] as? String == groupID)
}

@Test(arguments: [301, 302, 307, 308, 401, 500])
func lidarrRejectsRedirectAndSanitizesFailure(status: Int) async throws {
    let transport = LidarrFixtureTransport([(status, "sensitive server body")])
    let client = try client(transport, settings: false)
    let expected: LidarrError = status < 400 ? .redirectRejected : status == 401 ? .authentication : .httpStatus(status)
    await #expect(throws: expected) { try await client.rootFolders() }
    #expect(await transport.requests.count == 1)
}

@Test func lidarrCanRetrieveProfilesWithoutInventedSettings() async throws {
    let transport = LidarrFixtureTransport([(200, "[{\"id\":27,\"name\":\"User profile\"}]")])
    let client = try client(transport, settings: false)
    #expect(try await client.qualityProfiles().first?.id == 27)
    await #expect(throws: AcquisitionError.invalidSettings) { try await client.lookup(lidarrIdentity()) }
    #expect(await transport.requests.count == 1)
}

@Test func lidarrUnknownEditionNeverFallsBackToReleaseGroup() async throws {
    let json = albumJSON().replacingOccurrences(of: editionID, with: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee")
    let transport = LidarrFixtureTransport([(200, "[\(json)]")])
    let client = try client(transport)
    await #expect(throws: AcquisitionError.ambiguousIdentity) { try await client.lookup(lidarrIdentity(edition: true)) }
    #expect(await transport.requests.count == 1)
    #expect(await transport.requests.first?.httpMethod == "GET")
}

@Test func lidarrInvalidReadIsNotTreatedAsMissingAlbum() async throws {
    let transport = LidarrFixtureTransport([(200, "not JSON: sensitive body")])
    let client = try client(transport)
    await #expect(throws: LidarrError.invalidResponse) { try await client.findAlbum(lidarrIdentity()) }
    #expect(await transport.requests.count == 1)
}

@Test(arguments: ["queued", "started", "completed", "failed", "aborted", "cancelled", "orphaned", "future-status"])
func lidarrSearchReconciliationUsesLatestMatchingIDAndStatus(status: String) async throws {
    let transport = LidarrFixtureTransport([(200, """
    [{"id":93,"name":"AlbumSearch","status":"failed","body":{"albumIds":[13]}},
     {"id":94,"name":"ArtistSearch","status":"failed","body":{"albumIds":[31]}},
     {"id":42,"name":"AlbumSearch","status":"\(status)","body":{"albumIds":[31]}},
     {"id":41,"name":"AlbumSearch","status":"failed","body":{"albumIds":[31]}}]
    """), (200, "[{\"id\":41,\"name\":\"AlbumSearch\",\"status\":\"failed\",\"body\":{\"albumIds\":[31]}}]")])
    let client = try client(transport)
    #expect(try await client.latestSearch(for: 31) == LidarrSearchCommand(id: 42, status: LidarrSearchStatus(rawValue: status) ?? .unknown))
    #expect(try await client.latestSearch(for: 31, afterCommandID: 41) == nil)
}

/// Cancels the caller but deliberately returns a successful response anyway.
private actor CancellationIgnoringLidarrTransport: LidarrHTTPTransport {
    var methods: [String] = []
    func send(_ request: URLRequest) -> (Data, HTTPURLResponse) {
        methods.append(request.httpMethod ?? "GET")
        withUnsafeCurrentTask { $0?.cancel() }
        return (Data("[]".utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    }
}

private struct EmptyAcquisitionLibrary: AcquisitionLibrary {
    func indexedAlbumID(for identity: ConfirmedAlbumIdentity) async throws -> String? { nil }
}

@Test func lidarrChecksCancellationBeforeCallingTransport() async throws {
    let transport = CancellationIgnoringLidarrTransport()
    let client = LidarrClient(endpoint: try ServerEndpoint("https://example.test"), apiKey: "fixture", transport: transport)
    let task = Task {
        withUnsafeCurrentTask { $0?.cancel() }
        return try await client.rootFolders()
    }
    await #expect(throws: CancellationError.self) { try await task.value }
    #expect(await transport.methods.isEmpty)
}

@Test func lidarrDiscardsSuccessfulResponseAfterCancellation() async throws {
    let transport = CancellationIgnoringLidarrTransport()
    let client = LidarrClient(endpoint: try ServerEndpoint("https://example.test"), apiKey: "fixture", transport: transport)
    let task = Task { try await client.rootFolders() }
    await #expect(throws: CancellationError.self) { try await task.value }
    #expect(await transport.methods == ["GET"])
}

@Test func lidarrCancellationIgnoringReadCannotAdvanceAcquisitionOrWrite() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let transport = CancellationIgnoringLidarrTransport()
    let client = LidarrClient(endpoint: try ServerEndpoint("https://example.test"), apiKey: "fixture",
        settings: try LidarrSettings(rootFolderPath: "/music", qualityProfileID: 7, metadataProfileID: 8), transport: transport)
    let store = try AcquisitionRequestStore(directory: directory, accountID: "cancellation-account")
    let tracker = AcquisitionCoordinator(store: store, lidarr: client, library: EmptyAcquisitionLibrary())
    let task = Task { try await tracker.request(lidarrIdentity()) }
    await #expect(throws: CancellationError.self) { try await task.value }
    #expect(await transport.methods == ["GET"])
    let row = try #require(await store.requests().first)
    #expect(row.pendingMutation == nil)
    #expect(!row.searchIssued)
}
