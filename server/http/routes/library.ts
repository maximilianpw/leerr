import type { FastifyInstance } from "fastify";
import { Readable } from "node:stream";
import { z } from "zod";
import { idParam, itemID, jellyfinAccess, type AppContext } from "../context.ts";
import { APIError } from "../errors.ts";

/** Tickets authorise stream admission only; a started stream is never cut off by expiry. */
const TICKET_LIFETIME = 6 * 3_600_000;
const passthroughHeaders = ["content-length", "content-range", "accept-ranges", "etag", "last-modified"];
const playableType = /^(audio\/[a-z0-9.+-]+|application\/octet-stream)$/;

export function libraryRoutes(app: FastifyInstance, context: AppContext) {
  const { store, auth, upstream } = context;

  app.get("/api/v1/library", async (request) => {
    const { user } = auth.require(request);
    const page = z
      .object({
        offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
        limit: z.coerce.number().int().min(1).max(500).default(60),
        q: z.string().trim().max(200).default(""),
      })
      .parse(request.query);
    return upstream.jellyfinLibrary(jellyfinAccess(context, user.id), page.offset, page.limit, page.q);
  });

  app.get("/api/v1/albums/:id", async (request) => {
    const { user } = auth.require(request);
    const { id } = idParam.parse(request.params);
    return upstream.jellyfinAlbum(jellyfinAccess(context, user.id), id);
  });

  app.get("/api/v1/artwork/:id", async (request, reply) => {
    const { user } = auth.require(request);
    const { id } = idParam.parse(request.params);
    const artwork = await upstream.jellyfinArtwork(jellyfinAccess(context, user.id), id);
    auth.require(request);
    return reply
      .type(artwork.type)
      .header("Cache-Control", "private, max-age=86400")
      .send(Buffer.from(artwork.bytes));
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
        return reply.send(Readable.from(response.body));
      } catch (cause) {
        release();
        throw cause;
      }
    },
  );
}
