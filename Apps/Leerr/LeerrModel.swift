import Foundation
import LeerrCore
import Observation

/// Shared-server composition root. Legacy service credentials remain untouched.
@MainActor @Observable
final class LeerrModel {
    let connection = ConnectionSession()
    let library = LibraryModel()
    let playback = PlaybackController()
    var endpoint = UserDefaults.standard.string(forKey: "leerr.shared.origin") ?? ""
    var username = ""
    var password = ""
    private(set) var user: LeerrUser?
    private(set) var connections: LeerrConnections?
    private(set) var requests: [LeerrRequest] = []
    private(set) var candidates: [LeerrResolveItem] = []
    private(set) var editions: [LeerrEdition] = []
    private(set) var selectedCandidate: LeerrResolveItem?
    private(set) var isWorking = false
    private(set) var message: String?
    private(set) var sessionID = UUID()
    @ObservationIgnored private let sessions = LeerrSessionStore()
    @ObservationIgnored private var api: LeerrAPI?
    @ObservationIgnored private var work: Task<Void, Never>?
    @ObservationIgnored private var authWork: Task<Void, Never>?
    @ObservationIgnored private var playWork: Task<Void, Never>?

    func signIn() async {
        disconnect()
        let generation = sessionID
        isWorking = true
        let task = Task { await signIn(generation: generation) }
        authWork = task
        await task.value
        if generation == sessionID { authWork = nil }
    }

    private func signIn(generation: UUID) async {
        defer { if generation == sessionID { isWorking = false } }
        do {
            let address = try ServerEndpoint(endpoint.trimmingCharacters(in: .whitespacesAndNewlines))
            let session = try await LeerrAPI.login(endpoint: address, username: username, password: password,
                name: ProcessInfo.processInfo.hostName)
            guard generation == sessionID, !Task.isCancelled else { return }
            let client = LeerrAPI(endpoint: address, token: session.token)
            guard await connection.connect(to: client) else {
                guard generation == sessionID, !Task.isCancelled else { return }
                message = "Leerr accepted the login, but the device session could not connect. \(connection.errorMessage ?? "Check the server response and try again.")"
                return
            }
            guard generation == sessionID, !Task.isCancelled else { return }
            try sessions.save(token: session.token, origin: client.origin.absoluteString)
            guard generation == sessionID, !Task.isCancelled else { return }
            api = client; user = session.user; password = ""; endpoint = client.origin.absoluteString
            UserDefaults.standard.set(endpoint, forKey: "leerr.shared.origin")
            library.setServer(client)
            await library.reload()
            guard generation == sessionID, !Task.isCancelled else { return }
            await refreshSharedState(generation: generation, client: client)
        } catch {
            guard generation == sessionID else { return }
            disconnect()
            message = signInErrorMessage(error)
        }
    }

    func restoreSession() async {
        guard !endpoint.isEmpty, connection.server == nil else { return }
        let generation = sessionID
        let task = Task { await restoreSession(generation: generation) }
        authWork = task
        await task.value
        if generation == sessionID { authWork = nil }
    }

    private func restoreSession(generation: UUID) async {
        do {
            let address = try ServerEndpoint(endpoint)
            let probe = LeerrAPI(endpoint: address, token: "")
            guard let saved = try sessions.load(origin: probe.origin.absoluteString) else { return }
            let client = LeerrAPI(endpoint: address, token: saved.token)
            let restoredUser = try await client.me()
            guard generation == sessionID, !Task.isCancelled else { return }
            guard await connection.connect(to: client) else {
                guard generation == sessionID, !Task.isCancelled else { return }
                message = "The saved Leerr session was found, but could not reconnect. \(connection.errorMessage ?? "Check the server response and sign in again.")"
                return
            }
            guard generation == sessionID, !Task.isCancelled else { return }
            user = restoredUser; api = client; library.setServer(client)
            await library.reload()
            guard generation == sessionID, !Task.isCancelled else { return }
            await refreshSharedState(generation: generation, client: client)
        } catch {
            guard generation == sessionID else { return }
            disconnect()
            if error as? LeerrAPIError == .authentication {
                message = "Saved Leerr session expired. Sign in again."
            } else if error is ServerEndpoint.ValidationError {
                message = signInErrorMessage(error)
            } else {
                message = "The saved Leerr session could not be restored. \((error as? LocalizedError)?.errorDescription ?? "Check that this is a compatible Leerr server, then sign in again.")"
            }
        }
    }

    func disconnect() {
        sessionID = UUID(); authWork?.cancel(); authWork = nil; work?.cancel(); work = nil; playWork?.cancel(); playWork = nil
        playback.stop(); library.setServer(nil); connection.disconnect(); api = nil
        user = nil; connections = nil; requests = []; candidates = []; editions = []; selectedCandidate = nil
        isWorking = false; message = nil
    }

    func logout() {
        let client = api
        let origin = client?.origin.absoluteString
        var keychainError: Error?
        if let client, let origin {
            do {
                if try sessions.load(origin: origin)?.token == client.token {
                    try sessions.delete(origin: origin)
                }
            }
            catch { keychainError = error }
        }
        disconnect()
        let generation = sessionID
        if keychainError != nil { message = "The saved Leerr session could not be removed." }
        Task {
            do { try await client?.logout() }
            catch {
                guard generation == self.sessionID else { return }
                self.message = "Signed out locally, but the server session could not be ended."
            }
        }
    }

    func refreshSharedState() async {
        guard let api else { return }
        await refreshSharedState(generation: sessionID, client: api)
    }

    private func refreshSharedState(generation: UUID, client: LeerrAPI) async {
        do {
            let value = try await client.connections()
            guard generation == sessionID, !Task.isCancelled else { return }
            connections = value
        } catch {
            guard generation == sessionID, !Task.isCancelled else { return }
            connections = nil
        }
        do {
            let value = try await client.requests()
            guard generation == sessionID, !Task.isCancelled else { return }
            requests = value
        } catch {
            // Leerr authentication and library access do not depend on an
            // available upstream request service.
        }
    }

    func discover(query: String = "") {
        perform(operation: { api in
            if query.isEmpty { return try await api.recommendations() }
            return try await api.resolve(query: query)
        }, publish: { self.candidates = $0 })
    }

    func choose(_ candidate: LeerrResolveItem) {
        perform(operation: { api in try await api.editions(groupID: candidate.id) }, publish: {
            self.selectedCandidate = candidate; self.editions = $0
        })
    }

    func request(_ edition: LeerrEdition) {
        guard let selectedCandidate else { return }
        perform(operation: { api in
            try await api.request(releaseGroupMBID: selectedCandidate.id, releaseMBID: edition.id, artistMBID: selectedCandidate.artistMBID)
            return try await api.requests()
        }, publish: { self.requests = $0; self.message = "Request recorded." })
    }

    private func perform<Value>(operation: @escaping @MainActor (LeerrAPI) async throws -> Value,
                                publish: @escaping @MainActor (Value) -> Void) {
        work?.cancel(); guard let api else { return }; let generation = sessionID
        isWorking = true; message = nil
        work = Task {
            defer { if generation == self.sessionID { self.isWorking = false; self.work = nil } }
            do {
                let value = try await operation(api)
                guard generation == self.sessionID, !Task.isCancelled else { return }
                publish(value)
            }
            catch { if generation == self.sessionID, !Task.isCancelled { self.message = (error as? LocalizedError)?.errorDescription } }
        }
    }

    func playAlbum(_ album: Album) async {
        playWork?.cancel()
        guard let api else { return }
        let generation = sessionID
        let task = Task {
            do {
                let tracks = try await api.tracks(in: album.id)
                guard generation == self.sessionID, !Task.isCancelled else { return }
                guard !tracks.isEmpty else {
                    message = "This album has no playable indexed tracks."
                    return
                }
                await playback.start(tracks: tracks, index: 0, server: api)
            } catch {
                guard generation == self.sessionID, !Task.isCancelled else { return }
                message = "Album tracks could not be loaded. Retry from the library."
            }
        }
        playWork = task
        await task.value
        if generation == sessionID { playWork = nil }
    }

    func playTracks(_ tracks: [Track], index: Int, session: UUID) async {
        guard session == sessionID, let api, !Task.isCancelled else { return }
        await playback.start(tracks: tracks, index: index, server: api)
    }

    private func signInErrorMessage(_ error: Error) -> String {
        if let validation = error as? ServerEndpoint.ValidationError {
            switch validation {
            case .invalidURL:
                return "Enter a valid HTTPS origin, for example https://leerr.example.com."
            case .httpsRequired:
                return "Leerr requires an HTTPS origin. Use an address beginning with https://."
            case .embeddedCredentialsOrParameters:
                return "Enter only the HTTPS server origin, without credentials, query parameters, or a fragment."
            }
        }
        if let apiError = error as? LeerrAPIError {
            switch apiError {
            case .authentication:
                return "Leerr rejected the username or password. Check them and try again."
            case .invalidResponse:
                return "The server did not return the expected Leerr protocol response. Check that this is a compatible Leerr server."
            default:
                return apiError.errorDescription ?? "Leerr sign in failed."
            }
        }
        return (error as? LocalizedError)?.errorDescription ?? "Leerr sign in failed. Check the HTTPS origin and try again."
    }
}
