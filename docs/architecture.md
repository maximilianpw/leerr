# Architecture

```text
Browser ── HTTPS proxy ── Leerr (one Node process) ──┬── Jellyfin   (per-user tokens)
                                │                     ├── Lidarr     (installation key)
                                │                     ├── MusicBrainz
                                │                     ├── Last.fm    (per-user or installation API key)
                                │                     └── ntfy / Discord / webhook (optional, admin-configured)
                                └── SQLite (WAL) + separate 32-byte key file
```

Leerr runs as exactly one process. It serves the built web app, the API, the audio
proxy and the acquisition worker. There is no distributed locking, so
multiple replicas are not supported; the server holds SQLite's lock for its whole
lifetime, so a second server (or an offline maintenance command) refuses to start
beside it.

## Code layout

| Path | Responsibility |
|---|---|
| `server/main.ts` | Production entry point: config, database, HTTP server, worker timer, scheduled backups, shutdown |
| `server/config.ts` | Validates the environment (`LEERR_ORIGIN`, `LEERR_KEY_FILE`, `LEERR_BACKUP_*`, …) |
| `server/store.ts` | SQLite schema, migrations and every SQL statement; AES-GCM secrets |
| `server/acquisitions.ts` | `Reconciler`: the Lidarr state machine |
| `server/notifications.ts` | Turns acquisition outcomes into notifications |
| `server/backups.ts` | Scheduled online backups |
| `server/library.ts` | Cached per-user summary of the Jellyfin library (release groups, album artists) |
| `server/upstream/` | Bounded HTTP client and one module per service, behind the `Upstreams` interface |
| `server/http/app.ts` | Fastify setup, security hooks, rate limits, error mapping, static files |
| `server/http/auth.ts` | Sessions, CSRF, sign-in throttling |
| `server/http/routes/` | One module per API area |
| `server/operator.ts` | Offline maintenance CLI |
| `server/preview.ts`, `server/testing.ts` | Demo server and the shared fakes used by tests |
| `web/src/` | React app: `api.ts` (typed client), `router.tsx`, `playback.ts` (the player, without React), `player.tsx`, `pages/` |

Node runs the TypeScript sources directly (type stripping), so the server has no
build step. The code is restricted to erasable TypeScript syntax
(`erasableSyntaxOnly`).

## Security model

- **Passwords** are Argon2id (64 MiB, 3 iterations). Unknown usernames are
  verified against a dummy hash so timing does not reveal accounts. People change
  their own password with their current one; that ends their other sessions.
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
  account: 10 failures lock that username for 15 minutes after the tenth. A
  browser or native client that signed in to the account before carries a
  *known-device* token (stored as a digest, valid for a year) and has its own
  failure budget instead, so other people's guesses cannot lock the owner out.
  Browsers keep one such cookie per account, so everyone sharing a browser
  stays protected. An administrator's password reset or re-enable lifts the
  account lock. Connecting Jellyfin is throttled per Leerr user (5 wrong
  passwords per 15 minutes), so Leerr cannot be used to guess Jellyfin
  passwords.
- **Rate limits** are per person once signed in (300 requests a minute, with
  separate, larger budgets for artwork and streams; password changes and
  Jellyfin sign-ins 10 per 15 minutes) and per address otherwise (sign-in 10
  and setup 5 per 15 minutes), so a household behind one address does not share
  a budget. A 429's message states the limiter's real wait.
- **Revocation takes effect immediately.** Every authenticated response is
  re-checked before it is sent. Disabling a user, changing their password or
  signing out a device ends their sessions and aborts their live streams.
- **Secrets are encrypted at rest** with AES-256-GCM and a 16-byte tag. The
  associated data is `owner + NUL + service`, so a ciphertext cannot be moved to
  another user or service. The key lives in a separate file, not in SQLite, and
  a wrong key stops startup with a message saying so.
- **Credentials never follow a URL change.** A new Jellyfin server address
  deletes every stored Jellyfin token, a new Lidarr address requires its own
  key, and a new notification address never inherits the old token. Upstream
  redirects are never followed.
- **Jellyfin sign-ins are per person.** Leerr signs in to Jellyfin as a
  separate device for each Leerr user (a stable id derived from the user id), so
  two people sharing a Jellyfin account cannot revoke each other's tokens. When
  Jellyfin stops accepting a saved token, the API says so (`jellyfin_reconnect`)
  without signing the person out of Leerr.
- **Upstream responses are untrusted**: every one is schema-validated,
  size-capped (2 MB JSON, 5 MB artwork) and time-limited, including the body.
  Error messages describe the status but never echo response bodies or keys.
- **Audio responses cannot run as a page.** Streams only use an audio content
  type (otherwise `application/octet-stream`) and carry
  `Content-Security-Policy: sandbox`.
- **Logs** are JSON lines on stdout with security events (sign-ins, failures,
  setup, user and settings changes) and upstream failures (at most one line per
  route and failure per minute). They never contain tokens, passwords, keys or
  stream paths.

## Data ownership

- The **Jellyfin server URL** is set by an administrator. Each **user** stores
  their own Jellyfin token, so library, artwork, favourites, playlists and
  playback always follow that user's Jellyfin permissions.
- **Lidarr** belongs to the installation. An album has one **acquisition**,
  keyed by its MusicBrainz release group. Each user's **request** points to it,
  so two people requesting the same album share a single download. Withdrawing a
  request removes only that person's; the acquisition goes when nobody wants it.
- **Last.fm**: each person may connect a username with their own API key, or
  with only a username when an administrator set an installation-wide key.
- **"Imported"** means Lidarr has a file for every track (any edition).
  **"In your library"** is worked out per user: their own Jellyfin account can
  see that release group. That needs MusicBrainz release-group ids in Jellyfin's
  album metadata; Requests says when albums lack them.

## Playback

The browser asks for a **stream ticket** for one track (`POST /stream-tickets`)
and plays the returned URL in an `<audio>` element. The ticket in the URL path is
the credential, because media elements cannot send headers. It admits new
requests for six hours and is bound to the session, user and track. Once a stream
has started, ticket expiry never cuts it off; revocation still does. If a stream
fails (for example a ticket expired during a long pause), the player gets a new
ticket and resumes at the same position; if that fails too, it asks the server
why and shows that reason.

The proxy re-checks the track against the user's Jellyfin account, then streams
the original file (`static=true`, no transcoding). It forwards `Range` and
`If-Range` and passes 200/206/416 responses through without buffering. Each
session may have four streams open at once; a stream's slot is freed as soon as
its response finishes. Whether a file plays depends on the browser's codec
support: FLAC, MP3, AAC and Opus work in current browsers, while ALAC generally
only works in Safari.

The player (`web/src/playback.ts`) keeps the queue, shuffle and repeat. It fetches
the next track's ticket while the current one plays, reports start, progress
(every 30 seconds and on pause) and stop to Jellyfin, and saves the queue and
position in the browser's local storage per user (never tickets), so a reload
resumes paused. Signing out reports the stop to Jellyfin first, then clears it;
so does finding the browser signed out (an expired or revoked session) or a
sign-out in another tab. Which request outcomes a person has seen (the Requests
badge) is kept on the server, not in the browser.

## Acquisition state machine

Each acquisition has a user-visible **status** and an internal **phase**:

| Status | Meaning | User action |
|---|---|---|
| `requested` | Queued, waiting for Lidarr's root folder and profiles, or being added to Lidarr | wait |
| `acquiring` | Lidarr is searching, downloading or importing | wait |
| `imported` | Lidarr has every track | none; it appears once Jellyfin scans |
| `failed` | The search failed, nothing was grabbed within 24 h, the edition is missing from Lidarr's metadata, or the album was removed from Lidarr | **Retry** |
| `attention` | Leerr could not confirm a change it made in Lidarr, a download is stuck or has run for a week, or Leerr hit an internal error | check Lidarr, then **Retry** or remove |

The worker runs every 15 seconds, and immediately after a new request, retry or
settings change. It processes the 25 rows that are due soonest, one at a time,
re-reading each before acting. Each pass reads Lidarr first, and an album Lidarr
has fully imported (in any edition) is marked `imported` whatever its phase.
Otherwise:

```text
ready ──add──▶ pending_add ──confirmed──▶ ready ──pin edition──▶ pending_monitor ──▶ ready
  ready ──search──▶ pending_search ──command seen──▶ searching ──▶ finished
```

- Before each Lidarr change, the phase is set to `pending_*` (and the status to
  `requested`) with a compare-and-set, so concurrent writers (a retry, another
  pass) cannot interleave.
- A change **known not to have happened** (connection refused, DNS failure, or a
  4xx rejection) moves the phase back. It is tried again automatically, with
  exponential backoff capped at one hour.
- A change **with an unknown outcome** (timeout, 5xx) is **never sent
  automatically again**. Later passes check Lidarr for the result. If it cannot
  be confirmed within 15 minutes, including because Lidarr is unreachable, the
  acquisition becomes `attention`, and only an explicit retry sends it again.
- **Editions.** Lidarr ignores the edition flags sent with a new album and
  monitors its own pick (the longest edition) once it has loaded the album. For
  albums Leerr adds, it waits until Lidarr has finished loading the editions,
  then pins the requested one (monitored alone, other editions refused) before
  searching. Albums an operator already monitors are searched but never
  re-configured. An unmonitored existing album is monitored with only the
  requested edition. A new artist is added unmonitored, monitoring only this album.
- The search floor is the highest Lidarr command id seen just before searching,
  so older searches are never mistaken for this one. After that the search is
  followed by its command id, which survives a Lidarr restart. A command Lidarr
  no longer knows at all is treated as completed.
- After a completed search, Lidarr's download queue decides: a healthy download
  keeps the request `acquiring`, a stuck or blocked one makes it `attention`
  (it recovers by itself if the download does), and an empty queue after 24
  hours means nothing was found.
- Requesting an album Leerr considers imported re-checks Lidarr: if Lidarr still
  has it, nothing changes; otherwise it is added or searched again.
- Switching Lidarr installations restarts every unfinished acquisition on the new
  one. It is refused while any change on the current installation is
  unconfirmed. A pass that started on the old installation stops at the next row.
- On shutdown the worker finishes the Lidarr call in flight but starts no new one.
- Outcomes (`imported`, `failed`, `attention`) are sent to the notification
  target, once per change.

Administrators see every acquisition under **Settings → All requests** and can
retry, re-check or remove it there. Removing an acquisition only stops Leerr
tracking it; Lidarr is not changed.

## Limits

- Library pages hold at most 500 albums (60 by default). Lists of requests and
  acquisitions show the newest 500.
- MusicBrainz is limited to one request per 1.1 seconds, per its usage policy,
  measured on a monotonic clock. Search uses two calls, so a busy server queues
  requests; the queue gives up after 20 seconds. The edition picker reads up to
  300 editions (three calls); artist pages show 100 releases per page.
- Suggestions are cached per user for 30 minutes and new releases for 6 hours;
  a failure is remembered for a minute. The per-user library summary is cached
  for two minutes (a failed walk for 30 seconds) and cleared when that user's
  Jellyfin connection changes.
- The player saves up to 1,000 queued tracks around the current one.
- Last.fm access is read-only public data. Scrobbling happens through Jellyfin's
  own plugins, from the playback Leerr reports.
