import Foundation
import Testing
@testable import LeerrCore

private let acquisitionIdentity = try! ConfirmedAlbumIdentity(
    artistMBID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    releaseGroupMBID: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    title: "Confirmed album", artist: "Confirmed artist", confirmed: true)

private actor IndexedFixture: AcquisitionLibrary {
    var indexed: String?
    func set(_ value: String?) { indexed = value }
    func indexedAlbumID(for identity: ConfirmedAlbumIdentity) -> String? { indexed }
}

private actor AcquisitionLidarrFixture: LidarrService {
    var album: LidarrAlbum?
    var command: LidarrSearchCommand?
    var nextCommandID = 41
    var failAdd = false
    var failSearch = false
    var calls: [String] = []
    let directory: URL
    init(directory: URL) { self.directory = directory }
    func configure(existing: Bool = false, imported: Bool = false, failAdd: Bool = false, failSearch: Bool = false) {
        if existing { album = LidarrAlbum(id: 31, monitored: false, imported: imported, resource: Data()) }
        self.failAdd = failAdd
        self.failSearch = failSearch
    }
    func findAlbum(_ identity: ConfirmedAlbumIdentity) -> LidarrAlbum? { calls.append("read"); return album }
    func lookup(_ identity: ConfirmedAlbumIdentity) -> LidarrCandidate { calls.append("lookup"); return LidarrCandidate(resource: Data()) }
    func checkJournal(_ mutation: AcquisitionMutation) async throws {
        // Reopen disk at mutation entry, not the coordinator's in-memory store.
        let disk = try AcquisitionRequestStore(directory: directory, accountID: "account")
        let row = await disk.requests().first
        #expect(row?.status == .uncertain)
        #expect(row?.pendingMutation == mutation)
        if mutation == .search && nextCommandID == 42 {
            #expect(row?.retriedFailureCommandID == 41)
            #expect(row?.searchIssued == false)
        }
    }
    func add(_ candidate: LidarrCandidate) async throws {
        try await checkJournal(.add)
        calls.append("add")
        album = LidarrAlbum(id: 31, monitored: true, imported: false, resource: Data())
        if failAdd { throw LidarrError.transport }
    }
    func monitor(_ album: LidarrAlbum, identity: ConfirmedAlbumIdentity) async throws {
        try await checkJournal(.monitor)
        calls.append("monitor")
        self.album = LidarrAlbum(id: album.id, monitored: true, imported: album.imported, resource: Data())
    }
    func latestSearch(for albumID: Int, afterCommandID: Int?) -> LidarrSearchCommand? {
        calls.append("readSearch")
        guard let command, command.id > (afterCommandID ?? 0) else { return nil }
        return command
    }
    func search(albumID: Int) async throws -> Int {
        try await checkJournal(.search)
        calls.append("search")
        let id = nextCommandID
        nextCommandID += 1
        command = LidarrSearchCommand(id: id, status: .queued)
        if failSearch { throw LidarrError.transport }
        return id
    }
    func forgetSearch() { command = nil }
    func setCommand(_ command: LidarrSearchCommand?) { self.command = command }
    func setSearchFailure(_ value: Bool) { failSearch = value }
}

@Test func acquisitionConfirmationAndIdentityAreRequired() {
    #expect(throws: AcquisitionError.confirmationRequired) {
        try ConfirmedAlbumIdentity(artistMBID: acquisitionIdentity.artistMBID,
            releaseGroupMBID: acquisitionIdentity.releaseGroupMBID, title: "Album", artist: "Artist", confirmed: false)
    }
    #expect(throws: AcquisitionError.invalidIdentity) {
        try ConfirmedAlbumIdentity(artistMBID: "a name", releaseGroupMBID: "album name", title: "Album", artist: "Artist", confirmed: true)
    }
}

@Test func acquisitionCrashReconcilesAcceptedAddWithoutDuplicate() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let store = try AcquisitionRequestStore(directory: directory, accountID: "account")
    let service = AcquisitionLidarrFixture(directory: directory)
    await service.configure(failAdd: true)
    let library = IndexedFixture()
    let tracker = AcquisitionCoordinator(store: store, lidarr: service, library: library)
    await #expect(throws: LidarrError.transport) { try await tracker.request(acquisitionIdentity) }
    let recoveredStore = try AcquisitionRequestStore(directory: directory, accountID: "account")
    #expect(await recoveredStore.requests().first?.pendingMutation == .add)
    let resumed = AcquisitionCoordinator(store: recoveredStore, lidarr: service, library: library)
    let result = try await resumed.reconcile(acquisitionIdentity)
    #expect(result.status == .acquiring)
    #expect(!result.isAvailable)
    _ = try await resumed.request(acquisitionIdentity)
    let calls = await service.calls
    #expect(calls.filter { $0 == "add" }.count == 1)
    #expect(calls.filter { $0 == "search" }.count == 1)
    #expect(calls.first == "read")
}

@Test(arguments: [true, false])
func acquisitionSearchTimeoutReconcilesAndMissingEvidenceNeverRetries(evidencePresent: Bool) async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let service = AcquisitionLidarrFixture(directory: directory)
    await service.configure(existing: true, failSearch: true)
    let tracker = AcquisitionCoordinator(store: try AcquisitionRequestStore(directory: directory, accountID: "account"),
                                         lidarr: service, library: IndexedFixture())
    await #expect(throws: LidarrError.transport) { try await tracker.request(acquisitionIdentity) }
    let recovered = try AcquisitionRequestStore(directory: directory, accountID: "account")
    #expect(await recovered.requests().first?.pendingMutation == .search)
    let resumed = AcquisitionCoordinator(store: recovered, lidarr: service, library: IndexedFixture())
    if evidencePresent {
        let row = try await resumed.reconcile(acquisitionIdentity)
        #expect(row.status == .acquiring)
        #expect(row.pendingMutation == nil)
    } else {
        await service.forgetSearch()
        await #expect(throws: AcquisitionError.uncertainSearch) { try await resumed.reconcile(acquisitionIdentity) }
        #expect(await resumed.requests().first?.status == .uncertain)
    }
    #expect(await service.calls.filter { $0 == "search" }.count == 1)
    #expect(await service.calls.filter { $0 == "add" }.isEmpty == true)
}

@Test func acquisitionImportedIsNotAvailableAndIndexedSkipsWrites() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let service = AcquisitionLidarrFixture(directory: directory)
    await service.configure(existing: true, imported: true)
    let library = IndexedFixture()
    let tracker = AcquisitionCoordinator(store: try AcquisitionRequestStore(directory: directory, accountID: "account"),
                                         lidarr: service, library: library)
    let imported = try await tracker.request(acquisitionIdentity)
    #expect(imported.status == .imported)
    #expect(!imported.isAvailable)
    #expect(await service.calls == ["read", "monitor"])
    await library.set("navidrome-opaque-id")
    let indexed = try await tracker.reconcile(acquisitionIdentity)
    #expect(indexed.isAvailable)
    #expect(indexed.indexedAlbumID == "navidrome-opaque-id")
    #expect(await service.calls == ["read", "monitor"])
}

@Test func acquisitionStoreSeparatesAccountsAndRejectsFutureSchema() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let account = String(repeating: "non-secret-endpoint/username", count: 12)
    let store = try AcquisitionRequestStore(directory: directory, accountID: account)
    try await store.save(AcquisitionRequest(identity: acquisitionIdentity))
    let reopened = try AcquisitionRequestStore(directory: directory, accountID: account)
    #expect(await reopened.requests().map(\.identity) == [acquisitionIdentity])
    let other = try AcquisitionRequestStore(directory: directory, accountID: "other")
    #expect(await other.requests().isEmpty)
    let files = FileManager.default.enumerator(at: directory, includingPropertiesForKeys: nil)!
    let file = try #require(files.compactMap { $0 as? URL }.first { $0.lastPathComponent == "requests.json" })
    let text = try String(contentsOf: file, encoding: .utf8)
    #expect(!text.contains("apiKey"))
    try text.replacingOccurrences(of: "\"version\":1", with: "\"version\":99").write(to: file, atomically: true, encoding: .utf8)
    #expect(throws: AcquisitionError.invalidStore) { try AcquisitionRequestStore(directory: directory, accountID: account) }
}

@Test(arguments: [LidarrSearchStatus.failed, .aborted])
func acquisitionKnownFailureRequiresExplicitRetryAndConsumesFailureID(status: LidarrSearchStatus) async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let service = AcquisitionLidarrFixture(directory: directory)
    await service.configure(existing: true)
    let store = try AcquisitionRequestStore(directory: directory, accountID: "account")
    let tracker = AcquisitionCoordinator(store: store, lidarr: service, library: IndexedFixture())
    #expect(try await tracker.request(acquisitionIdentity).searchCommandID == 41)
    await service.setCommand(LidarrSearchCommand(id: 41, status: status))
    let failed = try await tracker.reconcile(acquisitionIdentity)
    #expect(failed.status == .failed)
    #expect(failed.pendingMutation == nil)
    _ = try await tracker.request(acquisitionIdentity)
    #expect(await service.calls.filter { $0 == "search" }.count == 1)
    let retried = try await tracker.retryFailedSearch(acquisitionIdentity)
    #expect(retried.status == .acquiring)
    #expect(retried.searchCommandID == 42)
    #expect(retried.retriedFailureCommandID == 41)
    let reopened = try AcquisitionRequestStore(directory: directory, accountID: "account")
    #expect(await reopened.requests().first?.retriedFailureCommandID == 41)
    let resumed = AcquisitionCoordinator(store: reopened, lidarr: service, library: IndexedFixture())
    // Even after restart, stale failure evidence cannot authorize a second retry.
    await service.setCommand(LidarrSearchCommand(id: 41, status: status))
    #expect(try await resumed.reconcile(acquisitionIdentity).status == .acquiring)
    _ = try await resumed.retryFailedSearch(acquisitionIdentity)
    #expect(await service.calls.filter { $0 == "search" }.count == 2)
}

@Test(arguments: [LidarrSearchStatus.queued, .started, .completed])
func acquisitionActiveOrCompletedSearchNeverRepeats(status: LidarrSearchStatus) async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let service = AcquisitionLidarrFixture(directory: directory)
    await service.configure(existing: true)
    let tracker = AcquisitionCoordinator(store: try AcquisitionRequestStore(directory: directory, accountID: "account"),
                                         lidarr: service, library: IndexedFixture())
    _ = try await tracker.request(acquisitionIdentity)
    await service.setCommand(LidarrSearchCommand(id: 41, status: .failed))
    #expect(try await tracker.reconcile(acquisitionIdentity).status == .failed)
    // Fresh read supersedes the UI's stale failed row.
    await service.setCommand(LidarrSearchCommand(id: 42, status: status))
    #expect(try await tracker.retryFailedSearch(acquisitionIdentity).status == .acquiring)
    #expect(try await tracker.reconcile(acquisitionIdentity).status == .acquiring)
    #expect(await service.calls.filter { $0 == "search" }.count == 1)
}

@Test func acquisitionMissingFailureHistoryCannotAuthorizeRetry() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let service = AcquisitionLidarrFixture(directory: directory)
    await service.configure(existing: true)
    let tracker = AcquisitionCoordinator(store: try AcquisitionRequestStore(directory: directory, accountID: "account"),
                                         lidarr: service, library: IndexedFixture())
    _ = try await tracker.request(acquisitionIdentity)
    await service.setCommand(LidarrSearchCommand(id: 41, status: .failed))
    _ = try await tracker.reconcile(acquisitionIdentity)
    await service.forgetSearch()
    #expect(try await tracker.retryFailedSearch(acquisitionIdentity).status == .failed)
    #expect(try await tracker.reconcile(acquisitionIdentity).status == .failed)
    #expect(await service.calls.filter { $0 == "search" }.count == 1)
}

@Test(arguments: [LidarrSearchStatus.cancelled, .orphaned, .unknown])
func acquisitionUnprovenCommandOutcomeRemainsUncertain(status: LidarrSearchStatus) async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let service = AcquisitionLidarrFixture(directory: directory)
    await service.configure(existing: true)
    let tracker = AcquisitionCoordinator(store: try AcquisitionRequestStore(directory: directory, accountID: "account"),
                                         lidarr: service, library: IndexedFixture())
    _ = try await tracker.request(acquisitionIdentity)
    await service.setCommand(LidarrSearchCommand(id: 41, status: status))
    #expect(try await tracker.reconcile(acquisitionIdentity).status == .uncertain)
    #expect(try await tracker.retryFailedSearch(acquisitionIdentity).status == .uncertain)
    #expect(await service.calls.filter { $0 == "search" }.count == 1)
}

@Test func acquisitionUncertainRetryCannotReuseConsumedFailureAfterCrash() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let service = AcquisitionLidarrFixture(directory: directory)
    await service.configure(existing: true)
    let tracker = AcquisitionCoordinator(store: try AcquisitionRequestStore(directory: directory, accountID: "account"),
                                         lidarr: service, library: IndexedFixture())
    _ = try await tracker.request(acquisitionIdentity)
    await service.setCommand(LidarrSearchCommand(id: 41, status: .failed))
    _ = try await tracker.reconcile(acquisitionIdentity)
    await service.setSearchFailure(true)
    await #expect(throws: LidarrError.transport) { try await tracker.retryFailedSearch(acquisitionIdentity) }
    let reopened = try AcquisitionRequestStore(directory: directory, accountID: "account")
    #expect(await reopened.requests().first?.pendingMutation == .search)
    #expect(await reopened.requests().first?.retriedFailureCommandID == 41)
    let resumed = AcquisitionCoordinator(store: reopened, lidarr: service, library: IndexedFixture())
    await service.setCommand(LidarrSearchCommand(id: 41, status: .failed))
    await #expect(throws: AcquisitionError.uncertainSearch) { try await resumed.reconcile(acquisitionIdentity) }
    #expect(try await resumed.retryFailedSearch(acquisitionIdentity).status == .uncertain)
    #expect(await service.calls.filter { $0 == "search" }.count == 2)
    // A definite failure of the NEW command resolves uncertainty, without retry.
    await service.setCommand(LidarrSearchCommand(id: 42, status: .failed))
    let resolved = try await resumed.reconcile(acquisitionIdentity)
    #expect(resolved.status == .failed)
    #expect(resolved.pendingMutation == nil)
    #expect(await service.calls.filter { $0 == "search" }.count == 2)
}

@Test(arguments: [0, -1, Int.min])
func acquisitionStoreRejectsCorruptCommandCursors(cursor: Int) async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let store = try AcquisitionRequestStore(directory: directory, accountID: "cursor")
    for field in 0..<2 {
        var row = AcquisitionRequest(identity: acquisitionIdentity)
        if field == 0 { row.searchCommandID = cursor }
        else { row.retriedFailureCommandID = cursor }
        try await store.save(row)
        #expect(throws: AcquisitionError.invalidStore) {
            try AcquisitionRequestStore(directory: directory, accountID: "cursor")
        }
    }
}
