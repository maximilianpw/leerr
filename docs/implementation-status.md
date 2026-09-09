# Implementation and remaining acceptance gates

The seven stages have local implementations integrated in one checkout. This is
**not a verified Apple release**. On 9 September 2026, the Mac runner passed both
Apple builds, 86 core tests including actual Mac Keychain operations, and native
disconnected/error UI checks on Mac and iPhone Simulator. See the
[native verification report](native-verification-2026-09-09.md) for exact scope.
Connected UI, real-device audio and live acquisition acceptance remain open.
No code was pushed, no deployment was triggered and no shared infrastructure
was changed.

Jellyfin is now implemented as an alternative music server under
[PRS-331](https://linear.app/maxpw/issue/PRS-331), without requiring Navidrome.
Provider selection, native authentication, paginated music browsing, source
metadata and static original-stream URLs share the existing playback/workflow
interfaces. `IndexedMusicLibrary` preserves Jellyfin release/group IDs and
resolves edition-only tags as needed. The subsequent
[Jellyfin native verification](jellyfin-native-verification.md) passed both Apple
builds, 102 core tests and native provider-switching, persistence, cancellation
and error-state checks on Mac and iPhone Simulator, including dark/XXXL rendering.
Live Jellyfin authentication, connected library and audio delivery remain open;
PRS-331 stays In Progress. These checks do not require a Navidrome installation.

## Linear tracks implementation separately from acceptance

| Stage | Acceptance-gated issue | Fixture/procedure subissue |
| --- | --- | --- |
| Secure Navidrome connection | [PRS-317](https://linear.app/maxpw/issue/PRS-317) | [PRS-324](https://linear.app/maxpw/issue/PRS-324) |
| Original FLAC and honest quality | [PRS-318](https://linear.app/maxpw/issue/PRS-318) | [PRS-325](https://linear.app/maxpw/issue/PRS-325) |
| Paginated library/search/tracks | [PRS-319](https://linear.app/maxpw/issue/PRS-319) | [PRS-326](https://linear.app/maxpw/issue/PRS-326) |
| Queue/background/system controls | [PRS-320](https://linear.app/maxpw/issue/PRS-320) | [PRS-327](https://linear.app/maxpw/issue/PRS-327) |
| Real-device lossless gate | [PRS-321](https://linear.app/maxpw/issue/PRS-321) | [PRS-328](https://linear.app/maxpw/issue/PRS-328) |
| Durable Lidarr acquisition | [PRS-322](https://linear.app/maxpw/issue/PRS-322) | [PRS-329](https://linear.app/maxpw/issue/PRS-329) |
| Last.fm discovery/request/play | [PRS-323](https://linear.app/maxpw/issue/PRS-323) | [PRS-330](https://linear.app/maxpw/issue/PRS-330) |

Original issues retain their native/live acceptance criteria. Narrow subissues
cover executable Linux fixtures or the prepared procedure only; completing one
does not complete the corresponding product gate. Actual integration dependencies
are linked in Linear rather than pretending the seven coding units were serial.

## Implemented behavior

- Fresh salted token authentication, ping, paginated OpenSubsonic browse/search,
  album tracks, typed safe failures, HTTPS redirect policy and device-only
  Keychain storage. Connection/search/selection cancellation guards late results.
- An original-stream AVPlayer resource loader, separate source/delivered/unknown
  quality, queue/seeking/skipping, system Now Playing and media commands, iOS
  audio session/background/interruption/route handling and explicit retry.
- Confirmed artist/release-group/edition acquisition with configured Lidarr root
  and profiles, atomic versioned account-scoped request journals and read-before-
  retry reconciliation. Import and Navidrome indexing are distinct states.
- Last.fm top-artist listening signals, similar artists and catalog albums;
  MusicBrainz group/edition choices, exact owned/requested exclusion and explicit
  confirmation before mutations. Native Library/Discover/Requests/Connect tabs
  share one player while album detail track state is view-owned.
- Full account inventory, not just the visible browse page, supplies ownership.
  Navidrome's `musicBrainzId` is a **release** ID. The account-owned bridge resolves
  public release-to-group identities, caches successful/unresolved lookups for
  the session, and never treats names or release IDs as group IDs.

## Deliberate constraints and remaining checks

- Playback supports progressive audio with valid HTTP 206 byte ranges and
  recognized audio MIME types. It rejects every media redirect, including
  same-origin redirects, and does not hand authenticated URLs to AVPlayer.
  Redirecting servers, HLS and non-range streaming are unsupported. The custom
  resource-loader FLAC path **must still be proven on both Apple platforms**.
- Source suffix/rate/depth are library hints. Delivered format observations come
  from AVFoundation track format descriptions; missing/ambiguous observations
  remain unknown. Compressed bit depth, transcoding and hardware output remain
  unknown when unmeasured. No bit-perfect, exclusive-output or DAC claim is made.
- Range requests are chunked but are not hostile-server response memory limits.
  Library enumeration assumes the server honors offsets; there is no offline
  media cache. MusicBrainz inventory resolution can take one second per previously
  unseen edition because the shared client respects the public API rate limit.
- Albums missing valid MusicBrainz tags cannot be automatically excluded by name.
  The UI warns about that limitation and requires explicit identity confirmation.
  MusicBrainz failures do not silently become proof of absence. An exact confirmed
  edition can be recognized as indexed without a live MusicBrainz lookup.
- Uncertain search writes with no retained command evidence remain uncertain,
  rather than issuing another search blindly. Failed/aborted searches require an
  explicit retry and fresh command evidence; consumed failure IDs prevent a
  stale response from authorizing another retry. An existing unmonitored Lidarr
  artist can satisfy an explicit album search, but later RSS grabs still require
  artist monitoring; Leerr does not broaden that server policy automatically.
  Durable records contain identities
  and remote IDs, not API keys or stream URLs. Disconnect cancels old work; the
  app waits for its journal writes to settle before reopening the same store.
- The app reconnects only on user action. Lidarr profiles/root selection must be
  chosen again after relaunch/disconnect. Status refresh runs in the foreground
  and on return to the app; no reliable iOS background polling is promised.

## Reproduce the checks and finish the gates

Run `./scripts/check` for the combined Swift 6 core suite. It includes independent
MD5 vectors, malformed responses/ranges and overflow boundaries, late-result
account/search races, raw-count pagination, uncertain mutations reopened from
disk, edition/group distinctions, discovery filtering and an end-to-end fixture
workflow across the real adapters. These tests require no live credentials.

Final Linux run on 8 September 2026: **86 tests passed**, followed by
`Core tests only: app builds require macOS and Xcode.` The documented synthetic
fixture round trip also reported `original_file_match=True; pcm_match=True`
(FLAC, 48,000 Hz, 24-bit, stereo, 60 seconds). This tests the local procedure,
not a delivered network stream. Syntax parsing, composition-only typechecking
described below and `git diff --check` passed.

`swiftc -frontend -parse Apps/Leerr/*.swift` checks syntax only. A supplementary
Linux typecheck of `LeerrModel` against the compiled core and a temporary playback
stub checks composition API/concurrency contracts, **not Apple SDK compatibility**.
The stub is not part of the application and is not retained in the repository.

On a connected Mac with the exact unpushed changes, run `./scripts/check`, launch
both targets, and inspect the [native UI checklist](development.md#native-ui-acceptance-checklist).
XcodeGen generates `.build/Leerr-iOS-Info.plist` with the background audio array;
regenerate the project after cleaning `.build`. Verify the built plist and actual
OS behavior rather than treating configuration as runtime evidence.

Then execute the [real-device lossless gate](lossless-acceptance.md), recording
physical devices, server versions/policies, independent legal fixture metadata
and hashes, correlated delivered bytes, interruptions, system controls and network
recovery. Finally exercise the complete native Last.fm → MusicBrainz → Lidarr →
Navidrome → playback flow against authorized test services. Keep credentials,
authenticated URLs and private listening history out of screenshots and reports.

Offline downloads, scrobbling, advanced audio output and a companion
backend remain outside this implementation scope.
