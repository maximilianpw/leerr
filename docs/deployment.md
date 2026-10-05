# Deployment and operations

## What you need

- One host that runs Docker, or Node 24 (see [nix.md](nix.md) for the Nix package).
- An HTTPS reverse proxy in front of Leerr. Leerr refuses plain HTTP.
- A Plex Media Server (tested with 1.43) that is claimed (signed in to a Plex
  account), with a music library using the **Plex Music** agent, reachable from
  Leerr over HTTPS (see [Plex](#plex)). Leerr also needs to reach plex.tv, for
  people's sign-ins.
- Lidarr 2 or newer (tested with 3.1), also over HTTPS, for requests. Its
  certificate must be one Node trusts: public, or from a CA you add (see
  [Private CA](#private-ca-or-self-signed-upstreams)).
- A 32-byte encryption key in its own file, stored and backed up separately from
  the data, and outside any Git checkout.

## Configuration

| Variable | Required | Meaning |
|---|---|---|
| `LEERR_ORIGIN` | yes | Public address, e.g. `https://music.example.com` (HTTPS, no path). Requests with any other `Host` are refused. |
| `LEERR_KEY_FILE` | yes | Path to a file containing a base64-encoded 32-byte key |
| `LEERR_TRUST_PROXY` | behind a proxy | Comma-separated IPs/CIDRs of your reverse proxy **only**. Forwarded protocol and client address are trusted only from these. |
| `LEERR_DATA` | no | Data directory (default `./data`; `/data` in the image) |
| `LEERR_BACKUP_DIR` | no | Turns on scheduled backups into this directory |
| `LEERR_BACKUP_HOURS`, `LEERR_BACKUP_KEEP` | no | How often (default every 24 hours) and how many to keep (default 7) |
| `NODE_EXTRA_CA_CERTS` | no | A PEM file with extra CAs to trust for Lidarr (or a Plex behind your own proxy) |
| `HOST`, `PORT` | no | Listen address (default `0.0.0.0:3000`) |

Create the key once, outside any checkout, and never replace it for an existing
database. In Docker the key is read as UID 1000 (the image's user):

```sh
sudo install -d -m 700 /etc/leerr
node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64"))' | sudo tee /etc/leerr/key >/dev/null
sudo chown 1000:1000 /etc/leerr/key && sudo chmod 600 /etc/leerr/key
```

With rootless Docker or Podman, the engine runs as you and cannot read a
root-only `/etc/leerr`. Keep the key in a directory you own instead, and give
it to UID 1000 inside your user namespace:

```sh
install -d -m 700 ~/.config/leerr
node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64"))' > ~/.config/leerr/key
chmod 600 ~/.config/leerr/key
podman unshare chown 1000:1000 ~/.config/leerr/key
# rootless Docker: nsenter -U --preserve-credentials -t "$(cat "$XDG_RUNTIME_DIR/docker.pid")" chown 1000:1000 ~/.config/leerr/key
```

Then set `LEERR_KEY_FILE` in `.env` to that file's absolute path (Compose does
not expand `~`); the `/etc/leerr/key` default in `.env.example` is for rootful
Docker. For a non-Docker install, make the key readable only by the user Leerr
runs as.

## Docker

```sh
cp .env.example .env    # set LEERR_ORIGIN; check LEERR_TRUST_PROXY and LEERR_KEY_FILE
docker compose up -d --build
```

The variables live in `.env` (ignored by Git), so every later `docker compose`
command sees them. `compose.yaml` publishes the port on loopback only and mounts
the key as a read-only secret. It keeps data in the `leerr_data` volume, checks
`/health` (which also checks the database), and pins the container network to
`10.213.47.0/24`, so a proxy on the host always connects from `10.213.47.1`, the
`LEERR_TRUST_PROXY` in `.env.example`. If that subnet clashes with another
network, change it in `compose.yaml` and in `.env` together.

The container runs as UID 1000. Everything Leerr writes is private to that user
(directory 0700, files 0600). Stop it with `docker compose stop`: Leerr ends open
streams, finishes the Lidarr call in flight and exits within 50 seconds.

Optional additions (scheduled backups, a private CA) go in a
`compose.override.yaml`; copy `compose.override.example.yaml` and keep what you need.

Without Docker: `npm ci && npm run build`, then run `node server/main.ts` as a
dedicated unprivileged user with the variables above. Native modules (argon2,
better-sqlite3) may need Python, make and a C++ compiler if no prebuilt binary
fits.

## Reverse proxy

- Terminate TLS and forward to Leerr. Preserve the original `Host` header
  (it must equal `LEERR_ORIGIN`'s host and port exactly), send
  `X-Forwarded-Proto: https`, and send the client's address in
  `X-Forwarded-For`. Without it every client shares the proxy's address, and so
  its sign-in and request limits; Leerr logs `proxy_missing_forwarded_for` once
  when that happens.
- Set `LEERR_TRUST_PROXY` to the address the proxy connects from. Never trust a
  whole client network. If every page answers "Leerr requires HTTPS"
  (`https_required`) behind a working HTTPS proxy, this address is wrong.
- Don't buffer responses and allow long-lived requests: audio streams pass
  straight through with Range support.
- **Keep `/api/v1/streams/…` paths out of access logs.** The path is a playback
  credential valid for up to six hours.

Caddy (sets the forwarded headers itself):

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

nginx:

```nginx
map $request_uri $leerr_log_uri {
  ~^/api/v1/streams/ /api/v1/streams/[redacted];
  default $request_uri;
}
log_format leerr '$remote_addr [$time_local] "$request_method $leerr_log_uri" $status';

server {
  listen 443 ssl;
  server_name music.example.com;
  access_log /var/log/nginx/leerr.log leerr;
  location / {
    proxy_pass http://127.0.0.1:3000;
    # $http_host keeps a non-default port (e.g. :8443); $host would drop it.
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_buffering off;
    proxy_read_timeout 1h;
  }
}
```

HAProxy: `option forwardfor` and `http-request set-header X-Forwarded-Proto https`.

## First run

1. Open the site. It asks for a **setup token**: read it from `setup-token` in
   the data directory (`docker compose exec leerr cat /data/setup-token`). The
   token is deleted once the first administrator exists.
2. **Settings → Server:** enter the Plex server's HTTPS address (see
   [Plex](#plex)). Then enter the Lidarr address and API key, save, choose a
   root folder and the quality and metadata profiles, and save again. Requests
   made before the profiles are chosen wait, and start as soon as you save them.
3. Optionally, still under **Server**: a Last.fm API key for everyone (members
   then connect Last.fm with just a username, and people without Last.fm get
   suggestions from their own library), and a notification address.
4. **Settings → Connections:** each person signs in with their own Plex account.
   Once you have, **Server** also lets you choose the music library, if the
   server has more than one.
5. **Settings → Users:** add people. Share their temporary password privately;
   they can change it under **Settings → Account**. For anyone using a managed
   Plex Home profile, use **Link Plex profile** there (see Plex below).

Requesting EPs, live albums or compilations only works if Lidarr's metadata
profile allows those types.

## Plex

**The address.** Leerr only talks to services over HTTPS. Every claimed Plex
server already has a certificate for its own `plex.direct` names, of the form
`https://<IP address with dashes>.<certificate id>.plex.direct:32400`. The
certificate names its id; on the Plex machine:

```sh
openssl s_client -connect 127.0.0.1:32400 </dev/null 2>/dev/null | openssl x509 -noout -subject
# subject=CN=*.0123456789abcdef0123456789abcdef.plex.direct
```

When Leerr runs directly on the Plex machine (the Nix package or plain Node),
use the loopback name, `https://127-0-0-1.<certificate id>.plex.direct:32400`;
on another machine, the LAN address's name (e.g.
`https://192-168-1-10.<certificate id>.plex.direct:32400`). In **Docker**,
127.0.0.1 is the container itself: on the Plex machine use the compose
network's gateway, `https://10-213-47-1.<certificate id>.plex.direct:32400`
(change it with the subnet in `compose.yaml`), or the LAN name. Plex must listen
on that interface and the firewall must let the Docker bridge reach port 32400.

These names resolve through public DNS; to keep playback independent of it, pin
the name to its address. On NixOS, for the Nix package:
`networking.hosts."127.0.0.1" = [ "127-0-0-1.<certificate id>.plex.direct" ];`.
A container does not see the host's pins: use `extra_hosts` in
`compose.override.yaml` instead (see `compose.override.example.yaml`). A
reverse proxy with its own HTTPS name works too.

The address must be that name, with the exact id. `https://127.0.0.1:32400`,
`https://localhost:32400` or `https://<LAN IP>:32400` fail with
`ERR_TLS_CERT_ALTNAME_INVALID` ("its certificate is for a different name"):
Plex's certificate only covers `*.<certificate id>.plex.direct`, and no extra CA
can change that.

Saving checks the address: the server must be claimed, and Leerr remembers
which server answered. If the address later answers as a different server,
Leerr sends nobody's sign-in there (Settings → Status says so); saving an
address that answers as a different server, on purpose, removes every Plex
link. Clearing the address switches Plex off for everyone but keeps the links,
so saving the same server again brings everything back.

Do not add Leerr's address to Plex's "List of IP addresses and networks that
are allowed without auth" (Settings → Network): requests from there run as the
server's owner, so everyone would see the owner's library.

**Signing in.** Each person signs in with their own Plex account on Plex's page
(Settings → Connections → Sign in with Plex), and Plex sends them back. People
the server is shared with only see what is shared with them. A **managed Home
profile** (one without its own Plex account, often a child's) is linked by a
Leerr administrator who is a full member of the Plex Home, on their own device:
**Settings → Users → Link Plex profile** for that person, approve on Plex's
page, then pick the profile. Only there: whoever sees the Home's profile list
picks from it, and a profile without a Plex PIN needs nothing more. Giving each
managed profile a Plex PIN means a profile can only be linked by someone who
knows it.

Never sign in to Plex as a full member on someone else's device: Plex's sign-in
page keeps that browser signed in, and later offers your account with one tap,
without a password or a Home PIN. If it happened, sign out at
<https://app.plex.tv> on that device. Give the Home administrator a Plex PIN
too: without one, anyone signed in to any Home profile can switch to the
administrator in Plex's own apps. One Plex account or profile can be linked to
only one Leerr user; Settings → Users shows who plays as whom, and **Unlink
Plex** there frees a profile linked to the wrong person.

**Recognising arrived albums.** Plex's music agent names each album's
MusicBrainz *release*. Leerr looks up the release group (requests are by release
group) on MusicBrainz and remembers it, so a new library takes a few minutes to
be fully recognised. Albums Plex has not matched (Plex Web shows them as
unmatched) cannot be recognised: use **Fix Match** in Plex, and turn on
"Tag Audio Files with Metadata" in Lidarr (Settings → Metadata) so Plex finds
the right release. When a requested album has arrived but Plex has not matched
it to that album, the Requests page says so and links to it, so it can be
played and fixed.

**Scanning after Lidarr imports.** Leerr never asks Plex to scan. Either add
Lidarr's **Plex Media Server** connection (Lidarr → Settings → Connect, with
"Update Library", "On Release Import" and "On Upgrade"; map paths if Lidarr and
Plex see the music folder at different paths), or turn on Plex's "Scan my
library automatically" (Settings → Library). Lidarr's connection only fires for
downloaded albums, not for manual imports or rescans, so the automatic or
periodic scan is a useful backstop.

**Formats.** FLAC, MP3, AAC, Opus, Vorbis and WAV stream as they are. Plex
converts others (ALAC, AIFF, WMA, APE, …) to MP3 for the browser; that needs no Plex
Pass.

## Notifications

Under **Settings → Server → Notifications**, set an HTTPS address and its kind:

- **ntfy**: a topic URL such as `https://ntfy.sh/your-topic`, with an optional
  access token for a private server;
- **Discord**: a channel webhook URL;
- **JSON webhook**: Leerr POSTs `{source, event, title, message, album, requesters}`.

Leerr announces each request that arrives in Lidarr, fails, or needs an
administrator, once per change. Messages name the album, its artist and who
asked for it; they never contain ids, tokens or links. **Send a test** checks the
address. Failures are logged (`notification_failed`) and never hold up requests.

## Private CA or self-signed upstreams

Set `NODE_EXTRA_CA_CERTS` to a PEM file holding your root CA, or the self-signed
certificate itself (one file can hold several). Node reads it only at startup.

- Docker: in `compose.override.yaml`, set `NODE_EXTRA_CA_CERTS: /etc/leerr/ca.pem`
  and mount the file read-only (it must be readable by UID 1000).
- systemd: add `Environment=NODE_EXTRA_CA_CERTS=/etc/leerr/ca.pem`.

A certificate that still does not verify shows up as "Lidarr could not be
reached (UNABLE_TO_GET_ISSUER_CERT_LOCALLY): its certificate is not trusted…"
(or a similar code) when saving the Lidarr or Plex address, and on **Settings →
Status**. Plex's own `plex.direct` certificates are public and need nothing.
A name error (`ERR_TLS_CERT_ALTNAME_INVALID`, "its certificate is for a
different name") means the address does not match the certificate:
`NODE_EXTRA_CA_CERTS` cannot fix that, use the name the certificate was issued
for (for Plex, its `plex.direct` name).

## Day to day

- **Requests needing attention.** "Needs attention" means Leerr sent a change to
  Lidarr but couldn't confirm it (for example, Lidarr timed out or was down), or
  a download Lidarr grabbed is stuck. Look at the album in Lidarr (its Activity
  queue for downloads), then use **Retry** or **Remove** under **Settings → All
  requests**. Leerr never automatically repeats a change whose outcome is unknown.
- **Failed requests** (search failed, or nothing grabbed within a day) can be
  retried by the person who requested them or by an administrator.
- **Settings → Status** shows whether Plex and Lidarr answer, the worker's
  last pass and problem, request counts, open streams and the last backup.
- **Logs** are JSON lines on stdout, for example `login_failed`,
  `user_updated`, `upstream_error`, `acquisition_upstream_error`,
  `notification_failed`, `plex_token_rejected`, `plex_token_renewed`,
  `release_lookup_failed`, `backup_failed`, `startup_failed` and
  `internal_error`. They contain no secrets.

## Backups

Set `LEERR_BACKUP_DIR` (in Docker, through `compose.override.yaml` with a host
directory writable by UID 1000) and Leerr writes a consistent copy of the live
database every `LEERR_BACKUP_HOURS` (first one a minute after starting) as
`leerr-<time>.sqlite`, keeping the newest `LEERR_BACKUP_KEEP`. Copy that
directory off the machine. The key is **not** included: back it up separately
and label each database with its key.

The running server holds the database, so ad-hoc backups with the operator
command need Leerr stopped (below).

## Offline maintenance

Stop Leerr first: these commands refuse to run while it holds the database. Use
the same `LEERR_DATA` and `LEERR_KEY_FILE` as the server. They never change a
database's schema version (the server upgrades it when it starts).

```sh
# Nix
leerr-operator reset-password alice < new-password-file
leerr-operator backup /protected/leerr-2026-09-30.sqlite
leerr-operator restore /protected/leerr-2026-09-30.sqlite
leerr-operator rotate-key /protected/new-key
```

From a source checkout, run them in the checkout as the user Leerr runs as,
with absolute paths (`LEERR_DATA` defaults to `./data`):

```sh
node server/operator.ts reset-password alice < new-password-file
node server/operator.ts backup /protected/leerr-2026-09-30.sqlite
node server/operator.ts restore /protected/leerr-2026-09-30.sqlite
node server/operator.ts rotate-key /protected/new-key
```

- `reset-password USER` reads the password from stdin, re-enables the account
  and signs out all of its devices.
- `backup DEST` writes a consistent copy of the database. The key is **not** included.
- `restore BACKUP` checks the backup against the current key, moves the current
  database (and its write-ahead log, which must never be replayed onto another
  database) aside as `leerr.sqlite.before-restore-<time>`, and puts the backup in
  place. Set `LEERR_KEY_FILE` to the key that belongs to the backup first. The
  backup is copied, never opened where it lies, so it can be on read-only media.
- `rotate-key NEW_KEY_FILE` re-encrypts all stored credentials under the new key
  and signs everyone out. Afterwards, point `LEERR_KEY_FILE` at the new key. Old
  backups still need the old key.

With Docker (the variables come from `.env`; `backups/` must be writable by UID 1000
for `backup`):

```sh
docker compose stop
mkdir -p backups && sudo chown 1000 backups
printf '%s\n' 'a new password' | docker compose run --rm -T leerr node server/operator.ts reset-password alice
docker compose run --rm -v "$PWD/backups:/backups" leerr node server/operator.ts backup /backups/leerr-$(date +%F).sqlite
docker compose run --rm -v "$PWD/backups:/backups:ro" leerr node server/operator.ts restore /backups/leerr-2026-09-30.sqlite
docker compose run --rm -v /etc/leerr/new-key:/run/new-key:ro leerr node server/operator.ts rotate-key /run/new-key
docker compose up -d --force-recreate
```

The key reaches the container as a Compose secret, fixed when the container is
created. Whenever `LEERR_KEY_FILE` changes (after `rotate-key`, or to restore a
backup made with another key), edit `.env` first; every later `docker compose
run` and the restart then use the new key. Restart with `docker compose up -d
--force-recreate`: `docker compose start`, and even a plain `up -d`, keep the
old key mounted, and Leerr then stops with "The encryption key does not match
this database".

## Upgrading

Leerr upgrades its database schema by itself on start and keeps a copy of the
database it started from next to it (`leerr.sqlite.v<old version>-<id>.bak`).
Release notes are in [CHANGELOG.md](../CHANGELOG.md); read them before
upgrading.

Upgrading to 0.3 moves Leerr from Jellyfin to Plex: enter the Plex address under
Settings → Server, and everyone signs in with Plex under Settings → Connections.
Saved Jellyfin sign-ins are deleted. Docker deployments also need
`LEERR_TRUST_PROXY=10.213.47.1` and a `.env` that points at the existing key
(see the changelog).

### Rolling back

Rolling the program back does not roll the database back: an older release
refuses a newer schema. Put the pre-upgrade copy back first. Anything written
since the upgrade is lost.

1. Stop Leerr.
2. Restore the copy with the **newer** release's operator, which 0.2 does not
   have: `leerr-operator restore /var/lib/leerr/leerr.sqlite.v3-<id>.bak` (on
   Nix, the operator from the new generation's store path, since after a
   rollback only the old one is on `PATH`; in Docker, the new image). Restore
   keeps the copy's schema version.
3. Switch the program back and start it with the same key.

By hand instead: with Leerr stopped, move `leerr.sqlite` and any
`leerr.sqlite-wal` and `leerr.sqlite-shm` aside together, copy the `.bak` to
`leerr.sqlite` (owned by the service user, mode 0600), then start the older
release.

### From the pre-refresh Leerr

Schema versions 1–2 are not migrated. Leerr refuses to start on them rather than
touch them. Move the old data directory aside, keeping it as a backup, and start
with an empty one: set up the administrator again, and have each person sign in
with Plex. The encryption key can be reused or replaced.
