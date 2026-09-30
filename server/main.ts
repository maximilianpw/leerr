import { deployment, ensureSetupToken } from "./config.ts";
import { buildApp } from "./http/app.ts";
import { logEvent } from "./log.ts";
import { Store } from "./store.ts";

// Everything Leerr writes (database, WAL, setup token) is private to its user.
process.umask(0o077);
const config = deployment();
const store = new Store(config.database, config.key);
const setupRequired = store.setupRequired();
const { app, reconciler } = await buildApp({
  store,
  origin: config.origin,
  setupToken: setupRequired ? ensureSetupToken(config.setupTokenFile) : "",
  setupTokenFile: config.setupTokenFile,
  trustProxy: config.trustProxy,
  webRoot: new URL("../dist/web", import.meta.url).pathname,
  log: logEvent,
});

const reconcile = () => {
  reconciler.run().catch((cause: Error) => logEvent("reconcile_failed", { error: cause.message }));
};
const timer = setInterval(reconcile, 15_000);

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    logEvent("stopping", { signal });
    app
      .close()
      .then(() => store.close())
      .catch((cause: Error) => {
        logEvent("stop_failed", { error: cause.message });
        process.exitCode = 1;
      });
  });

await app.listen({ host: config.host, port: config.port });
logEvent("ready", {
  origin: config.origin,
  setupTokenFile: setupRequired ? config.setupTokenFile : null,
});
reconcile();
