import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildApp } from "./app.ts";
import { makeStore } from "./test-fixtures.ts";

test("production web assets keep their MIME types and stale HTML validators never hide a new build", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "leerr-static-"));
  const webRoot = join(directory, "web");
  const store = makeStore();
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  execFileSync(process.execPath, [
    "node_modules/vite/bin/vite.js",
    "build",
    "--config",
    "web/vite.config.ts",
    "--outDir",
    webRoot,
  ]);
  const html = readFileSync(join(webRoot, "index.html"), "utf8");
  // Nix normalizes every output's timestamp; different builds with equal HTML
  // length had identical stat-based validators despite different chunk names.
  utimesSync(join(webRoot, "index.html"), 1, 1);
  const { app } = await buildApp({
    store,
    origin: "https://leerr.test",
    setupToken: "synthetic-setup",
    secure: false,
    webRoot,
  });
  t.after(() => app.close());
  const headers = { host: "leerr.test", accept: "text/html" };
  for (const condition of [
    { "if-none-match": `W/"${Buffer.byteLength(html).toString(16)}-3e8"` },
    { "if-none-match": "*" },
    { "if-modified-since": "Thu, 01 Jan 1970 00:00:01 GMT" },
  ]) {
    for (const url of ["/", "/index.html", "/library"]) {
      const page = await app.inject({
        url,
        headers: { ...headers, ...condition },
      });
      assert.equal(page.statusCode, 200);
      assert.equal(page.body, html);
      assert.equal(page.headers["cache-control"], "no-store");
      assert.equal(page.headers.etag, undefined);
      assert.equal(page.headers["last-modified"], undefined);
    }
  }
  const paths = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map(
    (match) => match[1],
  );
  assert.ok(paths.some((path) => path.endsWith(".js")));
  assert.ok(paths.some((path) => path.endsWith(".css")));
  for (const path of paths) {
    const asset = await app.inject({ url: path, headers });
    assert.equal(asset.statusCode, 200);
    assert.match(
      String(asset.headers["content-type"]),
      path.endsWith(".js") ? /^(?:application|text)\/javascript/ : /^text\/css/,
    );
    assert.deepEqual(asset.rawPayload, readFileSync(join(webRoot, path)));
    assert.doesNotMatch(asset.body, /^<!doctype html>/i);
    if (path.endsWith(".css")) {
      for (const font of asset.body.matchAll(
        /url\((\/assets\/[^)]+\.woff2)\)/g,
      )) {
        const response = await app.inject({ url: font[1], headers });
        assert.equal(response.statusCode, 200);
        assert.match(String(response.headers["content-type"]), /^font\/woff2/);
      }
    }
  }
  for (const url of [
    "/assets/previous-build.js",
    "/assets/missing.css",
    "/missing.js",
    "/api/missing",
  ]) {
    const missing = await app.inject({ url, headers });
    assert.equal(missing.statusCode, 404);
    assert.doesNotMatch(String(missing.headers["content-type"]), /text\/html/);
  }
  const navigation = await app.inject({ url: "/library", headers });
  assert.equal(navigation.statusCode, 200);
  assert.equal(navigation.body, html);
  assert.equal(navigation.headers["cache-control"], "no-store");
  assert.equal(
    (
      await app.inject({
        url: "/library",
        headers: { ...headers, accept: "*/*" },
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (await app.inject({ method: "POST", url: "/library", headers })).statusCode,
    404,
  );
});
