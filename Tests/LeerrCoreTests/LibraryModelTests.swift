import Foundation
import Testing
@testable import LeerrCore

private func album(_ id: String) -> Album {
    Album(id: id, title: "Album \(id)", artist: "Artist \(id)")
}

private func track(_ id: String) -> Track {
    Track(id: id, title: "Track \(id)", artist: "Artist \(id)", duration: 137)
}

private struct SecretError: LocalizedError {
    var errorDescription: String? { "https://private.test?password=do-not-display" }
}

/// Deliberately ignores cancellation until the test releases each request.
private actor ControlledServer: MusicServer {
    enum Kind: Equatable {
        case browse(Int, Int)
        case search(String, Int, Int)
        case tracks(String)
    }
    struct Request: Sendable {
        let id: Int
        let kind: Kind
    }
    enum Response: Sendable {
        case albums([Album])
        case tracks([Track])
    }
    private var nextID = 0
    private var requests: [Request] = []
    private var readers: [CheckedContinuation<Request, Never>] = []
    private var pending: [Int: CheckedContinuation<Response, Error>] = [:]
    private(set) var cancelled: Set<Int> = []
    private(set) var callCount = 0

    func nextRequest() async -> Request {
        if !requests.isEmpty { return requests.removeFirst() }
        return await withCheckedContinuation { readers.append($0) }
    }

    func finish(_ request: Request, _ response: Response) {
        pending.removeValue(forKey: request.id)!.resume(returning: response)
    }

    func fail(_ request: Request, _ error: any Error = SecretError()) {
        pending.removeValue(forKey: request.id)!.resume(throwing: error)
    }

    private func request(_ kind: Kind) async throws -> Response {
        let request = Request(id: nextID, kind: kind)
        nextID += 1
        callCount += 1
        defer { if Task.isCancelled { cancelled.insert(request.id) } }
        return try await withCheckedThrowingContinuation { continuation in
            pending[request.id] = continuation
            if readers.isEmpty {
                requests.append(request)
            } else {
                readers.removeFirst().resume(returning: request)
            }
        }
    }

    func connect() async throws {}
    func albums(offset: Int, limit: Int) async throws -> [Album] {
        guard case .albums(let result) = try await request(.browse(offset, limit)) else {
            preconditionFailure("Wrong fixture response")
        }
        return result
    }
    func searchAlbums(query: String, offset: Int, limit: Int) async throws -> [Album] {
        guard case .albums(let result) = try await request(.search(query, offset, limit)) else {
            preconditionFailure("Wrong fixture response")
        }
        return result
    }
    func tracks(in albumID: String) async throws -> [Track] {
        guard case .tracks(let result) = try await request(.tracks(albumID)) else {
            preconditionFailure("Wrong fixture response")
        }
        return result
    }
    func originalStreamURL(for trackID: String) async throws -> URL {
        throw SecretError()
    }
}

@MainActor
@Test func libraryStartsAndDisconnectsEmpty() async {
    let model = LibraryModel()
    #expect(model.albums.isEmpty && model.tracks.isEmpty)
    #expect(!model.isLoading && !model.hasMore && model.errorMessage == nil)
    await model.reload()
    await model.search("anything")
    await model.loadMore()
    await model.loadTracks(album: album("unavailable"))
    model.setServer(nil)
    #expect(model.query.isEmpty)
    #expect(!model.isLoading && !model.hasMore && model.errorMessage == nil)
}

@MainActor
@Test func paginationUsesRawCountAndOnlyEmptyPageEnds() async {
    let server = ControlledServer()
    let model = LibraryModel()
    model.setServer(server)
    let pages = [[album("b"), album("a"), album("b")], [album("a")], [album("c"), album("b")], []]
    let offsets = [0, 3, 4, 6]
    for (index, page) in pages.enumerated() {
        let task = Task { await model.loadMore() }
        let request = await server.nextRequest()
        #expect(request.kind == .browse(offsets[index], 50))
        #expect(model.isLoading)
        await model.loadMore() // Concurrent pagination must not issue another request.
        #expect(await server.callCount == index + 1)
        await server.finish(request, .albums(page))
        await task.value
        #expect(model.hasMore == !page.isEmpty)
        #expect(!model.isLoading)
    }
    #expect(model.albums == [album("b"), album("a"), album("c")])
    await model.loadMore()
    #expect(await server.callCount == 4)
}

@MainActor
@Test(arguments: [false, true], [false, true])
func supersededSearchCannotChangeResultsErrorsOrLoading(oldFails: Bool, oldFinishesFirst: Bool) async {
    let server = ControlledServer()
    let model = LibraryModel()
    model.setServer(server)
    let old = Task { await model.search("older") }
    let oldRequest = await server.nextRequest()
    let latest = Task { await model.search("  newer\n") }
    let newRequest = await server.nextRequest()
    #expect(newRequest.kind == .search("newer", 0, 50))
    if !oldFinishesFirst {
        await server.finish(newRequest, .albums([album("fresh"), album("second")]))
        await latest.value
    }
    if oldFails {
        await server.fail(oldRequest)
    } else {
        await server.finish(oldRequest, .albums([album("stale")]))
    }
    await old.value
    #expect(await server.cancelled.contains(oldRequest.id))
    #expect(model.isLoading == oldFinishesFirst)
    #expect(model.errorMessage == nil)
    if oldFinishesFirst {
        #expect(model.albums.isEmpty)
        await server.finish(newRequest, .albums([album("fresh"), album("second")]))
        await latest.value
    }
    #expect(model.query == "newer")
    #expect(model.albums == [album("fresh"), album("second")])
    let more = Task { await model.loadMore() }
    let moreRequest = await server.nextRequest()
    #expect(moreRequest.kind == .search("newer", 2, 50))
    await server.finish(moreRequest, .albums([]))
    await more.value
}

@MainActor
@Test(arguments: ["replacement", "same-session", "disconnect"])
func accountChangesInvalidateBothRequestSlots(mode: String) async {
    let server = ControlledServer()
    let replacement = mode == "same-session" ? server : ControlledServer()
    let model = LibraryModel()
    model.setServer(server)
    let oldAlbums = Task { await model.search("private query") }
    let albumRequest = await server.nextRequest()
    let oldTracks = Task { await model.loadTracks(album: album("shared-id")) }
    let trackRequest = await server.nextRequest()
    model.setServer(mode == "disconnect" ? nil : replacement)
    #expect(model.query.isEmpty && model.albums.isEmpty && model.tracks.isEmpty)
    #expect(!model.isLoading && model.errorMessage == nil)
    #expect(model.hasMore == (mode != "disconnect"))
    if mode != "disconnect" {
        let fresh = Task { await model.reload() }
        let request = await replacement.nextRequest()
        #expect(request.kind == .browse(0, 50))
        await replacement.finish(request, .albums([album("new-account")]))
        await fresh.value
    }
    await server.finish(albumRequest, .albums([album("private-old-album")]))
    await server.fail(trackRequest)
    await oldAlbums.value
    await oldTracks.value
    #expect(await server.cancelled == [albumRequest.id, trackRequest.id])
    #expect(model.albums == (mode == "disconnect" ? [] : [album("new-account")]))
    #expect(model.tracks.isEmpty && model.errorMessage == nil && !model.isLoading)
}

@MainActor
@Test func trackSelectionCancelsOldSelectionAndLoadingIncludesBothSlots() async {
    let server = ControlledServer()
    let model = LibraryModel()
    model.setServer(server)
    let browsing = Task { await model.reload() }
    let browseRequest = await server.nextRequest()
    let old = Task { await model.loadTracks(album: album("old")) }
    let oldRequest = await server.nextRequest()
    let latest = Task { await model.loadTracks(album: album("latest")) }
    let newRequest = await server.nextRequest()
    #expect(newRequest.kind == .tracks("latest"))
    await server.finish(newRequest, .tracks([track("2"), track("1")]))
    await latest.value
    #expect(model.isLoading) // The album request is still active.
    await server.finish(oldRequest, .tracks([track("stale")]))
    await old.value
    #expect(await server.cancelled.contains(oldRequest.id))
    #expect(model.tracks == [track("2"), track("1")])
    #expect(model.isLoading)
    await server.finish(browseRequest, .albums([album("latest")]))
    await browsing.value
    #expect(!model.isLoading && model.errorMessage == nil)
}

@MainActor
@Test func failedPageRetainsAlbumsAndRetriesSameOffsetWithSafeError() async {
    let server = ControlledServer()
    let model = LibraryModel()
    model.setServer(server)
    let initial = Task { await model.reload() }
    let first = await server.nextRequest()
    await server.finish(first, .albums([album("x"), album("y"), album("x")]))
    await initial.value
    let failing = Task { await model.loadMore() }
    let failed = await server.nextRequest()
    await server.fail(failed)
    await failing.value
    #expect(model.errorMessage == "Unable to load albums. Please try again.")
    #expect(model.albums == [album("x"), album("y")])
    #expect(model.hasMore && !model.isLoading)
    let retry = Task { await model.loadMore() }
    let retried = await server.nextRequest()
    #expect(retried.kind == .browse(3, 50))
    #expect(model.errorMessage == nil)
    await server.finish(retried, .albums([album("z")]))
    await retry.value
    #expect(model.albums == [album("x"), album("y"), album("z")])
}

@MainActor
@Test(arguments: [false, true])
func callerCancellationCannotPublishEvenIfTransportSucceeds(tracks: Bool) async {
    let server = ControlledServer()
    let model = LibraryModel()
    model.setServer(server)
    let task = Task {
        if tracks { await model.loadTracks(album: album("cancelled")) }
        else { await model.reload() }
    }
    let request = await server.nextRequest()
    task.cancel()
    await server.finish(request, tracks ? .tracks([track("late")]) : .albums([album("late")]))
    await task.value
    #expect(model.albums.isEmpty && model.tracks.isEmpty)
    #expect(model.errorMessage == nil && !model.isLoading)
}

@MainActor
@Test func reloadPreservesQueryAndClearsTracksWhileBlankSearchBrowses() async {
    let server = ControlledServer()
    let model = LibraryModel()
    model.setServer(server)
    let search = Task { await model.search("jazz") }
    let searchRequest = await server.nextRequest()
    await server.finish(searchRequest, .albums([album("jazz")]))
    await search.value
    let selection = Task { await model.loadTracks(album: album("jazz")) }
    let trackRequest = await server.nextRequest()
    let reload = Task { await model.reload() }
    let reloadRequest = await server.nextRequest()
    #expect(reloadRequest.kind == .search("jazz", 0, 50))
    #expect(model.albums.isEmpty && model.tracks.isEmpty)
    await server.finish(trackRequest, .tracks([track("stale")]))
    await selection.value
    #expect(await server.cancelled.contains(trackRequest.id))
    #expect(model.tracks.isEmpty && model.isLoading)
    await server.finish(reloadRequest, .albums([]))
    await reload.value
    let browse = Task { await model.search(" \n\t") }
    let browseRequest = await server.nextRequest()
    #expect(browseRequest.kind == .browse(0, 50))
    #expect(model.query.isEmpty)
    await server.finish(browseRequest, .albums([]))
    await browse.value
}

@MainActor
@Test func trackErrorsAreSafeAndCancellationIsSilent() async {
    let server = ControlledServer()
    let model = LibraryModel()
    model.setServer(server)
    let failed = Task { await model.loadTracks(album: album("failed")) }
    let failedRequest = await server.nextRequest()
    await server.fail(failedRequest)
    await failed.value
    #expect(model.errorMessage == "Unable to load tracks. Please try again.")
    #expect(model.tracks.isEmpty && !model.isLoading)
    let cancelled = Task { await model.loadTracks(album: album("cancelled")) }
    let cancelledRequest = await server.nextRequest()
    #expect(model.errorMessage == nil)
    await server.fail(cancelledRequest, CancellationError())
    await cancelled.value
    #expect(model.errorMessage == nil && !model.isLoading)
}

@MainActor
@Test func cancelledBeforeEntryCannotSupersedeCurrentWork() async {
    let server = ControlledServer()
    let model = LibraryModel()
    model.setServer(server)
    let active = Task { await model.search("current") }
    let request = await server.nextRequest()
    let selection = Task { await model.loadTracks(album: album("current")) }
    let trackRequest = await server.nextRequest()
    // Main-actor tasks cannot enter the model before these synchronous cancellations.
    let cancelled = Task {
        await model.search("obsolete")
        await model.reload()
        await model.loadMore()
        await model.loadTracks(album: album("obsolete"))
    }
    cancelled.cancel()
    await cancelled.value
    #expect(await server.callCount == 2)
    #expect(model.query == "current" && model.isLoading)
    await server.finish(request, .albums([album("current")]))
    await server.finish(trackRequest, .tracks([track("current-track")]))
    await active.value
    await selection.value
    #expect(await server.cancelled.isEmpty)
    #expect(model.albums == [album("current")])
    #expect(model.tracks == [track("current-track")])
    #expect(!model.isLoading && model.errorMessage == nil)
}
