import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { deployment } from "./config.ts";
import { Store, userSchema } from "./store.ts";
import { passwordHash } from "./app.ts";

// Offline operation only: stop Leerr first. No passwords in argv/history.
const [command, argument] = process.argv.slice(2);
const config = deployment();
const store = new Store(resolve(config.data, "leerr.sqlite"), config.key);
try {
  if (command === "reset-password") {
    const password = z
      .string()
      .min(10)
      .max(256)
      .parse(readFileSync(0, "utf8").trim());
    const user = userSchema.parse(
      store.db.prepare("SELECT * FROM users WHERE username=?").get(argument),
    );
    const encoded = await passwordHash(password);
    store.db.transaction(() => {
      store.db
        .prepare("UPDATE users SET password=?,disabled=0 WHERE id=?")
        .run(encoded, user.id);
      store.db.prepare("DELETE FROM sessions WHERE userID=?").run(user.id);
    })();
    process.stdout.write("Password reset and sessions revoked.\n");
  } else if (command === "backup") {
    await store.db.backup(z.string().min(1).parse(argument));
    process.stdout.write(
      "Database backup complete. Protect the encryption key separately.\n",
    );
  } else if (command === "rotate-key") {
    const newKey = Buffer.from(
      readFileSync(z.string().min(1).parse(argument), "utf8").trim(),
      "base64",
    );
    const next = new Store(":memory:", newKey);
    try {
      const rows = z
        .array(
          z.object({
            owner: z.string(),
            service: z.string(),
            value: z.string(),
          }),
        )
        .parse(store.db.prepare("SELECT * FROM secrets").all());
      store.db.transaction(() => {
        for (const row of rows)
          store.db
            .prepare("UPDATE secrets SET value=? WHERE owner=? AND service=?")
            .run(
              next.encrypt(
                row.owner,
                row.service,
                store.decrypt(row.owner, row.service, row.value),
              ),
              row.owner,
              row.service,
            );
        store.db.prepare("DELETE FROM sessions").run();
      })();
    } finally {
      next.close();
    }
    process.stdout.write(
      "Database re-encrypted. Set LEERR_KEY_FILE to the new key before restarting. Retain the old key with old backups.\n",
    );
  } else if (command === "keygen") {
    // Key creation is deliberately separate from DB startup to prevent lost-key replacement.
    throw new Error(
      "Generate a key before startup with openssl rand -base64 32 > key-file.",
    );
  } else {
    process.stderr.write(
      "Usage (server stopped): operator reset-password USER < password-file | backup DESTINATION | rotate-key NEW_KEY_FILE\n",
    );
    process.exitCode = 1;
  }
} catch {
  process.stderr.write(
    "Operator command failed. Check inputs, key and database; no secret details were logged.\n",
  );
  process.exitCode = 1;
} finally {
  store.close();
}
