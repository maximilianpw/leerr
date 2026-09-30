import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { LiveUpstreams, UpstreamError, validateEndpoint } from "../upstream/index.ts";
import type { JsonValue } from "../upstream/http.ts";
import { luceneTerms } from "../upstream/musicbrainz.ts";

const group = "11111111-1111-4111-8111-111111111111";
const release = "22222222-2222-4222-8222-222222222222";
const artist = "33333333-3333-4333-8333-333333333333";
const jellyfin = { endpoint: "https://j.test/base", token: "token", userID: "user" };
const lidarr = { endpoint: "https://lidarr.test", key: "synthetic-key" };
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), "utf8"));

const json = (body: JsonValue, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const urlOf = (input: string | URL | Request) => (input instanceof URL ? input : new URL(String(input)));

function rejectsWith(code: string, pattern?: RegExp) {
  return (error: Error) => {
    assert.ok(error instanceof UpstreamError, String(error));
    assert.equal(error.code, code);
    if (pattern) assert.match(error.message, pattern);
    assert.doesNotMatch(error.message, /private-response|synthetic-key/);
    return true;
  };
}

test("endpoints must be credential-free HTTPS URLs; subpaths are kept", () => {
  assert.equal(validateEndpoint(" https://media.example/base/ "), "https://media.example/base");
  for (const value of ["http://media.example", "https://a:b@media.example", "https://m.example?q=x", "https://m.example/#x", "nope"])
    assert.throws(() => validateEndpoint(value), UpstreamError);
});

test("Lucene terms are quoted so search text can never become query syntax", () => {
  assert.equal(luceneTerms(' AC/DC  "live" OR x\\ '), '"AC/DC" AND "\\"live\\"" AND "OR" AND "x\\\\"');
});

test("Jellyfin, Last.fm and Lidarr setup calls match their wire contracts", async () => {
  const seen: string[] = [];
  const upstream = new LiveUpstreams(async (input, init) => {
    const url = urlOf(input);
    seen.push(`${url.hostname}${url.pathname}`);
    assert.equal(init?.redirect, "manual");
    const headers = new Headers(init?.headers);
    if (url.hostname === "jellyfin.test") {
      assert.equal(init?.method, "POST");
      assert.deepEqual(JSON.parse(String(init?.body)), { Username: "u & é", Pw: "p & + é" });
      assert.match(headers.get("authorization") ?? "", /^MediaBrowser Client="Leerr"/);
      return json({ AccessToken: "t", User: { Id: "jf-user" } });
    }
    if (url.hostname === "ws.audioscrobbler.com") {
      assert.equal(url.searchParams.get("method"), "user.getInfo");
      assert.equal(url.searchParams.get("api_key"), "k&y");
      assert.equal(url.searchParams.get("user"), "u & é");
      return json({ user: { name: "u & é" } });
    }
    assert.equal(headers.get("x-api-key"), "synthetic-key");
    if (url.pathname === "/api/v1/rootfolder") return json([{ id: 7, path: "/music", freeSpace: null }]);
    return json([{ id: url.pathname.endsWith("qualityprofile") ? 3 : 9, name: "Profile" }]);
  });
  assert.deepEqual(await upstream.jellyfinLogin("https://jellyfin.test", "u & é", "p & + é"), { token: "t", userID: "jf-user" });
  await upstream.lastfmCheck({ username: "u & é", apiKey: "k&y" });
  assert.deepEqual(await upstream.lidarrOptions(lidarr), {
    roots: [{ id: 7, path: "/music" }],
    qualities: [{ id: 3, name: "Profile" }],
    metadata: [{ id: 9, name: "Profile" }],
  });
  assert.equal(seen.length, 5);
});

test("errors keep useful diagnostics but never echo response bodies or keys", async () => {
  for (const status of [401, 403])
    await assert.rejects(
      new LiveUpstreams(async () => json({ message: "private-response" }, status)).jellyfinLogin("https://j.test", "u", "p"),
      rejectsWith("upstream_auth", new RegExp(`HTTP ${status}`)),
    );
  for (const status of [200, 400, 403])
    for (const code of [6, 10, 26])
      await assert.rejects(
        new LiveUpstreams(async () => json({ error: code, message: "private-response" }, status)).lastfmCheck({
          username: "u",
          apiKey: "synthetic-key",
        }),
        (error: Error) => {
          assert.match(error.message, new RegExp(`Last.fm error ${code}`));
          assert.doesNotMatch(error.message, /private-response|synthetic-key/);
          return true;
        },
      );
  await assert.rejects(
    new LiveUpstreams(async (input) =>
      urlOf(input).pathname.endsWith("rootfolder") ? json([{ id: 1, path: "/music" }]) : json({ unexpected: "private-response" }),
    ).lidarrOptions(lidarr),
    rejectsWith("upstream_protocol", /Lidarr (qualityprofile|metadataprofile):/),
  );
});

test("transport failures say whether a request could have reached the service", async () => {
  const refused = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  await assert.rejects(
    new LiveUpstreams(async () => {
      throw refused;
    }).lidarrSearch(lidarr, 1),
    (error: Error) => error instanceof UpstreamError && error.outcome === "not_applied",
  );
  await assert.rejects(
    new LiveUpstreams(async () => json({}, 502)).lidarrSearch(lidarr, 1),
    (error: Error) => error instanceof UpstreamError && error.outcome === "unknown",
  );
  await assert.rejects(
    new LiveUpstreams(async () => json({}, 400)).lidarrSearch(lidarr, 1),
    (error: Error) => error instanceof UpstreamError && error.outcome === "not_applied",
  );
});

test("oversized or non-JSON responses fail closed", async () => {
  await assert.rejects(
    new LiveUpstreams(async () => new Response("x".repeat(2_000_001))).jellyfinLibrary(jellyfin, 0, 10),
    rejectsWith("upstream_protocol", /oversized/),
  );
  await assert.rejects(
    new LiveUpstreams(async () => new Response("<html>login</html>")).jellyfinLibrary(jellyfin, 0, 10),
    rejectsWith("upstream_protocol", /valid JSON/),
  );
  await assert.rejects(
    new LiveUpstreams(async () => new Response(null, { status: 302, headers: { location: "https://evil.test" } })).lidarrOptions(lidarr),
    rejectsWith("upstream_protocol", /redirected/),
  );
});

test("streams authorise the track for the user first, then forward Range and If-Range", async () => {
  const calls: string[] = [];
  const upstream = new LiveUpstreams(async (input, init) => {
    const url = urlOf(input);
    calls.push(url.pathname);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), 'MediaBrowser Token="token"');
    if (calls.length === 1) return json({ Id: "track", Name: "Song", Type: "Audio" });
    assert.equal(headers.get("range"), "bytes=10-20");
    assert.equal(headers.get("if-range"), '"etag"');
    assert.equal(headers.get("accept-encoding"), "identity");
    return new Response(new Uint8Array([1, 2]), { status: 206, headers: { "Content-Range": "bytes 10-11/12" } });
  });
  const response = await upstream.jellyfinStream(jellyfin, "track", "bytes=10-20", '"etag"', new AbortController().signal);
  assert.equal(response.status, 206);
  assert.deepEqual(calls, ["/base/Users/user/Items/track", "/base/Audio/track/stream"]);
  let count = 0;
  const denied = new LiveUpstreams(async () => (++count === 1 ? json({ Id: "album", Name: "Album", Type: "MusicAlbum" }) : json({})));
  await assert.rejects(denied.jellyfinStream(jellyfin, "album", undefined, undefined, new AbortController().signal), UpstreamError);
  assert.equal(count, 1, "no audio request is made for a non-track item");
});

test("Jellyfin albums are mapped with release identities, tracks and source quality", async () => {
  const upstream = new LiveUpstreams(async (input) => {
    const url = urlOf(input);
    if (url.pathname.endsWith("/Items/album"))
      return json({
        Id: "album",
        Name: "Album",
        Type: "MusicAlbum",
        AlbumArtist: "Artist",
        ProductionYear: 2020,
        ProviderIds: { MusicBrainzReleaseGroup: group.toUpperCase(), MusicBrainzAlbum: "not-a-uuid" },
      });
    assert.equal(url.searchParams.get("parentId"), "album");
    return json({
      Items: [
        {
          Id: "t1",
          Name: "One",
          Type: "Audio",
          IndexNumber: 1,
          ParentIndexNumber: 1,
          RunTimeTicks: 1_800_000_000,
          MediaStreams: [{ Type: "Audio", Codec: "flac", SampleRate: 96_000, BitDepth: 24 }],
        },
      ],
      TotalRecordCount: 1,
    });
  });
  const detail = await upstream.jellyfinAlbum(jellyfin, "album");
  assert.deepEqual(detail.album, {
    id: "album",
    title: "Album",
    artist: "Artist",
    year: 2020,
    releaseGroupMBID: group,
    releaseMBID: null,
  });
  assert.deepEqual(detail.tracks[0], {
    id: "t1",
    title: "One",
    artist: "",
    disc: 1,
    number: 1,
    duration: 180,
    codec: "flac",
    sampleRate: 96_000,
    bitDepth: 24,
  });
});

test("Lidarr add payloads monitor one edition and never the whole artist", async () => {
  const upstream = new LiveUpstreams(async (input) => {
    const url = urlOf(input);
    if (url.pathname === "/api/v1/rootfolder") return json([{ id: 1, path: "/music" }]);
    if (url.pathname.endsWith("profile")) return json([{ id: 1, name: "P" }]);
    assert.equal(url.searchParams.get("term"), `lidarr:${group}`);
    return json([
      {
        foreignAlbumId: group,
        artist: { foreignArtistId: artist, artistName: "A" },
        releases: [
          { foreignReleaseId: release, monitored: false },
          { foreignReleaseId: "44444444-4444-4444-8444-444444444444", monitored: true },
        ],
      },
    ]);
  });
  const candidate = await upstream.lidarrLookup(
    lidarr,
    { releaseGroupMBID: group, releaseMBID: release, artistMBID: artist, title: "T", artist: "A" },
    { rootFolderPath: "/music", qualityProfileID: 1, metadataProfileID: 1 },
  );
  assert.deepEqual(
    candidate.releases.map((value) => value.monitored),
    [true, false],
  );
  assert.equal(candidate.anyReleaseOk, false);
  assert.deepEqual(candidate.artist.addOptions, { monitor: "none", albumsToMonitor: [], searchForMissingAlbums: false });
  assert.equal(candidate.artist.monitored, false);
  await assert.rejects(
    upstream.lidarrLookup(
      lidarr,
      { releaseGroupMBID: group, releaseMBID: release, artistMBID: artist, title: "T", artist: "A" },
      { rootFolderPath: "/elsewhere", qualityProfileID: 1, metadataProfileID: 1 },
    ),
    rejectsWith("upstream_rejected", /settings are incomplete/),
  );
});

test("Lidarr album state counts any complete edition as imported and finds only newer searches", async () => {
  const upstream = new LiveUpstreams(async (input) => {
    const url = urlOf(input);
    if (url.pathname === "/api/v1/command")
      return json([
        { id: 4, name: "AlbumSearch", status: "failed", body: { albumIds: [9] } },
        { id: 6, name: "AlbumSearch", status: "started", body: { albumIds: [9] } },
        { id: 8, name: "RefreshArtist", status: "completed", body: {} },
      ]);
    return json([
      { id: 9, foreignAlbumId: group, monitored: true, releases: [], statistics: { trackCount: 10, trackFileCount: 10 } },
      { id: 10, foreignAlbumId: "44444444-4444-4444-8444-444444444444", monitored: true, releases: [] },
    ]);
  });
  const album = await upstream.lidarrAlbum(lidarr, group);
  assert.deepEqual([album?.id, album?.imported, album?.monitored], [9, true, true]);
  assert.deepEqual(await upstream.lidarrLatestSearch(lidarr, 9, 0), { id: 6, status: "started" });
  assert.equal(await upstream.lidarrLatestSearch(lidarr, 9, 6), null);
  assert.equal(await upstream.lidarrLatestCommandID(lidarr), 8);
});

test("MusicBrainz identity must link group, edition and artist authoritatively", async () => {
  const upstream = (releaseGroup: string) =>
    new LiveUpstreams(async (input) =>
      urlOf(input).pathname.includes("release-group/")
        ? json({ id: group, title: "Album", "artist-credit": [{ artist: { id: artist, name: "Artist" } }] })
        : json({
            id: release,
            title: "Edition",
            "release-group": { id: releaseGroup },
            "artist-credit": [{ artist: { id: artist, name: "Artist" } }],
          }),
    );
  assert.deepEqual(await upstream(group).identity(group, release, artist), {
    artistMBID: artist,
    releaseGroupMBID: group,
    releaseMBID: release,
    title: "Album",
    artist: "Artist",
  });
  await assert.rejects(upstream("44444444-4444-4444-8444-444444444444").identity(group, release, artist), UpstreamError);
});

test("search separates artists and albums, escapes terms and only takes covers from Last.fm's CDN", async () => {
  const cover = "https://lastfm-img.freetls.fastly.net/i/u/500x500/8c6af1315c66631bad022085c7992b34.jpg";
  const queries: string[] = [];
  let hostile = false;
  const upstream = new LiveUpstreams(async (input) => {
    const url = urlOf(input);
    if (url.hostname === "musicbrainz.org") {
      queries.push(url.searchParams.get("query") ?? "");
      return json(url.pathname.endsWith("/artist") ? { artists: [] } : fixture("search-pablo"));
    }
    return json({
      results: {
        albummatches: {
          album: [
            { name: "The Life of Pablo", artist: "Someone else", image: [{ size: "large", "#text": cover }] },
            {
              name: "The Life of Pablo",
              artist: "Kanye West",
              image: [{ size: "large", "#text": hostile ? "https://attacker.test/i.jpg" : cover }],
            },
          ],
        },
      },
    });
  });
  const result = await upstream.search('life of "pablo', "lastfm-key");
  assert.equal(queries[0], 'releasegroup:("life" AND "of" AND "\\"pablo") AND primarytype:album');
  const pablo = result.items.find((item) => item.title === "The Life of Pablo");
  assert.ok(pablo);
  assert.equal(pablo.id, "8c18657a-6338-490d-a952-897663596b96");
  assert.equal(pablo.year, "2016");
  assert.equal(pablo.coverUrl, cover);
  hostile = true;
  const again = await upstream.search("pablo", "lastfm-key");
  assert.equal(again.items.find((item) => item.title === "The Life of Pablo")?.coverUrl, null);
});
