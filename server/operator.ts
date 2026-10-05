/**
 * Offline maintenance. Stop Leerr first: the running server holds the
 * database, and these commands refuse to run beside it. Passwords are read
 * from stdin, never argv.
 */
import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { readKey } from "./config.ts";
import { hashPassword } from "./passwords.ts";
import { DatabaseBusyError, SCHEMA_VERSION, Store } from "./store.ts";

const usage = `Usage (with Leerr stopped; LEERR_DATA and LEERR_KEY_FILE set as for the server).
OPERATOR is leerr-operator (Nix) or node server/operator.ts (source checkout, Docker):
  OPERATOR reset-password USER < password-file   Set a password, re-enable the user, end their sessions
  OPERATOR backup DESTINATION                    Consistent copy of the database (key not included)
  OPERATOR restore BACKUP                        Replace the database with a backup made with the same key
  OPERATOR rotate-key NEW_KEY_FILE               Re-encrypt secrets under a new key and end all sessions
Databases keep their schema version: the server upgrades them when it starts.
`;

const [command, argument] = process.argv.slice(2);
if (!command || !argument || !["reset-password", "backup", "restore", "rotate-key"].includes(command)) {
  process.stderr.write(usage);
  process.exit(2);
}
process.umask(0o077);
const database = resolve(process.env.LEERR_DATA ?? "data", "leerr.sqlite");
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const sidecars = (path: string) => [`${path}-wal`, `${path}-shm`];

function keyFile(): Buffer {
  return readKey(z.string({ error: "Set LEERR_KEY_FILE." }).min(1, "Set LEERR_KEY_FILE.").parse(process.env.LEERR_KEY_FILE));
}
function open(key: Buffer): Store {
  // No waiting: a busy database means the server is running. No upgrade either:
  // the release that wrote this database must still be able to open it.
  return new Store(database, key, { mustExist: true, busyTimeout: 0, migrate: false });
}
function refuseEmpty(store: Store) {
  if (store.setupRequired())
    throw new Error(`The database at ${database} has no users. Is LEERR_DATA the server's data directory?`);
}

/** A name for the database being replaced that no earlier restore used. */
function asidePath(): string {
  for (let attempt = 0; ; attempt++) {
    const path = `${database}.before-restore-${stamp}${attempt ? `-${attempt}` : ""}`;
    if (!existsSync(path)) return path;
  }
}

/**
 * Replaces the database with a verified copy of `source`, at the backup's own
 * schema version. The backup is copied (with its own write-ahead log) and
 * opened beside the database, never where it lies. The current database and
 * its write-ahead log are moved aside together: a log left next to a restored
 * file would be replayed onto it and corrupt it.
 */
function restore(source: string, key: Buffer): string | null {
  if (!existsSync(source)) throw new Error(`No backup at ${source}.`);
  if (Store.inUse(database)) throw new DatabaseBusyError();
  const staging = `${database}.restoring`;
  const clean = () => {
    for (const path of [staging, ...sidecars(staging)]) rmSync(path, { force: true });
  };
  clean();
  try {
    if (Store.stage(source, staging) === 0) throw new Error(`${source} is not a Leerr database.`);
    // Opening checks the key and the schema version; closing folds its log back in.
    const copy = new Store(staging, key, { mustExist: true, migrate: false });
    try {
      if (copy.setupRequired()) throw new Error(`${source} has no users. Is it a Leerr backup?`);
      const integrity = copy.integrity();
      if (integrity !== "ok") throw new Error(`The backup failed SQLite's integrity check: ${integrity}`);
    } finally {
      copy.close();
    }
  } catch (cause) {
    clean();
    throw cause;
  }
  // Checked again just before the swap: the server may have been started meanwhile.
  if (Store.inUse(database)) {
    clean();
    throw new DatabaseBusyError();
  }
  let previous: string | null = null;
  if (existsSync(database)) {
    previous = asidePath();
    renameSync(database, previous);
  }
  for (const [index, path] of sidecars(database).entries())
    if (existsSync(path)) {
      if (previous) renameSync(path, sidecars(previous)[index]);
      else rmSync(path, { force: true });
    }
  renameSync(staging, database);
  return previous;
}

try {
  if (command === "restore") {
    const previous = restore(resolve(argument), keyFile());
    process.stdout.write(
      `Restored ${resolve(argument)} into ${database}.${previous ? ` The previous database is kept as ${previous}.` : ""} Start Leerr with the key that belongs to this backup.\n`,
    );
  } else {
    const key = keyFile();
    const store = open(key);
    try {
      if (command === "reset-password") {
        // Known devices, forgotten with the old password, only exist from schema 4.
        if (store.schemaVersion() < SCHEMA_VERSION)
          throw new Error("This database is from an older Leerr. Start this Leerr once so it upgrades the database, then run reset-password again.");
        const password = z
          .string()
          .min(10, "The password must be at least 10 characters.")
          .max(256)
          .parse(readFileSync(0, "utf8").replace(/\r?\n$/, ""));
        const user = store.userByName(argument);
        if (!user) throw new Error(`No user named ${argument} in ${database}.`);
        const hashed = await hashPassword(password);
        store.transaction(() => {
          store.updateUser(user.id, { passwordHash: hashed, disabled: false });
          store.deleteUserSessions(user.id);
        });
        process.stdout.write("Password reset; the user is enabled and their sessions have ended.\n");
      } else if (command === "backup") {
        refuseEmpty(store);
        await store.backup(resolve(argument));
        process.stdout.write(`Backed up ${database} to ${resolve(argument)}. Store the encryption key separately.\n`);
      } else {
        refuseEmpty(store);
        const next = new Store(":memory:", readKey(argument, "NEW_KEY_FILE"));
        try {
          const count = store.reencrypt(next);
          store.deleteAllSessions();
          process.stdout.write(
            `Re-encrypted ${count} secrets in ${database}. Point LEERR_KEY_FILE at the new key before starting Leerr; keep the old key for old backups.\n`,
          );
        } finally {
          next.close();
        }
      }
    } finally {
      store.close();
    }
  }
} catch (cause) {
  // Messages here never contain secrets: inputs are validated, not echoed.
  const message =
    cause instanceof z.ZodError ? z.prettifyError(cause) : cause instanceof Error ? cause.message : "unknown error";
  process.stderr.write(`Operator command failed: ${message}\n`);
  process.exitCode = 1;
}
