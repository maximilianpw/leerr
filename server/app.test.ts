import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { z } from "zod";
import type {
  InjectOptions,
  Response as InjectResponse,
} from "light-my-request";
import { buildApp } from "./app.ts";
import { Upstreams, UpstreamError } from "./upstream.ts";
import { Store, digest } from "./store.ts";
import {
  FakeUpstreams,
  fixtureKey,
  identities,
  makeStore,
} from "./test-fixtures.ts";

const host = { host: "leerr.test" },
  origin = { ...host, origin: "https://leerr.test" };
async function harness(fetcher?: typeof fetch) {
  const store = makeStore(),
    upstream = new FakeUpstreams();
  let clock = 1_700_000_000_000;
  const { app } = await buildApp({
    store,
    origin: "https://leerr.test",
    setupToken: "fixture-setup",
    secure: false,
    upstream: fetcher ? new Upstreams(fetcher) : upstream,
    now: () => clock,
  });
  const inject = (o: InjectOptions) =>
    app.inject({ ...o, headers: { ...origin, ...o.headers } });
  const setup = await inject({
    method: "POST",
    url: "/api/v1/setup",
    payload: {
      token: "fixture-setup",
      username: "admin",
      password: "admin-password",
    },
  });
  assert.equal(setup.statusCode, 200);
  const login = async (
    username: string,
    password: string,
    device: "web" | "native" = "web",
  ) =>
    inject({
      method: "POST",
      url: "/api/v1/sessions",
      payload: { username, password, device, name: "test" },
    });
  return {
    store,
    upstream,
    app,
    inject,
    login,
    advance(ms: number) {
      clock += ms;
    },
  };
}
function header(response: InjectResponse, name: string): string {
  const value = response.headers[name];
  return String(Array.isArray(value) ? value[0] : (value ?? ""));
}
function webHeaders(response: InjectResponse) {
  const body = z.object({ csrf: z.string() }).parse(response.json());
  return {
    cookie: header(response, "set-cookie").split(";")[0],
    "x-csrf-token": body.csrf,
  };
}

test("setup is one-shot, rejects hostile host/origin, and web auth enforces cookie CSRF", async (t) => {
  const h = await harness();
  t.after(async () => {
    await h.app.close();
    h.store.close();
  });
  assert.equal(
    (
      await h.inject({
        method: "POST",
        url: "/api/v1/setup",
        payload: {
          token: "fixture-setup",
          username: "again",
          password: "long-password",
        },
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await h.app.inject({
        method: "GET",
        url: "/api/v1/setup",
        headers: { host: "evil.test" },
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await h.app.inject({
        method: "POST",
        url: "/api/v1/sessions",
        headers: { host: "leerr.test", origin: "https://evil.test" },
        payload: {},
      })
    ).statusCode,
    403,
  );
  const login = await h.login("admin", "admin-password");
  assert.equal(login.statusCode, 200);
  const cookie = header(login, "set-cookie");
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Strict/i);
  assert.doesNotMatch(cookie, /Secure/i);
  assert.equal(
    (
      await h.inject({
        method: "GET",
        url: "/api/v1/me",
        headers: { cookie: cookie.split(";")[0] },
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await h.inject({
        method: "DELETE",
        url: "/api/v1/sessions/current",
        headers: { cookie: cookie.split(";")[0] },
      })
    ).statusCode,
    403,
  );
});

test("native/member permissions, encrypted per-user connections, isolation and expiry/revoke", async (t) => {
  const h = await harness();
  t.after(async () => {
    await h.app.close();
    h.store.close();
  });
  const adminLogin = await h.login("admin", "admin-password"),
    admin = webHeaders(adminLogin);
  await h.inject({
    method: "POST",
    url: "/api/v1/admin/users",
    headers: admin,
    payload: {
      username: "member",
      password: "member-password",
      role: "member",
    },
  });
  const native = await h.login("member", "member-password", "native");
  const token = native.json().token;
  assert.equal(token.length, 43);
  assert.equal(
    (
      await h.inject({
        method: "GET",
        url: "/api/v1/admin/users",
        headers: { authorization: `Bearer ${token}` },
      })
    ).statusCode,
    403,
  );
  h.store.putSecret(
    "installation",
    "settings",
    JSON.stringify({
      jellyfinURL: "https://jelly.test",
      lidarrURL: null,
      lidarrKey: "",
      rootFolderPath: "",
      qualityProfileID: 0,
      metadataProfileID: 0,
    }),
  );
  assert.equal(
    (
      await h.inject({
        method: "PUT",
        url: "/api/v1/connections/jellyfin",
        headers: { authorization: `Bearer ${token}` },
        payload: { username: "member", password: "jelly-password" },
      })
    ).statusCode,
    200,
  );
  const memberID = z
    .string()
    .parse(
      h.store.db
        .prepare("SELECT id FROM users WHERE username='member'")
        .pluck()
        .get(),
    );
  const raw = z
    .string()
    .parse(
      h.store.db
        .prepare("SELECT value FROM secrets WHERE owner=?")
        .pluck()
        .get(memberID),
    );
  assert.equal(raw.includes("member-jelly-token"), false);
  assert.deepEqual(
    (
      await h.inject({
        method: "GET",
        url: "/api/v1/connections",
        headers: { authorization: `Bearer ${token}` },
      })
    ).json(),
    { jellyfinConfigured: true, jellyfin: true, lastfm: false },
  );
  assert.equal(
    (
      await h.inject({
        method: "GET",
        url: "/api/v1/library",
        headers: { authorization: `Bearer ${token}` },
      })
    ).json().items[0].id,
    "member-only",
  );
  await h.inject({
    method: "DELETE",
    url: "/api/v1/connections/jellyfin",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(
    (
      await h.inject({
        method: "GET",
        url: "/api/v1/library",
        headers: { authorization: `Bearer ${token}` },
      })
    ).statusCode,
    409,
  );
  h.advance(31 * 86400_000);
  assert.equal(
    (
      await h.inject({
        method: "GET",
        url: "/api/v1/me",
        headers: { authorization: `Bearer ${token}` },
      })
    ).statusCode,
    401,
  );
});

test("library pagination preserves untagged albums; requests deduplicate by group and remain user-scoped", async (t) => {
  const h = await harness();
  t.after(async () => {
    await h.app.close();
    h.store.close();
  });
  const login = await h.login("admin", "admin-password"),
    headers = webHeaders(login);
  h.store.putSecret(
    "installation",
    "settings",
    JSON.stringify({
      jellyfinURL: "https://jelly.test",
      lidarrURL: "https://lidarr.test",
      lidarrKey: "key",
      rootFolderPath: "/music",
      qualityProfileID: 1,
      metadataProfileID: 1,
    }),
  );
  await h.inject({
    method: "PUT",
    url: "/api/v1/connections/jellyfin",
    headers,
    payload: { username: "admin", password: "jelly-password" },
  });
  const page = (
    await h.inject({
      method: "GET",
      url: "/api/v1/library?offset=1&limit=1",
      headers,
    })
  ).json();
  assert.equal(page.items[0].id, "untagged");
  assert.equal(page.total, 2);
  assert.equal(
    (
      await h.inject({
        method: "POST",
        url: "/api/v1/requests",
        headers,
        payload: { ...identities.album, confirmed: true },
      })
    ).statusCode,
    409,
  );
  h.upstream.libraries.set("admin-jelly-token", []);
  const payload = { ...identities.other, confirmed: true };
  const [a, b] = await Promise.all([
    h.inject({
      method: "POST",
      url: "/api/v1/requests",
      headers,
      payload,
    }),
    h.inject({
      method: "POST",
      url: "/api/v1/requests",
      headers,
      payload,
    }),
  ]);
  assert.equal(a.statusCode, 200);
  assert.equal(b.statusCode, 200);
  assert.equal(a.json().id, b.json().id);
  assert.equal(
    h.store.db.prepare("SELECT count(*) FROM acquisitions").pluck().get(),
    1,
  );
  assert.equal(
    (await h.inject({ method: "GET", url: "/api/v1/requests", headers })).json()
      .items.length,
    1,
  );
  h.store.db.prepare("UPDATE acquisitions SET status='imported'").run();
  assert.equal(
    (await h.inject({ method: "GET", url: "/api/v1/requests", headers })).json()
      .items[0].status,
    "imported",
  );
  h.upstream.libraries.set("admin-jelly-token", [
    {
      id: "now-here",
      title: "Other",
      artist: "Other",
      releaseGroupMBID: identities.other.releaseGroupMBID,
      releaseMBID: identities.other.releaseMBID,
    },
  ]);
  assert.equal(
    (await h.inject({ method: "GET", url: "/api/v1/requests", headers })).json()
      .items[0].status,
    "available",
  );
});

test("stream proxy returns exact full/range bytes, 416, expiry, and never exposes token", async (t) => {
  const h = await harness();
  t.after(async () => {
    await h.app.close();
    h.store.close();
  });
  const login = await h.login("admin", "admin-password"),
    headers = webHeaders(login);
  h.store.putSecret(
    "installation",
    "settings",
    JSON.stringify({
      jellyfinURL: "https://jelly.test",
      lidarrURL: null,
      lidarrKey: "",
      rootFolderPath: "",
      qualityProfileID: 0,
      metadataProfileID: 0,
    }),
  );
  await h.inject({
    method: "PUT",
    url: "/api/v1/connections/jellyfin",
    headers,
    payload: { username: "admin", password: "jelly-password" },
  });
  const ticket = (
    await h.inject({
      method: "POST",
      url: "/api/v1/stream-tickets",
      headers,
      payload: { trackID: "tone" },
    })
  ).json();
  assert.equal(JSON.stringify(ticket).includes("jelly-token"), false);
  const full = await h.inject({ method: "GET", url: ticket.path });
  assert.deepEqual(full.rawPayload, h.upstream.audio);
  const partial = await h.inject({
    method: "GET",
    url: ticket.path,
    headers: { range: "bytes=137-691" },
  });
  assert.equal(partial.statusCode, 206);
  assert.deepEqual(partial.rawPayload, h.upstream.audio.subarray(137, 692));
  assert.equal(
    (
      await h.inject({
        method: "GET",
        url: ticket.path,
        headers: { range: "bytes=999999-" },
      })
    ).statusCode,
    416,
  );
  h.advance(16 * 60_000);
  assert.equal(
    (
      await h.inject({
        method: "GET",
        url: ticket.path,
        headers: { range: "bytes=1-9" },
      })
    ).statusCode,
    401,
  );
});

test("store reopens backups, migrates v1 journal, and rejects a wrong encryption key", () => {
  const dir = mkdtempSync(join(tmpdir(), "leerr-store-"));
  const path = join(dir, "db.sqlite");
  try {
    const store = new Store(path, fixtureKey);
    store.putSecret("owner", "service", JSON.stringify({ token: "secret" }));
    store.close();
    assert.throws(() => new Store(path, Buffer.alloc(32, 8)));
    const reopened = new Store(path, fixtureKey);
    reopened.close();
    const v1 = join(dir, "v1.sqlite"),
      db = new Database(v1);
    db.exec(
      "CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT,password TEXT,role TEXT,disabled INTEGER); CREATE TABLE sessions(id TEXT,userID TEXT,csrf TEXT,expiresAt INTEGER,name TEXT,device TEXT); CREATE TABLE secrets(owner TEXT,service TEXT,value TEXT); CREATE TABLE acquisitions(id TEXT PRIMARY KEY,releaseGroupMBID TEXT,releaseMBID TEXT,artistMBID TEXT,title TEXT,artist TEXT,status TEXT,attempted INTEGER,failures INTEGER,nextAt INTEGER); CREATE TABLE requests(id TEXT,userID TEXT,acquisitionID TEXT); CREATE TABLE tickets(id TEXT,sessionID TEXT,trackID TEXT,expiresAt INTEGER); PRAGMA user_version=1",
    );
    db.close();
    const migrated = new Store(v1, fixtureKey);
    assert.ok(
      migrated.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name='acquisition_mutations'",
        )
        .get(),
    );
    assert.equal(migrated.db.pragma("user_version", { simple: true }), 2);
    migrated.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Secure cookies require trusted HTTPS and login attempts are bounded", async (t) => {
  const h = await harness();
  t.after(async () => {
    await h.app.close();
    h.store.close();
  });
  const secure = await buildApp({
    store: h.store,
    origin: "https://leerr.test",
    setupToken: "fixture",
    trustProxy: ["127.0.0.1"],
  });
  t.after(() => secure.app.close());
  assert.equal(
    (await secure.app.inject({ url: "/api/v1/setup", headers: host }))
      .statusCode,
    400,
  );
  const login = await secure.app.inject({
    method: "POST",
    url: "/api/v1/sessions",
    remoteAddress: "127.0.0.1",
    headers: { ...origin, "x-forwarded-proto": "https" },
    payload: {
      username: "admin",
      password: "admin-password",
      device: "web",
      name: "secure-browser",
    },
  });
  assert.equal(login.statusCode, 200);
  assert.match(header(login, "set-cookie"), /Secure/i);
  assert.equal(
    (
      await secure.app.inject({
        url: "/api/v1/setup",
        remoteAddress: "10.9.8.7",
        headers: { ...host, "x-forwarded-proto": "https" },
      })
    ).statusCode,
    400,
  );
  for (let i = 0; i < 10; i++)
    assert.equal((await h.login("admin", "wrong-password")).statusCode, 401);
  const limited = await h.login("admin", "admin-password");
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.json().error.code, "rate_limited");
});

test("password reset and individual device revocation invalidate stream tickets", async (t) => {
  const h = await harness();
  t.after(async () => {
    await h.app.close();
    h.store.close();
  });
  const admin = webHeaders(await h.login("admin", "admin-password"));
  await h.inject({
    method: "POST",
    url: "/api/v1/admin/users",
    headers: admin,
    payload: {
      username: "member",
      password: "member-password",
      role: "member",
    },
  });
  const first = (await h.login("member", "member-password", "native")).json();
  const second = (await h.login("member", "member-password", "native")).json();
  const bearer = { authorization: `Bearer ${first.token}` };
  h.store.putSecret(
    "installation",
    "settings",
    JSON.stringify({
      jellyfinURL: "https://jelly.test",
      lidarrURL: null,
      lidarrKey: "",
      rootFolderPath: "",
      qualityProfileID: 0,
      metadataProfileID: 0,
    }),
  );
  await h.inject({
    method: "PUT",
    url: "/api/v1/connections/jellyfin",
    headers: bearer,
    payload: { username: "member", password: "jelly-password" },
  });
  const ticket = (
    await h.inject({
      method: "POST",
      url: "/api/v1/stream-tickets",
      headers: bearer,
      payload: { trackID: "tone" },
    })
  ).json();
  assert.equal(
    (
      await h.inject({
        method: "DELETE",
        url: `/api/v1/sessions/${digest(first.token)}`,
        headers: admin,
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await h.inject({
        method: "DELETE",
        url: "/api/v1/sessions/current",
        headers: bearer,
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (await h.inject({ method: "GET", url: ticket.path })).statusCode,
    401,
  );
  assert.equal(
    (
      await h.inject({
        method: "GET",
        url: "/api/v1/me",
        headers: { authorization: `Bearer ${second.token}` },
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await h.inject({
        method: "PATCH",
        url: `/api/v1/admin/users/${second.user.id}`,
        headers: admin,
        payload: { password: "replacement-password" },
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await h.inject({
        method: "GET",
        url: "/api/v1/me",
        headers: { authorization: `Bearer ${second.token}` },
      })
    ).statusCode,
    401,
  );
  assert.equal((await h.login("member", "member-password")).statusCode, 401);
  assert.equal(
    (await h.login("member", "replacement-password")).statusCode,
    200,
  );
});

test("two users share one acquisition without exposing identities or request IDs", async (t) => {
  const h = await harness();
  t.after(async () => {
    await h.app.close();
    h.store.close();
  });
  const admin = webHeaders(await h.login("admin", "admin-password"));
  await h.inject({
    method: "POST",
    url: "/api/v1/admin/users",
    headers: admin,
    payload: {
      username: "member",
      password: "member-password",
      role: "member",
    },
  });
  const member = webHeaders(await h.login("member", "member-password"));
  h.store.putSecret(
    "installation",
    "settings",
    JSON.stringify({
      jellyfinURL: null,
      lidarrURL: "https://lidarr.test",
      lidarrKey: "super-secret",
      rootFolderPath: "/music",
      qualityProfileID: 1,
      metadataProfileID: 1,
    }),
  );
  const payload = { ...identities.album, confirmed: true };
  const a = await h.inject({
    method: "POST",
    url: "/api/v1/requests",
    headers: admin,
    payload,
  });
  const b = await h.inject({
    method: "POST",
    url: "/api/v1/requests",
    headers: member,
    payload,
  });
  assert.equal(a.statusCode, 200);
  assert.equal(b.statusCode, 200);
  assert.notEqual(a.json().id, b.json().id);
  assert.equal(
    h.store.db.prepare("SELECT count(*) FROM acquisitions").pluck().get(),
    1,
  );
  const own = await h.inject({
    method: "GET",
    url: "/api/v1/requests",
    headers: member,
  });
  assert.equal(own.json().items.length, 1);
  assert.equal(own.body.includes(a.json().id), false);
  assert.equal(own.body.includes("super-secret"), false);
  assert.equal(
    (
      await h.inject({
        method: "POST",
        url: `/api/v1/requests/${a.json().id}/retry`,
        headers: member,
        payload: {},
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await h.inject({
        method: "POST",
        url: "/api/v1/requests",
        headers: member,
        payload: { ...payload, confirmed: false },
      })
    ).statusCode,
    400,
  );
});

test("online SQLite backup restores encrypted data and durable intent", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "leerr-backup-"));
  const store = new Store(join(dir, "source.sqlite"), fixtureKey);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  store.putSecret(
    "owner",
    "jellyfin",
    JSON.stringify({ token: "fixture-original-token" }),
  );
  await store.db.backup(join(dir, "backup.sqlite"));
  const restored = new Store(join(dir, "backup.sqlite"), fixtureKey);
  try {
    assert.deepEqual(
      restored.secret("owner", "jellyfin", z.object({ token: z.string() })),
      {
        token: "fixture-original-token",
      },
    );
    assert.equal(restored.db.pragma("integrity_check", { simple: true }), "ok");
  } finally {
    restored.close();
  }
});

test("artwork requires a session and per-user Jellyfin access before delivering exact PNG bytes", async (t) => {
  const h = await harness();
  t.after(async () => {
    await h.app.close();
    h.store.close();
  });
  const session = await h.login("admin", "admin-password");
  const user = z
    .object({ id: z.string() })
    .parse(
      h.store.db.prepare("SELECT id FROM users WHERE username='admin'").get(),
    );
  h.store.putSecret(
    "installation",
    "settings",
    JSON.stringify({
      ...h.store.settings(),
      jellyfinURL: "https://jelly.test",
    }),
  );
  h.store.putSecret(
    user.id,
    "jellyfin",
    JSON.stringify({
      token: "private-art-token",
      userID: "private-user",
    }),
  );
  const png = readFileSync(
    new URL("./fixtures/cover-evening.png", import.meta.url),
  );
  const paths: string[] = [];
  const upstream = new Upstreams(async (input, init) => {
    const url = new URL(String(input));
    paths.push(url.pathname);
    assert.equal(url.search, "");
    assert.equal(
      new Headers(init?.headers).get("Authorization"),
      'MediaBrowser Token="private-art-token"',
    );
    assert.equal(init?.redirect, "manual");
    if (url.pathname === "/Users/private-user/Items/allowed") {
      return new Response(
        JSON.stringify({
          Id: "allowed",
          Name: "Album",
          Type: "MusicAlbum",
        }),
        {
          headers: { "Content-Type": "application/json" },
        },
      );
    }
    if (url.pathname === "/Items/allowed/Images/Primary") {
      return new Response(png, {
        headers: { "Content-Type": "image/png" },
      });
    }
    return new Response(null, { status: 403 });
  });
  h.upstream.jellyfinArtwork = upstream.jellyfinArtwork.bind(upstream);
  assert.equal(
    (await h.inject({ method: "GET", url: "/api/v1/artwork/allowed" }))
      .statusCode,
    401,
  );
  assert.deepEqual(paths, []);
  const headers = webHeaders(session);
  const image = await h.inject({
    method: "GET",
    url: "/api/v1/artwork/allowed",
    headers,
  });
  assert.equal(image.statusCode, 200);
  assert.equal(image.headers["content-type"], "image/png");
  assert.equal(image.headers["cache-control"], "no-store");
  assert.deepEqual(image.rawPayload, png);
  assert.deepEqual(paths, [
    "/Users/private-user/Items/allowed",
    "/Items/allowed/Images/Primary",
  ]);
  paths.length = 0;
  const denied = await h.inject({
    method: "GET",
    url: "/api/v1/artwork/another-users-album",
    headers,
  });
  assert.equal(denied.statusCode, 502);
  assert.equal(denied.json().error.code, "upstream_auth");
  assert.deepEqual(paths, ["/Users/private-user/Items/another-users-album"]);
  assert.doesNotMatch(
    denied.body + JSON.stringify(image.headers),
    /private-art-token/,
  );
});

test("service setup is independent and a new Lidarr URL requires a key before I/O", async (t) => {
  const h = await harness();
  t.after(async () => {
    await h.app.close();
    h.store.close();
  });
  const headers = webHeaders(await h.login("admin", "admin-password"));
  const save = (payload: InjectOptions["payload"]) =>
    h.inject({
      method: "PUT",
      url: "/api/v1/admin/settings",
      headers,
      payload,
    });
  let calls = 0;
  h.upstream.lidarrOptions = async () => {
    calls++;
    return { roots: [], qualities: [], metadata: [] };
  };
  assert.equal(
    (await h.inject({ url: "/api/v1/connections", headers })).json()
      .jellyfinConfigured,
    false,
  );
  const missing = await save({
    lidarrURL: "https://lidarr.test",
    lidarrKey: "",
  });
  assert.equal(missing.statusCode, 400);
  assert.equal(missing.json().error.code, "lidarr_key_required");
  assert.match(missing.json().error.message, /Enter a Lidarr API key/);
  assert.equal(calls, 0);
  assert.equal(
    (await save({ lidarrURL: "https://lidarr.test" })).json().error.code,
    "lidarr_key_required",
  );
  assert.equal(
    (
      await save({ lidarrURL: "http://lidarr.test", lidarrKey: "test-key" })
    ).json().error.code,
    "invalid_endpoint",
  );
  assert.equal(calls, 0);
  await h.inject({
    method: "POST",
    url: "/api/v1/admin/users",
    headers,
    payload: {
      username: "member",
      password: "member-password",
      role: "member",
    },
  });
  const member = webHeaders(await h.login("member", "member-password"));
  assert.deepEqual(
    (await h.inject({ url: "/api/v1/connections", headers: member })).json(),
    { jellyfinConfigured: false, jellyfin: false, lastfm: false },
  );
  assert.equal(
    (
      await h.inject({
        method: "PUT",
        url: "/api/v1/admin/settings",
        headers: member,
        payload: { jellyfinURL: "https://denied.test" },
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await h.inject({
        method: "PUT",
        url: "/api/v1/connections/jellyfin",
        headers: member,
        payload: { username: "member", password: "synthetic" },
      })
    ).statusCode,
    409,
  );
  assert.equal(h.upstream.loginCalls, 0);
  assert.equal(
    (await save({ jellyfinURL: "https://jellyfin.test" })).statusCode,
    200,
  );
  assert.equal(calls, 0);
  assert.equal(
    (await h.inject({ url: "/api/v1/connections", headers })).json()
      .jellyfinConfigured,
    true,
  );
  assert.equal(
    (
      await save({
        lidarrURL: "https://lidarr.test",
        lidarrKey: "test-key",
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (await save({ lidarrURL: "https://lidarr.test", lidarrKey: "" }))
      .statusCode,
    200,
  );
  assert.equal(calls, 2);
  assert.equal(h.store.settings().lidarrKey, "test-key");
  assert.equal(
    (await save({ lidarrURL: "https://other.test", lidarrKey: "" })).statusCode,
    400,
  );
  assert.equal(calls, 2);
  h.upstream.lidarrOptions = async () => {
    throw new UpstreamError("upstream_protocol", 502);
  };
  assert.equal(
    (await save({ lidarrURL: "https://lidarr.test" })).statusCode,
    502,
  );
  assert.equal(
    (await save({ jellyfinURL: "https://jellyfin-new.test" })).statusCode,
    200,
  );
  assert.equal(h.store.settings().jellyfinURL, "https://jellyfin-new.test");
  assert.equal(h.store.settings().lidarrURL, "https://lidarr.test");
});

test("Discover separates candidate generation from fail-closed Jellyfin filtering", async (t) => {
  let mode = "empty";
  let jellyCalls = 0;
  const fetcher: typeof fetch = async (input) => {
    assert.ok(input instanceof URL);
    const json = <T>(body: T, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    if (input.hostname === "ws.audioscrobbler.com") {
      if (mode === "lastfm401") return json({}, 401);
      if (mode === "lastfmApi")
        return json({ error: 10, message: "private-upstream-text" });
      switch (input.searchParams.get("method")) {
        case "user.getTopArtists":
          return json({
            topartists: { artist: mode === "empty" ? [] : [{ name: "Seed" }] },
          });
        case "artist.getSimilar":
          return json({ similarartists: { artist: [{ name: "Similar" }] } });
        case "artist.getTopAlbums":
          return json({ topalbums: { album: [{ name: "Album" }] } });
        default:
          throw new Error("Unexpected Last.fm method");
      }
    }
    if (input.hostname === "musicbrainz.org") {
      if (mode === "musicbrainz401") return json({}, 401);
      return json({
        "release-groups": [
          {
            id: identities.album.releaseGroupMBID,
            title: "Album",
            "artist-credit": [
              { artist: { id: identities.album.artistMBID, name: "Similar" } },
            ],
          },
        ],
        count: 1,
      });
    }
    assert.equal(input.hostname, "jelly.test");
    assert.equal(input.pathname, "/Items");
    jellyCalls++;
    if (mode === "owned")
      return json({
        Items: [
          {
            Id: "owned",
            Name: "Album",
            ProviderIds: {
              MusicBrainzReleaseGroup: identities.album.releaseGroupMBID,
            },
          },
        ],
        TotalRecordCount: 1,
      });
    if (mode === "partial" && input.searchParams.get("startIndex") === "0")
      return json({
        Items: Array.from({ length: 500 }, (_, i) => ({
          Id: `item-${i}`,
          Name: "Album",
          ProviderIds: {
            MusicBrainzReleaseGroup: identities.album.releaseGroupMBID,
          },
        })),
        TotalRecordCount: 501,
      });
    return json({ message: "private-upstream-text" }, 401);
  };
  const h = await harness(fetcher);
  t.after(async () => {
    await h.app.close();
    h.store.close();
  });
  const session = await h.login("admin", "admin-password");
  const headers = webHeaders(session);
  const userID = session.json().user.id;
  h.store.putSecret(
    "installation",
    "settings",
    JSON.stringify({
      ...h.store.settings(),
      jellyfinURL: "https://jelly.test",
    }),
  );
  h.store.putSecret(
    userID,
    "jellyfin",
    JSON.stringify({ token: "synthetic-token", userID: "synthetic-user" }),
  );
  h.store.putSecret(
    userID,
    "lastfm",
    JSON.stringify({ username: "synthetic-user", apiKey: "synthetic-key" }),
  );
  const load = () => h.inject({ url: "/api/v1/recommendations", headers });
  const empty = await load();
  assert.equal(empty.statusCode, 200);
  assert.deepEqual(empty.json(), {
    items: [],
    source: "lastfm",
    emptyReason: "no_candidates",
  });
  assert.equal(
    jellyCalls,
    0,
    "No ownership check is needed without candidates",
  );
  for (mode of ["candidates", "partial"]) {
    const denied = await load();
    assert.equal(denied.statusCode, 502);
    assert.equal(denied.json().error.code, "jellyfin_filter_failed");
    assert.match(denied.json().error.message, /Jellyfin library filtering/);
    assert.match(denied.json().error.message, /HTTP 401/);
    assert.equal(
      denied.json().items,
      undefined,
      "Never publish unverified or partially filtered candidates",
    );
  }
  for (mode of ["lastfm401", "lastfmApi", "musicbrainz401"]) {
    const before: number = jellyCalls;
    const denied = await load();
    assert.equal(denied.statusCode, 502);
    assert.match(
      denied.json().error.message,
      mode === "musicbrainz401" ? /MusicBrainz/ : /Last.fm/,
    );
    assert.equal(denied.json().items, undefined);
    assert.doesNotMatch(
      denied.body,
      /private-upstream-text|synthetic-key|synthetic-token/,
    );
    assert.equal(
      jellyCalls,
      before,
      "Candidate-source failures must not be blamed on Jellyfin",
    );
  }
  mode = "owned";
  assert.deepEqual((await load()).json(), {
    items: [],
    source: "lastfm",
    emptyReason: "all_excluded",
  });
  await h.inject({
    method: "DELETE",
    url: "/api/v1/connections/jellyfin",
    headers,
  });
  mode = "candidates";
  const before = jellyCalls;
  const unfiltered = await load();
  assert.equal(unfiltered.statusCode, 200);
  assert.equal(
    unfiltered.json().items[0].id,
    identities.album.releaseGroupMBID,
  );
  assert.equal(unfiltered.json().emptyReason, null);
  assert.equal(jellyCalls, before);
});

test("saved Jellyfin tokens use modern authorization after login and stay user-scoped", async (t) => {
  let itemCalls = 0;
  const h = await harness(async (input, init) => {
    assert.ok(input instanceof URL);
    assert.equal(input.hostname, "jelly.test");
    assert.equal(init?.redirect, "manual");
    if (input.pathname === "/Users/AuthenticateByName")
      return Response.json({
        AccessToken: "issued-token",
        User: { Id: "remote-user-id" },
      });
    assert.equal(input.pathname, "/Items");
    assert.equal(input.searchParams.get("userId"), "remote-user-id");
    assert.equal(input.searchParams.has("api_key"), false);
    const headers = new Headers(init?.headers);
    // Jellyfin 12 disables legacy X-Emby-Token authentication by default.
    if (headers.get("Authorization") !== 'MediaBrowser Token="issued-token"')
      return new Response(null, { status: 401 });
    assert.equal(headers.has("X-Emby-Token"), false);
    itemCalls++;
    return Response.json({
      Items: [{ Id: "one", Name: "Saved-token album" }],
      TotalRecordCount: 1,
    });
  });
  t.after(async () => {
    await h.app.close();
    h.store.close();
  });
  h.store.putSecret(
    "installation",
    "settings",
    JSON.stringify({
      ...h.store.settings(),
      jellyfinURL: "https://jelly.test",
    }),
  );
  const headers = webHeaders(await h.login("admin", "admin-password"));
  assert.equal(
    (
      await h.inject({
        method: "PUT",
        url: "/api/v1/connections/jellyfin",
        headers,
        payload: { username: "remote", password: "synthetic-password" },
      })
    ).statusCode,
    200,
  );
  const library = await h.inject({ url: "/api/v1/library", headers });
  assert.equal(library.statusCode, 200);
  assert.equal(library.json().items[0].title, "Saved-token album");
  assert.doesNotMatch(library.body, /issued-token|remote-user-id/);
  await h.inject({
    method: "POST",
    url: "/api/v1/admin/users",
    headers,
    payload: {
      username: "member",
      password: "member-password",
      role: "member",
    },
  });
  const member = webHeaders(await h.login("member", "member-password"));
  assert.equal(
    (await h.inject({ url: "/api/v1/library", headers: member })).statusCode,
    409,
  );
  assert.equal(itemCalls, 1);
});

test("Jellyfin ownership failure prevents acquisition creation", async (t) => {
  const h = await harness();
  t.after(async () => {
    await h.app.close();
    h.store.close();
  });
  const session = await h.login("admin", "admin-password");
  const headers = webHeaders(session);
  h.store.putSecret(
    "installation",
    "settings",
    JSON.stringify({
      ...h.store.settings(),
      jellyfinURL: "https://jelly.test",
      lidarrURL: "https://lidarr.test",
      lidarrKey: "synthetic-key",
    }),
  );
  h.store.putSecret(
    session.json().user.id,
    "jellyfin",
    JSON.stringify({ token: "synthetic-token", userID: "remote-user" }),
  );
  h.upstream.jellyfinLibrary = async () => {
    throw new UpstreamError("upstream_auth", 502);
  };
  assert.equal(
    (
      await h.inject({
        method: "POST",
        url: "/api/v1/requests",
        headers,
        payload: { ...identities.album, confirmed: true },
      })
    ).statusCode,
    502,
  );
  assert.deepEqual(
    h.store.db.prepare("SELECT COUNT(*) AS count FROM acquisitions").get(),
    { count: 0 },
  );
});

test("fixture mode is explicit and rejects service credentials before upstream calls", async (t) => {
  const store = makeStore();
  const upstream = new FakeUpstreams();
  const { app } = await buildApp({
    store,
    upstream,
    origin: "https://leerr.test",
    setupToken: "fixture",
    fixturePreview: true,
    secure: false,
  });
  t.after(async () => {
    await app.close();
    store.close();
  });
  assert.equal(
    (await app.inject({ url: "/api/v1/setup", headers: host })).json()
      .fixturePreview,
    true,
  );
  for (const url of [
    "/api/v1/connections/jellyfin",
    "/api/v1/connections/lastfm",
    "/api/v1/admin/settings",
  ]) {
    const response = await app.inject({
      method: "PUT",
      url,
      headers: origin,
      payload: {},
    });
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().error.code, "fixture_preview");
  }
  assert.equal(upstream.loginCalls, 0);
  assert.equal(
    z
      .object({ count: z.number() })
      .parse(store.db.prepare("SELECT COUNT(*) AS count FROM secrets").get())
      .count,
    0,
  );
});

test("normal mode reports missing or failed library access without fixture substitution", async (t) => {
  const h = await harness();
  t.after(async () => {
    await h.app.close();
    h.store.close();
  });
  assert.equal(
    (await h.inject({ url: "/api/v1/setup" })).json().fixturePreview,
    false,
  );
  const login = await h.login("admin", "admin-password");
  const headers = webHeaders(login);
  const missing = await h.inject({ url: "/api/v1/library", headers });
  assert.equal(missing.statusCode, 409);
  assert.equal(missing.json().error.code, "connection_required");
  const user = z
    .object({ id: z.string() })
    .parse(
      h.store.db.prepare("SELECT id FROM users WHERE username='admin'").get(),
    );
  h.store.putSecret(
    "installation",
    "settings",
    JSON.stringify({
      ...h.store.settings(),
      jellyfinURL: "https://jelly.test",
    }),
  );
  h.store.putSecret(
    user.id,
    "jellyfin",
    JSON.stringify({ token: "test-only", userID: "user" }),
  );
  h.upstream.jellyfinLibrary = async () => {
    throw new UpstreamError("upstream_auth", 502);
  };
  const failed = await h.inject({ url: "/api/v1/library", headers });
  assert.equal(failed.statusCode, 502);
  assert.equal(failed.json().error.code, "upstream_auth");
  assert.equal(failed.json().items, undefined);
});
