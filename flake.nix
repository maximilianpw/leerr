{
  description = "Leerr shared music server";

  inputs.nixpkgs.url = "github:nixos/nixpkgs/nixos-26.05";

  outputs = {
    self,
    nixpkgs,
  }: {
    overlays.default = final: _prev: {
      leerr = final.callPackage ./nix/package.nix {};
    };

    packages.x86_64-linux = let
      pkgs = import nixpkgs {
        system = "x86_64-linux";
        overlays = [self.overlays.default];
      };
    in {
      inherit (pkgs) leerr;
      default = pkgs.leerr;
    };

    # `nix flake check` also runs Oxlint with the anti-slop rules (needs memory headroom).
    checks.x86_64-linux = {
      inherit (self.packages.x86_64-linux) leerr;
      lint = self.packages.x86_64-linux.leerr.overrideAttrs (_: {
        pname = "leerr-lint";
        checkPhase = "runHook preCheck; npm run lint; runHook postCheck";
        installPhase = "touch $out";
      });
    };
  };
}
