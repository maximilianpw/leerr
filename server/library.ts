import type { JellyfinAccess, Upstreams } from "./upstream/index.ts";

const PAGE = 500;
const MAX_ALBUMS = 50_000;
/** A failed walk is remembered briefly so a hanging Jellyfin does not slow every page. */
const FAILURE_TTL = 30_000;

/** What Leerr knows about one user's Jellyfin music library from a full walk. */
export type LibrarySummary = {
  /** MusicBrainz release group → Jellyfin album id. */
  groups: Map<string, string>;
  /** Album-artist name → number of albums, for library-seeded suggestions. */
  artists: Map<string, number>;
  /** Album-artist MusicBrainz id → number of albums, for new releases. */
  artistMBIDs: Map<string, number>;
  albums: number;
  /** Albums without a release-group id, which Leerr cannot match to requests. */
  unmatched: number;
};
type Entry = { summary: Promise<LibrarySummary>; expiresAt: number };

/**
 * Per-user summary of the Jellyfin library, used to mark requests available,
 * filter discovery and seed suggestions. Cached briefly because building it
 * walks the user's whole library; concurrent callers share one walk.
 */
export class LibraryIndex {
  readonly #upstream: Upstreams;
  readonly #now: () => number;
  readonly #ttl: number;
  readonly #entries = new Map<string, Entry>();

  constructor(upstream: Upstreams, now: () => number, ttl = 2 * 60_000) {
    this.#upstream = upstream;
    this.#now = now;
    this.#ttl = ttl;
  }

  summary(userID: string, access: JellyfinAccess): Promise<LibrarySummary> {
    const cached = this.#entries.get(userID);
    if (cached && cached.expiresAt > this.#now()) return cached.summary;
    const summary = this.#walk(access);
    const entry = { summary, expiresAt: this.#now() + this.#ttl };
    this.#entries.set(userID, entry);
    summary.catch(() => {
      if (this.#entries.get(userID) === entry) this.#entries.set(userID, { summary, expiresAt: this.#now() + FAILURE_TTL });
    });
    return summary;
  }

  async groups(userID: string, access: JellyfinAccess): Promise<Map<string, string>> {
    return (await this.summary(userID, access)).groups;
  }

  invalidate(userID?: string) {
    if (userID === undefined) this.#entries.clear();
    else this.#entries.delete(userID);
  }

  async #walk(access: JellyfinAccess): Promise<LibrarySummary> {
    const summary: LibrarySummary = { groups: new Map(), artists: new Map(), artistMBIDs: new Map(), albums: 0, unmatched: 0 };
    for (let offset = 0; offset < MAX_ALBUMS; offset += PAGE) {
      const page = await this.#upstream.jellyfinLibrary(access, {
        offset,
        limit: PAGE,
        q: "",
        sort: "title",
        artistID: null,
        favorites: false,
      });
      for (const album of page.items) {
        summary.albums++;
        if (!album.releaseGroupMBID) summary.unmatched++;
        else if (!summary.groups.has(album.releaseGroupMBID)) summary.groups.set(album.releaseGroupMBID, album.id);
        if (album.artist) summary.artists.set(album.artist, (summary.artists.get(album.artist) ?? 0) + 1);
        if (album.artistMBID) summary.artistMBIDs.set(album.artistMBID, (summary.artistMBIDs.get(album.artistMBID) ?? 0) + 1);
      }
      if (!page.items.length || offset + page.items.length >= page.total) return summary;
    }
    return summary;
  }
}

/** The keys with the highest counts, most first. */
export function top(counts: Map<string, number>, limit: number): string[] {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([key]) => key);
}
