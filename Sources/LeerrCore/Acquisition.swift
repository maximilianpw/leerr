import Foundation

public enum AcquisitionError: Error, Equatable {
    case confirmationRequired, invalidIdentity, invalidSettings, ambiguousIdentity
    case invalidStore, accountMismatch, busy, uncertainSearch
}

/// MusicBrainz entity types are deliberately separate. Construct only after showing
/// the artist, release group and optional edition to the user for confirmation.
public struct ConfirmedAlbumIdentity: Codable, Equatable, Sendable {
    public let artistMBID: String
    public let releaseGroupMBID: String
    public let releaseMBID: String?
    public let title: String
    public let artist: String

    public init(artistMBID: String, releaseGroupMBID: String, releaseMBID: String? = nil,
                title: String, artist: String, confirmed: Bool) throws {
        guard confirmed else { throw AcquisitionError.confirmationRequired }
        guard UUID(uuidString: artistMBID) != nil, UUID(uuidString: releaseGroupMBID) != nil,
              releaseMBID.map({ UUID(uuidString: $0) != nil }) ?? true,
              !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !artist.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw AcquisitionError.invalidIdentity
        }
        self.artistMBID = artistMBID.lowercased()
        self.releaseGroupMBID = releaseGroupMBID.lowercased()
        self.releaseMBID = releaseMBID?.lowercased()
        self.title = title
        self.artist = artist
    }
}

public enum AcquisitionStatus: String, Codable, Sendable {
    case requested, acquiring, imported, indexed, failed, uncertain
}

public enum AcquisitionMutation: String, Codable, Sendable { case add, monitor, search }

public struct AcquisitionRequest: Codable, Equatable, Identifiable, Sendable {
    public var id: String { identity.releaseGroupMBID }
    public let identity: ConfirmedAlbumIdentity
    public internal(set) var status: AcquisitionStatus = .requested
    public internal(set) var lidarrAlbumID: Int?
    public internal(set) var pendingMutation: AcquisitionMutation?
    public internal(set) var searchIssued = false
    public internal(set) var searchCommandID: Int?
    /// Consumed failed command: stale reads at/below this ID cannot authorize retry.
    public internal(set) var retriedFailureCommandID: Int?
    public internal(set) var indexedAlbumID: String?
    public var isAvailable: Bool { status == .indexed && indexedAlbumID != nil }
}

/// Implement using authoritative Navidrome metadata, never a title/artist search.
/// Return nil unless the canonical release-group matches and, when specified,
/// release matches too. A release-group globally determines artist ownership;
/// adapters lacking artist MBIDs must not replace that check with fuzzy names.
/// A Lidarr import or a local file path is not indexing evidence.
public protocol AcquisitionLibrary: Sendable {
    func indexedAlbumID(for identity: ConfirmedAlbumIdentity) async throws -> String?
}

/// One store/coordinator per account in the app composition root. accountID must
/// be an opaque non-secret identifier covering both Navidrome and Lidarr accounts.
/// Atomic versioned JSON replaces a single account file; unsupported/corrupt data
/// fails closed rather than erasing the write journal. No API keys or
/// authenticated stream URLs are stored.
public actor AcquisitionRequestStore {
    private struct Document: Codable {
        var version = 1
        let accountID: String
        var requests: [AcquisitionRequest]
    }
    private let file: URL
    private var document: Document

    public init(directory: URL, accountID: String) throws {
        guard !accountID.isEmpty else { throw AcquisitionError.accountMismatch }
        let name = accountID.utf8.map { String(format: "%02x", $0) }.joined()
        var accountDirectory = directory.appendingPathComponent("acquisition")
        // Chunk the reversible account key to stay below filesystem name limits.
        var remainder = name[...]
        while !remainder.isEmpty {
            accountDirectory.appendPathComponent(String(remainder.prefix(100)))
            remainder = remainder.dropFirst(100)
        }
        file = accountDirectory.appendingPathComponent("requests.json")
        try FileManager.default.createDirectory(at: accountDirectory, withIntermediateDirectories: true)
        if FileManager.default.fileExists(atPath: file.path) {
            let loaded = try JSONDecoder().decode(Document.self, from: Data(contentsOf: file))
            guard loaded.version == 1 else { throw AcquisitionError.invalidStore }
            guard loaded.accountID == accountID else { throw AcquisitionError.accountMismatch }
            guard Set(loaded.requests.map(\.id)).count == loaded.requests.count else {
                throw AcquisitionError.invalidStore
            }
            for request in loaded.requests {
                let identity = request.identity
                let validated = try ConfirmedAlbumIdentity(artistMBID: identity.artistMBID,
                    releaseGroupMBID: identity.releaseGroupMBID, releaseMBID: identity.releaseMBID,
                    title: identity.title, artist: identity.artist, confirmed: true)
                guard validated == identity,
                      request.searchCommandID.map({ $0 > 0 }) ?? true,
                      request.retriedFailureCommandID.map({ $0 > 0 }) ?? true,
                      request.pendingMutation == nil || request.status == .uncertain else {
                    throw AcquisitionError.invalidStore
                }
            }
            document = loaded
        } else {
            document = Document(accountID: accountID, requests: [])
        }
    }

    public func requests() -> [AcquisitionRequest] { document.requests }

    func save(_ request: AcquisitionRequest) throws {
        var next = document
        next.requests.removeAll { $0.id == request.id }
        next.requests.append(request)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        try encoder.encode(next).write(to: file, options: .atomic)
        document = next
    }
}

/// UI integration: await request(_:), reconcile(_:) on resume/retry, and requests()
/// to refresh displayed rows. Construct a new coordinator/store when accounts
/// change; cancel old work and discard its results. No background polling promised.
/// Actor reentrancy is gated so overlapping taps cannot perform duplicate writes.
public actor AcquisitionCoordinator {
    private let store: AcquisitionRequestStore
    private let lidarr: any LidarrService
    private let library: any AcquisitionLibrary
    private var working = false

    public init(store: AcquisitionRequestStore, lidarr: any LidarrService, library: any AcquisitionLibrary) {
        self.store = store
        self.lidarr = lidarr
        self.library = library
    }

    public func requests() async -> [AcquisitionRequest] { await store.requests() }

    @discardableResult
    public func request(_ identity: ConfirmedAlbumIdentity) async throws -> AcquisitionRequest {
        guard !working else { throw AcquisitionError.busy }
        working = true
        defer { working = false }
        let existing = await store.requests().first { $0.id == identity.releaseGroupMBID }
        if let existing {
            guard existing.identity.artistMBID == identity.artistMBID,
                  existing.identity.releaseMBID == identity.releaseMBID else {
                throw AcquisitionError.ambiguousIdentity
            }
            return try await advance(existing)
        }
        let request = AcquisitionRequest(identity: identity)
        try await store.save(request)
        return try await advance(request)
    }

    @discardableResult
    public func reconcile(_ identity: ConfirmedAlbumIdentity) async throws -> AcquisitionRequest {
        try await request(identity)
    }

    /// Explicit user intent only. Re-reads the latest command; only failed/aborted
    /// authorize one retry. Active/completed/absent/uncertain evidence never does.
    /// Repeated taps return current state; the consumed failure ID survives crashes.
    @discardableResult
    public func retryFailedSearch(_ identity: ConfirmedAlbumIdentity) async throws -> AcquisitionRequest {
        guard !working else { throw AcquisitionError.busy }
        working = true
        defer { working = false }
        guard let row = await store.requests().first(where: { $0.id == identity.releaseGroupMBID }),
              row.identity.artistMBID == identity.artistMBID,
              row.identity.releaseMBID == identity.releaseMBID else { throw AcquisitionError.ambiguousIdentity }
        guard row.status == .failed, row.searchIssued, row.pendingMutation == nil else { return row }
        return try await advance(row, retryFailedSearch: true)
    }

    private func advance(_ original: AcquisitionRequest, retryFailedSearch: Bool = false) async throws -> AcquisitionRequest {
        var row = original
        do {
            try Task.checkCancellation()
            if let id = try await library.indexedAlbumID(for: row.identity) {
                row.indexedAlbumID = id
                row.status = .indexed
                row.pendingMutation = nil
                try await store.save(row)
                return row
            }
            row.indexedAlbumID = nil
            // Always reconcile reads, including after a process died during a write.
            var album = try await lidarr.findAlbum(row.identity)
            if album == nil && (row.pendingMutation == .search || row.searchIssued) {
                throw AcquisitionError.uncertainSearch
            }
            if album == nil {
                let candidate = try await lidarr.lookup(row.identity)
                try await journal(.add, row: &row)
                try await lidarr.add(candidate)
                // A successful write isn't evidence that metadata is visible yet.
                guard let found = try await lidarr.findAlbum(row.identity) else { return row }
                album = found
            }
            guard let current = album else { return row }
            row.lidarrAlbumID = current.id
            if row.pendingMutation != .search { row.pendingMutation = nil }
            if !current.monitored && row.pendingMutation != .search {
                try await journal(.monitor, row: &row)
                try await lidarr.monitor(current, identity: row.identity)
                row.pendingMutation = nil
            }
            if current.imported {
                row.status = .imported
                row.pendingMutation = nil
            } else {
                try await reconcileSearch(albumID: current.id, row: &row, retryFailedSearch: retryFailedSearch)
            }
            try await store.save(row)
            return row
        } catch {
            // Retain pending intent even for cancellation: the server may have
            // accepted the request before the local task was interrupted.
            row.status = row.pendingMutation == nil ? .failed : .uncertain
            try await store.save(row)
            throw error
        }
    }

    private func reconcileSearch(albumID: Int, row: inout AcquisitionRequest, retryFailedSearch: Bool) async throws {
        let floor = max(row.retriedFailureCommandID ?? 0, (row.searchCommandID ?? 1) - 1)
        let command = try await lidarr.latestSearch(for: albumID, afterCommandID: floor)
        if let command {
            row.searchIssued = true
            row.searchCommandID = command.id
            row.pendingMutation = nil
            switch command.status {
            case .failed, .aborted:
                row.status = .failed
                guard retryFailedSearch else { return }
                // Consume this exact failure BEFORE retrying; even a stale GET
                // after restart cannot mistake it for the outcome of the retry.
                row.retriedFailureCommandID = command.id
                row.searchCommandID = nil
                row.searchIssued = false
            case .queued, .started, .completed:
                row.status = .acquiring
                return
            case .cancelled, .orphaned, .unknown:
                row.status = .uncertain
                return
            }
        } else {
            if row.pendingMutation == .search { throw AcquisitionError.uncertainSearch }
            if row.searchIssued {
                // Retention is not evidence of success or a reason to retry.
                if row.status != .failed && row.status != .uncertain { row.status = .acquiring }
                return
            }
            if retryFailedSearch { return }
        }
        try await journal(.search, row: &row)
        let id = try await lidarr.search(albumID: albumID)
        guard id > (row.retriedFailureCommandID ?? 0) else { throw AcquisitionError.uncertainSearch }
        row.searchCommandID = id
        row.searchIssued = true
        row.pendingMutation = nil
        row.status = .acquiring
    }

    private func journal(_ mutation: AcquisitionMutation, row: inout AcquisitionRequest) async throws {
        try Task.checkCancellation()
        row.pendingMutation = mutation
        row.status = .uncertain
        try await store.save(row) // MUST complete before any network mutation.
    }
}
