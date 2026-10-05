import { fileURLToPath } from "node:url";
import { z } from "zod";
import { scheduleBackups } from "./backups.ts";
import { deployment, ensureSetupToken } from "./config.ts";
import { buildApp } from "./http/app.ts";
import type { Runtime } from "./http/context.ts";
import { logEvent } from "./log.ts";
import { Store } from "./store.ts";

/** Below compose's 60 s stop_grace_period, so Leerr exits on its own terms. */
const SHUTDOWN_DEADLINE = 50_000;

const describe = (cause: unknown) =>
  cause instanceof z.ZodError ? z.prettifyError(cause) : cause instanceof Error ? cause.message : "unknown error";

process.on("uncaughtException", (cause) => {
  logEvent("crashed", { error: describe(cause) });
  process.exit(1);
});
process.on("unhandledRejection", (cause) => {
  logEvent("crashed", { error: describe(cause) });
  process.exit(1);
});

// Everything Leerr writes (database, WAL, setup token, backups) is private to its user.
process.umask(0o077);
let started;
try {
  const config = deployment();
  // The exclusive lock lets offline maintenance commands tell that Leerr is running.
  const store = new Store(config.database, config.key, { exclusive: true });
  started = { config, store };
} catch (cause) {
  logEvent("startup_failed", { error: describe(cause) });
  process.exit(1);
}
const { config, store } = started;
const setupRequired = store.setupRequired();
const runtime: Runtime = { startedAt: Date.now(), lastBackup: null };
const { app, reconciler } = await buildApp({
  store,
  origin: config.origin,
  setupToken: setupRequired ? ensureSetupToken(config.setupTokenFile) : "",
  setupTokenFile: config.setupTokenFile,
  trustProxy: config.trustProxy,
  webRoot: fileURLToPath(new URL("../dist/web", import.meta.url)),
  log: logEvent,
  runtime,
});

const timer = setInterval(() => void reconciler.run(), 15_000);
const stopBackups = config.backups ? scheduleBackups(store, config.backups, runtime, logEvent) : () => {};

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    if (stopping) {
      logEvent("stop_forced", { signal });
      process.exit(1);
    }
    stopping = true;
    clearInterval(timer);
    stopBackups();
    logEvent("stopping", { signal });
    setTimeout(() => {
      logEvent("stop_timeout", { afterMs: SHUTDOWN_DEADLINE });
      process.exit(1);
    }, SHUTDOWN_DEADLINE).unref();
    app
      .close()
      .then(() => {
        store.close();
        logEvent("stopped", {});
      })
      .catch((cause: Error) => {
        logEvent("stop_failed", { error: cause.message });
        process.exitCode = 1;
      });
  });

await app.listen({ host: config.host, port: config.port });
logEvent("ready", {
  origin: config.origin,
  setupTokenFile: setupRequired ? config.setupTokenFile : null,
  backups: config.backups?.directory ?? null,
});
void reconciler.run();
