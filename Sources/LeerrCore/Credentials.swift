import Foundation
#if canImport(Security)
import Security
#endif

public struct AccountCredentials: Codable, Equatable, Sendable {
    public let username: String
    public let password: String

    public init(username: String, password: String) {
        self.username = username
        self.password = password
    }
}

public enum CredentialStoreError: Error, Equatable, Sendable, LocalizedError {
    case unavailable
    case invalidData
    case operationFailed

    public var errorDescription: String? {
        switch self {
        case .unavailable: "Secure credential storage is unavailable."
        case .invalidData: "The stored credentials could not be read."
        case .operationFailed: "Secure credential storage could not complete the operation."
        }
    }
}

/// Apple Keychain generic passwords, device-only and available after first unlock
/// for background playback. No synchronization or plaintext fallback on Linux.
/// `account` is a stable caller-owned server/account identifier, not a password.
/// Use a distinct account per configured server/login. Keep service stable across launches.
public struct KeychainCredentialStore: Sendable {
    private let service: String

    public init(service: String = "dev.leerr.credentials") { self.service = service }

    /// Inserts or replaces the username/password for this account.
    public func save(_ credentials: AccountCredentials, account: String) throws {
        #if canImport(Security)
        let data = try JSONEncoder().encode(credentials)
        let query = query(account)
        let status = SecItemUpdate(query as CFDictionary, [kSecValueData: data] as CFDictionary)
        if status == errSecItemNotFound {
            var item = query
            item[kSecValueData] = data
            item[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else {
                throw CredentialStoreError.operationFailed
            }
        } else if status != errSecSuccess { throw CredentialStoreError.operationFailed }
        #else
        throw CredentialStoreError.unavailable
        #endif
    }

    /// Returns nil only for an absent account; locked/denied/corrupt storage throws.
    public func load(account: String) throws -> AccountCredentials? {
        #if canImport(Security)
        var query = query(account)
        query[kSecReturnData] = true
        query[kSecMatchLimit] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw CredentialStoreError.operationFailed }
        guard let data = result as? Data,
              let credentials = try? JSONDecoder().decode(AccountCredentials.self, from: data) else {
            throw CredentialStoreError.invalidData
        }
        return credentials
        #else
        throw CredentialStoreError.unavailable
        #endif
    }

    /// Idempotent removal. Never deletes other accounts or services.
    public func delete(account: String) throws {
        #if canImport(Security)
        let status = SecItemDelete(query(account) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw CredentialStoreError.operationFailed
        }
        #else
        throw CredentialStoreError.unavailable
        #endif
    }

    #if canImport(Security)
    private func query(_ account: String) -> [CFString: Any] {
        [kSecClass: kSecClassGenericPassword, kSecAttrService: service, kSecAttrAccount: account]
    }
    #endif
}
