import assert from "node:assert/strict";
import test from "node:test";
import { hashPassword } from "../passwords.ts";
import { plexIDs } from "../testing.ts";
import { harness, ORIGIN, PASSWORD, SETUP_TOKEN } from "./harness.ts";

test("setup is one-shot, token-protected and creates an administrator", async (t) => {
  const h = await harness(t);
  assert.deepEqual((await h.call("GET", "/api/v1/setup")).json(), { required: true, fixturePreview: false });
  const attempt = { token: "wrong", username: "root", password: PASSWORD };
  assert.equal((await h.call("POST", "/api/v1/setup", null, attempt)).status, 403);
  assert.equal((await h.call("POST", "/api/v1/setup", null, { ...attempt, token: SETUP_TOKEN })).status, 200);
  assert.equal((await h.call("POST", "/api/v1/setup", null, { ...attempt, token: SETUP_TOKEN })).status, 409);
  const admin = await h.login("root");
  const me = (await h.call("GET", "/api/v1/me", admin)).json();
  assert.equal(me.user.role, "admin");
  assert.ok(h.events.some((entry) => entry.event === "setup_completed"));
});

test("host, origin and HTTPS are enforced before any route runs", async (t) => {
  const h = await harness(t, { secure: true });
  const wrongHost = await h.call("GET", "/api/v1/setup", null, undefined, { host: "evil.test" });
  assert.equal(wrongHost.json().error.code, "invalid_host");
  const plain = await h.call("GET", "/api/v1/setup");
  assert.equal(plain.json().error.code, "https_required");
  const h2 = await harness(t);
  const crossSite = await h2.call("POST", "/api/v1/sessions", null, { username: "a", password: "b" }, { origin: "https://evil.test" });
  assert.equal(crossSite.status, 403);
  const sameSite = await h2.call("POST", "/api/v1/sessions", null, { username: "a", password: "b" }, { origin: ORIGIN });
  assert.equal(sameSite.status, 401);
  assert.equal((await h2.call("GET", "/health", null, undefined, { host: "anything" })).status, 200);
});

test("web sessions use a strict HttpOnly cookie and require the CSRF token for writes", async (t) => {
  const h = await harness(t);
  await h.user("alice");
  const response = await h.call("POST", "/api/v1/sessions", null, { username: "ALICE", password: PASSWORD });
  const cookie = String(response.headers["set-cookie"]);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.equal(response.json().token, undefined);
  const alice = await h.login("alice");
  const noToken = await h.call("PUT", "/api/v1/connections/lastfm", { ...alice, csrf: "" }, { username: "a", apiKey: "b" });
  assert.equal(noToken.json().error.code, "csrf");
  const withToken = await h.call("PUT", "/api/v1/connections/lastfm", alice, { username: "a", apiKey: "lastfm-key" });
  assert.equal(withToken.status, 200);
});

test("secure deployments need forwarded HTTPS from a trusted proxy and use a __Host- cookie", async (t) => {
  const h = await harness(t, { secure: true, trustProxy: ["127.0.0.1"] });
  h.store.createUser("alice", await hashPassword(PASSWORD), "member", 0);
  const body = { username: "alice", password: PASSWORD };
  assert.equal((await h.call("POST", "/api/v1/sessions", null, body)).json().error.code, "https_required");
  const login = await h.call("POST", "/api/v1/sessions", null, body, { "x-forwarded-proto": "https" });
  assert.equal(login.status, 200);
  assert.match(String(login.headers["set-cookie"]), /^__Host-leerr=.*Secure/);
  const untrusted = await harness(t, { secure: true });
  untrusted.store.createUser("alice", await hashPassword(PASSWORD), "member", 0);
  const spoofed = await untrusted.call("POST", "/api/v1/sessions", null, body, { "x-forwarded-proto": "https" });
  assert.equal(spoofed.json().error.code, "https_required");
});

test("secure deployments work end to end after sign-in: cookie reads and CSRF-protected writes over HTTPS", async (t) => {
  const h = await harness(t, { secure: true, trustProxy: ["127.0.0.1"] });
  h.store.createUser("alice", await hashPassword(PASSWORD), "member", 0);
  const https = { "x-forwarded-proto": "https", "x-forwarded-for": "198.51.100.7" };
  const login = await h.call("POST", "/api/v1/sessions", null, { username: "alice", password: PASSWORD }, https);
  const cookie = String(login.headers["set-cookie"]).split(";", 1)[0];
  const client = { cookie, csrf: login.json().csrf, userID: login.json().user.id };
  assert.equal((await h.call("GET", "/api/v1/me", client, undefined, https)).status, 200);
  const write = await h.call("PUT", "/api/v1/connections/lastfm", client, { username: "a", apiKey: "lastfm-key" }, https);
  assert.equal(write.status, 200);
  assert.equal((await h.call("GET", "/api/v1/me", client)).json().error.code, "https_required");
  // A proxy that is not trusted cannot claim HTTPS for a client.
  const other = await harness(t, { secure: true, trustProxy: ["10.9.9.9"] });
  other.store.createUser("alice", await hashPassword(PASSWORD), "member", 0);
  const spoofed = await other.call("POST", "/api/v1/sessions", null, { username: "alice", password: PASSWORD }, https);
  assert.equal(spoofed.json().error.code, "https_required");
});

test("a trusted proxy that drops X-Forwarded-For is reported once", async (t) => {
  const h = await harness(t, { trustProxy: ["127.0.0.1"] });
  await h.call("GET", "/api/v1/setup");
  await h.call("GET", "/api/v1/setup");
  assert.equal(h.events.filter((entry) => entry.event === "proxy_missing_forwarded_for").length, 1);
});

test("native bearer sessions cannot be used as cookies and vice versa", async (t) => {
  const h = await harness(t);
  await h.user("alice");
  const native = (
    await h.call("POST", "/api/v1/sessions", null, { username: "alice", password: PASSWORD, device: "native", name: "Phone" })
  ).json();
  assert.equal(native.csrf, null);
  assert.equal(
    (await h.call("GET", "/api/v1/me", null, undefined, { authorization: `Bearer ${native.token}` })).status,
    200,
  );
  assert.equal((await h.call("GET", "/api/v1/me", null, undefined, { cookie: `leerr=${native.token}` })).status, 401);
  // And a web session's cookie token does not work as a bearer token.
  const web = await h.login("alice");
  const webToken = decodeURIComponent(web.cookie.split("=", 2)[1]);
  assert.equal((await h.call("GET", "/api/v1/me", null, undefined, { authorization: `Bearer ${webToken}` })).status, 401);
  // Bearer requests need no CSRF token: they cannot be forged by a browser.
  const write = await h.call("DELETE", "/api/v1/sessions/current", null, undefined, { authorization: `Bearer ${native.token}` });
  assert.equal(write.status, 200);
  assert.equal((await h.call("GET", "/api/v1/me", null, undefined, { authorization: `Bearer ${native.token}` })).status, 401);
});

test("repeated failed logins lock the account even across client addresses, for 15 minutes after the tenth", async (t) => {
  const h = await harness(t, { trustProxy: ["127.0.0.1"] });
  await h.user("alice");
  const from = (address: string) => ({ "x-forwarded-for": address });
  await h.call("POST", "/api/v1/sessions", null, { username: "alice", password: "wrong password" }, from("10.0.0.100"));
  h.clock.advance(14 * 60_000);
  for (let attempt = 0; attempt < 9; attempt++)
    await h.call("POST", "/api/v1/sessions", null, { username: "alice", password: "wrong password" }, from(`10.0.0.${attempt}`));
  const locked = await h.call("POST", "/api/v1/sessions", null, { username: "alice", password: PASSWORD }, from("10.0.1.1"));
  assert.equal(locked.status, 429);
  assert.match(locked.json().error.message, /this account.*15 minutes/);
  h.clock.advance(14 * 60_000);
  assert.equal(
    (await h.call("POST", "/api/v1/sessions", null, { username: "alice", password: PASSWORD }, from("10.0.1.2"))).status,
    429,
    "the lock lasts 15 minutes from the tenth failure, not from the first",
  );
  h.clock.advance(2 * 60_000);
  const later = await h.call("POST", "/api/v1/sessions", null, { username: "alice", password: PASSWORD }, from("10.0.1.3"));
  assert.equal(later.status, 200);
});

test("a browser that signed in before is not locked out by strangers' guesses", async (t) => {
  const h = await harness(t, { trustProxy: ["127.0.0.1"] });
  await h.user("alice");
  const first = await h.call("POST", "/api/v1/sessions", null, { username: "alice", password: PASSWORD }, { "x-forwarded-for": "192.0.2.1" });
  const device = String(first.headers["set-cookie"])
    .split(/,(?=\s*leerr)/)
    .find((cookie) => cookie.trim().startsWith("leerr-device-"));
  assert.ok(device, "a known-device cookie is issued on sign-in");
  assert.match(device, /HttpOnly/);
  const deviceCookie = device.trim().split(";", 1)[0];
  // Native clients carry the token in the body instead of a cookie.
  const native = (
    await h.call("POST", "/api/v1/sessions", null, { username: "alice", password: PASSWORD, device: "native", name: "Phone" }, { "x-forwarded-for": "192.0.2.50" })
  ).json();
  assert.match(native.deviceToken, /^[A-Za-z0-9_-]{43}$/);
  for (let attempt = 0; attempt < 10; attempt++)
    await h.call("POST", "/api/v1/sessions", null, { username: "alice", password: "guess" }, { "x-forwarded-for": `203.0.113.${attempt}` });
  const nativeAgain = await h.call(
    "POST",
    "/api/v1/sessions",
    null,
    { username: "alice", password: PASSWORD, device: "native", name: "Phone", deviceToken: native.deviceToken },
    { "x-forwarded-for": "192.0.2.50" },
  );
  assert.equal(nativeAgain.status, 200);
  const stranger = await h.call("POST", "/api/v1/sessions", null, { username: "alice", password: PASSWORD }, { "x-forwarded-for": "203.0.113.99" });
  assert.equal(stranger.status, 429);
  const owner = await h.call(
    "POST",
    "/api/v1/sessions",
    null,
    { username: "alice", password: PASSWORD },
    { "x-forwarded-for": "192.0.2.1", cookie: deviceCookie },
  );
  assert.equal(owner.status, 200);
  // A known device has its own budget: guessing from it still locks it.
  for (let attempt = 0; attempt < 10; attempt++)
    await h.call("POST", "/api/v1/sessions", null, { username: "alice", password: "guess" }, { "x-forwarded-for": `198.51.100.${attempt}`, cookie: deviceCookie });
  const deviceLocked = await h.call("POST", "/api/v1/sessions", null, { username: "alice", password: PASSWORD }, { "x-forwarded-for": "198.51.100.99", cookie: deviceCookie });
  assert.equal(deviceLocked.status, 429);
});

test("the sign-in route's address limit says how long to wait", async (t) => {
  const h = await harness(t);
  for (let attempt = 0; attempt < 10; attempt++) await h.call("POST", "/api/v1/sessions", null, { username: `u${attempt}`, password: "x" });
  const limited = await h.call("POST", "/api/v1/sessions", null, { username: "u", password: "x" });
  assert.equal(limited.status, 429);
  assert.match(limited.json().error.message, /15 minutes/);
});

test("members cannot reach administration, including through encoded paths", async (t) => {
  const h = await harness(t);
  const member = await h.user("mia");
  assert.equal((await h.call("GET", "/api/v1/admin/users", member)).status, 403);
  assert.equal((await h.call("GET", "/api/v1/admin/%75sers", member)).status, 403);
  const encoded = await h.call("GET", "/%61pi/v1/me", member);
  assert.equal(encoded.status, 200);
  assert.equal(encoded.headers["cache-control"], "no-store");
});

test("fixture preview refuses credentials however the path is spelled", async (t) => {
  const h = await harness(t, { fixturePreview: true });
  const admin = await h.user("root", "admin");
  h.configure();
  for (const path of ["/api/v1/connections/plex/links", "/api/v1/connections/%70lex/links"]) {
    const response = await h.call("POST", path, admin, { mode: "own" });
    assert.equal(response.json().error.code, "fixture_preview");
  }
  const settings = await h.call("PUT", "/api/v1/admin/settings/%70lex", admin, { url: "https://other.test" });
  assert.equal(settings.json().error.code, "fixture_preview");
});

test("sessions can be listed and revoked individually; revocation ends the session", async (t) => {
  const h = await harness(t);
  await h.user("alice");
  const first = await h.login("alice");
  const second = await h.login("alice");
  const list = (await h.call("GET", "/api/v1/sessions", first)).json().items;
  assert.equal(list.length, 3);
  const other = list.find((item: { current: boolean; id: string }) => !item.current);
  assert.equal((await h.call("DELETE", `/api/v1/sessions/${other.id}`, first)).status, 200);
  assert.equal((await h.call("DELETE", "/api/v1/sessions/unknown", first)).status, 404);
  assert.equal((await h.call("DELETE", "/api/v1/sessions/current", second)).status, 200);
  assert.equal((await h.call("GET", "/api/v1/me", second)).status, 401);
});

test("sessions expire after thirty days", async (t) => {
  const h = await harness(t);
  const alice = await h.user("alice");
  h.clock.advance(30 * 86_400_000 + 1);
  assert.equal((await h.call("GET", "/api/v1/me", alice)).status, 401);
});

test("an administrator's password reset or re-enable lifts the account lock", async (t) => {
  const h = await harness(t, { trustProxy: ["127.0.0.1"] });
  const admin = await h.user("root", "admin");
  await h.user("mia");
  const users = (await h.call("GET", "/api/v1/admin/users", admin)).json().items;
  const miaID = users.find((user: { username: string; id: string }) => user.username === "mia").id;
  for (let attempt = 0; attempt < 10; attempt++)
    await h.call("POST", "/api/v1/sessions", null, { username: "mia", password: "forgotten" }, { "x-forwarded-for": `10.1.0.${attempt}` });
  assert.equal((await h.call("POST", "/api/v1/sessions", null, { username: "mia", password: PASSWORD }, { "x-forwarded-for": "10.2.0.1" })).status, 429);
  assert.equal((await h.call("PATCH", `/api/v1/admin/users/${miaID}`, admin, { password: "a fresh password" })).status, 200);
  const after = await h.call("POST", "/api/v1/sessions", null, { username: "mia", password: "a fresh password" }, { "x-forwarded-for": "10.2.0.2" });
  assert.equal(after.status, 200);
});

test("people change their own password; other devices are signed out, this one stays", async (t) => {
  const h = await harness(t);
  const alice = await h.user("alice");
  const other = await h.login("alice");
  const wrong = await h.call("PUT", "/api/v1/me/password", alice, { current: "not it", password: "a brand new password" });
  assert.equal(wrong.status, 403);
  assert.equal(wrong.json().error.code, "wrong_password");
  assert.equal((await h.call("PUT", "/api/v1/me/password", alice, { current: PASSWORD, password: "short" })).status, 400);
  assert.equal((await h.call("PUT", "/api/v1/me/password", alice, { current: PASSWORD, password: "a brand new password" })).status, 200);
  assert.equal((await h.call("GET", "/api/v1/me", alice)).status, 200);
  assert.equal((await h.call("GET", "/api/v1/me", other)).status, 401);
  await h.login("alice", "a brand new password");
  assert.ok(h.events.some((entry) => entry.event === "password_changed"));
  // Guessing the current password through this route is throttled too.
  for (let attempt = 0; attempt < 10; attempt++)
    await h.call("PUT", "/api/v1/me/password", alice, { current: `guess ${attempt}`, password: "yet another password" });
  assert.equal(
    (await h.call("PUT", "/api/v1/me/password", alice, { current: "a brand new password", password: "yet another password" })).status,
    429,
  );
});

test("a response is withheld if the session is revoked while it is being prepared", async (t) => {
  const h = await harness(t);
  h.configure();
  const admin = await h.user("root", "admin", "admin");
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const library = h.upstream.plexLibrary.bind(h.upstream);
  h.upstream.plexLibrary = async (access, query) => {
    await held;
    return library(access, query);
  };
  const pending = h.call("GET", "/api/v1/library", admin);
  await new Promise((resolve) => setImmediate(resolve));
  h.store.deleteUserSessions(admin.userID);
  release();
  const response = await pending;
  assert.equal(response.status, 401);
  assert.equal(response.body.includes("Evening Signals"), false);
});

test("signed-in people get their own request budget, so a cover grid cannot block playback", async (t) => {
  const h = await harness(t);
  h.configure();
  const admin = await h.user("root", "admin", "admin");
  for (let index = 0; index < 320; index++) await h.call("GET", `/api/v1/artwork/${plexIDs.album}?size=small`, admin);
  assert.equal((await h.call("POST", "/api/v1/stream-tickets", admin, { trackID: plexIDs.track })).status, 200);
  const other = await h.user("mia", "member", "member");
  assert.equal((await h.call("GET", "/api/v1/me", other)).status, 200);
});

test("administrators manage users; disabling or a new password ends sessions; one admin must remain", async (t) => {
  const h = await harness(t);
  const admin = await h.user("root", "admin");
  assert.equal(
    (await h.call("POST", "/api/v1/admin/users", admin, { username: "mia", password: PASSWORD, role: "member" })).status,
    200,
  );
  assert.equal(
    (await h.call("POST", "/api/v1/admin/users", admin, { username: "MIA", password: PASSWORD, role: "member" })).json().error.code,
    "duplicate_user",
  );
  const mia = await h.login("mia");
  const users = (await h.call("GET", "/api/v1/admin/users", admin)).json().items;
  const miaID = users.find((user: { username: string; id: string }) => user.username === "mia").id;
  assert.equal((await h.call("PATCH", `/api/v1/admin/users/${miaID}`, admin, { disabled: true })).status, 200);
  assert.equal((await h.call("GET", "/api/v1/me", mia)).status, 401);
  assert.equal((await h.call("POST", "/api/v1/sessions", null, { username: "mia", password: PASSWORD })).status, 401);
  assert.equal((await h.call("PATCH", `/api/v1/admin/users/${miaID}`, admin, { disabled: false, password: "another password" })).status, 200);
  await h.login("mia", "another password");
  const last = await h.call("PATCH", `/api/v1/admin/users/${admin.userID}`, admin, { role: "member" });
  assert.equal(last.json().error.code, "last_admin");
  assert.equal((await h.call("PATCH", `/api/v1/admin/users/${miaID}`, admin, { role: "admin" })).status, 200);
  assert.equal((await h.call("PATCH", `/api/v1/admin/users/${admin.userID}`, admin, { role: "member" })).status, 200);
  assert.equal((await h.call("GET", "/api/v1/admin/users", admin)).status, 403);
});

test("an administrator who sets their own password here stays signed in, and only their other devices end", async (t) => {
  const h = await harness(t);
  const admin = await h.user("root", "admin");
  const other = await h.login("root");
  const changed = await h.call("PATCH", `/api/v1/admin/users/${admin.userID}`, admin, { password: "a new admin password" });
  assert.equal(changed.status, 200);
  assert.match(String(changed.headers["set-cookie"]), /leerr-device-[0-9a-f]{16}=/, "this browser stays a known device");
  assert.equal((await h.call("GET", "/api/v1/me", admin)).status, 200);
  assert.equal((await h.call("GET", "/api/v1/me", other)).status, 401);
});

/** The known-device cookie a successful sign-in set, if any. */
const deviceCookieOf = (response: { headers: Record<string, string | string[] | number | undefined> }) =>
  String(response.headers["set-cookie"])
    .split(/,(?=\s*leerr)/)
    .find((cookie) => cookie.trim().startsWith("leerr-device-"))
    ?.trim()
    .split(";", 1)[0];

test("on a shared browser, each account keeps its own known-device cookie", async (t) => {
  const h = await harness(t, { trustProxy: ["127.0.0.1"] });
  await h.user("alice");
  await h.user("bob");
  // An empty cookie header is the same as none.
  const signIn = (username: string, cookie = "") =>
    h.call("POST", "/api/v1/sessions", null, { username, password: PASSWORD }, { "x-forwarded-for": "192.0.2.1", cookie });
  const alice = deviceCookieOf(await signIn("alice"));
  const bob = deviceCookieOf(await signIn("bob", alice));
  assert.ok(alice && bob);
  assert.notEqual(alice.split("=", 1)[0], bob.split("=", 1)[0], "bob's sign-in does not replace alice's cookie");
  const jar = `${alice}; ${bob}`;
  assert.equal(deviceCookieOf(await signIn("alice", jar)), undefined, "alice is recognised, so no new device is issued");
  for (let attempt = 0; attempt < 10; attempt++)
    await h.call("POST", "/api/v1/sessions", null, { username: "alice", password: "guess" }, { "x-forwarded-for": `203.0.113.${attempt}` });
  assert.equal((await signIn("alice", jar)).status, 200, "strangers' guesses do not lock alice out of the family browser");
});

test("known devices are forgotten when the password changes or the account is disabled, and capped per account", async (t) => {
  const h = await harness(t, { trustProxy: ["127.0.0.1"] });
  const admin = await h.user("root", "admin");
  await h.user("alice");
  const signIn = (headers: Record<string, string> = {}) =>
    h.call("POST", "/api/v1/sessions", null, { username: "alice", password: PASSWORD }, { "x-forwarded-for": "192.0.2.1", ...headers });
  const device = deviceCookieOf(await signIn());
  assert.ok(device);
  const aliceID = h.store.userByName("alice")?.id ?? "";
  assert.equal(await (async () => (await signIn({ cookie: device })).status)(), 200);
  assert.equal((await h.call("PATCH", `/api/v1/admin/users/${aliceID}`, admin, { password: "a fresh password" })).status, 200);
  assert.equal(h.store.db.prepare("SELECT COUNT(*) FROM devices WHERE userID=?").pluck().get(aliceID), 0, "a reset forgets every device");
  // An old device cookie no longer has its own budget: it shares the account's.
  for (let attempt = 0; attempt < 10; attempt++)
    await h.call("POST", "/api/v1/sessions", null, { username: "alice", password: "guess" }, { "x-forwarded-for": `198.51.100.${attempt}`, cookie: device });
  assert.equal(
    (await h.call("POST", "/api/v1/sessions", null, { username: "alice", password: "a fresh password" }, { "x-forwarded-for": "192.0.2.2" })).status,
    429,
  );
  for (let index = 0; index < 25; index++) h.store.createDevice(aliceID, index);
  assert.equal(h.store.db.prepare("SELECT COUNT(*) FROM devices WHERE userID=?").pluck().get(aliceID), 20);
  assert.equal((await h.call("PATCH", `/api/v1/admin/users/${aliceID}`, admin, { disabled: true })).status, 200);
  assert.equal(h.store.db.prepare("SELECT COUNT(*) FROM devices WHERE userID=?").pluck().get(aliceID), 0);
});

test("one account's device token gives no extra attempts against another account", async (t) => {
  const h = await harness(t, { trustProxy: ["127.0.0.1"] });
  await h.user("mallory");
  await h.user("alice");
  const mine = deviceCookieOf(
    await h.call("POST", "/api/v1/sessions", null, { username: "mallory", password: PASSWORD }, { "x-forwarded-for": "203.0.113.1" }),
  );
  assert.ok(mine);
  for (let attempt = 0; attempt < 10; attempt++)
    await h.call("POST", "/api/v1/sessions", null, { username: "alice", password: "guess" }, { "x-forwarded-for": `203.0.113.${attempt + 10}`, cookie: mine });
  const locked = await h.call("POST", "/api/v1/sessions", null, { username: "alice", password: PASSWORD }, { "x-forwarded-for": "203.0.113.50" });
  assert.equal(locked.status, 429, "the guesses counted against alice's own lock");
});

test("concurrent guesses cannot get past the account lock", async (t) => {
  const h = await harness(t, { trustProxy: ["127.0.0.1"] });
  await h.user("alice");
  const statuses = await Promise.all(
    Array.from({ length: 15 }, (_, attempt) =>
      h.call("POST", "/api/v1/sessions", null, { username: "alice", password: "guess" }, { "x-forwarded-for": `10.3.0.${attempt}` }),
    ),
  ).then((responses) => responses.map((response) => response.status));
  assert.equal(statuses.filter((status) => status === 401).length, 10);
  assert.equal(statuses.filter((status) => status === 429).length, 5);
});

test("rate limits are per person behind a shared address", async (t) => {
  const h = await harness(t);
  const alice = await h.user("alice");
  const bob = await h.user("bob");
  let last = 200;
  let message = "";
  for (let index = 0; index < 301; index++) {
    const response = await h.call("GET", "/api/v1/me", alice);
    last = response.status;
    if (last === 429) message = response.json().error.message;
  }
  assert.equal(last, 429, "alice used up her own budget");
  assert.equal(message, "Too many requests. Try again in a minute.");
  assert.equal((await h.call("GET", "/api/v1/me", bob)).status, 200, "bob, at the same address, did not");
});

test("wrong current passwords lock password changes before the route's own limit", async (t) => {
  const h = await harness(t);
  const alice = await h.user("alice");
  for (let attempt = 0; attempt < 5; attempt++)
    assert.equal((await h.call("PUT", "/api/v1/me/password", alice, { current: `guess ${attempt}`, password: "a brand new password" })).status, 403);
  const locked = await h.call("PUT", "/api/v1/me/password", alice, { current: PASSWORD, password: "a brand new password" });
  assert.equal(locked.status, 429);
  assert.equal(locked.json().error.code, "login_locked");
});

test("re-enabling an account also lifts its sign-in lock", async (t) => {
  const h = await harness(t, { trustProxy: ["127.0.0.1"] });
  const admin = await h.user("root", "admin");
  await h.user("mia");
  const miaID = h.store.userByName("mia")?.id ?? "";
  for (let attempt = 0; attempt < 10; attempt++)
    await h.call("POST", "/api/v1/sessions", null, { username: "mia", password: "forgotten" }, { "x-forwarded-for": `10.4.0.${attempt}` });
  await h.call("PATCH", `/api/v1/admin/users/${miaID}`, admin, { disabled: true });
  assert.equal((await h.call("PATCH", `/api/v1/admin/users/${miaID}`, admin, { disabled: false })).status, 200);
  assert.equal(
    (await h.call("POST", "/api/v1/sessions", null, { username: "mia", password: PASSWORD }, { "x-forwarded-for": "10.4.1.1" })).status,
    200,
  );
});
