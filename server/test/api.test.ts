import assert from "node:assert/strict";
import test from "node:test";
import { jellyfinSecret, lastfmSecret } from "../store.ts";
import { identities } from "../testing.ts";
import { UpstreamError } from "../upstream/index.ts";
import { harness } from "./harness.ts";

const requestBody = (identity: typeof identities.album) => ({
  releaseGroupMBID: identity.releaseGroupMBID,
  releaseMBID: identity.releaseMBID,
  artistMBID: identity.artistMBID,
});

test("connections are per user, validated upstream, encrypted at rest and removable", async (t) => {
  const h = await harness(t);
  const alice = await h.user("alice");
  const bob = await h.user("bob");
  const missing = await h.call("PUT", "/api/v1/connections/jellyfin", alice, { username: "admin", password: "jelly-password" });
  assert.equal(missing.json().error.code, "jellyfin_not_configured");
  h.configure();
  const wrong = await h.call("PUT", "/api/v1/connections/jellyfin", alice, { username: "admin", password: "nope" });
  assert.equal(wrong.json().error.code, "upstream_auth");
  assert.equal(
    (await h.call("PUT", "/api/v1/connections/jellyfin", alice, { username: "admin", password: "jelly-password" })).status,
    200,
  );
  assert.equal(
    (await h.call("PUT", "/api/v1/connections/lastfm", alice, { username: "alice-fm", apiKey: "bad" })).json().error.code,
    "upstream_auth",
  );
  assert.equal(
    (await h.call("PUT", "/api/v1/connections/lastfm", alice, { username: "alice-fm", apiKey: "lastfm-key" })).status,
    200,
  );
  assert.deepEqual((await h.call("GET", "/api/v1/connections", alice)).json(), {
    jellyfinConfigured: true,
    jellyfin: "admin",
    lastfm: "alice-fm",
    lidarrConfigured: true,
  });
  assert.equal((await h.call("GET", "/api/v1/connections", bob)).json().jellyfin, null);
  const raw = JSON.stringify(h.store.db.prepare("SELECT value FROM secrets").all());
  assert.equal(raw.includes("admin-jelly-token"), false);
  assert.equal(raw.includes("lastfm-key"), false);
  assert.equal((await h.call("DELETE", "/api/v1/connections/lastfm", alice)).status, 200);
  assert.equal(h.store.secret(alice.userID, "lastfm", lastfmSecret), null);
  assert.ok(h.store.secret(alice.userID, "jellyfin", jellyfinSecret));
});

test("library, albums and artwork are read with each user's own Jellyfin account", async (t) => {
  const h = await harness(t);
  h.configure();
  const admin = await h.user("root", "admin", "admin");
  const member = await h.user("mia", "member", "member");
  const stranger = await h.user("sam");
  const page = (await h.call("GET", "/api/v1/library?limit=1", admin)).json();
  assert.equal(page.total, 2);
  assert.equal(page.items.length, 1);
  assert.equal((await h.call("GET", "/api/v1/library?q=untag", admin)).json().items[0].id, "untagged");
  assert.equal((await h.call("GET", "/api/v1/library?limit=501", admin)).status, 400);
  assert.equal((await h.call("GET", "/api/v1/albums/available", member)).status, 404);
  assert.equal((await h.call("GET", "/api/v1/library", stranger)).json().error.code, "jellyfin_not_connected");
  const album = (await h.call("GET", "/api/v1/albums/available", admin)).json();
  assert.equal(album.tracks[0].codec, "flac");
  const artwork = await h.call("GET", "/api/v1/artwork/available", admin);
  assert.equal(artwork.headers["content-type"], "image/png");
  assert.equal(artwork.headers["cache-control"], "private, max-age=86400");
  assert.equal((await h.call("GET", "/api/v1/artwork/available")).status, 401);
});

test("requests deduplicate per album, are shared across users, and become available per user", async (t) => {
  const h = await harness(t);
  const admin = await h.user("root", "admin", "admin");
  const member = await h.user("mia", "member", "member");
  assert.equal(
    (await h.call("POST", "/api/v1/requests", member, requestBody(identities.other))).json().error.code,
    "lidarr_not_configured",
  );
  h.configure();
  // Already in this member's library.
  assert.equal(
    (await h.call("POST", "/api/v1/requests", member, requestBody(identities.other))).json().error.code,
    "already_available",
  );
  const first = (await h.call("POST", "/api/v1/requests", admin, requestBody(identities.other))).json();
  const again = (await h.call("POST", "/api/v1/requests", admin, requestBody(identities.other))).json();
  assert.equal(first.id, again.id);
  assert.equal(first.sharedEdition, false);
  await h.reconciler.settle();
  const mine = (await h.call("GET", "/api/v1/requests", admin)).json();
  assert.equal(mine.items.length, 1);
  assert.equal(mine.items[0].status, "acquiring");
  assert.equal(mine.libraryChecked, true);
  // The member sees none of the admin's requests.
  assert.equal((await h.call("GET", "/api/v1/requests", member)).json().items.length, 0);
  // Once the admin's Jellyfin can see the album, it is available to them.
  h.upstream.libraries.get("admin-jelly-token")?.push({
    id: "new-album",
    title: identities.other.title,
    artist: identities.other.artist,
    year: null,
    releaseGroupMBID: identities.other.releaseGroupMBID,
    releaseMBID: identities.other.releaseMBID,
  });
  h.context.library.invalidate();
  const now = (await h.call("GET", "/api/v1/requests", admin)).json().items[0];
  assert.equal(now.status, "available");
  assert.equal(now.albumID, "new-album");
  assert.equal(h.upstream.createCalls, 1);
});

test("an unconfirmed identity is refused before anything is stored", async (t) => {
  const h = await harness(t);
  h.configure();
  const admin = await h.user("root", "admin", "admin");
  const mismatched = { ...requestBody(identities.other), artistMBID: identities.album.artistMBID };
  assert.equal((await h.call("POST", "/api/v1/requests", admin, mismatched)).status, 422);
  assert.equal(h.store.acquisitions().length, 0);
});

test("a request for a different edition joins the album already being acquired", async (t) => {
  const h = await harness(t);
  h.configure();
  const admin = await h.user("root", "admin");
  const member = await h.user("mia");
  h.upstream.identity = async (group, release, artist) => ({ ...identities.other, releaseGroupMBID: group, releaseMBID: release, artistMBID: artist });
  await h.call("POST", "/api/v1/requests", admin, requestBody(identities.other));
  const other = "77777777-7777-4777-8777-777777777777";
  const joined = (await h.call("POST", "/api/v1/requests", member, { ...requestBody(identities.other), releaseMBID: other })).json();
  assert.equal(joined.sharedEdition, true);
  assert.equal(joined.edition, identities.other.releaseMBID);
  assert.equal(h.store.acquisitions()[0].requesters, 2);
});

test("users retry their own failed requests; administrators see and manage all of them", async (t) => {
  const h = await harness(t);
  h.configure();
  const admin = await h.user("root", "admin");
  const member = await h.user("mia");
  const { id } = (await h.call("POST", "/api/v1/requests", member, requestBody(identities.album))).json();
  await h.reconciler.settle();
  assert.equal((await h.call("POST", `/api/v1/requests/${id}/retry`, member)).json().error.code, "not_retryable");
  assert.equal((await h.call("POST", `/api/v1/requests/${id}/retry`, admin)).status, 404);
  h.upstream.commands[0].status = "failed";
  h.clock.advance(60_000);
  await h.reconciler.run();
  const failed = (await h.call("GET", "/api/v1/requests", member)).json().items[0];
  assert.equal(failed.status, "failed");
  assert.equal(failed.retryable, true);
  assert.equal((await h.call("POST", `/api/v1/requests/${id}/retry`, member)).status, 200);
  await h.reconciler.settle();
  assert.equal(h.upstream.searchCalls, 2);
  const all = (await h.call("GET", "/api/v1/admin/acquisitions", admin)).json().items;
  assert.equal(all.length, 1);
  assert.equal(all[0].requesters, 1);
  assert.equal((await h.call("GET", "/api/v1/admin/acquisitions", member)).status, 403);
  assert.equal((await h.call("DELETE", `/api/v1/admin/acquisitions/${all[0].id}`, admin)).status, 200);
  assert.equal((await h.call("GET", "/api/v1/requests", member)).json().items.length, 0);
});

test("changing the Jellyfin server forgets every user's token and ends streams", async (t) => {
  const h = await harness(t);
  h.configure();
  const admin = await h.user("root", "admin", "admin");
  const ticket = (await h.call("POST", "/api/v1/stream-tickets", admin, { trackID: "tone" })).json();
  assert.equal((await h.call("PUT", "/api/v1/admin/settings/jellyfin", admin, { url: "http://insecure.test" })).status, 400);
  assert.equal((await h.call("PUT", "/api/v1/admin/settings/jellyfin", admin, { url: "https://new.test/jf/" })).status, 200);
  assert.equal(h.store.settings().jellyfinURL, "https://new.test/jf");
  assert.equal(h.store.secret(admin.userID, "jellyfin", jellyfinSecret), null);
  assert.equal((await h.call("GET", ticket.url)).status, 401);
});

test("Lidarr settings need a key, never carry a key to a new host, and restart unfinished work there", async (t) => {
  const h = await harness(t);
  const admin = await h.user("root", "admin");
  const lidarr = (body: { url: string; apiKey?: string; rootFolderPath?: string }) =>
    h.call("PUT", "/api/v1/admin/settings/lidarr", admin, { qualityProfileID: 1, metadataProfileID: 1, ...body });
  assert.equal((await lidarr({ url: "https://lidarr.test" })).json().error.code, "lidarr_key_required");
  assert.equal((await lidarr({ url: "https://lidarr.test", apiKey: "k1", rootFolderPath: "/music" })).status, 200);
  // Same host: a blank key keeps the saved one.
  assert.equal((await lidarr({ url: "https://lidarr.test", rootFolderPath: "/music" })).status, 200);
  assert.equal(h.store.settings().lidarrKey, "k1");
  const settings = (await h.call("GET", "/api/v1/admin/settings", admin)).json();
  assert.equal(settings.lidarrConfigured, true);
  assert.equal(JSON.stringify(settings).includes("k1"), false);
  assert.equal((await lidarr({ url: "https://other.test" })).json().error.code, "lidarr_key_required");
  const member = await h.user("mia");
  await h.call("POST", "/api/v1/requests", member, requestBody(identities.album));
  await h.reconciler.settle();
  assert.equal(h.store.acquisitions()[0].phase, "searching");
  assert.equal((await lidarr({ url: "https://other.test", apiKey: "k2", rootFolderPath: "/music" })).status, 200);
  const moved = h.store.acquisitions()[0];
  assert.equal(moved.lidarrAlbumID === null || moved.phase !== "ready", true);
  assert.equal(h.store.settings().lidarrKey, "k2");
});

test("Lidarr cannot be switched while a mutation there is unconfirmed", async (t) => {
  const h = await harness(t);
  h.configure();
  const admin = await h.user("root", "admin");
  h.upstream.failCreate = new UpstreamError("upstream_unavailable", 503, "timeout");
  h.upstream.createApplies = false;
  await h.call("POST", "/api/v1/requests", admin, requestBody(identities.album));
  await h.reconciler.settle();
  const response = await h.call("PUT", "/api/v1/admin/settings/lidarr", admin, { url: "https://other.test", apiKey: "k" });
  assert.equal(response.json().error.code, "lidarr_busy");
});

test("discovery annotates results and recommendations fail closed on library errors", async (t) => {
  const h = await harness(t);
  h.configure();
  const admin = await h.user("root", "admin", "admin");
  const search = (await h.call("GET", "/api/v1/discover/search?q=anything", admin)).json();
  const byID = new Map(search.items.map((item: { id: string; status: string | null }) => [item.id, item.status]));
  assert.equal(byID.get(identities.album.releaseGroupMBID), "available");
  assert.equal(byID.get(identities.other.releaseGroupMBID), null);
  assert.equal(search.artists.length, 1);
  assert.equal((await h.call("GET", "/api/v1/discover/search?q=error", admin)).status, 503);
  const recommendations = (await h.call("GET", "/api/v1/discover/recommendations", admin)).json();
  assert.deepEqual(
    recommendations.items.map((item: { id: string }) => item.id),
    [identities.other.releaseGroupMBID],
  );
  assert.equal(recommendations.source, "musicbrainz");
  const editions = (await h.call("GET", `/api/v1/discover/release-groups/${identities.other.releaseGroupMBID}/editions`, admin)).json();
  assert.equal(editions.items[0].id, identities.other.releaseMBID);
  h.upstream.failLibrary = new UpstreamError("upstream_unavailable", 503, "Jellyfin returned HTTP 503.");
  h.context.library.invalidate();
  assert.equal((await h.call("GET", "/api/v1/discover/recommendations", admin)).json().error.code, "library_unavailable");
  // Search still works; it just cannot say what is already owned.
  const degraded = (await h.call("GET", "/api/v1/discover/search?q=anything", admin)).json();
  assert.equal(degraded.items[0].status, null);
  assert.equal((await h.call("GET", "/api/v1/requests", admin)).json().libraryChecked, false);
});
