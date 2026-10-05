# Nix package

The flake packages the server and the built web app for `x86_64-linux`. It
provides no NixOS module and never activates anything by itself.

`nix/package.nix` builds with Node 24. The build runs the test suite, then
installs:

- `bin/leerr`: the server (`server/main.ts`);
- `bin/leerr-operator`: offline maintenance (see [deployment.md](deployment.md));
- the runtime server modules only. Tests, fakes, fixtures and the demo server
  are left out, as are pruned production dependencies' own test directories;
- the built web app and the Inter font licence.

The wrappers call Node with absolute paths, so they work from any directory.
Use absolute paths for `LEERR_DATA`, `LEERR_KEY_FILE` and operator arguments.

## Build

```sh
nix build "path:$PWD#leerr" -L
```

`path:` includes uncommitted files. Nix copies the whole flake directory into the
store before the package's source filter runs, so never build from a checkout
that contains keys, `.env` files or data directories. `.#leerr` in a Git
checkout only sees tracked files.

After changing `package-lock.json` (including its version), update `npmDepsHash`:

```sh
nix run nixpkgs#prefetch-npm-deps -- package-lock.json
```

CI's `nix-deps` job builds `.#leerr.npmDeps` on every pull request, so a
lockfile change (including Dependabot's) fails there until the hash follows.

`nix flake check "path:$PWD"` also runs Oxlint with the anti-slop rules
(`checks.x86_64-linux.lint`). Its plugin needs several GiB of memory (see
[development.md](development.md#lint)), which is why it is not part of every
package build.

## Use from another flake

The published source is `https://ampcode.com/@maxpw/leerr`. Pin a revision that
contains this flake; private access needs Git credentials available to the Nix
fetcher, never embedded in the URL.

```nix
{
  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-26.05";
    leerr.url = "git+https://ampcode.com/@maxpw/leerr?ref=main";
    leerr.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs = { nixpkgs, leerr, ... }:
    let
      pkgs = import nixpkgs {
        system = "x86_64-linux";
        overlays = [ leerr.overlays.default ];
      };
    in {
      packages.x86_64-linux.default = pkgs.leerr;
    };
}
```

In a NixOS configuration, add `leerr.overlays.default` to `nixpkgs.overlays` and
use `${pkgs.leerr}/bin/leerr` as the service's `ExecStart`, with the environment
from [deployment.md](deployment.md). Run it as a dedicated user with its own
state directory, and give it the key file via systemd credentials or a
root-owned file readable only by that user. Never put the key in a Nix
expression or the Nix store. For scheduled backups, set `LEERR_BACKUP_DIR` to a
directory the service can write (for example under its `StateDirectory`) and
copy it off the machine. Offline maintenance (`leerr-operator`) needs the service
stopped: the running server holds the database.

Updating the pin (`nix flake update leerr`) or building does not restart
anything; deploying the new generation does. Leerr upgrades its database
schema on start and keeps a copy of the old one; rolling back a system
generation does **not** roll back the database. Restore that copy with the new
generation's `leerr-operator` before switching back (see
[rolling back](deployment.md#rolling-back)). Pre-refresh databases (schema 1–2)
are refused.
