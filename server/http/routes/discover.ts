import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AlbumCandidate } from "../../upstream/index.ts";
import { UpstreamError } from "../../upstream/index.ts";
import { hasJellyfin, jellyfinAccess, lastfmAccount, mbidParam, type AppContext } from "../context.ts";
import { APIError } from "../errors.ts";

type CandidateStatus = "available" | "requested" | null;
type Annotated = AlbumCandidate & { status: CandidateStatus };
const RECOMMENDATION_TTL = 30 * 60_000;

export function discoverRoutes(app: FastifyInstance, context: AppContext) {
  const { store, auth, upstream } = context;
  const recommendationCache = new Map<string, { items: AlbumCandidate[]; source: string; expiresAt: number }>();

  /** Best effort: search still works when the user's library cannot be read. */
  async function libraryGroups(userID: string): Promise<Map<string, string> | null> {
    if (!hasJellyfin(context, userID)) return null;
    try {
      return await context.library.groups(userID, jellyfinAccess(context, userID));
    } catch (cause) {
      if (cause instanceof UpstreamError) return null;
      throw cause;
    }
  }
  async function annotate(userID: string, items: AlbumCandidate[]): Promise<Annotated[]> {
    const requested = store.requestedGroups(userID);
    const library = await libraryGroups(userID);
    return items.map((item) => ({
      ...item,
      status: library?.has(item.id) ? "available" : requested.has(item.id) ? "requested" : null,
    }));
  }

  app.get("/api/v1/discover/search", async (request) => {
    const { user } = auth.require(request);
    const { q } = z.object({ q: z.string().trim().min(1).max(200) }).parse(request.query);
    const result = await upstream.search(q, lastfmAccount(context, user.id)?.apiKey ?? null);
    return { ...result, items: await annotate(user.id, result.items) };
  });

  app.get("/api/v1/discover/artists/:id/albums", async (request) => {
    const { user } = auth.require(request);
    const { id } = mbidParam.parse(request.params);
    const { offset } = z
      .object({ offset: z.coerce.number().int().min(0).max(10_000).default(0) })
      .parse(request.query);
    const page = await upstream.artistAlbums(id, offset, lastfmAccount(context, user.id)?.apiKey ?? null);
    return { ...page, items: await annotate(user.id, page.items) };
  });

  app.get("/api/v1/discover/release-groups/:id/editions", async (request) => {
    auth.require(request);
    const { id } = mbidParam.parse(request.params);
    return { items: await upstream.editions(id) };
  });

  app.get("/api/v1/discover/recommendations", async (request) => {
    const { user } = auth.require(request);
    const { refresh } = z.object({ refresh: z.enum(["1"]).optional() }).parse(request.query);
    const account = lastfmAccount(context, user.id);
    const source = account ? "lastfm" : "musicbrainz";
    let cached = recommendationCache.get(user.id);
    if (!cached || cached.expiresAt <= context.now() || cached.source !== source || refresh) {
      cached = { items: await upstream.recommendations(account), source, expiresAt: context.now() + RECOMMENDATION_TTL };
      recommendationCache.set(user.id, cached);
    }
    if (!cached.items.length) return { items: [], source, emptyReason: "no_candidates" };
    let library = new Map<string, string>();
    if (hasJellyfin(context, user.id))
      try {
        library = await context.library.groups(user.id, jellyfinAccess(context, user.id));
      } catch (cause) {
        // Suggesting albums the user already owns is worse than suggesting nothing.
        if (cause instanceof UpstreamError)
          throw new APIError(
            cause.status,
            "library_unavailable",
            `Recommendations need your Jellyfin library to filter out albums you have. ${cause.message}`,
          );
        throw cause;
      }
    const requested = store.requestedGroups(user.id);
    const items = cached.items.filter((item) => !library.has(item.id) && !requested.has(item.id));
    return {
      items: items.map((item) => ({ ...item, status: null })),
      source,
      emptyReason: items.length ? null : "all_excluded",
    };
  });
}
