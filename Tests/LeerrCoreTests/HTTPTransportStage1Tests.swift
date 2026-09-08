import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import Testing
@testable import LeerrCore

@Test(arguments: [
    ("https://music.test/next", true),
    ("https://MUSIC.test:443/proxy/next", true),
    ("https://music.test:8443/next", false),
    ("https://other.test/next", false),
    ("http://music.test/next", false),
    ("https://user@music.test/next", false),
    ("https://music.test.evil.test/next", false),
])
func stage1AuthenticatedRedirectPolicy(target: (String, Bool)) throws {
    #expect(URLSessionHTTPTransport.permitsRedirect(from: URL(string: "https://music.test/rest/ping.view?t=fixture")!,
                                                   to: URL(string: target.0)!) == target.1)
}

@Test func stage1LiveTransportRejectsHTTPBeforeSending() async {
    await #expect(throws: MusicServerError.invalidRequest) {
        try await URLSessionHTTPTransport().send(URLRequest(url: URL(string: "http://example.test/?t=fixture")!))
    }
}
