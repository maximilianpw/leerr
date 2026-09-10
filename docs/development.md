# Development and verification

## Server and web

Use Node.js 22.13 or newer. Package versions are exactly pinned in
`package-lock.json`.

```sh
npm ci
npm run lint
node scripts/check-anti-slop.mjs
npm test
npm run build
```

Oxlint 1.82.0 and `@oxlint/plugins` 1.82.0 must remain matched. The supported
JavaScript-plugin integration enables all 17 vendored anti-slop general rules,
plus native `oxc/no-accumulating-spread`. `tools/oxlint/README.md` records the
pinned upstream revision and license provenance.

### Constrained Linux lint workaround

The Oxlint plugin can reserve roughly 4 GiB of aligned virtual address space per
thread due to [oxc-project/oxc#20331](https://github.com/oxc-project/oxc/issues/20331)
and [#22966](https://github.com/oxc-project/oxc/issues/22966). A small, swapless
Linux orb with `vm.overcommit_memory=0` can reject that reservation even though
the memory is virtual. Inspect before diagnosing:

```sh
grep -E 'MemTotal|SwapTotal' /proc/meminfo
sysctl vm.overcommit_memory
```

Prefer a supported environment with sufficient VM capacity/swap. For an
isolated disposable orb, an administrator may explicitly choose
`sudo sysctl -w vm.overcommit_memory=1`; that was done in this orb. This is not
a universal Node/macOS requirement, is not needed by the production runtime,
and lint scripts must never silently change a host sysctl.

## Swift and Apple clients

Run shared tests with the reference Swift 6.0.3 toolchain:

```sh
swift test
```

For native apps use macOS, Xcode 16.2+ (with the desired iOS Simulator), and
XcodeGen 2.42+:

```sh
./scripts/check
open Leerr.xcodeproj
```

`project.yml` is authoritative; do not commit generated Xcode projects or local
signing settings. The native clients now sign into Leerr and store only their
Leerr bearer session in its Keychain namespace. Earlier direct Jellyfin,
Navidrome, Lidarr, and Last.fm adapters/tests remain in the tree, but current app
composition does not migrate or remove those credentials.

Native verification runs in [the Mac runner thread](https://ampcode.com/threads/T-01a086f7-17ca-7188-8aae-9764a3ba593f).
Final source passed 107 Swift tests and both unsigned builds on macOS 27/Xcode
26.5. Final XCTest runs each had 1 pass and 1 failure: Mac lost the app window
after relaunch; iPhone Simulator computed an invalid Discover tap point after
Library. Mac signed-out tabs and iPhone login/errors were exercised; final
iPhone Discover/Requests were not reached. Earlier 2/2 passes on each platform
are not a final-source pass. Authenticated UI/races need a trusted TLS fixture.
Do not treat Linux
`swift test`, an Xcode compile, or Simulator screenshots as real-device audio
acceptance. Before release, verify both app targets and representative UI states
on a Mac, then test original streaming, Range seeking, ticket refresh,
interruptions, routes, background controls, and network loss on real iPhone and
Mac hardware. Record OS/device, upstream versions, and fixture characteristics,
without secrets or ticket URLs. Live upstream credentials and hardware were not
provided for the current verification.

## Current verification boundary

`npm test` passed 27 tests; `npm run lint` passed including the deliberate
anti-slop rejection probe; `npm run build` passed strict TypeScript and Vite.
Tests cover encrypted backup/reopen, v1 migration, reset/rotation, permission
isolation, uncertain mutation reconciliation, and synthetic FLAC full/range/416
responses and streaming cancellation. Docker image construction, UID 1000
startup, first-account setup, and account persistence after restart passed.
Chromium setup/login/settings/library/album/edition/request success and progress,
empty/error, and narrow states were rendered and inspected. Dialog modal/focus
and Escape behavior were checked; narrow Chromium is not native iOS verification.
Production restore drills, live upstream compatibility and real-device playback
remain release gates in the [plan](shared-server-plan.md).

Artwork delivery is implemented through the authenticated, no-store
`/api/v1/artwork/:id` proxy. A test verifies per-user Jellyfin item authorization
precedes image retrieval, successful PNG bytes match exactly, and anonymous or
upstream-denied requests never retrieve the image. The preview uses three
original synthetic geometric PNG covers in `server/fixtures/cover-*.png`, drawn
locally with ImageMagick (no external artwork or personal data), and deliberately
omits the final cover to exercise fallback rendering. Repetition in the fixture
is intentional, not an artwork lookup limitation. Live Jellyfin is unverified.

### Bundled font provenance

`web/src/fonts/InterVariable.woff2` was downloaded on 2026-09-09 from
`https://github.com/rsms/inter/raw/master/docs/font-files/InterVariable.woff2`.
It is the master docs WOFF2 (352240 bytes, font-file version 4.66), not the
tagged 4.1 release archive. SHA-256:
`693b77d4f32ee9b8bfc995589b5fad5e99adf2832738661f5402f9978429a8e3`.
The complete upstream SIL OFL 1.1 copyright/license is bundled beside it in
`web/src/fonts/LICENSE.txt`.
