/**
 * Offline maintenance. Stop Leerr first: these commands do not coordinate
 * with a running server. Passwords are read from stdin, never argv.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { readKey } from "./config.ts";
import { hashPassword } from "./passwords.ts";
import { Store } from "./store.ts";

const usage = `Usage (with Leerr stopped; LEERR_DATA and LEERR_KEY_FILE set as for the server):
  leerr-operator reset-password USER < password-file   Set a password, re-enable the user, end their sessions
  leerr-operator backup DESTINATION                    Consistent copy of the database (key not included)
  leerr-operator rotate-key NEW_KEY_FILE               Re-encrypt secrets under a new key and end all sessions
`;

const [command, argument] = process.argv.slice(2);
if (!command || !argument) {
  process.stderr.write(usage);
  process.exit(2);
}
process.umask(0o077);
const store = new Store(
  resolve(process.env.LEERR_DATA ?? "data", "leerr.sqlite"),
  readKey(z.string().min(1).parse(process.env.LEERR_KEY_FILE)),
);
try {
  if (command === "reset-password") {
    const password = z.string().min(10).max(256).parse(readFileSync(0, "utf8").replace(/\r?\n$/, ""));
    const user = store.userByName(argument);
    if (!user) throw new Error("No such user.");
    const hashed = await hashPassword(password);
    store.transaction(() => {
      store.updateUser(user.id, { passwordHash: hashed, disabled: false });
      store.deleteUserSessions(user.id);
    });
    process.stdout.write("Password reset; the user is enabled and their sessions have ended.\n");
  } else if (command === "backup") {
    await store.db.backup(resolve(argument));
    process.stdout.write("Backup complete. Store the encryption key separately.\n");
  } else if (command === "rotate-key") {
    const next = new Store(":memory:", readKey(argument));
    try {
      const count = store.reencrypt(next);
      store.deleteAllSessions();
      process.stdout.write(
        `Re-encrypted ${count} secrets. Point LEERR_KEY_FILE at the new key before starting Leerr; keep the old key for old backups.\n`,
      );
    } finally {
      next.close();
    }
  } else {
    process.stderr.write(usage);
    process.exitCode = 2;
  }
} catch (cause) {
  // Messages here never contain secrets: inputs are validated, not echoed.
  process.stderr.write(`Operator command failed: ${cause instanceof Error ? cause.message : "unknown error"}\n`);
  process.exitCode = 1;
} finally {
  store.close();
}
