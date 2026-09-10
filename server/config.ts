import { mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { opaque } from "./store.ts";

export function deployment() {
  const origin = z.url().parse(process.env.LEERR_ORIGIN);
  const url = new URL(origin);
  if (
    url.protocol !== "https:" ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new Error("LEERR_ORIGIN must be an HTTPS origin without a subpath.");
  const data = resolve(process.env.LEERR_DATA ?? "data");
  mkdirSync(data, { recursive: true, mode: 0o700 });
  const keyFile = z.string().min(1).parse(process.env.LEERR_KEY_FILE);
  const key = Buffer.from(readFileSync(keyFile, "utf8").trim(), "base64");
  if (key.length !== 32)
    throw new Error(
      "LEERR_KEY_FILE must contain a base64 encoded 32-byte key.",
    );
  const tokenFile = resolve(data, "setup-token");
  if (!existsSync(tokenFile))
    writeFileSync(tokenFile, opaque(), { mode: 0o600, flag: "wx" });
  return {
    origin: url.origin,
    data,
    key,
    setupToken: readFileSync(tokenFile, "utf8").trim(),
    trustProxy: (process.env.LEERR_TRUST_PROXY ?? "")
      .split(",")
      .filter(Boolean),
  };
}
