import Foundation
import Testing
@testable import LeerrCore

@Test func stage1CredentialsStorageContract() throws {
    let store = KeychainCredentialStore(service: "dev.leerr.tests." + UUID().uuidString)
    let credentials = AccountCredentials(username: "fixture-user", password: "fixture-only")
    #if canImport(Security)
    defer { try? store.delete(account: "first"); try? store.delete(account: "second") }
    #expect(try store.load(account: "first") == nil)
    try store.save(credentials, account: "first")
    try store.save(credentials, account: "second")
    #expect(try store.load(account: "first") == credentials)
    let replacement = AccountCredentials(username: "another", password: "replacement-fixture")
    try store.save(replacement, account: "first")
    #expect(try store.load(account: "first") == replacement)
    #expect(try store.load(account: "second") == credentials)
    try store.delete(account: "first")
    try store.delete(account: "first")
    #expect(try store.load(account: "first") == nil)
    #expect(try store.load(account: "second") == credentials)
    #else
    #expect(throws: CredentialStoreError.unavailable) { try store.save(credentials, account: "first") }
    #expect(throws: CredentialStoreError.unavailable) { try store.load(account: "first") }
    #expect(throws: CredentialStoreError.unavailable) { try store.delete(account: "first") }
    #endif
}
