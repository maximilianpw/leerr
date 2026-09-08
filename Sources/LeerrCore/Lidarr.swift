import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public struct LidarrSettings: Equatable, Sendable {
    public let rootFolderPath: String
    public let qualityProfileID: Int
    public let metadataProfileID: Int

    /// IDs and path must be selected from this server's settings, not defaults.
    public init(rootFolderPath: String, qualityProfileID: Int, metadataProfileID: Int) throws {
        guard rootFolderPath.hasPrefix("/"), qualityProfileID > 0, metadataProfileID > 0 else {
            throw AcquisitionError.invalidSettings
        }
        self.rootFolderPath = rootFolderPath
        self.qualityProfileID = qualityProfileID
        self.metadataProfileID = metadataProfileID
    }
}

public struct LidarrOption: Equatable, Sendable, Identifiable {
    public let id: Int
    public let name: String
}

public struct LidarrAlbum: Sendable {
    public let id: Int
    /// True only if both the album and the confirmed edition are monitored.
    public let monitored: Bool
    public let imported: Bool
    let resource: Data
}

public struct LidarrCandidate: Sendable { let resource: Data }

public enum LidarrSearchStatus: String, Sendable {
    case queued, started, completed, failed, aborted, cancelled, orphaned, unknown
}

public struct LidarrSearchCommand: Equatable, Sendable {
    public let id: Int
    public let status: LidarrSearchStatus
    public init(id: Int, status: LidarrSearchStatus) { self.id = id; self.status = status }
}

public protocol LidarrService: Sendable {
    func findAlbum(_ identity: ConfirmedAlbumIdentity) async throws -> LidarrAlbum?
    func lookup(_ identity: ConfirmedAlbumIdentity) async throws -> LidarrCandidate
    func add(_ candidate: LidarrCandidate) async throws
    func monitor(_ album: LidarrAlbum, identity: ConfirmedAlbumIdentity) async throws
    func latestSearch(for albumID: Int, afterCommandID: Int?) async throws -> LidarrSearchCommand?
    func search(albumID: Int) async throws -> Int
}

public enum LidarrError: Error, Equatable {
    case authentication, transport, invalidResponse, httpStatus(Int), redirectRejected
}

/// Fixture seam intentionally independent of the OpenSubsonic HTTP transport.
/// Implementations must not follow redirects or log authenticated requests.
public protocol LidarrHTTPTransport: Sendable {
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

public final class LidarrURLSessionTransport: NSObject, LidarrHTTPTransport, URLSessionTaskDelegate {
    public override init() { super.init() }

    public func urlSession(_ session: URLSession, task: URLSessionTask,
                           willPerformHTTPRedirection response: HTTPURLResponse,
                           newRequest request: URLRequest,
                           completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil) // Even same-origin redirects are rejected.
    }

    public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw LidarrError.invalidResponse }
        return (data, response)
    }
}

public struct LidarrClient: LidarrService {
    private let endpoint: ServerEndpoint
    private let apiKey: String
    private let settings: LidarrSettings?
    private let transport: any LidarrHTTPTransport

    public init(endpoint: ServerEndpoint, apiKey: String, settings: LidarrSettings? = nil,
                transport: any LidarrHTTPTransport = LidarrURLSessionTransport()) {
        self.endpoint = endpoint
        self.apiKey = apiKey
        self.settings = settings
        self.transport = transport
    }

    public func rootFolders() async throws -> [LidarrOption] { try await options("rootfolder", field: "path") }
    public func qualityProfiles() async throws -> [LidarrOption] { try await options("qualityprofile", field: "name") }
    public func metadataProfiles() async throws -> [LidarrOption] { try await options("metadataprofile", field: "name") }

    private func options(_ path: String, field: String) async throws -> [LidarrOption] {
        try await list(path).map {
            guard let id = $0["id"] as? Int, let name = $0[field] as? String else { throw LidarrError.invalidResponse }
            return LidarrOption(id: id, name: name)
        }
    }

    public func findAlbum(_ identity: ConfirmedAlbumIdentity) async throws -> LidarrAlbum? {
        let values = try await list("album", query: [URLQueryItem(name: "foreignAlbumId", value: identity.releaseGroupMBID)])
        let matches = values.filter { ($0["foreignAlbumId"] as? String)?.lowercased() == identity.releaseGroupMBID }
        guard matches.count <= 1 else { throw AcquisitionError.ambiguousIdentity }
        guard let value = matches.first else { return nil }
        try validate(value, identity: identity)
        guard let id = value["id"] as? Int, id > 0 else { throw LidarrError.invalidResponse }
        let releases = value["releases"] as? [[String: Any]] ?? []
        let editionMonitored = identity.releaseMBID.map { release in
            value["anyReleaseOk"] as? Bool == false &&
            releases.filter { $0["monitored"] as? Bool == true }.count == 1 &&
            releases.contains { ($0["foreignReleaseId"] as? String)?.lowercased() == release && $0["monitored"] as? Bool == true }
        } ?? true
        let statistics = value["statistics"] as? [String: Any]
        let total = statistics?["trackCount"] as? Int ?? 0
        let files = statistics?["trackFileCount"] as? Int ?? 0
        return LidarrAlbum(id: id, monitored: value["monitored"] as? Bool == true && editionMonitored,
                           imported: total > 0 && files >= total && editionMonitored,
                           resource: try JSONSerialization.data(withJSONObject: value))
    }

    public func lookup(_ identity: ConfirmedAlbumIdentity) async throws -> LidarrCandidate {
        guard let settings else { throw AcquisitionError.invalidSettings }
        let values = try await list("album/lookup", query: [URLQueryItem(name: "term", value: "lidarr:\(identity.releaseGroupMBID)")])
        let matches = values.filter { ($0["foreignAlbumId"] as? String)?.lowercased() == identity.releaseGroupMBID }
        guard matches.count == 1, var value = matches.first else { throw AcquisitionError.ambiguousIdentity }
        try validate(value, identity: identity)
        // Validate configured values against the server before performing any write.
        let roots = try await rootFolders()
        let qualities = try await qualityProfiles()
        let metadata = try await metadataProfiles()
        guard roots.contains(where: { $0.name == settings.rootFolderPath }),
              qualities.contains(where: { $0.id == settings.qualityProfileID }),
              metadata.contains(where: { $0.id == settings.metadataProfileID }) else {
            throw AcquisitionError.invalidSettings
        }
        var artist = value["artist"] as? [String: Any] ?? [:]
        artist["rootFolderPath"] = settings.rootFolderPath
        artist["qualityProfileId"] = settings.qualityProfileID
        artist["metadataProfileId"] = settings.metadataProfileID
        artist["monitored"] = true
        artist["monitorNewItems"] = "none"
        // Lidarr's initial artist scan applies these options after album insertion.
        // "none" would unmonitor the artist and overwrite album.monitored=true.
        artist["addOptions"] = ["monitor": "unknown", "albumsToMonitor": [identity.releaseGroupMBID],
                                "searchForMissingAlbums": false]
        value["artist"] = artist
        // Add without searching; edition monitoring is reconciled before search.
        value["monitored"] = true
        value["addOptions"] = ["searchForNewAlbum": false]
        return LidarrCandidate(resource: try JSONSerialization.data(withJSONObject: value))
    }

    public func add(_ candidate: LidarrCandidate) async throws {
        _ = try await send("album", method: "POST", body: candidate.resource)
    }

    public func monitor(_ album: LidarrAlbum, identity: ConfirmedAlbumIdentity) async throws {
        guard var value = try JSONSerialization.jsonObject(with: album.resource) as? [String: Any] else {
            throw LidarrError.invalidResponse
        }
        try validate(value, identity: identity)
        value["monitored"] = true
        if let release = identity.releaseMBID {
            value["anyReleaseOk"] = false
            value["releases"] = (value["releases"] as? [[String: Any]] ?? []).map { original in
                var item = original
                item["monitored"] = (item["foreignReleaseId"] as? String)?.lowercased() == release
                return item
            }
        }
        _ = try await send("album/\(album.id)", method: "PUT", body: JSONSerialization.data(withJSONObject: value))
    }

    /// GET command is sorted by status/priority, not chronology. IDs are the
    /// persistent queue cursor; absent retained history never proves no search.
    public func latestSearch(for albumID: Int, afterCommandID: Int? = nil) async throws -> LidarrSearchCommand? {
        try await list("command").compactMap { command -> LidarrSearchCommand? in
            let body = command["body"] as? [String: Any]
            guard command["name"] as? String == "AlbumSearch",
                  (body?["albumIds"] as? [Int])?.contains(albumID) == true else { return nil }
            guard let id = command["id"] as? Int, id > 0 else { throw LidarrError.invalidResponse }
            guard id > (afterCommandID ?? 0) else { return nil }
            return LidarrSearchCommand(id: id, status: LidarrSearchStatus(rawValue: command["status"] as? String ?? "") ?? .unknown)
        }.max { $0.id < $1.id }
    }

    /// Explicit AlbumSearch bypasses Lidarr's artist-monitor check (unlike RSS
    /// and bulk missing-album searches). Do not broaden artist monitoring here:
    /// an unmonitored artist can fulfill this search, but not later RSS grabs.
    @discardableResult
    public func search(albumID: Int) async throws -> Int {
        let data = try await send("command", method: "POST", body: JSONSerialization.data(withJSONObject: ["name": "AlbumSearch", "albumIds": [albumID]]))
        guard let command = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let id = command["id"] as? Int, id > 0 else { throw LidarrError.invalidResponse }
        return id
    }

    private func validate(_ value: [String: Any], identity: ConfirmedAlbumIdentity) throws {
        let artist = value["artist"] as? [String: Any]
        guard (value["foreignAlbumId"] as? String)?.lowercased() == identity.releaseGroupMBID,
              (artist?["foreignArtistId"] as? String)?.lowercased() == identity.artistMBID else {
            throw AcquisitionError.ambiguousIdentity
        }
        if let release = identity.releaseMBID {
            let releases = value["releases"] as? [[String: Any]] ?? []
            guard releases.filter({ ($0["foreignReleaseId"] as? String)?.lowercased() == release }).count == 1 else {
                throw AcquisitionError.ambiguousIdentity
            }
        }
    }

    private func list(_ path: String, query: [URLQueryItem] = []) async throws -> [[String: Any]] {
        let data = try await send(path, query: query)
        guard let result = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]] else {
            throw LidarrError.invalidResponse
        }
        return result
    }

    private func send(_ path: String, method: String = "GET", query: [URLQueryItem] = [], body: Data? = nil) async throws -> Data {
        var components = URLComponents(url: endpoint.baseURL.appendingPathComponent("api/v1/\(path)"), resolvingAgainstBaseURL: false)!
        components.queryItems = query.isEmpty ? nil : query
        var request = URLRequest(url: components.url!)
        request.httpMethod = method
        request.httpBody = body
        request.setValue(apiKey, forHTTPHeaderField: "X-Api-Key")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        do {
            try Task.checkCancellation()
            let (data, response) = try await transport.send(request)
            try Task.checkCancellation()
            guard response.url == request.url else { throw LidarrError.redirectRejected }
            switch response.statusCode {
            case 200..<300: return data
            case 300..<400: throw LidarrError.redirectRejected
            case 401, 403: throw LidarrError.authentication
            default: throw LidarrError.httpStatus(response.statusCode)
            }
        } catch {
            if Task.isCancelled || error is CancellationError { throw CancellationError() }
            if let error = error as? LidarrError { throw error }
            throw LidarrError.transport
        }
    }
}
