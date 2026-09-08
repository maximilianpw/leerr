import Foundation
import Testing
@testable import LeerrCore

private actor InventoryServer: MusicServer {
    var offsets: [Int] = []
    func connect() async throws {}
    func albums(offset: Int, limit: Int) async throws -> [Album] {
        offsets.append(offset)
        let first = Album(id: "one", title: "Same name", artist: "Artist", releaseGroupMBID: "group-a")
        switch offset {
        case 0: return [first, first]
        case 2: return [Album(id: "two", title: "Same name", artist: "Artist", releaseGroupMBID: "group-b", releaseMBID: "edition-b")]
        default: return []
        }
    }
    func searchAlbums(query: String, offset: Int, limit: Int) async throws -> [Album] { [] }
    func tracks(in albumID: String) async throws -> [Track] { [] }
    func originalStreamURL(for trackID: String) async throws -> URL { throw CancellationError() }
}

@Test func completeInventoryUsesRawOffsetsAndExactEdition() async throws {
    let server = InventoryServer()
    let albums = try await LibraryInventory(server: server).albums()
    #expect(await server.offsets == [0, 2, 3])
    #expect(albums.map(\.id) == ["one", "two"])
    #expect(LibraryInventory.album(in: albums, releaseGroupMBID: "GROUP-B")?.id == "two")
    #expect(LibraryInventory.album(in: albums, releaseGroupMBID: "group-b", releaseMBID: "edition-b")?.id == "two")
    #expect(LibraryInventory.album(in: albums, releaseGroupMBID: "group-b", releaseMBID: "edition-c") == nil)
    #expect(LibraryInventory.album(in: albums, releaseGroupMBID: "group-c") == nil)
    #expect(LibraryInventory.album(in: albums, releaseGroupMBID: "group-a", releaseMBID: "edition-b") == nil)
}
