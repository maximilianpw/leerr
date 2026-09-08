/// An ordered, non-repeating queue. Duplicate track IDs remain distinct entries.
public struct PlaybackQueue: Equatable, Sendable {
    public private(set) var tracks: [Track] = []
    public private(set) var index: Int?

    public init() {}

    /// Invalid selections clear the queue rather than silently choosing another song.
    public init(tracks: [Track], index: Int) {
        guard tracks.indices.contains(index) else { return }
        self.tracks = tracks
        self.index = index
    }

    public var current: Track? { index.map { tracks[$0] } }
    public var hasNext: Bool { index.map { $0 + 1 < tracks.count } ?? false }
    public var hasPrevious: Bool { index.map { $0 > 0 } ?? false }

    /// At the end, retain the final selection for an explicit replay or retry.
    @discardableResult
    public mutating func next() -> Track? {
        guard hasNext, let index else { return nil }
        self.index = index + 1
        return current
    }

    @discardableResult
    public mutating func previous() -> Track? {
        guard hasPrevious, let index else { return nil }
        self.index = index - 1
        return current
    }
}
