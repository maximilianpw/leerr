import type { JellyfinAccess, Upstreams } from "./upstream/index.ts";

const PAGE = 500;
const MAX_ALBUMS = 50_000;

type Entry = { groups: Promise<Map<string, string>>; expiresAt: number };

/**
 * Per-user map of MusicBrainz release group → Jellyfin album id, used to mark
 * requests available and filter discovery. Cached briefly because building it
 * walks the user's whole Jellyfin library; concurrent callers share one walk.
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

  groups(userID: string, access: JellyfinAccess): Promise<Map<string, string>> {
    const cached = this.#entries.get(userID);
    if (cached && cached.expiresAt > this.#now()) return cached.groups;
    const groups = this.#walk(access);
    const entry = { groups, expiresAt: this.#now() + this.#ttl };
    this.#entries.set(userID, entry);
    groups.catch(() => {
      if (this.#entries.get(userID) === entry) this.#entries.delete(userID);
    });
    return groups;
  }

  invalidate(userID?: string) {
    if (userID === undefined) this.#entries.clear();
    else this.#entries.delete(userID);
  }

  async #walk(access: JellyfinAccess): Promise<Map<string, string>> {
    const groups = new Map<string, string>();
    for (let offset = 0; offset < MAX_ALBUMS; offset += PAGE) {
      const page = await this.#upstream.jellyfinLibrary(access, offset, PAGE);
      for (const album of page.items)
        if (album.releaseGroupMBID && !groups.has(album.releaseGroupMBID))
          groups.set(album.releaseGroupMBID, album.id);
      if (!page.items.length || offset + page.items.length >= page.total) return groups;
    }
    return groups;
  }
}
