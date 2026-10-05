import type { Logger } from "./log.ts";
import { plexSecret, type Store } from "./store.ts";
import { UpstreamError, type Upstreams } from "./upstream/index.ts";

const FIRST = 5 * 60_000;
const EVERY = 24 * 3_600_000;

/** Uses each linked Plex sign-in on plex.tv once a day, as Plex's own apps do, so idle ones do not expire. */
export async function keepPlexAlive(store: Store, upstream: Upstreams, log: Logger): Promise<void> {
  for (const userID of store.secretOwners("plex")) {
    const link = store.secret(userID, "plex", plexSecret);
    if (!link) continue;
    try {
      await upstream.plexPing(store.plexClientID(userID), link.accountToken);
    } catch (cause) {
      if (!(cause instanceof UpstreamError)) throw cause;
      // Only plex.tv's 401 means the sign-in is gone; the person then sees "sign in again" when Plex refuses it.
      log(cause.code === "plex_reconnect" ? "plex_token_rejected" : "plex_keepalive_failed", { user: userID, code: cause.code });
    }
  }
}

export function scheduleKeepAlive(store: Store, upstream: Upstreams, log: Logger): () => void {
  const run = () =>
    void keepPlexAlive(store, upstream, log).catch((cause: Error) => log("internal_error", { route: "plex_keepalive", error: cause.message }));
  const first = setTimeout(run, FIRST);
  const timer = setInterval(run, EVERY);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
