import type { FastifyInstance, FastifyRequest } from "fastify";
import { Readable } from "node:stream";
import { z } from "zod";
import { opaque } from "../../store.ts";
import { artworkSizes, librarySorts, UpstreamError, type Album, type PlayableTrack, type TimelineState } from "../../upstream/index.ts";
import { idParam, itemID, plexAccess, withPlex, type AppContext } from "../context.ts";
import { APIError } from "../errors.ts";

/** Tickets authorise stream admission only; a started stream is never cut off by expiry. */
const TICKET_LIFETIME = 6 * 3_600_000;
const passthroughHeaders = ["content-length", "content-range", "accept-ranges", "etag", "last-modified"];
const playableType = /^(audio\/[a-z0-9.+-]+|application\/octet-stream)$/;
const flag = z.enum(["0", "1"]).transform((value) => value === "1");
const states: Record<"start" | "progress" | "stop", (paused: boolean) => TimelineState> = {
  start: () => "playing",
  progress: (paused) => (paused ? "paused" : "playing"),
  stop: () => "stopped",
};
/** Track lengths Plex needs with every report, remembered from when the track's ticket was made. */
const DURATIONS = 2_000;

export function libraryRoutes(app: FastifyInstance, context: AppContext) {
  const { store, auth, upstream, log } = context;
  const durations = new Map<string, number>();
  const rememberDuration = (track: PlayableTrack) => {
    if (track.durationMs === null) return;
    durations.delete(track.id);
    durations.set(track.id, track.durationMs);
    if (durations.size > DURATIONS) durations.delete(durations.keys().next().value ?? "");
  };

  /** Release groups Leerr already resolved, so albums can link to their MusicBrainz group. */
  const withGroups = <T extends Album>(albums: T[]): T[] => {
    const groups = store.releaseGroups(albums.flatMap((album) => (album.releaseMBID ? [album.releaseMBID] : [])), context.now());
    return albums.map((album) => ({ ...album, releaseGroupMBID: (album.releaseMBID && groups.get(album.releaseMBID)) || null }));
  };

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
    const page = await withPlex(context, user.id, (access) =>
      upstream.plexLibrary(access, {
        offset: query.offset,
        limit: query.limit,
        q: query.q,
        sort: query.sort,
        artistID: query.artist ?? null,
        favorites: query.favorites,
      }),
    );
    return { ...page, items: withGroups(page.items) };
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
    return withPlex(context, user.id, (access) => upstream.plexArtists(access, query.offset, query.limit, query.q));
  });

  app.get("/api/v1/albums/:id", async (request) => {
    const { user } = auth.require(request);
    const { id } = idParam.parse(request.params);
    const detail = await withPlex(context, user.id, (access) => upstream.plexAlbum(access, id));
    return { ...detail, album: withGroups([detail.album])[0] };
  });

  app.get("/api/v1/playlists", async (request) => {
    const { user } = auth.require(request);
    return { items: await withPlex(context, user.id, (access) => upstream.plexPlaylists(access)) };
  });

  app.get("/api/v1/playlists/:id", async (request) => {
    const { user } = auth.require(request);
    const { id } = idParam.parse(request.params);
    return withPlex(context, user.id, (access) => upstream.plexPlaylist(access, id));
  });

  app.post("/api/v1/playlists/:id/tracks", async (request) => {
    const { user } = auth.require(request);
    const { id } = idParam.parse(request.params);
    const { trackIDs } = z.object({ trackIDs: z.array(itemID).min(1).max(500) }).parse(request.body);
    await withPlex(context, user.id, (access) => upstream.plexAddToPlaylist(access, id, trackIDs));
    return {};
  });

  // A favourite is Plex's five-star rating, the same one Plexamp and Plex Web show.
  const favorite = (value: boolean) => async (request: FastifyRequest) => {
    const { user } = auth.require(request);
    const { id } = idParam.parse(request.params);
    await withPlex(context, user.id, (access) => upstream.plexFavorite(access, id, value));
    return {};
  };
  app.put("/api/v1/favorites/:id", favorite(true));
  app.delete("/api/v1/favorites/:id", favorite(false));

  // Reports what plays to Plex: "now playing", play counts and history.
  app.post("/api/v1/playback", async (request) => {
    const { user, session } = auth.require(request);
    const body = z
      .object({
        trackID: itemID,
        event: z.enum(["start", "progress", "stop"]),
        position: z.number().finite().min(0).max(86_400),
        paused: z.boolean().default(false),
      })
      .parse(request.body);
    const stopped = await withPlex(
      context,
      user.id,
      async (access) => {
        let durationMs = durations.get(body.trackID);
        if (durationMs === undefined) {
          const track = await upstream.plexTrack(access, body.trackID);
          rememberDuration(track);
          durationMs = track.durationMs ?? 0;
        }
        return upstream.plexReport(access, { trackID: body.trackID, state: states[body.event](body.paused), position: body.position, durationMs });
      },
      session.id,
    );
    // Plex ended this playback (for example an administrator stopped it): the player stops and says why.
    return stopped ? { stop: stopped } : {};
  });

  // Cover grids load hundreds of these; they get their own budget so browsing never blocks playback.
  app.get("/api/v1/artwork/:id", { config: { rateLimit: { max: 3000, timeWindow: "1 minute" } } }, async (request, reply) => {
    const { user } = auth.require(request);
    const { id } = idParam.parse(request.params);
    const { size } = z.object({ size: z.enum(artworkSizes).default("medium") }).parse(request.query);
    try {
      const artwork = await withPlex(context, user.id, (access) => upstream.plexArtwork(access, id, size));
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
    const track = await withPlex(context, user.id, (access) => upstream.plexTrack(access, trackID));
    rememberDuration(track);
    auth.require(request);
    const expiresAt = context.now() + TICKET_LIFETIME;
    const ticket = store.createTicket(session.id, trackID, expiresAt);
    return {
      url: `/api/v1/streams/${ticket}`,
      expiresAt: new Date(expiresAt).toISOString(),
      // Converted streams cannot be ranged: the player seeks by asking for a new start.
      transcoded: track.transcode,
    };
  });

  // Media elements cannot send headers, so the unguessable ticket is the credential.
  // Operators must keep this path out of access logs.
  app.get(
    "/api/v1/streams/:ticket",
    { config: { rateLimit: { max: 6000, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const { ticket: token } = z.object({ ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).parse(request.params);
      const { start } = z.object({ start: z.coerce.number().finite().min(0).max(86_400).default(0) }).parse(request.query);
      const ticket = store.ticket(token, context.now());
      if (!ticket) throw new APIError(401, "ticket_expired", "Playback authorization expired. Start playback again.");
      // Checked before a stream slot is taken: a person without Plex gets the right error.
      plexAccess(context, ticket.userID, ticket.sessionID);
      const controller = context.streams.open(ticket.sessionID);
      if (!controller) throw new APIError(429, "stream_limit", "Too many streams are open on this device.");
      let conversion: { session: string; stop: () => void } | null = null;
      const release = () => {
        context.streams.release(ticket.sessionID, controller);
        const ending = conversion;
        conversion = null;
        ending?.stop();
      };
      // On a keep-alive connection "close" waits for the socket, so a finished response releases on "finish".
      reply.raw.once("finish", release);
      reply.raw.once("close", release);
      try {
        const headers = request.headers;
        const response = await withPlex(
          context,
          ticket.userID,
          async (access) => {
            const track = await upstream.plexTrack(access, ticket.trackID, controller.signal);
            if (!track.transcode)
              return upstream.plexStream(
                access,
                track,
                z.string().max(200).optional().catch(undefined).parse(headers.range),
                z.string().max(200).optional().catch(undefined).parse(headers["if-range"]),
                controller.signal,
              );
            const session = `leerr-${opaque().slice(0, 24)}`;
            conversion = {
              session,
              stop: () =>
                void upstream.plexStopTranscode(access, session).catch((cause: Error) => {
                  if (!(cause instanceof UpstreamError)) log("stream_interrupted", { error: `${cause.name}: ${cause.message}` });
                }),
            };
            return upstream.plexTranscode(access, track, start, session, controller.signal);
          },
          ticket.sessionID,
        );
        const type = (response.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
        for (const name of passthroughHeaders) {
          const value = response.headers.get(name);
          if (value) reply.header(name, value);
        }
        if (conversion) reply.header("Accept-Ranges", "none");
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
          // An abort is the listener leaving or the session ending; anything else is Plex failing mid-stream.
          if (!controller.signal.aborted) log("stream_interrupted", { error: `${cause.name}: ${cause.message}` });
        });
        return reply.send(body);
      } catch (cause) {
        release();
        // The client left or was signed out while Plex was being asked: not a server fault.
        if (controller.signal.aborted && !(cause instanceof UpstreamError))
          throw new APIError(401, "ticket_expired", "Playback stopped. Start playback again.");
        throw cause;
      }
    },
  );
}
