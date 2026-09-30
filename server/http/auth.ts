import type { FastifyReply, FastifyRequest } from "fastify";
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Session, Store, User } from "../store.ts";
import { APIError, unauthorized } from "./errors.ts";

export const SESSION_LIFETIME = 30 * 86_400_000;
const BEARER = /^Bearer ([A-Za-z0-9_-]{43})$/;

export type Principal = { user: User; session: Session };

export function sameSecret(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}

/**
 * Resolves sessions from the web cookie or a native bearer token. Each kind
 * only works through its own channel, and web writes require the session's
 * CSRF token.
 */
export class Auth {
  readonly #store: Store;
  readonly #now: () => number;
  readonly #secure: boolean;
  readonly cookie: string;

  constructor(store: Store, now: () => number, secure: boolean) {
    this.#store = store;
    this.#now = now;
    this.#secure = secure;
    // __Host- cookies must be Secure, so plain-HTTP previews use a bare name.
    this.cookie = secure ? "__Host-leerr" : "leerr";
  }

  require(request: FastifyRequest, admin = false): Principal {
    const bearer = request.headers.authorization?.match(BEARER)?.[1];
    const token = bearer ?? request.cookies[this.cookie];
    const session = token ? this.#store.session(token, this.#now()) : undefined;
    const user = session ? this.#store.user(session.userID) : undefined;
    if (!session || !user || user.disabled || session.device !== (bearer ? "native" : "web")) throw unauthorized();
    if (admin && user.role !== "admin")
      throw new APIError(403, "forbidden", "Administrator permission is required.");
    if (!bearer && request.method !== "GET" && request.method !== "HEAD") {
      const header = z.string().safeParse(request.headers["x-csrf-token"]);
      if (!header.success || !sameSecret(header.data, session.csrf))
        throw new APIError(403, "csrf", "Refresh the page and try again.");
    }
    return { user, session };
  }

  setCookie(reply: FastifyReply, token: string) {
    reply.setCookie(this.cookie, token, {
      path: "/",
      httpOnly: true,
      secure: this.#secure,
      sameSite: "strict",
      maxAge: SESSION_LIFETIME / 1000,
    });
  }
  clearCookie(reply: FastifyReply) {
    reply.clearCookie(this.cookie, { path: "/", httpOnly: true, secure: this.#secure, sameSite: "strict" });
  }
}

/** Per-username login failure throttle, complementing the per-IP rate limit. */
export class LoginThrottle {
  readonly #failures = new Map<string, { count: number; since: number }>();
  readonly #now: () => number;
  readonly #limit: number;
  readonly #window: number;

  constructor(now: () => number, limit = 10, window = 15 * 60_000) {
    this.#now = now;
    this.#limit = limit;
    this.#window = window;
  }

  #entry(username: string) {
    const key = username.toLowerCase();
    const entry = this.#failures.get(key);
    if (entry && this.#now() - entry.since > this.#window) {
      this.#failures.delete(key);
      return undefined;
    }
    return entry;
  }
  blocked(username: string): boolean {
    return (this.#entry(username)?.count ?? 0) >= this.#limit;
  }
  failed(username: string) {
    const entry = this.#entry(username);
    if (entry) entry.count++;
    else this.#failures.set(username.toLowerCase(), { count: 1, since: this.#now() });
    if (this.#failures.size > 10_000)
      for (const [key, value] of this.#failures)
        if (this.#now() - value.since > this.#window) this.#failures.delete(key);
  }
  succeeded(username: string) {
    this.#failures.delete(username.toLowerCase());
  }
}
