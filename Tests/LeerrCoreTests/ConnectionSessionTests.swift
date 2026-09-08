import Foundation
import Testing
@testable import LeerrCore

private actor DelayedConnection: MusicServer {
    var continuation: CheckedContinuation<Void, Error>?
    var started = false
    func connect() async throws {
        started = true
        try await withCheckedThrowingContinuation { continuation = $0 }
    }
    func finish(fail: Bool = false) {
        if fail { continuation?.resume(throwing: URLError(.userAuthenticationRequired)) }
        else { continuation?.resume() }
        continuation = nil
    }
    func albums(offset: Int, limit: Int) async throws -> [Album] { [] }
    func searchAlbums(query: String, offset: Int, limit: Int) async throws -> [Album] { [] }
    func tracks(in albumID: String) async throws -> [Track] { [] }
    func originalStreamURL(for trackID: String) async throws -> URL { URL(string: "https://example.test")! }
}

@Test @MainActor func staleConnectionCannotReplaceNewAccount() async {
    let session = ConnectionSession()
    let old = DelayedConnection(), new = DelayedConnection()
    let first = Task { await session.connect(to: old) }
    while !(await old.started) { await Task.yield() }
    let second = Task { await session.connect(to: new) }
    while !(await new.started) { await Task.yield() }
    await new.finish()
    #expect(await second.value)
    await old.finish()
    #expect(!(await first.value))
    #expect(session.server as? DelayedConnection === new)
    #expect(session.errorMessage == nil)
}

@Test @MainActor func disconnectedAttemptCannotReconnect() async {
    let session = ConnectionSession(), server = DelayedConnection()
    let task = Task { await session.connect(to: server) }
    while !(await server.started) { await Task.yield() }
    session.disconnect()
    await server.finish()
    #expect(!(await task.value))
    #expect(session.server == nil)
    #expect(!session.isConnecting)
    #expect(session.errorMessage == nil)
}

@Test @MainActor func failedConnectionShowsSafeRetryMessage() async {
    let session = ConnectionSession(), server = DelayedConnection()
    let task = Task { await session.connect(to: server) }
    while !(await server.started) { await Task.yield() }
    await server.finish(fail: true)
    #expect(!(await task.value))
    #expect(session.errorMessage == "Could not connect. Check the HTTPS address and credentials, then retry.")
    #expect(session.server == nil)
}

@Test @MainActor func preCancelledConnectionCannotDisconnectActiveAccount() async {
    let session = ConnectionSession(), active = DelayedConnection(), canceled = DelayedConnection()
    let connect = Task { await session.connect(to: active) }
    while !(await active.started) { await Task.yield() }
    await active.finish()
    #expect(await connect.value)
    let attempt = Task {
        withUnsafeCurrentTask { $0?.cancel() }
        return await session.connect(to: canceled)
    }
    #expect(!(await attempt.value))
    #expect(session.server as? DelayedConnection === active)
    #expect(!(await canceled.started))
}
