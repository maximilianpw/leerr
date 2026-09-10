import SwiftUI
import LeerrCore

struct LeerrRootView: View {
    @Bindable var model: LeerrModel
    @State private var tab = 0
    var body: some View {
        VStack(spacing: 0) {
            TabView(selection: $tab) {
                LibraryView(model: model).id(model.sessionID).tabItem { Label("Library", systemImage: "square.stack") }.tag(0)
                DiscoveryView(model: model).id(model.sessionID).tabItem { Label("Discover", systemImage: "sparkles") }.tag(1)
                RequestsView(model: model).tabItem { Label("Requests", systemImage: "arrow.down.circle") }.tag(2)
                AccountView(model: model).tabItem { Label("Account", systemImage: "person.crop.circle") }.tag(3)
            }
            if model.isWorking { ProgressView("Contacting Leerr…").padding(8) }
            if let message = model.message ?? model.connection.errorMessage {
                Text(message).font(.footnote).foregroundStyle(.secondary).padding(8)
                    .accessibilityIdentifier("service-message")
            }
            if model.playback.queue.current != nil { PlayerView(model: model) }
        }
        .task { await model.restoreSession(); if model.connection.server == nil { tab = 3 } }
        #if os(macOS)
        .frame(minWidth: 650, minHeight: 600)
        #endif
    }
}

private struct AccountView: View {
    @Bindable var model: LeerrModel
    var body: some View { NavigationStack { Form {
        if let user = model.user {
            Section("Signed in") { Text(user.username); Text(user.role.capitalized); Button("Log out", role: .destructive) { model.logout() } }
            if let state = model.connections { Section("Connections") { Label("Jellyfin", systemImage: state.jellyfin ? "checkmark.circle" : "xmark.circle"); Label("Last.fm", systemImage: state.lastfm ? "checkmark.circle" : "xmark.circle") } }
        } else { Section("Leerr server") {
            TextField("HTTPS server address", text: $model.endpoint).textContentType(.URL).autocorrectionDisabled()
                .accessibilityLabel("HTTPS server address")
                .accessibilityIdentifier("leerr-server-address")
                .disabled(model.isWorking)
            TextField("Username", text: $model.username).autocorrectionDisabled().accessibilityLabel("Username")
                .accessibilityIdentifier("leerr-username").disabled(model.isWorking)
            SecureField("Password", text: $model.password).accessibilityLabel("Password")
                .accessibilityIdentifier("leerr-password").disabled(model.isWorking)
            Button("Sign in") { Task { await model.signIn() } }.disabled(model.endpoint.isEmpty || model.username.isEmpty || model.password.isEmpty || model.isWorking)
            if model.isWorking { Button("Cancel") { model.disconnect() } }
            if let error = model.connection.errorMessage { Text(error).foregroundStyle(.red) }
            Text("Your password is used only to create a device session. The bearer token is stored in a separate Keychain namespace. Existing Jellyfin, Navidrome, Lidarr, and Last.fm Keychain entries are never read, uploaded, or deleted.").font(.footnote)
        }}
    }
    .formStyle(.grouped)
    #if os(iOS)
    .textInputAutocapitalization(.never)
    #endif
    .navigationTitle("Account") } }
}

private struct LibraryView: View {
    @Bindable var model: LeerrModel; @State private var query = ""
    var body: some View { NavigationStack { List {
        if model.connection.server == nil { ContentUnavailableView("Sign in to Leerr", systemImage: "music.note.house") }
        ForEach(model.library.albums) { album in NavigationLink { AlbumView(model: model, album: album, session: model.sessionID) } label: { AlbumLabel(title: album.title, artist: album.artist) } }
        if model.connection.server != nil, model.library.albums.isEmpty, !model.library.isLoading, model.library.errorMessage == nil {
            ContentUnavailableView("No albums", systemImage: "square.stack", description: Text(query.isEmpty ? "The server library is empty." : "Try a different search."))
        }
        if model.library.hasMore { Button("Load more albums") { Task { await model.library.loadMore() } }.disabled(model.library.isLoading) }
        if model.library.isLoading { ProgressView("Loading library…") }
        if let error = model.library.errorMessage {
            Text(error).foregroundStyle(.red)
            Button("Retry") { Task { await model.library.loadMore() } }
        }
    }.navigationTitle("Library").searchable(text: $query, prompt: "Albums or artists").task(id: query) {
        do { try await Task.sleep(for: .milliseconds(250)) } catch { return }
        await model.library.search(query)
    }.refreshable { await model.library.reload() } } }
}

private struct AlbumLabel: View { let title, artist: String; var body: some View { VStack(alignment: .leading) { Text(title).font(.headline); Text(artist).font(.subheadline).foregroundStyle(.secondary) } } }

private struct AlbumView: View {
    let model: LeerrModel; let album: Album; let session: UUID; @State private var detail = LibraryModel()
    var body: some View { List {
        AlbumLabel(title: album.title, artist: album.artist)
        ForEach(Array(detail.tracks.enumerated()), id: \.offset) { index, track in
            Button { let tracks = detail.tracks; Task { await model.playTracks(tracks, index: index, session: session) } } label: {
                HStack { Text("\(index + 1)").foregroundStyle(.secondary).monospacedDigit(); AlbumLabel(title: track.title, artist: track.artist); Spacer(); Image(systemName: "play.circle") }
            }.buttonStyle(.plain)
        }
        if detail.isLoading { ProgressView("Loading tracks…") }
        if let error = detail.errorMessage {
            Text(error).foregroundStyle(.red)
            Button("Retry tracks") { Task { await detail.loadTracks(album: album) } }
        } else if detail.tracks.isEmpty, !detail.isLoading { Text("No indexed tracks in this album.").foregroundStyle(.secondary) }
    }.navigationTitle(album.title).task(id: album.id) {
        guard session == model.sessionID else { return }
        detail.setServer(model.connection.server); await detail.loadTracks(album: album)
    }.onDisappear { detail.setServer(nil) } }
}

private struct DiscoveryView: View {
    let model: LeerrModel; @State private var query = ""; @State private var pending: LeerrEdition?
    var body: some View { NavigationStack { List {
        if model.user == nil { ContentUnavailableView("Sign in to discover music", systemImage: "sparkles", description: Text("Open Account to sign in to your Leerr server.")) }
        HStack { TextField("Album or artist", text: $query).accessibilityLabel("Album or artist"); Button("Search") { model.discover(query: query) } }.disabled(model.user == nil || model.isWorking)
        Button("Recommendations") { model.discover() }.disabled(model.user == nil || model.isWorking)
        ForEach(model.candidates) { item in Button { model.choose(item) } label: { AlbumLabel(title: item.title, artist: item.artist) } }
        if let selected = model.selectedCandidate { Section("Choose edition of \(selected.title)") { ForEach(model.editions) { edition in Button { pending = edition } label: { VStack(alignment: .leading) { Text(edition.title); Text([edition.date, edition.country].compactMap { $0 }.joined(separator: " · ")).font(.caption) } } } } }
    }.navigationTitle("Discover").confirmationDialog("Confirm this exact edition?", isPresented: Binding(get: { pending != nil }, set: { if !$0 { pending = nil } })) { Button("Confirm and request") { if let pending { model.request(pending); self.pending = nil } }; Button("Cancel", role: .cancel) { pending = nil } } } }
}

private struct RequestsView: View {
    let model: LeerrModel
    var body: some View { NavigationStack { List {
        if model.user == nil { ContentUnavailableView("Sign in to see requests", systemImage: "arrow.down.circle", description: Text("Open Account to sign in to your Leerr server.")) }
        else if model.requests.isEmpty { Text("No requests yet. Discover an album to request it.").foregroundStyle(.secondary) }
        ForEach(model.requests) { request in VStack(alignment: .leading) { AlbumLabel(title: request.title, artist: request.artist); Text(request.status.capitalized); if let id = request.albumID { Button("Play from library") { Task { await model.playAlbum(Album(id: id, title: request.title, artist: request.artist)) } } } } }; Button("Refresh") { Task { await model.refreshSharedState() } }.disabled(model.user == nil) }.navigationTitle("Requests") } }
}

private struct PlayerView: View {
    let model: LeerrModel
    @State private var showQueue = false
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Divider()
            if let track = model.playback.queue.current {
                HStack {
                    AlbumLabel(title: track.title, artist: track.artist); Spacer()
                    Button { Task { await model.playback.previous() } } label: { Image(systemName: "backward.end.fill") }.accessibilityLabel("Previous track")
                    Button { model.playback.isPlaybackRequested ? model.playback.pause() : model.playback.play() } label: { Image(systemName: model.playback.isPlaybackRequested ? "pause.fill" : "play.fill") }.accessibilityLabel(model.playback.isPlaybackRequested ? "Pause" : "Play")
                    Button { Task { await model.playback.next() } } label: { Image(systemName: "forward.end.fill") }.disabled(!model.playback.queue.hasNext).accessibilityLabel("Next track")
                    Button { showQueue = true } label: { Image(systemName: "list.bullet") }.accessibilityLabel("Playback queue")
                }
                Slider(value: Binding(get: { model.playback.audio.position }, set: { model.playback.seek(to: $0) }), in: 0...max(1, model.playback.audio.duration))
                    .disabled(model.playback.audio.duration <= 0).accessibilityLabel("Playback position")
                Text("\(Int(model.playback.audio.position)) / \(Int(model.playback.audio.duration)) seconds").font(.caption).monospacedDigit()
                Text(model.playback.audio.qualityDescription).font(.caption).foregroundStyle(.secondary)
                if model.playback.isPlaybackRequested, !model.playback.audio.isPlaying, model.playback.audio.errorMessage == nil {
                    HStack { Text("Preparing or buffering…").font(.footnote); Button("Retry stream") { Task { await model.playback.retry() } } }
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
                    HStack { if index == model.playback.queue.index { Image(systemName: "speaker.wave.2") }; AlbumLabel(title: track.title, artist: track.artist) }
                }.navigationTitle("Playback queue").toolbar { Button("Close") { showQueue = false } }
            }.frame(minWidth: 300, minHeight: 300)
        }
    }
}
