import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { harness } from "./harness.ts";

test("the web build is served with an uncached shell, immutable assets and an SPA fallback", async (t) => {
  const webRoot = mkdtempSync(join(tmpdir(), "leerr-web-"));
  t.after(() => rmSync(webRoot, { recursive: true, force: true }));
  mkdirSync(join(webRoot, "assets"));
  writeFileSync(join(webRoot, "index.html"), "<!doctype html><title>Leerr</title>");
  writeFileSync(join(webRoot, "assets", "app-abc123.js"), "console.log(1)");
  writeFileSync(join(webRoot, "assets", "font.woff2"), "font");
  writeFileSync(join(webRoot, "manifest.webmanifest"), "{}");
  writeFileSync(join(webRoot, "favicon.svg"), "<svg/>");
  const h = await harness(t, { webRoot });
  const html = { accept: "text/html" };
  const shell = await h.call("GET", "/", null, undefined, html);
  assert.equal(shell.headers["content-type"], "text/html; charset=utf-8");
  assert.equal(shell.headers["cache-control"], "no-store");
  assert.equal(shell.headers.etag, undefined);
  assert.match(String(shell.headers["content-security-policy"]), /media-src 'self'/);
  const script = await h.call("GET", "/assets/app-abc123.js");
  assert.match(String(script.headers["content-type"]), /javascript/);
  assert.equal(script.headers["cache-control"], "public, max-age=31536000, immutable");
  assert.equal((await h.call("GET", "/assets/font.woff2")).headers["content-type"], "font/woff2");
  const deep = await h.call("GET", "/albums/abc", null, undefined, html);
  assert.equal(deep.body, "<!doctype html><title>Leerr</title>");
  assert.equal((await h.call("GET", "/assets/missing.js", null, undefined, html)).status, 404);
  assert.equal((await h.call("GET", "/api/v1/missing", null, undefined, html)).status, 404);
  assert.equal((await h.call("GET", "/albums/abc")).status, 404, "only navigations get the shell");
  // Install files are served as themselves, never as the app shell.
  const manifest = await h.call("GET", "/manifest.webmanifest", null, undefined, html);
  assert.equal(manifest.headers["content-type"], "application/manifest+json");
  assert.equal(manifest.body, "{}");
  assert.equal((await h.call("GET", "/favicon.svg", null, undefined, html)).headers["content-type"], "image/svg+xml");
});
