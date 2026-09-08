---
name: verify-leerr
description: Drive the Leerr native macOS and iOS SwiftUI apps to prove user-facing behavior with isolated launches, screenshots, and OCR. Use when verifying Leerr launch, the setup placeholder, later connection/library/playback UI, or when a change needs visual proof on Apple platforms.
---

# Verify Leerr

Leerr is a native SwiftUI music app (`Apps/Leerr/LeerrApp.swift`) with macOS and iOS targets generated from `project.yml`. There is no web UI, CLI, or companion server. The shipped user surface is a non-interactive setup placeholder; Navidrome, Lidarr, and Last.fm are not implemented.

Drive only instances this skill started. The developer often has a personal `Leerr-macOS` from `DerivedData/Build/Products/Debug/` and a Simulator `Leerr-iOS` already running — never attach to those.

## Launch

Requires macOS with Xcode, `xcodegen` (`brew install xcodegen`), and a unique verify directory. Linux orbs cannot drive the apps.

```sh
export LEERR_VERIFY_DIR=/tmp/leerr-verify-$RUN_ID
.pi/skills/verify-leerr/control-leerr launch macos
```

Ready when `doctor` prints `ok=true` and a window named `Leerr` exists for the recorded pid. `launch` is idempotent for a live instance in that `LEERR_VERIFY_DIR`.

iOS uses a simulator this run creates (`Leerr Verify <run-id>`), never the developer's already-booted device:

```sh
export LEERR_VERIFY_DIR=/tmp/leerr-verify-$RUN_ID
.pi/skills/verify-leerr/control-leerr launch ios
```

Build products live under `$LEERR_VERIFY_DIR/instance/DerivedData`. The macOS app is `Leerr-macOS.app` (process/executable name `Leerr-macOS`, display name and window title `Leerr`, bundle id `dev.leerr.macos`, version from Info.plist, currently `0.1.0`). The iOS app is `Leerr-iOS.app` / `dev.leerr.ios`.

Teardown is `cleanup` (see Cleanup). `xcodegen generate` writes gitignored `Leerr.xcodeproj` in the repo; that is expected.

## Doctor

Run before the first drive, after any failed drive, and whenever the instance looks wrong:

```sh
.pi/skills/verify-leerr/control-leerr doctor
```

Pass means: state file exists; platform is `macos` or `ios`; the recorded process is alive; macOS executable path is exactly the app built into this `LEERR_VERIFY_DIR` (not `Local/leerr/DerivedData`); bundle id matches; macOS has an on-screen layer-0 window named `Leerr`; iOS is a Booted simulator this run created with `dev.leerr.ios` installed and running.

Fail means stop driving. If doctor fails because this skill's helper drifted, fix the helper and relaunch. If it fails because a foreign Leerr is the only one running, do not adopt it — launch a new isolated instance.

## Drive

`control-leerr` is the harness. It targets the pid/UDID in `$LEERR_VERIFY_DIR/instance/state`. Do not use `killall`, `pgrep Leerr`, or System Events by process name: those hit the developer's instance too. Accessibility/`osascript` is not available in this environment (`osascript is not allowed assistive access`); identify UI with CG window titles plus screenshot OCR.

```sh
.pi/skills/verify-leerr/control-leerr windows
.pi/skills/verify-leerr/control-leerr capture setup-placeholder \
  --contains "Leerr" \
  --contains "Your music, from your server." \
  --contains "Navidrome connection and playback"
```

`capture` writes `$LEERR_VERIFY_DIR/evidence/<prefix>.png` and `<prefix>.ocr.txt`. Stable handles:

- Window title `Leerr` (macOS CG window name and title bar)
- Heading `Leerr`
- Body `Your music, from your server.`
- Body `Navidrome connection and playback are coming next.` (OCR often wraps after `are`)
- SF Symbol house-with-note (visible on the screenshot; not an AX role here)
- No buttons, fields, or connection controls on the current screen

Read `features/README.md` and the matching feature file before driving. Exercise every entry point the feature file lists, not only the convenient one.

The placeholder is non-interactive: there is nothing to click. Proof is launch + identity + copy. When connection, library, or playback UI ships, add feature files and drive those controls by label; do not invent those paths while they are absent.

## Evidence

Put proof in `$LEERR_VERIFY_DIR/evidence/` (outside the instance tree). Cleanup must not delete it.

For a pass, keep:

- The `launch`/`doctor` stdout (`ok=true`, pid, bundle id, window id or UDID)
- A screenshot of the action result with the Leerr window/title visible
- The OCR text of that screenshot, matching the feature's expected copy
- The feature id and entry point (`setup-macos` or `setup-ios`)

Exercise the real app binary, not unit tests or internal setters, as the user-visible proof. `swift test` / `./scripts/check` can accompany a change; they do not replace a screenshot of the running app. Capture the launched state, not only a final crop that hides the window title. There is no persistence to mutate yet; do not mock Navidrome.

## Cleanup

```sh
.pi/skills/verify-leerr/control-leerr cleanup
```

Stops only the pid whose executable is this run's app (macOS) or terminates `dev.leerr.ios` on the created simulator (iOS), then deletes that simulator if `SIM_CREATED=1`, then `rm -rf $LEERR_VERIFY_DIR/instance`. Leaves `$LEERR_VERIFY_DIR/evidence`.

Never `killall Leerr-macOS` or shut down a simulator you did not create. After cleanup, confirm the evidence files still exist and that any pre-existing Leerr pid (for example one from `.../Local/leerr/DerivedData/.../Leerr-macOS`) is still running if it was running before launch.

## Helpers

All invocations assume repo root and a set `LEERR_VERIFY_DIR`.

| Command | What it does |
| --- | --- |
| `control-leerr launch macos\|ios` | Generate, Debug-build, start isolated instance, then doctor |
| `control-leerr doctor` | Read-only health/identity check |
| `control-leerr windows` | macOS CG window dump for the recorded pid |
| `control-leerr screenshot [path]` | Capture instance window or simulator |
| `control-leerr ocr [path] --contains TEXT` | OCR; exit 1 if TEXT is missing |
| `control-leerr capture PREFIX --contains TEXT` | Screenshot + OCR under `evidence/PREFIX.*` |
| `control-leerr stop` | Kill only this instance |
| `control-leerr cleanup` | stop + delete `instance/` and created simulator |

`control-leerr` compiles `helpers/LeerrUI.swift` into `$LEERR_VERIFY_DIR/instance/leerr-ui` on first use.
