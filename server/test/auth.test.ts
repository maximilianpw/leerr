import assert from "node:assert/strict";
import test from "node:test";
import { hashPassword } from "../passwords.ts";
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
  // Bearer requests need no CSRF token: they cannot be forged by a browser.
  const write = await h.call("DELETE", "/api/v1/sessions/current", null, undefined, { authorization: `Bearer ${native.token}` });
  assert.equal(write.status, 200);
  assert.equal((await h.call("GET", "/api/v1/me", null, undefined, { authorization: `Bearer ${native.token}` })).status, 401);
});

test("repeated failed logins lock the account even across client addresses", async (t) => {
  const h = await harness(t, { trustProxy: ["127.0.0.1"] });
  await h.user("alice");
  const from = (address: string) => ({ "x-forwarded-for": address });
  for (let attempt = 0; attempt < 10; attempt++)
    await h.call("POST", "/api/v1/sessions", null, { username: "alice", password: "wrong password" }, from(`10.0.0.${attempt}`));
  const locked = await h.call("POST", "/api/v1/sessions", null, { username: "alice", password: PASSWORD }, from("10.0.1.1"));
  assert.match(locked.json().error.message, /this account/);
  h.clock.advance(16 * 60_000);
  const later = await h.call("POST", "/api/v1/sessions", null, { username: "alice", password: PASSWORD }, from("10.0.1.2"));
  assert.equal(later.status, 200);
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
  for (const path of ["/api/v1/connections/jellyfin", "/api/v1/connections/%6Aellyfin"]) {
    const response = await h.call("PUT", path, admin, { username: "admin", password: "jelly-password" });
    assert.equal(response.json().error.code, "fixture_preview");
  }
  const settings = await h.call("PUT", "/api/v1/admin/settings/%6Aellyfin", admin, { url: "https://other.test" });
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
