import { UpstreamError } from "./errors.ts";
import { HttpClient, type Fetcher } from "./http.ts";
import {
  Jellyfin,
  type AlbumDetail,
  type AlbumPage,
  type Artwork,
  type JellyfinAccess,
  type JellyfinAccount,
  type Track,
} from "./jellyfin.ts";
import { Lastfm, type LastfmAccount, type LastfmAlbum } from "./lastfm.ts";
import {
  Lidarr,
  type Identity,
  type LidarrAccess,
  type LidarrAlbum,
  type LidarrCandidate,
  type LidarrCommand,
  type LidarrOptions,
  type LidarrProfile,
} from "./lidarr.ts";
import {
  luceneTerms,
  MusicBrainz,
  type AlbumCandidate,
  type ArtistMatch,
  type CandidatePage,
  type Edition,
} from "./musicbrainz.ts";

export { UpstreamError, validateEndpoint, type MutationOutcome } from "./errors.ts";
export type * from "./jellyfin.ts";
export type * from "./lastfm.ts";
export type * from "./lidarr.ts";
export type * from "./musicbrainz.ts";

export type SearchResult = CandidatePage & { artists: ArtistMatch[] };

/** Every external service Leerr talks to. Tests substitute a fake implementation. */
export interface Upstreams {
  jellyfinLogin(endpoint: string, username: string, password: string): Promise<JellyfinAccount>;
  jellyfinLibrary(access: JellyfinAccess, offset: number, limit: number, query?: string): Promise<AlbumPage>;
  jellyfinAlbum(access: JellyfinAccess, albumID: string): Promise<AlbumDetail>;
  jellyfinTrack(access: JellyfinAccess, trackID: string): Promise<Track>;
  jellyfinArtwork(access: JellyfinAccess, itemID: string): Promise<Artwork>;
  jellyfinStream(
    access: JellyfinAccess,
    trackID: string,
    range: string | undefined,
    ifRange: string | undefined,
    signal: AbortSignal,
  ): Promise<Response>;

  lidarrOptions(access: LidarrAccess): Promise<LidarrOptions>;
  lidarrAlbum(access: LidarrAccess, releaseGroupMBID: string): Promise<LidarrAlbum | null>;
  lidarrLookup(access: LidarrAccess, identity: Identity, profile: LidarrProfile): Promise<LidarrCandidate>;
  lidarrCreate(access: LidarrAccess, candidate: LidarrCandidate): Promise<void>;
  lidarrMonitor(access: LidarrAccess, album: LidarrAlbum, releaseMBID: string): Promise<void>;
  lidarrLatestCommandID(access: LidarrAccess): Promise<number>;
  lidarrLatestSearch(access: LidarrAccess, albumID: number, after: number): Promise<LidarrCommand | null>;
  lidarrSearch(access: LidarrAccess, albumID: number): Promise<number>;

  lastfmCheck(account: LastfmAccount): Promise<void>;
  search(query: string, lastfmKey: string | null): Promise<SearchResult>;
  artistAlbums(artistMBID: string, offset: number, lastfmKey: string | null): Promise<CandidatePage>;
  editions(releaseGroupMBID: string): Promise<Edition[]>;
  identity(releaseGroupMBID: string, releaseMBID: string, artistMBID: string): Promise<Identity>;
  recommendations(account: LastfmAccount | null): Promise<AlbumCandidate[]>;
}

const normalise = (value: string) =>
  value
    .toLowerCase()
    .replace(/\s*[([].*?[)\]]\s*/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

function withCovers(items: AlbumCandidate[], albums: LastfmAlbum[], matchArtist: boolean): void {
  for (const item of items) {
    const match = albums.find(
      (album) =>
        album.coverUrl &&
        normalise(album.name) === normalise(item.title) &&
        (!matchArtist || normalise(album.artist) === normalise(item.artist)),
    );
    if (match) item.coverUrl = match.coverUrl;
  }
}

export class LiveUpstreams implements Upstreams {
  readonly #jellyfin: Jellyfin;
  readonly #lidarr: Lidarr;
  readonly #musicbrainz: MusicBrainz;
  readonly #lastfm: Lastfm;

  constructor(fetcher: Fetcher = fetch) {
    const http = new HttpClient(fetcher);
    this.#jellyfin = new Jellyfin(http);
    this.#lidarr = new Lidarr(http);
    this.#musicbrainz = new MusicBrainz(http);
    this.#lastfm = new Lastfm(http);
  }

  jellyfinLogin(endpoint: string, username: string, password: string) {
    return this.#jellyfin.login(endpoint, username, password);
  }
  jellyfinLibrary(access: JellyfinAccess, offset: number, limit: number, query = "") {
    return this.#jellyfin.library(access, offset, limit, query);
  }
  jellyfinAlbum(access: JellyfinAccess, albumID: string) {
    return this.#jellyfin.album(access, albumID);
  }
  jellyfinTrack(access: JellyfinAccess, trackID: string) {
    return this.#jellyfin.track(access, trackID);
  }
  jellyfinArtwork(access: JellyfinAccess, itemID: string) {
    return this.#jellyfin.artwork(access, itemID);
  }
  jellyfinStream(
    access: JellyfinAccess,
    trackID: string,
    range: string | undefined,
    ifRange: string | undefined,
    signal: AbortSignal,
  ) {
    return this.#jellyfin.stream(access, trackID, range, ifRange, signal);
  }

  lidarrOptions(access: LidarrAccess) {
    return this.#lidarr.options(access);
  }
  lidarrAlbum(access: LidarrAccess, releaseGroupMBID: string) {
    return this.#lidarr.album(access, releaseGroupMBID);
  }
  lidarrLookup(access: LidarrAccess, identity: Identity, profile: LidarrProfile) {
    return this.#lidarr.lookup(access, identity, profile);
  }
  lidarrCreate(access: LidarrAccess, candidate: LidarrCandidate) {
    return this.#lidarr.create(access, candidate);
  }
  lidarrMonitor(access: LidarrAccess, album: LidarrAlbum, releaseMBID: string) {
    return this.#lidarr.monitor(access, album, releaseMBID);
  }
  lidarrLatestCommandID(access: LidarrAccess) {
    return this.#lidarr.latestCommandID(access);
  }
  lidarrLatestSearch(access: LidarrAccess, albumID: number, after: number) {
    return this.#lidarr.latestSearch(access, albumID, after);
  }
  lidarrSearch(access: LidarrAccess, albumID: number) {
    return this.#lidarr.search(access, albumID);
  }

  lastfmCheck(account: LastfmAccount) {
    return this.#lastfm.checkUser(account);
  }

  async search(query: string, lastfmKey: string | null): Promise<SearchResult> {
    const terms = luceneTerms(query);
    const albums = await this.#musicbrainz.releaseGroups(`releasegroup:(${terms}) AND primarytype:album`);
    const artists = await this.#musicbrainz.artists(terms);
    if (lastfmKey && albums.items.length) {
      // Artwork is optional: a Last.fm outage must not fail a valid search.
      try {
        withCovers(albums.items, await this.#lastfm.searchAlbums(lastfmKey, query), true);
      } catch (cause) {
        if (!(cause instanceof UpstreamError)) throw cause;
      }
    }
    return { ...albums, artists };
  }

  async artistAlbums(artistMBID: string, offset: number, lastfmKey: string | null): Promise<CandidatePage> {
    const page = await this.#musicbrainz.releaseGroups(
      `arid:${artistMBID} AND primarytype:album AND (status:official^5 OR primarytype:album)`,
      offset,
    );
    if (lastfmKey && page.items.length) {
      try {
        withCovers(page.items, await this.#lastfm.topAlbums(lastfmKey, { mbid: artistMBID }, 100), false);
      } catch (cause) {
        if (!(cause instanceof UpstreamError)) throw cause;
      }
    }
    return page;
  }

  editions(releaseGroupMBID: string) {
    return this.#musicbrainz.editions(releaseGroupMBID);
  }
  identity(releaseGroupMBID: string, releaseMBID: string, artistMBID: string) {
    return this.#musicbrainz.identity(releaseGroupMBID, releaseMBID, artistMBID);
  }

  /**
   * Last.fm: artists similar to the user's recent top artists, resolved to
   * MusicBrainz release groups with one MusicBrainz query per artist.
   * Without Last.fm: recent official albums from MusicBrainz.
   */
  async recommendations(account: LastfmAccount | null): Promise<AlbumCandidate[]> {
    if (!account) {
      const year = new Date().getUTCFullYear();
      return (
        await this.#musicbrainz.releaseGroups(
          `primarytype:album AND status:official AND firstreleasedate:[${year - 1} TO ${year}]`,
        )
      ).items;
    }
    const artists: string[] = [];
    for (const seed of await this.#lastfm.topArtists(account, 3))
      for (const similar of await this.#lastfm.similarArtists(account.apiKey, seed, 2))
        if (!artists.some((known) => normalise(known) === normalise(similar))) artists.push(similar);
    const items: AlbumCandidate[] = [];
    for (const artist of artists.slice(0, 6)) {
      const top = await this.#lastfm.topAlbums(account.apiKey, { name: artist }, 4);
      const groups = await this.#musicbrainz.releaseGroups(
        `artist:(${luceneTerms(artist)}) AND primarytype:album`,
        0,
        50,
      );
      for (const album of top) {
        if (album.name === "(null)") continue;
        const match = groups.items.find(
          (candidate) =>
            normalise(candidate.title) === normalise(album.name) &&
            !items.some((known) => known.id === candidate.id),
        );
        if (match) items.push({ ...match, coverUrl: album.coverUrl });
      }
    }
    return items;
  }
}
