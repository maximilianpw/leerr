import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { opaque } from "./store.ts";

export type Deployment = {
  origin: string;
  data: string;
  database: string;
  key: Buffer;
  setupTokenFile: string;
  trustProxy: string[];
  host: string;
  port: number;
};

function readKey(path: string): Buffer {
  const key = Buffer.from(readFileSync(path, "utf8").trim(), "base64");
  if (key.length !== 32) throw new Error("LEERR_KEY_FILE must contain a base64-encoded 32-byte key.");
  return key;
}

/** Reads and validates the deployment environment. Fails fast on anything unsafe. */
export function deployment(env = process.env): Deployment {
  const url = new URL(z.url().parse(env.LEERR_ORIGIN));
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash || url.username || url.password)
    throw new Error("LEERR_ORIGIN must be an HTTPS origin such as https://music.example.com, without a path.");
  const data = resolve(env.LEERR_DATA ?? "data");
  mkdirSync(data, { recursive: true, mode: 0o700 });
  // mkdir's mode does not apply to an existing (e.g. image-created) directory.
  chmodSync(data, 0o700);
  const key = readKey(z.string().min(1, "Set LEERR_KEY_FILE.").parse(env.LEERR_KEY_FILE));
  const database = resolve(data, "leerr.sqlite");
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
    port: z.coerce.number().int().min(1).max(65_535).parse(env.PORT ?? "3000"),
  };
}

/** Returns the one-time setup token, creating it (mode 0600) on first use. */
export function ensureSetupToken(path: string): string {
  if (!existsSync(path)) writeFileSync(path, `${opaque()}\n`, { mode: 0o600, flag: "wx" });
  return readFileSync(path, "utf8").trim();
}

export { readKey };
