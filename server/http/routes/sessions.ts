import type { FastifyInstance } from "fastify";
import { rmSync } from "node:fs";
import { z } from "zod";
import { hashPassword, verifyPassword } from "../../passwords.ts";
import { sameSecret, SESSION_LIFETIME } from "../auth.ts";
import { password, publicUser, username, type AppContext } from "../context.ts";
import { APIError, notFound } from "../errors.ts";

export function sessionRoutes(app: FastifyInstance, context: AppContext) {
  const { store, auth, log } = context;

  app.get("/api/v1/setup", async () => ({
    required: store.setupRequired(),
    fixturePreview: context.fixturePreview,
  }));

  app.post(
    "/api/v1/setup",
    { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } },
    async (request) => {
      const body = z.object({ token: z.string().min(1).max(256), username, password }).parse(request.body);
      if (!store.setupRequired()) throw new APIError(409, "setup_complete", "Setup is already complete.");
      if (!sameSecret(body.token, context.setupToken)) {
        log("setup_rejected", { ip: request.ip });
        throw new APIError(403, "setup_token", "The setup token is incorrect.");
      }
      const hashed = await hashPassword(body.password);
      const admin = store.transaction(() => {
        if (!store.setupRequired()) throw new APIError(409, "setup_complete", "Setup is already complete.");
        return store.createUser(body.username, hashed, "admin", context.now());
      });
      // The token has done its job; setup can never run again.
      if (context.setupTokenFile) rmSync(context.setupTokenFile, { force: true });
      log("setup_completed", { user: admin.id });
      return {};
    },
  );

  app.post(
    "/api/v1/sessions",
    { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } },
    async (request, reply) => {
      const body = z
        .object({
          username: z.string().trim().min(1).max(64),
          password: z.string().min(1).max(256),
          device: z.enum(["web", "native"]).default("web"),
          name: z.string().trim().min(1).max(80).default("Browser"),
        })
        .parse(request.body);
      if (context.logins.blocked(body.username)) {
        log("login_throttled", { ip: request.ip });
        throw new APIError(429, "rate_limited", "Too many failed sign-ins for this account. Try again later.");
      }
      const found = store.userByName(body.username);
      const valid = await verifyPassword(found?.password, body.password);
      // Re-read: the account may have changed while the hash was verified.
      const user = found ? store.user(found.id) : undefined;
      if (!valid || !user || user.disabled || user.password !== found?.password) {
        context.logins.failed(body.username);
        log("login_failed", { ip: request.ip });
        throw new APIError(401, "invalid_credentials", "The username or password is incorrect.");
      }
      context.logins.succeeded(body.username);
      const now = context.now();
      store.prune(now);
      const session = store.createSession(user.id, body.device, body.name, now, SESSION_LIFETIME);
      log("login", { user: user.id, device: body.device });
      if (body.device === "web") {
        auth.setCookie(reply, session.token);
        return { user: publicUser(user), csrf: session.csrf };
      }
      return { user: publicUser(user), csrf: null, token: session.token };
    },
  );

  app.get("/api/v1/me", async (request) => {
    const { user, session } = auth.require(request);
    return { user: publicUser(user), csrf: session.device === "web" ? session.csrf : null };
  });

  app.get("/api/v1/sessions", async (request) => {
    const { user, session } = auth.require(request);
    return {
      items: store.sessions(user.id, context.now()).map((row) => ({
        id: row.id,
        name: row.name,
        device: row.device,
        createdAt: new Date(row.createdAt).toISOString(),
        expiresAt: new Date(row.expiresAt).toISOString(),
        current: row.id === session.id,
      })),
    };
  });

  app.delete("/api/v1/sessions/:id", async (request, reply) => {
    const { user, session } = auth.require(request);
    const { id } = z.object({ id: z.string().min(1).max(128) }).parse(request.params);
    const target = id === "current" ? session.id : id;
    if (!store.deleteSession(target, user.id)) throw notFound("Session");
    context.streams.abortSession(target);
    if (target === session.id) auth.clearCookie(reply);
    return {};
  });
}
