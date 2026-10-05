import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { top, type LibrarySummary } from "../../library.ts";
import { albumTypes, ARTIST_PAGE, UpstreamError, type AlbumCandidate, type RecommendationSeed } from "../../upstream/index.ts";
import { hasPlex, lastfmAccount, lastfmKey, mbidParam, plexUnavailable, withPlex, type AppContext } from "../context.ts";
import { APIError } from "../errors.ts";

type CandidateStatus = "available" | "requested" | null;
type Annotated = AlbumCandidate & { status: CandidateStatus; albumID: string | null };
type Cached = { items: Promise<AlbumCandidate[]>; key: string; expiresAt: number };
const RECOMMENDATION_TTL = 30 * 60_000;
const NEW_RELEASES_TTL = 6 * 3_600_000;
const NEW_RELEASE_WINDOW = 120 * 86_400_000;
const FAILURE_TTL = 60_000;
/** Album-artist names that are not an artist anyone listens to. */
const notArtists = new Set(["various artists", "various", "soundtrack", "unknown artist", ""]);
const VARIOUS_ARTISTS = "89ad4ac3-39f7-470e-963a-56509c546377";

export function discoverRoutes(app: FastifyInstance, context: AppContext) {
  const { store, auth, upstream } = context;
  const recommendationCache = new Map<string, Cached>();
  const newReleaseCache = new Map<string, Cached>();

  /** Shares one computation between concurrent callers; failures are remembered briefly, not for the full TTL. */
  function cached(cache: Map<string, Cached>, userID: string, key: string, ttl: number, refresh: boolean, load: () => Promise<AlbumCandidate[]>) {
    const entry = cache.get(userID);
    if (entry && entry.key === key && entry.expiresAt > context.now() && !refresh) return entry.items;
    const items = load();
    const next = { items, key, expiresAt: context.now() + ttl };
    cache.set(userID, next);
    items.catch(() => {
      if (cache.get(userID) === next) cache.set(userID, { ...next, expiresAt: context.now() + FAILURE_TTL });
    });
    return items;
  }

  /** Best effort: search still works when the user's library cannot be read. */
  async function librarySummary(userID: string): Promise<LibrarySummary | null> {
    if (!hasPlex(context, userID)) return null;
    try {
      return await withPlex(context, userID, (access) => context.library.summary(userID, access));
    } catch (cause) {
      if (plexUnavailable(cause)) return null;
      throw cause;
    }
  }
  function annotate(userID: string, items: AlbumCandidate[], library: LibrarySummary | null): Annotated[] {
    // Read after the awaits, so a request made meanwhile is reflected.
    const requested = store.requestedGroups(userID);
    return items.map((item) => {
      const albumID = library?.groups.get(item.id) ?? null;
      return { ...item, albumID, status: albumID ? "available" : requested.has(item.id) ? "requested" : null };
    });
  }

  app.get("/api/v1/discover/search", async (request) => {
    const { user } = auth.require(request);
    const { q } = z.object({ q: z.string().trim().min(1).max(200) }).parse(request.query);
    // The library walk and MusicBrainz run side by side.
    const [result, library] = await Promise.all([upstream.search(q, lastfmKey(context, user.id)), librarySummary(user.id)]);
    return { ...result, items: annotate(user.id, result.items, library) };
  });

  app.get("/api/v1/discover/artists/:id/albums", async (request) => {
    const { user } = auth.require(request);
    const { id } = mbidParam.parse(request.params);
    const { offset, type } = z
      .object({
        offset: z.coerce.number().int().min(0).max(10_000).default(0),
        type: z.enum(albumTypes).default("studio"),
      })
      .parse(request.query);
    const [page, library] = await Promise.all([
      upstream.artistAlbums(id, offset, type, lastfmKey(context, user.id)),
      librarySummary(user.id),
    ]);
    return { ...page, items: annotate(user.id, page.items, library), pageSize: ARTIST_PAGE };
  });

  app.get("/api/v1/discover/release-groups/:id/editions", async (request) => {
    auth.require(request);
    const { id } = mbidParam.parse(request.params);
    const editions = await upstream.editions(id);
    // Plex names albums by edition: knowing every edition's group saves MusicBrainz lookups later.
    store.saveReleaseGroups(new Map(editions.items.map((edition) => [edition.id, id])), context.now());
    return editions;
  });

  app.get("/api/v1/discover/recommendations", async (request) => {
    const { user } = auth.require(request);
    const { refresh } = z.object({ refresh: z.enum(["1"]).optional() }).parse(request.query);
    const account = lastfmAccount(context, user.id);
    const installationKey = store.settings().lastfmKey;
    let library: LibrarySummary | null = null;
    if (hasPlex(context, user.id))
      try {
        library = await withPlex(context, user.id, (access) => context.library.summary(user.id, access));
      } catch (cause) {
        // Suggesting albums the user already owns is worse than suggesting nothing.
        if (cause instanceof UpstreamError)
          throw new APIError(
            cause.status,
            cause.code === "plex_reconnect" ? cause.code : "library_unavailable",
            `Suggestions need your Plex library to leave out albums you have. ${cause.message}`,
          );
        throw cause;
      }
    const seedArtists = library ? top(library.artists, 20).filter((name) => !notArtists.has(name.toLowerCase())) : [];
    let seed: RecommendationSeed = { source: "musicbrainz" };
    if (account) seed = { source: "lastfm", account };
    else if (installationKey && seedArtists.length) seed = { source: "library", artists: seedArtists.slice(0, 3), apiKey: installationKey };
    const key = seed.source === "lastfm" ? `lastfm:${seed.account.username}` : seed.source === "library" ? `library:${seed.artists.join("|")}` : "musicbrainz";
    const candidates = await cached(recommendationCache, user.id, key, RECOMMENDATION_TTL, !!refresh, () => upstream.recommendations(seed));
    if (!candidates.length) return { items: [], source: seed.source, emptyReason: "no_candidates" };
    const requested = store.requestedGroups(user.id);
    const items = candidates.filter((item) => !library?.groups.has(item.id) && !requested.has(item.id));
    return {
      items: items.map((item) => ({ ...item, status: null, albumID: null })),
      source: seed.source,
      emptyReason: items.length ? null : "all_excluded",
    };
  });

  app.get("/api/v1/discover/new-releases", async (request) => {
    const { user } = auth.require(request);
    const library = await librarySummary(user.id);
    if (!library) return { items: [] };
    // "Various Artists" is credited on many unrelated compilations.
    const artists = top(library.artistMBIDs, 41)
      .filter((id) => id !== VARIOUS_ARTISTS)
      .slice(0, 40);
    const since = new Date(context.now() - NEW_RELEASE_WINDOW).toISOString().slice(0, 10);
    const candidates = await cached(newReleaseCache, user.id, artists.join(","), NEW_RELEASES_TTL, false, () =>
      upstream.newReleases(artists, since),
    );
    return { items: annotate(user.id, candidates, library).filter((item) => item.status !== "available") };
  });
}
