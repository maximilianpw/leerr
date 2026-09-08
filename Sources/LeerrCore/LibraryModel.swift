import Foundation
import Observation

/// In-memory, account-scoped library state. The caller owns connection/authentication.
@MainActor @Observable
public final class LibraryModel {
    public private(set) var albums: [Album] = []
    public private(set) var tracks: [Track] = []
    public private(set) var isLoading = false
    public private(set) var errorMessage: String?
    public private(set) var hasMore = false
    public private(set) var query = ""

    @ObservationIgnored private var server: (any MusicServer)?
    @ObservationIgnored private var albumTask: Task<[Album], Error>?
    @ObservationIgnored private var trackTask: Task<[Track], Error>?
    @ObservationIgnored private var albumRequest = UUID()
    @ObservationIgnored private var trackRequest = UUID()
    @ObservationIgnored private var offset = 0
    private static let pageSize = 50

    public init() {}

    /// Even assigning the same server invalidates work from the previous account session.
    public func setServer(_ server: (any MusicServer)?) {
        reset()
        self.server = server
        query = ""
        hasMore = server != nil
    }

    /// Reloads the current query; use search("") to return to browsing.
    public func reload() async {
        guard !Task.isCancelled else { return }
        reset()
        hasMore = server != nil
        await loadMore()
    }

    public func search(_ query: String) async {
        guard !Task.isCancelled else { return }
        self.query = query.trimmingCharacters(in: .whitespacesAndNewlines)
        await reload()
    }

    public func loadMore() async {
        guard let server, hasMore, albumTask == nil, !Task.isCancelled else { return }
        let request = UUID()
        albumRequest = request
        let offset = offset
        let query = query
        let task = Task {
            if query.isEmpty {
                return try await server.albums(offset: offset, limit: Self.pageSize)
            }
            return try await server.searchAlbums(query: query, offset: offset, limit: Self.pageSize)
        }
        albumTask = task
        isLoading = true
        errorMessage = nil
        defer {
            if albumRequest == request {
                albumTask = nil
                isLoading = trackTask != nil
            }
        }
        do {
            let page = try await withTaskCancellationHandler {
                try await task.value
            } onCancel: {
                task.cancel()
            }
            guard albumRequest == request, !Task.isCancelled else { return }
            self.offset += page.count
            hasMore = !page.isEmpty
            var ids = Set(albums.map(\.id))
            albums.append(contentsOf: page.filter { ids.insert($0.id).inserted })
        } catch {
            guard albumRequest == request, !Task.isCancelled,
                  !(error is CancellationError) else { return }
            errorMessage = "Unable to load albums. Please try again."
        }
    }

    public func loadTracks(album: Album) async {
        guard !Task.isCancelled else { return }
        trackTask?.cancel()
        trackRequest = UUID()
        trackTask = nil
        tracks = []
        errorMessage = nil
        isLoading = albumTask != nil
        guard let server, !Task.isCancelled else { return }
        let request = trackRequest
        let task = Task { try await server.tracks(in: album.id) }
        trackTask = task
        isLoading = true
        defer {
            if trackRequest == request {
                trackTask = nil
                isLoading = albumTask != nil
            }
        }
        do {
            let result = try await withTaskCancellationHandler {
                try await task.value
            } onCancel: {
                task.cancel()
            }
            guard trackRequest == request, !Task.isCancelled else { return }
            tracks = result
        } catch {
            guard trackRequest == request, !Task.isCancelled,
                  !(error is CancellationError) else { return }
            errorMessage = "Unable to load tracks. Please try again."
        }
    }

    private func reset() {
        albumTask?.cancel()
        trackTask?.cancel()
        albumRequest = UUID()
        trackRequest = UUID()
        albumTask = nil
        trackTask = nil
        albums = []
        tracks = []
        offset = 0
        isLoading = false
        errorMessage = nil
    }
}
