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
  };
}
