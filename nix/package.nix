{
  lib,
  buildNpmPackage,
  nodejs_24,
  makeWrapper,
}: let
  root = ../.;
in
  buildNpmPackage {
    pname = "leerr";
    # The source is not a published release; the flake lock/source determines identity.
    version = "0-unstable";
    src = lib.cleanSourceWith {
      src = root;
      name = "leerr-source";
      filter = path: type: let
        relative = lib.removePrefix "${toString root}/" (toString path);
        components = lib.splitString "/" relative;
        buildInput =
          builtins.elem relative [
            "package.json"
            "package-lock.json"
            "tsconfig.json"
            "oxlint.config.ts"
            "scripts"
            "scripts/check-anti-slop.mjs"
            "docs"
            "docs/openapi.yaml"
            "tools"
          ]
          || lib.any (dir: relative == dir || lib.hasPrefix "${dir}/" relative) [
            "server"
            "web"
            "tools/oxlint"
          ];
      in
        (toString path == toString root || buildInput)
        && lib.all (part: !(lib.hasPrefix "." part) && !(builtins.elem part ["node_modules" "dist" "result"])) components
        && type != "symlink"
        && lib.cleanSourceFilter path type;
    };
    nodejs = nodejs_24;
    npmDepsHash = "sha256-mSv7DuN+Z47fkMxfXUmFBnme9Y7cJdMlJNLx6KfRneI=";
    nativeBuildInputs = [makeWrapper];

    doCheck = true;
    checkPhase = ''
      runHook preCheck
      npm test
      npm run lint
      runHook postCheck
    '';

    installPhase = ''
      runHook preInstall
      npm prune --omit=dev --ignore-scripts
      # Some production dependencies ship their own test fixtures in npm tarballs.
      find node_modules -type d \( -name test -o -name tests -o -name __tests__ -o -name spec -o -name fixtures \) -prune -exec rm -rf {} +
      mkdir -p "$out/lib/leerr/server" "$out/bin"
      node --input-type=module -e '
        import fs from "node:fs";
        const { name, private: privatePackage, type, engines, dependencies, scripts } = JSON.parse(fs.readFileSync("package.json", "utf8"));
        fs.writeFileSync(process.argv[1], JSON.stringify({ name, private: privatePackage, type, engines, dependencies, scripts: { start: scripts.start, operator: scripts.operator } }, null, 2) + "\n");
      ' "$out/lib/leerr/package.json"
      cp -r node_modules dist "$out/lib/leerr/"
      # Install only real runtime modules: preview, fixtures and tests stay out.
      cp server/{main,app,config,store,upstream,worker,operator}.ts "$out/lib/leerr/server/"
      install -Dm644 web/src/fonts/LICENSE.txt "$out/share/licenses/leerr/Inter-OFL.txt"
      makeWrapper ${lib.getExe nodejs_24} "$out/bin/leerr" \
        --chdir "$out/lib/leerr" \
        --add-flags "--import tsx server/main.ts"
      makeWrapper ${lib.getExe nodejs_24} "$out/bin/leerr-operator" \
        --chdir "$out/lib/leerr" \
        --add-flags "--import tsx server/operator.ts"
      runHook postInstall
    '';

    meta = {
      description = "Private music library and requests with per-user Jellyfin access";
      mainProgram = "leerr";
      platforms = ["x86_64-linux"];
    };
  }
