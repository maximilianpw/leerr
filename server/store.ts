import Database from "better-sqlite3";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";

export const opaque = () => randomBytes(32).toString("base64url");
export const digest = (value: string) => createHash("sha256").update(value).digest("hex");

// Versions 1–2 were the pre-refresh schema, which is not migrated.
const SCHEMA_VERSION = 3;
const SCHEMA = `
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
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Acquisition = z.infer<typeof acquisitionRow>;
const requestRow = acquisitionRow.extend({
  requestID: z.string(),
  requestedAt: z.number(),
});
export type RequestRecord = z.infer<typeof requestRow>;
const ticketRow = z.object({
  sessionID: z.string(),
  userID: z.string(),
  trackID: z.string(),
  expiresAt: z.number(),
});
export type Ticket = z.infer<typeof ticketRow>;

export const settingsSchema = z.object({
  jellyfinURL: z.string().nullable(),
  lidarrURL: z.string().nullable(),
  lidarrKey: z.string(),
  rootFolderPath: z.string(),
  qualityProfileID: z.number().int(),
  metadataProfileID: z.number().int(),
});
export type Settings = z.infer<typeof settingsSchema>;
export const emptySettings: Settings = {
  jellyfinURL: null,
  lidarrURL: null,
  lidarrKey: "",
  rootFolderPath: "",
  qualityProfileID: 0,
  metadataProfileID: 0,
};
export const jellyfinSecret = z.object({ token: z.string(), userID: z.string(), username: z.string() });
export const lastfmSecret = z.object({ username: z.string(), apiKey: z.string() });
export type Service = "settings" | "jellyfin" | "lastfm";
const INSTALLATION = "installation";
type SqlValue = string | number | null;
const TAG_LENGTH = 16;
const NONCE_LENGTH = 12;

/** Durable state. Every SQL statement lives here; callers use domain methods. */
export class Store {
  readonly db: Database.Database;
  readonly #key: Buffer;

  constructor(path: string, key: Buffer) {
    if (key.length !== 32) throw new Error("Encryption key must contain exactly 32 bytes.");
    this.#key = key;
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    const version = z.number().parse(this.db.pragma("user_version", { simple: true }));
    if (version > SCHEMA_VERSION) throw new Error("Database was created by a newer Leerr.");
    if (version > 0 && version < SCHEMA_VERSION)
      throw new Error(
        "This database is from an earlier Leerr release that cannot be upgraded. Move it aside (keep a backup) and start with an empty data directory.",
      );
    if (version === 0)
      this.db.transaction(() => {
        this.db.exec(SCHEMA);
        this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
      })();
    // A wrong key must stop startup rather than quietly hiding connections.
    for (const row of this.#secretRows()) this.decrypt(row.owner, row.service, row.value);
  }

  close() {
    this.db.close();
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
  updateUser(id: string, changes: { passwordHash?: string; disabled?: boolean; role?: Role }) {
    if (changes.passwordHash !== undefined)
      this.db.prepare("UPDATE users SET password=? WHERE id=?").run(changes.passwordHash, id);
    if (changes.disabled !== undefined)
      this.db.prepare("UPDATE users SET disabled=? WHERE id=?").run(changes.disabled ? 1 : 0, id);
    if (changes.role !== undefined) this.db.prepare("UPDATE users SET role=? WHERE id=?").run(changes.role, id);
  }
  activeAdminCount(): number {
    return z
      .object({ count: z.number() })
      .parse(this.db.prepare("SELECT COUNT(*) AS count FROM users WHERE role='admin' AND disabled=0").get()).count;
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
  deleteUserSessions(userID: string) {
    this.db.prepare("DELETE FROM sessions WHERE userID=?").run(userID);
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
    return z
      .object({ count: z.number() })
      .parse(this.db.prepare("SELECT COUNT(*) AS count FROM acquisitions WHERE phase LIKE 'pending_%'").get()).count;
  }
  /** After switching Lidarr installations every unfinished album starts over there. */
  restartAcquisitions(now: number): number {
    return this.db
      .prepare(
        `UPDATE acquisitions SET status='requested', reason=NULL, phase='ready', lidarrAlbumID=NULL, commandID=NULL,
         searchFloor=0, failures=0, nextAt=0, phaseAt=@now, updatedAt=@now WHERE status<>'imported'`,
      )
      .run({ now }).changes;
  }
  /**
   * Compare-and-set on the acquisition: `expected` guards against lost
   * updates between the worker and user retries. Returns whether it applied.
   */
  updateAcquisition(
    id: string,
    expected: { phase?: Phase; status?: AcquisitionStatus },
    changes: Partial<Pick<Acquisition, "status" | "reason" | "phase" | "lidarrAlbumID" | "commandID" | "searchFloor" | "phaseAt" | "failures" | "nextAt">>,
    now: number,
  ): boolean {
    const assignments: string[] = ["updatedAt=@updatedAt"];
    const parameters = new Map<string, SqlValue>([
      ["id", id],
      ["updatedAt", now],
    ]);
    for (const [column, value] of Object.entries(changes)) {
      if (value === undefined) continue;
      assignments.push(`${column}=@${column}`);
      parameters.set(column, value);
    }
    const conditions = ["id=@id"];
    if (expected.phase) {
      conditions.push("phase=@expectedPhase");
      parameters.set("expectedPhase", expected.phase);
    }
    if (expected.status) {
      conditions.push("status=@expectedStatus");
      parameters.set("expectedStatus", expected.status);
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
  /** Idempotently records a user's request, sharing one acquisition per album. */
  request(
    userID: string,
    identity: { releaseGroupMBID: string; releaseMBID: string; artistMBID: string; title: string; artist: string },
    now: number,
  ): { requestID: string; acquisition: Acquisition; created: boolean } {
    return this.transaction(() => {
      let acquisition = this.acquisitionByGroup(identity.releaseGroupMBID);
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
            `SELECT a.*, r.id AS requestID, r.createdAt AS requestedAt FROM requests r
             JOIN acquisitions a ON a.id=r.acquisitionID WHERE r.userID=? ORDER BY r.createdAt DESC LIMIT 500`,
          )
          .all(userID),
      );
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
