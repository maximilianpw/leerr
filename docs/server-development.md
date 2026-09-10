# Server deployment and operator runbook

## Production shape

Run exactly one Leerr container/process. It serves the static web build, API,
stream proxy, and reconciliation worker against `/data/leerr.sqlite` (SQLite
WAL, migration `user_version=2`). Multiple replicas are unsupported.

Create and protect a distinct encryption key file:

```sh
umask 077
openssl rand -base64 32 > leerr-key
LEERR_ORIGIN=https://leerr.example \
LEERR_TRUST_PROXY=172.18.0.1/32 \
LEERR_KEY_FILE="$PWD/leerr-key" docker compose up -d --build
```

The file must decode to exactly 32 bytes. Compose mounts it read-only as
`/run/secrets/leerr_key`; never place it in `/data`, the image, source control,
logs, or the database. Persist the `leerr_data` volume. On first startup Leerr
atomically creates `/data/setup-token` mode 0600. Read it locally, complete setup
once, then continue protecting the file; setup is disabled once any user exists.
Docker build, UID 1000 startup and account persistence across restart were
verified in the implementation orb. Live upstream compatibility remains a
separate acceptance gate.

## Live versus fixture mode

`npm start` runs `server/main.ts`: a persistent SQLite store and real `Upstreams`.
Missing/denied/unavailable Jellyfin returns an error, never fixture albums.
`npm run preview` runs `server/preview.ts`: a seeded in-memory demo and fake
upstreams. It ignores production connection settings, resets on restart, exposes
`fixturePreview: true` in `/api/v1/setup`, and blocks service credential writes.
Never deploy preview as the user's server, and never enter real credentials into
it. The browser labels this mode explicitly before and after login.

Without Docker, build with `npm ci && npm run build` (Node 24 recommended;
native argon2/better-sqlite3 dependencies may require Python, make, and C++).
Run as a dedicated non-root service user from the source/build directory:

```sh
LEERR_ORIGIN=https://leerr.example \
LEERR_DATA=/var/lib/leerr \
LEERR_KEY_FILE=/run/secrets/leerr-key \
LEERR_TRUST_PROXY=127.0.0.1/32 \
HOST=127.0.0.1 PORT=3000 npm start
```

Use the actual proxy address, not the example blindly. `HOST` defaults to
`0.0.0.0` for container compatibility; set it to loopback for native systemd,
or publish the container port only on loopback. `/health` is a
non-secret local liveness check; API calls additionally require matching Host
and trusted forwarded HTTPS. Do not expose the HTTP backend directly.

The service user needs write access to its data directory and read access to the
separate key file. The Docker image uses UID/GID 1000; Nix/systemd may use another
dedicated UID provided permissions match. Migrations run at startup (currently
v2); back up the DB and matching key before upgrades. Stop the single worker
before offline recovery operations. Never regenerate a key for an existing DB.

After bootstrap, configure the installation Jellyfin HTTPS URL in Administration,
then enroll each user's own Jellyfin account in Connections. “Credentials saved”
means a token was stored after login, not an ongoing health check; actual library,
artwork and stream requests enforce that user's upstream access. Lidarr settings
are needed for acquisitions, not library browsing. Legacy Mac Keychain credentials
are neither read nor migrated automatically.

## HTTPS reverse proxy

Leerr must be externally reachable only through an HTTPS reverse proxy. Bind the
container port to loopback/private networking, preserve the original `Host`, and
forward the scheme. Set `LEERR_ORIGIN` to the exact public HTTPS origin with no
path. Set comma-separated `LEERR_TRUST_PROXY` only to the actual proxy IPs/CIDRs,
never a broad client network and never “trust all”; only those peers may supply
forwarded protocol/client values.

Leerr disables Fastify request/access logs. Configure the proxy to redact or
omit `/api/v1/streams/<ticket>` paths and all query-string authentication from
client and upstream logs. Do not log Authorization, cookies, setup tokens,
Jellyfin tokens, Lidarr keys, Last.fm keys, or response bodies. Ensure Range and
206/416 responses stream through without buffering and use realistic timeouts.

## Offline operator commands

Stop the server first. Commands open the same database/key and are not protected
against concurrent server writes. Run through the image with the normal data and
key mounts (examples below show the underlying npm interface):

```sh
# Password is read from stdin, never argv; this also enables the user and revokes that user's sessions.
npm run operator -- reset-password USER < password-file

# Destination is a file path. The encryption key is not included.
npm run operator -- backup /protected/leerr-2026-09-09.sqlite

# NEW_KEY_FILE contains a new base64 32-byte key. Re-encrypts secrets and revokes all sessions.
npm run operator -- rotate-key NEW_KEY_FILE
```

Current safeguards are deliberately limited: commands require the server to be
stopped by operator procedure, validate inputs/key by opening the store, avoid
passwords in argv, print generic failures, and transact password/key changes.
They do not stop a running server, lock out another process, create key backups,
or automatically update deployment secrets.

## Backup, restore, and key rotation

Back up the SQLite database with `operator backup` and copy its matching key to
a separate protected location. Label database/key generations together. A DB
without its exact key cannot recover encrypted settings; old backups continue
to need their old keys after rotation. Test restoration before release.

Restore while Leerr is stopped. Restore the database and its matching key
together, verify ownership/permissions, and start Leerr on a private/loopback
interface first. Before reopening external access, revoke all restored sessions
(for each account use an offline password reset, or rotate the key to revoke all
sessions), then validate setup state, migration version, login, and connections.
Do not combine a newer DB with an older key or replace a missing key with a new
one.

For rotation: stop Leerr, back up DB and current key, generate a new key file,
run `rotate-key`, update `LEERR_KEY_FILE`/the mounted secret, then restart
privately and test. Retain the old key for old backups. Rotation revokes all
sessions but does not prove live upstream credentials still work; check them
before external reopening.
