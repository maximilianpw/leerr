import { z } from "zod";
import { endpointURL, UpstreamError } from "./errors.ts";
import { HttpClient, parseBody, parseJson, statusError, type JsonValue } from "./http.ts";

/** One person's way into the household Plex Media Server. */
export type PlexAccess = {
  endpoint: string;
  /** The person's token for this server (from plex.tv resources), never their plex.tv account token. */
  token: string;
  /** Leerr's per-person X-Plex-Client-Identifier. */
  clientID: string;
  machineID: string;
  /** The music library to browse; null picks the server's Plex Music library. */
  section: string | null;
  /** X-Plex-Session-Identifier, so each browser shows as its own player in Plex. */
  session?: string;
};

export type Album = {
  id: string;
  title: string;
  artist: string;
  /** Plex's album-artist item, for browsing an artist's albums. */
  artistID: string | null;
  artistMBID: string | null;
  year: number | null;
  /** Known once Leerr has looked the release up on MusicBrainz. */
  releaseGroupMBID: string | null;
  /** The edition Plex matched (its mbid:// guid is a MusicBrainz release, not a release group). */
  releaseMBID: string | null;
  hasArtwork: boolean;
  /** Plex's own definition, shared with Plexamp and Plex Web: a five-star rating. */
  favorite: boolean;
  /** False for albums in Plex's trash: their files are gone, so they cannot play. */
  available: boolean;
};
export type AlbumPage = { items: Album[]; total: number };
export type Track = {
  id: string;
  title: string;
  artist: string;
  albumID: string | null;
  albumTitle: string | null;
  disc: number | null;
  number: number | null;
  duration: number | null;
  codec: string | null;
  sampleRate: number | null;
  bitDepth: number | null;
  favorite: boolean;
  /** False for tracks in Plex's trash. */
  available: boolean;
};
/** What streaming needs: the file, and whether browsers can play it as it is. */
export type PlayableTrack = Track & { partKey: string; transcode: boolean; durationMs: number | null };
export type AlbumDetail = { album: Album; tracks: Track[] };
export type Artist = { id: string; name: string; hasArtwork: boolean };
export type ArtistPage = { items: Artist[]; total: number };
export type Playlist = {
  id: string;
  name: string;
  tracks: number | null;
  duration: number | null;
  hasArtwork: boolean;
  /** Smart playlists fill themselves from rules; tracks cannot be added to them. */
  smart: boolean;
};
export type PlaylistDetail = { playlist: Playlist; tracks: Track[] };
export type Artwork = { type: string; bytes: Uint8Array };
export type PlexIdentity = { machineID: string; version: string; claimed: boolean };
export type PlexSection = { key: string; title: string; agent: string; scanner: string };
/** One album as the availability index needs it. */
export type IndexedAlbum = { id: string; title: string; artist: string; artistID: string | null; releaseMBID: string | null };
export type LibraryContents = { albums: IndexedAlbum[]; artistMBIDs: Map<string, string> };
export type TimelineState = "playing" | "paused" | "stopped";
export type TimelineReport = { trackID: string; state: TimelineState; position: number; durationMs: number };
export const librarySorts = ["title", "artist", "year", "added"] as const;
export type LibrarySort = (typeof librarySorts)[number];
export type LibraryQuery = {
  offset: number;
  limit: number;
  q: string;
  sort: LibrarySort;
  artistID: string | null;
  favorites: boolean;
};
export const artworkSizes = ["small", "medium", "large"] as const;
export type ArtworkSize = (typeof artworkSizes)[number];
export type PlaybackEvent = "start" | "progress" | "stop";

const SERVICE = "Plex";
export const PLEX_PRODUCT = "Leerr";
export const PLEX_VERSION = "0.3.0";
/** Plex Web's own definition of a favourite. */
const FAVORITE = 10;
const INDEX_PAGE = 300;
const MAX_ALBUMS = 50_000;
const MAX_TRACKS = 5_000;
const TRACK_PAGE = 200;
const METADATA_BATCH = 100;
// Keys travel in the request line, which Plex caps at 32 KiB.
const PLAYLIST_BATCH = 100;
const SECTION_TTL = 10 * 60_000;
const PAGE_BYTES = 8_000_000;
const pixels: Record<ArtworkSize, number> = { small: 192, medium: 512, large: 1024 };
const sortParameters: Record<LibrarySort, string> = {
  title: "titleSort",
  artist: "artist.titleSort,album.titleSort,album.index,album.id,album.originallyAvailableAt",
  year: "year:desc",
  added: "addedAt:desc",
};
/** Codecs every current browser plays from the original file; anything else is converted to MP3. */
const browserCodecs = new Set(["flac", "mp3", "aac", "opus", "vorbis", "pcm"]);
/** Plex calls WAV and AIFF audio both "pcm"; only WAV plays outside Safari. */
function mustConvert(codec: string | undefined, format: string | undefined): boolean {
  const audio = (codec ?? "").toLowerCase();
  return !browserCodecs.has(audio) || (audio === "pcm" && (format ?? "").toLowerCase() !== "wav");
}
const imageTypes = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "image/avif"]);
/** Plex Web's request for a single progressive MP3, which a plain <audio> element can play. */
const MP3_PROFILE =
  "add-transcode-target(type=musicProfile&context=streaming&protocol=http&container=mp3&audioCodec=mp3&replace=true)";

/** Plex ratingKeys are decimal; anything else must never reach a URL path. */
export const ratingKey = z.string().regex(/^\d{1,12}$/);
const partKey = /^\/library\/parts\/\d+\/\d+\/file\.[A-Za-z0-9]{1,8}$/;
const artworkPath = /^\/(library\/metadata|playlists)\/\d+\/(thumb|art|composite)\/\d+$/;
const mbidURI = /^mbid:\/\/(\S+)$/i;
/** The same check MusicBrainz ids get everywhere else, so an odd file tag counts as unmatched rather than failing later. */
const musicbrainzID = z.string().uuid();

const stream = z
  .object({
    streamType: z.number().optional(),
    codec: z.string().optional(),
    bitDepth: z.number().int().nonnegative().optional(),
    samplingRate: z.number().nonnegative().optional(),
  })
  .loose();
const part = z.object({ key: z.string().optional(), Stream: z.array(stream).optional() }).loose();
const media = z
  .object({
    audioCodec: z.string().optional(),
    container: z.string().optional(),
    duration: z.number().nonnegative().optional(),
    Part: z.array(part).optional(),
  })
  .loose();
const metadata = z
  .object({
    ratingKey,
    type: z.string(),
    title: z.string().default(""),
    parentTitle: z.string().optional(),
    grandparentTitle: z.string().optional(),
    originalTitle: z.string().optional(),
    parentRatingKey: ratingKey.optional(),
    index: z.number().int().optional(),
    parentIndex: z.number().int().optional(),
    year: z.number().int().optional(),
    duration: z.number().nonnegative().optional(),
    userRating: z.number().optional(),
    thumb: z.string().optional(),
    parentThumb: z.string().optional(),
    composite: z.string().optional(),
    guid: z.string().optional(),
    Guid: z.array(z.object({ id: z.string() }).loose()).optional(),
    leafCount: z.number().int().nonnegative().optional(),
    smart: z.boolean().optional(),
    playlistType: z.string().optional(),
    deletedAt: z.number().optional(),
    Media: z.array(media).optional(),
  })
  .loose();
type Metadata = z.infer<typeof metadata>;
const directory = z
  .object({ key: z.string(), type: z.string(), title: z.string().default(""), agent: z.string().default(""), scanner: z.string().default("") })
  .loose();
const container = z
  .object({
    MediaContainer: z
      .object({
        size: z.number().int().nonnegative().optional(),
        totalSize: z.number().int().nonnegative().optional(),
        Metadata: z.array(metadata).optional(),
        Directory: z.array(directory).optional(),
        terminationCode: z.number().optional(),
        terminationText: z.string().optional(),
      })
      .loose(),
  })
  .loose();

/** The MusicBrainz id Plex attached: Guid[] when Plex matched the item, or the primary guid from file tags. */
function mbidOf(value: Metadata): string | null {
  for (const id of [...(value.Guid ?? []).map((guid) => guid.id), value.guid ?? ""]) {
    const parsed = musicbrainzID.safeParse(mbidURI.exec(id)?.[1]);
    if (parsed.success) return parsed.data.toLowerCase();
  }
  return null;
}
const seconds = (milliseconds: number | undefined) => (milliseconds === undefined ? null : milliseconds / 1000);
function audioStream(value: Metadata) {
  return value.Media?.[0]?.Part?.[0]?.Stream?.find((entry) => entry.streamType === 2);
}
function toAlbum(value: Metadata): Album {
  return {
    id: value.ratingKey,
    title: value.title,
    artist: value.parentTitle ?? "",
    artistID: value.parentRatingKey ?? null,
    artistMBID: null,
    year: value.year ?? null,
    releaseGroupMBID: null,
    releaseMBID: mbidOf(value),
    hasArtwork: !!value.thumb,
    favorite: value.userRating === FAVORITE,
    available: !value.deletedAt,
  };
}
function toTrack(value: Metadata, details: Metadata | undefined = value): Track {
  const audio = audioStream(details);
  const media = value.Media?.[0];
  return {
    id: value.ratingKey,
    title: value.title,
    // Plex leaves the track artist out when it is the album artist.
    artist: value.originalTitle ?? value.grandparentTitle ?? "",
    albumID: value.parentRatingKey ?? null,
    albumTitle: value.parentTitle ?? null,
    disc: value.parentIndex ?? null,
    number: value.index ?? null,
    duration: seconds(value.duration ?? media?.duration),
    codec: media?.audioCodec ?? audio?.codec ?? null,
    sampleRate: audio?.samplingRate ?? null,
    bitDepth: audio?.bitDepth ?? null,
    favorite: value.userRating === FAVORITE,
    available: !value.deletedAt,
  };
}
function toPlaylist(value: Metadata): Playlist {
  return {
    id: value.ratingKey,
    name: value.title,
    tracks: value.leafCount ?? null,
    duration: seconds(value.duration),
    hasArtwork: !!(value.thumb || value.composite),
    smart: value.smart === true,
  };
}

/** The person's saved Plex sign-in no longer works for this server: only signing in again can fix it. */
export const reconnectError = () =>
  new UpstreamError(
    "plex_reconnect",
    409,
    "Plex no longer accepts your saved sign-in for this server (for example after it was signed out or the share ended). Sign in to Plex again in Settings → Connections.",
    "not_applied",
  );
const notFound = (message = "Plex has no such item, or your account cannot see it.") =>
  new UpstreamError("upstream_rejected", 404, message, "not_applied");
function userStatusError(status: number): UpstreamError {
  if (status === 401) return reconnectError();
  if (status === 403)
    return new UpstreamError("upstream_rejected", 403, "Your Plex account is not allowed to do this on this server.", "not_applied");
  // Plex answers 404 both for missing items and for items this account may not see.
  if (status === 404) return notFound();
  return statusError(status, SERVICE);
}
const ignoredFilter = (name: string) =>
  new UpstreamError("upstream_protocol", 502, `Plex ignored the ${name} filter, so Leerr cannot show this list correctly.`);

export class Plex {
  readonly #http: HttpClient;
  readonly #now: () => number;
  /** The music library picked for each person, when no administrator chose one. */
  readonly #sections = new Map<string, { key: string; expiresAt: number }>();
  constructor(http: HttpClient, now: () => number = Date.now) {
    this.#http = http;
    this.#now = now;
  }

  #headers(access: PlexAccess, accept = "application/json"): Headers {
    const headers = new Headers({
      Accept: accept,
      "X-Plex-Token": access.token,
      "X-Plex-Client-Identifier": access.clientID,
      "X-Plex-Product": PLEX_PRODUCT,
      "X-Plex-Version": PLEX_VERSION,
      "X-Plex-Platform": "Generic",
      "X-Plex-Device-Name": PLEX_PRODUCT,
    });
    if (access.session) headers.set("X-Plex-Session-Identifier", access.session);
    return headers;
  }
  #url(access: PlexAccess, path: string, parameters: Record<string, string> | URLSearchParams = {}): URL {
    const url = endpointURL(access.endpoint, path);
    for (const [key, value] of new URLSearchParams(parameters)) url.searchParams.set(key, value);
    return url;
  }
  /** Status first: Plex error bodies are HTML even when JSON was asked for. */
  async #json(access: PlexAccess, url: URL, options: { signal?: AbortSignal; start?: number; size?: number } = {}): Promise<JsonValue> {
    const headers = this.#headers(access);
    if (options.start !== undefined && options.size !== undefined) {
      headers.set("X-Plex-Container-Start", String(options.start));
      headers.set("X-Plex-Container-Size", String(options.size));
    }
    const response = await this.#http.binary(url, { headers }, { service: SERVICE, signal: options.signal, maxBytes: PAGE_BYTES });
    if (response.status < 200 || response.status > 299) throw userStatusError(response.status);
    return parseJson(response.bytes, SERVICE);
  }
  async #container(access: PlexAccess, url: URL, options: { signal?: AbortSignal; start?: number; size?: number } = {}) {
    return parseBody(container, await this.#json(access, url, options), SERVICE).MediaContainer;
  }
  async #write(access: PlexAccess, url: URL, method: "PUT" | "POST" | "DELETE"): Promise<void> {
    const status = await this.#http.empty(url, { method, headers: this.#headers(access) }, { service: SERVICE });
    if (status < 200 || status > 299) throw userStatusError(status);
  }
  /** One page of a listing, with Plex's total (falling back to what came back, as Plex sometimes omits it). */
  async #page(access: PlexAccess, url: URL, offset: number, limit: number) {
    const result = await this.#container(access, url, { start: offset, size: limit });
    const items = result.Metadata ?? [];
    return { items, total: result.totalSize ?? offset + items.length };
  }
  /** Every item of a listing, advancing by what Plex returned rather than what was asked for. */
  async #all(access: PlexAccess, url: (offset: number) => URL, pageSize: number, limit: number, what: string): Promise<Metadata[]> {
    const items: Metadata[] = [];
    for (let offset = 0; offset < limit; ) {
      const page = await this.#page(access, url(offset), offset, pageSize);
      items.push(...page.items);
      offset += page.items.length;
      if (!page.items.length || offset >= page.total) return items;
    }
    throw new UpstreamError("upstream_protocol", 502, `Too many ${what}.`);
  }
  async #metadata(access: PlexAccess, id: string, signal?: AbortSignal): Promise<Metadata> {
    const value = (await this.#container(access, this.#url(access, `library/metadata/${ratingKey.parse(id)}`), { signal })).Metadata?.[0];
    if (!value || value.ratingKey !== id) throw notFound();
    return value;
  }

  /** The server's identity, from its unauthenticated /identity endpoint. */
  async identity(endpoint: string): Promise<PlexIdentity> {
    const body = parseBody(
      z.object({ MediaContainer: z.object({ machineIdentifier: z.string().min(1).max(200), version: z.string(), claimed: z.boolean().default(false) }).loose() }).loose(),
      await this.#http.json(endpointURL(endpoint, "identity"), { headers: { Accept: "application/json" } }, { service: SERVICE }),
      SERVICE,
    ).MediaContainer;
    return { machineID: body.machineIdentifier, version: body.version, claimed: body.claimed };
  }

  /** Whether the saved token still works on this server. Other failures (e.g. Plex is down) throw. */
  async tokenValid(access: PlexAccess): Promise<boolean> {
    try {
      await this.#container(access, this.#url(access, "library/sections/all"));
      return true;
    } catch (cause) {
      if (cause instanceof UpstreamError && cause.code === "plex_reconnect") return false;
      throw cause;
    }
  }

  /** The music libraries this person can see. */
  async sections(access: PlexAccess): Promise<PlexSection[]> {
    const result = await this.#container(access, this.#url(access, "library/sections/all"));
    return (result.Directory ?? []).flatMap((entry) =>
      entry.type === "artist" ? [{ key: entry.key, title: entry.title, agent: entry.agent, scanner: entry.scanner }] : [],
    );
  }
  async #section(access: PlexAccess): Promise<string> {
    if (access.section) return ratingKey.parse(access.section);
    const cacheKey = `${access.endpoint}\0${access.token}`;
    const cached = this.#sections.get(cacheKey);
    if (cached && cached.expiresAt > this.#now()) return cached.key;
    const sections = await this.sections(access);
    // Audiobook libraries are "artist" libraries too; the Plex Music agent marks real music.
    const music = sections.find((entry) => entry.agent === "tv.plex.agents.music") ?? sections[0];
    if (!music) throw notFound("Your Plex account cannot see a music library on this server.");
    this.#sections.set(cacheKey, { key: ratingKey.parse(music.key), expiresAt: this.#now() + SECTION_TTL });
    return music.key;
  }

  /**
   * Runs `work` against the person's music library. Plex gives a re-created
   * library a new key, so a pinned one that is gone gets an error that says so.
   */
  async #inSection<T>(access: PlexAccess, work: (section: string) => Promise<T>): Promise<T> {
    const section = await this.#section(access);
    try {
      return await work(section);
    } catch (cause) {
      if (!access.section || !(cause instanceof UpstreamError) || cause.status !== 404) throw cause;
      throw notFound("The music library chosen in Settings → Server is no longer on this Plex server, or this Plex account cannot see it.");
    }
  }

  async library(access: PlexAccess, query: LibraryQuery): Promise<AlbumPage> {
    if (!Number.isInteger(query.offset) || query.offset < 0 || !Number.isInteger(query.limit) || query.limit < 1 || query.limit > 500)
      throw new RangeError("Library pages must use 0 <= offset and 1..500 items.");
    const parameters = new URLSearchParams({ type: "9", sort: sortParameters[query.sort], includeGuids: "1", excludeFields: "summary" });
    if (query.q) parameters.set("title", query.q);
    if (query.artistID) parameters.set("artist.id", ratingKey.parse(query.artistID));
    if (query.favorites) parameters.set("userRating", String(FAVORITE));
    const page = await this.#inSection(access, (section) =>
      this.#page(access, this.#url(access, `library/sections/${section}/all`, parameters), query.offset, query.limit),
    );
    // Plex answers an unknown filter with the whole library; a wrong list must never pass as the right one.
    if (query.artistID && page.items.some((item) => item.parentRatingKey !== query.artistID)) throw ignoredFilter("artist");
    if (query.favorites && page.items.some((item) => item.userRating !== FAVORITE)) throw ignoredFilter("favourites");
    return { items: page.items.flatMap((item) => (item.type === "album" ? [toAlbum(item)] : [])), total: page.total };
  }

  async artists(access: PlexAccess, offset: number, limit: number, q: string): Promise<ArtistPage> {
    const parameters = new URLSearchParams({ type: "8", sort: "titleSort", excludeFields: "summary" });
    if (q) parameters.set("title", q);
    const page = await this.#inSection(access, (section) =>
      this.#page(access, this.#url(access, `library/sections/${section}/all`, parameters), offset, limit),
    );
    // Plex matches artist names word by word ("tyler the creator" finds "Tyler, The Creator"), so its list is kept as it is.
    return {
      items: page.items.flatMap((item) => (item.type === "artist" ? [{ id: item.ratingKey, name: item.title, hasArtwork: !!item.thumb }] : [])),
      total: page.total,
    };
  }

  /** Bit depth and sample rate are only in full metadata, which Plex returns for many items at once. */
  async #details(access: PlexAccess, ids: string[]): Promise<Map<string, Metadata>> {
    const details = new Map<string, Metadata>();
    for (let start = 0; start < ids.length; start += METADATA_BATCH) {
      const batch = ids.slice(start, start + METADATA_BATCH).map((id) => ratingKey.parse(id));
      const result = await this.#container(access, this.#url(access, `library/metadata/${batch.join(",")}`));
      for (const item of result.Metadata ?? []) details.set(item.ratingKey, item);
    }
    return details;
  }

  async album(access: PlexAccess, albumID: string): Promise<AlbumDetail> {
    const album = await this.#metadata(access, albumID);
    if (album.type !== "album") throw notFound("This item is not an album.");
    const tracks = (
      await this.#all(access, () => this.#url(access, `library/metadata/${albumID}/children`, { includeGuids: "1" }), TRACK_PAGE, MAX_TRACKS, "tracks")
    ).filter((item) => item.type === "track");
    const details = await this.#details(access, tracks.map((track) => track.ratingKey));
    let artistMBID: string | null = null;
    if (album.parentRatingKey)
      try {
        artistMBID = mbidOf(await this.#metadata(access, album.parentRatingKey));
      } catch (cause) {
        // Only the "more by this artist" link needs it.
        if (!(cause instanceof UpstreamError)) throw cause;
      }
    return {
      album: { ...toAlbum(album), artistMBID },
      tracks: tracks.map((track) => toTrack(track, details.get(track.ratingKey) ?? track)),
    };
  }

  /** Every album with its MusicBrainz release, and every artist's MusicBrainz id, for availability checks. */
  async libraryIndex(access: PlexAccess): Promise<LibraryContents> {
    const { albums, artists } = await this.#inSection(access, async (section) => {
      const listing = (type: string) => (_offset: number) =>
        this.#url(access, `library/sections/${section}/all`, { type, includeGuids: "1", excludeFields: "summary" });
      return {
        albums: await this.#all(access, listing("9"), INDEX_PAGE, MAX_ALBUMS, "albums"),
        artists: await this.#all(access, listing("8"), INDEX_PAGE, MAX_ALBUMS, "artists"),
      };
    });
    const artistMBIDs = new Map<string, string>();
    for (const artist of artists) {
      const id = mbidOf(artist);
      if (id) artistMBIDs.set(artist.ratingKey, id);
    }
    return {
      // Albums in Plex's trash cannot be played, so they do not count as having arrived.
      albums: albums.flatMap((album) =>
        album.type === "album" && !album.deletedAt
          ? [
              {
                id: album.ratingKey,
                title: album.title,
                artist: album.parentTitle ?? "",
                artistID: album.parentRatingKey ?? null,
                releaseMBID: mbidOf(album),
              },
            ]
          : [],
      ),
      artistMBIDs,
    };
  }

  async playlists(access: PlexAccess): Promise<Playlist[]> {
    const items = await this.#all(access, () => this.#url(access, "playlists", { playlistType: "audio" }), 500, 2_000, "playlists");
    return items.flatMap((item) => (item.type === "playlist" ? [toPlaylist(item)] : []));
  }
  async #playlist(access: PlexAccess, playlistID: string): Promise<Metadata> {
    const value = (await this.#container(access, this.#url(access, `playlists/${ratingKey.parse(playlistID)}`))).Metadata?.[0];
    if (!value || value.ratingKey !== playlistID || value.type !== "playlist" || value.playlistType !== "audio")
      throw notFound("This item is not a music playlist.");
    return value;
  }
  async playlist(access: PlexAccess, playlistID: string): Promise<PlaylistDetail> {
    const playlist = await this.#playlist(access, playlistID);
    const items = await this.#all(access, () => this.#url(access, `playlists/${playlistID}/items`), TRACK_PAGE, MAX_TRACKS, "tracks");
    return { playlist: toPlaylist(playlist), tracks: items.flatMap((item) => (item.type === "track" ? [toTrack(item)] : [])) };
  }
  async addToPlaylist(access: PlexAccess, playlistID: string, trackIDs: string[]): Promise<void> {
    const before = await this.#playlist(access, playlistID);
    // On a smart playlist the same call would replace its rules.
    if (before.smart)
      throw new UpstreamError("upstream_rejected", 409, "Smart playlists fill themselves in Plex. Choose a regular playlist.", "not_applied");
    for (let start = 0; start < trackIDs.length; start += PLAYLIST_BATCH) {
      const keys = trackIDs.slice(start, start + PLAYLIST_BATCH).map((id) => ratingKey.parse(id));
      await this.#write(
        access,
        this.#url(access, `playlists/${playlistID}/items`, {
          uri: `server://${access.machineID}/com.plexapp.plugins.library/library/metadata/${keys.join(",")}`,
        }),
        "PUT",
      );
    }
    // Plex drops tracks it cannot resolve and still answers 200.
    const added = ((await this.#playlist(access, playlistID)).leafCount ?? 0) - (before.leafCount ?? 0);
    if (added < trackIDs.length)
      throw new UpstreamError(
        "upstream_rejected",
        422,
        `Plex added ${Math.max(0, added)} of ${trackIDs.length} tracks. The others may no longer be in the library.`,
        "not_applied",
      );
  }

  /** A favourite is a five-star rating; removing it never erases a rating that was not a favourite. */
  async favorite(access: PlexAccess, itemID: string, favorite: boolean): Promise<void> {
    const item = await this.#metadata(access, itemID);
    if (!favorite && item.userRating !== FAVORITE) return;
    await this.#write(
      access,
      this.#url(access, ":/rate", { key: itemID, identifier: "com.plexapp.plugins.library", rating: favorite ? String(FAVORITE) : "-1" }),
      "PUT",
    );
  }

  /** Tells Plex what plays, for "now playing", play counts and history. Returns why Plex ended playback, if it did. */
  async report(access: PlexAccess, report: TimelineReport): Promise<string | null> {
    const id = ratingKey.parse(report.trackID);
    // Plex rejects a position past the end, and ignores 0.
    const time = Math.max(1, Math.min(Math.round(report.position * 1000), report.durationMs || Number.MAX_SAFE_INTEGER));
    const parameters = new URLSearchParams({ ratingKey: id, key: `/library/metadata/${id}`, state: report.state, time: String(time) });
    if (report.durationMs) parameters.set("duration", String(Math.round(report.durationMs)));
    const response = await this.#http.binary(
      this.#url(access, ":/timeline", parameters),
      { headers: this.#headers(access) },
      { service: SERVICE, maxBytes: 100_000 },
    );
    if (response.status < 200 || response.status > 299) throw userStatusError(response.status);
    if (!response.bytes.length) return null;
    const parsed = container.safeParse(parseJson(response.bytes, SERVICE));
    const result = parsed.success ? parsed.data.MediaContainer : null;
    return result?.terminationCode !== undefined ? (result.terminationText ?? "Plex ended playback.") : null;
  }

  /** A person-scoped lookup: succeeding proves this account may play the track. */
  async track(access: PlexAccess, trackID: string, signal?: AbortSignal): Promise<PlayableTrack> {
    const value = await this.#metadata(access, trackID, signal);
    if (value.type !== "track") throw notFound("This item is not a track.");
    if (value.deletedAt) throw notFound("This track is in Plex's trash: its file is gone.");
    const media = value.Media?.[0];
    const key = media?.Part?.[0]?.key;
    if (!key || !partKey.test(key)) throw notFound("Plex has no playable file for this track.");
    const track = toTrack(value);
    return {
      ...track,
      partKey: key,
      transcode: mustConvert(media?.audioCodec, media?.container),
      durationMs: value.duration ?? media?.duration ?? null,
    };
  }

  /** A bounded-size image of any album, artist, track or playlist the person can see. */
  async artwork(access: PlexAccess, itemID: string, size: ArtworkSize, signal?: AbortSignal): Promise<Artwork> {
    let item: Metadata;
    try {
      item = await this.#metadata(access, itemID, signal);
    } catch (cause) {
      if (!(cause instanceof UpstreamError && cause.status === 404)) throw cause;
      item = await this.#playlist(access, itemID);
    }
    const path = item.thumb ?? item.composite ?? (item.type === "track" ? item.parentThumb : undefined);
    // Plex fetches any URL it is given here, so only its own image paths are passed on.
    if (!path || !artworkPath.test(path)) throw notFound("This item has no artwork.");
    const box = String(pixels[size]);
    const image = await this.#http.binary(
      this.#url(access, "photo/:/transcode", { width: box, height: box, minSize: "0", upscale: "0", url: path }),
      { headers: this.#headers(access, "image/jpeg,image/png;q=0.9,*/*;q=0.5") },
      { service: SERVICE, signal, maxBytes: 5_000_000 },
    );
    if (image.status === 404) throw notFound("This item has no artwork.");
    if (image.status < 200 || image.status > 299) throw userStatusError(image.status);
    if (!imageTypes.has(image.type)) throw new UpstreamError("upstream_protocol", 502, "Plex artwork is not an image.");
    return { type: image.type, bytes: image.bytes };
  }

  /** The original file, with Range passed through. The body streams to the caller; `signal` cancels it. */
  async stream(access: PlexAccess, track: PlayableTrack, range: string | undefined, ifRange: string | undefined, signal: AbortSignal): Promise<Response> {
    if (!partKey.test(track.partKey)) throw notFound("Plex has no playable file for this track.");
    const headers = this.#headers(access, "*/*");
    headers.set("Accept-Encoding", "identity");
    if (range) headers.set("Range", range);
    if (range && ifRange) headers.set("If-Range", ifRange);
    const response = await this.#http.open(endpointURL(access.endpoint, track.partKey.slice(1)), { headers }, { service: SERVICE, signal, timeoutMs: 15_000 });
    const encoding = response.headers.get("content-encoding");
    if (encoding && encoding !== "identity") {
      await response.body?.cancel();
      throw new UpstreamError("upstream_protocol", 502, "Plex compressed the audio stream.");
    }
    if (response.status === 416) return response;
    if (response.status !== 200 && response.status !== 206) {
      await response.body?.cancel();
      throw userStatusError(response.status);
    }
    return response;
  }

  /**
   * The track converted to one progressive MP3 by Plex, starting `offset`
   * seconds in. It cannot be ranged: seeking starts a new conversion.
   */
  async transcode(access: PlexAccess, track: PlayableTrack, offset: number, session: string, signal: AbortSignal): Promise<Response> {
    const parameters = {
      path: `/library/metadata/${ratingKey.parse(track.id)}`,
      mediaIndex: "0",
      partIndex: "0",
      protocol: "http",
      directPlay: "0",
      directStream: "0",
      hasMDE: "1",
      musicBitrate: "320",
      session,
    };
    const headers = this.#headers({ ...access, session });
    headers.set("X-Plex-Client-Profile-Name", "Generic");
    headers.set("X-Plex-Client-Profile-Extra", MP3_PROFILE);
    // Plex Web asks for a decision first; the conversion also starts without one.
    try {
      await this.#http.empty(this.#url(access, "music/:/transcode/universal/decision", parameters), { headers }, { service: SERVICE, signal, timeoutMs: 5_000 });
    } catch (cause) {
      if (!(cause instanceof UpstreamError)) throw cause;
    }
    const start = this.#url(access, "music/:/transcode/universal/start.mp3", { ...parameters, offset: String(Math.max(0, offset)) });
    const streamHeaders = new Headers(headers);
    streamHeaders.set("Accept", "audio/mpeg,*/*");
    const response = await this.#http.open(start, { headers: streamHeaders }, { service: SERVICE, signal, timeoutMs: 20_000 });
    if (!response.ok) {
      await response.body?.cancel();
      throw userStatusError(response.status);
    }
    return response;
  }
  /** Ends a conversion when its listener leaves; Plex would otherwise keep working for a while. */
  async stopTranscode(access: PlexAccess, session: string): Promise<void> {
    await this.#http.empty(this.#url(access, "video/:/transcode/universal/stop", { session }), { headers: this.#headers(access) }, { service: SERVICE, timeoutMs: 5_000 });
  }
}
