import type { FastifyInstance } from "fastify";
import { rmSync } from "node:fs";
import { z } from "zod";
import { hashPassword, verifyPassword } from "../../passwords.ts";
import { digest } from "../../store.ts";
import { sameSecret, SESSION_LIFETIME } from "../auth.ts";
import { password, publicUser, revokeUser, username, type AppContext } from "../context.ts";
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
          /** Native clients send their known-device token here; browsers send a cookie. */
          deviceToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional(),
        })
        .parse(request.body);
      const now = context.now();
      const found = store.userByName(body.username);
      const deviceToken =
        body.deviceToken ?? (found ? z.string().optional().catch(undefined).parse(request.cookies[auth.deviceCookie(found.id)]) : undefined);
      // A browser that signed in to this account before has its own failure budget,
      // so strangers' guesses cannot lock the account's owner out.
      const knownDevice = !!found && !!deviceToken && store.deviceUser(deviceToken, now) === found.id;
      const throttle = knownDevice && deviceToken ? `device:${digest(deviceToken)}` : `account:${body.username}`;
      const attempt = context.logins.begin(throttle);
      if (!attempt) {
        log("login_throttled", { ip: request.ip, knownDevice });
        throw new APIError(429, "login_locked", "Too many failed sign-ins for this account. Try again in 15 minutes.");
      }
      let valid = false;
      try {
        valid = await verifyPassword(found?.password, body.password);
      } catch (cause) {
        attempt.release();
        throw cause;
      }
      // Re-read: the account may have changed while the hash was verified.
      const user = found ? store.user(found.id) : undefined;
      if (!valid || !user || user.disabled || user.password !== found?.password) {
        attempt.failed();
        log("login_failed", { ip: request.ip, knownDevice });
        throw new APIError(401, "invalid_credentials", "The username or password is incorrect.");
      }
      attempt.release();
      context.logins.clear(throttle);
      store.prune(now);
      const session = store.createSession(user.id, body.device, body.name, now, SESSION_LIFETIME);
      if (knownDevice && deviceToken) store.touchDevice(deviceToken, now);
      const issuedDevice = knownDevice ? null : store.createDevice(user.id, now);
      log("login", { user: user.id, device: body.device, knownDevice });
      if (body.device === "web") {
        auth.setCookie(reply, session.token);
        if (issuedDevice) auth.setDeviceCookie(reply, user.id, issuedDevice);
        return { user: publicUser(user), csrf: session.csrf };
      }
      return { user: publicUser(user), csrf: null, token: session.token, deviceToken: issuedDevice ?? body.deviceToken ?? null };
    },
  );

  app.put(
    "/api/v1/me/password",
    { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } },
    async (request, reply) => {
      const { user, session } = auth.require(request);
      const body = z.object({ current: z.string().min(1).max(256), password }).parse(request.body);
      const attempt = context.passwordChecks.begin(user.id);
      if (!attempt) throw new APIError(429, "login_locked", "Too many wrong passwords. Try again in 15 minutes.");
      let valid = false;
      try {
        valid = await verifyPassword(user.password, body.current);
      } catch (cause) {
        attempt.release();
        throw cause;
      }
      if (!valid) {
        attempt.failed();
        log("password_change_failed", { user: user.id });
        throw new APIError(403, "wrong_password", "Your current password is incorrect.");
      }
      attempt.release();
      const hashed = await hashPassword(body.password);
      // Re-check after hashing: the session may have been revoked meanwhile.
      auth.require(request);
      const now = context.now();
      store.transaction(() => {
        // Also forgets the account's known devices (store.updateUser).
        store.updateUser(user.id, { passwordHash: hashed });
        // Other devices sign in again; this one stays signed in, and stays known.
        revokeUser(context, user.id, session.id);
      });
      if (session.device === "web") auth.setDeviceCookie(reply, user.id, store.createDevice(user.id, now));
      context.passwordChecks.clear(user.id);
      context.logins.clear(`account:${user.username}`);
      log("password_changed", { user: user.id });
      return {};
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
