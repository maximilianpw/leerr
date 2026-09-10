import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { verify } from "argon2";
import { z } from "zod";
import { Store } from "./store.ts";

test("offline reset and key replacement revoke sessions and preserve encrypted connections", async () => {
  const dir = mkdtempSync(join(tmpdir(), "leerr-operator-")),
    key = Buffer.alloc(32, 71),
    next = Buffer.alloc(32, 72);
  const oldFile = join(dir, "old-key"),
    newFile = join(dir, "new-key"),
    data = join(dir, "leerr.sqlite");
  writeFileSync(oldFile, key.toString("base64"));
  writeFileSync(newFile, next.toString("base64"));
  const env = {
    ...process.env,
    LEERR_ORIGIN: "https://leerr.test",
    LEERR_DATA: dir,
    LEERR_KEY_FILE: oldFile,
  };
  try {
    const initial = new Store(data, key);
    initial.db
      .prepare("INSERT INTO users VALUES(?,?,?,?,?)")
      .run("u", "admin", "unused", "admin", 1);
    initial.db
      .prepare("INSERT INTO sessions VALUES(?,?,?,?,?,?)")
      .run("s", "u", "csrf", Date.now() + 100000, "phone", "native");
    initial.putSecret(
      "u",
      "jellyfin",
      JSON.stringify({ token: "retained-fixture-token" }),
    );
    initial.close();
    const reset = spawnSync(
      process.execPath,
      ["--import", "tsx", "server/operator.ts", "reset-password", "admin"],
      { env, input: "new-password-123", encoding: "utf8" },
    );
    assert.equal(reset.status, 0, reset.stderr);
    assert.equal(reset.stdout.includes("new-password-123"), false);
    const changed = new Store(data, key);
    assert.equal(
      await verify(
        z
          .string()
          .parse(
            changed.db
              .prepare("SELECT password FROM users WHERE id='u'")
              .pluck()
              .get(),
          ),
        "new-password-123",
      ),
      true,
    );
    assert.equal(
      changed.db.prepare("SELECT count(*) FROM sessions").pluck().get(),
      0,
    );
    changed.close();
    const rotated = spawnSync(
      process.execPath,
      ["--import", "tsx", "server/operator.ts", "rotate-key", newFile],
      { env, encoding: "utf8" },
    );
    assert.equal(rotated.status, 0, rotated.stderr);
    assert.throws(() => new Store(data, key));
    const reopened = new Store(data, next);
    assert.deepEqual(
      reopened.secret("u", "jellyfin", z.object({ token: z.string() })),
      { token: "retained-fixture-token" },
    );
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
