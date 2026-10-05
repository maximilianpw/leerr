import { UpstreamError } from "./errors.ts";
import { HttpClient, type Fetcher } from "./http.ts";
import {
  Jellyfin,
  type AlbumDetail,
  type AlbumPage,
  type ArtistPage,
  type Artwork,
  type ArtworkSize,
  type JellyfinAccess,
  type JellyfinAccount,
  type LibraryQuery,
  type PlaybackEvent,
  type Playlist,
  type PlaylistDetail,
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
  type LidarrDownload,
  type LidarrOptions,
  type LidarrProfile,
} from "./lidarr.ts";
import {
  luceneTerms,
  MusicBrainz,
  type AlbumCandidate,
  type ArtistMatch,
  type CandidatePage,
  type EditionList,
} from "./musicbrainz.ts";
import { Notifier, type Notification, type NotifyTarget } from "./notify.ts";

export { UpstreamError, validateEndpoint, type MutationOutcome } from "./errors.ts";
export { artworkSizes, librarySorts } from "./jellyfin.ts";
export type * from "./jellyfin.ts";
export type * from "./lastfm.ts";
export type * from "./lidarr.ts";
export type * from "./musicbrainz.ts";
export type * from "./notify.ts";

export type SearchResult = CandidatePage & { artists: ArtistMatch[] };
export const albumTypes = ["studio", "ep", "live", "compilation", "all"] as const;
export type AlbumType = (typeof albumTypes)[number];
/** Where suggestions start from: a Last.fm profile, the user's own library, or nothing personal. */
export type RecommendationSeed =
  | { source: "lastfm"; account: LastfmAccount }
  | { source: "library"; artists: string[]; apiKey: string }
  | { source: "musicbrainz" };

/** Every external service Leerr talks to. Tests substitute a fake implementation. */
export interface Upstreams {
  jellyfinVersion(endpoint: string): Promise<string>;
  jellyfinLogin(endpoint: string, username: string, password: string, deviceID: string): Promise<JellyfinAccount>;
  jellyfinTokenValid(access: JellyfinAccess): Promise<boolean>;
  jellyfinLibrary(access: JellyfinAccess, query: LibraryQuery): Promise<AlbumPage>;
  jellyfinArtists(access: JellyfinAccess, offset: number, limit: number, q: string): Promise<ArtistPage>;
  jellyfinAlbum(access: JellyfinAccess, albumID: string): Promise<AlbumDetail>;
  jellyfinPlaylists(access: JellyfinAccess): Promise<Playlist[]>;
  jellyfinPlaylist(access: JellyfinAccess, playlistID: string): Promise<PlaylistDetail>;
  jellyfinAddToPlaylist(access: JellyfinAccess, playlistID: string, trackIDs: string[]): Promise<void>;
  jellyfinFavorite(access: JellyfinAccess, itemID: string, favorite: boolean): Promise<void>;
  jellyfinReport(access: JellyfinAccess, event: PlaybackEvent, trackID: string, position: number, paused: boolean): Promise<void>;
  jellyfinTrack(access: JellyfinAccess, trackID: string): Promise<Track>;
  jellyfinArtwork(access: JellyfinAccess, itemID: string, size: ArtworkSize, signal?: AbortSignal): Promise<Artwork>;
  jellyfinStream(
    access: JellyfinAccess,
    trackID: string,
    range: string | undefined,
    ifRange: string | undefined,
    signal: AbortSignal,
  ): Promise<Response>;

  lidarrVersion(access: LidarrAccess): Promise<string>;
  lidarrOptions(access: LidarrAccess): Promise<LidarrOptions>;
  lidarrAlbum(access: LidarrAccess, releaseGroupMBID: string): Promise<LidarrAlbum | null>;
  lidarrLookup(access: LidarrAccess, identity: Identity, profile: LidarrProfile): Promise<LidarrCandidate>;
  lidarrCreate(access: LidarrAccess, candidate: LidarrCandidate): Promise<void>;
  lidarrMonitor(access: LidarrAccess, album: LidarrAlbum, releaseMBID: string): Promise<void>;
  lidarrLatestCommandID(access: LidarrAccess): Promise<number>;
  lidarrLatestSearch(access: LidarrAccess, albumID: number, after: number): Promise<LidarrCommand | null>;
  lidarrCommand(access: LidarrAccess, id: number): Promise<LidarrCommand | null>;
  lidarrRefreshing(access: LidarrAccess, album: LidarrAlbum): Promise<boolean>;
  lidarrDownloads(access: LidarrAccess, albumID: number): Promise<LidarrDownload[]>;
  lidarrSearch(access: LidarrAccess, albumID: number): Promise<number>;

  lastfmCheck(account: LastfmAccount): Promise<void>;
  lastfmCheckKey(apiKey: string): Promise<void>;
  search(query: string, lastfmKey: string | null): Promise<SearchResult>;
  artistAlbums(artistMBID: string, offset: number, type: AlbumType, lastfmKey: string | null): Promise<CandidatePage>;
  /** Studio albums by any of these artists first released on or after `since` (YYYY-MM-DD). */
  newReleases(artistMBIDs: string[], since: string): Promise<AlbumCandidate[]>;
  editions(releaseGroupMBID: string): Promise<EditionList>;
  identity(releaseGroupMBID: string, releaseMBID: string, artistMBID: string): Promise<Identity>;
  recommendations(seed: RecommendationSeed): Promise<AlbumCandidate[]>;

  notify(target: NotifyTarget, notification: Notification): Promise<void>;
}

/** MusicBrainz page size for artist discographies: its maximum, so one call covers most artists. */
export const ARTIST_PAGE = 100;
const NOT_STUDIO =
  'secondarytype:(compilation OR live OR remix OR interview OR demo OR soundtrack OR spokenword OR audiobook OR "dj-mix" OR "mixtape/street" OR "audio drama" OR "field recording")';
const artistQueries: Record<AlbumType, (artist: string) => string> = {
  studio: (artist) => `arid:${artist} AND primarytype:album AND NOT ${NOT_STUDIO}`,
  ep: (artist) => `arid:${artist} AND primarytype:ep`,
  live: (artist) => `arid:${artist} AND primarytype:album AND secondarytype:live`,
  compilation: (artist) => `arid:${artist} AND primarytype:album AND secondarytype:compilation`,
  all: (artist) => `arid:${artist} AND (primarytype:album OR primarytype:ep)`,
};
const byDate = (a: AlbumCandidate, b: AlbumCandidate) => (a.date ?? "9999").localeCompare(b.date ?? "9999");
const stripBrackets = (value: string) => value.replace(/\s*[([].*?[)\]]\s*/g, " ").trim();

const normalise = (value: string) =>
  stripBrackets(value.toLowerCase())
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
  readonly #notifier: Notifier;

  constructor(fetcher: Fetcher = fetch) {
    const http = new HttpClient(fetcher);
    this.#jellyfin = new Jellyfin(http);
    this.#lidarr = new Lidarr(http);
    this.#musicbrainz = new MusicBrainz(http);
    this.#lastfm = new Lastfm(http);
    this.#notifier = new Notifier(http);
  }

  jellyfinVersion(endpoint: string) {
    return this.#jellyfin.version(endpoint);
  }
  jellyfinLogin(endpoint: string, username: string, password: string, deviceID: string) {
    return this.#jellyfin.login(endpoint, username, password, deviceID);
  }
  jellyfinTokenValid(access: JellyfinAccess) {
    return this.#jellyfin.tokenValid(access);
  }
  jellyfinLibrary(access: JellyfinAccess, query: LibraryQuery) {
    return this.#jellyfin.library(access, query);
  }
  jellyfinArtists(access: JellyfinAccess, offset: number, limit: number, q: string) {
    return this.#jellyfin.artists(access, offset, limit, q);
  }
  jellyfinAlbum(access: JellyfinAccess, albumID: string) {
    return this.#jellyfin.album(access, albumID);
  }
  jellyfinPlaylists(access: JellyfinAccess) {
    return this.#jellyfin.playlists(access);
  }
  jellyfinPlaylist(access: JellyfinAccess, playlistID: string) {
    return this.#jellyfin.playlist(access, playlistID);
  }
  jellyfinAddToPlaylist(access: JellyfinAccess, playlistID: string, trackIDs: string[]) {
    return this.#jellyfin.addToPlaylist(access, playlistID, trackIDs);
  }
  jellyfinFavorite(access: JellyfinAccess, itemID: string, favorite: boolean) {
    return this.#jellyfin.favorite(access, itemID, favorite);
  }
  jellyfinReport(access: JellyfinAccess, event: PlaybackEvent, trackID: string, position: number, paused: boolean) {
    return this.#jellyfin.report(access, event, trackID, position, paused);
  }
  jellyfinTrack(access: JellyfinAccess, trackID: string) {
    return this.#jellyfin.track(access, trackID);
  }
  jellyfinArtwork(access: JellyfinAccess, itemID: string, size: ArtworkSize, signal?: AbortSignal) {
    return this.#jellyfin.artwork(access, itemID, size, signal);
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

  lidarrVersion(access: LidarrAccess) {
    return this.#lidarr.version(access);
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
  lidarrCommand(access: LidarrAccess, id: number) {
    return this.#lidarr.command(access, id);
  }
  lidarrRefreshing(access: LidarrAccess, album: LidarrAlbum) {
    return this.#lidarr.refreshing(access, album);
  }
  lidarrDownloads(access: LidarrAccess, albumID: number) {
    return this.#lidarr.downloads(access, albumID);
  }
  lidarrSearch(access: LidarrAccess, albumID: number) {
    return this.#lidarr.search(access, albumID);
  }

  lastfmCheck(account: LastfmAccount) {
    return this.#lastfm.checkUser(account);
  }
  lastfmCheckKey(apiKey: string) {
    return this.#lastfm.checkKey(apiKey);
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

  async artistAlbums(artistMBID: string, offset: number, type: AlbumType, lastfmKey: string | null): Promise<CandidatePage> {
    const page = await this.#musicbrainz.releaseGroups(artistQueries[type](artistMBID), offset, ARTIST_PAGE);
    // MusicBrainz search cannot sort, so the page is put in release order here.
    page.items.sort(byDate);
    if (lastfmKey && page.items.length) {
      try {
        withCovers(page.items, await this.#lastfm.topAlbums(lastfmKey, { mbid: artistMBID }, 100), false);
      } catch (cause) {
        if (!(cause instanceof UpstreamError)) throw cause;
      }
    }
    return page;
  }

  async newReleases(artistMBIDs: string[], since: string): Promise<AlbumCandidate[]> {
    if (!artistMBIDs.length) return [];
    const artists = artistMBIDs.map((id) => `arid:${id}`).join(" OR ");
    const page = await this.#musicbrainz.releaseGroups(
      `(${artists}) AND primarytype:album AND NOT ${NOT_STUDIO} AND firstreleasedate:[${since} TO *]`,
      0,
      50,
    );
    return page.items.sort(byDate).reverse();
  }

  editions(releaseGroupMBID: string) {
    return this.#musicbrainz.editions(releaseGroupMBID);
  }
  identity(releaseGroupMBID: string, releaseMBID: string, artistMBID: string) {
    return this.#musicbrainz.identity(releaseGroupMBID, releaseMBID, artistMBID);
  }

  /**
   * Artists similar to the seed artists (the user's Last.fm favourites, or the
   * album artists they own most), resolved to MusicBrainz release groups with
   * one MusicBrainz query per artist. With no seed: recent official albums.
   * One artist failing does not lose the others' suggestions.
   */
  async recommendations(seed: RecommendationSeed): Promise<AlbumCandidate[]> {
    if (seed.source === "musicbrainz") {
      const year = new Date().getUTCFullYear();
      return (
        await this.#musicbrainz.releaseGroups(
          `primarytype:album AND status:official AND firstreleasedate:[${year - 1} TO ${year}]`,
        )
      ).items;
    }
    const apiKey = seed.source === "lastfm" ? seed.account.apiKey : seed.apiKey;
    const seeds = seed.source === "lastfm" ? await this.#lastfm.topArtists(seed.account, 3) : seed.artists.slice(0, 3);
    const known = new Set(seeds.map(normalise));
    let firstError: UpstreamError | null = null;
    const artists: string[] = [];
    for (const name of seeds)
      try {
        for (const similar of await this.#lastfm.similarArtists(apiKey, name, 2))
          if (!known.has(normalise(similar))) {
            known.add(normalise(similar));
            artists.push(similar);
          }
      } catch (cause) {
        if (!(cause instanceof UpstreamError)) throw cause;
        firstError ??= cause;
      }
    const items: AlbumCandidate[] = [];
    for (const artist of artists.slice(0, 6))
      try {
        const top = (await this.#lastfm.topAlbums(apiKey, { name: artist }, 4)).flatMap((album) =>
          album.name !== "(null)" && stripBrackets(album.name) ? [album] : [],
        );
        if (!top.length) continue;
        // Constrained to Last.fm's titles: an unconstrained query returns an arbitrary slice for prolific artists.
        const titles = top.map((album) => `releasegroup:(${luceneTerms(stripBrackets(album.name))})`).join(" OR ");
        const groups = await this.#musicbrainz.releaseGroups(
          `artist:(${luceneTerms(artist)}) AND primarytype:album AND (${titles}) AND (status:official^5 OR primarytype:album)`,
          0,
          100,
        );
        for (const album of top) {
          const matches = groups.items.filter(
            (candidate) => normalise(candidate.title) === normalise(album.name) && !items.some((taken) => taken.id === candidate.id),
          );
          const match = matches.find((candidate) => normalise(candidate.artist).includes(normalise(artist))) ?? matches[0];
          if (match) items.push({ ...match, coverUrl: album.coverUrl });
        }
      } catch (cause) {
        if (!(cause instanceof UpstreamError)) throw cause;
        firstError ??= cause;
      }
    if (!items.length && firstError) throw firstError;
    return items;
  }

  notify(target: NotifyTarget, notification: Notification) {
    return this.#notifier.send(target, notification);
  }
}
