import Foundation
import LeerrCore
import Observation

/// One composition root per process, shared by every native window.
@MainActor @Observable
final class LeerrModel {
    let connection = ConnectionSession()
    let library = LibraryModel()
    let playback = PlaybackController()
    private(set) var serverKind: MusicServerKind = .jellyfin
    var endpoint = ""
    var username = ""
    var password = ""
    var lidarrEndpoint = ""
    var lidarrKey = ""
    var lastFMUsername = ""
    var lastFMKey = ""
    var rootFolder = ""
    var qualityProfile = 0
    var metadataProfile = 0
    private(set) var roots: [LidarrOption] = []
    private(set) var qualities: [LidarrOption] = []
    private(set) var metadataProfiles: [LidarrOption] = []
    private(set) var requests: [AcquisitionRequest] = []
    private(set) var candidates: [DiscoveryCandidate] = []
    private(set) var resolution: DiscoveryResolution?
    private(set) var editions: [MusicBrainzRelease] = []
    private(set) var selectedGroup: MusicBrainzReleaseGroup?
    private(set) var editionOffset: Int?
    private(set) var resolutionOffset = 0
    private(set) var inventory: [Album] = []
    private(set) var isWorking = false
    private(set) var message: String?
    private(set) var acquisitionReady = false
    private(set) var sessionID = UUID()
    @ObservationIgnored private let keychain = KeychainCredentialStore()
    @ObservationIgnored private var coordinator: AcquisitionCoordinator?
    @ObservationIgnored private var indexedLibrary: IndexedMusicLibrary?
    @ObservationIgnored private var workflow: Task<Void, Never>?
    @ObservationIgnored private var draining: [Task<Void, Never>] = []
    @ObservationIgnored private var operationID = UUID()
    @ObservationIgnored private var discovery: DiscoveryService?
    @ObservationIgnored private var albumPlaybackTask: Task<[Track], Error>?
    @ObservationIgnored private var albumPlaybackID = UUID()

    init() {
        let defaults = UserDefaults.standard
        serverKind = defaults.string(forKey: "musicServer.kind").flatMap(MusicServerKind.init(rawValue:))
            ?? (defaults.string(forKey: "navidrome.endpoint") == nil ? .jellyfin : .navidrome)
        endpoint = defaults.string(forKey: serverKind.endpointDefaultsKey) ?? ""
        lidarrEndpoint = UserDefaults.standard.string(forKey: "lidarr.endpoint") ?? ""
        do {
            if let saved = try keychain.load(account: serverKind.credentialAccount(endpoint: endpoint)) {
                username = saved.username
                password = saved.password
            }
            if let saved = try keychain.load(account: "lidarr:" + lidarrEndpoint) { lidarrKey = saved.password }
            if let saved = try keychain.load(account: "lastfm") {
                lastFMUsername = saved.username
                lastFMKey = saved.password
            }
        } catch {
            message = "Saved credentials could not be read from Keychain. Enter them again."
        }
    }

    func selectServer(_ kind: MusicServerKind) {
        guard kind != serverKind else { return }
        disconnect()
        serverKind = kind
        UserDefaults.standard.set(kind.rawValue, forKey: "musicServer.kind")
        endpoint = UserDefaults.standard.string(forKey: kind.endpointDefaultsKey) ?? ""
        username = ""
        password = ""
        do {
            if let saved = try keychain.load(account: kind.credentialAccount(endpoint: endpoint)) {
                username = saved.username
                password = saved.password
            }
        } catch { message = "Saved credentials could not be read from Keychain. Enter them again." }
    }

    func connect() async {
        guard !Task.isCancelled else { return }
        disconnect()
        let account = sessionID
        do {
            let address = try ServerEndpoint(endpoint.trimmingCharacters(in: .whitespacesAndNewlines))
            let credentials = AccountCredentials(username: username, password: password)
            let server: any MusicServer
            switch serverKind {
            case .navidrome:
                server = OpenSubsonicServer(endpoint: address, username: credentials.username, password: credentials.password)
            case .jellyfin:
                let deviceID = UserDefaults.standard.string(forKey: "jellyfin.deviceID") ?? UUID().uuidString
                UserDefaults.standard.set(deviceID, forKey: "jellyfin.deviceID")
                server = JellyfinServer(endpoint: address, username: credentials.username,
                    password: credentials.password, deviceID: deviceID)
            }
            guard await connection.connect(to: server), account == sessionID else { return }
            try keychain.save(credentials, account: serverKind.credentialAccount(endpoint: address.baseURL.absoluteString))
            endpoint = address.baseURL.absoluteString
            UserDefaults.standard.set(endpoint, forKey: serverKind.endpointDefaultsKey)
            UserDefaults.standard.set(serverKind.rawValue, forKey: "musicServer.kind")
            indexedLibrary = IndexedMusicLibrary(server: server)
            library.setServer(server)
            await library.reload()
        } catch {
            guard account == sessionID else { return }
            connection.disconnect()
            message = "Connection configuration or Keychain storage failed. Use a valid HTTPS address and try again."
        }
    }

    func disconnect() {
        sessionID = UUID()
        albumPlaybackID = UUID()
        albumPlaybackTask?.cancel()
        albumPlaybackTask = nil
        operationID = UUID()
        workflow?.cancel()
        if let workflow { draining.append(workflow) }
        workflow = nil
        // Each account receives a new service instance. Old work cannot publish.
        discovery = nil
        coordinator = nil
        indexedLibrary = nil
        acquisitionReady = false
        playback.stop()
        library.setServer(nil)
        connection.disconnect()
        inventory = []
        candidates = []
        requests = []
        resolution = nil
        selectedGroup = nil
        editions = []
        isWorking = false
        message = nil
    }

    func forgetCredentials() {
        disconnect()
        do {
            try keychain.delete(account: serverKind.credentialAccount(endpoint: endpoint))
            try keychain.delete(account: "lidarr:" + lidarrEndpoint)
            try keychain.delete(account: "lastfm")
            username = ""; password = ""; lidarrKey = ""; lastFMUsername = ""; lastFMKey = ""
            message = "Credentials removed from this device. Request history is retained."
        } catch { message = "Keychain could not remove credentials. Please retry." }
    }

    private func makeDiscovery() throws -> DiscoveryService {
        if let discovery { return discovery }
        let musicBrainz = try MusicBrainzClient(userAgent: "Leerr/0.1 (https://ampcode.com/@maxpw/leerr)")
        let service = DiscoveryService(musicBrainz: musicBrainz)
        discovery = service
        return service
    }

    private func perform(_ action: @escaping @MainActor (UUID) async throws -> Void) {
        let previous = workflow
        previous?.cancel()
        let pending = draining
        draining = []
        let id = UUID()
        operationID = id
        isWorking = true
        message = nil
        workflow = Task {
            defer { if self.operationID == id { self.isWorking = false; self.workflow = nil } }
            // A canceled mutation may still be journaling its outcome. Never
            // reopen the same durable store until that writer has settled.
            if let previous { await previous.value }
            for task in pending { await task.value }
            do {
                try Task.checkCancellation()
                guard self.operationID == id else { return }
                try await action(id)
            }
            catch {
                guard self.operationID == id, !Task.isCancelled, !(error is CancellationError) else { return }
                if let coordinator = self.coordinator {
                    let records = await coordinator.requests()
                    guard self.operationID == id else { return }
                    self.requests = records
                }
                self.message = "The service could not complete this operation. Check settings and retry; uncertain requests must be reconciled first."
            }
        }
    }

    func loadLidarrOptions() {
        perform { id in
            let client = LidarrClient(endpoint: try ServerEndpoint(self.lidarrEndpoint), apiKey: self.lidarrKey)
            let roots = try await client.rootFolders()
            let qualities = try await client.qualityProfiles()
            let metadata = try await client.metadataProfiles()
            guard self.operationID == id else { return }
            self.roots = roots; self.qualities = qualities; self.metadataProfiles = metadata
            self.message = "Choose a root folder and both profiles, then enable requests."
        }
    }

    func configureServices() {
        perform { id in
            guard let bridge = self.indexedLibrary else { return }
            let address = try ServerEndpoint(self.lidarrEndpoint)
            let settings = try LidarrSettings(rootFolderPath: self.rootFolder,
                qualityProfileID: self.qualityProfile, metadataProfileID: self.metadataProfile)
            let client = LidarrClient(endpoint: address, apiKey: self.lidarrKey, settings: settings)
            let store = try self.requestStore(lidarr: address)
            let coordinator = AcquisitionCoordinator(store: store, lidarr: client, library: bridge)
            let requests = await coordinator.requests()
            guard self.operationID == id else { return }
            try self.keychain.save(.init(username: "", password: self.lidarrKey), account: "lidarr:" + address.baseURL.absoluteString)
            try self.keychain.save(.init(username: self.lastFMUsername, password: self.lastFMKey), account: "lastfm")
            self.lidarrEndpoint = address.baseURL.absoluteString
            UserDefaults.standard.set(self.lidarrEndpoint, forKey: "lidarr.endpoint")
            self.coordinator = coordinator
            self.requests = requests
            self.acquisitionReady = true
            self.message = "Requests enabled. Refresh statuses after returning to the app."
        }
    }

    func discoverAlbums() {
        perform { id in
            guard let bridge = self.indexedLibrary else { return }
            let service = try self.makeDiscovery()
            let inventory = try await bridge.albums()
            let records: [AcquisitionRequest]
            if let coordinator = self.coordinator { records = await coordinator.requests() }
            else if let address = try? ServerEndpoint(self.lidarrEndpoint) {
                records = await (try self.requestStore(lidarr: address)).requests()
            } else { records = [] }
            let requested = Set(records.map { $0.identity.releaseGroupMBID })
            let candidates = try await service.discover(username: self.lastFMUsername, apiKey: self.lastFMKey,
                ownedReleaseGroupMBIDs: Set(inventory.compactMap(\.releaseGroupMBID)), requestedReleaseGroupMBIDs: requested)
            guard self.operationID == id else { return }
            try self.keychain.save(.init(username: self.lastFMUsername, password: self.lastFMKey), account: "lastfm")
            self.inventory = inventory
            self.requests = records
            self.candidates = candidates
            self.resolution = nil
            self.selectedGroup = nil
            self.editions = []
            if candidates.isEmpty { self.message = "No new recommendations found. Try again after your listening history changes." }
        }
    }

    func resolve(_ candidate: DiscoveryCandidate, more: Bool = false) {
        perform { id in
            let offset = more ? self.resolutionOffset + 25 : 0
            let result = try await self.makeDiscovery().resolve(candidate, offset: offset)
            guard self.operationID == id else { return }
            self.resolution = result
            self.resolutionOffset = offset
            self.selectedGroup = nil
            self.editions = []
        }
    }

    func choose(_ group: MusicBrainzReleaseGroup, more: Bool = false) {
        perform { id in
            let page = try await self.makeDiscovery().releases(releaseGroupMBID: group.id,
                offset: more ? (self.editionOffset ?? 0) : 0)
            guard self.operationID == id else { return }
            self.selectedGroup = group
            self.editions = more ? self.editions + page.releases : page.releases
            self.editionOffset = page.nextOffset
        }
    }

    func request(_ edition: MusicBrainzRelease, artist: MusicBrainzArtist) {
        perform { id in
            guard let coordinator = self.coordinator, let bridge = self.indexedLibrary, let group = self.selectedGroup,
                  edition.releaseGroupMBID == group.id, group.artists.contains(where: { $0.id == artist.id }) else { return }
            let fresh = try await bridge.albums()
            guard self.operationID == id else { return }
            self.inventory = fresh
            if LibraryInventory.album(in: fresh, releaseGroupMBID: group.id) != nil {
                self.message = "This release group is already in your music library. Use the library playback action."
                return
            }
            let identity = try ConfirmedAlbumIdentity(artistMBID: artist.id, releaseGroupMBID: group.id,
                releaseMBID: edition.id, title: edition.title, artist: artist.name, confirmed: true)
            _ = try await coordinator.request(identity)
            let requests = await coordinator.requests()
            guard self.operationID == id else { return }
            self.requests = requests
            self.candidates.removeAll { $0.releaseGroupMBID == group.id }
            self.message = "Request recorded. Refresh to reconcile acquisition and library indexing."
        }
    }

    func refreshRequests() {
        perform { id in
            guard let coordinator = self.coordinator else { return }
            let current = await coordinator.requests()
            var failed = false
            for request in current {
                try Task.checkCancellation()
                do { _ = try await coordinator.reconcile(request.identity) }
                catch is CancellationError { throw CancellationError() }
                catch { failed = true }
            }
            let updated = await coordinator.requests()
            guard self.operationID == id else { return }
            self.requests = updated
            if failed { self.message = "Some requests need attention. Uncertain writes remain recorded; refresh will reconcile them before any retry." }
        }
    }

    func retryFailedSearch(_ request: AcquisitionRequest) {
        perform { id in
            guard let coordinator = self.coordinator else { return }
            _ = try await coordinator.retryFailedSearch(request.identity)
            let records = await coordinator.requests()
            guard self.operationID == id else { return }
            self.requests = records
            self.message = "Search status reconciled. A new search is issued only when the previous failure is confirmed."
        }
    }

    func discoverySettingsChanged() {
        candidates = []; resolution = nil; selectedGroup = nil; editions = []
        discovery = nil
    }

    func lidarrSettingsChanged() {
        guard !acquisitionReady else { return }
        roots = []; qualities = []; metadataProfiles = []
        rootFolder = ""; qualityProfile = 0; metadataProfile = 0
    }

    func playAlbum(_ album: Album) async {
        guard let server = connection.server else { return }
        let account = sessionID
        albumPlaybackTask?.cancel()
        let id = UUID()
        albumPlaybackID = id
        let task = Task { try await server.tracks(in: album.id) }
        albumPlaybackTask = task
        defer { if albumPlaybackID == id { albumPlaybackTask = nil } }
        do {
            let tracks = try await withTaskCancellationHandler { try await task.value } onCancel: { task.cancel() }
            guard account == sessionID, albumPlaybackID == id, !Task.isCancelled, !task.isCancelled else { return }
            guard !tracks.isEmpty else { message = "This album has no playable indexed tracks."; return }
            await playback.start(tracks: tracks, index: 0, server: server)
        } catch {
            guard account == sessionID, albumPlaybackID == id, !Task.isCancelled else { return }
            message = "Album tracks could not be loaded. Retry from the library."
        }
    }

    func playTracks(_ tracks: [Track], index: Int, session: UUID) async {
        guard session == sessionID, let server = connection.server, !Task.isCancelled else { return }
        albumPlaybackID = UUID()
        albumPlaybackTask?.cancel()
        albumPlaybackTask = nil
        await playback.start(tracks: tracks, index: index, server: server)
    }

    func playRequest(_ request: AcquisitionRequest) async {
        guard request.isAvailable, let id = request.indexedAlbumID else { return }
        await playAlbum(Album(id: id, title: request.identity.title, artist: request.identity.artist))
    }

    private func requestStore(lidarr: ServerEndpoint) throws -> AcquisitionRequestStore {
        let directory = try FileManager.default.url(for: .applicationSupportDirectory,
            in: .userDomainMask, appropriateFor: nil, create: true).appendingPathComponent("Leerr/Requests", isDirectory: true)
        let scope = serverKind.requestAccount(endpoint: endpoint, username: username,
            lidarrEndpoint: lidarr.baseURL.absoluteString)
        return try AcquisitionRequestStore(directory: directory, accountID: scope)
    }
}
