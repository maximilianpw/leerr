import Foundation

/// Non-secret server configuration. Credentials are supplied separately from Keychain.
public struct ServerEndpoint: Equatable, Sendable {
    public let baseURL: URL

    public enum ValidationError: Error, Equatable {
        case invalidURL
        case httpsRequired
        case embeddedCredentialsOrParameters
    }

    public init(_ value: String) throws {
        guard let components = URLComponents(string: value),
              let host = components.host, !host.isEmpty,
              let url = components.url else {
            throw ValidationError.invalidURL
        }
        guard components.scheme?.lowercased() == "https" else {
            throw ValidationError.httpsRequired
        }
        guard components.user == nil, components.password == nil,
              components.query == nil, components.fragment == nil else {
            throw ValidationError.embeddedCredentialsOrParameters
        }
        baseURL = url
    }
}
