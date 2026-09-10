import Database from "better-sqlite3";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { z } from "zod";

export const opaque = () => randomBytes(32).toString("base64url");
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const userSchema = z.object({
  id: z.string(),
  username: z.string(),
  role: z.enum(["admin", "member"]),
  disabled: z.number(),
  password: z.string(),
});
export const sessionSchema = z.object({
  id: z.string(),
  userID: z.string(),
  csrf: z.string(),
  expiresAt: z.number(),
  name: z.string(),
  device: z.enum(["native", "web"]),
});
export const settingsSchema = z.object({
  jellyfinURL: z.string().nullable(),
  lidarrURL: z.string().nullable(),
  lidarrKey: z.string(),
  rootFolderPath: z.string(),
  qualityProfileID: z.number(),
  metadataProfileID: z.number(),
});
export const jellySchema = z.object({ token: z.string(), userID: z.string() });
export const lastSchema = z.object({
  username: z.string(),
  apiKey: z.string(),
});
export const acquisitionSchema = z.object({
  id: z.string(),
  releaseGroupMBID: z.string(),
  releaseMBID: z.string(),
  artistMBID: z.string(),
  title: z.string(),
  artist: z.string(),
  status: z.string(),
  attempted: z.number(),
  failures: z.number(),
  nextAt: z.number(),
});

export class Store {
  readonly db: Database.Database;
  constructor(
    path: string,
    private readonly key: Buffer,
  ) {
    if (key.length !== 32)
      throw new Error("Encryption key must contain exactly 32 bytes.");
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    const version = z
      .number()
      .parse(this.db.pragma("user_version", { simple: true }));
    if (version > 2) throw new Error("Database is newer than this server.");
    if (version === 0)
      this.db.transaction(() => {
        this.db.exec(`
        CREATE TABLE users(id TEXT PRIMARY KEY, username TEXT UNIQUE COLLATE NOCASE NOT NULL, password TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','member')), disabled INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE sessions(id TEXT PRIMARY KEY, userID TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, csrf TEXT NOT NULL, expiresAt INTEGER NOT NULL, name TEXT NOT NULL, device TEXT NOT NULL);
        CREATE TABLE secrets(owner TEXT NOT NULL, service TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(owner, service));
        CREATE TABLE acquisitions(id TEXT PRIMARY KEY, releaseGroupMBID TEXT UNIQUE NOT NULL, releaseMBID TEXT NOT NULL, artistMBID TEXT NOT NULL, title TEXT NOT NULL, artist TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'requested', attempted INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0, nextAt INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE requests(id TEXT PRIMARY KEY, userID TEXT NOT NULL REFERENCES users(id), acquisitionID TEXT NOT NULL REFERENCES acquisitions(id), UNIQUE(userID,acquisitionID));
        CREATE TABLE tickets(id TEXT PRIMARY KEY, sessionID TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, trackID TEXT NOT NULL, expiresAt INTEGER NOT NULL);
        CREATE INDEX session_expiry ON sessions(expiresAt);
        CREATE INDEX ticket_expiry ON tickets(expiresAt);
        PRAGMA user_version = 1;
      `);
      })();
    if (version < 2)
      this.db.transaction(() => {
        this.db.exec(
          "CREATE TABLE IF NOT EXISTS acquisition_mutations(acquisitionID TEXT PRIMARY KEY REFERENCES acquisitions(id) ON DELETE CASCADE, phase TEXT NOT NULL DEFAULT 'ready', albumID INTEGER, commandID INTEGER, searchFloor INTEGER NOT NULL DEFAULT 0); PRAGMA user_version=2;",
        );
      })();
    // Detect wrong keys immediately, rather than quietly treating connections as absent.
    for (const row of z
      .array(
        z.object({ owner: z.string(), service: z.string(), value: z.string() }),
      )
      .parse(this.db.prepare("SELECT * FROM secrets").all()))
      this.decrypt(row.owner, row.service, row.value);
  }
  close() {
    this.db.close();
  }
  encrypt(owner: string, service: string, plain: string) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(Buffer.from(`${owner}\0${service}`));
    const encrypted = Buffer.concat([
      cipher.update(plain, "utf8"),
      cipher.final(),
    ]);
    return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString(
      "base64",
    );
  }
  decrypt(owner: string, service: string, value: string) {
    const bytes = Buffer.from(value, "base64");
    const cipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      bytes.subarray(0, 12),
    );
    cipher.setAuthTag(bytes.subarray(12, 28));
    cipher.setAAD(Buffer.from(`${owner}\0${service}`));
    return Buffer.concat([
      cipher.update(bytes.subarray(28)),
      cipher.final(),
    ]).toString("utf8");
  }
  secret<T>(owner: string, service: string, schema: z.ZodType<T>): T | null {
    const row = z
      .object({ value: z.string() })
      .optional()
      .parse(
        this.db
          .prepare("SELECT value FROM secrets WHERE owner=? AND service=?")
          .get(owner, service),
      );
    return row
      ? schema.parse(JSON.parse(this.decrypt(owner, service, row.value)))
      : null;
  }
  putSecret(owner: string, service: string, value: string) {
    this.db
      .prepare(
        "INSERT INTO secrets VALUES(?,?,?) ON CONFLICT(owner,service) DO UPDATE SET value=excluded.value",
      )
      .run(owner, service, this.encrypt(owner, service, value));
  }
  settings() {
    return (
      this.secret("installation", "settings", settingsSchema) ?? {
        jellyfinURL: null,
        lidarrURL: null,
        lidarrKey: "",
        rootFolderPath: "",
        qualityProfileID: 0,
        metadataProfileID: 0,
      }
    );
  }
  user(id: string) {
    return userSchema
      .optional()
      .parse(this.db.prepare("SELECT * FROM users WHERE id=?").get(id));
  }
  prune(now: number) {
    this.db.prepare("DELETE FROM sessions WHERE expiresAt<=?").run(now);
    this.db.prepare("DELETE FROM tickets WHERE expiresAt<=?").run(now);
  }
}
