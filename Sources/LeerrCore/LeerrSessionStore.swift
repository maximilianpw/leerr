import Foundation

public struct LeerrStoredSession: Codable, Equatable, Sendable {
    public let token: String
    public init(token: String) { self.token = token }
}

/// Dedicated namespace for Leerr bearer sessions. This never reads, uploads, or
/// deletes entries from the legacy `dev.leerr.credentials` service.
public struct LeerrSessionStore: Sendable {
    private let store: KeychainCredentialStore
    public init(service: String = "dev.leerr.shared-server.sessions") { store = KeychainCredentialStore(service: service) }
    public func save(token: String, origin: String) throws { try store.save(.init(username: "bearer", password: token), account: origin) }
    public func load(origin: String) throws -> LeerrStoredSession? { try store.load(account: origin).map { .init(token: $0.password) } }
    public func delete(origin: String) throws { try store.delete(account: origin) }
}
