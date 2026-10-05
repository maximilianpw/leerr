import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { buildApp, type AppOptions } from "../http/app.ts";
import { hashPassword } from "../passwords.ts";
import type { LogFields } from "../log.ts";
import type { Role } from "../store.ts";
import { Clock, configuredSettings, FakeUpstreams, makeStore } from "../testing.ts";
import type { JsonValue } from "../upstream/http.ts";

export const ORIGIN = "https://leerr.test";
export const SETUP_TOKEN = "setup-token-for-tests";
export const PASSWORD = "correct horse battery";

export type Client = { cookie: string; csrf: string; userID: string };
type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";

export async function harness(t: TestContext, options: Partial<AppOptions> = {}) {
  const store = options.store ?? makeStore();
  const upstream = new FakeUpstreams();
  const clock = new Clock();
  const events: Array<{ event: string; fields: LogFields }> = [];
  const built = await buildApp({
    store,
    origin: ORIGIN,
    setupToken: SETUP_TOKEN,
    upstream,
    now: clock.now,
    secure: false,
    log: (event, fields = {}) => events.push({ event, fields }),
    ...options,
  });
  t.after(() => built.app.close());

  async function call(
    method: Method,
    url: string,
    client?: Client | null,
    body?: JsonValue,
    headers: Record<string, string> = {},
  ) {
    const sent = new Map([["host", "leerr.test"]]);
    if (client) {
      sent.set("cookie", client.cookie);
      sent.set("x-csrf-token", client.csrf);
    }
    if (body) sent.set("content-type", "application/json");
    for (const [name, value] of Object.entries(headers)) sent.set(name, value);
    const response = await built.app.inject({
      method,
      url,
      headers: Object.fromEntries(sent),
      payload: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.statusCode, headers: response.headers, body: response.body, json: () => response.json() };
  }

  async function user(username: string, role: Role = "member", jellyfin?: "admin" | "member"): Promise<Client> {
    const created = store.createUser(username, await hashPassword(PASSWORD), role, clock.now());
    if (jellyfin)
      store.putSecret(
        created.id,
        "jellyfin",
        JSON.stringify({ ...upstream.logins.get(jellyfin), username: jellyfin }),
      );
    return login(username);
  }

  async function login(username: string, password = PASSWORD): Promise<Client> {
    const response = await call("POST", "/api/v1/sessions", null, { username, password });
    assert.equal(response.status, 200, response.body);
    const cookie = String(response.headers["set-cookie"]).split(";", 1)[0];
    const body = response.json();
    return { cookie, csrf: body.csrf, userID: body.user.id };
  }

  function configure() {
    store.saveSettings(configuredSettings);
  }

  /** Runs worker passes, advancing the clock to each next due row, until nothing is due within `horizon`. */
  async function work(horizon = 10 * 60_000, rounds = 10) {
    await built.reconciler.settle();
    for (let round = 0; round < rounds; round++) {
      const next = Math.min(...store.acquisitions().map((row) => row.nextAt));
      if (!Number.isFinite(next) || next > clock.now() + horizon) return;
      clock.advance(Math.max(0, next - clock.now()));
      await built.reconciler.run();
    }
  }

  return { ...built, store, upstream, clock, events, call, user, login, configure, work };
}
