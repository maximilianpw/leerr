import assert from "node:assert/strict";
import test from "node:test";
import { plexSecret } from "../store.ts";
import { reconnectError } from "../upstream/plex.ts";
import { harness } from "./harness.ts";

for (const { change, stage } of ["server", "account", "disconnect"].flatMap((change) =>
  ["request", "renewal", "identity"].map((stage) => ({ change, stage })),
)) {
  test(`Plex credentials stay bound to their link after ${change} during ${stage}`, async (t) => {
    const h = await harness(t);
    h.configure();
    const user = await h.user("alice", "member", "member");
    const saved = h.store.secret(user.userID, "plex", plexSecret);
    assert.ok(saved);
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const accesses: string[] = [];
    h.upstream.plexLibrary = async (access) => {
      accesses.push(access.token);
      if (stage === "request") {
        entered.resolve();
        await gate.promise;
      }
      throw reconnectError();
    };
    if (stage === "renewal") {
      h.upstream.plexServerToken = async () => {
        entered.resolve();
        await gate.promise;
        return "old-server-renewed-token";
      };
    }
    if (stage === "identity") {
      const identity = h.upstream.plexIdentity.bind(h.upstream);
      h.upstream.plexIdentity = async (endpoint) => {
        const result = await identity(endpoint);
        entered.resolve();
        await gate.promise;
        return result;
      };
    }
    const pending = h.call("GET", "/api/v1/library", user);
    await entered.promise;
    if (change === "server")
      h.store.saveSettings({ ...h.store.settings(), plexURL: "https://new-plex.test", plexMachineID: "new-machine" });
    const replacement = change === "server"
      ? { ...saved, machineID: "new-machine", serverToken: "new-server-token" }
      : { ...saved, accountToken: "replacement-account", uuid: "replacement-uuid", serverToken: "replacement-server-token" };
    if (change === "disconnect") assert.equal((await h.call("DELETE", "/api/v1/connections/plex", user)).status, 200);
    else h.store.putSecret(user.userID, "plex", JSON.stringify(replacement));
    gate.resolve();
    assert.equal((await pending).status, 409);
    assert.deepEqual(accesses, stage === "identity" ? [] : [saved.serverToken], "no stale operation retries or sends replacement credentials");
    assert.deepEqual(h.store.secret(user.userID, "plex", plexSecret), change === "disconnect" ? null : replacement);
  });
}

test("concurrent Plex sign-ins cannot assign the same account to two users", async (t) => {
  const h = await harness(t);
  h.configure();
  const alice = await h.user("alice");
  const bob = await h.user("bob");
  const first = (await h.call("POST", "/api/v1/connections/plex/links", alice, {})).json();
  h.upstream.approvePin("member-account");
  const second = (await h.call("POST", "/api/v1/connections/plex/links", bob, {})).json();
  h.upstream.approvePin("member-account");
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const serverToken = h.upstream.plexServerToken.bind(h.upstream);
  let calls = 0;
  h.upstream.plexServerToken = async (...args) => {
    if (++calls === 2) entered.resolve();
    await gate.promise;
    return serverToken(...args);
  };
  const pending = Promise.all([
    h.call("GET", `/api/v1/connections/plex/links/${first.id}`, alice),
    h.call("GET", `/api/v1/connections/plex/links/${second.id}`, bob),
  ]);
  await entered.promise;
  gate.resolve();
  assert.deepEqual((await pending).map((response) => response.json().state).sort(), ["in_use", "linked"]);
  assert.equal(h.store.secretOwners("plex").length, 1);
});

for (const change of ["disconnect", "replace", "expire", "signout"]) {
  test(`a pending Plex sign-in cannot save credentials after ${change}`, async (t) => {
    const h = await harness(t);
    h.configure();
    const user = await h.user("alice");
    const createPin = h.upstream.plexCreatePin.bind(h.upstream);
    h.upstream.plexCreatePin = async (...args) => ({ ...await createPin(...args), expiresAt: h.clock.now() + 60_000 });
    const link = (await h.call("POST", "/api/v1/connections/plex/links", user, {})).json();
    h.upstream.approvePin("member-account");
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const serverToken = h.upstream.plexServerToken.bind(h.upstream);
    h.upstream.plexServerToken = async (...args) => {
      entered.resolve();
      await gate.promise;
      return serverToken(...args);
    };
    const pending = h.call("GET", `/api/v1/connections/plex/links/${link.id}`, user);
    await entered.promise;
    if (change === "disconnect") assert.equal((await h.call("DELETE", "/api/v1/connections/plex", user)).status, 200);
    if (change === "replace") assert.equal((await h.call("POST", "/api/v1/connections/plex/links", user, {})).status, 200);
    if (change === "expire") h.clock.advance(Date.parse(link.expiresAt) - h.clock.now() + 1);
    if (change === "signout") h.store.deleteUserSessions(user.userID);
    gate.resolve();
    assert.notEqual((await pending).status, 200);
    assert.equal(h.store.secret(user.userID, "plex", plexSecret), null);
  });
}

for (const stage of ["poll", "profile", "save"]) {
  test(`managed Plex links require current administrator authority at ${stage}`, async (t) => {
    const h = await harness(t);
    h.configure();
    const admin = await h.user("root", "admin");
    const other = await h.user("other", "admin");
    const kid = await h.user("kid");
    const link = (await h.call("POST", `/api/v1/admin/users/${kid.userID}/plex/links`, admin, {})).json();
    h.upstream.approvePin("admin-account");
    const poll = () => h.call("GET", `/api/v1/connections/plex/links/${link.id}`, admin);
    const pick = () => h.call("POST", `/api/v1/connections/plex/links/${link.id}/profile`, admin, { uuid: "kid-uuid", pin: "1234" });
    if (stage !== "poll") assert.equal((await poll()).json().state, "choose_profile");
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const serverToken = h.upstream.plexServerToken.bind(h.upstream);
    h.upstream.plexServerToken = async (...args) => {
      entered.resolve();
      await gate.promise;
      return serverToken(...args);
    };
    const pending = stage === "save" ? pick() : null;
    if (pending) await entered.promise;
    assert.equal((await h.call("PATCH", `/api/v1/admin/users/${admin.userID}`, other, { role: "member" })).status, 200);
    gate.resolve();
    const response = pending ? await pending : stage === "poll" ? await poll() : await pick();
    assert.equal(response.status, 403);
    assert.equal(h.store.secret(kid.userID, "plex", plexSecret), null);
  });
}
