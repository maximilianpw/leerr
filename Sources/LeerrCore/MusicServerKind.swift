import Foundation

public enum MusicServerKind: String, CaseIterable, Sendable {
    case jellyfin
    case navidrome

    public var name: String {
        switch self {
        case .jellyfin: "Jellyfin"
        case .navidrome: "Navidrome"
        }
    }

    public var endpointDefaultsKey: String { rawValue + ".endpoint" }

    public func credentialAccount(endpoint: String) -> String { rawValue + ":" + endpoint }

    public func requestAccount(endpoint: String, username: String, lidarrEndpoint: String) -> String {
        let account = [endpoint, username, lidarrEndpoint].joined(separator: "\n")
        // Preserve existing Navidrome journals; never share them with Jellyfin.
        return self == .navidrome ? account : rawValue + "\n" + account
    }
}
