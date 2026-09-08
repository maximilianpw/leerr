# Setup placeholder

The setup placeholder is the only shipped user screen: a non-interactive `ContentUnavailableView` that names the app and states that Navidrome connection and playback are not available yet.

## Sub-features

- `setup-macos` opens a Mac window titled `Leerr` showing the placeholder.
- `setup-ios` opens the iPhone Simulator app showing the same placeholder copy.
- `setup-copy` shows heading `Leerr`, body `Your music, from your server.`, and `Navidrome connection and playback are coming next.` with no connection controls.

## How to get to it (user POV)

- Run the `Leerr-macOS` scheme on My Mac (or open the built `Leerr-macOS.app`).
- Run the `Leerr-iOS` scheme on an iPhone simulator.

## Driving it with control-leerr

Preconditions:

- `LEERR_VERIFY_DIR` is set to a unique directory.
- `control-leerr doctor` has not yet been run, or it failed because no instance exists in that directory.
- No attempt will be made to reuse a Leerr from `Local/leerr/DerivedData` or a simulator that was already Booted.

- **macOS launch.** Start an isolated Mac instance. Run `.pi/skills/verify-leerr/control-leerr launch macos`. Stdout includes `ok=true`, `bundle_id=dev.leerr.macos`, `window_name=Leerr`, and a `pid=` whose `exec=` path is under `$LEERR_VERIFY_DIR`.
- **macOS identity.** List windows for that pid only. Run `.pi/skills/verify-leerr/control-leerr windows`. Output contains `name=Leerr` and `owner=Leerr` for a `layer=0` window.
- **macOS copy.** Capture and OCR the window. Run `.pi/skills/verify-leerr/control-leerr capture setup-macos --contains "Leerr" --contains "Your music, from your server." --contains "Navidrome connection and playback"`. Exit code `0`. `$LEERR_VERIFY_DIR/evidence/setup-macos.png` shows the title bar `Leerr` and the house-with-note glyph. `$LEERR_VERIFY_DIR/evidence/setup-macos.ocr.txt` contains the heading and both body sentences (the Navidrome line may wrap).
- **macOS empty chrome.** Inspect the screenshot and OCR. There is no button labeled Connect, no text field, and no player controls.
- **iOS launch.** In a separate `LEERR_VERIFY_DIR`, start an isolated simulator instance. Run `.pi/skills/verify-leerr/control-leerr launch ios`. Stdout includes `ok=true`, `bundle_id=dev.leerr.ios`, `sim_name=Leerr Verify …`, and `udid=` for a simulator this run created.
- **iOS copy.** Capture the simulator. Run `.pi/skills/verify-leerr/control-leerr capture setup-ios --contains "Leerr" --contains "Your music, from your server." --contains "Navidrome connection and playback"`. Exit code `0`. The screenshot and OCR show the same heading and body, with no Connect control.

## Gotchas

- The process and executable are named `Leerr-macOS`; the window title and display name are `Leerr`. Matching on process name alone will also hit the developer's instance.
- `open -n -g` starts a new instance without stealing focus. Traffic lights on the screenshot may be grey; that is not a failed launch. Doctor must still reject any pid whose path is not this verify dir.
- `osascript` / System Events cannot inspect this app without Assistive Access. Use `windows` + `capture`.
- OCR splits `Navidrome connection and playback are coming next.` across two lines. Assert the phrase `Navidrome connection and playback`, not a single full-line match.
- The window can appear on a secondary display (negative `x`). CG capture still works; do not move the developer's windows to find it.
- `/tmp` is a symlink to `/private/tmp`. `control-leerr` compares realpaths; do not match pid command lines against the unresolved `/tmp/...` string yourself.
- iOS must use `launch ios`, which creates `Leerr Verify <run-id>`. Installing onto the already-booted iPhone 17 Pro is not verification.
- `CODE_SIGNING_ALLOWED=NO` builds from `./scripts/check` are not the launch path. `launch` uses a Debug ad-hoc signed app that can actually run.
