import test from "node:test";
import assert from "node:assert/strict";
import SwaggerParser from "@apidevtools/swagger-parser";
import { readFileSync } from "node:fs";

test("OpenAPI is valid and every implemented route has a documented operation", async () => {
  const api = await SwaggerParser.validate("docs/openapi.yaml");
  const source = readFileSync("server/app.ts", "utf8");
  const routes = [...source.matchAll(/app\.(get|post|put|patch|delete)\(\s*["']([^"']+)["']/g)];
  assert.equal(routes.length, 28, 'The route scanner must cover all registered operations');
  for (const route of routes) {
    const path = route[2].replace(/:([a-zA-Z]+)/g, "{$1}");
    const operation = api.paths?.[path];
    assert.ok(operation, `Missing path ${path}`);
    assert.ok(
      Object.keys(operation).includes(route[1]),
      `Missing ${route[1]} ${path}`,
    );
  }
});
