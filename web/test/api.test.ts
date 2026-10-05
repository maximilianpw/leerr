import assert from "node:assert/strict";
import test from "node:test";
import * as z from "zod/mini";
import { ApiError, configureApi, request, send } from "../src/api.ts";

type Call = { url: string; method: string; headers: Headers };

/** Replaces fetch for one test; responses are produced in order. */
function stubFetch(t: { after: (fn: () => void) => void }, responses: Array<() => Response>) {
  const calls: Call[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), method: init?.method ?? "GET", headers: new Headers(init?.headers) });
    const next = responses.shift();
    if (!next) throw new Error("unexpected fetch");
    return next();
  };
  t.after(() => {
    globalThis.fetch = real;
  });
  return calls;
}
type Json = z.infer<ReturnType<typeof z.json>>;
const json = (body: Json, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const failure = (status: number, code: string) => json({ error: { code, message: `${code} message` } }, status);
function hooks() {
  const seen = { unauthorized: 0, stale: 0 };
  return { seen, hooks: { unauthorized: () => void seen.unauthorized++, stale: () => void seen.stale++ } };
}

test("a 401 ends the session, except a wrong password at sign-in", async (t) => {
  const { seen, hooks: session } = hooks();
  configureApi("token", session);
  stubFetch(t, [() => failure(401, "invalid_credentials"), () => failure(401, "unauthorized"), () => failure(401, "unauthorized")]);
  await assert.rejects(request("/sessions", z.looseObject({}), { method: "POST", body: "{}" }), ApiError);
  assert.equal(seen.unauthorized, 0, "signing in with a wrong password is not a session ending");
  await assert.rejects(request("/sessions", z.looseObject({})), ApiError);
  assert.equal(seen.unauthorized, 1, "listing devices with an ended session is");
  await assert.rejects(request("/library", z.looseObject({})), ApiError);
  assert.equal(seen.unauthorized, 2);
});

test("a request from an earlier session cannot sign out the next person", async (t) => {
  const first = hooks();
  const second = hooks();
  configureApi("one", first.hooks);
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const real = globalThis.fetch;
  globalThis.fetch = async () => {
    await held;
    return failure(401, "unauthorized");
  };
  t.after(() => {
    globalThis.fetch = real;
  });
  const pending = request("/library", z.looseObject({})).catch(() => undefined);
  configureApi("two", second.hooks);
  release();
  await pending;
  assert.deepEqual([first.seen.unauthorized, second.seen.unauthorized], [0, 0]);
});

test("permission and CSRF refusals ask the session to refresh itself", async (t) => {
  const { seen, hooks: session } = hooks();
  configureApi("token", session);
  stubFetch(t, [() => failure(403, "forbidden"), () => failure(403, "csrf"), () => failure(403, "fixture_preview")]);
  for (let index = 0; index < 3; index++) await assert.rejects(send("/admin/settings/lidarr", "PUT", {}), ApiError);
  assert.equal(seen.stale, 2);
});

test("a proxy's error page reads as Leerr restarting, and writes carry the CSRF token", async (t) => {
  configureApi("csrf-token", hooks().hooks);
  const calls = stubFetch(t, [
    () => new Response("<html>502 Bad Gateway</html>", { status: 502 }),
    () => json({}),
    () => json({}),
    () => json({ unexpected: true }),
  ]);
  await assert.rejects(request("/library", z.looseObject({})), (error: Error) => error instanceof ApiError && /restarting/.test(error.message));
  await send("/requests", "POST", { a: 1 });
  await request("/library", z.looseObject({}));
  assert.equal(calls[1].headers.get("x-csrf-token"), "csrf-token");
  assert.equal(calls[1].headers.get("content-type"), "application/json");
  assert.equal(calls[2].headers.get("x-csrf-token"), null, "reads do not send it");
  await assert.rejects(request("/library", z.object({ items: z.array(z.string()) })), (error: Error) => error instanceof ApiError && error.code === "unexpected_response");
});
