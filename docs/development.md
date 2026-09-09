# Development

## macOS: build the native apps

Requirements: macOS supported by Xcode 16.2+, Xcode with iOS simulator support,
and XcodeGen 2.42+. Swift 6.0.3 is the package's reference toolchain; newer Xcode
toolchains use Swift 6 language mode. No runtime package dependencies, backend,
API credentials or paid Apple membership are needed to build the shell.

```sh
# Install Xcode separately and finish its first-launch setup.
sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer
brew install xcodegen
./scripts/check
open Leerr.xcodeproj
```

Select `Leerr-iOS` and an installed iPhone simulator, or `Leerr-macOS` and My Mac,
then Run. Start in **Connect**, enter a valid HTTPS Navidrome address and account,
then browse/search **Library**, open an album and select a track. Credentials are
stored in Keychain only after a successful ping. Disconnect before changing
accounts; **Forget saved credentials** removes this configuration's Keychain items.
The app does not silently reconnect on launch.

For **Discover**, enter a Last.fm username/API key. Recommendations use top artists,
similar artists and their album catalogs. For acquisition, enter a Lidarr HTTPS
address/API key, load and explicitly choose the root folder and both profiles,
then enable requests. Choose a resolved release group and edition and confirm the
artist/edition before requesting. **Requests** refreshes acquisition and indexing
while the app is active; imported is not yet available. Profile selections must be
chosen again after disconnect/relaunch. No background polling guarantee is made.

Inspect all these states on both platforms using the checklist below.
`scripts/check` runs package tests and unsigned builds for both targets; it
does not launch an app or validate audio behavior.

For a real iPhone, select your development team in Xcode and use unique bundle
identifiers if necessary. `dev.leerr.ios` and `dev.leerr.macos` are development
placeholders, not registered distribution identifiers. Xcode-only project edits
are overwritten on generation: persist shared settings in `project.yml`, but
keep personal signing configuration out of Git. For a local signing build, pass
`DEVELOPMENT_TEAM=YOUR_TEAM_ID` to xcodebuild. App icons, distribution signing and
store packaging are not part of this foundation.

## Prerequisite for Amp-driven native UI testing

Before assigning native build, Simulator, or visual testing from an orb, make
a Mac runner available. On the Mac, sign in to Amp and run this from its Leerr
checkout:

```sh
amp --no-tui
```

Keep the Mac awake and the runner process running throughout the testing work.
An interactive Amp runner can also be used; `--no-tui` is the recommended
unattended mode, not a requirement for Swift or Xcode themselves. Xcode must be
installed and selected, but its editor window need not be open. Simulator and
macOS visual checks need a usable logged-in graphical session and any required
OS permissions.

Before testing, the agent must:

1. Confirm a live Mac runner is available and use a runner-backed thread for
   native execution. An orb cannot run Xcode or SwiftUI.
2. Confirm the Mac checkout contains the exact changes being tested. Orb and
   runner checkouts are separate; explicitly transfer unpushed changes without
   overwriting unrelated Mac work. Record the tested revision and local changes.
3. Check Xcode/toolchain availability and the intended Simulator runtime or
   connected device, then run the relevant build and launch checks.
4. Capture and inspect representative affected UI states on each affected
   platform. Report the tested device/OS and include an inspected screenshot;
   a successful build or an uninspected capture is not visual verification.

If no Mac runner is available, continue independent core work and report native
build/UI verification as blocked, not passed. Do not substitute a web replica
or Linux tests for native rendering. Manual Xcode testing does not require an
Amp runner, and shared-core tests can still run in the orb. Real-device audio
acceptance remains a separate requirement even when Simulator UI checks pass.

## Shared core on Linux / Amp orbs

Install Swift 6.0.3 using the official [Swift Linux instructions](https://www.swift.org/install/linux/)
and [Swiftly](https://www.swift.org/install/linux/swiftly), then run:

```sh
swiftly install 6.0.3
./scripts/check
```

`.swift-version` selects the reference toolchain when using Swiftly. Linux runs
the package tests only in the check script. XcodeGen can also generate project
files on Linux; SwiftUI, Keychain, AVFoundation and Apple app validation require
the macOS workflow above. There is no web preview
or Linux substitute for native playback testing. This repository does not
provision a Navidrome/Lidarr server or change existing music directories.

## Before calling the first milestone complete

- Run the check script on macOS and launch both targets.
- With the connection/player features implemented, use a test Navidrome account
  over valid HTTPS and a known, legally usable FLAC file.
- Verify original delivery and observed codec/sample rate/bit depth; distinguish
  unknown fields from verified values and do not infer hardware output quality.
- On a real iPhone: exercise seeking, queue, lock screen, background playback,
  interruption, route changes, and Wi-Fi/network loss recovery.
- On a real Mac: exercise seeking, queue, Now Playing/media keys and network loss.
- Record device/OS, Navidrome version, fixture format, transcode settings and
  results without credentials, authenticated URLs or private listening history.

See [architecture](architecture.md) for ownership, security policy and subsequent
implementation gates. Unit tests alone do not pass the audio milestone.

## Native UI acceptance checklist

The [9 September native run](native-verification-2026-09-09.md) covers builds and
disconnected/error UI on Mac and iPhone Simulator. Connected, playback and live
acquisition cases below are still unexecuted. No physical iPhone audio gate passed.

On both iPhone and Mac, record OS/device, exact local revision and inspect captures:

- Connect: blank inputs, invalid HTTPS, wrong credentials, unavailable server,
  retry, cancel during ping, successful connection, Keychain restore/delete.
- Library: loading, empty, paginated and duplicate pages, search including rapid
  replacement, album tracks, error/retry. Disconnect during suspended requests;
  reconnect to an account reusing remote IDs and verify no stale title/track survives.
- Mac windows: open different albums in two windows, verify independent track
  lists and a single shared player/queue and media-command registration.
- Player: preparing/buffering pause, playing/paused, seek, next/previous, queue
  end, unsupported/range/redirect errors and explicit retry. Inspect source,
  delivered and unknown quality text without conflating hardware output.
- Discovery: missing/stale MusicBrainz IDs, ambiguous groups, edition pagination,
  exact IDs in the confirmation sheet, owned/requested exclusions, no results,
  rate-limit/network failures, and account changes. Name-only matches never write.
- Requests: settings/profile validation, confirmation cancel, duplicate tap,
  uncertain add/search, failed search with explicit retry, restart/reconcile,
  imported-but-not-indexed, indexed play.
  Verify another account cannot see the first account's request history.
- Dynamic Type, VoiceOver labels, keyboard navigation on Mac, compact iPhone
  width, light/dark appearance and visible error text without secret-bearing URLs.

Physical audio and real network checks are defined separately in
[lossless acceptance](lossless-acceptance.md). Native rendering is not verified
by Linux syntax parsing or by the fixture suite.
