# Architecture

```text
Browser ── HTTPS proxy ── Leerr (one Node process) ──┬── Plex Media Server (per-person server tokens)
                                │                     ├── plex.tv    (sign-in, per-person account tokens)
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
| `server/library.ts` | Cached per-user summary of the Plex library (release groups, album artists) |
| `server/keepalive.ts` | Uses each Plex sign-in on plex.tv once a day so idle ones do not expire |
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
  account lock. Plex sign-in happens on Plex's own page, so no Plex password
  ever reaches Leerr.
- **Rate limits** are per person once signed in (300 requests a minute, with
  separate, larger budgets for artwork and streams; password changes and
  starting Plex sign-ins 10 per 15 minutes) and per address otherwise (sign-in 10
  and setup 5 per 15 minutes), so a household behind one address does not share
  a budget. A 429's message states the limiter's real wait.
- **Revocation takes effect immediately.** Every authenticated response is
  re-checked before it is sent. Disabling a user, changing their password or
  signing out a device ends their sessions and aborts their live streams.
- **Secrets are encrypted at rest** with AES-256-GCM and a 16-byte tag. The
  associated data is `owner + NUL + service`, so a ciphertext cannot be moved to
  another user or service. The key lives in a separate file, not in SQLite, and
  a wrong key stops startup with a message saying so.
- **Credentials never follow a server change.** Saving the Plex address asks
  the server who it is (`/identity`, which must be a claimed server) and pins
  its machine identifier: tokens are only ever sent to that machine. Saving an
  address that answers as a different server deletes every Plex link (clearing
  the address keeps the pinned machine and the links); an
  address that later cannot prove it is that machine (another server, a
  proxy's error page, no answer) gets no tokens at all (`plex_wrong_server`,
  checked every ten minutes). A new Lidarr address
  requires its own key, and a new notification address never inherits the old
  token. Upstream redirects are never followed.
- **Plex sign-in.** Leerr's server creates a strong PIN on plex.tv with the
  person's own random client identifier (plex.tv only gives a PIN's token to
  the identifier that created it), keeps the PIN in memory bound to that Leerr
  session, and sends the browser to Plex's page with only an opaque id. Plex's
  consent page names the Leerr account ("Leerr (alice)"), and Leerr shows which
  Plex account approved. Leerr keeps two encrypted tokens per person: the
  plex.tv account token (to fetch a current server token and keep the sign-in
  alive; for a full account it is that person's whole Plex sign-in) and the
  token plex.tv issues for this server. A shared user's or
  managed profile's account token is never sent to the server; for the
  server's owner, plex.tv issues the account token itself as the server token,
  which is why the identity check above fails closed. One Plex account or
  profile can belong to only one Leerr user. When the server rejects a token, Leerr asks plex.tv once
  for a current one before saying so (`plex_reconnect`), without signing the
  person out of Leerr. Disconnecting signs the token out on plex.tv.
- **Managed Home profiles** are linked only by an administrator who is a full
  member of the Plex Home, from Settings → Users on their own device: whoever
  sees the Home's profile list picks from it, so it must not be the person the
  profile is for. They pick one of the Home's managed profiles (with its PIN,
  if it has one), and Leerr keeps only that profile's token. Only managed
  profiles can be picked; the member's own token is never stored. An
  administrator can unlink anyone's Plex link (a profile given to the wrong
  person).
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

- The **Plex server address** (and, optionally, which music library to use)
  is set by an administrator. Each **user** links their own Plex account, so
  library, artwork, favourites, playlists and playback always follow that
  account's Plex permissions. A favourite is Plex's five-star rating, the same
  one Plexamp and Plex Web show; removing a favourite only clears a five-star
  rating, never another one.
- **Lidarr** belongs to the installation. An album has one **acquisition**,
  keyed by its MusicBrainz release group. Each user's **request** points to it,
  so two people requesting the same album share a single download. Withdrawing a
  request removes only that person's; the acquisition goes when nobody wants it.
- **Last.fm**: each person may connect a username with their own API key, or
  with only a username when an administrator set an installation-wide key.
- **"Imported"** means Lidarr has a file for every track (any edition).
  **"In your library"** is worked out per user: their own Plex account can see
  an album of that release group. Plex names each matched album's MusicBrainz
  **release** (one edition), not its group, so Leerr looks releases up on
  MusicBrainz (100 per call) and remembers the answer for everyone in the
  `releaseGroups` table; editions seen in Discover and requested editions are
  known without asking. Albums Plex has not matched (`local://`) cannot be
  recognised; Requests says how many there are.

## Playback

The browser asks for a **stream ticket** for one track (`POST /stream-tickets`)
and plays the returned URL in an `<audio>` element. The ticket in the URL path is
the credential, because media elements cannot send headers. It admits new
requests for six hours and is bound to the session, user and track. Once a stream
has started, ticket expiry never cuts it off; revocation still does. If a stream
fails (for example a ticket expired during a long pause), the player gets a new
ticket and resumes at the same position; if that fails too, it asks the server
why and shows that reason.

The proxy re-checks the track against the user's Plex account, then streams
the original file (Plex's part path, never in download mode). It forwards
`Range` and `If-Range` and passes 200/206/416 responses through without
buffering. Formats browsers cannot play (ALAC, AIFF, WMA, APE and similar; FLAC, MP3,
AAC, Opus, Vorbis and WAV play as they are) are converted by Plex to a
progressive 320 kb/s MP3. A converted stream cannot be ranged, so the player
seeks by asking for a new conversion from that point (`?start=`), and the
conversion is stopped when its listener leaves. Each session may have four
streams open at once; a stream's slot is freed as soon as its response finishes.

The player (`web/src/playback.ts`) keeps the queue, shuffle and repeat. It fetches
the next track's ticket while the current one plays, reports start, progress
(every 10 seconds and on pause) and stop to Plex's timeline, as its own player
(one per browser), and saves the queue and position in the browser's local
storage per user (never tickets), so a reload resumes paused. When Plex ends a
playback (for example its owner stopped it), the player stops and says why.
Signing out reports the stop to Plex first, then clears the queue;
so does finding the browser signed out (an expired or revoked session) or a
sign-out in another tab. Which request outcomes a person has seen (the Requests
badge) is kept on the server, not in the browser.

## Acquisition state machine

Each acquisition has a user-visible **status** and an internal **phase**:

| Status | Meaning | User action |
|---|---|---|
| `requested` | Queued, waiting for Lidarr's root folder and profiles, or being added to Lidarr | wait |
| `acquiring` | Lidarr is searching, downloading or importing | wait |
| `imported` | Lidarr has every track | none; it appears once Plex scans |
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
  Plex link changes. At most 300 releases are looked up on MusicBrainz per walk,
  so a large first library is recognised over a few walks.
- The player saves up to 1,000 queued tracks around the current one.
- Last.fm access is read-only public data. Plex itself records plays, and
  forwards them to Last.fm when its owner linked Last.fm in Plex.
