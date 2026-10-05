import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit, { normalizeIP } from "@fastify/rate-limit";
import staticFiles from "@fastify/static";
import Fastify, { type FastifyReply } from "fastify";
import { readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { z } from "zod";
import { Reconciler } from "../acquisitions.ts";
import { LibraryIndex } from "../library.ts";
import { silentLogger, type Logger } from "../log.ts";
import { notificationListener } from "../notifications.ts";
import type { Store } from "../store.ts";
import { LiveUpstreams, UpstreamError, type Upstreams } from "../upstream/index.ts";
import { Auth, LoginThrottle } from "./auth.ts";
import type { AppContext, Runtime } from "./context.ts";
import { APIError } from "./errors.ts";
import { adminRoutes } from "./routes/admin.ts";
import { connectionRoutes } from "./routes/connections.ts";
import { discoverRoutes } from "./routes/discover.ts";
import { libraryRoutes } from "./routes/library.ts";
import { requestRoutes } from "./routes/requests.ts";
import { sessionRoutes } from "./routes/sessions.ts";
import { StreamRegistry } from "./streams.ts";

export type AppOptions = {
  store: Store;
  /** Public HTTPS origin; requests must arrive with its Host. */
  origin: string;
  setupToken: string;
  setupTokenFile?: string;
  upstream?: Upstreams;
  now?: () => number;
  log?: Logger;
  webRoot?: string;
  trustProxy?: string[];
  /** Require HTTPS and Secure cookies. Only previews and tests disable this. */
  secure?: boolean;
  fixturePreview?: boolean;
  runtime?: Runtime;
};

// Routes that establish or end sessions, or are authorised by a ticket.
const unauthenticated = new Set([
  "/api/v1/setup",
  "/api/v1/sessions",
  "/api/v1/sessions/:id",
  "/api/v1/streams/:ticket",
]);
const statusCode = z.object({ statusCode: z.number().int().min(400).max(499) });
const rateLimitedCode = z.object({ statusCode: z.literal(429) });
const retryAfter = z.coerce.number().int().positive().catch(60);
/** The limiter's own window, so the message never promises a shorter wait than Retry-After. */
const waitFor = (seconds: number) => (seconds <= 60 ? "a minute" : `${Math.ceil(seconds / 60)} minutes`);

export async function buildApp(options: AppOptions) {
  const now = options.now ?? Date.now;
  const log = options.log ?? silentLogger;
  const secure = options.secure ?? true;
  const upstream = options.upstream ?? new LiveUpstreams();
  const origin = new URL(options.origin);
  const context: AppContext = {
    store: options.store,
    upstream,
    now,
    log,
    auth: new Auth(options.store, now, secure),
    logins: new LoginThrottle(now),
    jellyfinLogins: new LoginThrottle(now, 5),
    passwordChecks: new LoginThrottle(now, 5),
    streams: new StreamRegistry(4),
    library: new LibraryIndex(upstream, now),
    reconciler: new Reconciler(options.store, upstream, now, log, notificationListener(options.store, upstream, log)),
    runtime: options.runtime ?? { startedAt: now(), lastBackup: null },
    setupToken: options.setupToken,
    setupTokenFile: options.setupTokenFile ?? null,
    fixturePreview: options.fixturePreview === true,
  };

  const app = Fastify({ logger: false, bodyLimit: 32_768, trustProxy: options.trustProxy ?? false });
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
        mediaSrc: ["'self'"],
        styleSrc: ["'self'"],
        scriptSrc: ["'self'"],
        frameAncestors: ["'none'"],
        // Only meaningful behind HTTPS; plain-HTTP previews would break every asset.
        upgradeInsecureRequests: secure ? [] : null,
      },
    },
    strictTransportSecurity: secure,
  });
  // Signed-in traffic is limited per person: a household behind one address
  // (or one IPv6 /64) must not share a single bucket.
  await app.register(rateLimit, {
    max: 300,
    timeWindow: "1 minute",
    keyGenerator: (request) => {
      const user = context.auth.userID(request);
      return user ? `user:${user}` : normalizeIP(request.ip);
    },
  });

  // One line per route and failure per minute: an outage must be visible without flooding the log.
  const loggedUpstream = new Map<string, { at: number; suppressed: number }>();
  const logUpstream = (route: string, error: UpstreamError) => {
    if (error.code === "invalid_endpoint" || (error.code === "upstream_rejected" && error.status === 404)) return;
    const key = `${route} ${error.code}`;
    const seen = loggedUpstream.get(key);
    if (seen && now() - seen.at < 60_000) {
      seen.suppressed++;
      return;
    }
    loggedUpstream.set(key, { at: now(), suppressed: 0 });
    log("upstream_error", { route, code: error.code, status: error.status, message: error.message, suppressed: seen?.suppressed ?? 0 });
  };

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof UpstreamError) logUpstream(request.routeOptions.url ?? "", error);
    if (error instanceof APIError || error instanceof UpstreamError)
      return reply.code(error.status).send({ error: { code: error.code, message: error.message } });
    if (error instanceof z.ZodError)
      return reply.code(400).send({
        error: { code: "invalid_request", message: error.issues[0]?.message ?? "Check the supplied fields." },
      });
    if (rateLimitedCode.safeParse(error).success) {
      const wait = waitFor(retryAfter.parse(reply.getHeader("retry-after")));
      // Requests with a session are counted per person; others per client address.
      const message = context.auth.userID(request)
        ? `Too many requests. Try again in ${wait}.`
        : `Too many attempts from your network. Try again in ${wait}.`;
      return reply.code(429).send({ error: { code: "rate_limited", message } });
    }
    const client = statusCode.safeParse(error);
    if (client.success)
      return reply.code(client.data.statusCode).send({ error: { code: "invalid_request", message: "The request was rejected." } });
    log("internal_error", {
      route: request.routeOptions.url ?? null,
      error: error instanceof Error ? `${error.name}: ${error.message}` : "non-error thrown",
    });
    return reply
      .code(500)
      .send({ error: { code: "internal_error", message: "Leerr could not complete this operation." } });
  });

  let warnedForwardedFor = false;
  app.addHook("onRequest", async (request, reply) => {
    // The matched route pattern, never the raw URL: encoded paths must not dodge checks.
    const route = request.routeOptions.url ?? "";
    if (route === "/health") return;
    // Without X-Forwarded-For every client shares the proxy's address, and so its rate limits.
    if (options.trustProxy?.length && request.headers["x-forwarded-for"] === undefined && !warnedForwardedFor) {
      warnedForwardedFor = true;
      log("proxy_missing_forwarded_for", {});
    }
    if (route.startsWith("/api/")) reply.header("Cache-Control", "no-store");
    // The reverse proxy must preserve Host; X-Forwarded-Host is not trusted.
    if (request.headers.host !== origin.host)
      throw new APIError(400, "invalid_host", "Open Leerr at its configured address.");
    if (secure && request.protocol !== "https") throw new APIError(400, "https_required", "Leerr requires HTTPS.");
    if (
      request.method !== "GET" &&
      request.method !== "HEAD" &&
      request.headers.origin !== undefined &&
      request.headers.origin !== origin.origin
    )
      throw new APIError(403, "csrf", "Requests from other sites are not allowed.");
  });

  // A logout or disable during slow upstream I/O must not still publish account data.
  app.addHook("preSerialization", async (request, reply, payload) => {
    const route = request.routeOptions.url ?? "";
    if (reply.statusCode < 400 && route.startsWith("/api/v1/") && !unauthenticated.has(route))
      // Admin data is only ever returned by reads; a write that demoted its own caller still completes.
      context.auth.require(request, route.startsWith("/api/v1/admin/") && request.method === "GET");
    return payload;
  });

  app.get("/health", async (_request, reply) => {
    try {
      if (context.store.healthy()) return { status: "ok" };
    } catch {
      // Reported below; the health check never returns details.
    }
    return reply.code(503).send({ status: "unavailable" });
  });
  sessionRoutes(app, context);
  adminRoutes(app, context);
  connectionRoutes(app, context);
  libraryRoutes(app, context);
  discoverRoutes(app, context);
  requestRoutes(app, context);

  const webRoot = options.webRoot;
  if (webRoot) {
    // index.html is served directly with no validators so a new build is never
    // hidden behind a stale 304; hashed assets are immutable.
    const html = readFileSync(join(webRoot, "index.html"), "utf8");
    const sendIndex = (reply: FastifyReply) =>
      reply.type("text/html; charset=utf-8").header("Cache-Control", "no-store").send(html);
    app.get("/", (_request, reply) => sendIndex(reply));
    app.get("/index.html", (_request, reply) => sendIndex(reply));
    await app.register(staticFiles, {
      root: webRoot,
      index: false,
      setHeaders: (response, path) => {
        if (path.startsWith(join(webRoot, "assets")))
          response.header("Cache-Control", "public, max-age=31536000, immutable");
      },
    });
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
      return reply.code(404).send({ error: { code: "not_found", message: "Not found." } });
    });
  } else {
    app.setNotFoundHandler((_request, reply) =>
      reply.code(404).send({ error: { code: "not_found", message: "Not found." } }),
    );
  }

  // preClose runs before the server waits for open connections; a playing
  // stream would otherwise hold shutdown open until the process is killed.
  app.addHook("preClose", async () => {
    context.streams.close();
    void context.reconciler.stop();
  });
  app.addHook("onClose", async () => {
    await context.reconciler.stop();
  });
  return { app, reconciler: context.reconciler, context };
}
