import { z } from "zod";
import { endpointURL, UpstreamError } from "./errors.ts";
import { HttpClient, parseBody, parseJson, statusError, type JsonValue } from "./http.ts";

export type JellyfinAccount = { token: string; userID: string };
export type JellyfinAccess = JellyfinAccount & { endpoint: string };

export type Album = {
  id: string;
  title: string;
  artist: string;
  /** Jellyfin's album-artist item, for browsing an artist's albums. */
  artistID: string | null;
  artistMBID: string | null;
  year: number | null;
  releaseGroupMBID: string | null;
  releaseMBID: string | null;
  hasArtwork: boolean;
  favorite: boolean;
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
};
export type AlbumDetail = { album: Album; tracks: Track[] };
export type Artist = { id: string; name: string; hasArtwork: boolean };
export type ArtistPage = { items: Artist[]; total: number };
export type Playlist = { id: string; name: string; tracks: number | null; duration: number | null; hasArtwork: boolean };
export type PlaylistDetail = { playlist: Playlist; tracks: Track[] };
export type Artwork = { type: string; bytes: Uint8Array };
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

const SERVICE = "Jellyfin";
const CLIENT_VERSION = "0.3";
const MAX_TRACKS = 5_000;
// Track entries carry their media streams (embedded pictures included), so pages stay small.
const TRACK_PAGE = 200;
const TRACK_PAGE_BYTES = 5_000_000;
const PLAYLIST_BATCH = 100;
// Jellyfin caches every distinct resize on disk, so sizes are a few fixed buckets (device pixels).
const pixels: Record<ArtworkSize, number> = { small: 192, medium: 512, large: 1024 };
const sortParameters: Record<LibrarySort, { sortBy: string; sortOrder: string }> = {
  title: { sortBy: "SortName", sortOrder: "Ascending" },
  artist: { sortBy: "AlbumArtist,SortName", sortOrder: "Ascending,Ascending" },
  year: { sortBy: "ProductionYear,SortName", sortOrder: "Descending,Ascending" },
  added: { sortBy: "DateCreated,SortName", sortOrder: "Descending,Ascending" },
};
const imageTypes = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "image/avif"]);
const mbid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const text = z.string().min(1).max(10_000);
const artistRef = z
  .object({ Name: z.string().optional(), name: z.string().optional(), Id: z.string().optional() })
  .loose();
const mediaStream = z
  .object({
    Type: z.string().optional(),
    Codec: z.string().nullable().optional(),
    SampleRate: z.number().finite().nonnegative().nullable().optional(),
    BitDepth: z.number().int().nonnegative().nullable().optional(),
  })
  .loose();
const item = z
  .object({
    Id: text,
    Name: text,
    Type: z.string().optional(),
    Artists: z.array(z.string()).nullable().optional(),
    AlbumArtist: z.string().nullable().optional(),
    AlbumArtists: z.array(artistRef).nullable().optional(),
    AlbumId: z.string().nullable().optional(),
    Album: z.string().nullable().optional(),
    ProductionYear: z.number().int().nullable().optional(),
    IndexNumber: z.number().int().nullable().optional(),
    ParentIndexNumber: z.number().int().nullable().optional(),
    RunTimeTicks: z.number().finite().nonnegative().nullable().optional(),
    CumulativeRunTimeTicks: z.number().finite().nonnegative().nullable().optional(),
    ChildCount: z.number().int().nonnegative().nullable().optional(),
    ProviderIds: z.record(z.string(), z.string().nullable()).nullable().optional(),
    ImageTags: z.record(z.string(), z.string()).nullable().optional(),
    UserData: z.object({ IsFavorite: z.boolean().optional() }).loose().nullable().optional(),
    MediaStreams: z.array(mediaStream).nullable().optional(),
    MediaSources: z
      .array(z.object({ MediaStreams: z.array(mediaStream).nullable().optional() }).loose())
      .nullable()
      .optional(),
  })
  .loose();
type Item = z.infer<typeof item>;
const page = z
  .object({
    Items: z.array(item),
    TotalRecordCount: z.number().int().nonnegative().optional(),
  })
  .loose();

const nonEmpty = (values: Array<string | null | undefined>) => values.filter((value): value is string => !!value);
/** Album artist first: an album's `Artists` lists every track's artist. */
function albumArtistName(value: Item): string {
  const albumArtists = nonEmpty((value.AlbumArtists ?? []).map((artist) => artist.Name ?? artist.name));
  if (albumArtists.length) return albumArtists.join(", ");
  if (value.AlbumArtist) return value.AlbumArtist;
  return nonEmpty(value.Artists ?? []).join(", ");
}
function trackArtistName(value: Item): string {
  const artists = nonEmpty(value.Artists ?? []);
  if (artists.length) return artists.join(", ");
  if (value.AlbumArtist) return value.AlbumArtist;
  return nonEmpty((value.AlbumArtists ?? []).map((artist) => artist.Name ?? artist.name)).join(", ");
}
function providerMBID(value: string | null | undefined): string | null {
  const parsed = mbid.safeParse(value);
  return parsed.success ? parsed.data : null;
}
const seconds = (ticks: number | null | undefined) => (ticks === undefined || ticks === null ? null : ticks / 10_000_000);
const hasArtwork = (value: Item) => !!value.ImageTags?.Primary;
function toAlbum(value: Item): Album {
  return {
    id: value.Id,
    title: value.Name,
    artist: albumArtistName(value),
    artistID: value.AlbumArtists?.find((artist) => artist.Id)?.Id ?? null,
    artistMBID: providerMBID(value.ProviderIds?.MusicBrainzAlbumArtist),
    year: value.ProductionYear ?? null,
    releaseGroupMBID: providerMBID(value.ProviderIds?.MusicBrainzReleaseGroup),
    releaseMBID: providerMBID(value.ProviderIds?.MusicBrainzAlbum),
    hasArtwork: hasArtwork(value),
    favorite: value.UserData?.IsFavorite === true,
  };
}
function toTrack(value: Item): Track {
  const streams = value.MediaStreams ?? value.MediaSources?.flatMap((source) => source.MediaStreams ?? []) ?? [];
  const audio = streams.find((stream) => stream.Type === "Audio");
  return {
    id: value.Id,
    title: value.Name,
    artist: trackArtistName(value),
    albumID: value.AlbumId ?? null,
    albumTitle: value.Album ?? null,
    disc: value.ParentIndexNumber ?? null,
    number: value.IndexNumber ?? null,
    duration: seconds(value.RunTimeTicks),
    codec: audio?.Codec ?? null,
    sampleRate: audio?.SampleRate ?? null,
    bitDepth: audio?.BitDepth ?? null,
    favorite: value.UserData?.IsFavorite === true,
  };
}
function toPlaylist(value: Item): Playlist {
  return {
    id: value.Id,
    name: value.Name,
    tracks: value.ChildCount ?? null,
    duration: seconds(value.CumulativeRunTimeTicks ?? value.RunTimeTicks),
    hasArtwork: hasArtwork(value),
  };
}

/** The saved per-user token no longer works: only reconnecting can fix it. */
export const reconnectError = () =>
  new UpstreamError(
    "jellyfin_reconnect",
    409,
    "Jellyfin no longer accepts your saved sign-in (for example after a password change). Reconnect Jellyfin in Settings → Connections.",
    "not_applied",
  );
function userStatusError(status: number): UpstreamError {
  if (status === 401) return reconnectError();
  if (status === 404)
    return new UpstreamError("upstream_rejected", 404, "Jellyfin has no such item, or your account cannot see it.", "not_applied");
  return statusError(status, SERVICE);
}

function setParameters(url: URL, parameters: Record<string, string>): URL {
  for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
  return url;
}

export class Jellyfin {
  readonly #http: HttpClient;
  constructor(http: HttpClient) {
    this.#http = http;
  }

  #headers(access: JellyfinAccess, accept = "application/json"): Headers {
    return new Headers({ Accept: accept, Authorization: `MediaBrowser Token=${JSON.stringify(access.token)}` });
  }
  /**
   * A call with the user's token; a 401 means the token was revoked, not a wrong
   * password. The status is checked first: Jellyfin's 401 has no JSON body.
   */
  async #json(access: JellyfinAccess, url: URL, signal?: AbortSignal, maxBytes?: number): Promise<JsonValue> {
    const response = await this.#http.binary(url, { headers: this.#headers(access) }, { service: SERVICE, signal, maxBytes });
    if (response.status < 200 || response.status > 299) throw userStatusError(response.status);
    return parseJson(response.bytes, SERVICE);
  }
  async #write(access: JellyfinAccess, url: URL, method: "POST" | "DELETE", body?: JsonValue): Promise<void> {
    const headers = this.#headers(access);
    if (body !== undefined) headers.set("Content-Type", "application/json");
    const status = await this.#http.empty(
      url,
      { method, headers, body: body === undefined ? undefined : JSON.stringify(body) },
      { service: SERVICE },
    );
    if (status < 200 || status > 299) throw userStatusError(status);
  }

  /**
   * Signs in as a Jellyfin user. `deviceID` must differ per Leerr user: Jellyfin
   * revokes earlier tokens issued to the same device and Jellyfin account.
   */
  async login(endpoint: string, username: string, password: string, deviceID: string): Promise<JellyfinAccount> {
    const body = await this.#http.json(
      endpointURL(endpoint, "Users/AuthenticateByName"),
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `MediaBrowser Client="Leerr",Device="Leerr",DeviceId=${JSON.stringify(deviceID)},Version="${CLIENT_VERSION}"`,
        },
        body: JSON.stringify({ Username: username, Pw: password }),
      },
      { service: SERVICE },
    );
    const parsed = parseBody(z.object({ AccessToken: text, User: z.object({ Id: text }).loose() }).loose(), body, SERVICE);
    return { token: parsed.AccessToken, userID: parsed.User.Id };
  }

  /** The server's version from its unauthenticated public endpoint. */
  async version(endpoint: string): Promise<string> {
    return parseBody(
      z.object({ Version: z.string() }).loose(),
      await this.#http.json(endpointURL(endpoint, "System/Info/Public"), { headers: { Accept: "application/json" } }, { service: SERVICE }),
      SERVICE,
    ).Version;
  }

  /** Whether the saved token still works. Other failures (e.g. Jellyfin is down) throw. */
  async tokenValid(access: JellyfinAccess): Promise<boolean> {
    try {
      await this.#json(access, endpointURL(access.endpoint, "Users/Me"));
      return true;
    } catch (cause) {
      if (cause instanceof UpstreamError && cause.code === "jellyfin_reconnect") return false;
      throw cause;
    }
  }

  async library(access: JellyfinAccess, query: LibraryQuery): Promise<AlbumPage> {
    if (!Number.isInteger(query.offset) || query.offset < 0 || !Number.isInteger(query.limit) || query.limit < 1 || query.limit > 500)
      throw new RangeError("Library pages must use 0 <= offset and 1..500 items.");
    const url = setParameters(endpointURL(access.endpoint, "Items"), {
      userId: access.userID,
      recursive: "true",
      includeItemTypes: "MusicAlbum",
      ...sortParameters[query.sort],
      fields: "ProviderIds",
      enableUserData: "true",
      enableImageTypes: "Primary",
      imageTypeLimit: "1",
      startIndex: String(query.offset),
      limit: String(query.limit),
    });
    if (query.q) url.searchParams.set("searchTerm", query.q);
    if (query.artistID) url.searchParams.set("albumArtistIds", query.artistID);
    if (query.favorites) url.searchParams.set("isFavorite", "true");
    const result = parseBody(page, await this.#json(access, url), SERVICE);
    const items = result.Items.map(toAlbum);
    const total = result.TotalRecordCount ?? query.offset + items.length;
    if (total < query.offset + items.length)
      throw new UpstreamError("upstream_protocol", 502, "Jellyfin returned an inconsistent album page.");
    return { items, total };
  }

  async artists(access: JellyfinAccess, offset: number, limit: number, q: string): Promise<ArtistPage> {
    // Deprecated in Jellyfin 12 but still the only way to list album artists rather than every track artist.
    const url = setParameters(endpointURL(access.endpoint, "Artists/AlbumArtists"), {
      userId: access.userID,
      sortBy: "SortName",
      sortOrder: "Ascending",
      enableImageTypes: "Primary",
      imageTypeLimit: "1",
      startIndex: String(offset),
      limit: String(limit),
    });
    if (q) url.searchParams.set("searchTerm", q);
    const result = parseBody(page, await this.#json(access, url), SERVICE);
    return {
      items: result.Items.map((value) => ({ id: value.Id, name: value.Name, hasArtwork: hasArtwork(value) })),
      total: result.TotalRecordCount ?? offset + result.Items.length,
    };
  }

  async #item(access: JellyfinAccess, id: string, signal?: AbortSignal): Promise<Item> {
    const url = setParameters(endpointURL(access.endpoint, `Items/${encodeURIComponent(id)}`), { userId: access.userID });
    const value = parseBody(item, await this.#json(access, url, signal), SERVICE);
    if (value.Id !== id) throw new UpstreamError("upstream_protocol", 502, "Jellyfin returned a different item.");
    return value;
  }

  /**
   * Every track a paged listing returns (an album's, or a playlist's). Pages
   * advance by what Jellyfin returned, not by what was kept: a playlist can
   * hold other media, which is skipped.
   */
  async #tracks(access: JellyfinAccess, url: (offset: number) => URL): Promise<Track[]> {
    const tracks: Track[] = [];
    for (let offset = 0; offset < MAX_TRACKS; ) {
      const result = parseBody(page, await this.#json(access, url(offset), undefined, TRACK_PAGE_BYTES), SERVICE);
      offset += result.Items.length;
      tracks.push(...result.Items.flatMap((value) => (value.Type === undefined || value.Type === "Audio" ? [toTrack(value)] : [])));
      if (!result.Items.length || offset >= (result.TotalRecordCount ?? offset)) return tracks;
    }
    throw new UpstreamError("upstream_protocol", 502, "Too many tracks.");
  }

  async album(access: JellyfinAccess, albumID: string): Promise<AlbumDetail> {
    const album = await this.#item(access, albumID);
    if (album.Type !== "MusicAlbum")
      throw new UpstreamError("upstream_rejected", 404, "This item is not an album.", "not_applied");
    const tracks = await this.#tracks(access, (offset) =>
      setParameters(endpointURL(access.endpoint, "Items"), {
        userId: access.userID,
        parentId: albumID,
        recursive: "true",
        includeItemTypes: "Audio",
        sortBy: "ParentIndexNumber,IndexNumber,SortName",
        fields: "MediaStreams",
        enableUserData: "true",
        startIndex: String(offset),
        limit: String(TRACK_PAGE),
      }),
    );
    return { album: toAlbum(album), tracks };
  }

  async playlists(access: JellyfinAccess): Promise<Playlist[]> {
    const url = setParameters(endpointURL(access.endpoint, "Items"), {
      userId: access.userID,
      recursive: "true",
      includeItemTypes: "Playlist",
      mediaTypes: "Audio",
      sortBy: "SortName",
      fields: "ChildCount,CumulativeRunTimeTicks",
      enableImageTypes: "Primary",
      imageTypeLimit: "1",
      limit: "500",
    });
    return parseBody(page, await this.#json(access, url), SERVICE).Items.map(toPlaylist);
  }

  async playlist(access: JellyfinAccess, playlistID: string): Promise<PlaylistDetail> {
    const playlist = await this.#item(access, playlistID);
    if (playlist.Type !== "Playlist")
      throw new UpstreamError("upstream_rejected", 404, "This item is not a playlist.", "not_applied");
    const tracks = await this.#tracks(access, (offset) =>
      setParameters(endpointURL(access.endpoint, `Playlists/${encodeURIComponent(playlistID)}/Items`), {
        userId: access.userID,
        fields: "MediaStreams",
        enableUserData: "true",
        startIndex: String(offset),
        limit: String(TRACK_PAGE),
      }),
    );
    return { playlist: toPlaylist(playlist), tracks };
  }

  async addToPlaylist(access: JellyfinAccess, playlistID: string, trackIDs: string[]): Promise<void> {
    const playlist = await this.#item(access, playlistID);
    if (playlist.Type !== "Playlist")
      throw new UpstreamError("upstream_rejected", 404, "This item is not a playlist.", "not_applied");
    // Ids travel in the query string: batches keep the request line short.
    for (let start = 0; start < trackIDs.length; start += PLAYLIST_BATCH) {
      const url = setParameters(endpointURL(access.endpoint, `Playlists/${encodeURIComponent(playlistID)}/Items`), {
        userId: access.userID,
        ids: trackIDs.slice(start, start + PLAYLIST_BATCH).join(","),
      });
      await this.#write(access, url, "POST");
    }
  }

  async favorite(access: JellyfinAccess, itemID: string, favorite: boolean): Promise<void> {
    // The item lookup proves this user may see it before anything is written.
    await this.#item(access, itemID);
    const url = setParameters(endpointURL(access.endpoint, `UserFavoriteItems/${encodeURIComponent(itemID)}`), {
      userId: access.userID,
    });
    await this.#write(access, url, favorite ? "POST" : "DELETE");
  }

  /** Tells Jellyfin what is playing, so play counts, "recently played" and scrobbler plugins work. */
  async report(access: JellyfinAccess, event: PlaybackEvent, trackID: string, position: number, paused: boolean): Promise<void> {
    const path = { start: "Sessions/Playing", progress: "Sessions/Playing/Progress", stop: "Sessions/Playing/Stopped" }[event];
    const ticks = Math.max(0, Math.round(position * 10_000_000));
    await this.#write(access, endpointURL(access.endpoint, path), "POST", {
      ItemId: trackID,
      PositionTicks: ticks,
      IsPaused: paused,
      CanSeek: true,
      PlayMethod: "DirectPlay",
    });
  }

  /** A user-scoped lookup: succeeding proves this Jellyfin user may play the track. */
  async track(access: JellyfinAccess, trackID: string, signal?: AbortSignal): Promise<Track> {
    const value = await this.#item(access, trackID, signal);
    if (value.Type !== "Audio")
      throw new UpstreamError("upstream_rejected", 404, "This item is not a track.", "not_applied");
    return toTrack(value);
  }

  /** A bounded-size primary image of any item the user can see. */
  async artwork(access: JellyfinAccess, itemID: string, size: ArtworkSize, signal?: AbortSignal): Promise<Artwork> {
    await this.#item(access, itemID, signal);
    const url = setParameters(endpointURL(access.endpoint, `Items/${encodeURIComponent(itemID)}/Images/Primary`), {
      maxWidth: String(pixels[size]),
      maxHeight: String(pixels[size]),
      quality: "90",
    });
    const image = await this.#http.binary(
      url,
      { headers: this.#headers(access, "image/webp,image/avif,image/jpeg,image/png;q=0.9") },
      { service: SERVICE, signal, maxBytes: 5_000_000 },
    );
    if (image.status === 404)
      throw new UpstreamError("upstream_rejected", 404, "This item has no artwork.", "not_applied");
    if (image.status < 200 || image.status > 299) throw userStatusError(image.status);
    if (!imageTypes.has(image.type)) throw new UpstreamError("upstream_protocol", 502, "Jellyfin artwork is not an image.");
    return { type: image.type, bytes: image.bytes };
  }

  /**
   * Opens the original file after re-authorising the track for this user.
   * The body streams to the caller; `signal` cancels both steps.
   */
  async stream(
    access: JellyfinAccess,
    trackID: string,
    range: string | undefined,
    ifRange: string | undefined,
    signal: AbortSignal,
  ): Promise<Response> {
    await this.track(access, trackID, signal);
    const headers = this.#headers(access, "*/*");
    headers.set("Accept-Encoding", "identity");
    if (range) headers.set("Range", range);
    if (range && ifRange) headers.set("If-Range", ifRange);
    const response = await this.#http.open(
      endpointURL(access.endpoint, `Audio/${encodeURIComponent(trackID)}/stream?static=true`),
      { headers },
      { service: SERVICE, signal, timeoutMs: 15_000 },
    );
    const encoding = response.headers.get("content-encoding");
    if (encoding && encoding !== "identity") {
      await response.body?.cancel();
      throw new UpstreamError("upstream_protocol", 502, "Jellyfin compressed the audio stream.");
    }
    if (response.status === 416) return response;
    if (response.status !== 200 && response.status !== 206) {
      await response.body?.cancel();
      throw userStatusError(response.status);
    }
    return response;
  }
}
