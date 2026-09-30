import { z } from "zod";
import type { Reconciler } from "../acquisitions.ts";
import type { LibraryIndex } from "../library.ts";
import type { Logger } from "../log.ts";
import { jellyfinSecret, lastfmSecret, type Store, type User } from "../store.ts";
import type { JellyfinAccess, LastfmAccount, LidarrAccess, Upstreams } from "../upstream/index.ts";
import type { Auth, LoginThrottle } from "./auth.ts";
import { APIError } from "./errors.ts";
import type { StreamRegistry } from "./streams.ts";

/** Everything route modules share; built once per app in app.ts. */
export type AppContext = {
  store: Store;
  upstream: Upstreams;
  now: () => number;
  log: Logger;
  auth: Auth;
  logins: LoginThrottle;
  streams: StreamRegistry;
  library: LibraryIndex;
  reconciler: Reconciler;
  setupToken: string;
  setupTokenFile: string | null;
  fixturePreview: boolean;
};

export const username = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9_.-]+$/, "Use letters, numbers, dots, dashes or underscores.");
export const password = z.string().min(10).max(256);
export const itemID = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9_-]+$/);
export const mbid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
export const idParam = z.object({ id: itemID });
export const mbidParam = z.object({ id: mbid });

export const publicUser = (user: User) => ({ id: user.id, username: user.username, role: user.role });

export function jellyfinAccess(context: AppContext, userID: string): JellyfinAccess {
  const endpoint = context.store.settings().jellyfinURL;
  if (!endpoint)
    throw new APIError(409, "jellyfin_not_configured", "An administrator must set up the Jellyfin server first.");
  const account = context.store.secret(userID, "jellyfin", jellyfinSecret);
  if (!account) throw new APIError(409, "jellyfin_not_connected", "Connect your Jellyfin account in Settings.");
  return { endpoint, token: account.token, userID: account.userID };
}
export function hasJellyfin(context: AppContext, userID: string): boolean {
  return !!context.store.settings().jellyfinURL && !!context.store.secret(userID, "jellyfin", jellyfinSecret);
}

export function lidarrAccess(context: AppContext): LidarrAccess {
  const settings = context.store.settings();
  if (!settings.lidarrURL || !settings.lidarrKey)
    throw new APIError(409, "lidarr_not_configured", "An administrator must connect Lidarr before albums can be requested.");
  return { endpoint: settings.lidarrURL, key: settings.lidarrKey };
}

export function lastfmAccount(context: AppContext, userID: string): LastfmAccount | null {
  return context.store.secret(userID, "lastfm", lastfmSecret);
}

/** Ends a user's sessions and live streams (password change, disable). */
export function revokeUser(context: AppContext, userID: string) {
  for (const id of context.store.sessionIDs(userID)) context.streams.abortSession(id);
  context.store.deleteUserSessions(userID);
}
