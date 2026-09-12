import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { z } from "zod";
import { buildApp } from "./app.ts";
import { Upstreams } from "./upstream.ts";
import { makeStore } from "./test-fixtures.ts";

// Public MusicBrainz responses captured 2026-09-12, not invented MBIDs.
const pablo = JSON.parse(
  readFileSync(
    new URL("./fixtures/search-pablo.json", import.meta.url),
    "utf8",
  ),
);
const radiohead = JSON.parse(
  readFileSync(
    new URL("./fixtures/search-radiohead.json", import.meta.url),
    "utf8",
  ),
);
const group = "8c18657a-6338-490d-a952-897663596b96";
const artist = "164f0d73-1234-4e2c-8743-d77bf2191051";
// Public Last.fm album page supplied this actual image. API envelopes below
// follow Last.fm's documented wire contract; no live API key was acquired.
const cover =
  "https://lastfm-img.freetls.fastly.net/i/u/500x500/8c6af1315c66631bad022085c7992b34.jpg";

test("search HTTP boundary separates artists, escapes terms, preserves group identity and scopes optional artwork", async (t) => {
  let mode = "pablo";
  const calls: URL[] = [];
  const provider = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://provider.test");
    calls.push(url);
    res.setHeader("Content-Type", "application/json");
    if (url.pathname === "/musicbrainz.org/ws/2/artist") {
      res.end(
        JSON.stringify(mode === "radiohead" ? radiohead : { artists: [] }),
      );
    } else if (url.pathname === "/musicbrainz.org/ws/2/release-group") {
      res.end(
        JSON.stringify(
          mode === "radiohead"
            ? { count: 0, "release-groups": [] }
            : url.searchParams.get("offset") === "25"
              ? { ...pablo, count: 28 }
              : pablo,
        ),
      );
    } else if (url.pathname === "/ws.audioscrobbler.com/2.0/") {
      assert.equal(url.searchParams.get("api_key"), "disposable-key");
      if (mode === "art-error") {
        res.statusCode = 503;
        res.end("{}");
      } else if (url.searchParams.get("method") === "album.search") {
        res.end(
          JSON.stringify({
            results: {
              albummatches: {
                album: [
                  {
                    name: "The Life of Pablo",
                    artist: "Someone else",
                    image: [{ size: "large", "#text": cover }],
                  },
                  {
                    name: "The Life of Pablo",
                    artist: "Kanye West",
                    mbid: "99e14f9e-5831-4b2c-b595-531be0f225ea",
                    image: [
                      {
                        size: "large",
                        "#text":
                          mode === "hostile-art"
                            ? "https://attacker.test/image.jpg"
                            : cover,
                      },
                    ],
                  },
                ],
              },
            },
          }),
        );
      } else {
        assert.equal(url.searchParams.get("method"), "artist.getTopAlbums");
        assert.equal(url.searchParams.get("mbid"), artist);
        res.end(
          JSON.stringify({
            topalbums: {
              album: [
                {
                  name: "The Life of Pablo",
                  image: [{ size: "large", "#text": cover }],
                },
              ],
            },
          }),
        );
      }
    } else {
      res.statusCode = 500;
      res.end("{}");
    }
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  const address = z.object({ port: z.number() }).parse(provider.address());
  const upstream = new Upstreams((input, init) => {
    assert.ok(input instanceof URL);
    assert.ok(
      ["musicbrainz.org", "ws.audioscrobbler.com"].includes(input.hostname),
    );
    assert.equal(init?.redirect, "manual");
    return fetch(
      `http://127.0.0.1:${address.port}/${input.hostname}${input.pathname}${input.search}`,
      init,
    );
  });
  const store = makeStore();
  const options = {
    store,
    upstream,
    origin: "http://127.0.0.1",
    setupToken: "disposable-setup",
    secure: false,
  };
  const { app } = await buildApp(options);
  const origin = await app.listen({ port: 0, host: "127.0.0.1" });
  options.origin = origin;
  t.after(async () => {
    await app.close();
    store.close();
    provider.close();
  });
  const headers = { origin, "content-type": "application/json" };
  const post = (path: string, body: z.infer<ReturnType<typeof z.json>>) =>
    fetch(`${origin}/api/v1${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  const setup = await post("/setup", {
    token: "disposable-setup",
    username: "admin",
    password: "disposable-password",
  });
  assert.equal(setup.status, 200, await setup.text());
  const login = await post("/sessions", {
    username: "admin",
    password: "disposable-password",
    device: "native",
    name: "test",
  });
  const session = z
    .object({ token: z.string(), user: z.object({ id: z.string() }) })
    .parse(await login.json());
  const get = (path: string) =>
    fetch(`${origin}/api/v1${path}`, {
      headers: { ...headers, authorization: `Bearer ${session.token}` },
    });
  assert.equal(
    (await fetch(`${origin}/api/v1/resolve?q=Radiohead`, { headers })).status,
    401,
  );
  assert.equal(
    (await fetch(`${origin}/api/v1/artists/${artist}/albums`, { headers }))
      .status,
    401,
  );
  assert.equal(calls.length, 0);
  mode = "radiohead";
  const artists = await (await get("/resolve?q=Radiohead")).json();
  assert.equal(artists.artists[0].id, "a74b1b7f-71a5-4011-9441-d0b5e4122711");
  assert.equal(artists.artists[0].country, "GB");
  assert.equal(artists.artists[0].type, "Group");
  assert.equal(
    artists.artists[1].disambiguation,
    "pre‐Radiohead group, until 1991",
  );
  assert.equal(artists.items.length, 0);
  assert.equal(
    calls[0].searchParams.get("query"),
    'releasegroup:("Radiohead") AND primarytype:album',
  );
  assert.equal(calls[1].searchParams.get("query"), '"Radiohead"');
  mode = "pablo";
  store.putSecret(
    session.user.id,
    "lastfm",
    JSON.stringify({ username: "disposable", apiKey: "disposable-key" }),
  );
  const response = await get("/resolve?q=the%20life%20of%20pablo");
  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-security-policy") ?? "",
    /https:\/\/lastfm-img\.freetls\.fastly\.net/,
  );
  const result = await response.json();
  assert.equal(result.items[0].id, group);
  assert.equal(result.items[0].artistMBID, artist);
  assert.equal(result.items[0].artist, "Kanye West");
  assert.equal(result.items[0].coverUrl, cover);
  assert.equal(result.items.length, 3);
  assert.equal(
    calls[2].searchParams.get("query"),
    'releasegroup:("the" AND "life" AND "of" AND "pablo") AND primarytype:album',
  );
  assert.equal(result.items[1].coverUrl, undefined);
  const browsed = await (
    await get(`/artists/${artist}/albums?offset=25`)
  ).json();
  assert.equal(browsed.items[0].coverUrl, cover);
  const browse = calls.find((url) => url.searchParams.get("offset") === "25");
  assert.equal(
    browse?.searchParams.get("query"),
    `arid:${artist} AND primarytype:album AND (status:official^5 OR primarytype:album)`,
  );
  assert.equal(browsed.total, 28);
  const beforeInvalid = calls.length;
  assert.equal((await get("/artists/not-a-uuid/albums")).status, 400);
  assert.equal((await get(`/artists/${artist}/albums?offset=-1`)).status, 400);
  assert.equal(calls.length, beforeInvalid);
  mode = "hostile-art";
  assert.equal(
    (await (await get("/resolve?q=Pablo")).json()).items[0].coverUrl,
    undefined,
  );
  mode = "art-error";
  const withoutArt = await get("/resolve?q=Pablo");
  assert.equal(withoutArt.status, 200);
  assert.equal((await withoutArt.json()).items[0].coverUrl, undefined);
  await upstream.search('AC/DC "Live" OR artist:*');
  const escaped = calls.at(-2)?.searchParams.get("query");
  assert.equal(
    escaped,
    'releasegroup:("AC/DC" AND "\\"Live\\"" AND "OR" AND "artist:*") AND primarytype:album',
  );
});

test("recommendations retain Last.fm artwork without turning release IDs into group IDs", async () => {
  const upstream = new Upstreams(async (input) => {
    assert.ok(input instanceof URL);
    const json = <T>(body: T) =>
      new Response(JSON.stringify(body), {
        headers: { "Content-Type": "application/json" },
      });
    if (input.hostname === "musicbrainz.org") return json(pablo);
    switch (input.searchParams.get("method")) {
      case "user.getTopArtists":
        return json({ topartists: { artist: [{ name: "Seed" }] } });
      case "artist.getSimilar":
        return json({ similarartists: { artist: [{ name: "Kanye West" }] } });
      case "artist.getTopAlbums":
        return json({
          topalbums: {
            album: [
              {
                name: "The Life of Pablo",
                mbid: "99e14f9e-5831-4b2c-b595-531be0f225ea",
                image: [{ size: "large", "#text": cover }],
              },
            ],
          },
        });
      default:
        throw new Error("Unexpected provider call");
    }
  });
  const result = await upstream.recommendations("disposable", "disposable-key");
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].id, group);
  assert.equal(result.items[0].coverUrl, cover);
});
