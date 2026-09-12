import assert from "node:assert/strict";
import test from "node:test";
import { UpstreamError, Upstreams, validateEndpoint } from "./upstream.ts";

const group = "11111111-1111-4111-8111-111111111111";
const release = "22222222-2222-4222-8222-222222222222";
const artist = "33333333-3333-4333-8333-333333333333";

function json<T>(body: T, status = 200, extra: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extra },
  });
}

test("validateEndpoint requires a credential-free HTTPS origin and retains subpaths", () => {
  assert.equal(
    validateEndpoint("https://media.example/base/"),
    "https://media.example/base",
  );
  for (const value of [
    "http://media.example",
    "https://a:b@media.example",
    "https://media.example?q=x",
    "https://media.example/#x",
  ]) {
    assert.throws(() => validateEndpoint(value), UpstreamError);
  }
});

test("Jellyfin login maps authentication and does not expose the upstream response", async () => {
  const fetcher: typeof fetch = async (_input, init) => {
    assert.equal(init?.redirect, "manual");
    return json({ secret: "do not leak" }, 401);
  };
  await assert.rejects(
    new Upstreams(fetcher).jellyfinLogin(
      "https://j.example/jellyfin",
      "u",
      "p",
    ),
    (error: Error) => {
      assert.ok(error instanceof UpstreamError);
      assert.equal(error.code, "upstream_auth");
      assert.equal(error.message.includes("secret"), false);
      return true;
    },
  );
});

test("setup adapters match Jellyfin, Last.fm and Lidarr wire contracts", async () => {
  const paths: string[] = [];
  const adapter = new Upstreams(async (input, init) => {
    assert.ok(input instanceof URL);
    paths.push(input.pathname);
    assert.equal(init?.redirect, "manual");
    if (input.hostname === "jellyfin.test") {
      assert.equal(input.pathname, "/Users/AuthenticateByName");
      assert.equal(init?.method, "POST");
      assert.deepEqual(JSON.parse(String(init.body)), {
        Username: "u & é",
        Pw: "p & + é",
      });
      assert.equal(
        new Headers(init.headers).get("authorization"),
        'MediaBrowser Client="Leerr",Device="Leerr Server",DeviceId="leerr-server",Version="0.1"',
      );
      assert.equal(
        new Headers(init.headers).get("content-type"),
        "application/json",
      );
      return json({
        AccessToken: "synthetic-token",
        User: { Id: "synthetic-user" },
        SessionInfo: {},
      });
    }
    if (input.hostname === "ws.audioscrobbler.com") {
      assert.equal(input.pathname, "/2.0/");
      assert.equal(init?.method ?? "GET", "GET");
      assert.equal(input.searchParams.get("method"), "user.getInfo");
      assert.equal(input.searchParams.get("api_key"), "synthetic&key");
      assert.equal(input.searchParams.get("user"), "u & é");
      assert.equal(input.searchParams.get("format"), "json");
      assert.equal(input.searchParams.has("password"), false);
      return json({
        user: { name: "u & é", registered: { unixtime: "1037793040" } },
      });
    }
    assert.equal(new Headers(init?.headers).get("x-api-key"), "synthetic-key");
    if (input.pathname === "/api/v1/rootfolder")
      return json([
        {
          id: 7,
          name: "Music",
          path: "/music",
          freeSpace: null,
          accessible: true,
        },
      ]);
    if (input.pathname === "/api/v1/qualityprofile")
      return json([
        {
          id: 3,
          name: "Lossless",
          items: [{ quality: { id: 0 }, allowed: false }],
        },
      ]);
    assert.equal(input.pathname, "/api/v1/metadataprofile");
    return json([
      {
        id: 9,
        name: "Standard",
        primaryAlbumTypes: [{ albumType: { id: 1 }, allowed: true }],
      },
    ]);
  });
  assert.deepEqual(
    await adapter.jellyfinLogin("https://jellyfin.test", "u & é", "p & + é"),
    {
      token: "synthetic-token",
      userID: "synthetic-user",
    },
  );
  await adapter.checkLastfm("u & é", "synthetic&key");
  assert.deepEqual(
    await adapter.lidarrOptions("https://lidarr.test", "synthetic-key"),
    {
      roots: [{ id: 7, name: "/music" }],
      qualities: [{ id: 3, name: "Lossless" }],
      metadata: [{ id: 9, name: "Standard" }],
    },
  );
  assert.equal(paths.length, 5);
});

test("setup rejection diagnostics retain status and API codes without response secrets", async () => {
  for (const status of [401, 403]) {
    const adapter = new Upstreams(async () =>
      json({ message: "private-response" }, status),
    );
    await assert.rejects(
      adapter.jellyfinLogin("https://jellyfin.test", "u", "p"),
      (error: Error) => {
        assert.match(error.message, new RegExp(`HTTP ${status}`));
        assert.doesNotMatch(error.message, /private-response/);
        return true;
      },
    );
  }
  for (const status of [200, 400, 403]) {
    for (const code of [6, 10, 26]) {
      const adapter = new Upstreams(async () =>
        json({ error: code, message: "private-response" }, status),
      );
      await assert.rejects(
        adapter.checkLastfm("u", "synthetic-key"),
        (error: Error) => {
          assert.match(error.message, new RegExp(`Last.fm error ${code}`));
          assert.doesNotMatch(error.message, /private-response|synthetic-key/);
          return true;
        },
      );
    }
  }
  const adapter = new Upstreams(async (input) => {
    assert.ok(input instanceof URL);
    return input.pathname.endsWith("rootfolder")
      ? json([{ id: 1, path: "/music" }])
      : json({ unexpected: "private-response" });
  });
  await assert.rejects(
    adapter.lidarrOptions("https://lidarr.test", "synthetic-key"),
    (error: Error) => {
      assert.match(error.message, /Lidarr (qualityprofile|metadataprofile):/);
      assert.doesNotMatch(error.message, /private-response|synthetic-key/);
      return true;
    },
  );
});

test("original audio first authorizes the user and preserves range streaming", async () => {
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url =
      input instanceof URL
        ? input
        : new URL(input instanceof Request ? input.url : input);
    calls.push(url.pathname);
    assert.equal(
      new Headers(init?.headers).get("Authorization"),
      'MediaBrowser Token="token"',
    );
    if (calls.length === 1)
      return json({ Id: "track", Name: "Song", Type: "Audio" });
    assert.equal(new Headers(init?.headers).get("range"), "bytes=10-20");
    return new Response(new Uint8Array([1, 2]), {
      status: 206,
      headers: { "Content-Range": "bytes 10-11/12" },
    });
  };
  const response = await new Upstreams(fetcher).jellyfinOriginal(
    "https://j.example/base",
    "token",
    "user",
    "track",
    "bytes=10-20",
    new AbortController().signal,
  );
  assert.equal(response.status, 206);
  assert.deepEqual(calls, [
    "/base/Users/user/Items/track",
    "/base/Audio/track/stream",
  ]);
});

test("original audio rejects redirects after authorization", async () => {
  let count = 0;
  const fetcher: typeof fetch = async () => {
    count += 1;
    if (count === 1) return json({ Id: "track", Name: "Song", Type: "Audio" });
    return new Response(null, {
      status: 302,
      headers: { Location: "https://evil.example/audio" },
    });
  };
  await assert.rejects(
    new Upstreams(fetcher).jellyfinOriginal(
      "https://j.example",
      "token",
      "user",
      "track",
      undefined,
      new AbortController().signal,
    ),
    UpstreamError,
  );
});

test("confirmed identity requires authoritative group, release, and artist relationships", async () => {
  const fetcher: typeof fetch = async (input) => {
    const url =
      input instanceof URL
        ? input
        : new URL(input instanceof Request ? input.url : input);
    if (url.pathname.includes("release-group/"))
      return json({
        id: group,
        title: "Album",
        "artist-credit": [{ artist: { id: artist, name: "Artist" } }],
      });
    return json({
      id: release,
      title: "Edition",
      "release-group": { id: group },
      "artist-credit": [{ artist: { id: artist, name: "Artist" } }],
    });
  };
  assert.deepEqual(
    await new Upstreams(fetcher).confirmedIdentity(group, release, artist),
    {
      artistMBID: artist,
      releaseGroupMBID: group,
      releaseMBID: release,
      title: "Album",
      artist: "Artist",
    },
  );

  const mismatched: typeof fetch = async (input) => {
    const url =
      input instanceof URL
        ? input
        : new URL(input instanceof Request ? input.url : input);
    if (url.pathname.includes("release-group/"))
      return json({
        id: group,
        title: "Same names prove nothing",
        "artist-credit": [{ artist: { id: artist, name: "Artist" } }],
      });
    return json({
      id: release,
      title: "Edition",
      "release-group": { id: "44444444-4444-4444-8444-444444444444" },
      "artist-credit": [{ artist: { id: artist, name: "Artist" } }],
    });
  };
  await assert.rejects(
    new Upstreams(mismatched).confirmedIdentity(group, release, artist),
    UpstreamError,
  );
});

test("Lidarr album lists omit nested artist and still reconcile the exact monitored edition", async () => {
  const fetcher: typeof fetch = async () =>
    json([
      {
        id: 17,
        foreignAlbumId: group,
        monitored: true,
        anyReleaseOk: false,
        releases: [{ foreignReleaseId: release, monitored: true }],
        statistics: { trackCount: 9, trackFileCount: 8 },
      },
    ]);
  const result = await new Upstreams(fetcher).lidarrAlbum(
    "https://lidarr.test",
    "fixture-key",
    group,
    release,
  );
  assert.equal(result?.monitored, true);
  assert.equal(result.imported, false);
  const wrong = await new Upstreams(fetcher).lidarrAlbum(
    "https://lidarr.test",
    "fixture-key",
    group,
    artist,
  );
  assert.equal(wrong?.monitored, false);
  assert.equal(wrong.imported, false);
});

test("Jellyfin denial stops before audio, and unbounded JSON/image responses fail closed", async () => {
  let calls = 0;
  const deny: typeof fetch = async () => {
    calls++;
    return json({ forbidden: true }, 403);
  };
  await assert.rejects(
    new Upstreams(deny).jellyfinOriginal(
      "https://jelly.test",
      "token",
      "user",
      "track",
      undefined,
      new AbortController().signal,
    ),
    UpstreamError,
  );
  assert.equal(calls, 1);
  const huge: typeof fetch = async () => new Response("x".repeat(2_000_001));
  await assert.rejects(
    new Upstreams(huge).jellyfinLogin("https://jelly.test", "user", "password"),
    UpstreamError,
  );
  const svg: typeof fetch = async (input) => {
    const url =
      input instanceof URL
        ? input
        : new URL(input instanceof Request ? input.url : input);
    return url.pathname.endsWith("/Primary")
      ? new Response('<svg onload="alert(1)"/>', {
          headers: { "Content-Type": "image/svg+xml" },
        })
      : json({ Id: "album", Name: "Album", Type: "MusicAlbum" });
  };
  await assert.rejects(
    new Upstreams(svg).jellyfinArtwork(
      "https://jelly.test",
      "token",
      "user",
      "album",
    ),
    UpstreamError,
  );
});

test("Lidarr initial payload never monitors an entire artist and pins exactly one edition", async () => {
  const fetcher: typeof fetch = async (input) => {
    const url =
      input instanceof URL
        ? input
        : new URL(input instanceof Request ? input.url : input);
    if (url.pathname.endsWith("rootfolder"))
      return json([{ id: 1, path: "/music" }]);
    if (
      url.pathname.endsWith("qualityprofile") ||
      url.pathname.endsWith("metadataprofile")
    )
      return json([{ id: 1, name: "Standard" }]);
    return json([
      {
        foreignAlbumId: group,
        artist: { foreignArtistId: artist },
        releases: [{ foreignReleaseId: release }, { foreignReleaseId: artist }],
      },
    ]);
  };
  const result = await new Upstreams(fetcher).lidarrLookup(
    "https://lidarr.test",
    "key",
    {
      releaseGroupMBID: group,
      releaseMBID: release,
      artistMBID: artist,
      title: "Album",
      artist: "Artist",
    },
    {
      rootFolderPath: "/music",
      qualityProfileID: 1,
      metadataProfileID: 1,
    },
  );
  assert.equal(result.anyReleaseOk, false);
  assert.equal(result.artist.monitored, false);
  assert.deepEqual(result.artist.addOptions, {
    monitor: "none",
    albumsToMonitor: [],
    searchForMissingAlbums: false,
  });
  assert.deepEqual(
    result.releases.map((value) => value.monitored),
    [true, false],
  );
});
