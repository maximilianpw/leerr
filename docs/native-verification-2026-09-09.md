# Native builds and disconnected UI passed; live acceptance remains open

Executed on 9 September 2026, Europe/Paris, on maxpw's Mac runner.
[Verification thread](https://ampcode.com/threads/T-01a084be-b3a9-749d-90d7-d68d6bf6fcbd).

Imported the parent's eight unpushed implementation commits from a verified Git
bundle, based on `ca3b0c76c388fc0b13f7223339275f9db26f3abd` and ending at
`f1497d095f0797a739beca97b21177ae583d6f69`. The Mac repository was not shallow.
Its clean local main fast-forwarded safely; no user changes were replaced.
Tested application code is commit
`32bb4f5cf55748e79ad1952ed1cafdac0ac63c0c`; the following documentation commit
does not change that code. No push, deployment or shared-service write occurred.

## Environment and executed checks

- MacBook Pro, arm64, macOS 27.0 build 26A5425a.
- Xcode 26.5 build 17F42; Apple Swift 6.3.2; XcodeGen 2.46.0.
- Dedicated iPhone 17 Simulator, iOS 26.5 build 23F73. The pre-existing simulator
  and the user's running Leerr process were not used for UI testing.
- `./scripts/check`: **86 core tests passed**, followed by **BUILD SUCCEEDED** for
  both `Leerr-macOS` and `Leerr-iOS`, unsigned as specified by the script.
  The Apple Security branch of the Keychain test executed actual isolated
  save/load/replace/delete operations, not the Linux unavailable-store branch.
- The built iOS Info.plist contains `UIBackgroundModes = [audio]`. This is
  configuration evidence, not proof of background playback.
- The original `Leerr-iOS` target was also rebuilt with default ad-hoc signing,
  installed on the dedicated simulator and captured at launch. Its Connect
  screen has no Keychain warning. Launching the unsigned `scripts/check` product
  first had shown the safe Keychain-unavailable message; unsigned builds are
  compile checks, not the supported credential-storage launch configuration.
- Native XCTest UI suite: **2 tests passed on Mac**, **2 on iPhone Simulator**,
  and **2 more in dark appearance with XXXL Dynamic Type** on that simulator.
  Tests compile the actual `Apps/Leerr` sources and `LeerrCore`, with separate
  verification bundle identifiers and ad-hoc signing. No model-state injection,
  fake network transport, web replica or preview replaced the app.

The test-only XcodeGen project, XCTest source, summary JSON and inspected PNGs
are retained as evidence in this thread's `.build/native-evidence/`, and packaged
for transfer to the parent. The Xcode result bundles remain under
`/tmp/leerr-native-mac-tests/ui-results-3.xcresult`,
`/tmp/leerr-native-phone/ui-results-3.xcresult`, and
`/tmp/leerr-native-phone/ui-dark-large.xcresult` on this runner.

The test invocation used `xcodebuild test`, schemes `VerifyMac` / `VerifyPhone`,
an isolated derived-data directory, and destinations `platform=macOS,arch=arm64`
and `platform=iOS Simulator,id=17679AF1-6A0D-4195-AC4A-A77151B98667` respectively.
The evidence project records the exact configuration and source paths. Create a
new simulator and adjust the checkout path before repeating it elsewhere.
The legacy verification skill still describes the removed placeholder and its
fixed `Leerr` window title; XCTest drove current tabs by accessibility instead.

## Native failures fixed

1. MusicBrainz User-Agent validation accepted CRLF on this Apple toolchain.
   Swift treats CRLF as a single grapheme, so individual-character `contains`
   checks were not sufficient. UTF-8 checks now reject either byte. Regression
   coverage includes CR, LF and CRLF, and the full core suite passes.
2. Swift 6 rejected moving a non-Sendable `Notification` into the main-actor
   playback callback. Callbacks now extract the player item or integer event
   fields first; they retain main-queue delivery and existing playback policy.
   Both Apple platform branches compile successfully.
3. Mac grouped-form text fields had visible captions but no accessibility labels
   in the XCTest hierarchy. Explicit labels now allow native tests to locate and
   type into the connection fields by name on both platforms.

## Inspected states and actual interactions

For each platform, screenshots cover `connect-blank`, `library-disconnected`,
`discover-unconfigured`, `requests-unconfigured`, `connect-invalid-https`,
`connect-unavailable-server`, and `connect-settings-disabled`.
Mac captures contain only the tested window. The iPhone suite also retained all
seven states in dark/XXXL appearance.

The tests select every tab, assert unavailable actions are disabled, enter
disposable inputs, reject `http://example.invalid`, and recover from
`https://example.invalid` with a sanitized network error and usable retry.
They scroll to the lower settings and check that requests cannot be enabled
without connection/root/profile prerequisites. No credentials were saved by
these failed connection attempts, and no acquisition was issued.

Inspection found readable errors and instructions, masked passwords, working
navigation and reachable lower controls. iOS uses a floating tab bar over
scrollable content; lower rows can be brought above it by scrolling. Secure-field
XCTest captures can omit the keyboard while retaining its occupied layout area.
This was not treated as a static form-clipping defect. Standard secondary text
on Mac is faint, but the captured instructions remain readable.

## Not verified and still required

- `devicectl list devices` reported the paired iPhone 16 Pro Max unavailable.
  Physical iPhone execution did not occur. The available Mac did not perform
  live audio playback because no authorized server/fixture/capture setup was supplied.
- No saved Mac Navidrome endpoint or local environment file was found. No
  credential values were printed or copied. Existing personal services were not
  probed or changed. A saved secret, if present elsewhere, would not itself grant
  permission to mutate a server or use private listening history in evidence.
- Successful native authentication, app Keychain restore/delete after login,
  connected library loading/pagination/search/album tracks, multiwindow album
  isolation, player/queue/loading/error/quality UI, and exact acquisition
  confirmation remain unexecuted against live services.
- Original FLAC delivery, AVFoundation custom-resource-loader behavior, byte/PCM
  correlation, seek/queue transitions, media keys/Now Playing, lock screen,
  backgrounding, interruptions, route changes, network recovery and real
  API/media redirect security remain **NOT RUN**, not inferred from build success.
- No full VoiceOver session, keyboard-only traversal, physical audio route or
  minimum-supported OS run was performed. Accessibility labels and XXXL simulator
  rendering are narrower evidence.

PRS-317 through PRS-323 must remain **In Progress**. PRS-324 through PRS-330 are
fixture/procedure completions only. Follow [lossless acceptance](lossless-acceptance.md)
and the remaining [native checklist](development.md#native-ui-acceptance-checklist)
with authorized test services and a physical iPhone before clearing those gates.
