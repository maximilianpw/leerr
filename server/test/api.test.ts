import assert from "node:assert/strict";
import test from "node:test";
import { lastfmSecret, plexSecret } from "../store.ts";
import { fixtureAlbum, identities, PLEX_MACHINE, plexIDs, plexLinkFor } from "../testing.ts";
import { PartialReleaseLookup, UpstreamError } from "../upstream/index.ts";
import { harness, ORIGIN, type Client } from "./harness.ts";

const requestBody = (identity: typeof identities.album) => ({
  releaseGroupMBID: identity.releaseGroupMBID,
  releaseMBID: identity.releaseMBID,
  artistMBID: identity.artistMBID,
});

/** Signs `client` in to Plex the way the browser does: start, approve on "plex.tv", then poll. */
async function linkPlex(h: Awaited<ReturnType<typeof harness>>, client: Client, accountToken: string) {
  const started = await h.call("POST", "/api/v1/connections/plex/links", client, {});
  assert.equal(started.status, 200, started.body);
  const { id, authURL } = started.json();
  h.upstream.approvePin(accountToken);
  h.clock.advance(3_000);
  return { id, authURL, result: (await h.call("GET", `/api/v1/connections/plex/links/${id}`, client)).json() };
}

test("people link their own Plex account through Plex's sign-in page; only server-bound tokens are kept, encrypted", async (t) => {
  const h = await harness(t);
  const alice = await h.user("alice");
  const bob = await h.user("bob");
  const missing = await h.call("POST", "/api/v1/connections/plex/links", alice, {});
  assert.equal(missing.json().error.code, "plex_not_configured");
  h.configure();
  const started = (await h.call("POST", "/api/v1/connections/plex/links", alice, {})).json();
  assert.match(started.id, /^[A-Za-z0-9_-]{43}$/);
  const auth = new URL(started.authURL);
  assert.equal(auth.origin, "https://app.plex.tv");
  const fragment = new URLSearchParams(auth.hash.slice(2));
  assert.equal(fragment.get("clientID"), h.store.plexClientID(alice.userID));
  assert.match(fragment.get("clientID") ?? "", /^leerr-[0-9a-f]{32}$/);
  assert.equal(fragment.get("forwardUrl"), `${ORIGIN}/settings/connections?plexLink=${started.id}`);
  assert.equal(fragment.get("context[device][deviceName]"), "Leerr (alice)");
  // Not approved yet: Leerr keeps waiting, and asks plex.tv at most every two seconds.
  assert.equal((await h.call("GET", `/api/v1/connections/plex/links/${started.id}`, alice)).json().state, "waiting");
  h.upstream.approvePin("admin-account");
  assert.equal((await h.call("GET", `/api/v1/connections/plex/links/${started.id}`, alice)).json().state, "waiting", "checked too soon");
  h.clock.advance(3_000);
  const linked = (await h.call("GET", `/api/v1/connections/plex/links/${started.id}`, alice)).json();
  assert.deepEqual([linked.state, linked.username], ["linked", "admin"]);
  // Nobody else can read or finish another person's sign-in.
  assert.equal((await h.call("GET", `/api/v1/connections/plex/links/${started.id}`, bob)).status, 404);
  assert.equal(
    (await h.call("PUT", "/api/v1/connections/lastfm", alice, { username: "alice-fm", apiKey: "lastfm-key" })).status,
    200,
  );
  assert.deepEqual((await h.call("GET", "/api/v1/connections", alice)).json(), {
    plexConfigured: true,
    plex: { username: "admin", managed: false },
    plexValid: true,
    lastfm: "alice-fm",
    lastfmKeyProvided: false,
    lidarrConfigured: true,
    lidarrReady: true,
  });
  assert.equal((await h.call("GET", "/api/v1/connections", bob)).json().plex, null);
  const saved = h.store.secret(alice.userID, "plex", plexSecret);
  assert.deepEqual([saved?.serverToken, saved?.machineID], ["admin-plex-token", PLEX_MACHINE]);
  const raw = JSON.stringify(h.store.db.prepare("SELECT value FROM secrets").all());
  assert.equal(raw.includes("admin-plex-token") || raw.includes("admin-account"), false);
  assert.equal(raw.includes("lastfm-key"), false);
  assert.equal((await h.call("DELETE", "/api/v1/connections/lastfm", alice)).status, 200);
  assert.equal(h.store.secret(alice.userID, "lastfm", lastfmSecret), null);
  // Disconnecting forgets the link and signs it out on plex.tv.
  assert.equal((await h.call("DELETE", "/api/v1/connections/plex", alice)).status, 200);
  assert.equal(h.store.secret(alice.userID, "plex", plexSecret), null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.upstream.signOuts, ["admin-account"]);
});

test("each Leerr user has their own random Plex client identifier, which plex.tv ties the sign-in to", async (t) => {
  const h = await harness(t);
  h.configure();
  const alice = await h.user("alice");
  const bob = await h.user("bob");
  const aliceID = h.store.plexClientID(alice.userID);
  assert.equal(h.store.plexClientID(alice.userID), aliceID, "stable");
  assert.notEqual(h.store.plexClientID(bob.userID), aliceID);
  assert.equal(aliceID.includes(alice.userID), false, "the identifier does not reveal the user id");
  const { result } = await linkPlex(h, alice, "member-account");
  assert.equal(result.state, "linked");
  // plex.tv only gives the token to the identifier that created the PIN.
  const started = (await h.call("POST", "/api/v1/connections/plex/links", bob, {})).json();
  const pin = [...h.upstream.pins.values()].at(-1);
  assert.ok(pin);
  pin.clientID = aliceID;
  pin.token = "admin-account";
  h.clock.advance(3_000);
  assert.equal((await h.call("GET", `/api/v1/connections/plex/links/${started.id}`, bob)).json().state, "waiting");
});

test("a Plex account the server is not shared with is not linked, and an expired sign-in says so", async (t) => {
  const h = await harness(t);
  h.configure();
  const alice = await h.user("alice");
  assert.equal((await linkPlex(h, alice, "stranger-account")).result.state, "no_access");
  assert.equal(h.store.secret(alice.userID, "plex", plexSecret), null);
  const started = (await h.call("POST", "/api/v1/connections/plex/links", alice, {})).json();
  const pin = [...h.upstream.pins.values()].at(-1);
  assert.ok(pin);
  pin.expired = true;
  h.clock.advance(3_000);
  assert.equal((await h.call("GET", `/api/v1/connections/plex/links/${started.id}`, alice)).json().state, "expired");
  // A new sign-in replaces the old one.
  const next = (await h.call("POST", "/api/v1/connections/plex/links", alice, {})).json();
  assert.equal((await h.call("GET", `/api/v1/connections/plex/links/${started.id}`, alice)).status, 404);
  assert.equal((await h.call("GET", `/api/v1/connections/plex/links/${next.id}`, alice)).json().state, "waiting");
});

test("a full Home member links a managed profile; Leerr keeps only the profile's own sign-in", async (t) => {
  const h = await harness(t);
  h.configure();
  const admin = await h.user("root", "admin");
  const kid = await h.user("kid");
  const { id } = (await h.call("POST", `/api/v1/admin/users/${kid.userID}/plex/links`, admin, {})).json();
  h.upstream.approvePin("admin-account");
  h.clock.advance(3_000);
  const result = (await h.call("GET", `/api/v1/connections/plex/links/${id}`, admin)).json();
  assert.equal(result.state, "choose_profile");
  assert.deepEqual(result.profiles, [{ uuid: "kid-uuid", name: "Kid", protected: true }]);
  assert.equal(h.store.secret(kid.userID, "plex", plexSecret), null, "nothing is stored before a profile is chosen");
  const pick = (body: { uuid: string; pin?: string }) => h.call("POST", `/api/v1/connections/plex/links/${id}/profile`, admin, body);
  assert.equal((await pick({ uuid: "admin-uuid" })).status, 400, "only listed managed profiles");
  assert.equal((await pick({ uuid: "kid-uuid", pin: "0000" })).status, 403);
  // plex.tv failing after the switch leaves the choice open, to try again.
  h.upstream.failServerToken = new UpstreamError("upstream_unavailable", 503, "plex.tv returned HTTP 503.");
  assert.equal((await pick({ uuid: "kid-uuid", pin: "1234" })).status, 503);
  h.upstream.failServerToken = null;
  const chosen = await pick({ uuid: "kid-uuid", pin: "1234" });
  assert.equal(chosen.json().state, "linked");
  const saved = h.store.secret(kid.userID, "plex", plexSecret);
  assert.deepEqual([saved?.accountToken, saved?.serverToken, saved?.managed, saved?.username], ["kid-account", "kid-plex-token", true, "Kid"]);
  assert.equal(JSON.stringify(saved).includes("admin-account"), false, "the member's own token is not kept");
  assert.deepEqual((await h.call("GET", "/api/v1/connections", kid)).json().plex, { username: "Kid", managed: true });
});

test("starting Plex sign-ins is limited per person", async (t) => {
  const h = await harness(t);
  h.configure();
  const alice = await h.user("alice");
  for (let index = 0; index < 10; index++)
    assert.equal((await h.call("POST", "/api/v1/connections/plex/links", alice, {})).status, 200);
  const limited = await h.call("POST", "/api/v1/connections/plex/links", alice, {});
  assert.equal(limited.status, 429);
  assert.equal(limited.json().error.message, "Too many requests. Try again in 15 minutes.");
});

test("a Plex server token that stops working is fetched again once before the person is asked to sign in again", async (t) => {
  const h = await harness(t);
  h.configure();
  const admin = await h.user("root", "admin", "admin");
  // The share was re-created: plex.tv hands out a new server token.
  h.upstream.revokedTokens.add("admin-plex-token");
  const entry = h.upstream.accounts.get("admin-account");
  assert.ok(entry);
  entry.serverToken = "admin-plex-token-2";
  h.upstream.libraries.set("admin-plex-token-2", h.upstream.libraries.get("admin-plex-token") ?? []);
  assert.equal((await h.call("GET", "/api/v1/library", admin)).status, 200);
  assert.equal(h.store.secret(admin.userID, "plex", plexSecret)?.serverToken, "admin-plex-token-2");
  // Really gone: the person is told to sign in again, and stays signed in to Leerr.
  h.upstream.revokedTokens.add("admin-plex-token-2");
  entry.serverToken = null;
  h.clock.advance(6 * 60_000);
  const library = await h.call("GET", "/api/v1/library", admin);
  assert.equal(library.status, 409);
  assert.equal(library.json().error.code, "plex_reconnect");
  assert.equal((await h.call("GET", "/api/v1/connections", admin)).json().plexValid, false);
  assert.equal((await h.call("GET", "/api/v1/me", admin)).status, 200);
  // Requests still work: the library check is best effort.
  assert.equal((await h.call("POST", "/api/v1/requests", admin, requestBody(identities.other))).status, 200);
  assert.equal((await h.call("GET", "/api/v1/requests", admin)).json().libraryChecked, false);
});

test("nobody's token goes to the saved address unless it proves to be the saved Plex server", async (t) => {
  const h = await harness(t);
  h.configure();
  const admin = await h.user("root", "admin", "admin");
  assert.equal((await h.call("GET", "/api/v1/library", admin)).status, 200);
  h.upstream.machineID = "someone-elses-server";
  h.clock.advance(11 * 60_000);
  const library = await h.call("GET", "/api/v1/library", admin);
  assert.equal(library.json().error.code, "plex_wrong_server");
  assert.equal(h.upstream.libraryCalls, 1, "the second listing never reached Plex");
  // Requests, search and Settings keep working without the library meanwhile.
  assert.equal((await h.call("GET", "/api/v1/requests", admin)).json().libraryChecked, false);
  assert.equal((await h.call("GET", "/api/v1/discover/search?q=x", admin)).status, 200);
  assert.equal((await h.call("POST", "/api/v1/requests", admin, requestBody(identities.other))).status, 200);
  assert.equal((await h.call("GET", "/api/v1/connections", admin)).json().plexValid, null);
  const status = (await h.call("GET", "/api/v1/admin/status", admin)).json();
  assert.equal(status.plex.state, "error");
  assert.match(status.plex.message, /different Plex server/);
  // An address that answers with something other than Plex's identity gets no token either.
  h.upstream.machineID = PLEX_MACHINE;
  for (const failure of [
    new UpstreamError("upstream_rejected", 502, "Plex rejected the request (HTTP 404).", "not_applied"),
    new UpstreamError("upstream_protocol", 502, "Plex did not return valid JSON."),
  ]) {
    h.upstream.failIdentity = failure;
    assert.notEqual((await h.call("GET", "/api/v1/library", admin)).status, 200);
    assert.equal(h.upstream.libraryCalls, 1);
  }
});

test("a renewed Plex server token is shared by everyone waiting for it, and works for the library at once", async (t) => {
  const h = await harness(t);
  h.configure();
  const admin = await h.user("root", "admin", "admin");
  const entry = h.upstream.accounts.get("admin-account");
  assert.ok(entry);
  h.upstream.revokedTokens.add("admin-plex-token");
  entry.serverToken = "admin-plex-token-2";
  h.upstream.libraries.set("admin-plex-token-2", h.upstream.libraries.get("admin-plex-token") ?? []);
  const statuses = await Promise.all(
    ["/api/v1/library", "/api/v1/library/artists", "/api/v1/playlists"].map(async (url) => (await h.call("GET", url, admin)).status),
  );
  assert.deepEqual(statuses, [200, 200, 200]);
  assert.equal(h.upstream.serverTokenCalls, 1, "one plex.tv call for all three");
  // The library summary walks with the new token, rather than a cached failure.
  assert.equal((await h.call("GET", "/api/v1/requests", admin)).json().libraryChecked, true);
  assert.equal((await h.call("GET", "/api/v1/discover/recommendations", admin)).status, 200);
  // The Connections check renews too, instead of telling the person to sign in again.
  h.upstream.revokedTokens.add("admin-plex-token-2");
  entry.serverToken = "admin-plex-token-3";
  h.upstream.libraries.set("admin-plex-token-3", h.upstream.libraries.get("admin-plex-token") ?? []);
  h.clock.advance(6 * 60_000);
  assert.equal((await h.call("GET", "/api/v1/connections", admin)).json().plexValid, true);
  // plex.tv being down is an outage, not a reason to sign in again.
  h.upstream.revokedTokens.add("admin-plex-token-3");
  h.upstream.failServerToken = new UpstreamError("upstream_unavailable", 503, "plex.tv returned HTTP 503.");
  h.clock.advance(6 * 60_000);
  const outage = await h.call("GET", "/api/v1/library", admin);
  assert.equal(outage.json().error.code, "upstream_unavailable");
});

test("one Plex account belongs to one Leerr user", async (t) => {
  const h = await harness(t);
  h.configure();
  const owner = await h.user("owner");
  const child = await h.user("child");
  assert.equal((await linkPlex(h, owner, "admin-account")).result.state, "linked");
  // E.g. the owner approving a sign-in on a child's device by mistake.
  const { result } = await linkPlex(h, child, "admin-account");
  assert.deepEqual([result.state, result.mode], ["in_use", "own"]);
  assert.equal(h.store.secret(child.userID, "plex", plexSecret), null);
  // The owner signing in again on their own account is fine.
  assert.equal((await linkPlex(h, owner, "admin-account")).result.state, "linked");
});

test("an administrator links a managed Home profile for someone from their own device", async (t) => {
  const h = await harness(t);
  h.configure();
  const admin = await h.user("root", "admin");
  const kid = await h.user("kid");
  assert.equal((await h.call("POST", `/api/v1/admin/users/${kid.userID}/plex/links`, kid, {})).status, 403);
  const started = (await h.call("POST", `/api/v1/admin/users/${kid.userID}/plex/links`, admin, {})).json();
  const fragment = new URLSearchParams(new URL(started.authURL).hash.slice(2));
  assert.equal(fragment.get("clientID"), h.store.plexClientID(kid.userID), "the sign-in is the child's device in Plex");
  assert.equal(fragment.get("context[device][deviceName]"), "Leerr (kid)");
  assert.equal(fragment.get("forwardUrl"), `${ORIGIN}/settings/users?plexLink=${started.id}`);
  h.upstream.approvePin("admin-account");
  h.clock.advance(3_000);
  assert.equal((await h.call("GET", `/api/v1/connections/plex/links/${started.id}`, kid)).status, 404, "only the administrator follows it");
  const chosen = (await h.call("GET", `/api/v1/connections/plex/links/${started.id}`, admin)).json();
  assert.deepEqual([chosen.state, chosen.mode], ["choose_profile", "managed"]);
  const linked = await h.call("POST", `/api/v1/connections/plex/links/${started.id}/profile`, admin, { uuid: "kid-uuid", pin: "1234" });
  assert.equal(linked.json().state, "linked");
  assert.equal(h.store.secret(kid.userID, "plex", plexSecret)?.accountToken, "kid-account");
  assert.equal(h.store.secret(admin.userID, "plex", plexSecret), null, "the administrator's own link is untouched");
  const users = (await h.call("GET", "/api/v1/admin/users", admin)).json().items;
  assert.deepEqual(users.find((user: { username: string }) => user.username === "kid").plex, { username: "Kid", managed: true });
  // Members only ever link their own account: whoever sees the profile list picks from it.
  const own = (await h.call("POST", "/api/v1/connections/plex/links", kid, { mode: "managed" })).json();
  assert.equal(new URLSearchParams(new URL(own.authURL).hash.slice(2)).get("forwardUrl"), `${ORIGIN}/settings/connections?plexLink=${own.id}`);
  h.upstream.approvePin("admin-account");
  h.clock.advance(3_000);
  assert.equal((await h.call("GET", `/api/v1/connections/plex/links/${own.id}`, kid)).json().mode, "own");
  // A profile linked to the wrong person is undone by an administrator.
  assert.equal((await h.call("DELETE", `/api/v1/admin/users/${kid.userID}/plex`, kid)).status, 403);
  assert.equal((await h.call("DELETE", `/api/v1/admin/users/${kid.userID}/plex`, admin)).status, 200);
  assert.equal(h.store.secret(kid.userID, "plex", plexSecret), null);
  assert.equal((await h.call("GET", `/api/v1/connections/plex/links/${own.id}`, kid)).status, 404, "a sign-in in progress ends too");
  const after = (await h.call("GET", "/api/v1/admin/users", admin)).json().items;
  assert.equal(after.find((user: { username: string }) => user.username === "kid").plex, null);
});

test("a plex.tv hiccup while a sign-in is checked leaves it waiting, and the next check finishes it", async (t) => {
  const h = await harness(t);
  h.configure();
  const alice = await h.user("alice");
  const { id } = (await h.call("POST", "/api/v1/connections/plex/links", alice, {})).json();
  h.upstream.approvePin("admin-account");
  h.upstream.failServerToken = new UpstreamError("upstream_unavailable", 503, "plex.tv returned HTTP 503.");
  h.clock.advance(3_000);
  assert.equal((await h.call("GET", `/api/v1/connections/plex/links/${id}`, alice)).json().state, "waiting");
  assert.equal(h.store.secret(alice.userID, "plex", plexSecret), null);
  h.upstream.failServerToken = null;
  h.clock.advance(3_000);
  assert.equal((await h.call("GET", `/api/v1/connections/plex/links/${id}`, alice)).json().state, "linked");
  assert.ok(h.store.secret(alice.userID, "plex", plexSecret));
});

test("the library summary keeps the releases MusicBrainz resolved before it failed", async (t) => {
  const h = await harness(t);
  h.configure();
  const admin = await h.user("root", "admin", "admin");
  h.upstream.releaseGroupsOf = async () => {
    throw new PartialReleaseLookup(
      new UpstreamError("upstream_unavailable", 503, "MusicBrainz returned HTTP 503."),
      new Map([[identities.album.releaseMBID, identities.album.releaseGroupMBID]]),
    );
  };
  const search = (await h.call("GET", "/api/v1/discover/search?q=x", admin)).json();
  assert.equal(search.items.find((item: { id: string }) => item.id === identities.album.releaseGroupMBID).status, "available");
  assert.equal(h.store.releaseGroups([identities.album.releaseMBID], h.clock.now()).get(identities.album.releaseMBID), identities.album.releaseGroupMBID);
  assert.ok(h.events.some((entry) => entry.event === "release_lookup_failed"));
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

test("library, albums and artwork are read with each user's own Plex account", async (t) => {
  const h = await harness(t);
  h.configure();
  const admin = await h.user("root", "admin", "admin");
  const member = await h.user("mia", "member", "member");
  const stranger = await h.user("sam");
  const page = (await h.call("GET", "/api/v1/library?limit=1", admin)).json();
  assert.equal(page.total, 2);
  assert.equal(page.items.length, 1);
  assert.equal((await h.call("GET", "/api/v1/library?q=untag", admin)).json().items[0].id, plexIDs.untagged);
  assert.equal((await h.call("GET", "/api/v1/library?limit=501", admin)).status, 400);
  assert.equal((await h.call("GET", `/api/v1/albums/${plexIDs.album}`, member)).status, 404);
  assert.equal((await h.call("GET", "/api/v1/albums/not-a-rating-key", admin)).status, 400, "Plex ids are decimal");
  assert.equal((await h.call("GET", "/api/v1/library", stranger)).json().error.code, "plex_not_connected");
  const album = (await h.call("GET", `/api/v1/albums/${plexIDs.album}`, admin)).json();
  assert.equal(album.tracks[0].codec, "flac");
  assert.equal(album.album.artistMBID, identities.album.artistMBID);
  const artwork = await h.call("GET", `/api/v1/artwork/${plexIDs.album}?size=small`, admin);
  assert.equal(artwork.headers["content-type"], "image/png");
  assert.equal(artwork.headers["cache-control"], "private, max-age=86400");
  assert.equal(h.upstream.artworkSizes.at(-1), "small");
  assert.equal((await h.call("GET", `/api/v1/artwork/${plexIDs.album}?size=huge`, admin)).status, 400);
  // Missing art is a cheap, cacheable 404 rather than an error every time.
  const none = await h.call("GET", `/api/v1/artwork/${plexIDs.untagged}`, admin);
  assert.equal(none.status, 404);
  assert.equal(none.headers["cache-control"], "private, max-age=3600");
  assert.equal((await h.call("GET", `/api/v1/artwork/${plexIDs.album}`)).status, 401);
});

test("the library can be sorted, filtered by artist or favourites, and browsed by artist", async (t) => {
  const h = await harness(t);
  h.configure();
  const admin = await h.user("root", "admin", "admin");
  await h.call("GET", `/api/v1/library?sort=added&artist=${plexIDs.artist}&favorites=1`, admin);
  assert.deepEqual(h.upstream.libraryQueries.at(-1), {
    offset: 0,
    limit: 60,
    q: "",
    sort: "added",
    artistID: plexIDs.artist,
    favorites: true,
  });
  assert.equal((await h.call("GET", "/api/v1/library?sort=random", admin)).status, 400);
  assert.equal((await h.call("GET", "/api/v1/library?artist=..%2Fx", admin)).status, 400);
  const artists = (await h.call("GET", "/api/v1/library/artists", admin)).json();
  assert.deepEqual(artists.items, [{ id: plexIDs.artist, name: identities.album.artist, hasArtwork: false }]);
});

test("favourites and playlists go to the user's own Plex account", async (t) => {
  const h = await harness(t);
  h.configure();
  const admin = await h.user("root", "admin", "admin");
  const member = await h.user("mia", "member", "member");
  assert.equal((await h.call("PUT", `/api/v1/favorites/${plexIDs.album}`, admin)).status, 200);
  assert.equal((await h.call("GET", "/api/v1/library?favorites=1", admin)).json().items[0].id, plexIDs.album);
  assert.equal((await h.call("PUT", `/api/v1/favorites/${plexIDs.album}`, member)).status, 404, "only items the user can see");
  assert.equal((await h.call("DELETE", `/api/v1/favorites/${plexIDs.album}`, admin)).status, 200);
  assert.equal(h.upstream.favorites.size, 0);
  const playlists = (await h.call("GET", "/api/v1/playlists", admin)).json();
  assert.deepEqual(playlists.items.map((playlist: { name: string; smart: boolean }) => [playlist.name, playlist.smart]), [["Dinner", false], ["Top rated", true]]);
  const dinner = (await h.call("GET", `/api/v1/playlists/${plexIDs.playlist}`, admin)).json();
  assert.equal(dinner.tracks[0].albumID, plexIDs.album);
  assert.equal((await h.call("POST", `/api/v1/playlists/${plexIDs.playlist}/tracks`, admin, { trackIDs: [plexIDs.track] })).status, 200);
  assert.deepEqual(h.upstream.playlistAdds, [{ playlistID: plexIDs.playlist, trackIDs: [plexIDs.track] }]);
  assert.equal((await h.call("POST", `/api/v1/playlists/${plexIDs.playlist}/tracks`, admin, { trackIDs: [] })).status, 400);
  assert.equal((await h.call("POST", `/api/v1/playlists/${plexIDs.smartPlaylist}/tracks`, admin, { trackIDs: [plexIDs.track] })).status, 409);
  assert.equal((await h.call("GET", `/api/v1/playlists/${plexIDs.playlist}`, member)).status, 404);
});

test("playback is reported to Plex with the person's account, per browser, and Plex can end it", async (t) => {
  const h = await harness(t);
  h.configure();
  const admin = await h.user("root", "admin", "admin");
  const other = await h.login("root");
  for (const [event, position, paused] of [
    ["start", 0, false],
    ["progress", 31.5, false],
    ["progress", 40, true],
    ["stop", 64, true],
  ] as const)
    assert.deepEqual((await h.call("POST", "/api/v1/playback", admin, { trackID: plexIDs.track, event, position, paused })).json(), {});
  assert.deepEqual(
    h.upstream.reports.map((report) => [report.state, report.position, report.durationMs]),
    [
      ["playing", 0, 100],
      ["playing", 31.5, 100],
      ["paused", 40, 100],
      ["stopped", 64, 100],
    ],
  );
  await h.call("POST", "/api/v1/playback", other, { trackID: plexIDs.track, event: "start", position: 0 });
  const sessions = new Set(h.upstream.reports.map((report) => report.session));
  assert.equal(sessions.size, 2, "each browser is its own player in Plex");
  h.upstream.terminate = "The server owner stopped this stream.";
  assert.deepEqual((await h.call("POST", "/api/v1/playback", admin, { trackID: plexIDs.track, event: "progress", position: 5 })).json(), {
    stop: "The server owner stopped this stream.",
  });
  assert.equal((await h.call("POST", "/api/v1/playback", admin, { trackID: plexIDs.track, event: "seek", position: 1 })).status, 400);
  const stranger = await h.user("sam");
  assert.equal((await h.call("POST", "/api/v1/playback", stranger, { trackID: plexIDs.track, event: "start", position: 0 })).status, 409);
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
  // Once the admin's Plex can see the album, it is available to them.
  h.upstream.libraries.get("admin-plex-token")?.push(
    fixtureAlbum({ id: "103", title: identities.other.title, artist: identities.other.artist, releaseMBID: identities.other.releaseMBID }),
  );
  h.context.library.invalidate();
  const now = (await h.call("GET", "/api/v1/requests", admin)).json().items[0];
  assert.equal(now.status, "available");
  assert.equal(now.albumID, "103");
  assert.equal(h.upstream.createCalls, 1);
});

test("a Plex outage does not block new requests", async (t) => {
  const h = await harness(t);
  h.configure();
  const admin = await h.user("root", "admin", "admin");
  h.upstream.failLibrary = new UpstreamError("upstream_unavailable", 503, "Plex returned HTTP 503.");
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

test("the Plex address must be HTTPS and a claimed server; tokens never follow it to a different server", async (t) => {
  const h = await harness(t);
  h.configure();
  const admin = await h.user("root", "admin", "admin");
  const ticket = (await h.call("POST", "/api/v1/stream-tickets", admin, { trackID: plexIDs.track })).json();
  const save = (url: string) => h.call("PUT", "/api/v1/admin/settings/plex", admin, { url });
  assert.equal((await save("http://insecure.test")).status, 400);
  h.upstream.claimed = false;
  assert.equal((await save("https://unclaimed.test")).json().error.code, "plex_unclaimed");
  h.upstream.claimed = true;
  // The same server at another address (e.g. its plex.direct name): links are kept.
  assert.equal((await save("https://127-0-0-1.abc.plex.direct:32400/")).status, 200);
  assert.equal(h.store.settings().plexURL, "https://127-0-0-1.abc.plex.direct:32400");
  assert.ok(h.store.secret(admin.userID, "plex", plexSecret));
  assert.equal((await h.call("GET", ticket.url)).status, 200);
  // Clearing the address switches Plex off but keeps the pinned server, so saving it again loses nothing.
  h.store.saveSettings({ ...h.store.settings(), plexSection: "3" });
  assert.equal((await save("")).status, 200);
  assert.deepEqual([h.store.settings().plexURL, h.store.settings().plexMachineID], [null, PLEX_MACHINE]);
  assert.equal((await h.call("GET", "/api/v1/library", admin)).json().error.code, "plex_not_configured");
  assert.equal((await save("https://127-0-0-1.abc.plex.direct:32400")).status, 200);
  assert.ok(h.store.secret(admin.userID, "plex", plexSecret));
  assert.equal(h.store.settings().plexSection, "3");
  // A different server: every link and ticket goes.
  h.upstream.machineID = "another-machine";
  assert.equal((await save("https://other.test")).status, 200);
  assert.equal(h.store.settings().plexMachineID, "another-machine");
  assert.equal(h.store.secret(admin.userID, "plex", plexSecret), null);
  assert.equal((await h.call("GET", ticket.url)).status, 401);
  const settings = (await h.call("GET", "/api/v1/admin/settings", admin)).json();
  assert.deepEqual([settings.plexURL, settings.plexSection], ["https://other.test", null]);
});

test("administrators see the music libraries their own Plex sign-in can see and may pick one", async (t) => {
  const h = await harness(t);
  h.configure();
  const admin = await h.user("root", "admin");
  assert.equal((await h.call("GET", "/api/v1/admin/plex/sections", admin)).json().error.code, "plex_not_connected");
  h.store.putSecret(admin.userID, "plex", JSON.stringify(plexLinkFor("admin")));
  assert.deepEqual((await h.call("GET", "/api/v1/admin/plex/sections", admin)).json(), {
    items: [{ key: "3", title: "Music", agent: "tv.plex.agents.music", scanner: "Plex Music" }],
    selected: null,
  });
  assert.equal((await h.call("PUT", "/api/v1/admin/settings/plex/section", admin, { key: "3" })).status, 200);
  assert.equal(h.store.settings().plexSection, "3");
  assert.equal((await h.call("PUT", "/api/v1/admin/settings/plex/section", admin, { key: "../x" })).status, 400);
  const member = await h.user("mia");
  assert.equal((await h.call("PUT", "/api/v1/admin/settings/plex/section", member, { key: null })).status, 403);
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
    ["available", plexIDs.album],
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
  h.upstream.failLibrary = new UpstreamError("upstream_unavailable", 503, "Plex returned HTTP 503.");
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
  assert.equal(status.plex.state, "ok");
  assert.equal(status.plex.version, "1.43.3.10861");
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
  h.upstream.libraries.get("admin-plex-token")?.push(
    fixtureAlbum({ id: "104", title: "Hits", artist: "Various Artists", artistID: "590", artistMBID: "89ad4ac3-39f7-470e-963a-56509c546377" }),
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

test("Plex albums are matched to requests by looking their MusicBrainz release up once, for everyone", async (t) => {
  const h = await harness(t);
  h.configure();
  const admin = await h.user("root", "admin", "admin");
  const member = await h.user("mia", "member", "member");
  const requests = (await h.call("GET", "/api/v1/requests", admin)).json();
  assert.deepEqual(requests.library, { albums: 2, unmatched: 1 });
  assert.deepEqual(h.upstream.releaseLookups, [[identities.album.releaseMBID]]);
  assert.equal(h.store.releaseGroups([identities.album.releaseMBID], h.clock.now()).get(identities.album.releaseMBID), identities.album.releaseGroupMBID);
  // The admin's album page links to its release group without asking again.
  assert.equal((await h.call("GET", `/api/v1/albums/${plexIDs.album}`, admin)).json().album.releaseGroupMBID, identities.album.releaseGroupMBID);
  // An edition someone looked at in Discover is known without MusicBrainz.
  await h.call("GET", `/api/v1/discover/release-groups/${identities.other.releaseGroupMBID}/editions`, member);
  await h.call("GET", "/api/v1/requests", member);
  assert.equal(h.upstream.releaseLookups.length, 1);
  // MusicBrainz being down leaves albums unresolved for now, without failing anything.
  h.upstream.libraries.get("admin-plex-token")?.push(
    fixtureAlbum({ id: "105", title: "Later", artist: "Someone", releaseMBID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
  );
  h.upstream.failReleaseLookup = new UpstreamError("upstream_unavailable", 503, "MusicBrainz returned HTTP 503.");
  h.context.library.invalidate();
  assert.deepEqual((await h.call("GET", "/api/v1/requests", admin)).json().library, { albums: 3, unmatched: 1 });
  assert.ok(h.events.some((entry) => entry.event === "release_lookup_failed"));
});

test("an arrived album Plex did not match is pointed at, so it can be played and fixed in Plex", async (t) => {
  const h = await harness(t);
  h.configure();
  const admin = await h.user("root", "admin", "admin");
  const { id } = (await h.call("POST", "/api/v1/requests", admin, requestBody(identities.other))).json();
  await h.reconciler.settle();
  const acquisition = h.store.acquisitions()[0];
  h.store.updateAcquisition(acquisition.id, {}, { status: "imported", phase: "finished" }, h.clock.now());
  const item = async () => (await h.call("GET", "/api/v1/requests", admin)).json().items.find((entry: { id: string }) => entry.id === id);
  assert.deepEqual([(await item()).status, (await item()).unmatchedAlbumID], ["imported", null], "not in Plex yet");
  // Plex scanned it but matched nothing (or another album); the names still agree, give or take case and punctuation.
  h.upstream.libraries.get("admin-plex-token")?.push(fixtureAlbum({ id: "106", title: "coastal lines!", artist: "MIRA SOL" }));
  h.context.library.invalidate();
  assert.deepEqual([(await item()).status, (await item()).albumID, (await item()).unmatchedAlbumID], ["imported", null, "106"]);
});

test("tracks browsers cannot play are converted by Plex, and seeking starts the conversion again", async (t) => {
  const h = await harness(t);
  h.configure();
  const admin = await h.user("root", "admin", "admin");
  const direct = (await h.call("POST", "/api/v1/stream-tickets", admin, { trackID: plexIDs.track })).json();
  assert.equal(direct.transcoded, false);
  const ticket = (await h.call("POST", "/api/v1/stream-tickets", admin, { trackID: plexIDs.alacTrack })).json();
  assert.equal(ticket.transcoded, true);
  const stream = await h.call("GET", `${ticket.url}?start=42.5`);
  assert.equal(stream.status, 200);
  assert.equal(stream.headers["content-type"], "audio/mpeg");
  assert.equal(stream.headers["accept-ranges"], "none");
  assert.deepEqual(h.upstream.transcodes.map((entry) => [entry.trackID, entry.offset]), [[plexIDs.alacTrack, 42.5]]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.upstream.stoppedTranscodes, [h.upstream.transcodes[0].session], "the conversion ends with the response");
  assert.equal((await h.call("GET", `${ticket.url}?start=-1`)).status, 400);
});
