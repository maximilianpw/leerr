# Leerr

Leerr is a native music app for iPhone and macOS that brings discovery, acquisition, and high-quality playback into one experience for people who host their own music.

The goal is a simple end-to-end flow:

> Discover an album, request it, follow it into the library, and play the original file without switching apps.

Leerr is a client and orchestrator, not another media store. Music remains on the user's server in ordinary directories and is served by an existing music server.

## Product direction

Leerr combines four responsibilities that are normally spread across separate applications:

- **Last.fm** supplies listening history and discovery signals.
- **Leerr** presents recommendations, resolves identities, and coordinates the workflow.
- **Lidarr** acquires and organizes requested music.
- **Jellyfin or Navidrome** indexes the music library and serves the original files.

Use your existing Jellyfin server; Navidrome is not required. The two adapters share the same library, playback, discovery and request workflow. Jellyfin uses its native API; Navidrome uses OpenSubsonic.

```text
┌─────────┐  discovery  ┌───────┐  requests  ┌────────┐
│ Last.fm │────────────▶│ Leerr │───────────▶│ Lidarr │
└─────────┘             └───▲───┘            └───┬────┘
                            │ streams             │ writes
                            │                     ▼
                      ┌─────┴─────┐ scan  ┌─────────────────┐
                      │ Jellyfin  │◀──────│ Music directory │
                      └───────────┘       └─────────────────┘
```

Lidarr writes to the music directory. Your selected music server scans that same directory, ideally through a read-only mount. Files do not need to be duplicated or owned by any one media server.

## Connect to Jellyfin

1. In **Connect**, choose **Jellyfin** under **Server type** (the default for new setups).
2. Enter the HTTPS server address, including any reverse-proxy base path, and your Jellyfin username/password. Use a user with access to a **Music** library and permission to play its audio.
3. Connect, then browse or search albums in **Library**. Lidarr and Last.fm are optional for playing your existing music.

Existing saved Navidrome setups retain their selection. Disconnect before changing server type; credentials and request journals are kept separate. Jellyfin login tokens stay in memory and login credentials stay in Keychain. The client requests static original audio, not a transcode; the server/proxy must support HTTPS byte-range responses without media redirects. Actual codec/container playback still requires validation on your Apple device. HTTP-only endpoints and certificate bypass are not supported.

Jellyfin's `MusicBrainzAlbum` tag is an edition/release ID, while `MusicBrainzReleaseGroup` is a group ID. Missing identity tags cannot prove an album is absent. Lidarr imports become playable only after the selected server indexes the intended edition; Leerr does not trigger a server scan or alter library settings.

## Discovery and requests

Last.fm does not transfer music to Lidarr. Leerr bridges the two systems:

1. Read the user's recent tracks, loved tracks, top artists, and top albums from Last.fm.
2. Use similar artists, similar tracks, tags, and artist catalogs to build recommendations.
3. Remove releases already present in the music library or already requested.
4. Let the user select an album in Leerr.
5. Resolve the artist and release through MusicBrainz and Lidarr.
6. Show the exact match for confirmation when identity is ambiguous.
7. Ask Lidarr to monitor and search for the album.
8. Track acquisition and import until the selected music server indexes the files.

Last.fm identifiers are not consistently populated, so matching by name alone must never silently request an uncertain release. MusicBrainz IDs should be the canonical bridge where available, with explicit user confirmation as the fallback.

A later share extension may accept a Last.fm artist or album URL and open the same resolution and request flow in Leerr.

## Playback quality

On trusted, sufficiently fast connections, Leerr should request the original stream from Jellyfin or Navidrome rather than a lossy transcode. The first version targets direct playback of formats supported by Apple platforms, including FLAC, WAV, and ALAC.

The player should:

- Prefer the original file on local networks and Wi-Fi.
- Allow an optional bandwidth-limited stream on mobile data.
- Display the actual codec, sample rate, bit depth, and whether transcoding occurred.
- Support a playback queue, seeking, play/pause, and track skipping.
- Integrate with background audio, lock-screen controls, media keys, and the system Now Playing UI.
- Recover clearly from interrupted streams and server unavailability.

Lossless direct streaming is an initial requirement. Bit-perfect output, exclusive device access, and automatic hardware sample-rate switching are separate audiophile features and are not promised by the first version.

## Apple clients

Leerr will use Swift and SwiftUI with native iOS and macOS targets. Shared code should own domain models, service clients, identity resolution, library state, and playback coordination. Platform-specific code should be limited to concerns such as audio sessions, media commands, menus, and output-device behavior.

Initial technologies:

- Swift and SwiftUI
- Swift concurrency and `URLSession`
- AVFoundation for playback
- MediaPlayer for system playback controls
- Keychain for credentials
- Jellyfin and OpenSubsonic music-server APIs
- Last.fm, MusicBrainz, and Lidarr HTTP APIs

React Native is not planned. The product is currently Apple-platform focused, and its most important behavior relies on native audio and operating-system integrations.

## First milestone: lossless vertical slice

The first milestone proves the riskiest path before building a broad interface:

1. Connect securely to a Jellyfin or Navidrome server.
2. Browse and search its library on iPhone and macOS.
3. Select a FLAC album and stream the original file.
4. Show verified stream format information.
5. Control playback using the platform's system media controls.
6. Exercise the flow on real Apple hardware over a real network.

After that works, add Lidarr request tracking and then Last.fm-powered discovery.

## First-version acceptance

On a real iPhone and Mac, a user can discover or search for an album that is not in the library, resolve and request it through Lidarr, follow its status until it appears in the selected music server, and play the original lossless stream. Albums already in the library offer playback instead of duplicate requests. Network failures, ambiguous matches, failed requests, and interrupted streams present recoverable states.

## Security and deployment

- Service credentials belong in Keychain and must never be committed or logged.
- Servers should be reached over HTTPS or a private network such as a VPN; Leerr should not encourage exposing unauthenticated services to the internet.
- Stream URLs may contain credentials and must be treated as secrets.
- The music server should have read-only access to the music files when practical.
- A companion backend is not required initially. It may become useful for push notifications, credential isolation, or controlled remote access.

## Follow-up scope

- Offline downloads
- Playlists and richer queue management
- AirPlay polish
- Last.fm scrobbling without duplicate submissions
- Push notifications when requested music becomes available
- Additional OpenSubsonic-compatible servers
- Advanced macOS audio-device controls and bit-perfect playback research

## Development status

Leerr now includes shared Swift 6 service clients and workflows, fixture tests,
and an integrated SwiftUI connection, library, player, discovery and request UI.
Native builds/rendering and real-device lossless acceptance are still blocked on
Apple hardware and live service validation; this is not a verified release.

- [Architecture and implementation gates](docs/architecture.md)
- [Development setup and device-validation checklist](docs/development.md)
- [Implementation evidence, Linear stages and remaining gates](docs/implementation-status.md)
- [Real-device lossless acceptance procedure — NOT RUN](docs/lossless-acceptance.md)

On a Mac with Xcode 16.2+ and XcodeGen installed:

```sh
./scripts/check
open Leerr.xcodeproj
```

The check script runs package tests and generates/builds both app targets. On Linux with Swift installed it runs core tests only. The generated Xcode project is not committed; edit `project.yml` instead. Native builds and visual checks require macOS; background playback, stream quality and media controls require real-device validation.
