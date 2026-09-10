# Leerr

Leerr is a self-hosted music discovery, request, and playback application. A
single TypeScript/Fastify process serves the React web UI, `/api/v1`, and a
bounded reconciliation worker backed by SQLite. Native iPhone and macOS clients
compose against that Leerr API; browser playback is intentionally deferred.

This checkout is not a scaffold. It includes the server and web application and
a substantial earlier native implementation: direct Jellyfin and Navidrome
adapters, Keychain credential storage, original-file playback, Lidarr
acquisition, Last.fm/MusicBrainz discovery, and tests. The current native
composition uses `LeerrAPI`; it deliberately does **not** discover, migrate,
read, upload, or delete credentials saved by those legacy adapters. Re-enter
connections in Leerr and retain old credentials until rollback is no longer
needed.

## What is implemented

- local administrator/member accounts, Argon2id password hashes, 30-day web and
  native device sessions, CSRF checks, revocation, and login/setup rate limits
- administrator-owned Jellyfin endpoint and Lidarr settings; per-user encrypted
  Jellyfin tokens and read-only Last.fm public username/API-key connections
- paginated Jellyfin library/search (default 24, maximum 500), album tracks and
  artwork, preserving each Jellyfin user's permissions
- account-scoped 15-minute opaque tickets that proxy Jellyfin original streams,
  including Range responses and cancellation
- MusicBrainz resolution/edition confirmation, durable per-user requests, and a
  serial Lidarr reconciliation worker with mutation journaling
- React setup, login, settings, library, discovery, and request interfaces

“Imported” is Lidarr state; “available” is computed per user only after that
user can see the album in Jellyfin. Request listings are capped at the newest
500 records and are not currently cursor-paginated. Last.fm access uses public,
read-only API calls—there is no OAuth, scrobbling, or private Last.fm session.

The worker never blindly repeats a journaled uncertain Lidarr mutation. If
Lidarr history has disappeared, state remains uncertain and requires operator
inspection rather than an automatic repeat. Multi-instance/horizontally scaled
operation is not supported.

## Quick development checks

Node 22.13+ and Swift 6.0.3 are the reference environments.

```sh
npm ci
npm run lint
node scripts/check-anti-slop.mjs
npm test
npm run build
swift test
```

Native build/UI verification requires Xcode 16.2+, XcodeGen 2.42+, and a Mac;
see [development.md](docs/development.md). Local verification passed 27 server
tests, lint with an active anti-slop rejection probe, TypeScript/Vite builds,
and Docker build/non-root startup/account persistence across restart. Rendered
web setup, settings, library, editions, requests, empty/error, and narrow layouts
were inspected. The Mac runner passed 107 Swift tests, both unsigned app builds,
and inspected reachable signed-out UI. Final XCTest runs each had 1 pass and
1 failure (Mac relaunch/window discovery; iPhone Simulator tab targeting).
Authenticated UI/audio acceptance remains open: no live Jellyfin/Lidarr credentials
or playback hardware were supplied. See the development verification boundary
before release.

## Deployment

See [server-development.md](docs/server-development.md) for the complete Docker,
HTTPS proxy, key, setup, backup/restore, and recovery runbook. In brief: deploy
one container/process, persist `/data`, mount a separately protected read-only
file containing a base64-encoded 32-byte encryption key, and put Leerr behind an
HTTPS reverse proxy. Preserve `Host` and set `LEERR_TRUST_PROXY` only to the
proxy's exact IP addresses/CIDRs.

## Documentation

- [Architecture](docs/architecture.md)
- [Development and verification](docs/development.md)
- [Shared-server plan and release gates](docs/shared-server-plan.md)
- [Server deployment and operator runbook](docs/server-development.md)
- [OpenAPI 3.1 contract](docs/openapi.yaml)
