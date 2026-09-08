import Foundation

/// Own one service per discovery UI session. Superseding discovery cancels old
/// discovery/resolution work; cancel on disconnect. No account cache or write API.
public actor DiscoveryService {
    private let lastFM: LastFMClient
    private let musicBrainz: MusicBrainzClient
    private var generation = UUID()
    private var discoveryTask: Task<[DiscoveryCandidate], Error>?
    private var resolutionTask: Task<DiscoveryResolution, Error>?
    private var releaseTask: Task<MusicBrainzReleasePage, Error>?

    public init(lastFM: LastFMClient = LastFMClient(), musicBrainz: MusicBrainzClient) {
        self.lastFM = lastFM
        self.musicBrainz = musicBrainz
    }

    public func cancel() {
        generation = UUID()
        discoveryTask?.cancel()
        resolutionTask?.cancel()
        releaseTask?.cancel()
        discoveryTask = nil
        resolutionTask = nil
        releaseTask = nil
    }

    public func discover(
        username: String, apiKey: String,
        ownedReleaseGroupMBIDs: Set<String> = [],
        requestedReleaseGroupMBIDs: Set<String> = []
    ) async throws -> [DiscoveryCandidate] {
        cancel()
        let generation = self.generation
        let task = Task { [lastFM, musicBrainz] in
            let candidates = try await lastFM.discover(username: username, apiKey: apiKey)
            var canonical: [DiscoveryCandidate] = []
            for candidate in candidates {
                try Task.checkCancellation()
                if case .release = candidate.identity {
                    do {
                        let resolution = try await musicBrainz.resolve(candidate)
                        guard let group = resolution.releaseGroups.first else { throw DiscoveryError.invalidResponse }
                        canonical.append(DiscoveryCandidate(title: group.title, artist: group.artists.map(\.name).joined(separator: ", "),
                                                            identity: .releaseGroup(mbid: group.id), reason: candidate.reason))
                    } catch DiscoveryError.notFound {
                        // Stale Last.fm MBID is not proof of an identity; preserve the suggestion for search.
                        canonical.append(DiscoveryCandidate(title: candidate.title, artist: candidate.artist, reason: candidate.reason))
                    }
                } else { canonical.append(candidate) }
            }
            return DiscoveryFilter.candidates(canonical, ownedReleaseGroupMBIDs: ownedReleaseGroupMBIDs,
                                              requestedReleaseGroupMBIDs: requestedReleaseGroupMBIDs)
        }
        discoveryTask = task
        defer { if self.generation == generation { discoveryTask = nil } }
        return try await withTaskCancellationHandler {
            let result = try await task.value
            try Task.checkCancellation()
            guard self.generation == generation else { throw CancellationError() }
            return result
        } onCancel: { task.cancel() }
    }

    public func resolve(_ candidate: DiscoveryCandidate, offset: Int = 0) async throws -> DiscoveryResolution {
        resolutionTask?.cancel()
        let generation = self.generation
        let task = Task { [musicBrainz] in try await musicBrainz.resolve(candidate, offset: offset) }
        resolutionTask = task
        return try await withTaskCancellationHandler {
            let result = try await task.value
            try Task.checkCancellation()
            guard self.generation == generation, !task.isCancelled else { throw CancellationError() }
            return result
        } onCancel: { task.cancel() }
    }

    public func releases(releaseGroupMBID: String, offset: Int = 0) async throws -> MusicBrainzReleasePage {
        releaseTask?.cancel()
        let generation = self.generation
        let task = Task { [musicBrainz] in try await musicBrainz.releases(releaseGroupMBID: releaseGroupMBID, offset: offset) }
        releaseTask = task
        return try await withTaskCancellationHandler {
            let result = try await task.value
            try Task.checkCancellation()
            guard self.generation == generation, !task.isCancelled else { throw CancellationError() }
            return result
        } onCancel: { task.cancel() }
    }
}
