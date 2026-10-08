# Development

Requires Node.js 24+ (the server runs TypeScript directly with Node's type
stripping). Dependency versions are pinned in `package-lock.json`.

```sh
npm ci
npm run check        # lint, typecheck, tests, web build
```

Individual steps:

| Command | What it does |
|---|---|
| `npm run lint` | Oxlint with the vendored anti-slop rules, then a probe proving the plugin is active |
| `npm run typecheck` | `tsc` for the server (`tsconfig.json`), the web app (`web/tsconfig.json`) and its tests (`web/test/tsconfig.json`) |
| `npm test` | Every `server/**/*.test.ts` and `web/test/**/*.test.ts` with `node --test` |
| `npm run build` | Typecheck, then build the web app to `dist/web` |
| `npm run preview` | Build the web app and serve it with fake services on port 3000 |
| `npm run dev:web` | Vite with hot reload on port 5173, proxying `/api` to a running preview |

For UI work, run `npm run preview` in one terminal and `npm run dev:web` in
another (sign-in and writes work through the dev proxy; set
`LEERR_PREVIEW_ORIGIN` for both if the preview is not on `localhost:3000`). The
preview reads `dist/web/index.html` at start, so restart it after `npm run
build:web`. To show the preview on another device, set
`LEERR_PREVIEW_ORIGIN=http://<host>:3000 HOST=0.0.0.0`. Set
`LEERR_PREVIEW_SETUP=1` to start the preview empty, at the setup screen (token
`preview-setup-token`).

## Tests

Tests use in-memory SQLite and `FakeUpstreams` (`server/testing.ts`), and never
touch the network. The fake Lidarr behaves like the real one where it matters:
it ignores the edition flags posted with a new album and monitors the longest
edition once it has "loaded" it. `server/test/harness.ts` builds an app with a
controllable clock, helpers to create users and sign in, and `work()`, which
runs worker passes until nothing is due.

| File | Covers |
|---|---|
| `auth.test.ts` | Setup, host/origin/HTTPS checks, cookies, CSRF, bearer sessions, throttling and known devices, password changes, revocation, per-person rate limits, user administration |
| `api.test.ts` | Connections, library, favourites, playlists, playback reporting, requests and withdrawals, discovery, admin settings, notifications, status |
| `acquisitions.test.ts` | The Lidarr state machine: edition pinning, unknown-outcome mutations, grace periods, the download queue, deadlines, retries, concurrency, notifications |
| `streams.test.ts` | Range/416, ticket admission, revocation aborting live streams, stream limits and slot release, shutdown with open streams |
| `upstream.test.ts` | Wire contracts for Lidarr, MusicBrainz, Last.fm and notification targets against stub `fetch` |
| `plex.test.ts` | Wire contracts for the Plex Media Server and plex.tv (sign-in, server tokens, Home profiles) against stub `fetch` |
| `plex-races.test.ts` | Concurrent Plex sign-ins, link invalidation, administrator demotion and server/account changes during token renewal |
| `store.test.ts` | Encryption, schema migrations, compare-and-set updates, deployment settings, backups, the operator CLI (restore, running-server detection) |
| `static.test.ts` | Web asset caching, install files and the single-page-app fallback |
| `contract.test.ts` | Every API route matches `docs/openapi.yaml` in both directions, and every documented operation is called and its JSON response validated against its schema |
| `web/test/api.test.ts` | The web API client: session-scoped 401 handling, refresh on 403, proxy errors, CSRF headers |
| `web/test/playback.test.ts` | The player without a browser: tickets, recovery, queue editing, shuffle and repeat, persistence, reporting |

Adding an API route means documenting it in `docs/openapi.yaml` and calling it in
`contract.test.ts`; the contract tests fail otherwise.

## Schema changes

Add an entry to `MIGRATIONS` in `server/store.ts` (never edit the version-3
baseline). Each migration runs in its own transaction with foreign keys off, and
an existing database is copied to `leerr.sqlite.v<old>-<id>.bak` first. Add a
case to `store.test.ts` that upgrades a database of the previous version.

## Lint

Oxlint 1.82.0 and `@oxlint/plugins` 1.82.0 must stay at the same version. The
anti-slop rules (`tools/oxlint/`, vendored with provenance in its README)
enforce, among other things:

- external input is parsed with zod at its boundary (no `typeof` checks and no
  `unknown` parameters except ones named `cause`);
- no chained `.filter().map()`;
- every `as` cast carries a `// SAFETY:` comment.

The Oxlint JS plugin reserves several GiB of virtual memory per thread
([oxc#20331](https://github.com/oxc-project/oxc/issues/20331)). On a small,
swapless Linux VM with `vm.overcommit_memory=0` it can fail to start. Use a
machine with more headroom rather than changing host settings from scripts.

## Conventions

- All SQL lives in `server/store.ts`. Acquisition updates go through
  `updateAcquisition`, which is compare-and-set; the worker always passes the
  row's phase and `phaseAt` as it last wrote them.
- Upstream code throws `UpstreamError` with an `outcome`, which the worker uses
  to decide whether a failed change is safe to repeat.
- API errors are `APIError(status, code, message)`. Messages are shown to users
  verbatim, so write them for people.
- The web app reads URLs from `useLocation()`, loads data with `useResource`
  (abortable; stale responses are ignored) and writes with `useAction` (ignores
  double submits). A 401 from any request of the current session signs the user
  out; a 403 `forbidden` or `csrf` re-reads who is signed in. Response schemas
  use `zod/mini` to keep the bundle small. Playback logic lives in
  `web/src/playback.ts`, without React, so it can be tested with a fake audio
  element.
