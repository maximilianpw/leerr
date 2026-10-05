import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import test from "node:test";
import { audio } from "../testing.ts";
import { harness } from "./harness.ts";

async function ticket(h: Awaited<ReturnType<typeof harness>>) {
  h.configure();
  const admin = await h.user("root", "admin", "admin");
  const issued = (await h.call("POST", "/api/v1/stream-tickets", admin, { trackID: "tone" })).json();
  return { admin, url: String(issued.url) };
}

test("streams return exact full and ranged bytes as sandboxed audio", async (t) => {
  const h = await harness(t);
  const { url } = await ticket(h);
  const full = await h.call("GET", url);
  assert.equal(full.status, 200);
  assert.equal(Number(full.headers["content-length"]), audio.length);
  assert.equal(full.headers["content-type"], "audio/flac");
  assert.equal(full.headers["content-security-policy"], "default-src 'none'; sandbox");
  const part = await h.call("GET", url, null, undefined, { range: "bytes=4-9" });
  assert.equal(part.status, 206);
  assert.equal(part.headers["content-range"], `bytes 4-9/${audio.length}`);
  assert.equal(Buffer.from(part.body, "latin1").length, 6);
  assert.equal((await h.call("GET", url, null, undefined, { range: `bytes=${audio.length}-` })).status, 416);
});

test("tickets need the ticket owner's Jellyfin access and expire only for new requests", async (t) => {
  const h = await harness(t);
  const { url } = await ticket(h);
  const stranger = await h.user("sam");
  assert.equal((await h.call("POST", "/api/v1/stream-tickets", stranger, { trackID: "tone" })).status, 409);
  assert.equal((await h.call("GET", "/api/v1/streams/not-a-ticket")).status, 400);
  h.clock.advance(6 * 3_600_000 - 1);
  assert.equal((await h.call("GET", url)).status, 200);
  h.clock.advance(2);
  assert.equal((await h.call("GET", url)).json().error.code, "ticket_expired");
});

test("revoking the session aborts a live stream and invalidates its ticket", async (t) => {
  const h = await harness(t);
  const { admin, url } = await ticket(h);
  let aborted = false;
  // Hold the upstream body open until the client or server aborts it.
  h.upstream.jellyfinStream = async (_access, _track, _range, _ifRange, signal) =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          signal.addEventListener("abort", () => {
            aborted = true;
            controller.error(new Error("aborted"));
          });
        },
      }),
      { headers: { "content-type": "audio/flac" } },
    );
  const address = await h.app.listen({ port: 0, host: "127.0.0.1" });
  const response = httpRequest(`${address}${url}`, { headers: { host: "leerr.test" } });
  response.end();
  const [incoming] = await once(response, "response");
  const [first] = await once(incoming, "data");
  assert.deepEqual([...first], [1, 2, 3], "bytes are delivered before upstream EOF");
  const closed = new Promise((resolve) => incoming.once("close", resolve));
  incoming.on("error", () => undefined);
  assert.equal((await h.call("DELETE", "/api/v1/sessions/current", admin)).status, 200);
  await closed;
  assert.equal(aborted, true);
  assert.equal((await h.call("GET", url)).status, 401);
});

test("a session may hold at most four concurrent streams", async (t) => {
  const h = await harness(t);
  const { url } = await ticket(h);
  const pending: Array<() => void> = [];
  h.upstream.jellyfinStream = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([0]));
          pending.push(() => controller.close());
        },
      }),
      {
        headers: { "content-type": "audio/flac" },
      },
    );
  const address = await h.app.listen({ port: 0, host: "127.0.0.1" });
  const open = async () => {
    const request = httpRequest(`${address}${url}`, { headers: { host: "leerr.test" } });
    request.end();
    const [incoming] = await once(request, "response");
    return incoming;
  };
  const streams = await Promise.all([open(), open(), open(), open()]);
  assert.ok(streams.every((stream) => stream.statusCode === 200));
  const refused = await open();
  assert.equal(refused.statusCode, 429);
  refused.resume();
  for (const finish of pending) finish();
  for (const stream of streams) stream.resume();
});

test("unexpected upstream content types are served as opaque bytes", async (t) => {
  const h = await harness(t);
  const { url } = await ticket(h);
  h.upstream.jellyfinStream = async () =>
    new Response("<script>alert(1)</script>", { headers: { "content-type": "text/html" } });
  const response = await h.call("GET", url);
  assert.equal(response.headers["content-type"], "application/octet-stream");
  assert.equal(response.headers["content-disposition"], "inline");
});

/** A Jellyfin body that stays open until released or aborted. */
function heldStream(h: Awaited<ReturnType<typeof harness>>) {
  const finishers: Array<() => void> = [];
  const state = { aborted: 0, finishers };
  h.upstream.jellyfinStream = async (_access, _track, _range, _ifRange, signal) =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          state.finishers.push(() => controller.close());
          signal.addEventListener("abort", () => {
            state.aborted++;
            controller.error(new Error("aborted"));
          });
        },
      }),
      { headers: { "content-type": "audio/flac" } },
    );
  return state;
}
async function openStream(address: string, url: string) {
  const request = httpRequest(`${address}${url}`, { headers: { host: "leerr.test" } });
  request.end();
  const [incoming] = await once(request, "response");
  incoming.on("error", () => undefined);
  return incoming;
}

test("finished streams free their slots, and a started stream outlives its ticket", async (t) => {
  const h = await harness(t);
  const { url } = await ticket(h);
  const state = heldStream(h);
  const address = await h.app.listen({ port: 0, host: "127.0.0.1" });
  const streams = await Promise.all([1, 2, 3, 4].map(() => openStream(address, url)));
  assert.equal(h.context.streams.size, 4);
  // Expiry only stops new requests; the four running streams keep going.
  h.clock.advance(6 * 3_600_000 + 1);
  // Each stream must end normally ("end"), not be cut off ("aborted"/"error").
  const ended = streams.map(
    (stream) =>
      new Promise((resolve) => {
        stream.once("end", () => resolve("end"));
        stream.once("aborted", () => resolve("aborted"));
      }),
  );
  for (const stream of streams) stream.resume();
  for (const finish of state.finishers) finish();
  assert.deepEqual(await Promise.all(ended), ["end", "end", "end", "end"]);
  for (let wait = 0; wait < 50 && h.context.streams.size; wait++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(h.context.streams.size, 0, "every slot was released");
  // The freed slots admit a fresh ticket's stream straight away.
  const fresh = (await h.call("POST", "/api/v1/stream-tickets", { ...(await h.login("root")) }, { trackID: "tone" })).json();
  const next = await openStream(address, fresh.url);
  assert.equal(next.statusCode, 200);
  next.resume();
  state.finishers.at(-1)?.();
});

test("shutting down does not wait for open streams, and admits no new ones", async (t) => {
  const h = await harness(t);
  const { url } = await ticket(h);
  const state = heldStream(h);
  const address = await h.app.listen({ port: 0, host: "127.0.0.1" });
  const stream = await openStream(address, url);
  const closed = new Promise((resolve) => stream.once("close", resolve));
  const shutdown = h.app.close();
  const outcome = await Promise.race([shutdown.then(() => "closed"), new Promise((resolve) => setTimeout(() => resolve("hung"), 3_000))]);
  assert.equal(outcome, "closed");
  await closed;
  assert.equal(state.aborted, 1);
  assert.equal(h.context.streams.open("any-session"), null);
});

test("a listener leaving before Jellyfin answers is not logged as a server error", async (t) => {
  const h = await harness(t);
  const { url } = await ticket(h);
  let started = () => {};
  const waiting = new Promise<void>((resolve) => {
    started = resolve;
  });
  h.upstream.jellyfinStream = async (_access, _track, _range, _ifRange, signal) => {
    started();
    await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    throw new Error("unreachable");
  };
  const address = await h.app.listen({ port: 0, host: "127.0.0.1" });
  const request = httpRequest(`${address}${url}`, { headers: { host: "leerr.test" } });
  request.on("error", () => undefined);
  request.end();
  await waiting;
  request.destroy();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(h.events.some((entry) => entry.event === "internal_error"), false);
  assert.equal(h.context.streams.size, 0);
});

test("stream tickets are stored only as digests of the URL's credential", async (t) => {
  const h = await harness(t);
  const { url } = await ticket(h);
  const token = url.split("/").at(-1) ?? "";
  const stored = h.store.db.prepare("SELECT id FROM tickets").pluck().all();
  assert.deepEqual(stored, [createHash("sha256").update(token).digest("hex")]);
});
