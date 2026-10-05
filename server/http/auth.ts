import type { FastifyReply, FastifyRequest } from "fastify";
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { DEVICE_LIFETIME, digest, type Session, type Store, type User } from "../store.ts";
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
  readonly #deviceCookie: string;

  constructor(store: Store, now: () => number, secure: boolean) {
    this.#store = store;
    this.#now = now;
    this.#secure = secure;
    // __Host- cookies must be Secure, so plain-HTTP previews use a bare name.
    this.cookie = secure ? "__Host-leerr" : "leerr";
    this.#deviceCookie = secure ? "__Host-leerr-device" : "leerr-device";
  }

  /** The signed-in user for rate limiting, without CSRF or role checks; null if none. */
  userID(request: FastifyRequest): string | null {
    const bearer = request.headers.authorization?.match(BEARER)?.[1];
    const token = bearer ?? request.cookies[this.cookie];
    const session = token ? this.#store.session(token, this.#now()) : undefined;
    return session && session.device === (bearer ? "native" : "web") ? session.userID : null;
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
  /**
   * One known-device cookie per account, so on a shared browser each person
   * who signed in keeps their own budget against strangers' guesses.
   */
  deviceCookie(userID: string): string {
    return `${this.#deviceCookie}-${digest(userID).slice(0, 16)}`;
  }
  /** Outlives sessions: signing out does not make a browser unknown. */
  setDeviceCookie(reply: FastifyReply, userID: string, token: string) {
    reply.setCookie(this.deviceCookie(userID), token, {
      path: "/",
      httpOnly: true,
      secure: this.#secure,
      sameSite: "strict",
      maxAge: DEVICE_LIFETIME / 1000,
    });
  }
}

/** One attempt in progress: it must end as a failure or be released. */
export type Attempt = { failed: () => void; release: () => void };

/**
 * Failed-attempt throttle per key (an account, a known device, a member's
 * Jellyfin sign-ins), complementing the per-IP rate limit. `limit` failures
 * within `window` of the first lock the key for a full `window`. Attempts
 * still being checked count against the limit, so a burst of concurrent
 * guesses cannot slip past it.
 */
export class LoginThrottle {
  readonly #entries = new Map<string, { count: number; pending: number; since: number; lockedUntil: number }>();
  readonly #now: () => number;
  readonly #limit: number;
  readonly #window: number;

  constructor(now: () => number, limit = 10, window = 15 * 60_000) {
    this.#now = now;
    this.#limit = limit;
    this.#window = window;
  }

  #expired(entry: { since: number; lockedUntil: number; pending: number }) {
    const now = this.#now();
    return entry.pending === 0 && now >= entry.lockedUntil && now - entry.since > this.#window;
  }
  #entry(key: string) {
    const name = key.toLowerCase();
    const entry = this.#entries.get(name);
    if (entry && !this.#expired(entry)) return entry;
    const fresh = { count: 0, pending: 0, since: this.#now(), lockedUntil: 0 };
    this.#entries.set(name, fresh);
    if (this.#entries.size > 10_000)
      for (const [other, value] of this.#entries) if (value !== fresh && this.#expired(value)) this.#entries.delete(other);
    return fresh;
  }
  /** Starts an attempt, or returns null when the key is locked or out of attempts. */
  begin(key: string): Attempt | null {
    const entry = this.#entry(key);
    const now = this.#now();
    if (entry.lockedUntil > now || entry.count + entry.pending >= this.#limit) return null;
    entry.pending++;
    let settled = false;
    const settle = () => {
      if (settled) return false;
      settled = true;
      entry.pending--;
      return true;
    };
    return {
      failed: () => {
        if (!settle()) return;
        entry.count++;
        const at = this.#now();
        if (entry.count >= this.#limit && entry.lockedUntil <= at) entry.lockedUntil = at + this.#window;
      },
      release: () => void settle(),
    };
  }
  /** Forgets failures, e.g. after a successful sign-in or an administrator's password reset. */
  clear(key: string) {
    const entry = this.#entries.get(key.toLowerCase());
    if (!entry) return;
    entry.count = 0;
    entry.lockedUntil = 0;
    entry.since = this.#now();
  }
}
