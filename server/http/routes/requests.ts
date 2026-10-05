import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { albumKey, type LibrarySummary } from "../../library.ts";
import { hasPlex, lidarrAccess, mbid, plexUnavailable, withPlex, type AppContext } from "../context.ts";
import { APIError, notFound } from "../errors.ts";

// Outcomes the Requests badge counts until the person's Requests page has shown them.
const noticeable = new Set(["available", "failed", "attention"]);
const requestStatus = z.enum(["requested", "acquiring", "imported", "available", "failed", "attention"]);

export function requestRoutes(app: FastifyInstance, context: AppContext) {
  const { store, auth, upstream, log } = context;

  /** Best effort: requests keep working while Plex is down or the saved sign-in is stale. */
  async function librarySummary(userID: string): Promise<LibrarySummary | null> {
    if (!hasPlex(context, userID)) return null;
    try {
      return await withPlex(context, userID, (access) => context.library.summary(userID, access));
    } catch (cause) {
      if (plexUnavailable(cause)) return null;
      throw cause;
    }
  }

  app.post("/api/v1/requests", async (request) => {
    const { user } = auth.require(request);
    const body = z
      .object({ releaseGroupMBID: mbid, releaseMBID: mbid, artistMBID: mbid })
      .parse(request.body);
    lidarrAccess(context);
    const [identity, library] = await Promise.all([
      upstream.identity(body.releaseGroupMBID, body.releaseMBID, body.artistMBID),
      librarySummary(user.id),
    ]);
    if (library?.groups.has(identity.releaseGroupMBID))
      throw new APIError(409, "already_available", "This album is already in your library.");
    auth.require(request);
    const result = store.request(user.id, identity, context.now());
    if (result.created) log("request_created", { user: user.id, acquisition: result.acquisition.id });
    void context.reconciler.run();
    return {
      id: result.requestID,
      edition: result.acquisition.releaseMBID,
      alreadyRequested: !result.created,
      // Someone else is already acquiring a different edition of this album.
      sharedEdition: result.created && result.acquisition.releaseMBID !== identity.releaseMBID,
    };
  });

  app.get("/api/v1/requests", async (request) => {
    const { user } = auth.require(request);
    const rows = store.requests(user.id);
    const library = await librarySummary(user.id);
    return {
      libraryChecked: library !== null,
      library: library ? { albums: library.albums, unmatched: library.unmatched } : null,
      items: rows.map((row) => {
        const albumID = library?.groups.get(row.releaseGroupMBID) ?? null;
        const status = albumID ? "available" : row.status;
        // Imported, and an album of that name is in Plex: Plex matched it to nothing, or to another album.
        const unmatchedAlbumID = status === "imported" ? (library?.byName.get(albumKey(row.artist, row.title)) ?? null) : null;
        return {
          id: row.requestID,
          releaseGroupMBID: row.releaseGroupMBID,
          releaseMBID: row.releaseMBID,
          title: row.title,
          artist: row.artist,
          // "available" is per user: this person's Plex account can see the album.
          status,
          unseen: noticeable.has(status) && row.seenStatus !== status,
          reason: albumID ? null : row.reason,
          retryable: !albumID && (row.status === "failed" || row.status === "attention"),
          albumID,
          unmatchedAlbumID,
          requestedAt: new Date(row.requestedAt).toISOString(),
          updatedAt: new Date(row.updatedAt).toISOString(),
        };
      }),
    };
  });

  // Kept on the server, so nothing about a person's requests lingers in a shared browser.
  app.post("/api/v1/requests/seen", async (request) => {
    const { user } = auth.require(request);
    const body = z
      .object({ items: z.array(z.object({ id: z.string().uuid(), status: requestStatus })).max(500) })
      .parse(request.body);
    store.markRequestsSeen(user.id, body.items);
    return {};
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

  // Lidarr is never changed: an album it already has or monitors stays there.
  app.delete("/api/v1/requests/:id", async (request) => {
    const { user } = auth.require(request);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const outcome = store.withdrawRequest(id, user.id);
    if (outcome === "not_found") throw notFound("Request");
    if (outcome === "unconfirmed")
      throw new APIError(
        409,
        "change_unconfirmed",
        "Leerr is waiting for Lidarr to confirm a change to this album. Try again in a few minutes.",
      );
    log("request_withdrawn", { user: user.id, request: id });
    return {};
  });
}
