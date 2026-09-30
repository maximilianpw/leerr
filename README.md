# Leerr

Leerr is a self-hosted music app for a household or small group sharing one
Jellyfin library and one Lidarr:

- **Discover** albums through MusicBrainz search and Last.fm-based suggestions.
- **Request** a specific edition; Leerr hands it to Lidarr and follows it until
  it lands in your library, with clear failure states and retry.
- **Play** your Jellyfin library in the browser, streaming original files.

Each person signs in to Leerr and connects their own Jellyfin account, so they
only ever see what Jellyfin lets them see.

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
node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64"))' > leerr-key
chmod 600 leerr-key
LEERR_ORIGIN=https://music.example.com \
LEERR_TRUST_PROXY=172.18.0.1/32 \
LEERR_KEY_FILE="$PWD/leerr-key" docker compose up -d --build
```

Then put it behind an HTTPS reverse proxy, open the site, and create the first
administrator with the token from `/data/setup-token`. The
[deployment guide](docs/deployment.md) covers the proxy, first-run setup,
backups, key rotation and recovery. A Nix package is described in [nix.md](docs/nix.md).

## Documentation

- [Architecture](docs/architecture.md): how requests flow, security model, the acquisition state machine
- [Deployment and operations](docs/deployment.md)
- [Development](docs/development.md): checks, tests, project layout
- [Nix package](docs/nix.md)
- [API contract (OpenAPI 3.1)](docs/openapi.yaml)
