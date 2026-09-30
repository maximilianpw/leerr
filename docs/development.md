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
| `npm run typecheck` | `tsc` for the server (`tsconfig.json`) and the web app (`web/tsconfig.json`) |
| `npm test` | Every `server/**/*.test.ts` with `node --test` |
| `npm run build` | Typecheck, then build the web app to `dist/web` |
| `npm run preview` | Build the web app and serve it with fake services on port 3000 |
| `npm run dev:web` | Vite with hot reload on port 5173, proxying `/api` to a running preview |

For UI work, run `npm run preview` in one terminal and `npm run dev:web` in
another. To show the preview on another device, set
`LEERR_PREVIEW_ORIGIN=http://<host>:3000 HOST=0.0.0.0`. Set
`LEERR_PREVIEW_SETUP=1` to start the preview empty, at the setup screen (token
`preview-setup-token`).

## Tests

Tests use in-memory SQLite and `FakeUpstreams` (`server/testing.ts`), and never
touch the network. `server/test/harness.ts` builds an app with a controllable
clock and helpers to create users and sign in.

| File | Covers |
|---|---|
| `auth.test.ts` | Setup, host/origin/HTTPS checks, cookies, CSRF, bearer sessions, throttling, user administration |
| `api.test.ts` | Connections, library isolation, requests, discovery, admin settings |
| `acquisitions.test.ts` | The Lidarr state machine: unknown-outcome mutations, grace periods, deadlines, retries |
| `streams.test.ts` | Range/416, ticket admission, revocation aborting live streams, stream limits |
| `upstream.test.ts` | Wire contracts for Jellyfin, Lidarr, MusicBrainz and Last.fm against stub `fetch` |
| `store.test.ts` | Encryption, schema versioning, compare-and-set updates, the operator CLI |
| `static.test.ts` | Web asset caching and the single-page-app fallback |
| `contract.test.ts` | Every API route matches `docs/openapi.yaml`, in both directions |

Adding an API route means documenting it in `docs/openapi.yaml`; the contract
test fails otherwise.

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
  `updateAcquisition`, which is compare-and-set.
- Upstream code throws `UpstreamError` with an `outcome`, which the worker uses
  to decide whether a failed change is safe to repeat.
- API errors are `APIError(status, code, message)`. Messages are shown to users
  verbatim, so write them for people.
- The web app reads URLs from `useLocation()`, loads data with `useResource`
  (abortable; stale responses are ignored) and writes with `useAction` (ignores
  double submits). A 401 from any request signs the user out.
