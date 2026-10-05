import type { FastifyInstance, FastifyRequest } from "fastify";
import { Readable } from "node:stream";
import { z } from "zod";
import { artworkSizes, librarySorts, UpstreamError } from "../../upstream/index.ts";
import { idParam, itemID, jellyfinAccess, type AppContext } from "../context.ts";
import { APIError } from "../errors.ts";

/** Tickets authorise stream admission only; a started stream is never cut off by expiry. */
const TICKET_LIFETIME = 6 * 3_600_000;
const passthroughHeaders = ["content-length", "content-range", "accept-ranges", "etag", "last-modified"];
const playableType = /^(audio\/[a-z0-9.+-]+|application\/octet-stream)$/;
const flag = z.enum(["0", "1"]).transform((value) => value === "1");

export function libraryRoutes(app: FastifyInstance, context: AppContext) {
  const { store, auth, upstream, log } = context;

  app.get("/api/v1/library", async (request) => {
    const { user } = auth.require(request);
    const query = z
      .object({
        offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
        limit: z.coerce.number().int().min(1).max(500).default(60),
        q: z.string().trim().max(200).default(""),
        sort: z.enum(librarySorts).default("title"),
        artist: itemID.optional(),
        favorites: flag.default(false),
      })
      .parse(request.query);
    return upstream.jellyfinLibrary(jellyfinAccess(context, user.id), {
      offset: query.offset,
      limit: query.limit,
      q: query.q,
      sort: query.sort,
      artistID: query.artist ?? null,
      favorites: query.favorites,
    });
  });

  app.get("/api/v1/library/artists", async (request) => {
    const { user } = auth.require(request);
    const query = z
      .object({
        offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
        limit: z.coerce.number().int().min(1).max(500).default(100),
        q: z.string().trim().max(200).default(""),
      })
      .parse(request.query);
    return upstream.jellyfinArtists(jellyfinAccess(context, user.id), query.offset, query.limit, query.q);
  });

  app.get("/api/v1/albums/:id", async (request) => {
    const { user } = auth.require(request);
    const { id } = idParam.parse(request.params);
    return upstream.jellyfinAlbum(jellyfinAccess(context, user.id), id);
  });

  app.get("/api/v1/playlists", async (request) => {
    const { user } = auth.require(request);
    return { items: await upstream.jellyfinPlaylists(jellyfinAccess(context, user.id)) };
  });

  app.get("/api/v1/playlists/:id", async (request) => {
    const { user } = auth.require(request);
    const { id } = idParam.parse(request.params);
    return upstream.jellyfinPlaylist(jellyfinAccess(context, user.id), id);
  });

  app.post("/api/v1/playlists/:id/tracks", async (request) => {
    const { user } = auth.require(request);
    const { id } = idParam.parse(request.params);
    const { trackIDs } = z.object({ trackIDs: z.array(itemID).min(1).max(500) }).parse(request.body);
    await upstream.jellyfinAddToPlaylist(jellyfinAccess(context, user.id), id, trackIDs);
    return {};
  });

  const favorite = (value: boolean) => async (request: FastifyRequest) => {
    const { user } = auth.require(request);
    const { id } = idParam.parse(request.params);
    await upstream.jellyfinFavorite(jellyfinAccess(context, user.id), id, value);
    return {};
  };
  app.put("/api/v1/favorites/:id", favorite(true));
  app.delete("/api/v1/favorites/:id", favorite(false));

  // Reports what plays to Jellyfin: play counts, "recently played" and scrobbler plugins.
  app.post("/api/v1/playback", async (request) => {
    const { user } = auth.require(request);
    const body = z
      .object({
        trackID: itemID,
        event: z.enum(["start", "progress", "stop"]),
        position: z.number().finite().min(0).max(86_400),
        paused: z.boolean().default(false),
      })
      .parse(request.body);
    await upstream.jellyfinReport(jellyfinAccess(context, user.id), body.event, body.trackID, body.position, body.paused);
    return {};
  });

  // Cover grids load hundreds of these; they get their own budget so browsing never blocks playback.
  app.get("/api/v1/artwork/:id", { config: { rateLimit: { max: 3000, timeWindow: "1 minute" } } }, async (request, reply) => {
    const { user } = auth.require(request);
    const { id } = idParam.parse(request.params);
    const { size } = z.object({ size: z.enum(artworkSizes).default("medium") }).parse(request.query);
    try {
      const artwork = await upstream.jellyfinArtwork(jellyfinAccess(context, user.id), id, size);
      auth.require(request);
      return reply
        .type(artwork.type)
        .header("Cache-Control", "private, max-age=86400")
        .send(Buffer.from(artwork.bytes));
    } catch (cause) {
      // Missing art is normal: say so cheaply and let the browser remember it for a while.
      if (cause instanceof UpstreamError && cause.status === 404)
        return reply
          .code(404)
          .header("Cache-Control", "private, max-age=3600")
          .send({ error: { code: "no_artwork", message: "This item has no artwork." } });
      throw cause;
    }
  });

  app.post("/api/v1/stream-tickets", async (request) => {
    const { user, session } = auth.require(request);
    const { trackID } = z.object({ trackID: itemID }).parse(request.body);
    await upstream.jellyfinTrack(jellyfinAccess(context, user.id), trackID);
    auth.require(request);
    const expiresAt = context.now() + TICKET_LIFETIME;
    const ticket = store.createTicket(session.id, trackID, expiresAt);
    return { url: `/api/v1/streams/${ticket}`, expiresAt: new Date(expiresAt).toISOString() };
  });

  // Media elements cannot send headers, so the unguessable ticket is the credential.
  // Operators must keep this path out of access logs.
  app.get(
    "/api/v1/streams/:ticket",
    { config: { rateLimit: { max: 6000, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const { ticket: token } = z.object({ ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).parse(request.params);
      const ticket = store.ticket(token, context.now());
      if (!ticket) throw new APIError(401, "ticket_expired", "Playback authorization expired. Start playback again.");
      const access = jellyfinAccess(context, ticket.userID);
      const controller = context.streams.open(ticket.sessionID);
      if (!controller) throw new APIError(429, "stream_limit", "Too many streams are open on this device.");
      const release = () => context.streams.release(ticket.sessionID, controller);
      // On a keep-alive connection "close" waits for the socket, so a finished response releases on "finish".
      reply.raw.once("finish", release);
      reply.raw.once("close", release);
      try {
        const headers = request.headers;
        const response = await upstream.jellyfinStream(
          access,
          ticket.trackID,
          z.string().max(200).optional().catch(undefined).parse(headers.range),
          z.string().max(200).optional().catch(undefined).parse(headers["if-range"]),
          controller.signal,
        );
        const type = (response.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
        for (const name of passthroughHeaders) {
          const value = response.headers.get(name);
          if (value) reply.header(name, value);
        }
        // Only audio is ever served from this origin, and never as a document.
        reply
          .type(playableType.test(type) ? type : "application/octet-stream")
          .header("Content-Disposition", "inline")
          .header("Content-Security-Policy", "default-src 'none'; sandbox")
          .header("Cache-Control", "no-store")
          .code(response.status);
        if (!response.body) {
          release();
          return reply.send();
        }
        // WHATWG streams are async-iterable; Readable.from bridges to Node.
        const body = Readable.from(response.body);
        body.on("error", (cause: Error) => {
          // An abort is the listener leaving or the session ending; anything else is Jellyfin failing mid-stream.
          if (!controller.signal.aborted) log("stream_interrupted", { error: `${cause.name}: ${cause.message}` });
        });
        return reply.send(body);
      } catch (cause) {
        release();
        // The client left or was signed out while Jellyfin was being asked: not a server fault.
        if (controller.signal.aborted && !(cause instanceof UpstreamError))
          throw new APIError(401, "ticket_expired", "Playback stopped. Start playback again.");
        throw cause;
      }
    },
  );
}
