import SwiftUI
import LeerrCore

struct LeerrRootView: View {
    @Bindable var model: LeerrModel
    @State private var tab = 0
    @Environment(\.scenePhase) private var phase

    var body: some View {
        VStack(spacing: 0) {
            TabView(selection: $tab) {
                LibraryView(model: model).id(model.sessionID).tabItem { Label("Library", systemImage: "square.stack") }.tag(0)
                DiscoveryView(model: model).id(model.sessionID).tabItem { Label("Discover", systemImage: "sparkles") }.tag(1)
                RequestsView(model: model).tabItem { Label("Requests", systemImage: "arrow.down.circle") }.tag(2)
                SettingsView(model: model).tabItem { Label("Connect", systemImage: "server.rack") }.tag(3)
            }
            if model.isWorking { ProgressView("Contacting services…").padding(8) }
            if let message = model.message {
                Text(message).font(.footnote).foregroundStyle(.secondary).padding(8)
                    .accessibilityIdentifier("service-message")
            }
            if model.playback.queue.current != nil { PlayerView(model: model) }
        }
        .task { if model.connection.server == nil { tab = 3 } }
        .onChange(of: phase) { _, phase in
            if phase == .active, model.acquisitionReady, !model.isWorking { model.refreshRequests() }
        }
        #if os(macOS)
        .frame(minWidth: 650, minHeight: 600)
        #endif
    }
}

private struct SettingsView: View {
    @Bindable var model: LeerrModel
    var body: some View {
        NavigationStack {
            Form {
                Section("Music server") {
                    Picker("Server type", selection: Binding(get: { model.serverKind }, set: { model.selectServer($0) })) {
                        ForEach(MusicServerKind.allCases, id: \.self) { kind in
                            Text(kind.name).tag(kind)
                        }
                    }
                    .accessibilityLabel("Server type")
                    .disabled(model.connection.server != nil || model.connection.isConnecting)
                    TextField("HTTPS server address", text: $model.endpoint)
                        .accessibilityLabel("HTTPS server address")
                        .autocorrectionDisabled()
                        .disabled(model.connection.server != nil || model.connection.isConnecting)
                    TextField("Username", text: $model.username).autocorrectionDisabled()
                        .accessibilityLabel("Username")
                        .disabled(model.connection.server != nil || model.connection.isConnecting)
                    SecureField("Password", text: $model.password)
                        .accessibilityLabel("Password")
                        .disabled(model.connection.server != nil || model.connection.isConnecting)
                    if model.connection.server != nil {
                        Label("Connected", systemImage: "checkmark.shield")
                        Button("Disconnect / change account") { model.disconnect() }
                    } else {
                        Button(model.connection.isConnecting ? "Connecting…" : "Connect / retry") {
                            Task { await model.connect() }
                        }.disabled(model.connection.isConnecting || model.username.isEmpty || model.password.isEmpty)
                        if model.connection.isConnecting { Button("Cancel") { model.disconnect() } }
                    }
                    if let error = model.connection.errorMessage { Text(error).foregroundStyle(.red) }
                    Text("Valid HTTPS is required. Credentials stay in Keychain; no certificate bypass.")
                        .font(.footnote).foregroundStyle(.secondary)
                    if model.serverKind == .jellyfin {
                        Text("Use your Jellyfin server address and user login. Your account needs access to a Music library. Navidrome is not required.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                }
                Section("Last.fm discovery") {
                    TextField("Last.fm username", text: $model.lastFMUsername).autocorrectionDisabled()
                        .accessibilityLabel("Last.fm username")
                        .onChange(of: model.lastFMUsername) { _, _ in model.discoverySettingsChanged() }
                    SecureField("Last.fm API key", text: $model.lastFMKey)
                        .accessibilityLabel("Last.fm API key")
                        .onChange(of: model.lastFMKey) { _, _ in model.discoverySettingsChanged() }
                    Text("Listening signals are sent to Last.fm. Album identities are resolved through MusicBrainz.")
                        .font(.footnote).foregroundStyle(.secondary)
                }.disabled(model.isWorking)
                Section("Lidarr requests") {
                    TextField("Lidarr HTTPS address", text: $model.lidarrEndpoint).autocorrectionDisabled()
                        .accessibilityLabel("Lidarr HTTPS address")
                        .onChange(of: model.lidarrEndpoint) { _, _ in model.lidarrSettingsChanged() }
                    SecureField("Lidarr API key", text: $model.lidarrKey)
                        .accessibilityLabel("Lidarr API key")
                        .onChange(of: model.lidarrKey) { _, _ in model.lidarrSettingsChanged() }
                    Button("Load folders and profiles") { model.loadLidarrOptions() }
                        .disabled(model.lidarrKey.isEmpty || model.lidarrEndpoint.isEmpty)
                    Picker("Root folder", selection: $model.rootFolder) {
                        Text("Choose…").tag("")
                        ForEach(model.roots, id: \.id) { Text($0.name).tag($0.name) }
                    }
                    Picker("Quality profile", selection: $model.qualityProfile) {
                        Text("Choose…").tag(0)
                        ForEach(model.qualities, id: \.id) { Text($0.name).tag($0.id) }
                    }
                    Picker("Metadata profile", selection: $model.metadataProfile) {
                        Text("Choose…").tag(0)
                        ForEach(model.metadataProfiles, id: \.id) { Text($0.name).tag($0.id) }
                    }
                    Button("Save settings and enable requests") { model.configureServices() }
                        .disabled(model.connection.server == nil || model.rootFolder.isEmpty || model.qualityProfile == 0 || model.metadataProfile == 0)
                    if model.acquisitionReady { Label("Requests enabled", systemImage: "checkmark.circle") }
                    Text("No acquisition occurs until you confirm a specific artist, release group and edition. Only request music you are entitled to acquire.")
                        .font(.footnote).foregroundStyle(.secondary)
                }.disabled(model.isWorking || model.acquisitionReady)
                if model.acquisitionReady {
                    Button("Disconnect to change Lidarr settings") { model.disconnect() }
                }
                Section {
                    Button("Forget saved credentials", role: .destructive) { model.forgetCredentials() }
                    Text("Request history remains on this device, isolated by server/account.").font(.footnote)
                }
            }
            #if os(iOS)
            .textInputAutocapitalization(.never)
            #endif
            .formStyle(.grouped)
            .navigationTitle("Connect")
        }
    }
}

private struct LibraryView: View {
    @Bindable var model: LeerrModel
    @State private var query = ""
    var body: some View {
        NavigationStack {
            List {
                if model.connection.server == nil {
                    ContentUnavailableView("Connect to your library", systemImage: "music.note.house",
                        description: Text("Open Connect to configure Jellyfin or Navidrome."))
                } else {
                    ForEach(model.library.albums) { album in
                        NavigationLink {
                            AlbumView(model: model, album: album, session: model.sessionID)
                        } label: { AlbumLabel(title: album.title, artist: album.artist) }
                    }
                    if model.library.albums.isEmpty, !model.library.isLoading, model.library.errorMessage == nil {
                        ContentUnavailableView("No albums", systemImage: "square.stack",
                            description: Text(query.isEmpty ? "The server library is empty." : "Try a different search."))
                    }
                    if model.library.hasMore {
                        Button("Load more albums") { Task { await model.library.loadMore() } }
                            .disabled(model.library.isLoading)
                    }
                }
                if model.library.isLoading { ProgressView("Loading library…") }
                if let error = model.library.errorMessage {
                    Text(error).foregroundStyle(.red)
                    Button("Retry") { Task { await model.library.loadMore() } }
                }
            }
            .navigationTitle("Library")
            .searchable(text: $query, prompt: "Albums or artists")
            .task(id: query) {
                do { try await Task.sleep(for: .milliseconds(250)) } catch { return }
                await model.library.search(query)
            }
            .refreshable { await model.library.reload() }
        }
    }
}

private struct AlbumLabel: View {
    let title: String
    let artist: String
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.headline)
            Text(artist).font(.subheadline).foregroundStyle(.secondary)
        }.padding(.vertical, 4)
    }
}

private struct AlbumView: View {
    let model: LeerrModel
    let album: Album
    let session: UUID
    @State private var detail = LibraryModel()
    var body: some View {
        List {
            AlbumLabel(title: album.title, artist: album.artist)
            ForEach(Array(detail.tracks.enumerated()), id: \.offset) { index, track in
                Button {
                    let tracks = detail.tracks
                    Task { await model.playTracks(tracks, index: index, session: session) }
                } label: {
                    HStack {
                        Text("\(index + 1)").foregroundStyle(.secondary).monospacedDigit()
                        AlbumLabel(title: track.title, artist: track.artist)
                        Spacer()
                        Image(systemName: "play.circle")
                    }
                }.buttonStyle(.plain)
            }
            if detail.isLoading { ProgressView("Loading tracks…") }
            if let error = detail.errorMessage {
                Text(error).foregroundStyle(.red)
                Button("Retry tracks") { Task { await detail.loadTracks(album: album) } }
            } else if detail.tracks.isEmpty, !detail.isLoading {
                Text("No indexed tracks in this album.").foregroundStyle(.secondary)
            }
        }
        .navigationTitle(album.title)
        .task(id: album.id) {
            guard session == model.sessionID else { return }
            detail.setServer(model.connection.server)
            await detail.loadTracks(album: album)
        }
        .onDisappear { detail.setServer(nil) }
    }
}

private struct PlayerView: View {
    let model: LeerrModel
    @State private var showQueue = false
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Divider()
            if let track = model.playback.queue.current {
                HStack {
                    AlbumLabel(title: track.title, artist: track.artist)
                    Spacer()
                    Button { Task { await model.playback.previous() } } label: { Image(systemName: "backward.end.fill") }
                        .accessibilityLabel("Previous track")
                    Button {
                        if model.playback.isPlaybackRequested { model.playback.pause() } else { model.playback.play() }
                    } label: { Image(systemName: model.playback.isPlaybackRequested ? "pause.fill" : "play.fill") }
                        .accessibilityLabel(model.playback.isPlaybackRequested ? "Pause" : "Play")
                    Button { Task { await model.playback.next() } } label: { Image(systemName: "forward.end.fill") }
                        .disabled(!model.playback.queue.hasNext).accessibilityLabel("Next track")
                    Button { showQueue = true } label: { Image(systemName: "list.bullet") }.accessibilityLabel("Playback queue")
                }
                Slider(value: Binding(get: { model.playback.audio.position }, set: { model.playback.seek(to: $0) }),
                    in: 0...max(1, model.playback.audio.duration))
                    .disabled(model.playback.audio.duration <= 0).accessibilityLabel("Playback position")
                Text("\(Int(model.playback.audio.position)) / \(Int(model.playback.audio.duration)) seconds")
                    .font(.caption).monospacedDigit()
                Text(model.playback.audio.qualityDescription).font(.caption).foregroundStyle(.secondary)
                if model.playback.isPlaybackRequested, !model.playback.audio.isPlaying,
                   model.playback.audio.errorMessage == nil {
                    HStack {
                        Text("Preparing or buffering…").font(.footnote)
                        Button("Retry stream") { Task { await model.playback.retry() } }
                    }
                }
                if let error = model.playback.errorMessage ?? model.playback.audio.errorMessage {
                    Text(error).font(.footnote).foregroundStyle(.red)
                    Button("Retry stream") { Task { await model.playback.retry() } }
                }
            }
        }.padding(.horizontal).padding(.bottom, 8)
        .sheet(isPresented: $showQueue) {
            NavigationStack {
                List(Array(model.playback.queue.tracks.enumerated()), id: \.offset) { index, track in
                    HStack {
                        if index == model.playback.queue.index { Image(systemName: "speaker.wave.2") }
                        AlbumLabel(title: track.title, artist: track.artist)
                    }
                }.navigationTitle("Playback queue")
                    .toolbar { Button("Close") { showQueue = false } }
            }.frame(minWidth: 300, minHeight: 300)
        }
    }
}

private struct RequestsView: View {
    let model: LeerrModel
    var body: some View {
        NavigationStack {
            List {
                if !model.acquisitionReady {
                    Text("Enable Lidarr in Connect to load this account's durable request history.")
                }
                ForEach(model.requests, id: \.id) { request in
                    VStack(alignment: .leading, spacing: 6) {
                        AlbumLabel(title: request.identity.title, artist: request.identity.artist)
                        Text(request.status.rawValue.capitalized).font(.subheadline)
                        if request.isAvailable {
                            Button("Play from library") { Task { await model.playRequest(request) } }
                        } else {
                            Text("Not yet verified as indexed in your music server.").font(.caption).foregroundStyle(.secondary)
                        }
                        if request.status == .failed, request.searchIssued, request.pendingMutation == nil {
                            Button("Retry failed search") { model.retryFailedSearch(request) }
                                .disabled(model.isWorking || !model.acquisitionReady)
                        }
                    }
                }
                if model.requests.isEmpty, model.acquisitionReady { Text("No requests for this account yet.") }
                Button("Refresh / reconcile statuses") { model.refreshRequests() }
                    .disabled(!model.acquisitionReady || model.isWorking)
                Text("Refresh reconciles uncertain writes before retry. Lidarr import alone does not make an album playable. Updates run while the app is active, not as a background polling service.")
                    .font(.footnote).foregroundStyle(.secondary)
            }.navigationTitle("Requests")
        }
    }
}

private struct DiscoveryView: View {
    let model: LeerrModel
    @State private var confirmEdition: MusicBrainzRelease?
    @State private var confirmArtist: MusicBrainzArtist?
    @State private var confirmation = false
    var body: some View {
        NavigationStack {
            List {
                Button("Find recommendations") { model.discoverAlbums() }
                    .disabled(model.connection.server == nil || model.lastFMUsername.isEmpty || model.lastFMKey.isEmpty || model.isWorking)
                Text("Owned and requested MusicBrainz identities are excluded. Albums without identity tags cannot be excluded automatically; check your library before confirming a request.")
                    .font(.footnote).foregroundStyle(.secondary)
                ForEach(model.candidates, id: \.id) { candidate in
                    Button { model.resolve(candidate) } label: { AlbumLabel(title: candidate.title, artist: candidate.artist) }
                        .disabled(model.isWorking)
                }
                if let resolution = model.resolution {
                    Section("Confirm release group") {
                        ForEach(resolution.releaseGroups, id: \.id) { group in
                            VStack(alignment: .leading) {
                                AlbumLabel(title: group.title, artist: group.artists.map(\.name).joined(separator: ", "))
                                Text(group.id).font(.caption).textSelection(.enabled)
                                if !group.disambiguation.isEmpty { Text(group.disambiguation).font(.caption) }
                                if let owned = LibraryInventory.album(in: model.inventory, releaseGroupMBID: group.id) {
                                    Button("Already in library — play") { Task { await model.playAlbum(owned) } }
                                } else if model.requests.contains(where: { $0.identity.releaseGroupMBID == group.id }) {
                                    Text("Already requested — see Requests")
                                } else {
                                    Button("Choose edition") { model.choose(group) }.disabled(model.isWorking)
                                }
                            }
                        }
                        if resolution.releaseGroups.isEmpty { Text("No exact candidates. Try another recommendation; no request was made.") }
                        if resolution.hasMore {
                            Button("Next matches") { model.resolve(resolution.candidate, more: true) }.disabled(model.isWorking)
                        }
                    }
                }
                if let group = model.selectedGroup {
                    Section("Choose an edition of \(group.title)") {
                        ForEach(model.editions, id: \.id) { edition in
                            VStack(alignment: .leading, spacing: 4) {
                                Text(edition.title).font(.headline)
                                Text([edition.date, edition.country, edition.status].compactMap { $0 }.joined(separator: " · "))
                                Text(edition.formats.joined(separator: ", ")).font(.caption)
                                Text(edition.id).font(.caption).textSelection(.enabled)
                                ForEach(group.artists, id: \.id) { artist in
                                    Button("Review request as \(artist.name)") {
                                        confirmEdition = edition; confirmArtist = artist; confirmation = true
                                    }.disabled(!model.acquisitionReady || model.isWorking)
                                }
                            }
                        }
                        if model.editions.isEmpty { Text("No editions found; no request will be made.") }
                        if model.editionOffset != nil {
                            Button("More editions") { model.choose(group, more: true) }.disabled(model.isWorking)
                        }
                        if !model.acquisitionReady { Text("Configure Lidarr folders and profiles in Connect before requesting.") }
                    }
                }
            }
            .navigationTitle("Discover")
            .confirmationDialog("Confirm exact identity and acquisition", isPresented: $confirmation, titleVisibility: .visible) {
                Button("Confirm and request") {
                    if let edition = confirmEdition, let artist = confirmArtist { model.request(edition, artist: artist) }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                if let edition = confirmEdition, let artist = confirmArtist {
                    Text("Artist: \(artist.name) (\(artist.id))\nAlbum: \(edition.title)\nRelease group: \(edition.releaseGroupMBID)\nEdition: \(edition.id)\nOnly continue if this is the intended edition and you are entitled to acquire it.")
                }
            }
        }
    }
}
