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
const libraryQuery = { offset: 0, limit: 10, q: "", sort: "title", artistID: null, favorites: false } as const;
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
      assert.match(headers.get("authorization") ?? "", /^MediaBrowser Client="Leerr",.*DeviceId="leerr-device"/);
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
  assert.deepEqual(await upstream.jellyfinLogin("https://jellyfin.test", "u & é", "p & + é", "leerr-device"), { token: "t", userID: "jf-user" });
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
      new LiveUpstreams(async () => json({ message: "private-response" }, status)).jellyfinLogin("https://j.test", "u", "p", "d"),
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
  // A private CA's chain without its root: the usual NODE_EXTRA_CA_CERTS mistake.
  for (const code of ["UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "CERT_UNTRUSTED", "ERR_TLS_CERT_ALTNAME_INVALID"])
    await assert.rejects(
      new LiveUpstreams(async () => {
        throw Object.assign(new TypeError("fetch failed"), { cause: { code } });
      }).lidarrSearch(lidarr, 1),
      (error: Error) =>
        error instanceof UpstreamError &&
        error.outcome === "not_applied" &&
        error.message.includes(`could not be reached (${code})`) &&
        error.message.includes("NODE_EXTRA_CA_CERTS"),
    );
  await assert.rejects(
    new LiveUpstreams(async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
    }).lidarrSearch(lidarr, 1),
    (error: Error) => error instanceof UpstreamError && error.outcome === "unknown" && /did not respond in time/.test(error.message),
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
    new LiveUpstreams(async () => new Response("x".repeat(2_000_001))).jellyfinLibrary(jellyfin, libraryQuery),
    rejectsWith("upstream_protocol", /oversized/),
  );
  await assert.rejects(
    new LiveUpstreams(async () => new Response("<html>login</html>")).jellyfinLibrary(jellyfin, libraryQuery),
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
  assert.deepEqual(calls, ["/base/Items/track", "/base/Audio/track/stream"]);
  let count = 0;
  const denied = new LiveUpstreams(async () => (++count === 1 ? json({ Id: "album", Name: "Album", Type: "MusicAlbum" }) : json({})));
  await assert.rejects(denied.jellyfinStream(jellyfin, "album", undefined, undefined, new AbortController().signal), UpstreamError);
  assert.equal(count, 1, "no audio request is made for a non-track item");
});

test("Jellyfin albums are mapped with release identities, tracks and source quality", async () => {
  const upstream = new LiveUpstreams(async (input) => {
    const url = urlOf(input);
    if (url.pathname.endsWith("/Items/album")) {
      assert.equal(url.searchParams.get("userId"), "user", "items are always read as the user");
      return json({
        Id: "album",
        Name: "Album",
        Type: "MusicAlbum",
        AlbumArtist: "Various Artists",
        AlbumArtists: [{ Name: "Various Artists", Id: "va" }],
        Artists: ["One", "Two"],
        ProductionYear: 2020,
        ImageTags: { Primary: "tag" },
        UserData: { IsFavorite: true },
        ProviderIds: {
          MusicBrainzReleaseGroup: group.toUpperCase(),
          MusicBrainzAlbum: "not-a-uuid",
          MusicBrainzAlbumArtist: artist,
        },
      });
    }
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
    artist: "Various Artists",
    artistID: "va",
    artistMBID: artist,
    year: 2020,
    releaseGroupMBID: group,
    releaseMBID: null,
    hasArtwork: true,
    favorite: true,
  });
  assert.deepEqual(detail.tracks[0], {
    id: "t1",
    title: "One",
    artist: "",
    albumID: null,
    albumTitle: null,
    disc: 1,
    number: 1,
    duration: 180,
    codec: "flac",
    sampleRate: 96_000,
    bitDepth: 24,
    favorite: false,
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
  // Lidarr picks its own edition after an add; the worker pins the requested one afterwards.
  assert.equal(candidate.anyReleaseOk, true);
  // An empty list would make Lidarr unmonitor this very album after its first scan.
  assert.deepEqual(candidate.artist.addOptions, { monitor: "none", albumsToMonitor: [group], searchForMissingAlbums: false });
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
      {
        id: 9,
        artistId: 2,
        foreignAlbumId: group,
        monitored: true,
        anyReleaseOk: false,
        releases: [{ foreignReleaseId: release.toUpperCase(), monitored: true }],
        statistics: { trackCount: 10, totalTrackCount: 10, trackFileCount: 10 },
      },
      { id: 10, foreignAlbumId: "44444444-4444-4444-8444-444444444444", monitored: true, releases: [] },
    ]);
  });
  const album = await upstream.lidarrAlbum(lidarr, group);
  assert.deepEqual([album?.id, album?.imported, album?.monitored, album?.artistID], [9, true, true, 2]);
  assert.deepEqual(album?.releases, [{ id: release, monitored: true }]);
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

test("Jellyfin user calls send the sort, filter, size and playback contracts, and a 401 means reconnect", async () => {
  const seen: Array<{ method: string; path: string; query: URLSearchParams; body: string | null }> = [];
  let status = 200;
  const upstream = new LiveUpstreams(async (input, init) => {
    const url = urlOf(input);
    seen.push({ method: init?.method ?? "GET", path: url.pathname, query: url.searchParams, body: init?.body ? String(init.body) : null });
    if (status !== 200) return json({}, status);
    if (url.pathname.endsWith("/Images/Primary")) return new Response(new Uint8Array([1]), { headers: { "content-type": "image/webp" } });
    if (url.pathname.startsWith("/base/Sessions") || url.pathname.startsWith("/base/UserFavoriteItems") || url.pathname.endsWith("/Items") && init?.method === "POST")
      return new Response(null, { status: 204 });
    if (url.pathname === "/base/Items" && url.searchParams.get("includeItemTypes") === "MusicAlbum") return json({ Items: [], TotalRecordCount: 60 });
    return json({ Id: url.pathname.split("/").at(-1) ?? "", Name: "Thing", Type: "MusicAlbum" });
  });
  await upstream.jellyfinLibrary(jellyfin, { offset: 60, limit: 60, q: "blue", sort: "added", artistID: "artist-1", favorites: true });
  const library = seen.at(-1);
  assert.equal(library?.query.get("sortBy"), "DateCreated,SortName");
  assert.equal(library?.query.get("sortOrder"), "Descending,Ascending");
  assert.equal(library?.query.get("albumArtistIds"), "artist-1");
  assert.equal(library?.query.get("isFavorite"), "true");
  assert.equal(library?.query.get("searchTerm"), "blue");
  assert.equal(library?.query.get("startIndex"), "60");
  const art = await upstream.jellyfinArtwork(jellyfin, "album", "small");
  assert.equal(art.type, "image/webp");
  assert.deepEqual([seen.at(-1)?.query.get("maxWidth"), seen.at(-1)?.query.get("maxHeight")], ["192", "192"]);
  await upstream.jellyfinReport(jellyfin, "progress", "track", 12.5, true);
  assert.equal(seen.at(-1)?.path, "/base/Sessions/Playing/Progress");
  assert.deepEqual(JSON.parse(seen.at(-1)?.body ?? "{}"), {
    ItemId: "track",
    PositionTicks: 125_000_000,
    IsPaused: true,
    CanSeek: true,
    PlayMethod: "DirectPlay",
  });
  await upstream.jellyfinFavorite(jellyfin, "album", false);
  assert.deepEqual([seen.at(-1)?.method, seen.at(-1)?.path, seen.at(-1)?.query.get("userId")], ["DELETE", "/base/UserFavoriteItems/album", "user"]);
  status = 401;
  await assert.rejects(upstream.jellyfinLibrary(jellyfin, libraryQuery), rejectsWith("jellyfin_reconnect", /Reconnect Jellyfin/));
  assert.equal(await upstream.jellyfinTokenValid(jellyfin), false);
  await assert.rejects(upstream.jellyfinLogin("https://j.test", "u", "p", "d"), rejectsWith("upstream_auth"), "a 401 at sign-in is a wrong password");
  status = 404;
  await assert.rejects(upstream.jellyfinArtwork(jellyfin, "album", "large"), (error: Error) => error instanceof UpstreamError && error.status === 404);
});

test("Lidarr albums count every track of the monitored edition, and commands, refreshes and downloads are read", async () => {
  const responses = new Map<string, () => Response>([
    ["/api/v1/album", () => json([{ id: 9, artistId: 2, foreignAlbumId: group, monitored: false, releases: [], statistics: { trackCount: 2, totalTrackCount: 12, trackFileCount: 2 } }])],
    ["/api/v1/command/7", () => json({ id: 7, name: "AlbumSearch", status: "orphaned" })],
    ["/api/v1/command/8", () => json({ message: "NotFound" }, 404)],
    ["/api/v1/command", () => json([{ id: 3, name: "RefreshArtist", status: "started", body: { artistId: 2 } }])],
    [
      "/api/v1/queue/details",
      () =>
        json([
          { status: "downloading", trackedDownloadStatus: "ok", trackedDownloadState: "downloading" },
          { status: "completed", trackedDownloadStatus: "warning", trackedDownloadState: "importBlocked", statusMessages: [{ title: "x", messages: ["No files found are eligible for import"] }] },
        ]),
    ],
    ["/api/v1/system/status", () => json({ version: "3.1.0.4875" })],
  ]);
  const queries: URLSearchParams[] = [];
  const upstream = new LiveUpstreams(async (input) => {
    const url = urlOf(input);
    queries.push(url.searchParams);
    return responses.get(url.pathname)?.() ?? json({}, 500);
  });
  const album = await upstream.lidarrAlbum(lidarr, group);
  assert.ok(album);
  assert.equal(album.imported, false, "2 of 12 tracks is not imported, even for an unmonitored album");
  assert.deepEqual(await upstream.lidarrCommand(lidarr, 7), { id: 7, status: "orphaned" });
  assert.equal(await upstream.lidarrCommand(lidarr, 8), null);
  assert.equal(await upstream.lidarrRefreshing(lidarr, album), true);
  assert.equal(await upstream.lidarrRefreshing(lidarr, { ...album, id: 99, artistID: 98 }), false);
  assert.deepEqual(await upstream.lidarrDownloads(lidarr, 9), [
    { state: "active", detail: "downloading" },
    { state: "problem", detail: "No files found are eligible for import" },
  ]);
  assert.equal(queries.at(-1)?.get("albumIds"), "9");
  assert.equal(await upstream.lidarrVersion(lidarr), "3.1.0.4875");
});

test("MusicBrainz editions are paged with their status, and credits keep their join phrases", async () => {
  const offsets: string[] = [];
  const credit = [
    { name: "Greenhouse Effect", joinphrase: " vs. ", artist: { id: artist, name: "Greenhouse Effect" } },
    { name: "Radiohead", joinphrase: "", artist: { id: "44444444-4444-4444-8444-444444444444", name: "Radiohead" } },
  ];
  const upstream = new LiveUpstreams(async (input) => {
    const url = urlOf(input);
    if (url.pathname.endsWith("/release")) {
      const offset = Number(url.searchParams.get("offset"));
      offsets.push(String(offset));
      const count = offset === 0 ? 100 : 20;
      return json({
        "release-count": 120,
        releases: Array.from({ length: count }, (_, index) => ({
          id: `${String(offset + index).padStart(8, "0")}-2222-4222-8222-222222222222`,
          title: "Album",
          status: offset + index === 0 ? "Bootleg" : "Official",
          disambiguation: offset + index === 1 ? "2017 remaster" : "",
          date: `20${String(10 + ((offset + index) % 10))}-01-01`,
          "artist-credit": credit,
        })),
      });
    }
    if (url.pathname.includes("/release-group/"))
      return json({ id: group, title: "Split", "artist-credit": credit });
    return json({ id: release, title: "Split", "release-group": { id: group }, "artist-credit": credit });
  });
  const editions = await upstream.editions(group);
  assert.deepEqual(offsets, ["0", "100"]);
  assert.equal(editions.total, 120);
  assert.equal(editions.items.length, 120);
  assert.equal(editions.items.find((edition) => edition.id.startsWith("00000000"))?.status, "Bootleg");
  assert.equal(editions.items.find((edition) => edition.id.startsWith("00000001"))?.disambiguation, "2017 remaster");
  assert.equal((await upstream.identity(group, release, artist)).artist, "Greenhouse Effect vs. Radiohead");
});

test("discographies filter by type and come back in release order; new releases ask for the user's artists", async () => {
  const queries: string[] = [];
  const upstream = new LiveUpstreams(async (input) => {
    const url = urlOf(input);
    queries.push(url.searchParams.get("query") ?? "");
    return json({
      count: 2,
      "release-groups": [
        { id: group, title: "Later", "first-release-date": "2016-05-08", "primary-type": "Album", "artist-credit": [{ artist: { id: artist, name: "A" } }] },
        { id: "44444444-4444-4444-8444-444444444444", title: "Earlier", "first-release-date": "1993-02-22", "primary-type": "Album", "secondary-types": [], "artist-credit": [{ artist: { id: artist, name: "A" } }] },
      ],
    });
  });
  const studio = await upstream.artistAlbums(artist, 0, "studio", null);
  assert.deepEqual(studio.items.map((item) => item.title), ["Earlier", "Later"]);
  assert.match(queries.at(-1) ?? "", new RegExp(`^arid:${artist} AND primarytype:album AND NOT secondarytype:\\(compilation OR live`));
  await upstream.artistAlbums(artist, 0, "ep", null);
  assert.equal(queries.at(-1), `arid:${artist} AND primarytype:ep`);
  const recent = await upstream.newReleases([artist, group], "2026-06-02");
  assert.match(queries.at(-1) ?? "", new RegExp(`^\\(arid:${artist} OR arid:${group}\\) AND primarytype:album AND NOT .* AND firstreleasedate:\\[2026-06-02 TO \\*\\]$`));
  assert.deepEqual(recent.map((item) => item.title), ["Later", "Earlier"], "newest first");
});

test("suggestions look only for Last.fm's top titles and survive one artist failing", async () => {
  const queries: string[] = [];
  const upstream = new LiveUpstreams(async (input) => {
    const url = urlOf(input);
    if (url.hostname === "musicbrainz.org") {
      queries.push(url.searchParams.get("query") ?? "");
      return json({
        count: 1,
        "release-groups": [{ id: group, title: "OK Computer", "artist-credit": [{ name: "Radiohead", artist: { id: artist, name: "Radiohead" } }] }],
      });
    }
    const method = url.searchParams.get("method");
    if (method === "artist.getSimilar")
      return url.searchParams.get("artist") === "Broken"
        ? json({ error: 29, message: "Rate limit" })
        : json({ similarartists: { artist: [{ name: "Radiohead" }] } });
    if (method === "artist.getTopAlbums")
      return json({ topalbums: { album: [{ name: "OK Computer (Remastered)", image: [] }, { name: "(null)", image: [] }] } });
    return json({});
  });
  const items = await upstream.recommendations({ source: "library", artists: ["Broken", "Portishead"], apiKey: "k" });
  assert.deepEqual(items.map((item) => item.title), ["OK Computer"]);
  assert.equal(queries.length, 1);
  assert.match(queries[0], /^artist:\("Radiohead"\) AND primarytype:album AND \(releasegroup:\("OK" AND "Computer"\)\)/);
});

test("the MusicBrainz rate limit does not stall when the wall clock steps backwards", async () => {
  const upstream = new LiveUpstreams(async () => json({ "release-groups": [], count: 0, artists: [] }));
  const realNow = Date.now;
  try {
    await upstream.search("first", null);
    Date.now = () => realNow() - 3_600_000;
    await upstream.search("second", null);
  } finally {
    Date.now = realNow;
  }
});

test("notifications speak each target's format and keep tokens away from Discord", async () => {
  const sent: Array<{ url: URL; headers: Headers; body: string }> = [];
  const upstream = new LiveUpstreams(async (input, init) => {
    sent.push({ url: urlOf(input), headers: new Headers(init?.headers), body: String(init?.body) });
    return new Response(null, { status: 200 });
  });
  const notification = {
    event: "imported" as const,
    title: "Ænima by Tool is ready",
    message: "Lidarr imported it.",
    album: { title: "Ænima", artist: "Tool" },
    requesters: ["alice"],
  };
  await upstream.notify({ url: "https://ntfy.example/leerr", format: "ntfy", token: "tk_1" }, notification);
  assert.equal(sent[0].url.searchParams.get("title"), "Ænima by Tool is ready", "non-ASCII titles travel in the query");
  assert.equal(sent[0].headers.get("authorization"), "Bearer tk_1");
  assert.equal(sent[0].body, "Lidarr imported it.");
  await upstream.notify({ url: "https://discord.example/api/webhooks/1/x", format: "discord", token: "tk_1" }, notification);
  assert.equal(sent[1].headers.get("authorization"), null);
  assert.deepEqual(JSON.parse(sent[1].body), { content: "**Ænima by Tool is ready**\nLidarr imported it.", allowed_mentions: { parse: [] } });
  await upstream.notify({ url: "https://hooks.example/leerr", format: "json", token: "" }, notification);
  assert.deepEqual(JSON.parse(sent[2].body), { source: "leerr", ...notification });
  await assert.rejects(
    new LiveUpstreams(async () => new Response(null, { status: 302, headers: { location: "https://evil.test" } })).notify(
      { url: "https://hooks.example/x", format: "json", token: "" },
      notification,
    ),
    rejectsWith("upstream_protocol", /redirected/),
  );
});

test("Lidarr's own failure states are problems; a stalled client is only stalled", async () => {
  const upstream = new LiveUpstreams(async () =>
    json([
      { status: "completed", trackedDownloadStatus: "warning", trackedDownloadState: "downloadFailedPending" },
      { status: "failed", trackedDownloadStatus: "error", trackedDownloadState: "downloadFailed" },
      { status: "warning", trackedDownloadStatus: "ok", trackedDownloadState: "downloading", errorMessage: "The download is stalled with no connections" },
      { status: "downloading", trackedDownloadStatus: "ok", trackedDownloadState: "downloading" },
    ]),
  );
  assert.deepEqual(
    (await upstream.lidarrDownloads(lidarr, 9)).map((download) => download.state),
    ["problem", "problem", "stalled", "active"],
  );
});

test("Lidarr refreshes are recognised in the shapes current Lidarr sends", async () => {
  const album = { id: 9, artistID: 2, monitored: true, anyReleaseOk: false, imported: false, releases: [], resource: { foreignAlbumId: group, releases: [] } };
  const check = async (commands: JsonValue) => new LiveUpstreams(async () => json(commands)).lidarrRefreshing(lidarr, album);
  assert.equal(await check([{ id: 1, name: "RefreshArtist", status: "started", body: { artistIds: [2], isNewArtist: true } }]), true);
  assert.equal(await check([{ id: 1, name: "RefreshArtist", status: "started", body: { artistIds: [98] } }]), false);
  assert.equal(await check([{ id: 1, name: "RefreshAlbum", status: "queued", body: { albumId: 9, isNewAlbum: true } }]), true);
  assert.equal(await check([{ id: 1, name: "RefreshAlbum", status: "queued", body: { albumId: 99 } }]), false);
  assert.equal(await check([{ id: 1, name: "RefreshArtist", status: "started", body: { artistIds: [] } }]), true, "an unscoped refresh covers everyone");
  assert.equal(await check([{ id: 1, name: "RefreshArtist", status: "completed", body: { artistIds: [2] } }]), false);
});

test("playlists page past non-audio entries, and tracks are added in batches", async () => {
  const requests: URL[] = [];
  const upstream = new LiveUpstreams(async (input, init) => {
    const url = urlOf(input);
    requests.push(url);
    if (url.pathname === "/base/Items/list") return json({ Id: "list", Name: "Mixed", Type: "Playlist" });
    if (init?.method === "POST") return new Response(null, { status: 204 });
    const start = Number(url.searchParams.get("startIndex"));
    assert.equal(url.searchParams.get("fields"), "MediaStreams");
    assert.equal(url.searchParams.get("limit"), "200");
    // Three items in all: an audiobook between two tracks.
    const all = [
      { Id: "a1", Name: "One", Type: "Audio" },
      { Id: "b1", Name: "Book", Type: "AudioBook" },
      { Id: "a2", Name: "Two", Type: "Audio" },
    ];
    return json({ Items: all.slice(start, start + 2), TotalRecordCount: 3 });
  });
  const detail = await upstream.jellyfinPlaylist(jellyfin, "list");
  assert.deepEqual(detail.tracks.map((track) => track.id), ["a1", "a2"]);
  const ids = Array.from({ length: 250 }, (_, index) => `track${index}`);
  requests.length = 0;
  await upstream.jellyfinAddToPlaylist(jellyfin, "list", ids);
  const posts = requests.filter((url) => url.pathname.endsWith("/Items") && url.searchParams.has("ids"));
  assert.deepEqual(posts.map((url) => url.searchParams.get("ids")?.split(",").length), [100, 100, 50]);
});

test("Jellyfin's empty-body 401 means the saved sign-in no longer works", async () => {
  const upstream = new LiveUpstreams(async () => new Response(null, { status: 401 }));
  await assert.rejects(upstream.jellyfinLibrary(jellyfin, libraryQuery), rejectsWith("jellyfin_reconnect"));
  assert.equal(await upstream.jellyfinTokenValid(jellyfin), false);
});
