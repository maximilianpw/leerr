import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { UpstreamError } from "../../upstream/index.ts";
import { hasJellyfin, jellyfinAccess, lidarrAccess, mbid, type AppContext } from "../context.ts";
import { APIError, notFound } from "../errors.ts";

export function requestRoutes(app: FastifyInstance, context: AppContext) {
  const { store, auth, upstream, log } = context;

  app.post("/api/v1/requests", async (request) => {
    const { user } = auth.require(request);
    const body = z
      .object({ releaseGroupMBID: mbid, releaseMBID: mbid, artistMBID: mbid })
      .parse(request.body);
    lidarrAccess(context);
    const identity = await upstream.identity(body.releaseGroupMBID, body.releaseMBID, body.artistMBID);
    if (hasJellyfin(context, user.id)) {
      const library = await context.library.groups(user.id, jellyfinAccess(context, user.id));
      if (library.has(identity.releaseGroupMBID))
        throw new APIError(409, "already_available", "This album is already in your library.");
    }
    auth.require(request);
    const result = store.request(user.id, identity, context.now());
    if (result.created) log("request_created", { user: user.id, acquisition: result.acquisition.id });
    void context.reconciler.run();
    return {
      id: result.requestID,
      // Someone else may already be acquiring a different edition of this album.
      edition: result.acquisition.releaseMBID,
      sharedEdition: result.acquisition.releaseMBID !== identity.releaseMBID,
    };
  });

  app.get("/api/v1/requests", async (request) => {
    const { user } = auth.require(request);
    const rows = store.requests(user.id);
    let library: Map<string, string> | null = null;
    if (hasJellyfin(context, user.id))
      try {
        library = await context.library.groups(user.id, jellyfinAccess(context, user.id));
      } catch (cause) {
        if (!(cause instanceof UpstreamError)) throw cause;
      }
    return {
      libraryChecked: library !== null,
      items: rows.map((row) => {
        const albumID = library?.get(row.releaseGroupMBID) ?? null;
        return {
          id: row.requestID,
          releaseGroupMBID: row.releaseGroupMBID,
          releaseMBID: row.releaseMBID,
          title: row.title,
          artist: row.artist,
          // "available" is per user: this user's Jellyfin account can see the album.
          status: albumID ? "available" : row.status,
          reason: albumID ? null : row.reason,
          retryable: !albumID && (row.status === "failed" || row.status === "attention"),
          albumID,
          requestedAt: new Date(row.requestedAt).toISOString(),
          updatedAt: new Date(row.updatedAt).toISOString(),
        };
      }),
    };
  });

  app.post("/api/v1/requests/:id/retry", async (request) => {
    const { user } = auth.require(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const acquisitionID = store.requestAcquisitionID(id, user.id);
    if (!acquisitionID) throw notFound("Request");
    if (!context.reconciler.retry(acquisitionID))
      throw new APIError(409, "not_retryable", "This request is still in progress.");
    log("request_retry", { user: user.id, acquisition: acquisitionID });
    void context.reconciler.run();
    return {};
  });
}
