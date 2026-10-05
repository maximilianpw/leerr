import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { opaque } from "./store.ts";

export type Backups = { directory: string; everyHours: number; keep: number };
export type Deployment = {
  origin: string;
  data: string;
  database: string;
  key: Buffer;
  setupTokenFile: string;
  trustProxy: string[];
  host: string;
  port: number;
  backups: Backups | null;
};

/** Reads a base64 32-byte key. `label` names the setting in errors (e.g. LEERR_KEY_FILE). */
function readKey(path: string, label = "LEERR_KEY_FILE"): Buffer {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (cause) {
    const code = z.object({ code: z.string() }).loose().safeParse(cause);
    if (code.success && code.data.code === "EACCES")
      throw new Error(
        `${label} (${path}) is not readable by this process (uid ${process.getuid?.() ?? "unknown"}). Give that user read access, keeping the file private.`,
      );
    throw new Error(`${label} (${path}) could not be read: ${cause instanceof Error ? cause.message : "unknown error"}.`);
  }
  const key = Buffer.from(text.trim(), "base64");
  if (key.length !== 32) throw new Error(`${label} must contain a base64-encoded 32-byte key.`);
  return key;
}

const integer = (name: string, fallback: string, min: number, max: number, env: NodeJS.ProcessEnv) =>
  z.coerce
    .number({ error: `${name} must be a whole number.` })
    .int(`${name} must be a whole number.`)
    .min(min, `${name} must be at least ${min}.`)
    .max(max, `${name} must be at most ${max}.`)
    .parse(env[name] ?? fallback);

/** Reads and validates the deployment environment. Fails fast on anything unsafe. */
export function deployment(env = process.env): Deployment {
  const origin = z
    .string({ error: "Set LEERR_ORIGIN to the public HTTPS origin, e.g. https://music.example.com." })
    .min(1, "Set LEERR_ORIGIN to the public HTTPS origin, e.g. https://music.example.com.")
    .parse(env.LEERR_ORIGIN);
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new Error("LEERR_ORIGIN must be an HTTPS origin such as https://music.example.com.");
  }
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash || url.username || url.password)
    throw new Error("LEERR_ORIGIN must be an HTTPS origin such as https://music.example.com, without a path.");
  const data = resolve(env.LEERR_DATA ?? "data");
  mkdirSync(data, { recursive: true, mode: 0o700 });
  // mkdir's mode does not apply to an existing (e.g. image-created) directory.
  chmodSync(data, 0o700);
  const key = readKey(z.string({ error: "Set LEERR_KEY_FILE." }).min(1, "Set LEERR_KEY_FILE.").parse(env.LEERR_KEY_FILE));
  const database = resolve(data, "leerr.sqlite");
  const backupDirectory = env.LEERR_BACKUP_DIR?.trim();
  return {
    origin: url.origin,
    data,
    database,
    key,
    setupTokenFile: resolve(data, "setup-token"),
    trustProxy: (env.LEERR_TRUST_PROXY ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
    host: env.HOST ?? "0.0.0.0",
    port: integer("PORT", "3000", 1, 65_535, env),
    backups: backupDirectory
      ? {
          directory: resolve(backupDirectory),
          // Timers cannot wait longer than about 24.8 days.
          everyHours: integer("LEERR_BACKUP_HOURS", "24", 1, 24 * 24, env),
          keep: integer("LEERR_BACKUP_KEEP", "7", 1, 1000, env),
        }
      : null,
  };
}

/** Returns the one-time setup token, creating it (mode 0600) on first use. */
export function ensureSetupToken(path: string): string {
  if (!existsSync(path)) writeFileSync(path, `${opaque()}\n`, { mode: 0o600, flag: "wx" });
  return readFileSync(path, "utf8").trim();
}

export { readKey };
