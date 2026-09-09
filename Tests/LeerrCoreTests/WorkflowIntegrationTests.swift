import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import Testing
@testable import LeerrCore

private enum WorkflowIdentity {
    static let artist = "11111111-1111-4111-8111-111111111111"
    static let ownedGroup = "22222222-2222-4222-8222-222222222222"
    static let ownedEdition = "33333333-3333-4333-8333-333333333333"
    static let targetGroup = "44444444-4444-4444-8444-444444444444"
    static let otherEdition = "55555555-5555-4555-8555-555555555555"
    static let selectedEdition = "66666666-6666-4666-8666-666666666666"
}

/// Strict scripts reject unexpected reads as well as duplicate writes. URLs are
/// never recorded: authenticated requests are checked only by path/query fields.
private actor WorkflowHTTPFixture {
    struct Step: Sendable {
        let path: String
        var method = "GET"
        var query: [String: String] = [:]
        let json: String
    }
    struct Write: Sendable {
        let path: String
        let method: String
        let body: Data
    }
    private var steps: [Step]
    private(set) var writes: [Write] = []

    init(_ steps: [Step]) { self.steps = steps }

    func send(_ request: URLRequest) throws -> (Data, HTTPURLResponse) {
        let step = try #require(steps.first, "Unexpected workflow HTTP request")
        steps.removeFirst()
        let url = try #require(request.url)
        #expect(url.path == step.path)
        #expect(request.httpMethod == step.method)
        let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        for (key, value) in step.query {
            #expect(query.filter { $0.name == key }.map(\.value) == [value])
        }
        if step.method != "GET" {
            writes.append(Write(path: url.path, method: step.method, body: try #require(request.httpBody)))
        }
        return (Data(step.json.utf8), try #require(HTTPURLResponse(url: url, statusCode: 200,
                                                                 httpVersion: nil, headerFields: nil)))
    }

    func assertDrained() { #expect(steps.isEmpty) }
}

private struct WorkflowNavidromeTransport: HTTPTransport {
    let fixture: WorkflowHTTPFixture
    func send(_ request: URLRequest) async throws -> HTTPResponse {
        let (data, response) = try await fixture.send(request)
        return HTTPResponse(data: data, statusCode: response.statusCode)
    }
}

private struct WorkflowMusicBrainzTransport: DiscoveryTransport {
    let fixture: WorkflowHTTPFixture
    func send(_ request: URLRequest) async throws -> DiscoveryHTTPResponse {
        let (data, response) = try await fixture.send(request)
        return DiscoveryHTTPResponse(data: data, statusCode: response.statusCode)
    }
}

private struct WorkflowLidarrTransport: LidarrHTTPTransport {
    let fixture: WorkflowHTTPFixture
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        try await fixture.send(request)
    }
}

private struct WorkflowImmediateLimiter: MusicBrainzRequestLimiting {
    func waitForTurn() async throws { try Task.checkCancellation() }
}

@Test func discoveryEditionAcquisitionBecomesAvailableOnlyAfterNavidromeIndexesAndStoreReopens() async throws {
    typealias ID = WorkflowIdentity
    typealias Step = WorkflowHTTPFixture.Step
    let credits = #"[{"artist":{"id":"\#(ID.artist)","name":"Fixture Ensemble"}}]"#
    func group(_ id: String, title: String) -> String {
        #"{"id":"\#(id)","title":"\#(title)","artist-credit":\#(credits),"primary-type":"Album"}"#
    }
    func edition(_ id: String, country: String) -> String {
        #"{"id":"\#(id)","title":"Target Album","artist-credit":\#(credits),"country":"\#(country)","media":[{"format":"CD"}]}"#
    }
    let mbFixture = WorkflowHTTPFixture([
        Step(path: "/ws/2/release/\(ID.ownedEdition)", json:
            #"{"id":"\#(ID.ownedEdition)","title":"Owned Album","release-group":\#(group(ID.ownedGroup, title: "Owned Album"))}"#),
        Step(path: "/ws/2/release/\(ID.otherEdition)", json:
            #"{"id":"\#(ID.otherEdition)","title":"Target Album","release-group":\#(group(ID.targetGroup, title: "Target Album"))}"#),
        Step(path: "/ws/2/release/\(ID.selectedEdition)", json:
            #"{"id":"\#(ID.selectedEdition)","title":"Target Album","release-group":\#(group(ID.targetGroup, title: "Target Album"))}"#),
        Step(path: "/ws/2/release", query: ["release-group": ID.targetGroup, "offset": "0", "limit": "100"], json:
            #"{"release-count":2,"releases":[\#(edition(ID.otherEdition, country: "US")),\#(edition(ID.selectedEdition, country: "FR"))]}"#),
    ])
    let musicBrainz = try MusicBrainzClient(userAgent: "LeerrTests/1.0 (https://example.test)",
        transport: WorkflowMusicBrainzTransport(fixture: mbFixture), limiter: WorkflowImmediateLimiter())

    // The existing edition has the same title, artist AND resolved group as the
    // requested edition. None of those is evidence that the selected edition exists.
    let existingAlbums = #"[{"id":"nd-owned","name":"Owned Album","artist":"Fixture Ensemble","musicBrainzId":"\#(ID.ownedEdition)"},{"id":"nd-other-edition","name":"Target Album","artist":"Fixture Ensemble","musicBrainzId":"\#(ID.otherEdition)"}]"#
    let indexedEdition = #"[{"id":"nd-selected-edition","name":"Target Album","artist":"Fixture Ensemble","musicBrainzId":"\#(ID.selectedEdition)"}]"#
    func navPage(_ offset: Int, _ albums: String, limit: Int = 500) -> Step {
        Step(path: "/navidrome/rest/getAlbumList2.view", query: ["offset": String(offset), "size": String(limit)],
             json: #"{"subsonic-response":{"status":"ok","albumList2":{"album":\#(albums)}}}"#)
    }
    var navSteps = [navPage(0, existingAlbums, limit: 50)]
    // Enriched library snapshot, then acquiring, repeated request, and imported.
    for _ in 0..<4 { navSteps += [navPage(0, existingAlbums), navPage(2, "[]")] }
    // The desired edition appears on a later short page, after reopening the store.
    for _ in 0..<2 {
        navSteps += [navPage(0, existingAlbums), navPage(2, indexedEdition), navPage(3, "[]")]
    }
    let navFixture = WorkflowHTTPFixture(navSteps)
    let server = OpenSubsonicServer(endpoint: try ServerEndpoint("https://navidrome.example.test/navidrome"),
        username: "fixture-user", password: "fixture-only", transport: WorkflowNavidromeTransport(fixture: navFixture))
    let library = IndexedMusicLibrary(server: server) { release in
        try await musicBrainz.releaseGroup(forReleaseMBID: release)?.id
    }
    let rawAlbums = try await server.albums(offset: 0, limit: 50)
    #expect(rawAlbums.map(\.releaseMBID) == [ID.ownedEdition, ID.otherEdition])
    #expect(rawAlbums.allSatisfy { $0.releaseGroupMBID == nil })
    let enriched = try await library.albums()
    #expect(enriched.map(\.releaseGroupMBID) == [ID.ownedGroup, ID.targetGroup])
    #expect(enriched.map(\.releaseMBID) == [ID.ownedEdition, ID.otherEdition])
    #expect(LibraryInventory.album(in: enriched, releaseGroupMBID: ID.targetGroup)?.id == "nd-other-edition")
    #expect(LibraryInventory.album(in: enriched, releaseGroupMBID: ID.targetGroup,
                                   releaseMBID: ID.selectedEdition) == nil)

    let candidate = DiscoveryCandidate(title: "Target Album", artist: "Fixture Ensemble",
                                       identity: .release(mbid: ID.selectedEdition))
    let discovery = DiscoveryService(musicBrainz: musicBrainz)
    let resolution = try await discovery.resolve(candidate)
    #expect(resolution.requiresConfirmation && !resolution.hasMore)
    #expect(resolution.candidate.identity == .release(mbid: ID.selectedEdition))
    let resolvedGroup = try #require(resolution.releaseGroups.first)
    #expect(resolvedGroup.id == ID.targetGroup && resolvedGroup.id != ID.selectedEdition)
    let choices = try await discovery.releases(releaseGroupMBID: resolvedGroup.id)
    #expect(choices.releases.map(\.id) == [ID.otherEdition, ID.selectedEdition])
    #expect(choices.nextOffset == nil)
    let selected = try #require(choices.releases.first { $0.country == "FR" })
    #expect(selected.id == ID.selectedEdition && selected.releaseGroupMBID == ID.targetGroup)
    let artist = try #require(resolvedGroup.artists.first)
    #expect(throws: AcquisitionError.confirmationRequired) {
        try ConfirmedAlbumIdentity(artistMBID: artist.id, releaseGroupMBID: resolvedGroup.id,
            releaseMBID: selected.id, title: resolvedGroup.title, artist: artist.name, confirmed: false)
    }
    let confirmed = try ConfirmedAlbumIdentity(artistMBID: artist.id, releaseGroupMBID: resolvedGroup.id,
        releaseMBID: selected.id, title: resolvedGroup.title, artist: artist.name, confirmed: true)

    func lidarrAlbum(monitored: Bool, files: Int) -> String {
        #"{"id":73,"foreignAlbumId":"\#(ID.targetGroup)","title":"Target Album","artist":{"foreignArtistId":"\#(ID.artist)"},"monitored":true,"anyReleaseOk":\#(!monitored),"releases":[{"foreignReleaseId":"\#(ID.otherEdition)","monitored":\#(!monitored)},{"foreignReleaseId":"\#(ID.selectedEdition)","monitored":\#(monitored)}],"statistics":{"trackCount":3,"trackFileCount":\#(files)}}"#
    }
    let unmonitored = lidarrAlbum(monitored: false, files: 0)
    let monitored = lidarrAlbum(monitored: true, files: 0)
    let imported = lidarrAlbum(monitored: true, files: 3)
    func find(_ json: String) -> Step {
        Step(path: "/lidarr/api/v1/album", query: ["foreignAlbumId": ID.targetGroup], json: json)
    }
    let lidarrFixture = WorkflowHTTPFixture([
        find("[]"),
        Step(path: "/lidarr/api/v1/album/lookup", query: ["term": "lidarr:\(ID.targetGroup)"], json: "[\(unmonitored)]"),
        Step(path: "/lidarr/api/v1/rootfolder", json: #"[{"id":9,"path":"/fixture/music"}]"#),
        Step(path: "/lidarr/api/v1/qualityprofile", json: #"[{"id":7,"name":"Fixture lossless"}]"#),
        Step(path: "/lidarr/api/v1/metadataprofile", json: #"[{"id":11,"name":"Fixture metadata"}]"#),
        Step(path: "/lidarr/api/v1/album", method: "POST", json: unmonitored),
        find("[\(unmonitored)]"),
        Step(path: "/lidarr/api/v1/album/73", method: "PUT", json: monitored),
        Step(path: "/lidarr/api/v1/command", json: "[]"),
        Step(path: "/lidarr/api/v1/command", method: "POST", json: #"{"id":91}"#),
        find("[\(monitored)]"),
        Step(path: "/lidarr/api/v1/command", json: #"[{"id":91,"name":"AlbumSearch","status":"completed","body":{"albumIds":[73]}}]"#),
        find("[\(imported)]"),
    ])
    let lidarr = LidarrClient(endpoint: try ServerEndpoint("https://lidarr.example.test/lidarr"), apiKey: "fixture-only",
        settings: try LidarrSettings(rootFolderPath: "/fixture/music", qualityProfileID: 7, metadataProfileID: 11),
        transport: WorkflowLidarrTransport(fixture: lidarrFixture))
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let account = "fixture-account-pair"
    let store = try AcquisitionRequestStore(directory: directory, accountID: account)
    let coordinator = AcquisitionCoordinator(store: store, lidarr: lidarr, library: library)
    let acquiring = try await coordinator.request(confirmed)
    #expect(acquiring.status == .acquiring && !acquiring.isAvailable)
    #expect(acquiring.identity == confirmed && acquiring.lidarrAlbumID == 73)
    #expect(acquiring.searchIssued && acquiring.pendingMutation == nil)
    // Restart while still acquiring: persisted searchIssued, rather than an
    // imported/indexed shortcut or an in-memory flag, must prevent another search.
    let acquiringStore = try AcquisitionRequestStore(directory: directory, accountID: account)
    #expect(await acquiringStore.requests() == [acquiring])
    let acquiringAfterRestart = AcquisitionCoordinator(store: acquiringStore, lidarr: lidarr, library: library)
    let repeated = try await acquiringAfterRestart.request(confirmed)
    #expect(repeated == acquiring)
    let importedRow = try await acquiringAfterRestart.reconcile(confirmed)
    #expect(importedRow.status == .imported && !importedRow.isAvailable)
    #expect(importedRow.indexedAlbumID == nil)

    let reopened = try AcquisitionRequestStore(directory: directory, accountID: account)
    #expect(await reopened.requests() == [importedRow])
    let resumed = AcquisitionCoordinator(store: reopened, lidarr: lidarr, library: library)
    let available = try await resumed.reconcile(confirmed)
    #expect(available.status == .indexed && available.isAvailable)
    #expect(available.indexedAlbumID == "nd-selected-edition")
    #expect(available.identity.releaseMBID == ID.selectedEdition)
    let reopenedAgain = try AcquisitionRequestStore(directory: directory, accountID: account)
    #expect(await reopenedAgain.requests() == [available])
    let repeatedAfterRestart = AcquisitionCoordinator(store: reopenedAgain, lidarr: lidarr, library: library)
    #expect(try await repeatedAfterRestart.request(confirmed) == available)

    let writes = await lidarrFixture.writes
    #expect(writes.map(\.method) == ["POST", "PUT", "POST"])
    #expect(writes.map(\.path) == ["/lidarr/api/v1/album", "/lidarr/api/v1/album/73", "/lidarr/api/v1/command"])
    try #require(writes.count == 3)
    let add = try #require(JSONSerialization.jsonObject(with: writes[0].body) as? [String: Any])
    #expect(add["foreignAlbumId"] as? String == ID.targetGroup)
    #expect((add["addOptions"] as? [String: Bool])?["searchForNewAlbum"] == false)
    let addedArtist = try #require(add["artist"] as? [String: Any])
    #expect(addedArtist["qualityProfileId"] as? Int == 7)
    #expect(addedArtist["metadataProfileId"] as? Int == 11)
    #expect(addedArtist["rootFolderPath"] as? String == "/fixture/music")
    let monitor = try #require(JSONSerialization.jsonObject(with: writes[1].body) as? [String: Any])
    #expect(monitor["anyReleaseOk"] as? Bool == false)
    let releases = try #require(monitor["releases"] as? [[String: Any]])
    #expect(releases.filter { $0["monitored"] as? Bool == true }.compactMap { $0["foreignReleaseId"] as? String }
            == [ID.selectedEdition])
    let search = try #require(JSONSerialization.jsonObject(with: writes[2].body) as? [String: Any])
    #expect(search["name"] as? String == "AlbumSearch")
    #expect(search["albumIds"] as? [Int] == [73])
    await navFixture.assertDrained()
    await mbFixture.assertDrained()
    await lidarrFixture.assertDrained()
}

private actor WorkflowBlockingLibrary: AcquisitionLibrary {
    private var continuation: CheckedContinuation<Void, Never>?
    private(set) var calls = 0
    private(set) var waiting = false
    func indexedAlbumID(for identity: ConfirmedAlbumIdentity) async -> String? {
        calls += 1
        if calls == 1 {
            await withCheckedContinuation { continuation = $0; waiting = true }
        }
        return "indexed"
    }
    func finish() { continuation?.resume(); continuation = nil }
}

@Test func overlappingConfirmedRequestsCannotEnterSecondWorkflow() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let store = try AcquisitionRequestStore(directory: directory, accountID: "overlap")
    let library = WorkflowBlockingLibrary()
    let fixture = WorkflowHTTPFixture([])
    let client = LidarrClient(endpoint: try ServerEndpoint("https://example.test"), apiKey: "fixture",
                              transport: WorkflowLidarrTransport(fixture: fixture))
    let coordinator = AcquisitionCoordinator(store: store, lidarr: client, library: library)
    let identity = try ConfirmedAlbumIdentity(artistMBID: WorkflowIdentity.artist,
        releaseGroupMBID: WorkflowIdentity.targetGroup, title: "Album", artist: "Artist", confirmed: true)
    let first = Task { try await coordinator.request(identity) }
    while !(await library.waiting) { await Task.yield() }
    await #expect(throws: AcquisitionError.busy) { try await coordinator.request(identity) }
    await library.finish()
    #expect(try await first.value.isAvailable)
    #expect(await library.calls == 1)
    #expect(await store.requests().count == 1)
    await fixture.assertDrained()
}
