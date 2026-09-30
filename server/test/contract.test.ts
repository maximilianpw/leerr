import SwaggerParser from "@apidevtools/swagger-parser";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

test("every API route is documented in OpenAPI, and every documented operation exists", async () => {
  const api = await SwaggerParser.validate("docs/openapi.yaml");
  const registered = new Set<string>();
  const sources = ["server/http/app.ts", ...readdirSync("server/http/routes").map((file) => `server/http/routes/${file}`)];
  for (const source of sources)
    for (const match of readFileSync(source, "utf8").matchAll(/app\.(get|post|put|patch|delete)\(\s*"([^"]+)"/g))
      if (match[2].startsWith("/api/") || match[2] === "/health")
        registered.add(`${match[1]} ${match[2].replace(/:([a-zA-Z]+)/g, "{$1}")}`);
  const documented = new Set<string>();
  for (const [path, item] of Object.entries(api.paths ?? {}))
    for (const method of ["get", "post", "put", "patch", "delete"])
      if (item && method in item) documented.add(`${method} ${path}`);
  assert.ok(registered.size >= 30, `route scan found only ${registered.size} routes`);
  assert.deepEqual([...registered].sort(), [...documented].sort());
});
