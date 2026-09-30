# Nix package

The flake packages the server and the built web app for `x86_64-linux`. It
provides no NixOS module and never activates anything by itself.

`nix/package.nix` builds with Node 24. The build runs the full lint and test
suite, then installs:

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

After changing `package-lock.json`, update `npmDepsHash`:

```sh
nix run nixpkgs#prefetch-npm-deps -- package-lock.json
```

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
expression or the Nix store.

Updating the pin (`nix flake update leerr`) or building does not restart
anything; deploying the new generation does. Rolling back a system generation
does **not** roll back the database. In particular, this release refuses
databases from the pre-refresh schema (see
[deployment.md](deployment.md#upgrading-from-the-pre-refresh-leerr)).
