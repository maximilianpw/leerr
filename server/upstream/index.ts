import { UpstreamError } from "./errors.ts";
import { HttpClient, type Fetcher } from "./http.ts";
import {
  Plex,
  type AlbumDetail,
  type AlbumPage,
  type ArtistPage,
  type Artwork,
  type ArtworkSize,
  type LibraryContents,
  type LibraryQuery,
  type PlayableTrack,
  type PlexAccess,
  type PlexIdentity,
  type PlexSection,
  type Playlist,
  type PlaylistDetail,
  type TimelineReport,
} from "./plex.ts";
import { PlexTV, type PlexAccount, type PlexPin, type PlexProfile } from "./plextv.ts";
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
export { artworkSizes, librarySorts, ratingKey } from "./plex.ts";
export { pinExpired } from "./plextv.ts";
export { PartialReleaseLookup } from "./musicbrainz.ts";
export type * from "./plex.ts";
export type * from "./plextv.ts";
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
  plexIdentity(endpoint: string): Promise<PlexIdentity>;
  plexCreatePin(clientID: string, deviceName: string): Promise<PlexPin>;
  plexCheckPin(clientID: string, pinID: number): Promise<string | null>;
  plexAccount(clientID: string, accountToken: string): Promise<PlexAccount>;
  plexServerToken(clientID: string, accountToken: string, machineID: string): Promise<string | null>;
  plexProfiles(clientID: string, accountToken: string): Promise<PlexProfile[]>;
  plexSwitchProfile(clientID: string, accountToken: string, uuid: string, pin: string): Promise<string>;
  plexSignOut(clientID: string, accountToken: string): Promise<void>;
  plexPing(clientID: string, accountToken: string): Promise<void>;
  plexTokenValid(access: PlexAccess): Promise<boolean>;
  plexSections(access: PlexAccess): Promise<PlexSection[]>;
  plexLibrary(access: PlexAccess, query: LibraryQuery): Promise<AlbumPage>;
  plexArtists(access: PlexAccess, offset: number, limit: number, q: string): Promise<ArtistPage>;
  plexAlbum(access: PlexAccess, albumID: string): Promise<AlbumDetail>;
  plexLibraryIndex(access: PlexAccess): Promise<LibraryContents>;
  plexPlaylists(access: PlexAccess): Promise<Playlist[]>;
  plexPlaylist(access: PlexAccess, playlistID: string): Promise<PlaylistDetail>;
  plexAddToPlaylist(access: PlexAccess, playlistID: string, trackIDs: string[]): Promise<void>;
  plexFavorite(access: PlexAccess, itemID: string, favorite: boolean): Promise<void>;
  /** Returns Plex's reason when it ended playback (for example an administrator stopped it). */
  plexReport(access: PlexAccess, report: TimelineReport): Promise<string | null>;
  plexTrack(access: PlexAccess, trackID: string, signal?: AbortSignal): Promise<PlayableTrack>;
  plexArtwork(access: PlexAccess, itemID: string, size: ArtworkSize, signal?: AbortSignal): Promise<Artwork>;
  plexStream(access: PlexAccess, track: PlayableTrack, range: string | undefined, ifRange: string | undefined, signal: AbortSignal): Promise<Response>;
  plexTranscode(access: PlexAccess, track: PlayableTrack, offset: number, session: string, signal: AbortSignal): Promise<Response>;
  plexStopTranscode(access: PlexAccess, session: string): Promise<void>;

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
  /** Release → release group; unknown releases map to null, and ids over the call's budget are left out. */
  releaseGroupsOf(releaseMBIDs: string[]): Promise<Map<string, string | null>>;
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
  readonly #plex: Plex;
  readonly #plextv: PlexTV;
  readonly #lidarr: Lidarr;
  readonly #musicbrainz: MusicBrainz;
  readonly #lastfm: Lastfm;
  readonly #notifier: Notifier;

  constructor(fetcher: Fetcher = fetch) {
    const http = new HttpClient(fetcher);
    this.#plex = new Plex(http);
    this.#plextv = new PlexTV(http);
    this.#lidarr = new Lidarr(http);
    this.#musicbrainz = new MusicBrainz(http);
    this.#lastfm = new Lastfm(http);
    this.#notifier = new Notifier(http);
  }

  plexIdentity(endpoint: string) {
    return this.#plex.identity(endpoint);
  }
  plexCreatePin(clientID: string, deviceName: string) {
    return this.#plextv.createPin(clientID, deviceName);
  }
  plexCheckPin(clientID: string, pinID: number) {
    return this.#plextv.checkPin(clientID, pinID);
  }
  plexAccount(clientID: string, accountToken: string) {
    return this.#plextv.account(clientID, accountToken);
  }
  plexServerToken(clientID: string, accountToken: string, machineID: string) {
    return this.#plextv.serverToken(clientID, accountToken, machineID);
  }
  plexProfiles(clientID: string, accountToken: string) {
    return this.#plextv.managedProfiles(clientID, accountToken);
  }
  plexSwitchProfile(clientID: string, accountToken: string, uuid: string, pin: string) {
    return this.#plextv.switchProfile(clientID, accountToken, uuid, pin);
  }
  plexSignOut(clientID: string, accountToken: string) {
    return this.#plextv.signOut(clientID, accountToken);
  }
  plexPing(clientID: string, accountToken: string) {
    return this.#plextv.ping(clientID, accountToken);
  }
  plexTokenValid(access: PlexAccess) {
    return this.#plex.tokenValid(access);
  }
  plexSections(access: PlexAccess) {
    return this.#plex.sections(access);
  }
  plexLibrary(access: PlexAccess, query: LibraryQuery) {
    return this.#plex.library(access, query);
  }
  plexArtists(access: PlexAccess, offset: number, limit: number, q: string) {
    return this.#plex.artists(access, offset, limit, q);
  }
  plexAlbum(access: PlexAccess, albumID: string) {
    return this.#plex.album(access, albumID);
  }
  plexLibraryIndex(access: PlexAccess) {
    return this.#plex.libraryIndex(access);
  }
  plexPlaylists(access: PlexAccess) {
    return this.#plex.playlists(access);
  }
  plexPlaylist(access: PlexAccess, playlistID: string) {
    return this.#plex.playlist(access, playlistID);
  }
  plexAddToPlaylist(access: PlexAccess, playlistID: string, trackIDs: string[]) {
    return this.#plex.addToPlaylist(access, playlistID, trackIDs);
  }
  plexFavorite(access: PlexAccess, itemID: string, favorite: boolean) {
    return this.#plex.favorite(access, itemID, favorite);
  }
  plexReport(access: PlexAccess, report: TimelineReport) {
    return this.#plex.report(access, report);
  }
  plexTrack(access: PlexAccess, trackID: string, signal?: AbortSignal) {
    return this.#plex.track(access, trackID, signal);
  }
  plexArtwork(access: PlexAccess, itemID: string, size: ArtworkSize, signal?: AbortSignal) {
    return this.#plex.artwork(access, itemID, size, signal);
  }
  plexStream(access: PlexAccess, track: PlayableTrack, range: string | undefined, ifRange: string | undefined, signal: AbortSignal) {
    return this.#plex.stream(access, track, range, ifRange, signal);
  }
  plexTranscode(access: PlexAccess, track: PlayableTrack, offset: number, session: string, signal: AbortSignal) {
    return this.#plex.transcode(access, track, offset, session, signal);
  }
  plexStopTranscode(access: PlexAccess, session: string) {
    return this.#plex.stopTranscode(access, session);
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
  releaseGroupsOf(releaseMBIDs: string[]) {
    return this.#musicbrainz.releaseGroupsOf(releaseMBIDs);
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
