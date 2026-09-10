# Nix package and overlay

This flake packages the shared Fastify server and React web build, not the native
Swift apps. Only `x86_64-linux` is supported initially, matching Kim. It does not
promise Darwin support for the native npm modules, and it provides no NixOS
service module or automatic activation.

`nix/package.nix` adapts Kim's existing `buildNpmPackage` recipe: Node 24, the
same `npmDepsHash`, TypeScript/Vite build, all server tests, and Oxlint including
the deliberate anti-slop rejection probe. The source filter includes the server
tests/fixtures, vendored `tools/oxlint`, `scripts/check-anti-slop.mjs`, and OpenAPI
contract for checks. It excludes root native apps/builds, artifacts, Git metadata,
hidden files, dependency/build directories, and symlinks. Never put credentials
inside the included source directories; store state and keys outside the checkout.

The installed package contains only the seven production server modules, built
web assets, pruned production dependencies, and the full Inter OFL license. It
does not install the preview server or fixture/test modules. `leerr` starts
`server/main.ts` with real upstreams; there is no fixture fallback.

## Build locally before publishing

The backend source is currently uncommitted and is not assumed to exist on any
remote default branch. Publish the verified backend source, including this flake
and lock, at the actual verified Leerr Git URL before using it as a remote input.
Do not substitute an invented GitHub URL or a stale Swift-only branch.

From a complete, sanitized backend checkout:

```sh
# path: includes the local uncommitted files; .# in a Git checkout omits untracked files.
nix flake check "path:$PWD"
nix build "path:$PWD#leerr" -L
```

Nix imports the flake directory into its store before the package source filter
runs. Do not point `path:` at a working tree containing private `.env` files,
state, keys, or review artifacts. For uncommitted work, stage only the package
inputs and these Nix files in a separate clean directory first. The derivation's
filter is not a security boundary for that initial flake import. Published Git
inputs must likewise contain no committed secrets.

The default package is the same derivation: `nix build "path:$PWD"`.
The honest package version is `0-unstable`; the source and lock identify the
build, not a fabricated release or commit suffix.

The standalone lock starts with Kim's nixpkgs revision
`6713828a351efa628b025a1adf7f43cbf8597513` (`nixos-26.05`) and uses `nodejs_24`.
Updating the npm lockfile may require updating `npmDepsHash`; obtain the new
fixed-output hash from an actual Nix build and rerun all checks. Do not remove
the hash or bypass checks. Constrained Linux Oxlint allocator prerequisites are
documented in [development.md](development.md); the build never changes host
sysctls automatically.

## Consume the overlay

For local evaluation, this consumer flake uses an absolute path placeholder:

```nix
{
  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-26.05";
    leerr.url = "path:/absolute/path/to/the/verified/leerr-backend";
    leerr.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs = { nixpkgs, leerr, ... }:
    let
      pkgs = import nixpkgs {
        system = "x86_64-linux";
        overlays = [ leerr.overlays.default ];
      };
    in {
      packages.x86_64-linux.leerr = pkgs.leerr;
      packages.x86_64-linux.default = pkgs.leerr;
    };
}
```

For a published source, replace only `leerr.url` with its verified Git flake URL
and desired ref; commit the consumer's resulting `flake.lock`. The overlay uses
the consumer's `final.callPackage`, so its nixpkgs supplies Node 24 and other
dependencies. `follows` avoids a second nixpkgs input, but does not guarantee a
different consumer pin builds successfully: verify the actual combination.
In an existing NixOS configuration, add `leerr.overlays.default` to
`nixpkgs.overlays` and reference `pkgs.leerr` in the existing service's `ExecStart`.
Do not replace the service's identity, state, credentials, networking, or proxy
configuration just to adopt the package.

Update the consumer's source pin explicitly with `nix flake update leerr`, review
the lock diff, then run `nix build .#leerr -L` and build the desired system
generation. Updating a pin or running `nix build` does **not** activate the
service. A separate authorized system activation/restart is required. Building
this flake never edits nix-config, changes the running service, or grants
production access.

## Runtime and offline operations

Both wrappers set their working directory to the installed package, so they find
`dist/web` and the TypeScript modules from any caller directory. Use absolute
paths for `LEERR_DATA`, `LEERR_KEY_FILE`, backups and key-rotation arguments:

```sh
export HOST=127.0.0.1 PORT=19008
export LEERR_ORIGIN=https://leerr.example
export LEERR_TRUST_PROXY=127.0.0.1/32
export LEERR_DATA=/var/lib/leerr
export LEERR_KEY_FILE=/run/secrets/leerr-key
./result/bin/leerr
```

These are examples, not instructions to change the current installation. Use a
dedicated non-root service identity, preserve the existing data/key pair, and
trust only the actual HTTPS proxy peer. The key must decode to 32 bytes; never
embed it in a Nix expression, source tree, derivation, or Nix store. `/health` is
a non-secret liveness check. Read the [server runbook](server-development.md)
for bootstrap, per-user Jellyfin enrollment, TLS and logging requirements.

With Leerr stopped, the same environment supports the installed operator:

```sh
./result/bin/leerr-operator backup /protected/leerr-backup.sqlite
./result/bin/leerr-operator reset-password USER < /protected/password-file
./result/bin/leerr-operator rotate-key /protected/new-key-file
```

The wrapper does not stop the server or add cross-process locking. Back up the
database and separately protect the matching encryption key before upgrades or
rotation. Migrations run at startup, not during the Nix build. Switching to an
older system/package generation does **not** roll back SQLite, credentials, or
the encryption key; older code may not read a newer schema. Restore a tested,
compatible DB/key pair while stopped when necessary. Key rotation revokes
sessions, and older backups still need their original keys. Never generate a new
key to replace a missing key for an existing database.
