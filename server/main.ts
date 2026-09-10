import { resolve } from "node:path";
import { deployment } from "./config.ts";
import { Store } from "./store.ts";
import { buildApp } from "./app.ts";

const config = deployment();
const store = new Store(resolve(config.data, "leerr.sqlite"), config.key);
const { app, worker } = await buildApp({
  ...config,
  store,
  webRoot: resolve("dist/web"),
});
const timer = setInterval(() => {
  void worker.run().catch(() => {
    process.stderr.write("Reconciliation failed; durable intent retained.\n");
  });
}, 15_000);
timer.unref();
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, async () => {
    clearInterval(timer);
    await app.close();
    store.close();
  });
await app.listen({
  host: process.env.HOST ?? "0.0.0.0",
  port: Number(process.env.PORT ?? 3000),
});
process.stdout.write(
  "Leerr is ready. Setup token is stored in the protected data directory.\n",
);
