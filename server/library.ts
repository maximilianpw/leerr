import type { Logger } from "./log.ts";
import type { Store } from "./store.ts";
import { PartialReleaseLookup, UpstreamError, type PlexAccess, type Upstreams } from "./upstream/index.ts";

/** A failed walk is remembered briefly so a hanging Plex does not slow every page. */
const FAILURE_TTL = 30_000;
/**
 * Releases resolved through MusicBrainz per walk. The rest wait for the next
 * walk, so a large first library cannot hold up searches sharing MusicBrainz's rate limit.
 */
const RESOLVE_PER_WALK = 300;

/** What Leerr knows about one person's Plex music library from a full walk. */
export type LibrarySummary = {
  /** MusicBrainz release group → Plex album id. */
  groups: Map<string, string>;
  /** Album-artist name → number of albums, for library-seeded suggestions. */
  artists: Map<string, number>;
  /** Album-artist MusicBrainz id → number of albums, for new releases. */
  artistMBIDs: Map<string, number>;
  albums: number;
  /** Albums Plex has not matched to MusicBrainz, which Leerr cannot match to requests. */
  unmatched: number;
  /** Every album by `albumKey`, to point at an arrived album Plex matched to nothing or to another album. */
  byName: Map<string, string>;
};
/** A walk is only reused for the token that made it: a renewed token walks afresh. */
type Entry = { summary: Promise<LibrarySummary>; expiresAt: number; token: string };

/**
 * Per-person summary of the Plex library, used to mark requests available,
 * filter discovery and seed suggestions. Plex names each album's MusicBrainz
 * release; the release groups requests are keyed by come from a shared,
 * persistent lookup. Cached briefly because building it walks the whole
 * library; concurrent callers share one walk.
 */
export class LibraryIndex {
  readonly #upstream: Upstreams;
  readonly #store: Store;
  readonly #now: () => number;
  readonly #log: Logger;
  readonly #ttl: number;
  readonly #entries = new Map<string, Entry>();

  constructor(upstream: Upstreams, store: Store, now: () => number, log: Logger, ttl = 2 * 60_000) {
    this.#upstream = upstream;
    this.#store = store;
    this.#now = now;
    this.#log = log;
    this.#ttl = ttl;
  }

  summary(userID: string, access: PlexAccess): Promise<LibrarySummary> {
    const cached = this.#entries.get(userID);
    if (cached && cached.token === access.token && cached.expiresAt > this.#now()) return cached.summary;
    const summary = this.#walk(access);
    const entry = { summary, expiresAt: this.#now() + this.#ttl, token: access.token };
    this.#entries.set(userID, entry);
    summary.catch(() => {
      if (this.#entries.get(userID) === entry) this.#entries.set(userID, { ...entry, expiresAt: this.#now() + FAILURE_TTL });
    });
    return summary;
  }

  async groups(userID: string, access: PlexAccess): Promise<Map<string, string>> {
    return (await this.summary(userID, access)).groups;
  }

  invalidate(userID?: string) {
    if (userID === undefined) this.#entries.clear();
    else this.#entries.delete(userID);
  }

  /** Release → group for these releases, from the shared lookup, asking MusicBrainz for what it lacks. */
  async #groupsOf(releases: string[]): Promise<Map<string, string | null>> {
    const known = this.#store.releaseGroups(releases, this.#now());
    const missing = releases.filter((id) => !known.has(id)).slice(0, RESOLVE_PER_WALK);
    if (!missing.length) return known;
    try {
      const resolved = await this.#upstream.releaseGroupsOf(missing);
      this.#store.saveReleaseGroups(resolved, this.#now());
      for (const [release, group] of resolved) known.set(release, group);
    } catch (cause) {
      // Albums wait for the next walk; everything already known (or resolved before the failure) still counts.
      if (!(cause instanceof UpstreamError)) throw cause;
      if (cause instanceof PartialReleaseLookup) {
        this.#store.saveReleaseGroups(cause.resolved, this.#now());
        for (const [release, group] of cause.resolved) known.set(release, group);
      }
      this.#log("release_lookup_failed", { code: cause.code, message: cause.message });
    }
    return known;
  }

  async #walk(access: PlexAccess): Promise<LibrarySummary> {
    const contents = await this.#upstream.plexLibraryIndex(access);
    const releases = [...new Set(contents.albums.flatMap((album) => (album.releaseMBID ? [album.releaseMBID] : [])))];
    const groups = await this.#groupsOf(releases);
    const summary: LibrarySummary = { groups: new Map(), artists: new Map(), artistMBIDs: new Map(), albums: 0, unmatched: 0, byName: new Map() };
    for (const album of contents.albums) {
      summary.albums++;
      const key = albumKey(album.artist, album.title);
      if (!summary.byName.has(key)) summary.byName.set(key, album.id);
      const group = album.releaseMBID ? groups.get(album.releaseMBID) : null;
      // Not yet looked up (over this walk's budget) is not unmatched: it resolves on a later walk.
      if (group) {
        if (!summary.groups.has(group)) summary.groups.set(group, album.id);
      } else if (!album.releaseMBID || group === null) summary.unmatched++;
      if (album.artist) summary.artists.set(album.artist, (summary.artists.get(album.artist) ?? 0) + 1);
      const artistMBID = album.artistID ? contents.artistMBIDs.get(album.artistID) : undefined;
      if (artistMBID) summary.artistMBIDs.set(artistMBID, (summary.artistMBIDs.get(artistMBID) ?? 0) + 1);
    }
    return summary;
  }
}

/** An album's artist and title as people compare them: case, accents and punctuation aside. */
export function albumKey(artist: string, title: string): string {
  const plain = (text: string) =>
    text
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  return `${plain(artist)}\0${plain(title)}`;
}

/** The keys with the highest counts, most first. */
export function top(counts: Map<string, number>, limit: number): string[] {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([key]) => key);
}
