# Architecture

## Runtime boundary

```text
React web ──────┐
Swift iOS/macOS ├── HTTPS ── Fastify API + reconciliation worker ── upstreams
                └────────────── SQLite (WAL, schema version 2)
```

Production is one Node process and one SQLite database. The process serves the
built web UI, API, original-audio proxy, and serial worker. Multi-instance or
horizontal operation is unsupported; there is no distributed lock.

The current Swift composition uses `LeerrAPI` for account, library, and stream
access while native AVFoundation/system-media code owns playback. The repository
also retains the real legacy direct Jellyfin/Navidrome, Keychain, playback,
Lidarr, Last.fm, and MusicBrainz adapters and their tests. They are retained for
history/rollback, not silently migrated: the current application neither reads
nor deletes old service credentials.

## Trust and data ownership

- Leerr passwords are Argon2id hashes (64 MiB, three iterations, one lane).
- Opaque web/native session values are stored as SHA-256 digests and expire 30
  days after issue. Browser cookies are Secure, HttpOnly, SameSite=Strict and
  mutations additionally require the session CSRF value. Native bearer sessions
  are distinct and revocable.
- Installation settings and per-user connections are AES-256-GCM encrypted.
  AAD is exactly `owner + NUL + service`, binding ciphertext to both scopes.
  The separately mounted 32-byte key is not in SQLite.
- Jellyfin's endpoint is installation-owned, while access token/user ID are
  per-user so library, artwork, and playback retain upstream permissions.
- Lidarr is installation-owned. Requests are per user but reference a shared,
  deduplicated acquisition keyed by MusicBrainz release-group identity.
- Last.fm stores a public username and API key per user. Current methods are
  read-only public API requests; no OAuth, scrobbling, or private session exists.

The server does not enable request/access logging. Generic API errors avoid raw
upstream bodies and URLs. The edge proxy must likewise redact stream-ticket
paths and query authentication before any access/upstream logging.

## Catalog, requests, and playback

`GET /library` supports `offset`, `limit` (1–500, default 24), and `q`; Jellyfin
reports the total. Album tracks are internally fetched in pages of 500. Resolve
uses MusicBrainz limits of 25 groups and 100 editions. Recommendations are a
bounded upstream result, not a general paging API. Request listing returns at
most the newest 500 and currently has no paging parameters.

Request creation requires explicitly confirmed release-group, release, and
artist UUIDs. “Imported” means Lidarr imported an album. “Available” is computed
separately for each requesting user only when their Jellyfin account can see the
matching release group.

Original audio is proxied without intentional transcoding or whole-file
buffering. An opaque account/track/session-bound ticket lasts 15 minutes; its
path contains the credential and supports Range/206/416 only while valid.
Revoking a session or Jellyfin connection aborts related active streams.
Delivered bytes/format and hardware output still require live verification;
metadata alone does not prove lossless or bit-perfect playback. Browser playback
is deliberately deferred.

## Reconciliation safety

The single worker polls bounded batches with backoff and writes durable intent
before each Lidarr mutation. After a timeout it reads authoritative album and
command state; it never blindly repeats an uncertain add, monitor, or search.
If Lidarr command history is missing, the request remains `uncertain` and needs
manual inspection. A user retry advances only a known failed-search journal.
Imported and Jellyfin-available remain distinct.

## Verification status

The API/store/worker and UI are implemented. All 27 server tests, lint with an
active anti-slop rejection probe, and TypeScript/Vite builds pass. Docker build,
non-root runtime and restart persistence pass; representative web states were
rendered and inspected. The Mac runner reported 107 Swift tests, both unsigned
builds passing and reachable signed-out states inspected. Final UI runs each
had 1 pass and 1 automation failure; authenticated/native audio gates remain
open. No live upstream credentials or playback hardware
were supplied. See [development.md](development.md) for the verification boundary
and keep unexercised release gates in [shared-server-plan.md](shared-server-plan.md)
open.
