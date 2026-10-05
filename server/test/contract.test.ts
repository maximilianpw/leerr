import SwaggerParser from "@apidevtools/swagger-parser";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { z } from "zod";
import { identities, plexIDs } from "../testing.ts";
import type { JsonValue } from "../upstream/http.ts";
import { harness, PASSWORD, type Client } from "./harness.ts";

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
const methods = ["get", "post", "put", "patch", "delete"] as const;

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
    for (const method of methods) if (item && method in item) documented.add(`${method} ${path}`);
  assert.ok(registered.size >= 45, `route scan found only ${registered.size} routes`);
  assert.deepEqual([...registered].sort(), [...documented].sort());
});

// The dereferenced document, read as plain data: only the response schemas are used.
const responseDocument = z.object({
  paths: z.record(
    z.string(),
    z.record(
      z.string(),
      z
        .object({
          responses: z.record(
            z.string(),
            z.object({ content: z.record(z.string(), z.object({ schema: z.json() }).loose()).optional() }).loose(),
          ),
        })
        .loose(),
    ),
  ),
});

test("every documented JSON response body matches its schema, for real calls to every operation", async (t) => {
  const document = responseDocument.parse(await SwaggerParser.dereference("docs/openapi.yaml"));
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats.default(ajv);
  const h = await harness(t);
  h.configure();
  h.store.saveSettings({ ...h.store.settings(), lastfmKey: "lastfm-key", notifyURL: "https://ntfy.test/leerr" });
  const admin = await h.user("root", "admin", "admin");
  const member = await h.user("mia", "member", "member");
  const stranger = await h.user("sam");
  const exercised = new Set<string>();

  async function check(
    method: Method,
    docPath: string,
    url: string,
    client: Client | null,
    expected: number,
    body?: JsonValue,
    headers: Record<string, string> = {},
  ) {
    const response = await h.call(method, url, client, body, headers);
    assert.equal(response.status, expected, `${method} ${url}: ${response.body}`);
    const operation = document.paths[docPath]?.[method.toLowerCase()];
    assert.ok(operation, `${method} ${docPath} is not documented`);
    const documentedResponse = operation.responses[String(expected)];
    assert.ok(documentedResponse, `${method} ${docPath} does not document status ${expected}`);
    const schema = documentedResponse.content?.["application/json"]?.schema;
    if (schema !== undefined) {
      const validate = ajv.compile(z.object({}).loose().parse(schema));
      assert.ok(validate(response.json()), `${method} ${docPath} ${expected}: ${ajv.errorsText(validate.errors)}\n${response.body}`);
    }
    exercised.add(`${method.toLowerCase()} ${docPath}`);
    return response;
  }

  await check("GET", "/health", "/health", null, 200);
  await check("GET", "/api/v1/setup", "/api/v1/setup", null, 200);
  await check("POST", "/api/v1/setup", "/api/v1/setup", null, 409, { token: "x", username: "x", password: PASSWORD });
  await check("POST", "/api/v1/sessions", "/api/v1/sessions", null, 200, { username: "mia", password: PASSWORD });
  await check("POST", "/api/v1/sessions", "/api/v1/sessions", null, 200, { username: "mia", password: PASSWORD, device: "native", name: "Phone" });
  await check("POST", "/api/v1/sessions", "/api/v1/sessions", null, 401, { username: "mia", password: "wrong password" });
  await check("GET", "/api/v1/sessions", "/api/v1/sessions", member, 200);
  await check("GET", "/api/v1/me", "/api/v1/me", member, 200);
  await check("GET", "/api/v1/me", "/api/v1/me", null, 401);

  await check("GET", "/api/v1/admin/users", "/api/v1/admin/users", admin, 200);
  await check("GET", "/api/v1/admin/users", "/api/v1/admin/users", member, 403);
  const created = await check("POST", "/api/v1/admin/users", "/api/v1/admin/users", admin, 200, { username: "zoe", password: PASSWORD, role: "member" });
  await check("POST", "/api/v1/admin/users", "/api/v1/admin/users", admin, 409, { username: "zoe", password: PASSWORD, role: "member" });
  const zoe = z.object({ id: z.string() }).parse(created.json()).id;
  await check("PATCH", "/api/v1/admin/users/{id}", `/api/v1/admin/users/${zoe}`, admin, 200, { disabled: true });
  await check("GET", "/api/v1/admin/settings", "/api/v1/admin/settings", admin, 200);
  await check("PUT", "/api/v1/admin/settings/plex", "/api/v1/admin/settings/plex", admin, 200, { url: "https://plex.test" });
  await check("PUT", "/api/v1/admin/settings/plex/section", "/api/v1/admin/settings/plex/section", admin, 200, { key: null });
  await check("GET", "/api/v1/admin/plex/sections", "/api/v1/admin/plex/sections", admin, 200);
  const profileLink = await check("POST", "/api/v1/admin/users/{id}/plex/links", `/api/v1/admin/users/${zoe}/plex/links`, admin, 200, {});
  const profileLinkID = z.object({ id: z.string() }).parse(profileLink.json()).id;
  h.upstream.approvePin("admin-account");
  await check("GET", "/api/v1/connections/plex/links/{id}", `/api/v1/connections/plex/links/${profileLinkID}`, admin, 200);
  await check("POST", "/api/v1/connections/plex/links/{id}/profile", `/api/v1/connections/plex/links/${profileLinkID}/profile`, admin, 200, {
    uuid: "kid-uuid",
    pin: "1234",
  });
  await check("DELETE", "/api/v1/admin/users/{id}/plex", `/api/v1/admin/users/${zoe}/plex`, admin, 200);
  await check("PUT", "/api/v1/admin/settings/lidarr", "/api/v1/admin/settings/lidarr", admin, 200, { url: "https://lidarr.test" });
  await check("PUT", "/api/v1/admin/settings/lastfm", "/api/v1/admin/settings/lastfm", admin, 200, { apiKey: "lastfm-key" });
  await check("PUT", "/api/v1/admin/settings/notifications", "/api/v1/admin/settings/notifications", admin, 200, {
    url: "https://ntfy.test/leerr",
    format: "ntfy",
  });
  await check("POST", "/api/v1/admin/notifications/test", "/api/v1/admin/notifications/test", admin, 200);
  await check("GET", "/api/v1/admin/lidarr/options", "/api/v1/admin/lidarr/options", admin, 200);

  await check("GET", "/api/v1/connections", "/api/v1/connections", member, 200);
  const link = await check("POST", "/api/v1/connections/plex/links", "/api/v1/connections/plex/links", stranger, 200, {});
  const linkID = z.object({ id: z.string() }).parse(link.json()).id;
  await check("GET", "/api/v1/connections/plex/links/{id}", `/api/v1/connections/plex/links/${linkID}`, stranger, 200);
  await check("POST", "/api/v1/connections/plex/links/{id}/profile", `/api/v1/connections/plex/links/${linkID}/profile`, stranger, 409, { uuid: "kid-uuid" });
  await check("GET", "/api/v1/connections/plex/links/{id}", "/api/v1/connections/plex/links/not-an-id", stranger, 400);
  await check("PUT", "/api/v1/connections/lastfm", "/api/v1/connections/lastfm", member, 200, { username: "mia-fm" });
  await check("DELETE", "/api/v1/connections/{service}", "/api/v1/connections/lastfm", member, 200);

  await check("GET", "/api/v1/library", "/api/v1/library?sort=year", admin, 200);
  await check("GET", "/api/v1/library/artists", "/api/v1/library/artists", admin, 200);
  await check("GET", "/api/v1/albums/{id}", `/api/v1/albums/${plexIDs.album}`, admin, 200);
  await check("GET", "/api/v1/albums/{id}", `/api/v1/albums/${plexIDs.album}`, member, 404);
  await check("GET", "/api/v1/playlists", "/api/v1/playlists", admin, 200);
  await check("GET", "/api/v1/playlists/{id}", `/api/v1/playlists/${plexIDs.playlist}`, admin, 200);
  await check("POST", "/api/v1/playlists/{id}/tracks", `/api/v1/playlists/${plexIDs.playlist}/tracks`, admin, 200, { trackIDs: [plexIDs.track] });
  await check("PUT", "/api/v1/favorites/{id}", `/api/v1/favorites/${plexIDs.album}`, admin, 200);
  await check("DELETE", "/api/v1/favorites/{id}", `/api/v1/favorites/${plexIDs.album}`, admin, 200);
  await check("POST", "/api/v1/playback", "/api/v1/playback", admin, 200, { trackID: plexIDs.track, event: "start", position: 0 });
  await check("GET", "/api/v1/artwork/{id}", `/api/v1/artwork/${plexIDs.album}?size=large`, admin, 200);
  await check("GET", "/api/v1/artwork/{id}", `/api/v1/artwork/${plexIDs.untagged}`, admin, 404);
  const ticket = await check("POST", "/api/v1/stream-tickets", "/api/v1/stream-tickets", admin, 200, { trackID: plexIDs.track });
  const streamURL = z.object({ url: z.string() }).parse(ticket.json()).url;
  await check("GET", "/api/v1/streams/{ticket}", streamURL, null, 200);
  await check("GET", "/api/v1/streams/{ticket}", streamURL, null, 206, undefined, { range: "bytes=0-3" });

  await check("GET", "/api/v1/discover/search", "/api/v1/discover/search?q=signals", admin, 200);
  await check("GET", "/api/v1/discover/artists/{id}/albums", `/api/v1/discover/artists/${identities.album.artistMBID}/albums`, admin, 200);
  await check("GET", "/api/v1/discover/new-releases", "/api/v1/discover/new-releases", admin, 200);
  await check(
    "GET",
    "/api/v1/discover/release-groups/{id}/editions",
    `/api/v1/discover/release-groups/${identities.other.releaseGroupMBID}/editions`,
    admin,
    200,
  );
  await check("GET", "/api/v1/discover/recommendations", "/api/v1/discover/recommendations", admin, 200);

  const request = {
    releaseGroupMBID: identities.other.releaseGroupMBID,
    releaseMBID: identities.other.releaseMBID,
    artistMBID: identities.other.artistMBID,
  };
  const made = await check("POST", "/api/v1/requests", "/api/v1/requests", admin, 200, request);
  await check("POST", "/api/v1/requests", "/api/v1/requests", member, 409, request);
  await h.work();
  await check("GET", "/api/v1/requests", "/api/v1/requests", admin, 200);
  await check("GET", "/api/v1/requests", "/api/v1/requests", stranger, 200);
  const requestID = z.object({ id: z.string() }).parse(made.json()).id;
  await check("POST", "/api/v1/requests/seen", "/api/v1/requests/seen", admin, 200, { items: [{ id: requestID, status: "failed" }] });
  await check("POST", "/api/v1/requests/{id}/retry", `/api/v1/requests/${requestID}/retry`, admin, 409);
  await check("GET", "/api/v1/admin/acquisitions", "/api/v1/admin/acquisitions", admin, 200);
  await check("GET", "/api/v1/admin/status", "/api/v1/admin/status", admin, 200);
  const acquisitionID = h.store.acquisitions()[0].id;
  await check("POST", "/api/v1/admin/acquisitions/{id}/retry", `/api/v1/admin/acquisitions/${acquisitionID}/retry`, admin, 409);
  await check("DELETE", "/api/v1/requests/{id}", `/api/v1/requests/${requestID}`, admin, 200);
  await check("DELETE", "/api/v1/admin/acquisitions/{id}", `/api/v1/admin/acquisitions/${acquisitionID}`, admin, 404);

  await check("PUT", "/api/v1/me/password", "/api/v1/me/password", member, 403, { current: "nope", password: "a new password!" });
  await check("PUT", "/api/v1/me/password", "/api/v1/me/password", member, 200, { current: PASSWORD, password: "a new password!" });
  await check("DELETE", "/api/v1/sessions/{id}", "/api/v1/sessions/current", member, 200);

  const documented = new Set<string>();
  for (const [path, item] of Object.entries(document.paths))
    for (const method of methods) if (method in item) documented.add(`${method} ${path}`);
  assert.deepEqual([...documented].filter((operation) => !exercised.has(operation)), [], "every documented operation is exercised");
});
