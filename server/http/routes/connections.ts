import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { jellyfinSecret, lastfmSecret, lidarrReady } from "../../store.ts";
import { UpstreamError } from "../../upstream/index.ts";
import { jellyfinAccess, jellyfinDeviceID, type AppContext } from "../context.ts";
import { APIError } from "../errors.ts";

export function connectionRoutes(app: FastifyInstance, context: AppContext) {
  const { store, auth, log } = context;
  const refuseInPreview = () => {
    if (context.fixturePreview)
      throw new APIError(403, "fixture_preview", "This demo cannot store credentials. Use a real Leerr deployment.");
  };

  /** Whether the saved Jellyfin sign-in still works: null when Jellyfin could not be asked. */
  async function jellyfinValid(userID: string): Promise<boolean | null> {
    if (!store.secret(userID, "jellyfin", jellyfinSecret) || !store.settings().jellyfinURL) return null;
    try {
      const valid = await context.upstream.jellyfinTokenValid(jellyfinAccess(context, userID));
      if (!valid) log("jellyfin_token_rejected", { user: userID });
      return valid;
    } catch (cause) {
      if (cause instanceof UpstreamError) return null;
      throw cause;
    }
  }

  app.get("/api/v1/connections", async (request) => {
    const { user } = auth.require(request);
    const settings = store.settings();
    return {
      jellyfinConfigured: !!settings.jellyfinURL,
      jellyfin: store.secret(user.id, "jellyfin", jellyfinSecret)?.username ?? null,
      jellyfinValid: await jellyfinValid(user.id),
      lastfm: store.secret(user.id, "lastfm", lastfmSecret)?.username ?? null,
      /** Members may connect Last.fm with just a username. */
      lastfmKeyProvided: !!settings.lastfmKey,
      lidarrConfigured: !!settings.lidarrURL && !!settings.lidarrKey,
      lidarrReady: lidarrReady(settings),
    };
  });

  app.put("/api/v1/connections/jellyfin", { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } }, async (request) => {
    const { user } = auth.require(request);
    refuseInPreview();
    const body = z
      .object({ username: z.string().trim().min(1).max(200), password: z.string().max(512) })
      .parse(request.body);
    const endpoint = store.settings().jellyfinURL;
    if (!endpoint)
      throw new APIError(409, "jellyfin_not_configured", "An administrator must set up the Jellyfin server first.");
    // Per Leerr user, across every Jellyfin username: Leerr must not become a password-guessing proxy.
    const attempt = context.jellyfinLogins.begin(user.id);
    if (!attempt) throw new APIError(429, "login_locked", "Too many failed Jellyfin sign-ins. Try again in 15 minutes.");
    const account = await context.upstream
      .jellyfinLogin(endpoint, body.username, body.password, jellyfinDeviceID(user.id))
      .catch((cause: Error) => {
        // Only wrong credentials count; an unreachable Jellyfin is not a guess.
        if (cause instanceof UpstreamError && cause.code === "upstream_auth") {
          attempt.failed();
          log("connection_failed", { user: user.id, service: "jellyfin" });
        } else attempt.release();
        throw cause;
      });
    attempt.release();
    auth.require(request);
    if (store.settings().jellyfinURL !== endpoint)
      throw new APIError(409, "settings_changed", "The Jellyfin server changed meanwhile. Try again.");
    store.putSecret(user.id, "jellyfin", JSON.stringify({ ...account, username: body.username }));
    context.jellyfinLogins.clear(user.id);
    context.library.invalidate(user.id);
    log("connection_saved", { user: user.id, service: "jellyfin" });
    return {};
  });

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

  app.delete("/api/v1/connections/:service", async (request) => {
    const { user } = auth.require(request);
    const { service } = z.object({ service: z.enum(["jellyfin", "lastfm"]) }).parse(request.params);
    store.transaction(() => {
      store.deleteSecret(user.id, service);
      if (service === "jellyfin") store.deleteUserTickets(user.id);
    });
    if (service === "jellyfin") {
      for (const id of store.sessionIDs(user.id)) context.streams.abortSession(id);
      context.library.invalidate(user.id);
    }
    log("connection_removed", { user: user.id, service });
    return {};
  });
}
