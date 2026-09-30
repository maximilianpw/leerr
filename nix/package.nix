{
  lib,
  buildNpmPackage,
  nodejs_24,
  makeWrapper,
}: let
  root = ../.;
  # Everything the build and its checks read; nothing else enters the store.
  inputs = ["package.json" "package-lock.json" "tsconfig.json" "oxlint.config.ts" "scripts" "docs" "tools" "server" "web"];
in
  buildNpmPackage {
    pname = "leerr";
    # Not a published release: the flake lock and source identify the build.
    version = "0-unstable";
    src = lib.cleanSourceWith {
      src = root;
      name = "leerr-source";
      filter = path: type: let
        relative = lib.removePrefix "${toString root}/" (toString path);
        components = lib.splitString "/" relative;
      in
        (toString path == toString root || lib.elem (lib.head components) inputs)
        && lib.all (part: !(lib.hasPrefix "." part) && !(lib.elem part ["node_modules" "dist" "result"])) components
        && type != "symlink"
        && lib.cleanSourceFilter path type;
    };
    nodejs = nodejs_24;
    npmDepsHash = "sha256-rs3UcSNewd4pHwBHekOoFZdpudT+J1eYpU2qF+S9R9c=";
    nativeBuildInputs = [makeWrapper];

    doCheck = true;
    checkPhase = ''
      runHook preCheck
      npm run lint
      npm test
      runHook postCheck
    '';

    installPhase = ''
      runHook preInstall
      npm prune --omit=dev --ignore-scripts
      # Some production dependencies ship tests and fixtures in their tarballs.
      find node_modules -type d \( -name test -o -name tests -o -name __tests__ -o -name spec -o -name fixtures \) -prune -exec rm -rf {} +
      mkdir -p "$out/lib/leerr" "$out/bin"
      node --input-type=module -e '
        import fs from "node:fs";
        const { name, private: privatePackage, type, engines, dependencies } = JSON.parse(fs.readFileSync("package.json", "utf8"));
        fs.writeFileSync(process.argv[1], JSON.stringify({ name, private: privatePackage, type, engines, dependencies }, null, 2) + "\n");
      ' "$out/lib/leerr/package.json"
      cp -r node_modules dist "$out/lib/leerr/"
      # Runtime modules only: tests, fakes, fixtures and the demo server stay out.
      cp -r server "$out/lib/leerr/server"
      rm -rf "$out/lib/leerr/server/test" "$out/lib/leerr/server/fixtures" \
        "$out/lib/leerr/server/testing.ts" "$out/lib/leerr/server/preview.ts"
      install -Dm644 web/src/fonts/LICENSE.txt "$out/share/licenses/leerr/Inter-OFL.txt"
      makeWrapper ${lib.getExe nodejs_24} "$out/bin/leerr" --add-flags "$out/lib/leerr/server/main.ts"
      makeWrapper ${lib.getExe nodejs_24} "$out/bin/leerr-operator" --add-flags "$out/lib/leerr/server/operator.ts"
      runHook postInstall
    '';

    meta = {
      description = "Self-hosted music discovery, requests and playback for Jellyfin and Lidarr";
      mainProgram = "leerr";
      platforms = ["x86_64-linux"];
    };
  }
