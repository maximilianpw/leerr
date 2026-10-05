# Leerr

Leerr is a self-hosted music app for a household or small group sharing one
Plex Media Server and one Lidarr:

- **Discover** albums through MusicBrainz search, artist discographies, new
  releases from artists you own, and suggestions from Last.fm or your library.
- **Request** a specific edition; Leerr hands it to Lidarr, makes sure Lidarr
  keeps that edition, and follows it until it lands in your library, with clear
  failure states, retry and optional notifications (ntfy, Discord, webhooks).
- **Play** your Plex music in the browser, streaming original files (Plex
  converts the few formats browsers cannot play, such as ALAC), with a queue,
  shuffle and repeat, favourites (Plex's five stars, shared with Plexamp) and
  Plex playlists. Playback is reported to Plex, so "now playing", play counts
  and history keep working.

Each person signs in to Leerr and then with their own Plex account, on Plex's
own page, so they only ever see what Plex lets them see. Managed Plex Home
profiles are supported too.

One Node.js process serves the React web app, the `/api/v1` JSON API, the audio
stream proxy and a background worker that drives Lidarr, all backed by one
SQLite file.

## Quick start (demo data)

Node 24+ is required.

```sh
npm ci
npm run preview        # http://localhost:3000, sign in as preview / preview-password
```

The preview uses fake services and an in-memory database. It never touches real
services and refuses to store credentials.

## Deploying

Docker:

```sh
# The encryption key lives outside this checkout. The container reads it as UID 1000.
# (Rootless Docker or Podman: keep it in your home instead; see docs/deployment.md.)
sudo install -d -m 700 /etc/leerr
node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64"))' | sudo tee /etc/leerr/key >/dev/null
sudo chown 1000:1000 /etc/leerr/key && sudo chmod 600 /etc/leerr/key

cp .env.example .env   # set LEERR_ORIGIN; LEERR_TRUST_PROXY and LEERR_KEY_FILE fit a proxy on this host
docker compose up -d --build
```

Then put it behind an HTTPS reverse proxy, open the site, and create the first
administrator with the token from `docker compose exec leerr cat /data/setup-token`.
The [deployment guide](docs/deployment.md) covers the proxy, first-run setup,
notifications, backups, key rotation and recovery. A Nix package is described
in [nix.md](docs/nix.md).

## Documentation

- [Architecture](docs/architecture.md): how requests flow, security model, the acquisition state machine
- [Deployment and operations](docs/deployment.md)
- [Development](docs/development.md): checks, tests, project layout
- [Nix package](docs/nix.md)
- [API contract (OpenAPI 3.1)](docs/openapi.yaml)
- [Changelog](CHANGELOG.md) and [security policy](SECURITY.md)
