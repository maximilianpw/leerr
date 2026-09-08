import Foundation

/// A complete, uncached account snapshot for duplicate checks, not the visible
/// browse/search page. The caller must discard it when its account changes.
public struct LibraryInventory: Sendable {
    private let server: any MusicServer

    public init(server: any MusicServer) { self.server = server }

    public func albums() async throws -> [Album] {
        var result: [Album] = []
        var seen: Set<String> = []
        var offset = 0
        while true {
            try Task.checkCancellation()
            let page = try await server.albums(offset: offset, limit: 500)
            try Task.checkCancellation()
            guard !page.isEmpty else { return result }
            offset += page.count
            result.append(contentsOf: page.filter { seen.insert($0.id).inserted })
        }
    }

    public static func album(in albums: [Album], releaseGroupMBID: String,
                             releaseMBID: String? = nil) -> Album? {
        albums.first {
            $0.releaseGroupMBID?.lowercased() == releaseGroupMBID.lowercased()
                && (releaseMBID == nil || $0.releaseMBID?.lowercased() == releaseMBID?.lowercased())
        }
    }
}
