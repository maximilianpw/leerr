import { opaque } from "../store.ts";
import type { PlexProfile } from "../upstream/index.ts";

export type LinkMode = "own" | "managed";
export type LinkState = "waiting" | "choose_profile" | "linked" | "expired" | "no_access" | "no_profiles" | "in_use";

/**
 * A Plex sign-in in progress. It lives only in memory and only for the Leerr
 * session that started it: the browser holds an opaque id, never the PIN.
 */
export type PendingLink = {
  id: string;
  /** Who started it, in which session: only they can follow and finish it. */
  userID: string;
  sessionID: string;
  /** Whose Plex link it becomes: the starter, or a person an administrator links a Home profile for. */
  targetUserID: string;
  /** The target's client identifier: the sign-in and every later plex.tv call are theirs. */
  clientID: string;
  pinID: number;
  mode: LinkMode;
  expiresAt: number;
  checkedAt: number;
  state: LinkState;
  /** The Plex account that approved the sign-in (shown so a wrong account is noticed); once linked, the linked account or profile. */
  username: string | null;
  profiles: PlexProfile[];
  /**
   * A Home member's account token while they pick a managed profile. Never
   * stored: only the chosen profile's own token is.
   */
  memberToken: string | null;
};

const MAX_PENDING = 200;

export class PlexLinks {
  readonly #links = new Map<string, PendingLink>();

  /** One sign-in at a time per person being linked: a new one replaces any earlier. */
  create(values: Omit<PendingLink, "id" | "checkedAt" | "state" | "username" | "profiles" | "memberToken">, now: number): PendingLink {
    this.prune(now);
    for (const [id, link] of this.#links) if (link.targetUserID === values.targetUserID) this.#links.delete(id);
    if (this.#links.size >= MAX_PENDING) {
      const oldest = [...this.#links.values()].sort((a, b) => a.expiresAt - b.expiresAt)[0];
      if (oldest) this.#links.delete(oldest.id);
    }
    const link: PendingLink = { ...values, id: opaque(), checkedAt: 0, state: "waiting", username: null, profiles: [], memberToken: null };
    this.#links.set(link.id, link);
    return link;
  }

  /** The link, only for the session that started it. */
  get(id: string, userID: string, sessionID: string, now: number): PendingLink | null {
    const link = this.#links.get(id);
    if (!link || link.userID !== userID || link.sessionID !== sessionID) return null;
    if (link.expiresAt <= now && link.state !== "linked") {
      link.state = "expired";
      link.memberToken = null;
    }
    return link;
  }

  /** Ends every sign-in a person started or is the target of (e.g. they disconnected). */
  forget(userID: string) {
    for (const [id, link] of this.#links) if (link.userID === userID || link.targetUserID === userID) this.#links.delete(id);
  }

  prune(now: number) {
    // Kept a little past expiry, so the page can still learn what happened.
    for (const [id, link] of this.#links) if (link.expiresAt + 10 * 60_000 < now) this.#links.delete(id);
  }
}
