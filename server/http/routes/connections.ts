import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { lastfmSecret, lidarrReady, plexSecret, type User } from "../../store.ts";
import { UpstreamError } from "../../upstream/index.ts";
import { reconnectError } from "../../upstream/plex.ts";
import { hasPlex, plexNotConfigured, withPlex, type AppContext } from "../context.ts";
import { APIError, notFound } from "../errors.ts";
import type { LinkMode, PendingLink } from "../plexlinks.ts";

/** plex.tv is asked about a sign-in at most this often, however often the page polls. */
const CHECK_SPACING = 2_000;
const linkParam = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });

export function connectionRoutes(app: FastifyInstance, context: AppContext) {
  const { store, auth, log, upstream } = context;
  const refuseInPreview = () => {
    if (context.fixturePreview)
      throw new APIError(403, "fixture_preview", "This demo cannot store credentials. Use a real Leerr deployment.");
  };

  /**
   * Whether the saved Plex sign-in still works on the server, after the same
   * renewal every other call gets: null when Plex could not be asked.
   */
  async function plexValid(userID: string): Promise<boolean | null> {
    if (!hasPlex(context, userID)) return null;
    try {
      await withPlex(context, userID, async (access) => {
        if (!(await upstream.plexTokenValid(access))) throw reconnectError();
      });
      return true;
    } catch (cause) {
      if (cause instanceof UpstreamError && cause.code === "plex_reconnect") {
        log("plex_token_rejected", { user: userID });
        return false;
      }
      if (cause instanceof UpstreamError || (cause instanceof APIError && cause.code === "plex_wrong_server")) return null;
      throw cause;
    }
  }

  /** The Leerr users other than `except` whose saved link is this Plex account or profile. */
  function linkedElsewhere(uuid: string, except: string): boolean {
    return store.secretOwners("plex").some((owner) => owner !== except && store.secret(owner, "plex", plexSecret)?.uuid === uuid);
  }

  app.get("/api/v1/connections", async (request) => {
    const { user } = auth.require(request);
    const settings = store.settings();
    const link = hasPlex(context, user.id) ? store.secret(user.id, "plex", plexSecret) : null;
    return {
      plexConfigured: !!settings.plexURL && !!settings.plexMachineID,
      plex: link ? { username: link.username, managed: link.managed } : null,
      plexValid: await plexValid(user.id),
      lastfm: store.secret(user.id, "lastfm", lastfmSecret)?.username ?? null,
      /** Members may connect Last.fm with just a username. */
      lastfmKeyProvided: !!settings.lastfmKey,
      lidarrConfigured: !!settings.lidarrURL && !!settings.lidarrKey,
      lidarrReady: lidarrReady(settings),
    };
  });

  const linkView = (link: PendingLink) => ({
    state: link.state,
    mode: link.mode,
    username: link.username,
    profiles: link.state === "choose_profile" ? link.profiles : [],
    expiresAt: new Date(link.expiresAt).toISOString(),
  });

  /** Ends a sign-in that cannot be finished; the member's token is no longer needed. */
  function fail(link: PendingLink, reason: "in_use" | "no_access") {
    link.state = reason;
    link.memberToken = null;
    log("connection_failed", { user: link.targetUserID, service: "plex", reason });
  }

  /** Recheck both authority and ownership after upstream I/O; forgotten links must never come back. */
  function requireCurrentLink(request: FastifyRequest, link: PendingLink) {
    const { user, session } = auth.require(request, link.mode === "managed");
    if (context.plexLinks.get(link.id, user.id, session.id, context.now()) !== link)
      throw new APIError(404, "not_found", "This Plex sign-in is not in progress. Start again.");
  }

  /**
   * Saves the link once the account is known to reach this server, and ends
   * the pending sign-in. A throw leaves it as it was, so it can be retried.
   */
  async function finish(request: FastifyRequest, link: PendingLink, accountToken: string, username: string, uuid: string, managed: boolean): Promise<void> {
    // One Plex account per Leerr user: otherwise one person's plays, loves and playlists land in another's account.
    if (linkedElsewhere(uuid, link.targetUserID)) return fail(link, "in_use");
    const settings = store.settings();
    const machineID = settings.plexMachineID;
    if (!settings.plexURL || !machineID) throw plexNotConfigured();
    const serverToken = await upstream.plexServerToken(link.clientID, accountToken, machineID);
    requireCurrentLink(request, link);
    if (link.state !== (link.mode === "own" ? "waiting" : "choose_profile"))
      throw new APIError(409, "plex_link_state", "This Plex sign-in is no longer waiting. Start again.");
    if (!serverToken) return fail(link, "no_access");
    // The server may have been changed, or the person removed, while the sign-in was on plex.tv.
    if (store.settings().plexMachineID !== machineID)
      throw new APIError(409, "settings_changed", "The Plex server changed meanwhile. Start again.");
    if (!store.user(link.targetUserID)) throw notFound("User");
    // No awaits between this check and the write: concurrent completions cannot claim the same account.
    if (linkedElsewhere(uuid, link.targetUserID)) return fail(link, "in_use");
    store.putSecret(link.targetUserID, "plex", JSON.stringify({ accountToken, serverToken, machineID, username, uuid, managed }));
    link.state = "linked";
    link.memberToken = null;
    link.username = username;
    context.plexRenewals.delete(link.targetUserID);
    context.library.invalidate(link.targetUserID);
    log("connection_saved", { user: link.targetUserID, actor: link.userID, service: "plex", managed });
  }

  /** Creates the PIN for `target` and returns Plex's sign-in page, which sends the browser back to `back`. */
  async function startLink(request: FastifyRequest, starter: User, sessionID: string, target: User, mode: LinkMode, back: string) {
    if (!store.settings().plexURL || !store.settings().plexMachineID) throw plexNotConfigured();
    const clientID = store.plexClientID(target.id);
    // Shown on Plex's consent page, so a sign-in someone else started is recognisable.
    const deviceName = `Leerr (${target.username})`;
    const pin = await upstream.plexCreatePin(clientID, deviceName);
    auth.require(request, mode === "managed");
    const link = context.plexLinks.create(
      { userID: starter.id, sessionID, targetUserID: target.id, clientID, pinID: pin.id, mode, expiresAt: pin.expiresAt },
      context.now(),
    );
    const forward = new URL(back, context.origin);
    forward.searchParams.set("plexLink", link.id);
    const parameters = new URLSearchParams({
      clientID,
      code: pin.code,
      "context[device][product]": "Leerr",
      "context[device][deviceName]": deviceName,
      forwardUrl: forward.toString(),
    });
    log("plex_link_started", { user: target.id, actor: starter.id, mode });
    return {
      id: link.id,
      // The fragment keeps the code out of plex.tv's server logs and any proxy.
      authURL: `https://app.plex.tv/auth#?${parameters.toString()}`,
      expiresAt: new Date(link.expiresAt).toISOString(),
    };
  }

  // Starts a person's sign-in with their own Plex account. The browser goes to
  // Plex's page; Leerr's server keeps the PIN and asks plex.tv whether it was approved.
  app.post(
    "/api/v1/connections/plex/links",
    { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } },
    async (request) => {
      const { user, session } = auth.require(request);
      refuseInPreview();
      return startLink(request, user, session.id, user, "own", "/settings/connections");
    },
  );

  // An administrator links one of their Plex Home's managed profiles for someone,
  // from their own device. Only there: whoever sees the profile list chooses from it.
  app.post(
    "/api/v1/admin/users/:id/plex/links",
    { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } },
    async (request) => {
      const { user, session } = auth.require(request, true);
      refuseInPreview();
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const target = store.user(id);
      if (!target) throw notFound("User");
      return startLink(request, user, session.id, target, "managed", "/settings/users");
    },
  );

  app.get("/api/v1/connections/plex/links/:id", async (request) => {
    const { user, session } = auth.require(request);
    const { id } = linkParam.parse(request.params);
    const link = context.plexLinks.get(id, user.id, session.id, context.now());
    if (!link) throw new APIError(404, "not_found", "This Plex sign-in is not in progress. Start again.");
    requireCurrentLink(request, link);
    if (link.state !== "waiting" || context.now() - link.checkedAt < CHECK_SPACING) return linkView(link);
    link.checkedAt = context.now();
    try {
      const token = await upstream.plexCheckPin(link.clientID, link.pinID);
      if (!token) return linkView(link);
      const account = await upstream.plexAccount(link.clientID, token);
      requireCurrentLink(request, link);
      link.username = account.username;
      if (link.mode === "own") await finish(request, link, token, account.username, account.uuid, account.restricted);
      else {
        const profiles = await upstream.plexProfiles(link.clientID, token);
        requireCurrentLink(request, link);
        if (link.state !== "waiting") return linkView(link);
        link.profiles = profiles;
        link.state = profiles.length ? "choose_profile" : "no_profiles";
        link.memberToken = profiles.length ? token : null;
      }
    } catch (cause) {
      if (cause instanceof UpstreamError && cause.status === 410) link.state = "expired";
      // A plex.tv hiccup: the approved PIN still answers, so the next poll simply asks again.
      else if (cause instanceof UpstreamError && cause.code === "upstream_unavailable")
        log("plex_link_retry", { user: link.targetUserID, error: cause.message });
      else throw cause;
    }
    return linkView(link);
  });

  // A full member of the Plex Home picks a managed profile for this Leerr account.
  app.post(
    "/api/v1/connections/plex/links/:id/profile",
    { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } },
    async (request) => {
      const { user, session } = auth.require(request);
      const { id } = linkParam.parse(request.params);
      const body = z.object({ uuid: z.string().min(1).max(100), pin: z.string().regex(/^\d{0,8}$/).default("") }).parse(request.body);
      const link = context.plexLinks.get(id, user.id, session.id, context.now());
      if (!link) throw new APIError(404, "not_found", "This Plex sign-in is not in progress. Start again.");
      requireCurrentLink(request, link);
      const memberToken = link.memberToken;
      if (link.state !== "choose_profile" || !memberToken)
        throw new APIError(409, "plex_link_state", "Choose a profile only after signing in with Plex.");
      // Only managed profiles are offered: switching to a full member or the administrator is never possible here.
      const profile = link.profiles.find((candidate) => candidate.uuid === body.uuid);
      if (!profile) throw new APIError(400, "invalid_request", "Choose one of the listed profiles.");
      const profileToken = await upstream.plexSwitchProfile(link.clientID, memberToken, profile.uuid, body.pin);
      const account = await upstream.plexAccount(link.clientID, profileToken);
      if (!account.restricted) throw new APIError(400, "invalid_request", "Choose one of the listed profiles.");
      requireCurrentLink(request, link);
      await finish(request, link, profileToken, profile.name, account.uuid, true);
      return linkView(link);
    },
  );

  app.put("/api/v1/connections/lastfm", async (request) => {
    const { user } = auth.require(request);
    refuseInPreview();
    const body = z
      .object({ username: z.string().trim().min(1).max(200), apiKey: z.string().trim().max(200).default("") })
      .parse(request.body);
    const installationKey = store.settings().lastfmKey;
    if (!body.apiKey && !installationKey)
      throw new APIError(400, "lastfm_key_required", "Enter a Last.fm API key.");
    await context.upstream.lastfmCheck({ username: body.username, apiKey: body.apiKey || installationKey });
    auth.require(request);
    // An empty key means "use the installation's key", which may change later.
    store.putSecret(user.id, "lastfm", JSON.stringify(body));
    log("connection_saved", { user: user.id, service: "lastfm" });
    return {};
  });

  /** Forgets a person's Plex link: tokens, playback tickets, streams and any sign-in in progress. */
  function unlinkPlex(userID: string) {
    const link = store.secret(userID, "plex", plexSecret);
    store.transaction(() => {
      store.deleteSecret(userID, "plex");
      store.deleteUserTickets(userID);
    });
    for (const id of store.sessionIDs(userID)) context.streams.abortSession(id);
    context.plexLinks.forget(userID);
    context.plexRenewals.delete(userID);
    context.library.invalidate(userID);
    // Best effort, after the local copy is gone: Leerr no longer holds the token either way.
    if (link)
      void upstream.plexSignOut(store.plexClientID(userID), link.accountToken).catch((cause: Error) => {
        if (!(cause instanceof UpstreamError)) log("internal_error", { route: "plex_sign_out", error: cause.message });
      });
  }

  app.delete("/api/v1/connections/:service", async (request) => {
    const { user } = auth.require(request);
    const { service } = z.object({ service: z.enum(["plex", "lastfm"]) }).parse(request.params);
    if (service === "plex") unlinkPlex(user.id);
    else store.deleteSecret(user.id, service);
    log("connection_removed", { user: user.id, service });
    return {};
  });

  // A profile linked to the wrong person, or a person who left the Plex Home.
  app.delete("/api/v1/admin/users/:id/plex", async (request) => {
    const { user: actor } = auth.require(request, true);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    if (!store.user(id)) throw notFound("User");
    unlinkPlex(id);
    log("connection_removed", { user: id, actor: actor.id, service: "plex" });
    return {};
  });
}
