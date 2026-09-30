# Deployment and operations

## What you need

- One host that runs Docker, or Node 24 (see [nix.md](nix.md) for the Nix package).
- An HTTPS reverse proxy in front of Leerr. Leerr refuses plain HTTP.
- Jellyfin reachable from Leerr over HTTPS. Lidarr, also over HTTPS, is needed
  for requests.
- A 32-byte encryption key in its own file, stored and backed up separately from
  the data.

## Configuration

| Variable | Required | Meaning |
|---|---|---|
| `LEERR_ORIGIN` | yes | Public address, e.g. `https://music.example.com` (HTTPS, no path). Requests with any other `Host` are refused. |
| `LEERR_KEY_FILE` | yes | Path to a file containing a base64-encoded 32-byte key |
| `LEERR_TRUST_PROXY` | behind a proxy | Comma-separated IPs/CIDRs of your reverse proxy **only**. Forwarded protocol and client address are trusted only from these. |
| `LEERR_DATA` | no | Data directory (default `./data`; `/data` in the image) |
| `HOST`, `PORT` | no | Listen address (default `0.0.0.0:3000`) |

Create the key once and never replace it for an existing database:

```sh
node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64"))' > leerr-key
chmod 600 leerr-key
```

## Docker

```sh
LEERR_ORIGIN=https://music.example.com \
LEERR_TRUST_PROXY=172.18.0.1/32 \
LEERR_KEY_FILE="$PWD/leerr-key" docker compose up -d --build
```

`compose.yaml` publishes the port on loopback only and mounts the key as a
read-only secret. It keeps data in the `leerr_data` volume and checks `/health`.
The container runs as UID 1000. Everything Leerr writes is private to that user
(directory 0700, files 0600). Stop it with `docker compose stop`: Leerr finishes
its current Lidarr call before exiting (up to 60 s).

Without Docker: `npm ci && npm run build`, then run `node server/main.ts` as a
dedicated unprivileged user with the variables above. Native modules (argon2,
better-sqlite3) may need Python, make and a C++ compiler if no prebuilt binary
fits.

## Reverse proxy

- Terminate TLS and forward to Leerr. Preserve the original `Host` header and
  send `X-Forwarded-Proto: https`.
- Set `LEERR_TRUST_PROXY` to the address the proxy connects from. Never trust a
  whole client network.
- Don't buffer responses and allow long-lived requests: audio streams pass
  straight through with Range support.
- **Keep `/api/v1/streams/…` paths out of access logs.** The path is a playback
  credential valid for up to six hours.

Caddy example:

```caddy
music.example.com {
  log {
    format filter {
      request>uri regexp ^/api/v1/streams/.* /api/v1/streams/[redacted]
    }
  }
  reverse_proxy 127.0.0.1:3000 {
    flush_interval -1
  }
}
```

## First run

1. Open the site. It asks for a **setup token**: read it from `setup-token` in
   the data directory (`docker compose exec leerr cat /data/setup-token`). The
   token is deleted once the first administrator exists.
2. **Settings → Server:** enter the Jellyfin address. Then enter the Lidarr
   address and API key, save, choose a root folder and the quality and metadata
   profiles, and save again.
3. **Settings → Connections:** each person connects their own Jellyfin account.
   Last.fm (username + API key) is optional and enables personal suggestions.
4. **Settings → Users:** add people. Share their temporary password privately.

## Day to day

- **Requests needing attention.** "Needs attention" means Leerr sent a change to
  Lidarr but couldn't confirm it (for example, Lidarr timed out). Look at the
  album in Lidarr, then use **Retry** or **Remove** under **Settings → All
  requests**. Leerr never automatically repeats a change whose outcome is
  unknown.
- **Failed requests** (search failed, or nothing found within a day) can be
  retried by the person who requested them or by an administrator.
- **Logs** are JSON lines on stdout, for example `login_failed`,
  `user_updated`, `acquisition_upstream_error` and `internal_error`. They contain
  no secrets.

## Offline maintenance

Stop Leerr first; these commands don't coordinate with a running server. Use the
same `LEERR_DATA` and `LEERR_KEY_FILE` as the server.

```sh
# Docker
docker compose run --rm leerr node server/operator.ts backup /data/backup-2026-09-30.sqlite
# Nix / source
leerr-operator reset-password alice < new-password-file
leerr-operator backup /protected/leerr-2026-09-30.sqlite
leerr-operator rotate-key /protected/new-key
```

- `reset-password USER` reads the password from stdin, re-enables the account
  and signs out all of its devices.
- `backup DEST` writes a consistent copy of the database. The key is **not**
  included: back it up separately and label each database with its key.
- `rotate-key NEW_KEY_FILE` re-encrypts all stored credentials under the new key
  and signs everyone out. Afterwards, point `LEERR_KEY_FILE` at the new key. Old
  backups still need the old key.

To **restore**, stop Leerr, put back the database together with its matching key,
start Leerr where only you can reach it, check that you can sign in, then open
access again.

## Upgrading from the pre-refresh Leerr

This release uses a new database schema (version 3) and does not migrate the
old one (versions 1–2). It refuses to start on an old database rather than touch
it. Move the old data directory aside, keeping it as a backup, and start with an
empty one: set up the administrator again, and have each person reconnect
Jellyfin. The encryption key can be reused or replaced.
