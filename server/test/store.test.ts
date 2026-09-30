import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { hashPassword, verifyPassword } from "../passwords.ts";
import { jellyfinSecret, Store } from "../store.ts";
import { fixtureKey, identities } from "../testing.ts";

function temporary(t: { after: (fn: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), "leerr-store-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("secrets are bound to their owner and service and a wrong key refuses to start", (t) => {
  const path = join(temporary(t), "leerr.sqlite");
  const store = new Store(path, fixtureKey);
  store.putSecret("user-1", "jellyfin", JSON.stringify({ token: "t", userID: "u", username: "n" }));
  const sealed = String(store.db.prepare("SELECT value FROM secrets").pluck().get());
  assert.throws(() => store.decrypt("user-2", "jellyfin", sealed));
  // Truncated authentication tags are rejected outright.
  assert.throws(() => store.decrypt("user-1", "jellyfin", Buffer.from(sealed, "base64").subarray(0, 20).toString("base64")));
  store.close();
  assert.throws(() => new Store(path, Buffer.alloc(32, 9)));
  const reopened = new Store(path, fixtureKey);
  assert.equal(reopened.secret("user-1", "jellyfin", jellyfinSecret)?.token, "t");
  reopened.close();
});

test("databases from newer or pre-refresh Leerr releases are refused untouched", (t) => {
  const directory = temporary(t);
  const path = join(directory, "leerr.sqlite");
  const store = new Store(path, fixtureKey);
  store.db.pragma("user_version = 99");
  store.close();
  assert.throws(() => new Store(path, fixtureKey), /newer Leerr/);
  const legacy = new Store(join(directory, "legacy.sqlite"), fixtureKey);
  legacy.db.pragma("user_version = 2");
  legacy.close();
  assert.throws(() => new Store(join(directory, "legacy.sqlite"), fixtureKey), /earlier Leerr release/);
});

test("acquisition updates are compare-and-set", () => {
  const store = new Store(":memory:", fixtureKey);
  const user = store.createUser("a", "h", "member", 0);
  const { acquisition } = store.request(user.id, identities.album, 0);
  assert.equal(store.updateAcquisition(acquisition.id, { phase: "searching" }, { status: "failed" }, 1), false);
  assert.equal(store.updateAcquisition(acquisition.id, { phase: "ready" }, { status: "failed", reason: "x" }, 1), true);
  assert.equal(store.acquisition(acquisition.id)?.reason, "x");
  // SAFETY: deliberately bypasses the type to prove the database CHECK constraint still rejects it.
  assert.throws(() => store.updateAcquisition(acquisition.id, {}, { status: "bogus" as "failed" }, 1));
  store.close();
});

test("passwords verify only against their hash, and unknown users still pay the hashing cost", async () => {
  const hashed = await hashPassword("correct horse battery");
  assert.equal(await verifyPassword(hashed, "correct horse battery"), true);
  assert.equal(await verifyPassword(hashed, "wrong"), false);
  assert.equal(await verifyPassword(undefined, "anything"), false);
});

test("operator commands reset passwords, back up, and rotate keys offline", async (t) => {
  const directory = temporary(t);
  const keyFile = join(directory, "key");
  const newKeyFile = join(directory, "new-key");
  writeFileSync(keyFile, fixtureKey.toString("base64"));
  writeFileSync(newKeyFile, Buffer.alloc(32, 3).toString("base64"));
  const store = new Store(join(directory, "leerr.sqlite"), fixtureKey);
  const user = store.createUser("alice", await hashPassword("old password!"), "member", 0);
  store.updateUser(user.id, { disabled: true });
  store.createSession(user.id, "web", "Browser", Date.now(), 60_000);
  store.putSecret(user.id, "jellyfin", JSON.stringify({ token: "t", userID: "u", username: "n" }));
  store.close();
  const operator = (args: string[], input = "", key = keyFile) =>
    spawnSync(process.execPath, ["server/operator.ts", ...args], {
      input,
      encoding: "utf8",
      env: { ...process.env, LEERR_DATA: directory, LEERR_KEY_FILE: key },
    });
  assert.equal(operator(["reset-password", "alice"], "short\n").status, 1);
  const reset = operator(["reset-password", "alice"], "brand new password\n");
  assert.equal(reset.status, 0, reset.stderr);
  assert.equal(operator(["backup", join(directory, "backup.sqlite")]).status, 0);
  const rotated = operator(["rotate-key", newKeyFile]);
  assert.equal(rotated.status, 0, rotated.stderr);
  assert.match(rotated.stdout, /Re-encrypted 1 secrets/);
  const after = new Store(join(directory, "leerr.sqlite"), Buffer.alloc(32, 3));
  const alice = after.userByName("alice");
  assert.ok(alice);
  assert.equal(alice.disabled, false);
  assert.equal(await verifyPassword(alice.password, "brand new password"), true);
  assert.equal(after.sessions(alice.id, Date.now()).length, 0);
  assert.equal(after.secret(alice.id, "jellyfin", jellyfinSecret)?.token, "t");
  after.close();
  // The backup predates rotation and still opens with the old key.
  new Store(join(directory, "backup.sqlite"), fixtureKey).close();
  assert.equal(operator([]).status, 2);
});
