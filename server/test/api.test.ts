import assert from "node:assert/strict";
import test from "node:test";
import { jellyfinSecret, lastfmSecret } from "../store.ts";
import { fixtureAlbum, identities } from "../testing.ts";
import { UpstreamError } from "../upstream/index.ts";
import { jellyfinDeviceID } from "../http/context.ts";
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
    jellyfinValid: true,
    lastfm: "alice-fm",
    lastfmKeyProvided: false,
    lidarrConfigured: true,
    lidarrReady: true,
  });
  assert.equal((await h.call("GET", "/api/v1/connections", bob)).json().jellyfin, null);
  const raw = JSON.stringify(h.store.db.prepare("SELECT value FROM secrets").all());
  assert.equal(raw.includes("admin-jelly-token"), false);
  assert.equal(raw.includes("lastfm-key"), false);
  assert.equal((await h.call("DELETE", "/api/v1/connections/lastfm", alice)).status, 200);
  assert.equal(h.store.secret(alice.userID, "lastfm", lastfmSecret), null);
  assert.ok(h.store.secret(alice.userID, "jellyfin", jellyfinSecret));
});

test("each Leerr user signs in to Jellyfin as their own device, so sharing an account revokes nobody", async (t) => {
  const h = await harness(t);
  h.configure();
  const alice = await h.user("alice");
  const bob = await h.user("bob");
  for (const client of [alice, bob])
    await h.call("PUT", "/api/v1/connections/jellyfin", client, { username: "admin", password: "jelly-password" });
  assert.deepEqual(h.upstream.loginDevices, [jellyfinDeviceID(alice.userID), jellyfinDeviceID(bob.userID)]);
  assert.notEqual(h.upstream.loginDevices[0], h.upstream.loginDevices[1]);
  assert.match(h.upstream.loginDevices[0], /^leerr-[0-9a-f]{32}$/);
  assert.equal(h.upstream.loginDevices[0].includes(alice.userID), false, "the device id does not reveal the user id");
});

test("the Jellyfin connect limit says how long its window really is", async (t) => {
  const h = await harness(t);
  h.configure();
  const alice = await h.user("alice");
  for (let index = 0; index < 10; index++)
    assert.equal((await h.call("PUT", "/api/v1/connections/jellyfin", alice, { username: "admin", password: "jelly-password" })).status, 200);
  const limited = await h.call("PUT", "/api/v1/connections/jellyfin", alice, { username: "admin", password: "jelly-password" });
  assert.equal(limited.status, 429);
  assert.equal(limited.json().error.message, "Too many requests. Try again in 15 minutes.");
});

test("members cannot use Leerr to guess Jellyfin passwords", async (t) => {
  const h = await harness(t);
  h.configure();
  const mallory = await h.user("mallory");
  const attempt = (username: string) =>
    h.call("PUT", "/api/v1/connections/jellyfin", mallory, { username, password: "guess" });
  for (let index = 0; index < 5; index++) assert.equal((await attempt(index % 2 ? "admin" : "member")).status, 502);
  const locked = await attempt("admin");
  assert.equal(locked.status, 429);
  assert.equal(locked.json().error.code, "login_locked");
  assert.ok(h.events.some((entry) => entry.event === "connection_failed" && entry.fields.user === mallory.userID));
  // An unreachable Jellyfin is not a guess.
  const h2 = await harness(t);
  h2.configure();
  const member = await h2.user("member");
  h2.upstream.jellyfinLogin = async () => {
    throw new UpstreamError("upstream_unavailable", 503, "Jellyfin could not be reached (ECONNREFUSED).", "not_applied");
  };
  for (let index = 0; index < 6; index++)
    assert.equal((await h2.call("PUT", "/api/v1/connections/jellyfin", member, { username: "x", password: "y" })).status, 503);
});

test("a revoked Jellyfin sign-in says to reconnect, without signing the person out of Leerr", async (t) => {
  const h = await harness(t);
  h.configure();
  const admin = await h.user("root", "admin", "admin");
  h.upstream.revokedTokens.add("admin-jelly-token");
  const library = await h.call("GET", "/api/v1/library", admin);
  assert.equal(library.status, 409);
  assert.equal(library.json().error.code, "jellyfin_reconnect");
  assert.equal((await h.call("GET", "/api/v1/connections", admin)).json().jellyfinValid, false);
  assert.equal((await h.call("GET", "/api/v1/me", admin)).status, 200);
  // Requests still work: the library check is best effort.
  assert.equal((await h.call("POST", "/api/v1/requests", admin, requestBody(identities.other))).status, 200);
  assert.equal((await h.call("GET", "/api/v1/requests", admin)).json().libraryChecked, false);
});

test("Last.fm can use the installation's API key, so members only need a username", async (t) => {
  const h = await harness(t);
  h.configure();
  const admin = await h.user("root", "admin", "admin");
  const member = await h.user("mia", "member", "member");
  assert.equal(
    (await h.call("PUT", "/api/v1/connections/lastfm", member, { username: "mia-fm" })).json().error.code,
    "lastfm_key_required",
  );
  assert.equal((await h.call("PUT", "/api/v1/admin/settings/lastfm", admin, { apiKey: "bad" })).status, 502);
  assert.equal((await h.call("PUT", "/api/v1/admin/settings/lastfm", member, { apiKey: "lastfm-key" })).status, 403);
  assert.equal((await h.call("PUT", "/api/v1/admin/settings/lastfm", admin, { apiKey: "lastfm-key" })).status, 200);
  const settings = (await h.call("GET", "/api/v1/admin/settings", admin)).json();
  assert.equal(settings.lastfmConfigured, true);
  assert.equal(JSON.stringify(settings).includes("lastfm-key"), false, "the key is never returned");
  assert.equal((await h.call("GET", "/api/v1/connections", member)).json().lastfmKeyProvided, true);
  assert.equal((await h.call("PUT", "/api/v1/connections/lastfm", member, { username: "mia-fm" })).status, 200);
  const suggestions = (await h.call("GET", "/api/v1/discover/recommendations", member)).json();
  assert.equal(suggestions.source, "lastfm");
  const seed = h.upstream.seeds.at(-1);
  assert.ok(seed?.source === "lastfm");
  assert.deepEqual(seed.account, { username: "mia-fm", apiKey: "lastfm-key" });
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
  assert.equal(album.album.artistMBID, identities.album.artistMBID);
  const artwork = await h.call("GET", "/api/v1/artwork/available?size=small", admin);
  assert.equal(artwork.headers["content-type"], "image/png");
  assert.equal(artwork.headers["cache-control"], "private, max-age=86400");
  assert.equal(h.upstream.artworkSizes.at(-1), "small");
  assert.equal((await h.call("GET", "/api/v1/artwork/available?size=huge", admin)).status, 400);
  // Missing art is a cheap, cacheable 404 rather than an error every time.
  const none = await h.call("GET", "/api/v1/artwork/untagged", admin);
  assert.equal(none.status, 404);
  assert.equal(none.headers["cache-control"], "private, max-age=3600");
  assert.equal((await h.call("GET", "/api/v1/artwork/available")).status, 401);
});

test("the library can be sorted, filtered by artist or favourites, and browsed by artist", async (t) => {
  const h = await harness(t);
  h.configure();
  const admin = await h.user("root", "admin", "admin");
  await h.call("GET", "/api/v1/library?sort=added&artist=artist-quiet&favorites=1", admin);
  assert.deepEqual(h.upstream.libraryQueries.at(-1), {
    offset: 0,
    limit: 60,
    q: "",
    sort: "added",
    artistID: "artist-quiet",
    favorites: true,
  });
  assert.equal((await h.call("GET", "/api/v1/library?sort=random", admin)).status, 400);
  assert.equal((await h.call("GET", "/api/v1/library?artist=..%2Fx", admin)).status, 400);
  const artists = (await h.call("GET", "/api/v1/library/artists", admin)).json();
  assert.deepEqual(artists.items, [{ id: "artist-quiet", name: identities.album.artist, hasArtwork: false }]);
});

test("favourites and playlists go to the user's own Jellyfin account", async (t) => {
  const h = await harness(t);
  h.configure();
  const admin = await h.user("root", "admin", "admin");
  const member = await h.user("mia", "member", "member");
  assert.equal((await h.call("PUT", "/api/v1/favorites/available", admin)).status, 200);
  assert.equal((await h.call("GET", "/api/v1/library?favorites=1", admin)).json().items[0].id, "available");
  assert.equal((await h.call("PUT", "/api/v1/favorites/available", member)).status, 404, "only items the user can see");
  assert.equal((await h.call("DELETE", "/api/v1/favorites/available", admin)).status, 200);
  assert.equal(h.upstream.favorites.size, 0);
  const playlists = (await h.call("GET", "/api/v1/playlists", admin)).json();
  assert.equal(playlists.items[0].name, "Dinner");
  const dinner = (await h.call("GET", "/api/v1/playlists/dinner", admin)).json();
  assert.equal(dinner.tracks[0].albumID, "available");
  assert.equal((await h.call("POST", "/api/v1/playlists/dinner/tracks", admin, { trackIDs: ["tone"] })).status, 200);
  assert.deepEqual(h.upstream.playlistAdds, [{ playlistID: "dinner", trackIDs: ["tone"] }]);
  assert.equal((await h.call("POST", "/api/v1/playlists/dinner/tracks", admin, { trackIDs: [] })).status, 400);
  assert.equal((await h.call("GET", "/api/v1/playlists/dinner", member)).status, 404);
});

test("playback is reported to Jellyfin with the user's account", async (t) => {
  const h = await harness(t);
  h.configure();
  const admin = await h.user("root", "admin", "admin");
  for (const [event, position] of [
    ["start", 0],
    ["progress", 31.5],
    ["stop", 64],
  ] as const)
    assert.equal((await h.call("POST", "/api/v1/playback", admin, { trackID: "tone", event, position })).status, 200);
  assert.deepEqual(
    h.upstream.reports.map((report) => [report.event, report.position]),
    [
      ["start", 0],
      ["progress", 31.5],
      ["stop", 64],
    ],
  );
  assert.equal((await h.call("POST", "/api/v1/playback", admin, { trackID: "tone", event: "seek", position: 1 })).status, 400);
  const stranger = await h.user("sam");
  assert.equal((await h.call("POST", "/api/v1/playback", stranger, { trackID: "tone", event: "start", position: 0 })).status, 409);
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
  assert.deepEqual([first.alreadyRequested, first.sharedEdition], [false, false]);
  assert.deepEqual([again.alreadyRequested, again.sharedEdition], [true, false]);
  await h.work();
  const mine = (await h.call("GET", "/api/v1/requests", admin)).json();
  assert.equal(mine.items.length, 1);
  assert.equal(mine.items[0].status, "acquiring");
  assert.equal(mine.libraryChecked, true);
  assert.deepEqual(mine.library, { albums: 2, unmatched: 1 });
  // The member sees none of the admin's requests.
  assert.equal((await h.call("GET", "/api/v1/requests", member)).json().items.length, 0);
  // Once the admin's Jellyfin can see the album, it is available to them.
  h.upstream.libraries.get("admin-jelly-token")?.push(
    fixtureAlbum({
      id: "new-album",
      title: identities.other.title,
      artist: identities.other.artist,
      releaseGroupMBID: identities.other.releaseGroupMBID,
      releaseMBID: identities.other.releaseMBID,
    }),
  );
  h.context.library.invalidate();
  const now = (await h.call("GET", "/api/v1/requests", admin)).json().items[0];
  assert.equal(now.status, "available");
  assert.equal(now.albumID, "new-album");
  assert.equal(h.upstream.createCalls, 1);
});

test("a Jellyfin outage does not block new requests", async (t) => {
  const h = await harness(t);
  h.configure();
  const admin = await h.user("root", "admin", "admin");
  h.upstream.failLibrary = new UpstreamError("upstream_unavailable", 503, "Jellyfin returned HTTP 503.");
  assert.equal((await h.call("POST", "/api/v1/requests", admin, requestBody(identities.other))).status, 200);
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
  // Asking again for another edition of one's own request is not someone else's choice.
  const own = (await h.call("POST", "/api/v1/requests", admin, { ...requestBody(identities.other), releaseMBID: other })).json();
  assert.deepEqual([own.alreadyRequested, own.sharedEdition], [true, false]);
});

test("members withdraw their own requests; a shared album stays for the others", async (t) => {
  const h = await harness(t);
  h.configure();
  const admin = await h.user("root", "admin");
  const member = await h.user("mia");
  const mine = (await h.call("POST", "/api/v1/requests", member, requestBody(identities.album))).json();
  const theirs = (await h.call("POST", "/api/v1/requests", admin, requestBody(identities.album))).json();
  await h.work();
  assert.equal((await h.call("DELETE", `/api/v1/requests/${theirs.id}`, member)).status, 404);
  assert.equal((await h.call("DELETE", `/api/v1/requests/${mine.id}`, member)).status, 200);
  assert.equal((await h.call("GET", "/api/v1/requests", member)).json().items.length, 0);
  assert.equal(h.store.acquisitions()[0].requesters, 1);
  // The last requester's withdrawal stops tracking, unless a Lidarr change is unconfirmed.
  const row = h.store.acquisitions()[0];
  h.store.updateAcquisition(row.id, {}, { phase: "pending_search" }, h.clock.now());
  assert.equal((await h.call("DELETE", `/api/v1/requests/${theirs.id}`, admin)).json().error.code, "change_unconfirmed");
  h.store.updateAcquisition(row.id, {}, { phase: "searching" }, h.clock.now());
  assert.equal((await h.call("DELETE", `/api/v1/requests/${theirs.id}`, admin)).status, 200);
  assert.equal(h.store.acquisitions().length, 0);
});

test("users retry their own failed requests; administrators see and manage all of them", async (t) => {
  const h = await harness(t);
  h.configure();
  const admin = await h.user("root", "admin");
  const member = await h.user("mia");
  const { id } = (await h.call("POST", "/api/v1/requests", member, requestBody(identities.album))).json();
  await h.work();
  assert.equal((await h.call("POST", `/api/v1/requests/${id}/retry`, member)).json().error.code, "not_retryable");
  assert.equal((await h.call("POST", `/api/v1/requests/${id}/retry`, admin)).status, 404);
  h.upstream.commands[0].status = "failed";
  await h.work();
  const failed = (await h.call("GET", "/api/v1/requests", member)).json().items[0];
  assert.equal(failed.status, "failed");
  assert.equal(failed.retryable, true);
  assert.equal((await h.call("POST", `/api/v1/requests/${id}/retry`, member)).status, 200);
  await h.work();
  assert.equal(h.upstream.searchCalls, 2);
  const all = (await h.call("GET", "/api/v1/admin/acquisitions", admin)).json().items;
  assert.equal(all.length, 1);
  assert.equal(all[0].requesters, 1);
  assert.equal((await h.call("GET", "/api/v1/admin/acquisitions", member)).status, 403);
  // Administrators can retry too, through their own route.
  const latest = h.upstream.commands.at(-1);
  assert.ok(latest);
  latest.status = "failed";
  await h.work();
  assert.equal((await h.call("POST", `/api/v1/admin/acquisitions/${all[0].id}/retry`, admin)).status, 200);
  assert.equal((await h.call("POST", `/api/v1/admin/acquisitions/${all[0].id}/retry`, admin)).json().error.code, "not_retryable");
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
  assert.equal(settings.lidarrReady, true);
  assert.equal(JSON.stringify(settings).includes("k1"), false);
  assert.equal((await lidarr({ url: "https://other.test" })).json().error.code, "lidarr_key_required");
  const member = await h.user("mia");
  await h.call("POST", "/api/v1/requests", member, requestBody(identities.album));
  await h.work();
  assert.equal(h.store.acquisitions()[0].phase, "searching");
  assert.equal(h.upstream.createCalls, 1);
  // The new installation does not have the album yet: unfinished work starts over there.
  h.upstream.lidarr = null;
  assert.equal((await lidarr({ url: "https://other.test", apiKey: "k2", rootFolderPath: "/music" })).status, 200);
  await h.reconciler.settle();
  assert.equal(h.upstream.createCalls, 2);
  assert.equal(h.store.acquisitions()[0].phase, "pending_add");
  assert.equal(h.store.settings().lidarrKey, "k2");
});

test("saving only the Lidarr key keeps the chosen profiles, and completing the profiles wakes waiting requests", async (t) => {
  const h = await harness(t);
  const admin = await h.user("root", "admin");
  assert.equal((await h.call("PUT", "/api/v1/admin/settings/lidarr", admin, { url: "https://lidarr.test", apiKey: "k1" })).status, 200);
  assert.equal((await h.call("GET", "/api/v1/admin/settings", admin)).json().lidarrReady, false);
  const member = await h.user("mia");
  await h.call("POST", "/api/v1/requests", member, requestBody(identities.album));
  await h.work();
  let row = h.store.acquisitions()[0];
  assert.match(row.reason ?? "", /finish setting up Lidarr/);
  assert.equal(h.upstream.createCalls, 0);
  const complete = { url: "https://lidarr.test", rootFolderPath: "/music", qualityProfileID: 1, metadataProfileID: 1 };
  assert.equal((await h.call("PUT", "/api/v1/admin/settings/lidarr", admin, complete)).status, 200);
  await h.reconciler.settle();
  row = h.store.acquisitions()[0];
  assert.equal(row.phase, "pending_add", "the waiting request went ahead straight away");
  // A key-only save (e.g. after rotating Lidarr's key) must not wipe the profiles.
  assert.equal((await h.call("PUT", "/api/v1/admin/settings/lidarr", admin, { url: "https://lidarr.test", apiKey: "k2" })).status, 200);
  assert.deepEqual(
    [h.store.settings().rootFolderPath, h.store.settings().qualityProfileID, h.store.settings().metadataProfileID],
    ["/music", 1, 1],
  );
  // Choices this Lidarr does not offer (e.g. a page still showing another host's lists) are refused.
  for (const stale of [{ rootFolderPath: "/elsewhere" }, { qualityProfileID: 9 }, { metadataProfileID: 9 }]) {
    const refused = await h.call("PUT", "/api/v1/admin/settings/lidarr", admin, { ...complete, ...stale });
    assert.equal(refused.json().error.code, "lidarr_option_unknown");
  }
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
  assert.match(response.json().error.message, /Settings → All requests/);
  // A change journalled while the new Lidarr is being verified is caught inside the save.
  const h2 = await harness(t);
  h2.configure();
  const root = await h2.user("root", "admin");
  const { id } = (await h2.call("POST", "/api/v1/requests", root, requestBody(identities.album))).json();
  await h2.reconciler.settle();
  h2.upstream.lidarrOptions = async () => {
    const acquisition = h2.store.acquisitions()[0];
    h2.store.updateAcquisition(acquisition.id, {}, { phase: "pending_search" }, h2.clock.now());
    return { roots: [], qualities: [], metadata: [] };
  };
  const late = await h2.call("PUT", "/api/v1/admin/settings/lidarr", root, { url: "https://other.test", apiKey: "k" });
  assert.equal(late.json().error.code, "lidarr_busy");
  assert.equal(h2.store.settings().lidarrURL, "https://lidarr.test");
  assert.ok(id);
});

test("discovery annotates results with library album ids and suggestions fail closed on library errors", async (t) => {
  const h = await harness(t);
  h.configure();
  const admin = await h.user("root", "admin", "admin");
  const search = (await h.call("GET", "/api/v1/discover/search?q=anything", admin)).json();
  const found = (id: string) =>
    search.items.find((item: { id: string; status: string | null; albumID: string | null }) => item.id === id);
  assert.deepEqual(
    [found(identities.album.releaseGroupMBID).status, found(identities.album.releaseGroupMBID).albumID],
    ["available", "available"],
  );
  assert.equal(found(identities.other.releaseGroupMBID).status, null);
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
  assert.equal(editions.items[0].status, "Official");
  assert.equal(editions.total, 1);
  const artist = (await h.call("GET", `/api/v1/discover/artists/${identities.album.artistMBID}/albums?type=ep`, admin)).json();
  assert.equal(artist.items.length, 0);
  assert.equal((await h.call("GET", `/api/v1/discover/artists/${identities.album.artistMBID}/albums?type=bootleg`, admin)).status, 400);
  h.upstream.failLibrary = new UpstreamError("upstream_unavailable", 503, "Jellyfin returned HTTP 503.");
  h.context.library.invalidate();
  assert.equal((await h.call("GET", "/api/v1/discover/recommendations?refresh=1", admin)).json().error.code, "library_unavailable");
  // Search still works; it just cannot say what is already owned.
  const degraded = (await h.call("GET", "/api/v1/discover/search?q=anything", admin)).json();
  assert.equal(degraded.items[0].status, null);
  assert.equal((await h.call("GET", "/api/v1/requests", admin)).json().libraryChecked, false);
});

test("suggestions are seeded from the library when there is no Last.fm profile but an installation key", async (t) => {
  const h = await harness(t);
  h.configure();
  h.store.saveSettings({ ...h.store.settings(), lastfmKey: "lastfm-key" });
  const admin = await h.user("root", "admin", "admin");
  const suggestions = (await h.call("GET", "/api/v1/discover/recommendations", admin)).json();
  assert.equal(suggestions.source, "library");
  // Most-owned album artists first, ties by name.
  assert.deepEqual(h.upstream.seeds.at(-1), { source: "library", artists: ["Nobody", identities.album.artist], apiKey: "lastfm-key" });
  // Connecting Last.fm switches the source at once, not after the cache expires.
  await h.call("PUT", "/api/v1/connections/lastfm", admin, { username: "root-fm" });
  assert.equal((await h.call("GET", "/api/v1/discover/recommendations", admin)).json().source, "lastfm");
});

test("new releases come from the artists in the user's library", async (t) => {
  const h = await harness(t);
  h.configure();
  const member = await h.user("mia", "member", "member");
  const result = (await h.call("GET", "/api/v1/discover/new-releases", member)).json();
  assert.deepEqual(h.upstream.newReleaseQueries.at(-1)?.artists, [identities.other.artistMBID]);
  assert.equal(h.upstream.newReleaseQueries.at(-1)?.since, "2026-06-02");
  // Albums the member already has are left out.
  assert.deepEqual(result.items, []);
  const stranger = await h.user("sam");
  assert.deepEqual((await h.call("GET", "/api/v1/discover/new-releases", stranger)).json(), { items: [] });
});

test("notifications go to the administrator's target on outcomes, and can be tested", async (t) => {
  const h = await harness(t);
  h.configure();
  const admin = await h.user("root", "admin");
  const member = await h.user("mia");
  assert.equal(
    (await h.call("POST", "/api/v1/admin/notifications/test", admin)).json().error.code,
    "notifications_not_configured",
  );
  assert.equal(
    (await h.call("PUT", "/api/v1/admin/settings/notifications", admin, { url: "http://ntfy.test/x", format: "ntfy" })).status,
    400,
  );
  assert.equal(
    (await h.call("PUT", "/api/v1/admin/settings/notifications", admin, { url: "https://ntfy.test/leerr", format: "ntfy", token: "tk_secret" }))
      .status,
    200,
  );
  const settings = (await h.call("GET", "/api/v1/admin/settings", admin)).json();
  assert.deepEqual([settings.notifyTarget, settings.notifyFormat, settings.notifyTokenSet], ["ntfy.test/…", "ntfy", true]);
  // The address is a credential for ntfy and Discord: only its host is ever returned.
  assert.equal(JSON.stringify(settings).includes("/leerr"), false);
  assert.equal(JSON.stringify(settings).includes("tk_secret"), false);
  // A blank address keeps the saved one (and its token); null turns notifications off.
  assert.equal((await h.call("PUT", "/api/v1/admin/settings/notifications", admin, { url: "", format: "json" })).status, 200);
  assert.deepEqual([h.store.settings().notifyURL, h.store.settings().notifyToken], ["https://ntfy.test/leerr", "tk_secret"]);
  assert.equal(
    (await h.call("PUT", "/api/v1/admin/settings/notifications", admin, { url: "https://other.test/x", format: "json" })).status,
    200,
  );
  assert.equal(h.store.settings().notifyToken, "", "a new address never inherits the old token");
  assert.equal((await h.call("PUT", "/api/v1/admin/settings/notifications", admin, { url: null, format: "json" })).status, 200);
  assert.equal(h.store.settings().notifyURL, null);
  await h.call("PUT", "/api/v1/admin/settings/notifications", admin, { url: "https://ntfy.test/leerr", format: "ntfy", token: "tk_secret" });
  assert.equal((await h.call("POST", "/api/v1/admin/notifications/test", admin)).status, 200);
  assert.equal(h.upstream.notifications.at(-1)?.notification.event, "test");
  assert.equal(h.upstream.notifications.at(-1)?.target.token, "tk_secret");
  await h.call("POST", "/api/v1/requests", member, requestBody(identities.album));
  await h.work();
  assert.ok(h.upstream.lidarr);
  h.upstream.lidarr.imported = true;
  await h.work(10 * 60_000);
  const sent = h.upstream.notifications.at(-1)?.notification;
  assert.equal(sent?.event, "imported");
  assert.deepEqual(sent?.requesters, ["mia"]);
  assert.match(sent?.title ?? "", /Evening Signals by The Quiet Hours/);
  const count = h.upstream.notifications.length;
  h.clock.advance(24 * 3_600_000);
  await h.reconciler.run();
  assert.equal(h.upstream.notifications.length, count, "no repeats while nothing changes");
  // A broken target is logged and never stops the worker.
  h.upstream.failNotify = new UpstreamError("upstream_unavailable", 503, "Notification target returned HTTP 503.");
  assert.equal((await h.call("POST", "/api/v1/admin/notifications/test", admin)).status, 503);
});

test("the status page reports services, the worker and counts to administrators only", async (t) => {
  const h = await harness(t);
  h.configure();
  const admin = await h.user("root", "admin");
  const member = await h.user("mia");
  await h.call("POST", "/api/v1/requests", member, requestBody(identities.album));
  await h.work();
  const status = (await h.call("GET", "/api/v1/admin/status", admin)).json();
  assert.equal(status.jellyfin.state, "ok");
  assert.equal(status.lidarr.version, "3.1.0");
  assert.equal(status.acquisitions.acquiring, 1);
  assert.equal(status.worker.pendingChanges, 0);
  assert.ok(status.worker.lastPassAt);
  assert.equal((await h.call("GET", "/api/v1/admin/status", member)).status, 403);
  h.upstream.lidarrVersion = async () => {
    throw new UpstreamError("upstream_auth", 502, "Lidarr returned HTTP 401 (unauthorized).", "not_applied");
  };
  h.clock.advance(11_000);
  const broken = (await h.call("GET", "/api/v1/admin/status", admin)).json();
  assert.equal(broken.lidarr.state, "error");
  assert.match(broken.lidarr.message, /401/);
});

test("upstream failures are logged once per route and minute, without secrets", async (t) => {
  const h = await harness(t);
  h.configure();
  const admin = await h.user("root", "admin", "admin");
  for (let attempt = 0; attempt < 3; attempt++) await h.call("GET", "/api/v1/discover/search?q=error", admin);
  const logged = h.events.filter((entry) => entry.event === "upstream_error");
  assert.equal(logged.length, 1);
  assert.deepEqual(logged[0].fields, {
    route: "/api/v1/discover/search",
    code: "upstream_unavailable",
    status: 503,
    message: "MusicBrainz returned HTTP 503.",
    suppressed: 0,
  });
});

test("concurrent Jellyfin sign-ins cannot exceed a member's five guesses", async (t) => {
  const h = await harness(t);
  h.configure();
  const mallory = await h.user("mallory");
  let reached = 0;
  h.upstream.jellyfinLogin = async () => {
    reached++;
    await new Promise((resolve) => setTimeout(resolve, 20));
    throw new UpstreamError("upstream_auth", 502, "Jellyfin returned HTTP 401 (unauthorized).", "not_applied");
  };
  const statuses = await Promise.all(
    Array.from({ length: 8 }, () => h.call("PUT", "/api/v1/connections/jellyfin", mallory, { username: "admin", password: "guess" })),
  ).then((responses) => responses.map((response) => response.status));
  assert.equal(reached, 5);
  assert.equal(statuses.filter((status) => status === 429).length, 3);
});

test("a request whose Lidarr change needs attention can be withdrawn; members cannot re-check imported albums", async (t) => {
  const h = await harness(t);
  h.configure();
  const member = await h.user("mia");
  const { id } = (await h.call("POST", "/api/v1/requests", member, requestBody(identities.album))).json();
  await h.reconciler.settle();
  const row = h.store.acquisitions()[0];
  h.store.updateAcquisition(row.id, {}, { phase: "pending_add", status: "requested" }, h.clock.now());
  assert.equal((await h.call("DELETE", `/api/v1/requests/${id}`, member)).json().error.code, "change_unconfirmed");
  h.store.updateAcquisition(row.id, {}, { status: "attention" }, h.clock.now());
  assert.equal((await h.call("DELETE", `/api/v1/requests/${id}`, member)).status, 200);
  const again = (await h.call("POST", "/api/v1/requests", member, requestBody(identities.album))).json();
  const acquisition = h.store.acquisitions()[0];
  h.store.updateAcquisition(acquisition.id, {}, { status: "imported", phase: "finished" }, h.clock.now());
  assert.equal((await h.call("POST", `/api/v1/requests/${again.id}/retry`, member)).status, 409);
});

test("new releases leave out Various Artists", async (t) => {
  const h = await harness(t);
  h.configure();
  const admin = await h.user("root", "admin", "admin");
  h.upstream.libraries.get("admin-jelly-token")?.push(
    fixtureAlbum({ id: "va", title: "Hits", artist: "Various Artists", artistMBID: "89ad4ac3-39f7-470e-963a-56509c546377" }),
  );
  await h.call("GET", "/api/v1/discover/new-releases", admin);
  assert.deepEqual(h.upstream.newReleaseQueries.at(-1)?.artists, [identities.album.artistMBID]);
});

test("each person's seen outcomes are kept on the server, and a new outcome is unseen again", async (t) => {
  const h = await harness(t);
  h.configure();
  const mia = await h.user("mia");
  const bob = await h.user("bob");
  const { id } = (await h.call("POST", "/api/v1/requests", mia, requestBody(identities.other))).json();
  await h.call("POST", "/api/v1/requests", bob, requestBody(identities.other));
  const unseen = async (client: typeof mia) =>
    (await h.call("GET", "/api/v1/requests", client)).json().items.map((item: { status: string; unseen: boolean }) => [item.status, item.unseen]);
  assert.deepEqual(await unseen(mia), [["requested", false]], "work in progress is not an update");
  const row = h.store.acquisitions()[0];
  h.store.updateAcquisition(row.id, {}, { status: "failed", reason: "No release found." }, h.clock.now());
  assert.deepEqual(await unseen(mia), [["failed", true]]);
  assert.equal((await h.call("POST", "/api/v1/requests/seen", mia, { items: [{ id, status: "failed" }] })).status, 200);
  assert.deepEqual(await unseen(mia), [["failed", false]]);
  assert.deepEqual(await unseen(bob), [["failed", true]], "seen is per person");
  // Someone else's request id changes nothing.
  await h.call("POST", "/api/v1/requests/seen", bob, { items: [{ id, status: "attention" }] });
  h.store.updateAcquisition(row.id, {}, { status: "attention", reason: "Stuck." }, h.clock.now());
  assert.deepEqual(await unseen(mia), [["attention", true]]);
  assert.equal((await h.call("POST", "/api/v1/requests/seen", mia, { items: [{ id, status: "bogus" }] })).status, 400);
});
