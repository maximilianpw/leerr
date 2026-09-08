import Foundation
import Testing
@testable import LeerrCore

@Test func preservesReverseProxyPathAndPort() throws {
    let endpoint = try ServerEndpoint("https://music.example.test:8443/navidrome/")
    #expect(endpoint.baseURL.absoluteString == "https://music.example.test:8443/navidrome/")
}

@Test(arguments: ["http://music.example.test", "ftp://music.example.test"])
func rejectsInsecureTransport(value: String) {
    #expect(throws: ServerEndpoint.ValidationError.httpsRequired) {
        try ServerEndpoint(value)
    }
}

@Test(arguments: [
    "https://alice:secret@music.example.test",
    "https://alice@music.example.test",
    "https://music.example.test?token=secret",
    "https://music.example.test#secret",
])
func rejectsSecretsInConfiguration(value: String) {
    #expect(throws: ServerEndpoint.ValidationError.embeddedCredentialsOrParameters) {
        try ServerEndpoint(value)
    }
}

@Test(arguments: ["", "music.example.test", "https://", "/navidrome"])
func rejectsMissingHost(value: String) {
    #expect(throws: ServerEndpoint.ValidationError.invalidURL) {
        try ServerEndpoint(value)
    }
}
