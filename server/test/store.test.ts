import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { backupName, backupOnce, newestBackup, nextBackupDelay, pruneBackups, scheduleBackups } from "../backups.ts";
import { deployment } from "../config.ts";
import type { Runtime } from "../http/context.ts";
import { hashPassword, verifyPassword } from "../passwords.ts";
import { emptySettings, jellyfinSecret, Store } from "../store.ts";
import { fixtureKey, identities } from "../testing.ts";

/** Runs a short script in a separate process, as a second server or a crashing one would. */
function script(directory: string, name: string, body: string): string {
  const path = join(directory, `${name}.mts`);
  writeFileSync(path, `import { Store } from ${JSON.stringify(new URL("../store.ts", import.meta.url).href)};\n${body}\n`);
  return path;
}

/** Rewinds a fresh database to the version-3 schema that earlier releases created. */
const VERSION_3 =
  "DROP TABLE devices; DROP INDEX requests_acquisition; ALTER TABLE acquisitions DROP COLUMN pinEdition; ALTER TABLE acquisitions DROP COLUMN notified; ALTER TABLE requests DROP COLUMN seenStatus; PRAGMA user_version = 3;";

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
  assert.throws(() => store.decrypt("user-2", "jellyfin", sealed), "bound to the owner");
  assert.throws(() => store.decrypt("user-1", "lastfm", sealed), "bound to the service");
  // Truncated authentication tags are rejected outright.
  assert.throws(() => store.decrypt("user-1", "jellyfin", Buffer.from(sealed, "base64").subarray(0, 20).toString("base64")));
  store.close();
  assert.throws(() => new Store(path, Buffer.alloc(32, 9)), /encryption key does not match this database/);
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

test("a version-3 database is upgraded in place, keeping its data and a copy of the original", (t) => {
  const directory = temporary(t);
  const path = join(directory, "leerr.sqlite");
  const store = new Store(path, fixtureKey);
  const user = store.createUser("alice", "hash", "member", 0);
  const { acquisition } = store.request(user.id, identities.album, 0);
  store.createSession(user.id, "web", "Browser", 0, 60_000);
  store.db.exec(VERSION_3);
  store.close();
  const upgraded = new Store(path, fixtureKey);
  assert.equal(upgraded.db.pragma("user_version", { simple: true }), 4);
  assert.equal(upgraded.acquisition(acquisition.id)?.pinEdition, false);
  assert.equal(upgraded.requests(user.id).length, 1, "rows survive; no cascade fired");
  assert.equal(upgraded.sessions(user.id, 0).length, 1);
  assert.ok(upgraded.createDevice(user.id, 0));
  upgraded.close();
  const copies = readdirSync(directory).filter((file) => /^leerr\.sqlite\.v3-[0-9a-f]{8}\.bak$/.test(file));
  assert.equal(copies.length, 1);
  const original = new Store(join(directory, copies[0]), fixtureKey, { upgradeCopy: false });
  assert.equal(original.requests(user.id).length, 1);
  original.close();
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
  // updatedAt moves only when what people see (status or reason) changes.
  assert.equal(store.updateAcquisition(acquisition.id, {}, { nextAt: 50, failures: 2 }, 9), true);
  assert.equal(store.acquisition(acquisition.id)?.updatedAt, 1);
  store.updateAcquisition(acquisition.id, {}, { status: "failed", reason: "x" }, 10);
  assert.equal(store.acquisition(acquisition.id)?.updatedAt, 1);
  store.updateAcquisition(acquisition.id, {}, { reason: "y" }, 11);
  assert.equal(store.acquisition(acquisition.id)?.updatedAt, 11);
  store.close();
});

test("sessions, tickets and known devices are stored only as SHA-256 digests", () => {
  const store = new Store(":memory:", fixtureKey);
  const user = store.createUser("a", "h", "member", 0);
  const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
  const session = store.createSession(user.id, "web", "Browser", 0, 60_000);
  assert.deepEqual(store.db.prepare("SELECT id FROM sessions").pluck().all(), [sha256(session.token)]);
  const ticket = store.createTicket(sha256(session.token), "track", 60_000);
  assert.deepEqual(store.db.prepare("SELECT id FROM tickets").pluck().all(), [sha256(ticket)]);
  const device = store.createDevice(user.id, 0);
  assert.deepEqual(store.db.prepare("SELECT id FROM devices").pluck().all(), [sha256(device)]);
  assert.equal(store.deviceUser(device, 1), user.id);
  assert.equal(store.deviceUser("someone-elses-token", 1), undefined);
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
  assert.equal(operator(["unknown", "x"]).status, 2);
});

test("operator commands find the server's database or say clearly why not", (t) => {
  const directory = temporary(t);
  const keyFile = join(directory, "key");
  writeFileSync(keyFile, fixtureKey.toString("base64"));
  const run = (args: string[], env: Record<string, string>) =>
    spawnSync(process.execPath, ["server/operator.ts", ...args], { encoding: "utf8", env: { ...process.env, ...env } });
  const empty = join(directory, "empty");
  const missing = run(["backup", join(directory, "b.sqlite")], { LEERR_DATA: empty, LEERR_KEY_FILE: keyFile });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /No Leerr database at .*empty\/leerr\.sqlite/);
  assert.equal(existsSync(join(empty, "leerr.sqlite")), false, "no empty database is created");
  const noKey = run(["backup", join(directory, "b.sqlite")], { LEERR_DATA: directory, LEERR_KEY_FILE: "" });
  assert.match(noKey.stderr, /Set LEERR_KEY_FILE/);
  new Store(join(directory, "leerr.sqlite"), fixtureKey).close();
  const unset = run(["backup", join(directory, "b.sqlite")], { LEERR_DATA: directory, LEERR_KEY_FILE: keyFile });
  assert.match(unset.stderr, /has no users/);
  const wrongKey = join(directory, "wrong");
  writeFileSync(wrongKey, "too short");
  assert.match(
    run(["rotate-key", wrongKey], { LEERR_DATA: directory, LEERR_KEY_FILE: keyFile }).stderr,
    /no users|NEW_KEY_FILE must contain/,
  );
});

test("operator commands refuse to run beside a running server", async (t) => {
  const directory = temporary(t);
  const keyFile = join(directory, "key");
  writeFileSync(keyFile, fixtureKey.toString("base64"));
  const store = new Store(join(directory, "leerr.sqlite"), fixtureKey);
  store.createUser("alice", "hash", "member", 0);
  store.close();
  // A separate process holds the database as the server does.
  const holder = script(
    directory,
    "hold",
    // Kept referenced: a collected connection closes and releases its lock.
    `const held = new Store(${JSON.stringify(join(directory, "leerr.sqlite"))}, Buffer.alloc(32, 7), { exclusive: true });
     process.stdout.write("held\\n");
     setInterval(() => held.healthy(), 100);`,
  );
  const server = spawn(process.execPath, [holder], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => server.kill());
  await new Promise((resolve) => server.stdout.once("data", resolve));
  // A real backup, so restore gets as far as the running-server check.
  const backup = new Store(join(directory, "spare.sqlite"), fixtureKey);
  backup.createUser("bob", "hash", "member", 0);
  backup.close();
  for (const args of [["backup", join(directory, "b.sqlite")], ["rotate-key", keyFile], ["restore", join(directory, "spare.sqlite")]]) {
    const result = spawnSync(process.execPath, ["server/operator.ts", ...args], {
      encoding: "utf8",
      env: { ...process.env, LEERR_DATA: directory, LEERR_KEY_FILE: keyFile },
    });
    assert.equal(result.status, 1, args[0]);
    assert.match(result.stderr, /appears to be running/);
  }
});

test("restore replaces the database with a verified backup and never replays the old write-ahead log", async (t) => {
  const directory = temporary(t);
  const keyFile = join(directory, "key");
  writeFileSync(keyFile, fixtureKey.toString("base64"));
  const path = join(directory, "leerr.sqlite");
  const store = new Store(path, fixtureKey);
  store.createUser("before", "hash", "member", 0);
  // An encrypted secret, so a restore with the wrong key has something to fail on.
  store.saveSettings({ ...emptySettings, lidarrKey: "secret" });
  await store.backup(join(directory, "backup.sqlite"));
  for (let index = 0; index < 50; index++) store.createUser(`later${index}`, "hash", "member", 0);
  store.close();
  // An unclean exit leaves the newer rows only in the write-ahead log.
  const crasher = script(
    directory,
    "crash",
    `const s = new Store(${JSON.stringify(path)}, Buffer.alloc(32, 7));
     for (let i = 0; i < 50; i++) s.createUser("crash" + i, "hash", "member", 0);
     process.kill(process.pid, "SIGKILL");`,
  );
  const crash = spawnSync(process.execPath, [crasher], { encoding: "utf8" });
  assert.equal(crash.signal, "SIGKILL");
  assert.equal(existsSync(`${path}-wal`), true, "a stale write-ahead log is left behind");
  const restored = spawnSync(process.execPath, ["server/operator.ts", "restore", join(directory, "backup.sqlite")], {
    encoding: "utf8",
    env: { ...process.env, LEERR_DATA: directory, LEERR_KEY_FILE: keyFile },
  });
  assert.equal(restored.status, 0, restored.stderr);
  assert.match(restored.stdout, /previous database is kept as/);
  const reopened = new Store(path, fixtureKey);
  assert.deepEqual(reopened.users().map((user) => user.username), ["before"]);
  assert.equal(reopened.integrity(), "ok");
  reopened.close();
  // The replaced database and its log were moved aside together, intact.
  const previous = readdirSync(directory).find((file) => /^leerr\.sqlite\.before-restore-\d{8}T\d{6}Z$/.test(file));
  assert.ok(previous);
  const kept = new Store(join(directory, previous), fixtureKey, { upgradeCopy: false });
  assert.equal(kept.users().length, 101);
  kept.close();
  const wrongKey = join(directory, "wrong-key");
  writeFileSync(wrongKey, Buffer.alloc(32, 1).toString("base64"));
  const refused = spawnSync(process.execPath, ["server/operator.ts", "restore", join(directory, "backup.sqlite")], {
    encoding: "utf8",
    env: { ...process.env, LEERR_DATA: directory, LEERR_KEY_FILE: wrongKey },
  });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /encryption key does not match/);
});

test("restore reads the backup's own write-ahead log, refuses non-Leerr files, replaces a corrupt database and keeps every previous one", async (t) => {
  const directory = temporary(t);
  const keyFile = join(directory, "key");
  writeFileSync(keyFile, fixtureKey.toString("base64"));
  const restore = (source: string) =>
    spawnSync(process.execPath, ["server/operator.ts", "restore", source], {
      encoding: "utf8",
      env: { ...process.env, LEERR_DATA: join(directory, "data"), LEERR_KEY_FILE: keyFile },
    });
  // A backup that is a live snapshot: its newest user is only in its write-ahead log.
  const source = join(directory, "snapshot.sqlite");
  const crasher = script(
    directory,
    "snapshot",
    `const s = new Store(${JSON.stringify(source)}, Buffer.alloc(32, 7));
     s.db.pragma("wal_autocheckpoint = 0");
     s.createUser("in-main", "hash", "member", 0);
     s.db.pragma("wal_checkpoint(TRUNCATE)");
     s.createUser("only-in-wal", "hash", "member", 0);
     process.kill(process.pid, "SIGKILL");`,
  );
  spawnSync(process.execPath, [crasher]);
  assert.equal(existsSync(`${source}-wal`), true);
  mkdirSync(join(directory, "data"));
  // The live database is corrupt: restore must still be able to replace it.
  writeFileSync(join(directory, "data", "leerr.sqlite"), "this is not a database");
  const first = restore(source);
  assert.equal(first.status, 0, first.stderr);
  const second = restore(source);
  assert.equal(second.status, 0, second.stderr);
  const restored = new Store(join(directory, "data", "leerr.sqlite"), fixtureKey);
  assert.deepEqual(restored.users().map((user) => user.username).sort(), ["in-main", "only-in-wal"]);
  restored.close();
  const kept = readdirSync(join(directory, "data")).filter((file) => file.includes("before-restore"));
  assert.equal(kept.length, 2, "two restores in the same second keep both previous databases");
  const empty = join(directory, "empty.sqlite");
  writeFileSync(empty, "");
  assert.match(restore(empty).stderr, /not a Leerr database|has no users/);
  const blank = join(directory, "blank.sqlite");
  new Store(blank, fixtureKey).close();
  assert.match(restore(blank).stderr, /has no users/);
});

test("restore works from a read-only directory and leaves nothing beside the backup; backups open read-only", async (t) => {
  const directory = temporary(t);
  const keyFile = join(directory, "key");
  writeFileSync(keyFile, fixtureKey.toString("base64"));
  const live = new Store(join(directory, "live.sqlite"), fixtureKey);
  live.createUser("alice", "hash", "member", 0);
  const shelf = join(directory, "shelf");
  mkdirSync(shelf);
  await live.backup(join(shelf, "backup.sqlite"));
  live.close();
  const header = readFileSync(join(shelf, "backup.sqlite")).subarray(18, 20);
  assert.deepEqual([...header], [1, 1], "the backup uses a rollback journal, not a write-ahead log");
  const data = join(directory, "data");
  mkdirSync(data);
  chmodSync(shelf, 0o555);
  let restored;
  try {
    restored = spawnSync(process.execPath, ["server/operator.ts", "restore", join(shelf, "backup.sqlite")], {
      encoding: "utf8",
      env: { ...process.env, LEERR_DATA: data, LEERR_KEY_FILE: keyFile },
    });
  } finally {
    chmodSync(shelf, 0o755);
  }
  assert.equal(restored.status, 0, restored.stderr);
  assert.deepEqual(readdirSync(shelf), ["backup.sqlite"]);
  const reopened = new Store(join(data, "leerr.sqlite"), fixtureKey);
  assert.deepEqual(reopened.users().map((user) => user.username), ["alice"]);
  reopened.close();
});

test("operator commands keep a database at its own schema version, so the release that made it can still open it", async (t) => {
  const directory = temporary(t);
  const keyFile = join(directory, "key");
  writeFileSync(keyFile, fixtureKey.toString("base64"));
  const newKeyFile = join(directory, "new-key");
  writeFileSync(newKeyFile, Buffer.alloc(32, 3).toString("base64"));
  const path = join(directory, "leerr.sqlite");
  const store = new Store(path, fixtureKey);
  store.createUser("alice", await hashPassword("old password!"), "admin", 0);
  store.putSecret("installation", "settings", "{}");
  store.db.exec(VERSION_3);
  store.close();
  const version = (file: string) => {
    const db = new Database(file, { readonly: true });
    try {
      return db.pragma("user_version", { simple: true });
    } finally {
      db.close();
    }
  };
  const operator = (args: string[], key = keyFile, input = "") =>
    spawnSync(process.execPath, ["server/operator.ts", ...args], {
      input,
      encoding: "utf8",
      env: { ...process.env, LEERR_DATA: directory, LEERR_KEY_FILE: key },
    });
  const backup = join(directory, "backup.sqlite");
  assert.equal(operator(["backup", backup]).status, 0);
  assert.equal(version(path), 3, "backing up does not upgrade the live database");
  assert.equal(version(backup), 3);
  const reset = operator(["reset-password", "alice"], keyFile, "brand new password\n");
  assert.equal(reset.status, 1);
  assert.match(reset.stderr, /older Leerr\. Start this Leerr once/);
  const restored = operator(["restore", backup]);
  assert.equal(restored.status, 0, restored.stderr);
  assert.equal(version(path), 3, "a restored backup keeps its version: the older release can start on it");
  const rotated = operator(["rotate-key", newKeyFile]);
  assert.equal(rotated.status, 0, rotated.stderr);
  assert.equal(version(path), 3);
  assert.equal(readdirSync(directory).some((file) => file.endsWith(".bak")), false, "no upgrade copies were made");
  // The server still upgrades it when it starts.
  const upgraded = new Store(path, Buffer.alloc(32, 3));
  assert.equal(upgraded.schemaVersion(), 4);
  upgraded.close();
});

test("a wrong key leaves an older database exactly as it was", (t) => {
  const directory = temporary(t);
  const path = join(directory, "leerr.sqlite");
  const store = new Store(path, fixtureKey);
  store.putSecret("user-1", "jellyfin", JSON.stringify({ token: "t", userID: "u", username: "n" }));
  store.db.exec(VERSION_3);
  store.close();
  assert.throws(() => new Store(path, Buffer.alloc(32, 9)), /encryption key does not match/);
  const check = new Database(path, { readonly: true });
  assert.equal(check.pragma("user_version", { simple: true }), 3);
  check.close();
  assert.equal(readdirSync(directory).some((file) => file.endsWith(".bak")), false);
});

test("deployment settings are checked with messages that name the setting", (t) => {
  const directory = temporary(t);
  const key = join(directory, "key");
  writeFileSync(key, fixtureKey.toString("base64"));
  const env = { LEERR_ORIGIN: "https://music.example.com", LEERR_KEY_FILE: key, LEERR_DATA: join(directory, "data") };
  assert.equal(deployment(env).origin, "https://music.example.com");
  assert.equal(deployment({ ...env, LEERR_ORIGIN: "https://MUSIC.example.com/" }).origin, "https://music.example.com");
  assert.throws(() => deployment({ ...env, LEERR_ORIGIN: undefined }), /LEERR_ORIGIN/);
  assert.throws(() => deployment({ ...env, LEERR_ORIGIN: "http://music.example.com" }), /HTTPS origin/);
  assert.throws(() => deployment({ ...env, LEERR_ORIGIN: "https://music.example.com/leerr" }), /without a path/);
  assert.throws(() => deployment({ ...env, LEERR_KEY_FILE: join(directory, "missing") }), /LEERR_KEY_FILE .* could not be read/);
  writeFileSync(join(directory, "short"), "c2hvcnQ=\n");
  assert.throws(() => deployment({ ...env, LEERR_KEY_FILE: join(directory, "short") }), /32-byte key/);
  assert.throws(() => deployment({ ...env, PORT: "70000" }), /PORT must be at most/);
  assert.equal(deployment(env).backups, null);
  assert.deepEqual(deployment({ ...env, LEERR_BACKUP_DIR: "/backups" }).backups, { directory: "/backups", everyHours: 24, keep: 7 });
  assert.throws(() => deployment({ ...env, LEERR_BACKUP_DIR: "/backups", LEERR_BACKUP_HOURS: "600" }), /LEERR_BACKUP_HOURS must be at most 576/);
});

test("scheduled backups are consistent copies, and pruning only ever removes old backups", async (t) => {
  const directory = temporary(t);
  const backups = { directory: join(directory, "backups"), everyHours: 24, keep: 2 };
  mkdirSync(backups.directory);
  writeFileSync(join(backups.directory, "notes.txt"), "keep me");
  const store = new Store(join(directory, "leerr.sqlite"), fixtureKey);
  store.createUser("alice", "hash", "member", 0);
  const runtime: Runtime = { startedAt: 0, lastBackup: null };
  const events: string[] = [];
  for (const day of [1, 2, 3]) await backupOnce(store, backups, runtime, (event) => void events.push(event), new Date(Date.UTC(2026, 9, day, 3)));
  store.close();
  assert.deepEqual(readdirSync(backups.directory).sort(), ["leerr-20261002T030000Z.sqlite", "leerr-20261003T030000Z.sqlite", "notes.txt"]);
  assert.equal(runtime.lastBackup?.ok, true);
  const copy = new Store(join(backups.directory, "leerr-20261003T030000Z.sqlite"), fixtureKey);
  assert.equal(copy.users()[0].username, "alice");
  copy.close();
  await backupOnce(store, backups, runtime, (event) => void events.push(event), new Date());
  assert.equal(runtime.lastBackup?.ok, false, "a closed database is reported, not thrown");
  assert.ok(events.includes("backup_failed"));
  assert.equal(pruneBackups(backups.directory, 1), 1);
});

test("backups are due a full period after the newest one, so restarts never push older backups out", (t) => {
  const hour = 3_600_000;
  const now = Date.UTC(2026, 9, 8, 5);
  assert.equal(nextBackupDelay(null, 24, now), 60_000);
  assert.equal(nextBackupDelay(now - hour, 24, now), 23 * hour);
  assert.equal(nextBackupDelay(now - 30 * hour, 24, now), 60_000, "overdue: soon after starting");
  assert.equal(nextBackupDelay(now + hour, 24, now), 60_000, "a backup from the future (clock moved back) does not delay the next");
  const directory = temporary(t);
  const backups = { directory: join(directory, "backups"), everyHours: 24, keep: 7 };
  mkdirSync(backups.directory);
  const days = [1, 2, 3, 4, 5, 6, 7].map((day) => backupName(new Date(Date.UTC(2026, 9, day, 3))));
  for (const name of days) writeFileSync(join(backups.directory, name), "");
  writeFileSync(join(backups.directory, `${backupName(new Date(Date.UTC(2026, 9, 7, 9)))}.partial`), "interrupted");
  assert.equal(newestBackup(backups.directory), Date.UTC(2026, 9, 7, 3));
  const store = new Store(join(directory, "leerr.sqlite"), fixtureKey);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const runtime: Runtime = { startedAt: 0, lastBackup: null };
  // Seven restarts an hour apart, each running for ten minutes.
  for (let restart = 0; restart < 7; restart++) {
    const stop = scheduleBackups(store, backups, runtime, () => {}, () => Date.UTC(2026, 9, 7, 4 + restart));
    t.mock.timers.tick(10 * 60_000);
    stop();
  }
  store.close();
  assert.deepEqual(readdirSync(backups.directory).sort(), days, "no extra copies, and the interrupted one was removed");
  assert.equal(runtime.lastBackup?.at, Date.UTC(2026, 9, 7, 3), "the status page knows the last backup after a restart");
});
