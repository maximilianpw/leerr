# Architecture

```text
Browser ── HTTPS proxy ── Leerr (one Node process) ──┬── Jellyfin   (per-user tokens)
                                │                     ├── Lidarr     (installation key)
                                │                     ├── MusicBrainz
                                │                     └── Last.fm    (per-user API key)
                                └── SQLite (WAL) + separate 32-byte key file
```

Leerr runs as exactly one process. It serves the built web app, the API, the
audio proxy and the acquisition worker. There is no distributed locking, so
multiple replicas are not supported.

## Code layout

| Path | Responsibility |
|---|---|
| `server/main.ts` | Production entry point: config, database, HTTP server, worker timer, shutdown |
| `server/config.ts` | Validates the environment (`LEERR_ORIGIN`, `LEERR_KEY_FILE`, …) |
| `server/store.ts` | SQLite schema and every SQL statement; AES-GCM secrets |
| `server/acquisitions.ts` | `Reconciler`: the Lidarr state machine |
| `server/library.ts` | Cached per-user map of MusicBrainz release group → Jellyfin album |
| `server/upstream/` | Bounded HTTP client and one module per service, behind the `Upstreams` interface |
| `server/http/app.ts` | Fastify setup, security hooks, error mapping, static files |
| `server/http/auth.ts` | Sessions, CSRF, per-account login throttling |
| `server/http/routes/` | One module per API area |
| `server/operator.ts` | Offline maintenance CLI |
| `server/preview.ts`, `server/testing.ts` | Demo server and the shared fakes used by tests |
| `web/src/` | React app: `api.ts` (typed client), `router.tsx`, `player.tsx`, `pages/` |

Node runs the TypeScript sources directly (type stripping), so the server has no
build step. The code is restricted to erasable TypeScript syntax
(`erasableSyntaxOnly`).

## Security model

- **Passwords** are Argon2id (64 MiB, 3 iterations). Unknown usernames are
  verified against a dummy hash so timing does not reveal accounts.
- **Sessions** are random 256-bit tokens stored only as SHA-256 digests, valid
  for 30 days. Web sessions use an HttpOnly, SameSite=Strict cookie
  (`__Host-leerr` over HTTPS), and every write must also send the session's CSRF
  token. Native bearer sessions exist for API clients. Each kind of session only
  works through its own channel.
- **Requests are checked before routing runs**: the `Host` header must match
  `LEERR_ORIGIN`, the request must have arrived over HTTPS (as reported by a
  trusted proxy), and a cross-site `Origin` on a write is refused. Checks use
  Fastify's matched route pattern, never the raw URL, so percent-encoded paths
  cannot bypass them.
- **Sign-in is throttled** per client address (10 per 15 minutes) and per
  account (10 failures lock that username for 15 minutes).
- **Revocation takes effect immediately.** Every authenticated response is
  re-checked before it is sent. Disabling a user, changing their password or
  signing out a device ends their sessions and aborts their live streams.
- **Secrets are encrypted at rest** with AES-256-GCM and a 16-byte tag. The
  associated data is `owner + NUL + service`, so a ciphertext cannot be moved to
  another user or service. The key lives in a separate file, not in SQLite, and
  a wrong key stops startup.
- **Credentials never follow a URL change.** A new Jellyfin server address
  deletes every stored Jellyfin token, and a new Lidarr address requires its own
  key. Upstream redirects are never followed.
- **Upstream responses are untrusted**: every one is schema-validated,
  size-capped (2 MB JSON, 5 MB artwork) and time-limited. Error messages
  describe the status but never echo response bodies or keys.
- **Audio responses cannot run as a page.** Streams only use an audio content
  type (otherwise `application/octet-stream`) and carry
  `Content-Security-Policy: sandbox`.
- **Logs** are JSON lines on stdout with security events (sign-ins, failures,
  setup, user and settings changes). They never contain tokens, passwords, keys
  or stream paths.

## Data ownership

- The **Jellyfin server URL** is set by an administrator. Each **user** stores
  their own Jellyfin token, so library, artwork and playback always follow that
  user's Jellyfin permissions.
- **Lidarr** belongs to the installation. An album has one **acquisition**,
  keyed by its MusicBrainz release group. Each user's **request** points to it,
  so two people requesting the same album share a single download.
- **"Imported"** means Lidarr has a file for every track (any edition).
  **"In your library"** is worked out per user: their own Jellyfin account can
  see that release group.

## Playback

The browser asks for a **stream ticket** for one track (`POST /stream-tickets`)
and plays the returned URL in an `<audio>` element. The ticket in the URL path is
the credential, because media elements cannot send headers. It admits new
requests for six hours and is bound to the session, user and track. Once a stream
has started, ticket expiry never cuts it off; revocation still does. If a ticket
expires during a long pause, the player gets a new one and resumes at the same
position.

The proxy re-checks the track against the user's Jellyfin account, then streams
the original file (`static=true`, no transcoding). It forwards `Range` and
`If-Range` and passes 200/206/416 responses through without buffering. Each
session may have four streams open at once. Whether a file plays depends on the
browser's codec support: FLAC, MP3, AAC and Opus work in current browsers, while
ALAC generally only works in Safari.

## Acquisition state machine

Each acquisition has a user-visible **status** and an internal **phase**:

| Status | Meaning | User action |
|---|---|---|
| `requested` | Queued, or being added to Lidarr | wait |
| `acquiring` | Lidarr is searching, downloading or importing | wait |
| `imported` | Lidarr has every track | none; it appears once Jellyfin scans |
| `failed` | The search failed, nothing was found within 24 h, or the album was removed from Lidarr | **Retry** |
| `attention` | Leerr could not confirm a change it made in Lidarr, or hit an internal error | check Lidarr, then **Retry** or remove |

The worker runs every 15 seconds, and immediately after a new request or retry.
It processes the 25 rows that are due soonest, one at a time. Each pass reads
Lidarr first, and an album Lidarr has fully imported (in any edition) is marked
`imported` whatever its phase. Otherwise:

```text
ready ──add──▶ pending_add ──confirmed──▶ ready ──monitor──▶ pending_monitor ──▶ ready
  ready ──search──▶ pending_search ──command seen──▶ searching ──▶ finished
```

- Before each Lidarr change, the phase is set to `pending_*` with a
  compare-and-set, so concurrent writers (a user's retry, another pass) cannot
  interleave.
- A change **known not to have happened** (connection refused, DNS failure, or a
  4xx rejection) moves the phase back to `ready`. It is tried again
  automatically, with exponential backoff capped at one hour.
- A change **with an unknown outcome** (timeout, 5xx) is **never sent
  automatically again**. Later passes check Lidarr for the result. If it cannot
  be confirmed within 15 minutes, the acquisition becomes `attention`, and only
  an explicit retry sends it again.
- The search floor is the highest Lidarr command id seen just before searching,
  so older searches are never mistaken for this one.
- Lidarr removes old commands from its history. A missing command is treated as
  completed, and the 24-hour import deadline then applies.
- Albums an operator already monitors in Lidarr are searched but never
  re-configured. An unmonitored existing album is monitored with only the
  requested edition.
- Switching Lidarr installations restarts every unfinished acquisition on the new
  one. It is refused while any change on the current installation is unconfirmed.

Administrators see every acquisition under **Settings → All requests** and can
retry or remove it there. Removing an acquisition only stops Leerr tracking it;
Lidarr is not changed.

## Limits

- Library pages hold at most 500 albums (60 by default). Lists of requests and
  acquisitions show the newest 500.
- MusicBrainz is limited to one request per 1.1 seconds, per its usage policy.
  Search uses two calls, so a busy server queues requests; the queue gives up
  after 20 seconds.
- Recommendations are cached per user for 30 minutes. The per-user library map
  used for availability is cached for two minutes and cleared when that user's
  Jellyfin connection changes.
- Last.fm access is read-only public data. There is no OAuth and no scrobbling.
