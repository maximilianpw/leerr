# Jellyfin native verification, 9 September 2026

Both Apple builds and the available native UI checks passed. This does not
verify a live Jellyfin login, connected library, playback or original delivery.
[Execution thread and captures](https://ampcode.com/threads/T-01a084be-b3a9-749d-90d7-d68d6bf6fcbd).

The Mac checkout fast-forwarded from `1c71921b3ec97174e020a749f85462a5fa086da5`
to the parent's bundled `f625ef4c072594617382b651ca2c762e68817da4` after bundle
verification. The repository was not shallow and had no unrelated worktree changes.
Tested app code is `0abbda067224f1fa579341ae71c053eee2551a0a`, which adds the
accessibility fix below. The subsequent report commit changes documentation only.
No push, service installation, personal-server probe or shared-server mutation occurred.

## Environment and results

- Xcode 26.5 build 17F42, Apple Swift 6.3.2, XcodeGen 2.46.0.
- Native MacBook Pro arm64, macOS 27.0 build 26A5425a.
- Dedicated iPhone 17 Simulator, iOS 26.5 build 23F73, named
  `Leerr Verify Jellyfin`, ID `37C4215C-A8AA-4964-BFA1-D8BA503EF610`.
- Final `./scripts/check`: **102 tests passed**, then **BUILD SUCCEEDED** for
  both `Leerr-macOS` and `Leerr-iOS` with unsigned build settings.
- Native `xcodebuild test`: the complete provider/migration/error interaction
  test **passed on Mac and iPhone Simulator**. A separate dark/XXXL provider
  presentation test **passed on iPhone Simulator**. No test was skipped.
- UI tests build the actual `Apps/Leerr` sources and `LeerrCore`, with ad-hoc
  signing and isolated `dev.leerr.jellyverify.*` bundle IDs. No web replica,
  preview, injected connection state or mock music-server responses were used.

The initial Mac run timed out during XCTest keyboard-event synthesis. The
serial rerun passed all actions; this was not treated as a product defect.

## Native accessibility fix

The iPhone picker exposed `Server type, Server type` as its accessible button
label and omitted the selected value. The explicit `.accessibilityLabel`
overrode SwiftUI's native selection label. Replacing it with the stable
`server-type` accessibility identifier preserves the platform's label/value.
Tests now assert that accessibility reports the selected Jellyfin or Navidrome
value, in addition to actually operating the picker on both platforms.

## What the tests exercised and captures show

- Legacy `navidrome.endpoint` fallback selects Navidrome and restores a disposable
  legacy endpoint. This used the isolated app's launch-argument defaults domain,
  not a user's on-disk preferences. No legacy credentials were read or deleted.
- Without that legacy default, initial selection is Jellyfin. Help explicitly
  says the existing Jellyfin account needs a Music library and Navidrome is not required.
- Typing distinct endpoint/username/password inputs, switching to Navidrome,
  typing different inputs and switching back clears all three fields each time.
  The Connect action is disabled after each switch. This proves unsaved-input
  isolation, not authenticated provider-specific Keychain restore.
- Both Navidrome and Jellyfin selections survive terminating and relaunching the
  isolated app without launch overrides. These are actual persisted preferences.
- An HTTP endpoint produces the safe configuration error. An unavailable reserved
  HTTPS hostname produces `The server could not be reached securely.` with usable retry.
- A temporary loopback TCP listener held TLS negotiation open, without completing
  TLS, reading/logging payloads or accepting authentication. While connecting, the
  server picker and endpoint field were disabled. Cancel restored the picker,
  removed the connecting state and retained the typed fields for explicit retry.
- Dark appearance with XXXL Dynamic Type renders both provider choices and their
  appropriate help. The tested provider content has no horizontal clipping.

All 22 explicit native captures were inspected. Password fields are masked or
blank; visible usernames and endpoints are disposable fixtures. Mac captures
contain the app window only. iOS's floating tab bar covers the bottom of scrollable
content, as in the preceding native run. It is not evidence that lower rows are
unreachable. A system password suggestion appears on one Mac cleared-field capture.

## Reproduction and evidence

The evidence archive contains `JellyfinUITests.swift`, its XcodeGen `project.yml`,
the final check log, three XCTest summaries and directories `macos`, `ios`, and
`ios-dark-xxxl` containing named captures. The project uses this runner's absolute
checkout path; adjust it and create a dedicated simulator before repeating elsewhere.
The main interaction test expects a fresh isolated application preferences domain.
Do not clear the real app's defaults or Keychain to repeat it.

Commands used:

```sh
./scripts/check
xcodegen generate --spec .build/jellyfin-verification/project.yml
xcodebuild -quiet -project .build/jellyfin-verification/JellyfinNativeVerification.xcodeproj \
  -scheme VerifyMac -destination 'platform=macOS,arch=arm64' \
  -derivedDataPath /tmp/leerr-jellyfin-mac/DerivedData \
  -resultBundlePath /tmp/leerr-jellyfin-mac/result-2.xcresult \
  -only-testing:VerifyMacTests/JellyfinUITests/testProviderSelectionMigrationIsolationAndFailures test
```

The phone command uses `VerifyPhone`, the `VerifyPhoneTests` test target,
`platform=iOS Simulator,id=37C4215C-A8AA-4964-BFA1-D8BA503EF610`, and
`/tmp/leerr-jellyfin-phone/{DerivedData,result-2.xcresult}`. The dark run selects
`testDarkLargePresentation` after `simctl ui` sets appearance `dark` and
content size `extra-extra-extra-large`, and writes `result-dark.xcresult`.
The connecting check needs a loopback listener on port 18443 that accepts TCP
connections and holds them for 20 seconds without completing TLS. No certificate
bypass or Jellyfin installation is required. The test listener exits after ten minutes.

## Still unverified

No authorized Jellyfin credentials were supplied. Successful authentication,
the **connected** picker-disabled state, saved credential restore between real
providers, account journals, music browsing, audio playback and original-delivery
evidence remain unverified natively. The connecting-state check does not stand
in for these cases. Physical iPhone execution and live audio were not attempted.
Core adapter/identity/transport tests are separate evidence, not a live-server pass.
Use the user's existing authorized Jellyfin server for the next gate; do not
install Navidrome or weaken TLS requirements to finish it.
