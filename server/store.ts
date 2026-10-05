import Database from "better-sqlite3";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, renameSync } from "node:fs";
import { z } from "zod";

export const opaque = () => randomBytes(32).toString("base64url");
export const digest = (value: string) => createHash("sha256").update(value).digest("hex");

// Versions 1–2 were the pre-refresh schema, which is not migrated.
const FIRST_SUPPORTED_VERSION = 3;
/** The version-3 baseline. Later versions are reached only through MIGRATIONS. */
const BASELINE = `
CREATE TABLE users(
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','member')),
  disabled INTEGER NOT NULL DEFAULT 0 CHECK(disabled IN (0,1)),
  createdAt INTEGER NOT NULL
);
CREATE TABLE sessions(
  id TEXT PRIMARY KEY,
  userID TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL,
  device TEXT NOT NULL CHECK(device IN ('web','native')),
  name TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  expiresAt INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(userID);
CREATE INDEX sessions_expiry ON sessions(expiresAt);
CREATE TABLE secrets(
  owner TEXT NOT NULL,
  service TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY(owner, service)
);
CREATE TABLE acquisitions(
  id TEXT PRIMARY KEY,
  releaseGroupMBID TEXT NOT NULL UNIQUE,
  releaseMBID TEXT NOT NULL,
  artistMBID TEXT NOT NULL,
  title TEXT NOT NULL,
  artist TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'requested'
    CHECK(status IN ('requested','acquiring','imported','failed','attention')),
  reason TEXT,
  phase TEXT NOT NULL DEFAULT 'ready'
    CHECK(phase IN ('ready','pending_add','pending_monitor','pending_search','searching','finished')),
  lidarrAlbumID INTEGER,
  commandID INTEGER,
  searchFloor INTEGER NOT NULL DEFAULT 0,
  phaseAt INTEGER NOT NULL,
  failures INTEGER NOT NULL DEFAULT 0,
  nextAt INTEGER NOT NULL DEFAULT 0,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);
CREATE INDEX acquisitions_due ON acquisitions(nextAt);
CREATE TABLE requests(
  id TEXT PRIMARY KEY,
  userID TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  acquisitionID TEXT NOT NULL REFERENCES acquisitions(id) ON DELETE CASCADE,
  createdAt INTEGER NOT NULL,
  UNIQUE(userID, acquisitionID)
);
CREATE INDEX requests_user ON requests(userID, createdAt);
CREATE TABLE tickets(
  id TEXT PRIMARY KEY,
  sessionID TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  trackID TEXT NOT NULL,
  expiresAt INTEGER NOT NULL
);
CREATE INDEX tickets_session ON tickets(sessionID);
CREATE INDEX tickets_expiry ON tickets(expiresAt);
`;
/**
 * Ordered schema upgrades. Each runs in its own transaction with foreign keys
 * off, so a table rebuild can never cascade-delete dependent rows.
 */
const MIGRATIONS: ReadonlyArray<{ to: number; sql: string }> = [
  {
    to: 4,
    sql: `
      ALTER TABLE acquisitions ADD COLUMN pinEdition INTEGER NOT NULL DEFAULT 0 CHECK(pinEdition IN (0,1));
      ALTER TABLE acquisitions ADD COLUMN notified TEXT;
      ALTER TABLE requests ADD COLUMN seenStatus TEXT;
      CREATE INDEX requests_acquisition ON requests(acquisitionID);
      CREATE TABLE devices(
        id TEXT PRIMARY KEY,
        userID TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        createdAt INTEGER NOT NULL,
        lastUsedAt INTEGER NOT NULL
      );
      CREATE INDEX devices_user ON devices(userID);
      CREATE INDEX devices_used ON devices(lastUsedAt);
    `,
  },
];
export const SCHEMA_VERSION = MIGRATIONS.at(-1)?.to ?? FIRST_SUPPORTED_VERSION;

export const roles = ["admin", "member"] as const;
export type Role = (typeof roles)[number];
export const acquisitionStatuses = ["requested", "acquiring", "imported", "failed", "attention"] as const;
export type AcquisitionStatus = (typeof acquisitionStatuses)[number];
export const phases = ["ready", "pending_add", "pending_monitor", "pending_search", "searching", "finished"] as const;
export type Phase = (typeof phases)[number];

const flag = z.number().int().transform((value) => value === 1);
const userRow = z.object({
  id: z.string(),
  username: z.string(),
  password: z.string(),
  role: z.enum(roles),
  disabled: flag,
  createdAt: z.number(),
});
export type User = z.infer<typeof userRow>;
const sessionRow = z.object({
  id: z.string(),
  userID: z.string(),
  csrf: z.string(),
  device: z.enum(["web", "native"]),
  name: z.string(),
  createdAt: z.number(),
  expiresAt: z.number(),
});
export type Session = z.infer<typeof sessionRow>;
export type Device = Session["device"];
const acquisitionRow = z.object({
  id: z.string(),
  releaseGroupMBID: z.string(),
  releaseMBID: z.string(),
  artistMBID: z.string(),
  title: z.string(),
  artist: z.string(),
  status: z.enum(acquisitionStatuses),
  reason: z.string().nullable(),
  phase: z.enum(phases),
  lidarrAlbumID: z.number().int().nullable(),
  commandID: z.number().int().nullable(),
  searchFloor: z.number().int(),
  phaseAt: z.number(),
  failures: z.number().int(),
  nextAt: z.number(),
  /** Leerr added this album to Lidarr, so it must pin the requested edition itself. */
  pinEdition: flag,
  /** The last outcome people were told about, so each is announced once. */
  notified: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Acquisition = z.infer<typeof acquisitionRow>;
const requestRow = acquisitionRow.extend({
  requestID: z.string(),
  requestedAt: z.number(),
  seenStatus: z.string().nullable(),
});
export type RequestRecord = z.infer<typeof requestRow>;
const ticketRow = z.object({
  sessionID: z.string(),
  userID: z.string(),
  trackID: z.string(),
  expiresAt: z.number(),
});
export type Ticket = z.infer<typeof ticketRow>;

export const notifyFormats = ["ntfy", "discord", "json"] as const;
export type NotifyFormat = (typeof notifyFormats)[number];
// Fields added after the first release need defaults: older settings blobs lack them.
export const settingsSchema = z.object({
  jellyfinURL: z.string().nullable(),
  lidarrURL: z.string().nullable(),
  lidarrKey: z.string(),
  rootFolderPath: z.string(),
  qualityProfileID: z.number().int(),
  metadataProfileID: z.number().int(),
  /** Installation-wide Last.fm API key for people who have not connected their own. */
  lastfmKey: z.string().default(""),
  notifyURL: z.string().nullable().default(null),
  notifyFormat: z.enum(notifyFormats).default("json"),
  /** Optional bearer token for a private ntfy server or webhook. */
  notifyToken: z.string().default(""),
});
export type Settings = z.infer<typeof settingsSchema>;
export const emptySettings: Settings = {
  jellyfinURL: null,
  lidarrURL: null,
  lidarrKey: "",
  rootFolderPath: "",
  qualityProfileID: 0,
  metadataProfileID: 0,
  lastfmKey: "",
  notifyURL: null,
  notifyFormat: "json",
  notifyToken: "",
};
/** Lidarr can take requests only once an administrator chose where albums go. */
export const lidarrReady = (settings: Settings) =>
  !!settings.lidarrURL &&
  !!settings.lidarrKey &&
  !!settings.rootFolderPath &&
  settings.qualityProfileID > 0 &&
  settings.metadataProfileID > 0;
export const jellyfinSecret = z.object({ token: z.string(), userID: z.string(), username: z.string() });
export const lastfmSecret = z.object({ username: z.string(), apiKey: z.string() });
export type Service = "settings" | "jellyfin" | "lastfm";
const INSTALLATION = "installation";
type SqlValue = string | number | null;
const TAG_LENGTH = 16;
const NONCE_LENGTH = 12;
const count = z.object({ count: z.number() });
export const DEVICE_LIFETIME = 365 * 86_400_000;
const DEVICES_PER_USER = 20;

export type StoreOptions = {
  /** Refuse to create a database: operator commands must find the server's. */
  mustExist?: boolean;
  /**
   * Hold SQLite's lock for the connection's lifetime. The server does this so
   * offline maintenance commands can tell that it is running.
   */
  exclusive?: boolean;
  /** How long to wait for another process's lock; 0 fails at once. */
  busyTimeout?: number;
  /** Keep a copy of a database before upgrading its schema (default true). */
  upgradeCopy?: boolean;
  /**
   * Upgrade an older schema (default true). Operator commands open databases
   * as they are, so a backup or restore never turns into one the release that
   * made it would refuse.
   */
  migrate?: boolean;
};

/** The database is held by another process, most likely a running Leerr. */
export class DatabaseBusyError extends Error {
  constructor() {
    super("Leerr appears to be running and holds the database. Stop it first.");
    this.name = "DatabaseBusyError";
  }
}

const busyCode = z.object({ code: z.string().startsWith("SQLITE_BUSY") }).loose();

/** Durable state. Every SQL statement lives here; callers use domain methods. */
export class Store {
  readonly db: Database.Database;
  readonly #key: Buffer;

  constructor(path: string, key: Buffer, options: StoreOptions = {}) {
    if (key.length !== 32) throw new Error("Encryption key must contain exactly 32 bytes.");
    this.#key = key;
    if (options.mustExist && path !== ":memory:" && !existsSync(path))
      throw new Error(`No Leerr database at ${path}. Set LEERR_DATA to the server's data directory.`);
    this.db = new Database(path, { fileMustExist: options.mustExist === true, timeout: options.busyTimeout ?? 5000 });
    try {
      if (options.exclusive) this.db.pragma("locking_mode = EXCLUSIVE");
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("foreign_keys = ON");
      // Before any upgrade: a wrong key must leave the database as it was.
      if (this.#version() >= FIRST_SUPPORTED_VERSION) this.#checkKey();
      if (options.migrate === false) this.#refuseUnsupported(false);
      else this.#migrate(options.upgradeCopy === false ? ":memory:" : path);
      // The exclusive lock is only taken by the first write.
      if (options.exclusive) this.db.exec("BEGIN IMMEDIATE; COMMIT");
    } catch (cause) {
      this.db.close();
      if (busyCode.safeParse(cause).success) throw new DatabaseBusyError();
      throw cause;
    }
  }

  #version(): number {
    return z.number().parse(this.db.pragma("user_version", { simple: true }));
  }
  /** The file's schema version; below SCHEMA_VERSION only when opened with `migrate: false`. */
  schemaVersion(): number {
    return this.#version();
  }
  #refuseUnsupported(allowEmpty: boolean) {
    const version = this.#version();
    if (version > SCHEMA_VERSION) throw new Error("Database was created by a newer Leerr.");
    if (version === 0 && !allowEmpty) throw new Error("This is not a Leerr database.");
    if (version > 0 && version < FIRST_SUPPORTED_VERSION)
      throw new Error(
        "This database is from an earlier Leerr release that cannot be upgraded. Move it aside (keep a backup) and start with an empty data directory.",
      );
  }
  /** `copyPath` is where a pre-upgrade copy goes; ":memory:" skips it. */
  #migrate(copyPath: string) {
    this.#refuseUnsupported(true);
    const version = this.#version();
    if (version === 0)
      this.db.transaction(() => {
        this.db.exec(BASELINE);
        this.db.pragma(`user_version = ${FIRST_SUPPORTED_VERSION}`);
      })();
    const pending = MIGRATIONS.filter((migration) => migration.to > Math.max(version, FIRST_SUPPORTED_VERSION));
    if (!pending.length) return;
    // An upgraded install keeps a copy of the database it started from.
    if (version > 0 && copyPath !== ":memory:")
      this.db.prepare("VACUUM INTO ?").run(`${copyPath}.v${version}-${randomUUID().slice(0, 8)}.bak`);
    this.db.pragma("foreign_keys = OFF");
    try {
      for (const migration of pending)
        this.db.transaction(() => {
          this.db.exec(migration.sql);
          if (z.array(z.object({}).loose()).parse(this.db.pragma("foreign_key_check")).length)
            throw new Error(`Schema upgrade to version ${migration.to} broke a foreign key.`);
          this.db.pragma(`user_version = ${migration.to}`);
        })();
    } finally {
      this.db.pragma("foreign_keys = ON");
    }
  }

  // A wrong key must stop startup rather than quietly hiding connections.
  #checkKey() {
    for (const row of this.#secretRows())
      try {
        this.decrypt(row.owner, row.service, row.value);
      } catch (cause) {
        if (cause instanceof Error && cause.message === "Stored secret is truncated.") throw cause;
        throw new Error(
          "The encryption key does not match this database. Check LEERR_KEY_FILE (after rotate-key, use the new key; after a restore, use the key that belongs to that backup). In Docker, recreate the container after changing it: docker compose up -d --force-recreate.",
        );
      }
  }

  close() {
    this.db.close();
  }
  /** Whether another process (a running Leerr) holds the database at `path`. */
  static inUse(path: string): boolean {
    if (!existsSync(path)) return false;
    let db: Database.Database | null = null;
    try {
      db = new Database(path, { fileMustExist: true, timeout: 0 });
      db.exec("BEGIN IMMEDIATE; ROLLBACK");
      return false;
    } catch (cause) {
      // Anything else (e.g. a corrupt file) is not a running server, which is all this answers.
      return busyCode.safeParse(cause).success;
    } finally {
      db?.close();
    }
  }
  /**
   * Copies a database file to `destination` and opens the copy there, so
   * committed transactions in the source's write-ahead log come along. Nothing
   * is written beside the source, which may be read-only. Returns the schema
   * version (0: not a Leerr database).
   */
  static stage(source: string, destination: string): number {
    copyFileSync(source, destination);
    // The shared-memory index is never copied: SQLite rebuilds it from the log.
    if (existsSync(`${source}-wal`)) copyFileSync(`${source}-wal`, `${destination}-wal`);
    const db = new Database(destination, { fileMustExist: true, timeout: 0 });
    try {
      return z.number().parse(db.pragma("user_version", { simple: true }));
    } finally {
      db.close();
    }
  }
  /** SQLite's own consistency check: "ok" when the file is sound. */
  integrity(): string {
    return z
      .array(z.object({ integrity_check: z.string() }))
      .parse(this.db.pragma("integrity_check"))
      .map((row) => row.integrity_check)
      .join("; ");
  }
  /** A consistent copy of the live database, written next to `destination` and renamed into place. */
  async backup(destination: string) {
    const partial = `${destination}.partial`;
    await this.db.backup(partial);
    // A rollback-journal file opens read-only anywhere (a WAL file needs to write beside itself).
    const copy = new Database(partial, { fileMustExist: true });
    try {
      copy.pragma("journal_mode = DELETE");
    } finally {
      copy.close();
    }
    renameSync(partial, destination);
  }
  transaction<T>(work: () => T): T {
    return this.db.transaction(work)();
  }

  // Secrets: AES-256-GCM, bound to owner and service through associated data.

  encrypt(owner: string, service: string, plain: string): string {
    const nonce = randomBytes(NONCE_LENGTH);
    const cipher = createCipheriv("aes-256-gcm", this.#key, nonce, { authTagLength: TAG_LENGTH });
    cipher.setAAD(Buffer.from(`${owner}\0${service}`));
    const sealed = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), sealed]).toString("base64");
  }
  decrypt(owner: string, service: string, value: string): string {
    const bytes = Buffer.from(value, "base64");
    if (bytes.length < NONCE_LENGTH + TAG_LENGTH) throw new Error("Stored secret is truncated.");
    const decipher = createDecipheriv("aes-256-gcm", this.#key, bytes.subarray(0, NONCE_LENGTH), {
      authTagLength: TAG_LENGTH,
    });
    decipher.setAuthTag(bytes.subarray(NONCE_LENGTH, NONCE_LENGTH + TAG_LENGTH));
    decipher.setAAD(Buffer.from(`${owner}\0${service}`));
    return Buffer.concat([
      decipher.update(bytes.subarray(NONCE_LENGTH + TAG_LENGTH)),
      decipher.final(),
    ]).toString("utf8");
  }
  #secretRows() {
    return z
      .array(z.object({ owner: z.string(), service: z.string(), value: z.string() }))
      .parse(this.db.prepare("SELECT owner,service,value FROM secrets").all());
  }
  /** Re-encrypts every secret under `next`, returning the rewritten rows' count. */
  reencrypt(next: Store): number {
    const rows = this.#secretRows();
    this.transaction(() => {
      for (const row of rows)
        this.db
          .prepare("UPDATE secrets SET value=? WHERE owner=? AND service=?")
          .run(next.encrypt(row.owner, row.service, this.decrypt(row.owner, row.service, row.value)), row.owner, row.service);
    });
    return rows.length;
  }
  secret<T>(owner: string, service: Service, schema: z.ZodType<T>): T | null {
    const row = z
      .object({ value: z.string() })
      .optional()
      .parse(this.db.prepare("SELECT value FROM secrets WHERE owner=? AND service=?").get(owner, service));
    return row ? schema.parse(JSON.parse(this.decrypt(owner, service, row.value))) : null;
  }
  putSecret(owner: string, service: Service, value: string) {
    this.db
      .prepare(
        "INSERT INTO secrets(owner,service,value) VALUES(?,?,?) ON CONFLICT(owner,service) DO UPDATE SET value=excluded.value",
      )
      .run(owner, service, this.encrypt(owner, service, value));
  }
  deleteSecret(owner: string, service: Service) {
    this.db.prepare("DELETE FROM secrets WHERE owner=? AND service=?").run(owner, service);
  }
  /** Forgets every user's credential for a service (the installation moved). */
  deleteServiceSecrets(service: Service) {
    this.db.prepare("DELETE FROM secrets WHERE service=? AND owner<>?").run(service, INSTALLATION);
  }
  settings(): Settings {
    return this.secret(INSTALLATION, "settings", settingsSchema) ?? emptySettings;
  }
  saveSettings(settings: Settings) {
    this.putSecret(INSTALLATION, "settings", JSON.stringify(settingsSchema.parse(settings)));
  }

  // Users

  /** A trivial query proving the database still answers, for the health check. */
  healthy(): boolean {
    return this.db.prepare("SELECT 1").pluck().get() === 1;
  }
  setupRequired(): boolean {
    return !this.db.prepare("SELECT 1 FROM users LIMIT 1").get();
  }
  user(id: string): User | undefined {
    return userRow.optional().parse(this.db.prepare("SELECT * FROM users WHERE id=?").get(id));
  }
  userByName(username: string): User | undefined {
    return userRow.optional().parse(this.db.prepare("SELECT * FROM users WHERE username=?").get(username));
  }
  users(): User[] {
    return z.array(userRow).parse(this.db.prepare("SELECT * FROM users ORDER BY username COLLATE NOCASE").all());
  }
  createUser(username: string, passwordHash: string, role: Role, now: number): User {
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO users(id,username,password,role,createdAt) VALUES(?,?,?,?,?)")
      .run(id, username, passwordHash, role, now);
    return userRow.parse(this.db.prepare("SELECT * FROM users WHERE id=?").get(id));
  }
  /** A new password or disabling also forgets the account's known devices. */
  updateUser(id: string, changes: { passwordHash?: string; disabled?: boolean; role?: Role }) {
    this.transaction(() => {
      if (changes.passwordHash !== undefined)
        this.db.prepare("UPDATE users SET password=? WHERE id=?").run(changes.passwordHash, id);
      if (changes.disabled !== undefined)
        this.db.prepare("UPDATE users SET disabled=? WHERE id=?").run(changes.disabled ? 1 : 0, id);
      if (changes.role !== undefined) this.db.prepare("UPDATE users SET role=? WHERE id=?").run(changes.role, id);
      if (changes.passwordHash !== undefined || changes.disabled === true)
        this.db.prepare("DELETE FROM devices WHERE userID=?").run(id);
    });
  }
  activeAdminCount(): number {
    return count.parse(this.db.prepare("SELECT COUNT(*) AS count FROM users WHERE role='admin' AND disabled=0").get()).count;
  }

  // Sessions and stream tickets

  createSession(userID: string, device: Device, name: string, now: number, lifetime: number) {
    const token = opaque();
    const csrf = opaque();
    this.db
      .prepare("INSERT INTO sessions(id,userID,csrf,device,name,createdAt,expiresAt) VALUES(?,?,?,?,?,?,?)")
      .run(digest(token), userID, csrf, device, name, now, now + lifetime);
    return { token, csrf, expiresAt: now + lifetime };
  }
  session(token: string, now: number): Session | undefined {
    return sessionRow
      .optional()
      .parse(this.db.prepare("SELECT * FROM sessions WHERE id=? AND expiresAt>?").get(digest(token), now));
  }
  sessionByID(id: string): Session | undefined {
    return sessionRow.optional().parse(this.db.prepare("SELECT * FROM sessions WHERE id=?").get(id));
  }
  sessions(userID: string, now: number): Session[] {
    return z
      .array(sessionRow)
      .parse(
        this.db
          .prepare("SELECT * FROM sessions WHERE userID=? AND expiresAt>? ORDER BY createdAt DESC")
          .all(userID, now),
      );
  }
  sessionIDs(userID: string): string[] {
    return z
      .array(z.object({ id: z.string() }))
      .parse(this.db.prepare("SELECT id FROM sessions WHERE userID=?").all(userID))
      .map((row) => row.id);
  }
  deleteSession(id: string, userID: string): boolean {
    return this.db.prepare("DELETE FROM sessions WHERE id=? AND userID=?").run(id, userID).changes > 0;
  }
  deleteUserSessions(userID: string, except: string | null = null) {
    this.db.prepare("DELETE FROM sessions WHERE userID=? AND id IS NOT ?").run(userID, except);
  }
  deleteAllSessions() {
    this.db.prepare("DELETE FROM sessions").run();
  }
  createTicket(sessionID: string, trackID: string, expiresAt: number): string {
    const ticket = opaque();
    this.db
      .prepare("INSERT INTO tickets(id,sessionID,trackID,expiresAt) VALUES(?,?,?,?)")
      .run(digest(ticket), sessionID, trackID, expiresAt);
    return ticket;
  }
  /** A ticket is usable only while it, its session and its user are all valid. */
  ticket(ticket: string, now: number): Ticket | undefined {
    return ticketRow
      .optional()
      .parse(
        this.db
          .prepare(
            `SELECT t.sessionID, s.userID, t.trackID, t.expiresAt FROM tickets t
             JOIN sessions s ON s.id=t.sessionID JOIN users u ON u.id=s.userID
             WHERE t.id=? AND t.expiresAt>? AND s.expiresAt>? AND u.disabled=0`,
          )
          .get(digest(ticket), now, now),
      );
  }
  deleteUserTickets(userID: string) {
    this.db
      .prepare("DELETE FROM tickets WHERE sessionID IN (SELECT id FROM sessions WHERE userID=?)")
      .run(userID);
  }
  deleteAllTickets() {
    this.db.prepare("DELETE FROM tickets").run();
  }
  prune(now: number) {
    this.db.prepare("DELETE FROM tickets WHERE expiresAt<=?").run(now);
    this.db.prepare("DELETE FROM sessions WHERE expiresAt<=?").run(now);
    this.db.prepare("DELETE FROM devices WHERE lastUsedAt<=?").run(now - DEVICE_LIFETIME);
  }

  // Known devices: proof that a browser signed in to an account before, so
  // strangers' failed guesses cannot lock its owner out (see LoginThrottle).

  /** A new known device; the account keeps only its most recently used ones. */
  createDevice(userID: string, now: number): string {
    const token = opaque();
    this.transaction(() => {
      this.db.prepare("INSERT INTO devices(id,userID,createdAt,lastUsedAt) VALUES(?,?,?,?)").run(digest(token), userID, now, now);
      this.db
        .prepare(
          "DELETE FROM devices WHERE userID=? AND id NOT IN (SELECT id FROM devices WHERE userID=? ORDER BY lastUsedAt DESC LIMIT ?)",
        )
        .run(userID, userID, DEVICES_PER_USER);
    });
    return token;
  }
  /** The account a device token belongs to, if it is still valid. */
  deviceUser(token: string, now: number): string | undefined {
    return z
      .object({ userID: z.string() })
      .optional()
      .parse(this.db.prepare("SELECT userID FROM devices WHERE id=? AND lastUsedAt>?").get(digest(token), now - DEVICE_LIFETIME))
      ?.userID;
  }
  /** Extends a device's lifetime after a successful sign-in from it. */
  touchDevice(token: string, now: number) {
    this.db.prepare("UPDATE devices SET lastUsedAt=? WHERE id=?").run(now, digest(token));
  }

  // Acquisitions (installation-wide) and requests (per user)

  acquisition(id: string): Acquisition | undefined {
    return acquisitionRow.optional().parse(this.db.prepare("SELECT * FROM acquisitions WHERE id=?").get(id));
  }
  acquisitionByGroup(releaseGroupMBID: string): Acquisition | undefined {
    return acquisitionRow
      .optional()
      .parse(this.db.prepare("SELECT * FROM acquisitions WHERE releaseGroupMBID=?").get(releaseGroupMBID));
  }
  acquisitions(): Array<Acquisition & { requesters: number }> {
    return z
      .array(acquisitionRow.extend({ requesters: z.number().int() }))
      .parse(
        this.db
          .prepare(
            `SELECT a.*, (SELECT COUNT(*) FROM requests r WHERE r.acquisitionID=a.id) AS requesters
             FROM acquisitions a ORDER BY a.updatedAt DESC LIMIT 500`,
          )
          .all(),
      );
  }
  dueAcquisitions(now: number, limit: number): Acquisition[] {
    return z
      .array(acquisitionRow)
      .parse(
        this.db
          .prepare("SELECT * FROM acquisitions WHERE nextAt<=? ORDER BY nextAt, createdAt LIMIT ?")
          .all(now, limit),
      );
  }
  /** Rows whose last Lidarr mutation is still unconfirmed. */
  pendingMutationCount(): number {
    return count.parse(this.db.prepare("SELECT COUNT(*) AS count FROM acquisitions WHERE phase LIKE 'pending_%'").get())
      .count;
  }
  acquisitionCounts(): Record<AcquisitionStatus, number> {
    const rows = z
      .array(z.object({ status: z.enum(acquisitionStatuses), count: z.number() }))
      .parse(this.db.prepare("SELECT status, COUNT(*) AS count FROM acquisitions GROUP BY status").all());
    const counts: Record<AcquisitionStatus, number> = { requested: 0, acquiring: 0, imported: 0, failed: 0, attention: 0 };
    for (const row of rows) counts[row.status] = row.count;
    return counts;
  }
  /** After switching Lidarr installations every unfinished album starts over there. */
  restartAcquisitions(now: number): number {
    return this.db
      .prepare(
        `UPDATE acquisitions SET status='requested', reason=NULL, phase='ready', lidarrAlbumID=NULL, commandID=NULL,
         searchFloor=0, failures=0, nextAt=0, pinEdition=0, phaseAt=@now, updatedAt=@now WHERE status<>'imported'`,
      )
      .run({ now }).changes;
  }
  /** Makes rows waiting to be added due now, e.g. once Lidarr's profiles are chosen. */
  wakeWaitingAcquisitions(now: number): number {
    return this.db
      .prepare(
        "UPDATE acquisitions SET failures=0, nextAt=0, reason=NULL, updatedAt=@now WHERE phase='ready' AND status='requested'",
      )
      .run({ now }).changes;
  }
  /**
   * Compare-and-set on the acquisition: `expected` guards against lost
   * updates between the worker and user retries. Returns whether it applied.
   * `updatedAt` only moves when the user-visible status or reason changes.
   */
  updateAcquisition(
    id: string,
    expected: { phase?: Phase; status?: AcquisitionStatus; phaseAt?: number },
    changes: Partial<
      Pick<
        Acquisition,
        "status" | "reason" | "phase" | "lidarrAlbumID" | "commandID" | "searchFloor" | "phaseAt" | "failures" | "nextAt" | "pinEdition" | "notified"
      >
    >,
    now: number,
  ): boolean {
    const assignments: string[] = [];
    const parameters = new Map<string, SqlValue>([
      ["id", id],
      ["updatedAt", now],
    ]);
    const visible: string[] = [];
    for (const [column, value] of Object.entries(changes)) {
      if (value === undefined) continue;
      assignments.push(`${column}=@${column}`);
      parameters.set(column, value === true ? 1 : value === false ? 0 : value);
      // SET expressions see the old row, so this compares against the previous value.
      if (column === "status" || column === "reason") visible.push(`${column} IS NOT @${column}`);
    }
    if (visible.length) assignments.push(`updatedAt=CASE WHEN ${visible.join(" OR ")} THEN @updatedAt ELSE updatedAt END`);
    if (!assignments.length) assignments.push("id=id");
    const conditions = ["id=@id"];
    if (expected.phase) {
      conditions.push("phase=@expectedPhase");
      parameters.set("expectedPhase", expected.phase);
    }
    if (expected.status) {
      conditions.push("status=@expectedStatus");
      parameters.set("expectedStatus", expected.status);
    }
    if (expected.phaseAt !== undefined) {
      conditions.push("phaseAt=@expectedPhaseAt");
      parameters.set("expectedPhaseAt", expected.phaseAt);
    }
    return (
      this.db
        .prepare(`UPDATE acquisitions SET ${assignments.join(",")} WHERE ${conditions.join(" AND ")}`)
        .run(Object.fromEntries(parameters)).changes > 0
    );
  }
  deleteAcquisition(id: string): boolean {
    return this.db.prepare("DELETE FROM acquisitions WHERE id=?").run(id).changes > 0;
  }
  /**
   * Idempotently records a user's request, sharing one acquisition per album.
   * Requesting an album Leerr considers imported re-checks it: Lidarr may have
   * lost it since, and only a person asking again should trigger a new search.
   */
  request(
    userID: string,
    identity: { releaseGroupMBID: string; releaseMBID: string; artistMBID: string; title: string; artist: string },
    now: number,
  ): { requestID: string; acquisition: Acquisition; created: boolean } {
    return this.transaction(() => {
      let acquisition = this.acquisitionByGroup(identity.releaseGroupMBID);
      if (acquisition?.status === "imported") {
        this.updateAcquisition(
          acquisition.id,
          { status: "imported" },
          { status: "requested", reason: null, phase: "ready", phaseAt: now, commandID: null, failures: 0, nextAt: 0 },
          now,
        );
        acquisition = this.acquisition(acquisition.id);
      }
      if (!acquisition) {
        const id = randomUUID();
        this.db
          .prepare(
            `INSERT INTO acquisitions(id,releaseGroupMBID,releaseMBID,artistMBID,title,artist,phaseAt,createdAt,updatedAt)
             VALUES(?,?,?,?,?,?,?,?,?)`,
          )
          .run(id, identity.releaseGroupMBID, identity.releaseMBID, identity.artistMBID, identity.title, identity.artist, now, now, now);
        acquisition = acquisitionRow.parse(this.db.prepare("SELECT * FROM acquisitions WHERE id=?").get(id));
      }
      const created =
        this.db
          .prepare("INSERT OR IGNORE INTO requests(id,userID,acquisitionID,createdAt) VALUES(?,?,?,?)")
          .run(randomUUID(), userID, acquisition.id, now).changes > 0;
      const requestID = z
        .object({ id: z.string() })
        .parse(this.db.prepare("SELECT id FROM requests WHERE userID=? AND acquisitionID=?").get(userID, acquisition.id)).id;
      return { requestID, acquisition, created };
    });
  }
  requests(userID: string): RequestRecord[] {
    return z
      .array(requestRow)
      .parse(
        this.db
          .prepare(
            `SELECT a.*, r.id AS requestID, r.createdAt AS requestedAt, r.seenStatus FROM requests r
             JOIN acquisitions a ON a.id=r.acquisitionID WHERE r.userID=? ORDER BY r.createdAt DESC LIMIT 500`,
          )
          .all(userID),
      );
  }
  /** Records which outcome the person's Requests page last showed for each request. */
  markRequestsSeen(userID: string, items: ReadonlyArray<{ id: string; status: string }>) {
    const update = this.db.prepare("UPDATE requests SET seenStatus=? WHERE id=? AND userID=?");
    this.transaction(() => {
      for (const item of items) update.run(item.status, item.id, userID);
    });
  }
  /**
   * Removes one person's request. The shared acquisition goes too once nobody
   * else wants it, unless a Lidarr change for it is still unconfirmed.
   */
  withdrawRequest(requestID: string, userID: string): "withdrawn" | "not_found" | "unconfirmed" {
    return this.transaction(() => {
      const acquisitionID = this.requestAcquisitionID(requestID, userID);
      if (!acquisitionID) return "not_found";
      const others = count.parse(
        this.db
          .prepare("SELECT COUNT(*) AS count FROM requests WHERE acquisitionID=? AND id<>?")
          .get(acquisitionID, requestID),
      ).count;
      if (!others) {
        const acquisition = this.acquisition(acquisitionID);
        // Within the confirmation window the journal must survive; once surfaced as attention it may go.
        if (acquisition?.phase.startsWith("pending_") && acquisition.status !== "attention") return "unconfirmed";
        this.deleteAcquisition(acquisitionID);
        return "withdrawn";
      }
      this.db.prepare("DELETE FROM requests WHERE id=? AND userID=?").run(requestID, userID);
      return "withdrawn";
    });
  }
  requesterNames(acquisitionID: string): string[] {
    return z
      .array(z.object({ username: z.string() }))
      .parse(
        this.db
          .prepare(
            "SELECT u.username FROM requests r JOIN users u ON u.id=r.userID WHERE r.acquisitionID=? ORDER BY r.createdAt",
          )
          .all(acquisitionID),
      )
      .map((row) => row.username);
  }
  requestAcquisitionID(requestID: string, userID: string): string | undefined {
    return z
      .object({ acquisitionID: z.string() })
      .optional()
      .parse(this.db.prepare("SELECT acquisitionID FROM requests WHERE id=? AND userID=?").get(requestID, userID))
      ?.acquisitionID;
  }
  requestedGroups(userID: string): Set<string> {
    return new Set(
      z
        .array(z.object({ releaseGroupMBID: z.string() }))
        .parse(
          this.db
            .prepare(
              "SELECT a.releaseGroupMBID FROM requests r JOIN acquisitions a ON a.id=r.acquisitionID WHERE r.userID=?",
            )
            .all(userID),
        )
        .map((row) => row.releaseGroupMBID),
    );
  }
}
