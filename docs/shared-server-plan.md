# Shared server and web UI plan

Status: approved plan with implementation in progress, 9 September 2026. The
server, web UI, version-2 SQLite store, worker, Docker definition, API adapter,
and native Leerr composition now exist. This checkout also had real legacy
direct Jellyfin/Navidrome, Keychain, playback, acquisition, and discovery code;
it was never merely a shell. Passing implementation tests does not close every
security, live-upstream, deployment, native-device, or release gate below.

## Product and scope

Run one self-hosted Leerr server. Sign in to it with the same Leerr account on
the web, Mac and iPhone, with separate revocable device sessions. Configure
service connections once on the server instead of repeating setup on each
device. Leerr credentials are distinct from credentials for connected services.

The web UI takes inspiration from Seerr: artwork-led discovery, search, album
details, requests and acquisition progress. Native apps remain the preferred
players, using AVFoundation and system media controls. Browser playback,
offline downloads, push notifications, public registration, SSO and request
approval workflows are outside the first release.

## System boundary

```text
Web browser ───────┐
macOS app ────────┼── HTTPS ── Leerr server ── Jellyfin
iPhone app ───────┘                │        ├─ Lidarr
                                  │        ├─ Last.fm
                                  │        └─ MusicBrainz
                                  └─ SQLite + encrypted service secrets
```

The server owns authentication, authorization, service connections, identity
resolution, durable requests and reconciliation. All clients use the same
versioned API and request records. The browser and API share an origin.
Clients own presentation and local interaction state; native clients also own
their playback queue, audio transport and operating-system integration.

Proposed stack: TypeScript, React with Vite, Fastify, and SQLite, deployed as
one Docker container with a persistent data volume. A single server process
serves the built web UI, API and bounded reconciliation worker. Use maintained
authentication/cryptography libraries rather than bespoke primitives. Select
and pin specific packages during implementation. No Redis, separate worker
service or horizontally scaled deployment is needed initially.

Keep SwiftUI and LeerrCore. Implement the existing MusicServer boundary with a
Leerr API adapter instead of making each client integrate every upstream
service. Define the HTTP contract with OpenAPI and exercise it from both
TypeScript and Swift tests; do not try to share runtime code across languages.

## Accounts, sessions and service ownership

| Data | Owner and behavior |
| --- | --- |
| Leerr account | Local username/password; passwords hashed with Argon2id, never reversibly encrypted |
| Browser session | Opaque server-side session, Secure/HttpOnly/SameSite cookie; CSRF protection on mutations |
| Native session | Separate revocable opaque bearer token stored in Keychain; never the Leerr password |
| Lidarr URL/API key | Administrator-managed installation connection; never returned to ordinary clients |
| Jellyfin URL | Administrator-managed installation connection initially |
| Jellyfin access token | Per-user connection, stored encrypted on Leerr; do not retain the user's Jellyfin password after authentication |
| Last.fm connection | Per-user public username and API key; read-only public methods only, with no OAuth, scrobbling, or private session |
| Service encryption key | Deployment secret kept separately from the database; never committed or logged |

Start with administrator and member roles. Both may discover and request;
only administrators manage users, installation settings and service secrets.
Members see their own requests and sanitized shared album availability, not
other users' identities or listening histories. Every API route enforces its
permissions server-side. A shared album acquisition can satisfy several user
requests without exposing their private records.

Bootstrap the first administrator using a one-time deployment-generated setup
token, disable setup after completion, and let administrators create subsequent
accounts. No open signup. Provide an operator-local password reset command;
password resets and account disabling revoke sessions. Sessions have expiry,
logout and per-device revocation; rate-limit login and setup attempts.

Keep upstream secrets out of browser storage, API responses, analytics and
logs. Connection responses expose only status and safe metadata. Disconnecting
deletes the relevant secret, invalidates related cached data and stops affected
work. Changing Leerr account cancels client requests and clears playback and
account-scoped caches. Upstream authentication failure prompts reconnection,
not a misleading Leerr login failure.

## Playback and network security

Initially proxy original audio through Leerr using each user's Jellyfin
connection. This keeps upstream passwords and authenticated URLs off clients,
at the cost of server bandwidth. Test AVFoundation authentication early: use
short-lived opaque stream tickets if normal API authentication cannot be
applied reliably. Tickets are account/track-scoped, expiring and revoked with
their session; redact them from all access logs. Do not rely on undocumented
AVFoundation header injection. Range retries must work during ticket lifetime;
expired playback authorization must be recoverable without retaining secrets.

The proxy must stream without buffering whole files or transcoding, propagate
cancellation and preserve correct Range/206/416 behavior and content metadata.
Verify received audio bytes independently of library metadata. Report original
delivery, observed stream format and hardware output as separate facts.

Require HTTPS for client access. Keep the existing HTTPS-only upstream policy
initially; HTTP on a private network needs an explicit later policy decision.
Upstream endpoints are administrator-configured, not arbitrary URLs submitted
to a proxy. Permit configured private service hosts without creating an open
proxy: restrict schemes, reject embedded credentials, validate destinations,
and reject redirects to unapproved origins or HTTP. Never trust forwarded
headers except from a configured reverse proxy.

## Data and API outline

Persist users, hashed sessions, encrypted service connections, account-scoped
preferences, requests and shared acquisition records with schema migrations.
Keep request ownership separate from the canonical album acquisition identity.
Do not store authenticated upstream stream URLs. Cache library/discovery data
with explicit server/account scope and bounded expiry.

API groups under `/api/v1`: setup and sessions, current user and connections,
administrator settings/users, library/search/album tracks, recommendations,
identity resolution, requests/status, and authorized streaming. Return stable
typed errors and pagination. Publish neither raw upstream responses nor secrets.

Resolve MusicBrainz release-group versus release IDs explicitly. Require user
confirmation for ambiguous editions before any Lidarr mutation. Persist request
intent before upstream writes and deduplicate concurrent requests using database
constraints and an explicit acquisition state machine. After timeouts or process
restarts, reconcile with Lidarr before repeating a write.

Track requested → acquiring → imported → available, plus failure/retry state.
Imported does not mean playable: availability requires Jellyfin indexing and
access for the current Jellyfin user. Preserve that user's library permissions
in browsing, search and streaming; do not use an administrator API key as a
shared playback identity. Verify Jellyfin user authentication, token revocation,
music-item mapping and original-stream behavior against the supported server
version during implementation.
Use bounded server polling with backoff that survives restarts; clients only
refresh server state. Avoid relying on background polling in iOS.

## Phases and completion gates

1. **Server, login and connections.** Add the server/web workspace alongside
   Swift, Docker deployment and database migrations. Implement bootstrap,
   login/logout, account management, role checks, encrypted connections and
   upstream connection checks. Deliver a responsive setup/login/settings UI.
   Gate: a second device signs in to the same account and sees connection status
   without retrieving secrets; unauthorized users cannot change installation
   settings or read another account's data. Test session expiry/revocation,
   CSRF, rate limits, failed upstream authentication and persistence on restart.
2. **Library and early native playback proof.** Implement paginated library and
   search endpoints, web album pages, the Swift Leerr adapter and native login.
   Prove original FLAC playback through the proxy before expanding discovery.
   Gate: known-fixture byte/range checks, seeking, cancellation, ticket expiry
   and reconnect tests; real Mac/iPhone playback and system-control validation.
   An orb can verify server/web behavior, not native audio or SwiftUI rendering.
3. **Shared requests.** Add album resolution/confirmation, request creation,
   request lists and the durable reconciliation worker. Gate: requests created
   on web appear in the native clients; simultaneous requests, ambiguous matches,
   timeout-after-write and restart recovery do not cause duplicate acquisition.
   Show failure/retry states and verify imported versus indexed availability.
4. **Discovery and Seerr-style polish.** Connect optional Last.fm signals and
   MusicBrainz catalogs, add recommendations and filter owned/requested albums.
   Gate: discover → confirm → request → available → native playback works across
   clients, including users with no Last.fm connection and unavailable services.
   Inspect responsive web layouts, keyboard use, loading/empty/error states,
   album details and request progress; validate both native apps on a Mac runner.
5. **Release hardening.** Verify backup/restore, upgrade migrations, administrator
   recovery, secret replacement, session revocation and redacted logs. Document
   HTTPS deployment and health checks that do not expose secrets. Backups need
   both the database and separately protected encryption key; a database backup
   alone cannot recover service credentials. Test restore before release.

Each phase includes automated tests for its contracts and rendered checks for
affected UI. Use fake upstreams in CI and explicit, authorized test accounts for
live integration tests. Never change production Lidarr data as a test default.

Implementation currently spans phases 1–4, but none should be read as fully
released solely from that fact. Phase 5 has offline backup/reset/rotation and
migration coverage, not production acceptance. All 27 server tests, active
anti-slop lint, and TypeScript/Vite builds pass. Docker build/non-root runtime
and restart persistence, encrypted backup restoration tests, and responsive web
rendered review pass. The Mac runner reported 107 Swift tests, both unsigned
builds passing, and reachable signed-out states inspected. Final UI runs each
had 1 pass and 1 automation failure, not a full native UI pass.
Authenticated native UI/races, production restore drills, live Jellyfin/Lidarr
behavior, and real-hardware playback remain gates. No live upstream credentials
or playback hardware were supplied. See [development.md](development.md).

## Existing Mac credentials and rollout

The legacy native credential implementation remains in this checkout. Current
app composition uses `LeerrAPI` and a separate Leerr-session Keychain namespace;
it intentionally does not inspect, migrate, upload, or delete legacy Jellyfin,
Navidrome, Lidarr, or Last.fm credentials.

Default migration is explicit re-entry in Leerr's server connection settings.
If a working native credential store exists, an optional user-approved one-time
transfer over HTTPS can avoid retyping. Never silently upload Keychain contents.
Installation credentials require administrator authorization; per-user services
attach only to the signed-in account. Confirm server connectivity and native
playback before offering to remove the old local service credentials. Rollback
must leave existing credentials intact until the user approves removal.

## Implemented defaults

- Separate Leerr account rather than using Jellyfin as the login authority.
- One installation-wide Jellyfin endpoint, with per-user upstream access tokens;
  no shared playback account by default.
- Administrator and member roles with immediate requests; approval queues later.
- One TypeScript/React server deployment with SQLite, and proxied native audio.
- Web discovery and requests first; browser playback is a later capability.
