import assert from "node:assert/strict";
import test from "node:test";
import { LiveUpstreams, PartialReleaseLookup, UpstreamError, type PlexAccess } from "../upstream/index.ts";
import type { JsonValue } from "../upstream/http.ts";

const release = "22222222-2222-4222-8222-222222222222";
const group = "11111111-1111-4111-8111-111111111111";
const artistMBID = "33333333-3333-4333-8333-333333333333";
const access: PlexAccess = {
  endpoint: "https://plex.test",
  token: "server-token",
  clientID: "leerr-client",
  machineID: "machine-1",
  section: "3",
};
const json = (body: JsonValue, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const html = (status: number) => new Response(`<html><h1>${status}</h1></html>`, { status, headers: { "Content-Type": "text/html" } });
const container = (fields: Record<string, JsonValue>) => json({ MediaContainer: fields });
const urlOf = (input: string | URL | Request) => (input instanceof URL ? input : new URL(String(input)));
type Call = { url: URL; method: string; headers: Headers };

/** A fake Plex: answers by path, and records every call. */
function plex(routes: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const upstream = new LiveUpstreams(async (input, init) => {
    const call = { url: urlOf(input), method: init?.method ?? "GET", headers: new Headers(init?.headers) };
    calls.push(call);
    return routes(call);
  });
  return { upstream, calls };
}

const album = (values: Record<string, JsonValue> = {}) => ({
  ratingKey: "1457",
  type: "album",
  title: "AT.LONG.LAST.A$AP",
  parentTitle: "A$AP Rocky",
  parentRatingKey: "1338",
  year: 2015,
  thumb: "/library/metadata/1457/thumb/1790055576",
  guid: "plex://album/5d07c956403c640290c7cfa5",
  Guid: [{ id: `mbid://${release.toUpperCase()}` }],
  ...values,
});

test("library pages ask Plex's section for albums with Plex's own sort and filter names, as the person", async () => {
  const { upstream, calls } = plex(() => container({ size: 1, totalSize: 40, Metadata: [album({ userRating: 10 })] }));
  const page = await upstream.plexLibrary(access, { offset: 20, limit: 10, q: "long", sort: "artist", artistID: "1338", favorites: true });
  const call = calls[0];
  assert.equal(call.url.pathname, "/library/sections/3/all");
  assert.deepEqual(Object.fromEntries(call.url.searchParams), {
    type: "9",
    sort: "artist.titleSort,album.titleSort,album.index,album.id,album.originallyAvailableAt",
    includeGuids: "1",
    excludeFields: "summary",
    title: "long",
    "artist.id": "1338",
    userRating: "10",
  });
  assert.equal(call.headers.get("x-plex-token"), "server-token");
  assert.equal(call.headers.get("x-plex-client-identifier"), "leerr-client");
  assert.equal(call.headers.get("x-plex-container-start"), "20");
  assert.equal(call.headers.get("x-plex-container-size"), "10");
  assert.equal(call.headers.get("accept"), "application/json");
  assert.equal(call.url.search.includes("server-token"), false, "the token never travels in the URL");
  assert.deepEqual(page, {
    total: 40,
    items: [
      {
        id: "1457",
        title: "AT.LONG.LAST.A$AP",
        artist: "A$AP Rocky",
        artistID: "1338",
        artistMBID: null,
        year: 2015,
        releaseGroupMBID: null,
        releaseMBID: release,
        hasArtwork: true,
        favorite: true,
        available: true,
      },
    ],
  });
});

test("an album list Plex did not filter is refused rather than shown as filtered", async () => {
  // Plex answers unknown filters with the whole library.
  const { upstream } = plex(() => container({ totalSize: 2, Metadata: [album(), album({ ratingKey: "9", parentRatingKey: "77" })] }));
  await assert.rejects(
    upstream.plexLibrary(access, { offset: 0, limit: 10, q: "", sort: "title", artistID: "1338", favorites: false }),
    (error: Error) => error instanceof UpstreamError && /ignored the artist filter/.test(error.message),
  );
  await assert.rejects(
    upstream.plexLibrary(access, { offset: 0, limit: 10, q: "", sort: "title", artistID: null, favorites: true }),
    (error: Error) => error instanceof UpstreamError && /favourites/.test(error.message),
  );
});

test("without a chosen library, Plex's music library is used, and the choice is remembered", async () => {
  const { upstream, calls } = plex((call) =>
    call.url.pathname === "/library/sections/all"
      ? container({
          Directory: [
            { key: "1", type: "movie", title: "Movies", agent: "tv.plex.agents.movie" },
            { key: "6", type: "artist", title: "Audiobooks", agent: "com.plexapp.agents.audnexus" },
            { key: "3", type: "artist", title: "Music", agent: "tv.plex.agents.music", scanner: "Plex Music" },
          ],
        })
      : container({ totalSize: 0, Metadata: [] }),
  );
  const auto = { ...access, section: null };
  await upstream.plexLibrary(auto, { offset: 0, limit: 10, q: "", sort: "title", artistID: null, favorites: false });
  await upstream.plexArtists(auto, 0, 10, "");
  assert.deepEqual(
    calls.map((call) => call.url.pathname),
    ["/library/sections/all", "/library/sections/3/all", "/library/sections/3/all"],
  );
  assert.deepEqual(await upstream.plexSections(auto), [
    { key: "6", title: "Audiobooks", agent: "com.plexapp.agents.audnexus", scanner: "" },
    { key: "3", title: "Music", agent: "tv.plex.agents.music", scanner: "Plex Music" },
  ]);
});

test("a chosen music library that Plex no longer has is named as the problem", async () => {
  const { upstream } = plex(() => html(404));
  for (const call of [
    () => upstream.plexLibrary(access, { offset: 0, limit: 10, q: "", sort: "title", artistID: null, favorites: false }),
    () => upstream.plexArtists(access, 0, 10, ""),
    () => upstream.plexLibraryIndex(access),
  ])
    await assert.rejects(call(), (error: Error) => error instanceof UpstreamError && error.status === 404 && /chosen in Settings → Server/.test(error.message));
  // Without a chosen library a 404 keeps Plex's own meaning.
  await assert.rejects(
    upstream.plexAlbum(access, "5"),
    (error: Error) => error instanceof UpstreamError && !/Settings/.test(error.message),
  );
});

test("album pages combine the album, its tracks, their stream details and the artist's MusicBrainz id", async () => {
  const { upstream, calls } = plex((call) => {
    const path = call.url.pathname;
    if (path === "/library/metadata/1457") return container({ Metadata: [album({ userRating: 9 })] });
    if (path === "/library/metadata/1457/children")
      return container({
        totalSize: 2,
        Metadata: [
          { ratingKey: "1458", type: "track", title: "Holy Ghost", index: 1, parentIndex: 1, duration: 191200, originalTitle: "A$AP Rocky feat. Joe Fox", grandparentTitle: "A$AP Rocky", parentRatingKey: "1457", parentTitle: "AT.LONG.LAST.A$AP", Media: [{ audioCodec: "flac", Part: [{ key: "/library/parts/1/2/file.flac" }] }] },
          { ratingKey: "1459", type: "track", title: "Canal St.", index: 2, parentIndex: 1, duration: 60000, grandparentTitle: "A$AP Rocky", userRating: 10 },
        ],
      });
    if (path === "/library/metadata/1458,1459")
      return container({
        Metadata: [
          { ratingKey: "1458", type: "track", Media: [{ Part: [{ key: "/library/parts/1/2/file.flac", Stream: [{ streamType: 2, codec: "flac", bitDepth: 24, samplingRate: 96000 }] }] }] },
        ],
      });
    if (path === "/library/metadata/1338") return container({ Metadata: [{ ratingKey: "1338", type: "artist", title: "A$AP Rocky", Guid: [{ id: `mbid://${artistMBID}` }] }] });
    return html(404);
  });
  const detail = await upstream.plexAlbum(access, "1457");
  assert.equal(detail.album.artistMBID, artistMBID);
  assert.equal(detail.album.favorite, false, "four and a half stars are not a favourite");
  assert.deepEqual(detail.tracks, [
    { id: "1458", title: "Holy Ghost", artist: "A$AP Rocky feat. Joe Fox", albumID: "1457", albumTitle: "AT.LONG.LAST.A$AP", disc: 1, number: 1, duration: 191.2, codec: "flac", sampleRate: 96000, bitDepth: 24, favorite: false, available: true },
    { id: "1459", title: "Canal St.", artist: "A$AP Rocky", albumID: null, albumTitle: null, disc: 1, number: 2, duration: 60, codec: null, sampleRate: null, bitDepth: null, favorite: true, available: true },
  ]);
  assert.equal(calls.find((call) => call.url.pathname.endsWith("/children"))?.url.searchParams.get("includeGuids"), "1");
  await assert.rejects(upstream.plexAlbum(access, "../1"), "ids are never put into paths unchecked");
});

test("a rejected token means signing in again; Plex's 404 means missing or not visible", async () => {
  const { upstream } = plex((call) => (call.url.pathname === "/library/sections/all" ? html(401) : html(404)));
  assert.equal(await upstream.plexTokenValid(access), false);
  await assert.rejects(upstream.plexSections(access), (error: Error) => error instanceof UpstreamError && error.code === "plex_reconnect" && error.status === 409);
  await assert.rejects(upstream.plexAlbum(access, "5"), (error: Error) => error instanceof UpstreamError && error.status === 404);
  const forbidden = plex(() => html(403)).upstream;
  await assert.rejects(forbidden.plexPlaylists(access), (error: Error) => error instanceof UpstreamError && error.status === 403);
});

test("the availability index reads every album's release and every artist's id, leaving out the trash", async () => {
  const { upstream, calls } = plex((call) => {
    const type = call.url.searchParams.get("type");
    if (type === "9")
      return container({
        totalSize: 3,
        Metadata: [
          album(),
          album({ ratingKey: "2", guid: "local://2", Guid: [] }),
          album({ ratingKey: "3", deletedAt: 1790000000 }),
        ],
      });
    return container({ totalSize: 1, Metadata: [{ ratingKey: "1338", type: "artist", title: "A$AP Rocky", Guid: [{ id: `mbid://${artistMBID}` }] }] });
  });
  const index = await upstream.plexLibraryIndex(access);
  assert.deepEqual(index.albums, [
    { id: "1457", title: "AT.LONG.LAST.A$AP", artist: "A$AP Rocky", artistID: "1338", releaseMBID: release },
    { id: "2", title: "AT.LONG.LAST.A$AP", artist: "A$AP Rocky", artistID: "1338", releaseMBID: null },
  ]);
  assert.deepEqual([...index.artistMBIDs], [["1338", artistMBID]]);
  assert.ok(calls.every((call) => call.url.searchParams.get("includeGuids") === "1"));
});

test("tracks are added to regular playlists only, by server URI in batches, and losses are reported", async () => {
  let leafCount = 10;
  const writes: URL[] = [];
  const { upstream } = plex((call) => {
    if (call.method === "PUT") {
      writes.push(call.url);
      leafCount += call.url.searchParams.get("uri")?.split("/").at(-1)?.split(",").length ?? 0;
      return new Response(null, { status: 200 });
    }
    const smart = call.url.pathname === "/playlists/8";
    return container({ Metadata: [{ ratingKey: smart ? "8" : "7", type: "playlist", playlistType: "audio", title: "Dinner", smart, leafCount }] });
  });
  const ids = Array.from({ length: 150 }, (_, index) => String(index + 1));
  await upstream.plexAddToPlaylist(access, "7", ids);
  assert.equal(writes.length, 2);
  assert.match(writes[0].searchParams.get("uri") ?? "", /^server:\/\/machine-1\/com\.plexapp\.plugins\.library\/library\/metadata\/1,2,3,/);
  await assert.rejects(upstream.plexAddToPlaylist(access, "8", ["1"]), (error: Error) => error instanceof UpstreamError && error.status === 409);
  const lossy = plex((call) =>
    call.method === "PUT" ? new Response(null, { status: 200 }) : container({ Metadata: [{ ratingKey: "7", type: "playlist", playlistType: "audio", smart: false, leafCount: 3 }] }),
  ).upstream;
  await assert.rejects(lossy.plexAddToPlaylist(access, "7", ["1", "2"]), /Plex added 0 of 2 tracks/);
});

test("a favourite is a five-star rating, and removing one never erases another rating", async () => {
  let rating: number | undefined = 6;
  const writes: URL[] = [];
  const { upstream } = plex((call) => {
    if (call.method === "PUT") {
      writes.push(call.url);
      return new Response(null, { status: 200 });
    }
    return container({ Metadata: [album({ userRating: rating ?? null })] });
  });
  await upstream.plexFavorite(access, "1457", false);
  assert.equal(writes.length, 0, "a three-star rating is left alone");
  await upstream.plexFavorite(access, "1457", true);
  assert.deepEqual(Object.fromEntries(writes[0].searchParams), { key: "1457", identifier: "com.plexapp.plugins.library", rating: "10" });
  assert.equal(writes[0].pathname, "/:/rate");
  rating = 10;
  await upstream.plexFavorite(access, "1457", false);
  assert.equal(writes[1].searchParams.get("rating"), "-1");
});

test("playback reports use Plex's timeline in whole milliseconds within the track, with the browser's session", async () => {
  const { upstream, calls } = plex((call) =>
    call.url.searchParams.get("state") === "stopped" ? container({ terminationCode: 2, terminationText: "Stopped by the owner." }) : container({}),
  );
  const session = { ...access, session: "leerr-browser" };
  assert.equal(await upstream.plexReport(session, { trackID: "1458", state: "playing", position: 0, durationMs: 191200 }), null);
  await upstream.plexReport(session, { trackID: "1458", state: "paused", position: 500, durationMs: 191200 });
  assert.equal(await upstream.plexReport(session, { trackID: "1458", state: "stopped", position: 12.3456, durationMs: 191200 }), "Stopped by the owner.");
  assert.deepEqual(
    calls.map((call) => [call.url.pathname, call.url.searchParams.get("state"), call.url.searchParams.get("time"), call.url.searchParams.get("duration")]),
    [
      ["/:/timeline", "playing", "1", "191200"],
      ["/:/timeline", "paused", "191200", "191200"],
      ["/:/timeline", "stopped", "12346", "191200"],
    ],
  );
  assert.equal(calls[0].url.searchParams.get("key"), "/library/metadata/1458");
  assert.equal(calls[0].headers.get("x-plex-session-identifier"), "leerr-browser");
});

test("tracks stream their own file with Range, and codecs browsers cannot play are converted to MP3", async () => {
  const { upstream, calls } = plex((call) => {
    const path = call.url.pathname;
    if (path === "/library/metadata/1458")
      return container({ Metadata: [{ ratingKey: "1458", type: "track", title: "Song", duration: 1000, Media: [{ audioCodec: "flac", Part: [{ key: "/library/parts/88/1790/file.flac" }] }] }] });
    if (path === "/library/metadata/1460")
      return container({ Metadata: [{ ratingKey: "1460", type: "track", title: "Apple", Media: [{ audioCodec: "alac", container: "mp4", duration: 2000, Part: [{ key: "/library/parts/89/1790/file.m4a" }] }] }] });
    if (path === "/library/metadata/1461")
      return container({ Metadata: [{ ratingKey: "1461", type: "track", title: "Odd", Media: [{ audioCodec: "flac", Part: [{ key: "http://elsewhere.test/file.flac" }] }] }] });
    if (path.startsWith("/library/parts/")) return new Response(new Uint8Array([1, 2]), { status: 206, headers: { "Content-Range": "bytes 10-11/12", "Content-Type": "audio/flac" } });
    if (path.endsWith("/decision")) return container({ generalDecisionCode: 1001 });
    if (path.endsWith("/start.mp3")) return new Response(new Uint8Array([0x49, 0x44, 0x33]), { status: 200, headers: { "Content-Type": "audio/mpeg" } });
    return html(404);
  });
  const flac = await upstream.plexTrack(access, "1458");
  assert.deepEqual([flac.transcode, flac.durationMs, flac.partKey], [false, 1000, "/library/parts/88/1790/file.flac"]);
  const response = await upstream.plexStream(access, flac, "bytes=10-20", '"etag"', new AbortController().signal);
  assert.equal(response.status, 206);
  const part = calls.find((call) => call.url.pathname.startsWith("/library/parts/"));
  assert.equal(part?.headers.get("range"), "bytes=10-20");
  assert.equal(part?.headers.get("if-range"), '"etag"');
  assert.equal(part?.headers.get("accept-encoding"), "identity");
  assert.equal(part?.url.searchParams.has("download"), false, "download mode is what 'Allow Downloads' blocks");
  const alac = await upstream.plexTrack(access, "1460");
  assert.deepEqual([alac.transcode, alac.durationMs], [true, 2000]);
  await upstream.plexTranscode(access, alac, 42.5, "leerr-conversion", new AbortController().signal);
  const start = calls.find((call) => call.url.pathname.endsWith("/start.mp3"));
  assert.ok(start);
  assert.equal(start.url.pathname, "/music/:/transcode/universal/start.mp3");
  assert.deepEqual(
    [start.url.searchParams.get("path"), start.url.searchParams.get("offset"), start.url.searchParams.get("session"), start.url.searchParams.get("protocol")],
    ["/library/metadata/1460", "42.5", "leerr-conversion", "http"],
  );
  assert.equal(start.headers.get("x-plex-client-profile-name"), "Generic");
  assert.match(start.headers.get("x-plex-client-profile-extra") ?? "", /container=mp3&audioCodec=mp3/);
  assert.ok(calls.some((call) => call.url.pathname === "/music/:/transcode/universal/decision"), "a decision is asked for first");
  await upstream.plexStopTranscode(access, "leerr-conversion");
  assert.equal(calls.at(-1)?.url.pathname, "/video/:/transcode/universal/stop");
  await assert.rejects(upstream.plexTrack(access, "1461"), "a part outside the server's own paths is never fetched");
});

test("artwork is resized by Plex from the item's own image path only", async () => {
  const { upstream, calls } = plex((call) => {
    const path = call.url.pathname;
    if (path === "/library/metadata/1457") return container({ Metadata: [album()] });
    if (path === "/library/metadata/1") return container({ Metadata: [album({ ratingKey: "1", thumb: "https://evil.test/x.jpg" })] });
    if (path === "/library/metadata/7") return html(404);
    if (path === "/playlists/7") return container({ Metadata: [{ ratingKey: "7", type: "playlist", playlistType: "audio", composite: "/playlists/7/composite/1790000000" }] });
    if (path === "/photo/:/transcode") return new Response(new Uint8Array([0xff, 0xd8]), { status: 200, headers: { "Content-Type": "image/jpeg" } });
    return html(404);
  });
  const art = await upstream.plexArtwork(access, "1457", "small");
  assert.equal(art.type, "image/jpeg");
  const resize = calls.find((call) => call.url.pathname === "/photo/:/transcode");
  assert.deepEqual(Object.fromEntries(resize?.url.searchParams ?? []), {
    width: "192",
    height: "192",
    minSize: "0",
    upscale: "0",
    url: "/library/metadata/1457/thumb/1790055576",
  });
  await assert.rejects(upstream.plexArtwork(access, "1", "small"), (error: Error) => error instanceof UpstreamError && error.status === 404);
  assert.equal((await upstream.plexArtwork(access, "7", "large")).type, "image/jpeg", "playlists use their composite image");
  assert.equal(calls.at(-1)?.url.searchParams.get("url"), "/playlists/7/composite/1790000000");
});

test("Plex sign-in: a strong PIN, the person's own client id, and the token for exactly this server", async () => {
  const { upstream, calls } = plex((call) => {
    const path = `${call.url.hostname}${call.url.pathname}`;
    if (path === "plex.tv/api/v2/pins") return json({ id: 4242, code: "abcdefghijklmnopqrstuvwxy", expiresAt: "2026-10-05T13:30:00Z", authToken: null }, 201);
    if (path === "plex.tv/api/v2/pins/4242") return json({ id: 4242, code: "abcdefghijklmnopqrstuvwxy", expiresAt: "2026-10-05T13:30:00Z", authToken: "account-token" });
    if (path === "plex.tv/api/v2/pins/4243") return json({ errors: [{ code: 1020 }] }, 404);
    if (path === "plex.tv/api/v2/user")
      return call.headers.get("x-plex-token") === "account-token"
        ? json({ id: 5, uuid: "u5", username: "max", title: "Max", restricted: false, home: true })
        : json({ error: "nope" }, 401);
    if (path === "clients.plex.tv/api/v2/resources")
      return json([
        { clientIdentifier: "other-machine", provides: "server", owned: false, accessToken: "other-token" },
        { clientIdentifier: "phone", provides: "client,player", owned: true, accessToken: "x" },
        { clientIdentifier: "machine-1", provides: "server", owned: false, accessToken: "shared-server-token" },
      ]);
    if (path === "plex.tv/api/v2/home/users")
      return json({ users: [{ uuid: "admin", title: "Max", restricted: false, admin: true }, { uuid: "kid", title: "Kid", restricted: true, protected: true }] });
    if (path === "plex.tv/api/v2/home/users/kid/switch")
      return call.url.searchParams.get("pin") === "1234" ? json({ authToken: "kid-token", restricted: true }, 201) : json({ error: "pin" }, 403);
    return json({}, 404);
  });
  const pin = await upstream.plexCreatePin("leerr-client", "Leerr (max)");
  assert.deepEqual(pin, { id: 4242, code: "abcdefghijklmnopqrstuvwxy", expiresAt: Date.parse("2026-10-05T13:30:00Z") });
  const create = calls[0];
  assert.equal(create.method, "POST");
  assert.equal(create.url.searchParams.get("strong"), "true");
  assert.equal(create.headers.get("x-plex-client-identifier"), "leerr-client");
  assert.equal(create.headers.get("x-plex-product"), "Leerr");
  assert.equal(create.headers.get("x-plex-device-name"), "Leerr (max)");
  assert.equal(await upstream.plexCheckPin("leerr-client", 4242), "account-token");
  await assert.rejects(upstream.plexCheckPin("leerr-client", 4243), (error: Error) => error instanceof UpstreamError && error.status === 410);
  assert.deepEqual(await upstream.plexAccount("leerr-client", "account-token"), { id: 5, uuid: "u5", username: "max", restricted: false, home: true });
  await assert.rejects(upstream.plexAccount("leerr-client", "revoked"), (error: Error) => error instanceof UpstreamError && error.code === "plex_reconnect");
  assert.equal(await upstream.plexServerToken("leerr-client", "account-token", "machine-1"), "shared-server-token");
  assert.equal(await upstream.plexServerToken("leerr-client", "account-token", "missing"), null);
  assert.deepEqual(await upstream.plexProfiles("leerr-client", "account-token"), [{ uuid: "kid", name: "Kid", protected: true }]);
  assert.equal(await upstream.plexSwitchProfile("leerr-client", "account-token", "kid", "1234"), "kid-token");
  await assert.rejects(upstream.plexSwitchProfile("leerr-client", "account-token", "kid", "0000"), /Check the profile's PIN/);
});

test("an owned server without its own access token uses the owner's account token; a shared one never does", async () => {
  const resources = (owned: boolean) =>
    plex(() => json([{ clientIdentifier: "machine-1", provides: "server", owned, accessToken: null }])).upstream;
  assert.equal(await resources(true).plexServerToken("c", "account-token", "machine-1"), "account-token");
  assert.equal(await resources(false).plexServerToken("c", "account-token", "machine-1"), null);
});

test("MusicBrainz names the release group of many releases per call, keyed by the id asked for", async () => {
  const merged = "77777777-7777-4777-8777-777777777777";
  const unknown = "88888888-8888-4888-8888-888888888888";
  const { upstream, calls } = plex((call) => {
    if (call.url.pathname === "/ws/2/release" && call.url.searchParams.has("query"))
      return json({ releases: [{ id: release, "release-group": { id: group } }, { id: "99999999-9999-4999-8999-999999999999", "release-group": { id: group } }] });
    if (call.url.pathname === `/ws/2/release/${merged}`) return json({ id: "12121212-1212-4212-8212-121212121212", "release-group": { id: group } });
    return json({ error: "Not Found" }, 404);
  });
  const found = await upstream.releaseGroupsOf([release.toUpperCase(), merged, unknown]);
  assert.deepEqual([...found].sort(), [[merged, group], [release, group], [unknown, null]].sort());
  assert.equal(calls[0].url.searchParams.get("query"), `reid:("${release}" OR "${merged}" OR "${unknown}")`);
});

test("odd MusicBrainz ids count as unmatched, AIFF is converted, trashed tracks never stream, and artist search keeps Plex's matches", async () => {
  const { upstream } = plex((call) => {
    const path = call.url.pathname;
    if (path === "/library/sections/3/all" && call.url.searchParams.get("type") === "9")
      return container({ totalSize: 2, Metadata: [album({ Guid: [{ id: "mbid://12345678-1234-0234-c234-123456789012" }] }), album({ ratingKey: "2" })] });
    if (path === "/library/sections/3/all" && call.url.searchParams.get("type") === "8")
      return container({ totalSize: 1, Metadata: [{ ratingKey: "9", type: "artist", title: "Tyler, The Creator" }] });
    const media = (audioCodec: string, format: string) => [{ audioCodec, container: format, Part: [{ key: `/library/parts/1/2/file.${format}` }] }];
    if (path === "/library/metadata/10") return container({ Metadata: [{ ratingKey: "10", type: "track", title: "A", Media: media("pcm", "aiff") }] });
    if (path === "/library/metadata/11") return container({ Metadata: [{ ratingKey: "11", type: "track", title: "W", Media: media("pcm", "wav") }] });
    if (path === "/library/metadata/12") return container({ Metadata: [{ ratingKey: "12", type: "track", title: "T", deletedAt: 1790000000, Media: media("flac", "flac") }] });
    return html(404);
  });
  const index = await upstream.plexLibraryIndex(access);
  assert.deepEqual(index.albums.map((entry) => entry.releaseMBID), [null, release], "a tag that is not a MusicBrainz id is no id");
  assert.equal((await upstream.plexTrack(access, "10")).transcode, true, "AIFF is PCM too, but only WAV plays in browsers");
  assert.equal((await upstream.plexTrack(access, "11")).transcode, false);
  await assert.rejects(upstream.plexTrack(access, "12"), /trash/);
  const artists = await upstream.plexArtists(access, 0, 10, "tyler the creator");
  assert.deepEqual([artists.items.map((artist) => artist.name), artists.total], [["Tyler, The Creator"], 1]);
});

test("MusicBrainz failing part-way keeps the releases already resolved", async () => {
  const { upstream } = plex((call) =>
    call.url.searchParams.has("query")
      ? json({ releases: [{ id: release, "release-group": { id: group } }] })
      : json({ error: "busy" }, 503),
  );
  const missing = "77777777-7777-4777-8777-777777777777";
  await assert.rejects(upstream.releaseGroupsOf([release, missing, "not-an-id"]), (error: Error) => {
    assert.ok(error instanceof PartialReleaseLookup);
    assert.deepEqual([...error.resolved].sort(), [["not-an-id", null], [release, group]].sort());
    return true;
  });
});
