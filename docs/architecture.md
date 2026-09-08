# Architecture baseline

This is the initial implementation direction, not a claim that the integrations
already work. Sources: the repository README and the
[Linear Leerr project](https://linear.app/maxpw/project/leerr-1c5fc662d135).
On 8 September 2026, project-scoped and text issue searches returned no Leerr
issues; the project has no milestones or linked resources. The sequence below
is a proposed local backlog, not a replacement for any inaccessible issues.

That search describes the scaffold preflight. The seven implementation stages
now have Linear issues and local implementations; see
[current evidence and remaining gates](implementation-status.md). The baseline
contracts below still apply, but future-tense ownership entries are historical.

## Native clients, no companion backend

Use Swift 6, SwiftUI, iOS 17+ and macOS 14+. These deployment floors permit
Observation and structured concurrency without compatibility wrappers. Start
with one local Swift package, LeerrCore, and two thin application targets.
XcodeGen's `project.yml` is the project source of truth; generated Xcode projects
are not committed. No third-party runtime dependencies are needed yet.

```
iOS app / macOS app (composition root, SwiftUI, platform integration)
          |
          v
LeerrCore (domain values, MusicServer boundary, shared workflows)
          ^
          |
future adapters (OpenSubsonic, Keychain, AVFoundation, HTTP services)
```

Keep pure domain code independent of SwiftUI, AVFoundation and API response
shapes. Add adapter targets only as their implementations arrive; don't create
empty modules for every future service. Apps construct live dependencies;
tests inject fixtures. No service locator, global mutable singleton, or generic
repository framework is needed. Shared SwiftUI views live under Apps/Leerr;
platform-only audio/session/menu code will live under Apps/iOS and Apps/macOS.

## Ownership and concurrency

| Owner | Contract |
| --- | --- |
| LeerrCore | Server-scoped library IDs, domain values, music-server boundary, later identity/request rules |
| OpenSubsonic adapter (next) | URLSession requests, response decoding, authentication, pagination and original-stream URL generation |
| App feature state (next) | Main-actor observable state; loading/empty/loaded/error states; cancellation of superseded searches |
| Playback coordinator (next) | One main-actor queue/player per app process, shared across macOS windows; transport state and interruptions |
| Apple adapters (next) | Keychain, AVPlayer, iOS audio session, MediaPlayer commands/Now Playing |
| Acquisition/discovery adapters (later) | Lidarr operations, Last.fm signals and MusicBrainz lookups; never expose their DTOs to views |

Use async/await and Sendable value types across isolation boundaries. Actors own
mutable network/session state when necessary. Cancellation must propagate, not
be converted into a visible network failure. After changing server/account,
cancel outstanding work, stop playback and discard old library state. Key any
future cache by server/account plus remote ID; Navidrome IDs are not MusicBrainz IDs.

## Connection and security

The initial endpoint policy is HTTPS only, including reverse-proxy subpaths and
custom ports. Reject embedded user info, query parameters and fragments.
Credentials are supplied separately and will be stored in Keychain, not
UserDefaults, source, fixtures or logs. Endpoint configuration is not itself
a credential store. There is no certificate-verification bypass or broad ATS
exception. Explicit HTTP-over-VPN support requires a separate user opt-in and
platform transport decision; a private IP alone does not prove a trusted path.

The OpenSubsonic adapter must negotiate/test supported authentication against
Navidrome, use fresh salts for token authentication where applicable, and retain
credentials only as needed. Treat authenticated stream URLs as secrets. Do not
include raw URLSession errors, request URLs or response bodies in logs/UI.
Reject cross-origin or HTTPS-to-HTTP redirects carrying authentication. Provide
typed, recoverable authentication, transport, protocol and unavailable states.

macOS starts sandboxed with outbound-network access. iOS background audio and
local-network privacy configuration are added with the real playback/connection
feature, not enabled speculatively in a non-playing shell.

## Playback is the first integration gate

The adapter's originalStreamURL requests original data; it does not certify
delivery. Keep source-library metadata, delivered-stream observations and
hardware output facts separate. Unknown codec/rate/depth or transcode status
must display as unknown, not as lossless by inference. Verify Navidrome's
original-stream parameters and server-side transcode policy with a known FLAC
fixture before claiming success. AVFoundation format support must be tested
for the actual remote container and delivery path, not just a local file.

AVPlayer owns transport. The coordinator owns queue position, seeking and
recoverable state; platform adapters translate system commands into the same
operations. Register media commands once, remove handlers on teardown, and
update Now Playing from actual player state. Verify iOS interruption/route
changes and background behavior and macOS media keys on real hardware.
Lossless streaming does not imply exclusive output or bit-perfect playback.

## Later acquisition and discovery

MusicBrainz artist and release-group/release IDs bridge services, but distinguish
those entity types explicitly. Never silently turn a name-only match into a
request. Require confirmation of ambiguous identity and edition before writes.

Track requested → acquiring → imported → indexed/available, with failure and
retry states. Lidarr import is not Navidrome availability. Reconcile after app
resume; don't promise reliable background polling on iOS. Before retrying a
timed-out mutation, check Lidarr for the existing monitored release. Do not
blindly repeat writes. Deduplicate against both requests and indexed library.

Start with in-memory library state. Add durable request records when acquisition
arrives, storing confirmed identities and remote IDs, never stream URLs. Choose
persistence then, with schema migration and account separation covered by tests.
No database/backend, push worker or offline download subsystem is required now.

## Implementation order and completion gates

Amp-driven native build and UI verification requires a live Mac runner with the
exact changes under test. Follow the [runner prerequisite and preflight](development.md#prerequisite-for-amp-driven-native-ui-testing).
Without it, core work may proceed, but native verification remains blocked.

1. **Foundation (this setup):** shared package, domain boundary, endpoint policy,
   package tests, generated native targets and reproducible build commands.
   Apple build/launch checks remain required on a Mac.
2. **Secure connection and library:** Keychain + OpenSubsonic adapter; ping,
   paginated browse/search, album tracks, connect/disconnect/retry UI. Test
   reverse-proxy paths, authentication failures, malformed responses, cancellation,
   pagination boundaries and account changes with an injected transport.
3. **Lossless vertical slice:** original FLAC stream, actual format reporting,
   queue/seeking, interruptions and system controls on iPhone and Mac. Test a
   real Navidrome server over a real network; record fixture and server settings.
4. **Lidarr requests:** confirmed identity, acquisition state, duplicate handling,
   uncertain-write reconciliation and indexed availability.
5. **Last.fm discovery:** listening signals, MusicBrainz resolution, recommendation
   filtering and the complete discover → request → play acceptance flow.

Do not let broader UI work or discovery integrations delay the FLAC streaming
experiment. Use only music fixtures the developer is permitted to use. No live
server credentials or Apple signing identity are required for unit tests.
