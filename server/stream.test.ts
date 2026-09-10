import test from "node:test";
import assert from "node:assert/strict";
import { buildApp, passwordHash } from "./app.ts";
import { FakeUpstreams, makeStore } from "./test-fixtures.ts";
import { z } from "zod";
import { get, type IncomingMessage } from "node:http";

test("proxy delivers before upstream EOF and aborts upstream on client disconnect", async (t) => {
  let didAbort = false;
  const aborted = Promise.withResolvers<void>();
  class StreamingUpstreams extends FakeUpstreams {
    override async jellyfinOriginal(
      _e: string,
      _token: string,
      _user: string,
      _track: string,
      _range: string | undefined,
      signal?: AbortSignal,
    ) {
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([70, 76, 65, 67]));
            signal?.addEventListener(
              "abort",
              () => {
                didAbort = true;
                controller.error(new Error("Cancelled"));
                aborted.resolve();
              },
              { once: true },
            );
          },
        }),
        { headers: { "Content-Type": "audio/flac" } },
      );
    }
  }
  const store = makeStore();
  store.db
    .prepare("INSERT INTO users(id,username,password,role) VALUES(?,?,?,?)")
    .run("user", "admin", await passwordHash("admin-password"), "admin");
  store.putSecret(
    "installation",
    "settings",
    JSON.stringify({
      jellyfinURL: "https://fixture.test",
      lidarrURL: null,
      lidarrKey: "",
      rootFolderPath: "",
      qualityProfileID: 0,
      metadataProfileID: 0,
    }),
  );
  store.putSecret(
    "user",
    "jellyfin",
    JSON.stringify({ token: "fixture-token", userID: "jf-user" }),
  );
  const { app } = await buildApp({
    store,
    origin: "http://leerr.test",
    setupToken: "fixture",
    upstream: new StreamingUpstreams(),
    secure: false,
  });
  t.after(async () => {
    await app.close();
    store.close();
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const login = await app.inject({
    method: "POST",
    url: "/api/v1/sessions",
    headers: { host: "leerr.test" },
    payload: {
      username: "admin",
      password: "admin-password",
      device: "native",
      name: "test",
    },
  });
  const { token } = z.object({ token: z.string() }).parse(login.json());
  const ticket = await app.inject({
    method: "POST",
    url: "/api/v1/stream-tickets",
    headers: { host: "leerr.test", authorization: `Bearer ${token}` },
    payload: { trackID: "track" },
  });
  const { path } = z.object({ path: z.string() }).parse(ticket.json());
  const received = Promise.withResolvers<IncomingMessage>();
  const client = get(
    address + path,
    { headers: { host: "leerr.test" } },
    received.resolve,
  );
  client.once("error", received.reject);
  const response = await received.promise;
  assert.equal(response.statusCode, 200);
  const chunk = Promise.withResolvers<Buffer>();
  response.once("data", chunk.resolve);
  assert.deepEqual(await chunk.promise, Buffer.from([70, 76, 65, 67]));
  assert.equal(didAbort, false);
  response.destroy();
  const timeout = setTimeout(
    () => aborted.reject(new Error("Upstream was not cancelled")),
    3000,
  );
  try {
    await aborted.promise;
    assert.equal(didAbort, true);
  } finally {
    clearTimeout(timeout);
  }
});
