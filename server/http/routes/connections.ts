import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { jellyfinSecret, lastfmSecret } from "../../store.ts";
import type { AppContext } from "../context.ts";
import { APIError } from "../errors.ts";

export function connectionRoutes(app: FastifyInstance, context: AppContext) {
  const { store, auth, log } = context;
  const refuseInPreview = () => {
    if (context.fixturePreview)
      throw new APIError(403, "fixture_preview", "This demo cannot store credentials. Use a real Leerr deployment.");
  };

  app.get("/api/v1/connections", async (request) => {
    const { user } = auth.require(request);
    return {
      jellyfinConfigured: !!store.settings().jellyfinURL,
      jellyfin: store.secret(user.id, "jellyfin", jellyfinSecret)?.username ?? null,
      lastfm: store.secret(user.id, "lastfm", lastfmSecret)?.username ?? null,
      lidarrConfigured: !!store.settings().lidarrKey,
    };
  });

  app.put("/api/v1/connections/jellyfin", async (request) => {
    const { user } = auth.require(request);
    refuseInPreview();
    const body = z
      .object({ username: z.string().trim().min(1).max(200), password: z.string().max(512) })
      .parse(request.body);
    const endpoint = store.settings().jellyfinURL;
    if (!endpoint)
      throw new APIError(409, "jellyfin_not_configured", "An administrator must set up the Jellyfin server first.");
    const account = await context.upstream.jellyfinLogin(endpoint, body.username, body.password);
    auth.require(request);
    if (store.settings().jellyfinURL !== endpoint)
      throw new APIError(409, "settings_changed", "The Jellyfin server changed meanwhile. Try again.");
    store.putSecret(user.id, "jellyfin", JSON.stringify({ ...account, username: body.username }));
    context.library.invalidate(user.id);
    log("connection_saved", { user: user.id, service: "jellyfin" });
    return {};
  });

  app.put("/api/v1/connections/lastfm", async (request) => {
    const { user } = auth.require(request);
    refuseInPreview();
    const body = lastfmSecret
      .extend({ username: z.string().trim().min(1).max(200), apiKey: z.string().trim().min(1).max(200) })
      .parse(request.body);
    await context.upstream.lastfmCheck(body);
    auth.require(request);
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
