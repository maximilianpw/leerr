import { z } from "zod";
import type { Reconciler } from "../acquisitions.ts";
import type { LibraryIndex } from "../library.ts";
import type { Logger } from "../log.ts";
import { digest, lastfmSecret, plexSecret, type Store, type User } from "../store.ts";
import { ratingKey, UpstreamError, type LastfmAccount, type LidarrAccess, type PlexAccess, type Upstreams } from "../upstream/index.ts";
import type { Auth, LoginThrottle } from "./auth.ts";
import { APIError } from "./errors.ts";
import type { PlexLinks } from "./plexlinks.ts";
import type { StreamRegistry } from "./streams.ts";

/** Facts about the running process for the administrator status page. */
export type Runtime = { startedAt: number; lastBackup: { at: number; ok: boolean } | null };

/** Everything route modules share; built once per app in app.ts. */
export type AppContext = {
  store: Store;
  upstream: Upstreams;
  now: () => number;
  log: Logger;
  auth: Auth;
  logins: LoginThrottle;
  /** Wrong current passwords when someone changes their own. */
  passwordChecks: LoginThrottle;
  /** Plex sign-ins waiting for the person to approve them on plex.tv. */
  plexLinks: PlexLinks;
  /** When each person's Plex server token was last re-fetched from plex.tv. */
  plexRenewals: Map<string, number>;
  /** Renewals in progress, shared by everyone who needs the same person's new token. */
  plexRenewing: Map<string, Promise<string | null>>;
  /** When the saved Plex address last answered as the saved server. */
  plexChecks: Map<string, number>;
  /** The public address, where Plex sends people back after signing in. */
  origin: string;
  streams: StreamRegistry;
  library: LibraryIndex;
  reconciler: Reconciler;
  runtime: Runtime;
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
/** Plex item ids (ratingKeys) are decimal. */
export const itemID = ratingKey;
export const mbid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
export const idParam = z.object({ id: itemID });
export const mbidParam = z.object({ id: mbid });

export const publicUser = (user: User) => ({ id: user.id, username: user.username, role: user.role });

export const plexNotConfigured = () =>
  new APIError(409, "plex_not_configured", "An administrator must set up the Plex server first.");

/** How Plex tells this browser apart from the person's other players. */
export const playerSession = (sessionID: string) => `leerr-${digest(sessionID).slice(0, 24)}`;

/**
 * The person's way into the Plex server. A link made for another server (the
 * address now answers as a different machine) is never used.
 */
export function plexAccess(context: AppContext, userID: string, sessionID?: string): PlexAccess {
  const settings = context.store.settings();
  if (!settings.plexURL || !settings.plexMachineID) throw plexNotConfigured();
  const link = context.store.secret(userID, "plex", plexSecret);
  if (!link || link.machineID !== settings.plexMachineID)
    throw new APIError(409, "plex_not_connected", "Sign in to Plex in Settings → Connections.");
  const access: PlexAccess = {
    endpoint: settings.plexURL,
    token: link.serverToken,
    clientID: context.store.plexClientID(userID),
    machineID: settings.plexMachineID,
    section: settings.plexSection,
  };
  if (sessionID) access.session = playerSession(sessionID);
  return access;
}
export function hasPlex(context: AppContext, userID: string): boolean {
  const settings = context.store.settings();
  const link = context.store.secret(userID, "plex", plexSecret);
  return !!settings.plexURL && !!link && link.machineID === settings.plexMachineID;
}

/** Re-fetching a server token asks plex.tv, so a person whose token is really gone does not hammer it. */
const RENEWAL_SPACING = 5 * 60_000;
const SERVER_CHECK = 10 * 60_000;

/**
 * Tokens only go to the server the address answered as when it was saved.
 * Fails closed: an address that cannot prove it is that server (it now leads
 * to another machine, a proxy's error page, or nothing) gets no token at all.
 */
async function confirmServer(context: AppContext, access: PlexAccess): Promise<void> {
  const key = `${access.endpoint}\0${access.machineID}`;
  if (context.now() - (context.plexChecks.get(key) ?? Number.NEGATIVE_INFINITY) < SERVER_CHECK) return;
  const { machineID } = await context.upstream.plexIdentity(access.endpoint);
  if (machineID !== access.machineID)
    throw new APIError(
      409,
      "plex_wrong_server",
      "A different Plex server now answers at the saved address. An administrator must save the Plex address again.",
    );
  context.plexChecks.set(key, context.now());
}

/**
 * Runs `work` with the person's Plex access. When the server rejects the
 * token, plex.tv is asked once for a current one (shares can be re-created
 * with new tokens) before the person is told to sign in again.
 */
export async function withPlex<T>(
  context: AppContext,
  userID: string,
  work: (access: PlexAccess) => Promise<T>,
  sessionID?: string,
): Promise<T> {
  const access = plexAccess(context, userID, sessionID);
  const link = context.store.secret(userID, "plex", plexSecret);
  // A renewal belongs to this account on this server, not whatever link the user has after an await.
  const requireCurrentAccess = () => {
    const settings = context.store.settings();
    const current = context.store.secret(userID, "plex", plexSecret);
    if (
      !link || !current || current.accountToken !== link.accountToken || current.uuid !== link.uuid ||
      current.machineID !== access.machineID || settings.plexMachineID !== access.machineID ||
      settings.plexURL !== access.endpoint || settings.plexSection !== access.section
    )
      throw new APIError(409, "plex_not_connected", "Your Plex connection changed meanwhile. Try again.");
    return current;
  };
  await confirmServer(context, access);
  requireCurrentAccess();
  try {
    return await work(access);
  } catch (cause) {
    if (!(cause instanceof UpstreamError && cause.code === "plex_reconnect")) throw cause;
    requireCurrentAccess();
    const renewed = await renewServerToken(context, userID, access.token);
    const current = requireCurrentAccess();
    if (!renewed || renewed !== current.serverToken) throw cause;
    return work({ ...access, token: renewed });
  }
}

/**
 * A current server token after `failed` was refused: one another request
 * already saved, the result of a renewal in progress, or a fresh one from
 * plex.tv. Null means only signing in again can help; a plex.tv outage throws.
 */
async function renewServerToken(context: AppContext, userID: string, failed: string): Promise<string | null> {
  const stored = context.store.secret(userID, "plex", plexSecret)?.serverToken;
  if (stored && stored !== failed) return stored;
  const running = context.plexRenewing.get(userID);
  if (running) return running;
  if (context.now() - (context.plexRenewals.get(userID) ?? Number.NEGATIVE_INFINITY) < RENEWAL_SPACING) return null;
  context.plexRenewals.set(userID, context.now());
  const renewal = fetchServerToken(context, userID, failed).finally(() => context.plexRenewing.delete(userID));
  context.plexRenewing.set(userID, renewal);
  return renewal;
}

async function fetchServerToken(context: AppContext, userID: string, failed: string): Promise<string | null> {
  const link = context.store.secret(userID, "plex", plexSecret);
  if (!link) return null;
  const settings = context.store.settings();
  let token: string | null;
  try {
    token = await context.upstream.plexServerToken(context.store.plexClientID(userID), link.accountToken, link.machineID);
  } catch (cause) {
    // Only plex.tv refusing the account means signing in again; an outage is reported as one, and tried again soon.
    if (cause instanceof UpstreamError && cause.code === "plex_reconnect") return null;
    context.plexRenewals.delete(userID);
    throw cause;
  }
  // Re-read: the person may have disconnected or signed in again meanwhile.
  const current = context.store.secret(userID, "plex", plexSecret);
  const currentSettings = context.store.settings();
  if (
    !token || token === failed || !current || current.accountToken !== link.accountToken ||
    current.machineID !== link.machineID || current.uuid !== link.uuid ||
    currentSettings.plexMachineID !== settings.plexMachineID || currentSettings.plexURL !== settings.plexURL
  ) return null;
  context.store.putSecret(userID, "plex", JSON.stringify({ ...current, serverToken: token }));
  context.log("plex_token_renewed", { user: userID });
  return token;
}

/**
 * Failures that leave a best-effort library lookup without the library
 * (requests and search keep working without it).
 */
export const plexUnavailable = (cause: unknown) =>
  cause instanceof UpstreamError || (cause instanceof APIError && cause.code === "plex_wrong_server");

export function lidarrAccess(context: AppContext): LidarrAccess {
  const settings = context.store.settings();
  if (!settings.lidarrURL || !settings.lidarrKey)
    throw new APIError(409, "lidarr_not_configured", "An administrator must connect Lidarr before albums can be requested.");
  return { endpoint: settings.lidarrURL, key: settings.lidarrKey };
}

/** The user's Last.fm profile, using the installation's API key when they did not give their own. */
export function lastfmAccount(context: AppContext, userID: string): LastfmAccount | null {
  const account = context.store.secret(userID, "lastfm", lastfmSecret);
  const apiKey = account?.apiKey || context.store.settings().lastfmKey;
  return account && apiKey ? { username: account.username, apiKey } : null;
}
/** Any Last.fm key usable for this user's artwork and suggestions. */
export function lastfmKey(context: AppContext, userID: string): string | null {
  return lastfmAccount(context, userID)?.apiKey ?? (context.store.settings().lastfmKey || null);
}

/** Ends a user's sessions and live streams (password change, disable), optionally keeping one. */
export function revokeUser(context: AppContext, userID: string, except: string | null = null) {
  for (const id of context.store.sessionIDs(userID)) if (id !== except) context.streams.abortSession(id);
  context.store.deleteUserSessions(userID, except);
}
