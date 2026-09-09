import Testing
@testable import LeerrCore

@Test func providerKeysKeepExistingNavidromeDataAndSeparateJellyfin() {
    let endpoint = "https://music.example.test/proxy"
    let lidarr = "https://requests.example.test"
    #expect(MusicServerKind.navidrome.endpointDefaultsKey == "navidrome.endpoint")
    #expect(MusicServerKind.navidrome.credentialAccount(endpoint: endpoint) == "navidrome:" + endpoint)
    #expect(MusicServerKind.jellyfin.credentialAccount(endpoint: endpoint) == "jellyfin:" + endpoint)
    let oldScope = "https://music.example.test/proxy\nalice\nhttps://requests.example.test"
    let nav = MusicServerKind.navidrome.requestAccount(endpoint: endpoint, username: "alice", lidarrEndpoint: lidarr)
    let jellyfin = MusicServerKind.jellyfin.requestAccount(endpoint: endpoint, username: "alice", lidarrEndpoint: lidarr)
    #expect(nav == oldScope)
    #expect(jellyfin != nav)
    #expect(jellyfin != MusicServerKind.jellyfin.requestAccount(endpoint: endpoint, username: "bob", lidarrEndpoint: lidarr))
    #expect(jellyfin != MusicServerKind.jellyfin.requestAccount(endpoint: endpoint + "/other", username: "alice", lidarrEndpoint: lidarr))
    #expect(jellyfin != MusicServerKind.jellyfin.requestAccount(endpoint: endpoint, username: "alice", lidarrEndpoint: lidarr + "/other"))
}
