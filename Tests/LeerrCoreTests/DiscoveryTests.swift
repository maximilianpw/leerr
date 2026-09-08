import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import Testing
@testable import LeerrCore

private let groupA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
private let groupB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
private let releaseA = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
private let releaseB = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
private let artistA = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
private let agent = "LeerrTests/1.0 (https://example.test/contact)"
private let credits = "\"artist-credit\":[{\"artist\":{\"id\":\"\(artistA)\",\"name\":\"Artist\"}}]"

private func response(_ json: String, status: Int = 200) -> DiscoveryHTTPResponse {
    DiscoveryHTTPResponse(data: Data(json.utf8), statusCode: status)
}

private func groupJSON(_ id: String = groupA) -> String {
    "{\"id\":\"\(id)\",\"title\":\"Album\",\(credits),\"disambiguation\":\"original\",\"primary-type\":\"Album\"}"
}

private func releaseJSON(_ id: String = releaseA, group: String = groupA) -> String {
    "{\"id\":\"\(id)\",\"title\":\"Album\",\(credits),\"release-group\":\(groupJSON(group)),\"country\":\"FR\",\"date\":\"2001-02-03\",\"media\":[{\"format\":\"CD\"}]}"
}

private func query(_ request: URLRequest, _ name: String) -> String? {
    URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == name }?.value
}

private actor DiscoveryFixture: DiscoveryTransport {
    private(set) var requests: [URLRequest] = []
    let handler: @Sendable (URLRequest) async throws -> DiscoveryHTTPResponse
    init(_ handler: @escaping @Sendable (URLRequest) async throws -> DiscoveryHTTPResponse) { self.handler = handler }
    func send(_ request: URLRequest) async throws -> DiscoveryHTTPResponse {
        requests.append(request)
        return try await handler(request)
    }
}

private actor FixtureLimiter: MusicBrainzRequestLimiting {
    private(set) var calls = 0
    func waitForTurn() throws { try Task.checkCancellation(); calls += 1 }
}

private func client(_ fixture: DiscoveryFixture, limiter: any MusicBrainzRequestLimiting = FixtureLimiter()) throws -> MusicBrainzClient {
    try MusicBrainzClient(userAgent: agent, transport: fixture, limiter: limiter)
}

@Test func discoveryFilteringIsExactTypedAndStable() {
    let owned = DiscoveryCandidate(title: "Album", artist: "Artist", identity: .releaseGroup(mbid: groupA))
    let requested = DiscoveryCandidate(title: "Other", artist: "Other", identity: .releaseGroup(mbid: groupB))
    let nameOnly = DiscoveryCandidate(title: "Album", artist: "Artist")
    let duplicateName = DiscoveryCandidate(title: " ALBUM ", artist: "ARTIST")
    let otherArtist = DiscoveryCandidate(title: "Album", artist: "Someone else")
    let edition = DiscoveryCandidate(title: "Album", artist: "Artist", identity: .release(mbid: groupA))
    let input = [owned, requested, nameOnly, duplicateName, otherArtist, edition, owned]
    let actual = DiscoveryFilter.candidates(input, ownedReleaseGroupMBIDs: [groupA.uppercased()], requestedReleaseGroupMBIDs: [groupB])
    #expect(actual == [nameOnly, otherArtist, edition])
    #expect(DiscoveryFilter.candidates(actual) == actual)
    #expect(DiscoveryCandidate(title: "X", artist: "Y", identity: .release(mbid: "not-an-id")).identity == .nameOnly)
}

@Test func discoveryLastFMUsesSignalsAndKeepsMissingMBIDsUncertain() async throws {
    let fixture = DiscoveryFixture { request in
        #expect(request.url?.scheme == "https")
        #expect(request.url?.host == "ws.audioscrobbler.com")
        #expect(request.httpMethod == "GET")
        #expect(query(request, "api_key") == "fixture-key&not-another-parameter")
        switch query(request, "method") {
        case "user.getTopArtists":
            #expect(query(request, "user") == "a+b & c")
            #expect(request.url?.query?.contains("a%2Bb") == true)
            return response(#"{"topartists":{"artist":[{"name":"Seed"}]}}"#)
        case "artist.getSimilar": return response(#"{"similarartists":{"artist":[{"name":"New artist"},{"name":"New artist"}]}}"#)
        case "artist.getTopAlbums": return response("{\"topalbums\":{\"album\":[{\"name\":\"First\",\"mbid\":\"\"},{\"name\":\"Second\"},{\"name\":\"Third\",\"mbid\":\"\(releaseA)\"}]}}")
        default: throw DiscoveryError.invalidResponse
        }
    }
    let result = try await LastFMClient(transport: fixture).discover(username: "a+b & c", apiKey: "fixture-key&not-another-parameter")
    #expect(result.map(\.identity) == [.nameOnly, .nameOnly, .release(mbid: releaseA)])
    #expect(result.map(\.title) == ["First", "Second", "Third"])
    #expect(result.allSatisfy { $0.artist == "New artist" && $0.reason == "Similar to Seed" })
    #expect(await fixture.requests.count == 3)
}

@Test func discoveryCanonicalizesEditionsBeforeOwnedFiltering() async throws {
    let fixture = DiscoveryFixture { request in
        switch query(request, "method") {
        case "user.getTopArtists": return response(#"{"topartists":{"artist":[{"name":"Seed"}]}}"#)
        case "artist.getSimilar": return response(#"{"similarartists":{"artist":[{"name":"Artist"}]}}"#)
        case "artist.getTopAlbums": return response("{\"topalbums\":{\"album\":[{\"name\":\"Album\",\"mbid\":\"\(releaseA)\"},{\"name\":\"Album\",\"mbid\":\"\(releaseB)\"},{\"name\":\"Album\"}]}}")
        default: return response(releaseJSON(request.url!.lastPathComponent))
        }
    }
    let service = DiscoveryService(lastFM: LastFMClient(transport: fixture), musicBrainz: try client(fixture))
    let unfiltered = try await service.discover(username: "first", apiKey: "fixture")
    #expect(unfiltered.map(\.identity) == [.releaseGroup(mbid: groupA), .nameOnly])
    let filtered = try await service.discover(username: "first", apiKey: "fixture", ownedReleaseGroupMBIDs: [groupA])
    #expect(filtered.count == 1)
    #expect(filtered.first?.identity == .nameOnly)
    let requested = try await service.discover(username: "first", apiKey: "fixture", requestedReleaseGroupMBIDs: [groupA])
    #expect(requested == filtered)
}

@Test func discoveryMusicBrainzSeparatesGroupAndEditionAndPreservesAmbiguity() async throws {
    let limiter = FixtureLimiter()
    let fixture = DiscoveryFixture { request in
        #expect(request.url?.scheme == "https")
        #expect(request.url?.host == "musicbrainz.org")
        #expect(request.httpMethod == "GET")
        #expect(request.value(forHTTPHeaderField: "User-Agent") == agent)
        if request.url?.lastPathComponent == releaseA {
            #expect(query(request, "inc") == "release-groups+artist-credits")
            return response(releaseJSON())
        }
        if query(request, "release-group") != nil {
            #expect(query(request, "release-group") == groupA)
            #expect(query(request, "offset") == "0")
            return response("{\"release-count\":3,\"releases\":[\(releaseJSON()),\(releaseJSON(releaseB))]}")
        }
        #expect(query(request, "query") == "releasegroup:\"A\\\" \\+ B\" AND artist:\"Artist\"")
        return response("{\"count\":2,\"release-groups\":[\(groupJSON()),\(groupJSON(groupB))]}")
    }
    let mb = try client(fixture, limiter: limiter)
    let exact = try await mb.resolve(DiscoveryCandidate(title: "Guess", artist: "Guess", identity: .release(mbid: releaseA)))
    #expect(exact.releaseGroups.map(\.id) == [groupA])
    #expect(exact.releaseGroups.first?.artists.first?.id == artistA)
    #expect(exact.requiresConfirmation)
    let search = try await mb.resolve(DiscoveryCandidate(title: "A\" + B", artist: "Artist"))
    #expect(search.releaseGroups.map(\.id) == [groupA, groupB])
    #expect(search.requiresConfirmation)
    #expect(!search.hasMore)
    let editions = try await mb.releases(releaseGroupMBID: groupA)
    #expect(editions.releases.map(\.id) == [releaseA, releaseB])
    #expect(editions.releases.allSatisfy { $0.releaseGroupMBID == groupA && $0.formats == ["CD"] && $0.country == "FR" })
    #expect(editions.nextOffset == 2)
    #expect(await limiter.calls == 3)
}

@Test func discoveryErrorsDoNotExposeRemoteMessagesOrURLs() async throws {
    let lastFM = LastFMClient(transport: DiscoveryFixture { _ in response(#"{"error":10,"message":"https://secret.example/?api_key=private"}"#) })
    await #expect(throws: DiscoveryError.authentication) { try await lastFM.discover(username: "account", apiKey: "fixture") }
    let badJSON = LastFMClient(transport: DiscoveryFixture { _ in response("secret response body") })
    await #expect(throws: DiscoveryError.invalidResponse) { try await badJSON.discover(username: "account", apiKey: "fixture") }
    let network = LastFMClient(transport: DiscoveryFixture { _ in throw URLError(.timedOut, userInfo: [NSURLErrorFailingURLStringErrorKey: "https://private/?api_key=secret"]) })
    await #expect(throws: DiscoveryError.transport) { try await network.discover(username: "account", apiKey: "fixture") }
    let limited = try client(DiscoveryFixture { _ in response("private", status: 429) })
    await #expect(throws: DiscoveryError.rateLimited) { try await limited.resolve(DiscoveryCandidate(title: "A", artist: "B")) }
    let redirect = LastFMClient(transport: DiscoveryFixture { _ in response("", status: 302) })
    await #expect(throws: DiscoveryError.invalidResponse) { try await redirect.discover(username: "account", apiKey: "fixture") }
}

/// Deliberately ignores cancellation to prove late results cannot cross account boundaries.
private actor DiscoveryGate {
    private var started = false
    private var waiters: [CheckedContinuation<Void, Never>] = []
    private var pending: CheckedContinuation<Void, Never>?
    func block() async {
        started = true
        waiters.forEach { $0.resume() }
        waiters = []
        await withCheckedContinuation { pending = $0 }
    }
    func waitUntilStarted() async {
        if !started { await withCheckedContinuation { waiters.append($0) } }
    }
    func release() { pending?.resume(); pending = nil }
}

@Test func discoveryAccountSwitchRejectsLateResults() async throws {
    let gate = DiscoveryGate()
    let fixture = DiscoveryFixture { request in
        if query(request, "user") == "old" { await gate.block() }
        return response(#"{"topartists":{"artist":[]}}"#)
    }
    let service = DiscoveryService(lastFM: LastFMClient(transport: fixture), musicBrainz: try client(fixture))
    let old = Task { try await service.discover(username: "old", apiKey: "old-key") }
    await gate.waitUntilStarted()
    let current = try await service.discover(username: "new", apiKey: "new-key")
    #expect(current.isEmpty)
    await gate.release()
    await #expect(throws: CancellationError.self) { try await old.value }
    let requests = await fixture.requests
    #expect(requests.map { query($0, "user") } == ["old", "new"])
    #expect(requests.map { query($0, "api_key") } == ["old-key", "new-key"])
}

@Test(arguments: [false, true]) func discoveryCancellationRejectsLateResults(cancelCaller: Bool) async throws {
    let gate = DiscoveryGate()
    let fixture = DiscoveryFixture { _ in await gate.block(); return response(#"{"count":0,"release-groups":[]}"#) }
    let service = DiscoveryService(musicBrainz: try client(fixture))
    let task = Task { try await service.resolve(DiscoveryCandidate(title: "Album", artist: "Artist")) }
    await gate.waitUntilStarted()
    if cancelCaller { task.cancel() } else { await service.cancel() }
    await gate.release()
    await #expect(throws: CancellationError.self) { try await task.value }
}

@Test func discoveryRateLimiterSpacesConcurrentRequestsAndCancelsWaiters() async throws {
    let limiter = MusicBrainzRateLimiter()
    let clock = ContinuousClock()
    let times = try await withThrowingTaskGroup(of: ContinuousClock.Instant.self) { group in
        for _ in 0..<3 {
            group.addTask { try await limiter.waitForTurn(); return clock.now }
        }
        var times: [ContinuousClock.Instant] = []
        for try await time in group { times.append(time) }
        return times.sorted()
    }
    #expect(times[0].duration(to: times[1]) >= .milliseconds(990))
    #expect(times[1].duration(to: times[2]) >= .milliseconds(990))
    let waiting = Task { try await limiter.waitForTurn() }
    waiting.cancel()
    await #expect(throws: CancellationError.self) { try await waiting.value }
}

@Test func discoveryRejectsInvalidUserAgentAndMalformedIdentity() async throws {
    #expect(throws: DiscoveryError.invalidConfiguration) { try MusicBrainzClient(userAgent: "generic") }
    #expect(throws: DiscoveryError.invalidConfiguration) { try MusicBrainzClient(userAgent: agent + "\r\nInjected: yes") }
    let mb = try client(DiscoveryFixture { _ in response(#"{"id":"invalid","title":"Album","artist-credit":[]}"#) })
    await #expect(throws: DiscoveryError.invalidResponse) { try await mb.resolve(DiscoveryCandidate(title: "A", artist: "B", identity: .releaseGroup(mbid: groupA))) }
    await #expect(throws: DiscoveryError.invalidConfiguration) { try await mb.releases(releaseGroupMBID: "release/not-an-id") }
}

@Test func discoveryStaleMBIDFallsBackToExplicitNameSearch() async throws {
    let fixture = DiscoveryFixture { request in
        switch query(request, "method") {
        case "user.getTopArtists": return response(#"{"topartists":{"artist":[{"name":"Seed"}]}}"#)
        case "artist.getSimilar": return response(#"{"similarartists":{"artist":[{"name":"Artist"}]}}"#)
        case "artist.getTopAlbums": return response("{\"topalbums\":{\"album\":[{\"name\":\"Stale\",\"mbid\":\"\(releaseA)\"}]}}")
        default: return response("", status: 404)
        }
    }
    let service = DiscoveryService(lastFM: LastFMClient(transport: fixture), musicBrainz: try client(fixture))
    let candidates = try await service.discover(username: "account", apiKey: "fixture", ownedReleaseGroupMBIDs: [groupA, releaseA])
    #expect(candidates.count == 1)
    #expect(candidates.first?.identity == .nameOnly)
    #expect(candidates.first?.releaseGroupMBID == nil)
    #expect(candidates.first?.title == "Stale")
}

@Test func discoveryEmptyListeningHistoryAndSearchPagination() async throws {
    let empty = LastFMClient(transport: DiscoveryFixture { _ in response(#"{"topartists":{}}"#) })
    #expect(try await empty.discover(username: "account", apiKey: "fixture").isEmpty)
    let mb = try client(DiscoveryFixture { request in
        let offset = query(request, "offset")
        if query(request, "release-group") != nil {
            #expect(offset == "2")
            return response("{\"release-count\":3,\"releases\":[\(releaseJSON(releaseB))]}")
        }
        return response("{\"count\":2,\"release-groups\":[\(groupJSON(offset == "0" ? groupA : groupB))]}")
    })
    let candidate = DiscoveryCandidate(title: "Album", artist: "Artist")
    let first = try await mb.resolve(candidate)
    #expect(first.hasMore)
    #expect(first.releaseGroups.map(\.id) == [groupA])
    let second = try await mb.resolve(candidate, offset: 1)
    #expect(!second.hasMore)
    #expect(second.releaseGroups.map(\.id) == [groupB])
    let lastEdition = try await mb.releases(releaseGroupMBID: groupA, offset: 2)
    #expect(lastEdition.nextOffset == nil)
    #expect(lastEdition.releases.map(\.id) == [releaseB])
}

@Test func discoveryLiveTransportRejectsHTTPAndAllRedirects() async throws {
    let transport = DiscoveryURLSessionTransport()
    await #expect(throws: DiscoveryError.invalidConfiguration) {
        try await transport.send(URLRequest(url: URL(string: "http://example.test")!))
    }
    let session = URLSession(configuration: .ephemeral)
    defer { session.invalidateAndCancel() }
    let source = URL(string: "https://ws.audioscrobbler.com/2.0/")!
    let task = session.dataTask(with: source)
    let redirect = HTTPURLResponse(url: source, statusCode: 302, httpVersion: nil, headerFields: nil)!
    for destination in ["https://other.example.test/", "http://ws.audioscrobbler.com/", "https://ws.audioscrobbler.com/new"] {
        DiscoveryRedirectPolicy().urlSession(session, task: task, willPerformHTTPRedirection: redirect,
                                             newRequest: URLRequest(url: URL(string: destination)!)) { request in
            #expect(request == nil)
        }
    }
}

@Test func discoveryInventoryLookupDistinguishesNotFoundFromFailure() async throws {
    let limiter = FixtureLimiter()
    let fixture = DiscoveryFixture { request in
        #expect(request.url?.path == "/ws/2/release/\(releaseA)" || request.url?.path == "/ws/2/release/\(releaseB)")
        if request.url?.lastPathComponent == releaseB { return response("", status: 404) }
        // Lookup includes release credits; nested group may omit them.
        return response("{\"id\":\"\(releaseA)\",\"title\":\"Edition\",\(credits),\"release-group\":{\"id\":\"\(groupA)\",\"title\":\"Album group\"}}")
    }
    let mb = try client(fixture, limiter: limiter)
    let group = try await mb.releaseGroup(forReleaseMBID: releaseA.uppercased())
    #expect(group?.id == groupA)
    #expect(group?.title == "Album group")
    #expect(group?.artists.first?.id == artistA)
    #expect(try await mb.releaseGroup(forReleaseMBID: releaseB) == nil)
    #expect(await limiter.calls == 2)
    let offline = try client(DiscoveryFixture { _ in response("", status: 503) })
    await #expect(throws: DiscoveryError.unavailable) { try await offline.releaseGroup(forReleaseMBID: releaseA) }
    await #expect(throws: DiscoveryError.invalidConfiguration) { try await mb.releaseGroup(forReleaseMBID: "invalid") }
}
