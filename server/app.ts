import Fastify, { type FastifyRequest, type FastifyReply } from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import helmet from "@fastify/helmet";
import staticFiles from "@fastify/static";
import { hash, verify, argon2id } from "argon2";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import { readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { z } from "zod";
import {
  Store,
  digest,
  opaque,
  userSchema,
  sessionSchema,
  jellySchema,
  lastSchema,
  acquisitionSchema,
} from "./store.ts";
import {
  Upstreams,
  UpstreamError,
  validateEndpoint,
  type Album,
} from "./upstream.ts";
import { Worker } from "./worker.ts";

const credentials = z.object({
  username: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9_.-]+$/),
  password: z.string().min(10).max(256),
});
const itemID = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9_-]+$/);
const routeID = z.object({ id: itemID });
const identityInput = z.object({
  releaseGroupMBID: z.string().uuid(),
  releaseMBID: z.string().uuid(),
  artistMBID: z.string().uuid(),
  confirmed: z.literal(true),
});
const requestRow = acquisitionSchema.extend({ requestID: z.string() });
const publicUser = (user: z.infer<typeof userSchema>) => ({
  id: user.id,
  username: user.username,
  role: user.role,
});
export class APIError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export const passwordHash = (password: string) =>
  hash(password, {
    type: argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 1,
  });

export async function buildApp(options: {
  store: Store;
  origin: string;
  setupToken: string;
  upstream?: Upstreams;
  now?: () => number;
  webRoot?: string;
  trustProxy?: string[];
  secure?: boolean;
  fixturePreview?: boolean;
}) {
  const { store } = options;
  const upstream = options.upstream ?? new Upstreams();
  const now = options.now ?? Date.now;
  const app = Fastify({
    logger: false,
    bodyLimit: 32_768,
    trustProxy: options.trustProxy ?? false,
  });
  const worker = new Worker(store, upstream, now);
  const streams = new Map<string, Set<AbortController>>();
  const secure = options.secure ?? true;
  const dummyHash = await passwordHash(opaque());
  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: [
          "'self'",
          "data:",
          "https://coverartarchive.org",
          "https://archive.org",
          "https://*.archive.org",
          "https://lastfm-img.freetls.fastly.net",
        ],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
  });
  await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof APIError || error instanceof UpstreamError)
      return reply
        .code(error.status)
        .send({ error: { code: error.code, message: error.message } });
    if (error instanceof z.ZodError)
      return reply.code(400).send({
        error: {
          code: "invalid_request",
          message: "Check the supplied fields and try again.",
        },
      });
    const httpError = z
      .object({ statusCode: z.number().int().min(400).max(499) })
      .safeParse(error);
    if (httpError.success)
      return reply.code(httpError.data.statusCode).send({
        error: {
          code:
            httpError.data.statusCode === 429
              ? "rate_limited"
              : "invalid_request",
          message: "Request rejected. Check the input or try again later.",
        },
      });
    return reply.code(500).send({
      error: {
        code: "internal_error",
        message: "Leerr could not complete this operation.",
      },
    });
  });
  app.addHook("onRequest", async (request, reply) => {
    if (request.url.startsWith("/api/"))
      reply.header("Cache-Control", "no-store");
    // Health is deliberately unauthenticated and contains no configuration/data.
    // Container-local checks need not impersonate a trusted TLS reverse proxy.
    if (request.url === "/health") return;
    // Host and client-origin allowlist. The reverse proxy must preserve Host.
    const expected = new URL(options.origin);
    if (request.headers.host !== expected.host)
      throw new APIError(
        400,
        "invalid_host",
        "Use the configured Leerr address.",
      );
    if (secure && request.protocol !== "https")
      throw new APIError(400, "https_required", "Leerr requires HTTPS.");
    if (
      !["GET", "HEAD", "OPTIONS"].includes(request.method) &&
      request.headers.origin &&
      request.headers.origin !== expected.origin
    )
      throw new APIError(403, "csrf", "The request origin is not allowed.");
  });
  function requiredSetup() {
    return !store.db.prepare("SELECT id FROM users LIMIT 1").get();
  }
  function auth(request: FastifyRequest, admin = false) {
    const bearer = request.headers.authorization?.match(
      /^Bearer ([A-Za-z0-9_-]{43})$/,
    )?.[1];
    const token = bearer ?? request.cookies.leerr;
    const session = token
      ? sessionSchema
          .optional()
          .parse(
            store.db
              .prepare("SELECT * FROM sessions WHERE id=? AND expiresAt>?")
              .get(digest(token), now()),
          )
      : undefined;
    const user = session ? store.user(session.userID) : undefined;
    if (
      !session ||
      !user ||
      user.disabled ||
      (bearer && session.device !== "native") ||
      (!bearer && session.device !== "web")
    )
      throw new APIError(401, "unauthorized", "Sign in to Leerr again.");
    if (admin && user.role !== "admin")
      throw new APIError(
        403,
        "forbidden",
        "Administrator permission is required.",
      );
    if (
      !bearer &&
      !["GET", "HEAD"].includes(request.method) &&
      request.headers["x-csrf-token"] !== session.csrf
    )
      throw new APIError(403, "csrf", "Refresh the page and try again.");
    return { session, user };
  }
  app.addHook("preSerialization", async (request, reply, payload) => {
    // A logout/disable during upstream I/O must not publish old account data.
    const route = request.routeOptions.url ?? "";
    if (
      reply.statusCode < 400 &&
      route.startsWith("/api/v1/") &&
      ![
        "/api/v1/setup",
        "/api/v1/sessions",
        "/api/v1/sessions/:id",
        "/api/v1/streams/:id",
      ].includes(route)
    )
      auth(request, route.startsWith("/api/v1/admin/"));
    return payload;
  });
  function abortSession(id: string) {
    for (const controller of streams.get(id) ?? []) controller.abort();
    streams.delete(id);
  }
  function revokeUser(id: string) {
    for (const session of z
      .array(z.object({ id: z.string() }))
      .parse(
        store.db.prepare("SELECT id FROM sessions WHERE userID=?").all(id),
      ))
      abortSession(session.id);
    store.db.prepare("DELETE FROM sessions WHERE userID=?").run(id);
  }
  function jelly(userID: string) {
    const endpoint = store.settings().jellyfinURL;
    const connection = store.secret(userID, "jellyfin", jellySchema);
    if (!endpoint || !connection)
      throw new APIError(
        409,
        "connection_required",
        "Connect your Jellyfin account in Settings.",
      );
    return { endpoint, ...connection };
  }
  async function inventory(userID: string) {
    const connection = jelly(userID);
    const items: Album[] = [];
    for (let offset = 0; offset < 50_000; offset += 500) {
      const page = await upstream.jellyfinLibrary(
        connection.endpoint,
        connection.token,
        connection.userID,
        offset,
        500,
      );
      items.push(...page.items);
      if (!page.items.length || offset + page.items.length >= page.total)
        return items;
    }
    throw new APIError(
      503,
      "library_too_large",
      "Library enumeration exceeded its safe limit.",
    );
  }
  app.get("/health", async () => ({ status: "ok" }));
  app.get("/api/v1/setup", async () => ({
    required: requiredSetup(),
    fixturePreview: options.fixturePreview === true,
  }));
  app.addHook("onRequest", async (request) => {
    if (
      options.fixturePreview &&
      request.method === "PUT" &&
      [
        "/api/v1/admin/settings",
        "/api/v1/connections/jellyfin",
        "/api/v1/connections/lastfm",
      ].includes(request.url.split("?", 1)[0])
    )
      throw new APIError(
        403,
        "fixture_preview",
        "Fixture preview cannot save service credentials. Use a live Leerr deployment.",
      );
  });
  app.post(
    "/api/v1/setup",
    { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } },
    async (request) => {
      const body = credentials
        .extend({ token: z.string().min(1).max(256) })
        .parse(request.body);
      if (!requiredSetup())
        throw new APIError(409, "setup_complete", "Setup is already complete.");
      if (
        !timingSafeEqual(
          Buffer.from(digest(body.token)),
          Buffer.from(digest(options.setupToken)),
        )
      )
        throw new APIError(403, "setup_token", "The setup token is invalid.");
      const password = await passwordHash(body.password);
      store.db.transaction(() => {
        if (!requiredSetup())
          throw new APIError(
            409,
            "setup_complete",
            "Setup is already complete.",
          );
        store.db
          .prepare(
            "INSERT INTO users(id,username,password,role) VALUES(?,?,?,?)",
          )
          .run(randomUUID(), body.username, password, "admin");
      })();
      return {};
    },
  );
  app.post(
    "/api/v1/sessions",
    { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } },
    async (request, reply) => {
      const body = credentials
        .extend({
          device: z.enum(["native", "web"]),
          name: z.string().min(1).max(80),
        })
        .parse(request.body);
      const found = userSchema
        .optional()
        .parse(
          store.db
            .prepare("SELECT * FROM users WHERE username=?")
            .get(body.username),
        );
      const valid = await verify(found?.password ?? dummyHash, body.password);
      const user = found ? store.user(found.id) : undefined;
      if (!valid || !user || user.disabled || user.password !== found?.password)
        throw new APIError(
          401,
          "unauthorized",
          "The username or password is incorrect.",
        );
      store.prune(now());
      const token = opaque(),
        csrf = opaque(),
        expiresAt = now() + 30 * 86400_000;
      store.db
        .prepare("INSERT INTO sessions VALUES(?,?,?,?,?,?)")
        .run(digest(token), user.id, csrf, expiresAt, body.name, body.device);
      if (body.device === "web")
        reply.setCookie("leerr", token, {
          path: "/",
          httpOnly: true,
          secure,
          sameSite: "strict",
          maxAge: 30 * 86400,
        });
      return {
        user: publicUser(user),
        token: body.device === "native" ? token : undefined,
        csrf: body.device === "web" ? csrf : null,
      };
    },
  );
  app.get("/api/v1/me", async (request) => {
    const { user, session } = auth(request);
    return {
      user: publicUser(user),
      csrf: session.device === "web" ? session.csrf : null,
    };
  });
  app.get("/api/v1/sessions", async (request) => {
    const { user, session } = auth(request);
    const rows = z
      .array(sessionSchema)
      .parse(
        store.db
          .prepare("SELECT * FROM sessions WHERE userID=? AND expiresAt>?")
          .all(user.id, now()),
      );
    return {
      items: rows.map((row) => ({
        id: row.id,
        name: row.name,
        expiresAt: new Date(row.expiresAt).toISOString(),
        current: row.id === session.id,
      })),
    };
  });
  app.delete("/api/v1/sessions/:id", async (request, reply) => {
    const { session, user } = auth(request);
    const { id } = routeID.parse(request.params);
    const target = id === "current" ? session.id : id;
    const removed = store.db
      .prepare("DELETE FROM sessions WHERE id=? AND userID=?")
      .run(target, user.id);
    if (!removed.changes)
      throw new APIError(404, "not_found", "Session not found.");
    abortSession(target);
    if (target === session.id) reply.clearCookie("leerr", { path: "/" });
    return {};
  });
  app.get("/api/v1/admin/users", async (request) => {
    auth(request, true);
    return {
      items: z
        .array(userSchema)
        .parse(store.db.prepare("SELECT * FROM users").all())
        .map((user) => ({
          ...publicUser(user),
          disabled: !!user.disabled,
        })),
    };
  });
  app.post("/api/v1/admin/users", async (request) => {
    auth(request, true);
    const body = credentials
      .extend({ role: z.enum(["admin", "member"]) })
      .parse(request.body);
    const password = await passwordHash(body.password);
    auth(request, true);
    if (
      store.db
        .prepare("SELECT id FROM users WHERE username=?")
        .get(body.username)
    )
      throw new APIError(409, "duplicate_user", "Username is already in use.");
    store.db
      .prepare("INSERT INTO users(id,username,password,role) VALUES(?,?,?,?)")
      .run(randomUUID(), body.username, password, body.role);
    return {};
  });
  app.patch("/api/v1/admin/users/:id", async (request) => {
    const { user } = auth(request, true),
      { id } = routeID.parse(request.params);
    const body = z
      .object({
        disabled: z.boolean().optional(),
        password: credentials.shape.password.optional(),
      })
      .refine(
        (value) => value.disabled !== undefined || value.password !== undefined,
      )
      .parse(request.body);
    if (!store.user(id))
      throw new APIError(404, "not_found", "User not found.");
    if (id === user.id && body.disabled)
      throw new APIError(
        409,
        "self_disable",
        "You cannot disable the current administrator.",
      );
    const password = body.password
      ? await passwordHash(body.password)
      : undefined;
    auth(request, true);
    store.db.transaction(() => {
      if (password)
        store.db
          .prepare("UPDATE users SET password=? WHERE id=?")
          .run(password, id);
      if (body.disabled !== undefined)
        store.db
          .prepare("UPDATE users SET disabled=? WHERE id=?")
          .run(Number(body.disabled), id);
      revokeUser(id);
    })();
    return {};
  });
  app.get("/api/v1/admin/settings", async (request) => {
    auth(request, true);
    const settings = store.settings();
    return {
      jellyfinURL: settings.jellyfinURL,
      lidarrURL: settings.lidarrURL,
      lidarrConfigured: !!settings.lidarrKey,
      rootFolderPath: settings.rootFolderPath,
      qualityProfileID: settings.qualityProfileID,
      metadataProfileID: settings.metadataProfileID,
    };
  });
  app.put("/api/v1/admin/settings", async (request) => {
    auth(request, true);
    const body = z
      .object({
        jellyfinURL: z.string(),
        lidarrURL: z.string(),
        lidarrKey: z.string().max(512),
        rootFolderPath: z.string().max(1000),
        qualityProfileID: z.number().int().nonnegative(),
        metadataProfileID: z.number().int().nonnegative(),
      })
      .partial()
      .refine((value) => Object.keys(value).length > 0)
      .parse(request.body);
    const previous = store.settings();
    const settings = {
      ...previous,
      ...body,
      jellyfinURL:
        body.jellyfinURL === undefined
          ? previous.jellyfinURL
          : body.jellyfinURL
            ? validateEndpoint(body.jellyfinURL)
            : null,
      lidarrURL:
        body.lidarrURL === undefined
          ? previous.lidarrURL
          : body.lidarrURL
            ? validateEndpoint(body.lidarrURL)
            : null,
    };
    if (
      previous.lidarrURL &&
      settings.lidarrURL !== previous.lidarrURL &&
      store.db.prepare("SELECT id FROM acquisitions LIMIT 1").get()
    )
      throw new APIError(
        409,
        "active_installation",
        "Lidarr has durable request history. An operator must reconcile it before changing installations.",
      );
    if (settings.lidarrURL !== previous.lidarrURL)
      settings.lidarrKey = body.lidarrKey ?? "";
    else if (!settings.lidarrKey) settings.lidarrKey = previous.lidarrKey;
    const updatingLidarr = Object.keys(body).some(
      (key) => key !== "jellyfinURL",
    );
    if (updatingLidarr && settings.lidarrURL && !settings.lidarrKey.trim())
      throw new APIError(
        400,
        "lidarr_key_required",
        "Enter a Lidarr API key from Lidarr Settings → General → Security before saving this connection.",
      );
    if (updatingLidarr && settings.lidarrURL && settings.lidarrKey)
      await upstream.lidarrOptions(settings.lidarrURL, settings.lidarrKey);
    auth(request, true);
    if (JSON.stringify(store.settings()) !== JSON.stringify(previous))
      throw new APIError(
        409,
        "settings_changed",
        "Server settings changed. Refresh and try again.",
      );
    // Changing an endpoint invalidates tokens tied to the old installation.
    store.db.transaction(() => {
      if (previous.jellyfinURL !== settings.jellyfinURL) {
        store.db.prepare("DELETE FROM secrets WHERE service='jellyfin'").run();
        store.db.prepare("DELETE FROM tickets").run();
        for (const id of streams.keys()) abortSession(id);
      }
      store.putSecret("installation", "settings", JSON.stringify(settings));
    })();
    return {};
  });
  app.get("/api/v1/admin/lidarr/options", async (request) => {
    auth(request, true);
    const settings = store.settings();
    if (!settings.lidarrURL || !settings.lidarrKey)
      throw new APIError(
        409,
        "connection_required",
        "Save a Lidarr connection first.",
      );
    const options = await upstream.lidarrOptions(
      settings.lidarrURL,
      settings.lidarrKey,
    );
    return {
      ...options,
      roots: options.roots.map((root) => ({
        id: root.id,
        path: root.name,
      })),
    };
  });
  app.get("/api/v1/connections", async (request) => {
    const { user } = auth(request);
    return {
      jellyfinConfigured: !!store.settings().jellyfinURL,
      jellyfin: !!store.secret(user.id, "jellyfin", jellySchema),
      lastfm: !!store.secret(user.id, "lastfm", lastSchema),
    };
  });
  app.put("/api/v1/connections/jellyfin", async (request) => {
    const { user } = auth(request);
    const body = z
      .object({
        username: z.string().min(1).max(200),
        password: z.string().min(1).max(512),
      })
      .parse(request.body);
    const endpoint = store.settings().jellyfinURL;
    if (!endpoint)
      throw new APIError(
        409,
        "connection_required",
        "Ask an administrator to configure Jellyfin.",
      );
    const connection = await upstream.jellyfinLogin(
      endpoint,
      body.username,
      body.password,
    );
    auth(request);
    if (endpoint !== store.settings().jellyfinURL)
      throw new APIError(
        409,
        "connection_changed",
        "Jellyfin settings changed. Try again.",
      );
    store.putSecret(user.id, "jellyfin", JSON.stringify(connection));
    return {};
  });
  app.put("/api/v1/connections/lastfm", async (request) => {
    const { user } = auth(request);
    const body = lastSchema.parse(request.body);
    await upstream.checkLastfm(body.username, body.apiKey);
    auth(request);
    store.putSecret(user.id, "lastfm", JSON.stringify(body));
    return {};
  });
  app.delete("/api/v1/connections/:id", async (request) => {
    const { user } = auth(request),
      { id } = z
        .object({ id: z.enum(["jellyfin", "lastfm"]) })
        .parse(request.params);
    store.db
      .prepare("DELETE FROM secrets WHERE owner=? AND service=?")
      .run(user.id, id);
    if (id === "jellyfin") {
      store.db
        .prepare(
          "DELETE FROM tickets WHERE sessionID IN (SELECT id FROM sessions WHERE userID=?)",
        )
        .run(user.id);
      for (const session of z
        .array(sessionSchema)
        .parse(
          store.db
            .prepare("SELECT * FROM sessions WHERE userID=?")
            .all(user.id),
        ))
        abortSession(session.id);
    }
    return {};
  });
  app.get("/api/v1/library", async (request) => {
    const { user } = auth(request),
      connection = jelly(user.id);
    const page = z
      .object({
        offset: z.coerce.number().int().min(0).default(0),
        limit: z.coerce.number().int().min(1).max(500).default(24),
        q: z.string().max(200).default(""),
      })
      .parse(request.query);
    return upstream.jellyfinLibrary(
      connection.endpoint,
      connection.token,
      connection.userID,
      page.offset,
      page.limit,
      page.q,
    );
  });
  app.get("/api/v1/albums/:id", async (request) => {
    const { user } = auth(request),
      { id } = routeID.parse(request.params),
      c = jelly(user.id);
    return upstream.jellyfinAlbum(c.endpoint, c.token, c.userID, id);
  });
  app.get("/api/v1/artwork/:id", async (request, reply) => {
    const { user } = auth(request),
      { id } = routeID.parse(request.params),
      c = jelly(user.id);
    const response = await upstream.jellyfinArtwork(
      c.endpoint,
      c.token,
      c.userID,
      id,
    );
    auth(request);
    reply.type(response.headers.get("content-type") ?? "image/jpeg");
    return reply.send(Buffer.from(await response.arrayBuffer()));
  });
  app.post("/api/v1/stream-tickets", async (request) => {
    const { user, session } = auth(request);
    const { trackID } = z.object({ trackID: itemID }).parse(request.body),
      c = jelly(user.id);
    await upstream.jellyfinTrack(c.endpoint, c.token, c.userID, trackID);
    auth(request);
    const ticket = opaque(),
      expiresAt = now() + 15 * 60_000;
    store.db
      .prepare("INSERT INTO tickets VALUES(?,?,?,?)")
      .run(digest(ticket), session.id, trackID, expiresAt);
    return { path: `/api/v1/streams/${ticket}`, expiresAt };
  });
  app.get(
    "/api/v1/streams/:id",
    { config: { rateLimit: { max: 6000, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const { id } = routeID.parse(request.params);
      const ticket = z
        .object({
          sessionID: z.string(),
          trackID: z.string(),
          expiresAt: z.number(),
          userID: z.string(),
        })
        .optional()
        .parse(
          store.db
            .prepare(
              "SELECT t.*,s.userID FROM tickets t JOIN sessions s ON s.id=t.sessionID JOIN users u ON u.id=s.userID WHERE t.id=? AND t.expiresAt>? AND s.expiresAt>? AND u.disabled=0",
            )
            .get(digest(id), now(), now()),
        );
      if (!ticket)
        throw new APIError(
          401,
          "unauthorized",
          "Playback authorization expired. Retry playback.",
        );
      const c = jelly(ticket.userID),
        controller = new AbortController();
      const active =
        streams.get(ticket.sessionID) ?? new Set<AbortController>();
      if (active.size >= 4)
        throw new APIError(
          429,
          "stream_limit",
          "Too many active streams on this device.",
        );
      active.add(controller);
      streams.set(ticket.sessionID, active);
      const timeout = setTimeout(
        () => controller.abort(),
        Math.max(1, ticket.expiresAt - now()),
      );
      const close = () => {
        clearTimeout(timeout);
        controller.abort();
        active.delete(controller);
        if (!active.size) streams.delete(ticket.sessionID);
      };
      reply.raw.once("close", close);
      try {
        const response = await upstream.jellyfinOriginal(
          c.endpoint,
          c.token,
          c.userID,
          ticket.trackID,
          request.headers.range,
          controller.signal,
        );
        for (const name of [
          "content-type",
          "content-length",
          "content-range",
          "accept-ranges",
          "etag",
          "last-modified",
        ]) {
          const value = response.headers.get(name);
          if (value) reply.header(name, value);
        }
        reply.code(response.status);
        if (!response.body) {
          close();
          return reply.send();
        }
        // Node's fetch body implements the async iterator accepted by Readable.from.
        return reply.send(Readable.from(response.body));
      } catch (error) {
        close();
        throw error;
      }
    },
  );
  app.get("/api/v1/resolve", async (request) => {
    const { user } = auth(request);
    const { q } = z
      .object({ q: z.string().trim().min(1).max(200) })
      .parse(request.query);
    return upstream.search(
      q,
      store.secret(user.id, "lastfm", lastSchema)?.apiKey,
    );
  });
  app.get("/api/v1/artists/:id/albums", async (request) => {
    const { user } = auth(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { offset } = z
      .object({
        offset: z.coerce.number().int().min(0).max(10000).default(0),
      })
      .parse(request.query);
    return upstream.artistAlbums(
      id,
      offset,
      store.secret(user.id, "lastfm", lastSchema)?.apiKey,
    );
  });
  app.get("/api/v1/resolve/:id/editions", async (request) => {
    auth(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    return upstream.editions(id);
  });
  app.get("/api/v1/recommendations", async (request) => {
    const { user } = auth(request),
      last = store.secret(user.id, "lastfm", lastSchema);
    const source = last ? "lastfm" : "musicbrainz";
    const page = last
      ? await upstream.recommendations(last.username, last.apiKey)
      : await upstream.resolve("primarytype:album AND status:official");
    if (!page.items.length)
      return { items: [], source, emptyReason: "no_candidates" };
    const excluded = new Set(
      z
        .array(z.object({ releaseGroupMBID: z.string() }))
        .parse(
          store.db
            .prepare(
              "SELECT a.releaseGroupMBID FROM acquisitions a JOIN requests r ON r.acquisitionID=a.id WHERE r.userID=?",
            )
            .all(user.id),
        )
        .map((row) => row.releaseGroupMBID),
    );
    if (store.secret(user.id, "jellyfin", jellySchema)) {
      let albums: Album[];
      try {
        albums = await inventory(user.id);
      } catch (error) {
        if (error instanceof UpstreamError || error instanceof APIError)
          throw new APIError(
            error.status,
            "jellyfin_filter_failed",
            `Jellyfin library filtering failed. Recommendations are withheld because library ownership could not be checked. Review your Jellyfin connection in Settings. ${error.message}`,
          );
        throw error;
      }
      for (const album of albums)
        if (album.releaseGroupMBID) excluded.add(album.releaseGroupMBID);
    }
    const items = page.items.filter((item) => !excluded.has(item.id));
    return { items, source, emptyReason: items.length ? null : "all_excluded" };
  });
  app.post("/api/v1/requests", async (request) => {
    const { user } = auth(request),
      body = identityInput.parse(request.body);
    const settings = store.settings();
    if (!settings.lidarrURL || !settings.lidarrKey)
      throw new APIError(
        409,
        "connection_required",
        "An administrator must configure Lidarr first.",
      );
    const identity = await upstream.confirmedIdentity(
      body.releaseGroupMBID,
      body.releaseMBID,
      body.artistMBID,
    );
    if (
      store.secret(user.id, "jellyfin", jellySchema) &&
      (await inventory(user.id)).some(
        (album) => album.releaseGroupMBID === identity.releaseGroupMBID,
      )
    )
      throw new APIError(
        409,
        "already_available",
        "This album is already in your library.",
      );
    auth(request);
    const result = store.db.transaction(() => {
      let acquisition = acquisitionSchema
        .optional()
        .parse(
          store.db
            .prepare("SELECT * FROM acquisitions WHERE releaseGroupMBID=?")
            .get(identity.releaseGroupMBID),
        );
      if (acquisition && acquisition.releaseMBID !== identity.releaseMBID)
        throw new APIError(
          409,
          "edition_conflict",
          "A different edition of this album is already being acquired.",
        );
      if (!acquisition) {
        const id = randomUUID();
        store.db
          .prepare(
            "INSERT INTO acquisitions(id,releaseGroupMBID,releaseMBID,artistMBID,title,artist) VALUES(?,?,?,?,?,?)",
          )
          .run(
            id,
            identity.releaseGroupMBID,
            identity.releaseMBID,
            identity.artistMBID,
            identity.title,
            identity.artist,
          );
        acquisition = acquisitionSchema.parse(
          store.db.prepare("SELECT * FROM acquisitions WHERE id=?").get(id),
        );
      }
      store.db
        .prepare("INSERT OR IGNORE INTO requests VALUES(?,?,?)")
        .run(randomUUID(), user.id, acquisition.id);
      return z
        .object({ id: z.string() })
        .parse(
          store.db
            .prepare(
              "SELECT id FROM requests WHERE userID=? AND acquisitionID=?",
            )
            .get(user.id, acquisition.id),
        );
    })();
    return result;
  });
  app.get("/api/v1/requests", async (request) => {
    const { user } = auth(request);
    const rows = z
      .array(requestRow)
      .parse(
        store.db
          .prepare(
            "SELECT a.*,r.id AS requestID FROM acquisitions a JOIN requests r ON r.acquisitionID=a.id WHERE r.userID=? ORDER BY r.rowid DESC LIMIT 500",
          )
          .all(user.id),
      );
    const library = store.secret(user.id, "jellyfin", jellySchema)
      ? await inventory(user.id)
      : [];
    return {
      items: rows.map((row) => {
        const album = library.find(
          (album) => album.releaseGroupMBID === row.releaseGroupMBID,
        );
        return {
          id: row.requestID,
          releaseGroupMBID: row.releaseGroupMBID,
          releaseMBID: row.releaseMBID,
          title: row.title,
          artist: row.artist,
          status: album ? "available" : row.status,
          albumID: album?.id ?? null,
        };
      }),
    };
  });
  app.post("/api/v1/requests/:id/retry", async (request) => {
    const { user } = auth(request),
      { id } = routeID.parse(request.params);
    const row = z
      .object({ acquisitionID: z.string() })
      .optional()
      .parse(
        store.db
          .prepare("SELECT acquisitionID FROM requests WHERE id=? AND userID=?")
          .get(id, user.id),
      );
    if (!row) throw new APIError(404, "not_found", "Request not found.");
    store.db
      .prepare(
        "UPDATE acquisition_mutations SET phase='retry_requested' WHERE acquisitionID=? AND phase='failed_search'",
      )
      .run(row.acquisitionID);
    store.db
      .prepare("UPDATE acquisitions SET nextAt=0 WHERE id=?")
      .run(row.acquisitionID);
    return {};
  });
  if (options.webRoot) {
    // Serve HTML directly: Nix-normalized mtimes make equal-size builds share
    // static-file validators even when their hashed asset references changed.
    const html = readFileSync(join(options.webRoot, "index.html"), "utf8");
    const sendIndex = (reply: FastifyReply) =>
      reply.type("text/html").header("Cache-Control", "no-store").send(html);
    for (const path of ["/", "/index.html"])
      app.get(path, (_request, reply) => sendIndex(reply));
    await app.register(staticFiles, { root: options.webRoot, index: false });
    app.setNotFoundHandler((request, reply) => {
      const path = request.url.split("?", 1)[0];
      if (
        (request.method === "GET" || request.method === "HEAD") &&
        request.headers.accept?.includes("text/html") &&
        !path.startsWith("/api/") &&
        !path.startsWith("/assets/") &&
        !extname(path)
      )
        return sendIndex(reply);
      return reply.code(404).send({
        error: { code: "not_found", message: "Route not found." },
      });
    });
  }
  app.addHook("onClose", async () => {
    for (const id of streams.keys()) abortSession(id);
    await worker.settle();
  });
  return { app, worker };
}
