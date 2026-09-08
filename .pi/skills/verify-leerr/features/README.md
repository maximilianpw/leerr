# Leerr verification map

This directory is the maintained source for verifying Leerr's user-facing behavior. Read this index before driving the app, then use the matching feature file as the recipe.

## Baseline preconditions

- macOS with Xcode and `xcodegen` on `PATH`.
- `export LEERR_VERIFY_DIR=/tmp/leerr-verify-$RUN_ID` with a unique `RUN_ID`.
- Launch with `.pi/skills/verify-leerr/control-leerr launch macos` (or `launch ios`).
- `control-leerr doctor` prints `ok=true` for that directory's instance.
- Never drive a Leerr whose executable path is outside `$LEERR_VERIFY_DIR`.

## Driving conventions

- Start every recipe from a freshly doctored instance unless the feature says otherwise.
- Identify UI by window title `Leerr` and OCR of the screenshot. Do not use System Events or click coordinates.
- Treat every `control-leerr` command as literal.
- Restore nothing after the placeholder (it has no persisted state). Keep proof artifacts.

## Proof and skip reporting

- Capture the launched app and the resulting screen, not only a cropped glyph.
- macOS proof includes doctor stdout, a window screenshot with the title bar, and OCR text.
- iOS proof includes doctor stdout, a simulator screenshot, and OCR text.
- Record the feature ID and entry point with every artifact.
- Report an unreachable path with the command attempted and the unmet precondition (for iOS: no Simulator runtime, or a request to use the developer's already-booted sim).
- Do not report a skipped platform as verified through the other platform.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order: `Sub-features`, `How to get to it (user POV)`, `Driving it with control-leerr`, `Gotchas`.

## Features

- [Setup placeholder](./setup-placeholder.md) covers the honest coming-soon screen on macOS and iOS Simulator.

## Not shipped

These product surfaces exist only in docs (`README.md`, `docs/architecture.md`). Do not treat them as present, and do not add feature files until the app exposes them:

- Navidrome connect / disconnect / retry
- Library browse, search, album tracks
- Playback, queue, Now Playing, format readout
- Lidarr request / acquisition tracking
- Last.fm discovery
