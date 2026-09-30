import { z } from "zod";
import { endpointURL, UpstreamError } from "./errors.ts";
import { HttpClient, parseBody, readBounded, statusError } from "./http.ts";

export type JellyfinAccount = { token: string; userID: string };
export type JellyfinAccess = JellyfinAccount & { endpoint: string };

export type Album = {
  id: string;
  title: string;
  artist: string;
  year: number | null;
  releaseGroupMBID: string | null;
  releaseMBID: string | null;
};
export type AlbumPage = { items: Album[]; total: number };
export type Track = {
  id: string;
  title: string;
  artist: string;
  disc: number | null;
  number: number | null;
  duration: number | null;
  codec: string | null;
  sampleRate: number | null;
  bitDepth: number | null;
};
export type AlbumDetail = { album: Album; tracks: Track[] };
export type Artwork = { type: string; bytes: Uint8Array };

const SERVICE = "Jellyfin";
const imageTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/avif",
]);
const mbid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const text = z.string().min(1).max(10_000);
const artistRef = z
  .object({ Name: z.string().optional(), name: z.string().optional() })
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
    Artists: z.array(z.string()).optional(),
    AlbumArtist: z.string().optional(),
    AlbumArtists: z.array(artistRef).optional(),
    ProductionYear: z.number().int().nullable().optional(),
    IndexNumber: z.number().int().nullable().optional(),
    ParentIndexNumber: z.number().int().nullable().optional(),
    RunTimeTicks: z.number().finite().nonnegative().nullable().optional(),
    ProviderIds: z.record(z.string(), z.string()).optional(),
    MediaStreams: z.array(mediaStream).optional(),
    MediaSources: z
      .array(z.object({ MediaStreams: z.array(mediaStream).optional() }).loose())
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

function artistName(value: Item): string {
  const artists = value.Artists?.filter((name) => name.length > 0) ?? [];
  if (artists.length) return artists.join(", ");
  if (value.AlbumArtist) return value.AlbumArtist;
  return (value.AlbumArtists ?? [])
    .map((artist) => artist.Name ?? artist.name ?? "")
    .join(", ");
}
function providerMBID(value: string | undefined): string | null {
  const parsed = mbid.safeParse(value);
  return parsed.success ? parsed.data : null;
}
function toAlbum(value: Item): Album {
  return {
    id: value.Id,
    title: value.Name,
    artist: artistName(value),
    year: value.ProductionYear ?? null,
    releaseGroupMBID: providerMBID(value.ProviderIds?.MusicBrainzReleaseGroup),
    releaseMBID: providerMBID(value.ProviderIds?.MusicBrainzAlbum),
  };
}
function toTrack(value: Item): Track {
  const streams =
    value.MediaStreams ??
    value.MediaSources?.flatMap((source) => source.MediaStreams ?? []) ??
    [];
  const audio = streams.find((stream) => stream.Type === "Audio");
  return {
    id: value.Id,
    title: value.Name,
    artist: artistName(value),
    disc: value.ParentIndexNumber ?? null,
    number: value.IndexNumber ?? null,
    duration:
      value.RunTimeTicks === undefined || value.RunTimeTicks === null
        ? null
        : value.RunTimeTicks / 10_000_000,
    codec: audio?.Codec ?? null,
    sampleRate: audio?.SampleRate ?? null,
    bitDepth: audio?.BitDepth ?? null,
  };
}

export class Jellyfin {
  readonly #http: HttpClient;
  constructor(http: HttpClient) {
    this.#http = http;
  }

  #headers(access: JellyfinAccess): Headers {
    return new Headers({
      Accept: "application/json",
      Authorization: `MediaBrowser Token=${JSON.stringify(access.token)}`,
    });
  }

  async login(
    endpoint: string,
    username: string,
    password: string,
  ): Promise<JellyfinAccount> {
    const body = await this.#http.json(
      endpointURL(endpoint, "Users/AuthenticateByName"),
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization:
            'MediaBrowser Client="Leerr",Device="Leerr Server",DeviceId="leerr-server",Version="0.2"',
        },
        body: JSON.stringify({ Username: username, Pw: password }),
      },
      { service: SERVICE },
    );
    const parsed = parseBody(
      z.object({ AccessToken: text, User: z.object({ Id: text }).loose() }).loose(),
      body,
      SERVICE,
    );
    return { token: parsed.AccessToken, userID: parsed.User.Id };
  }

  async library(
    access: JellyfinAccess,
    offset: number,
    limit: number,
    query = "",
  ): Promise<AlbumPage> {
    if (
      !Number.isInteger(offset) ||
      offset < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 500
    )
      throw new RangeError("Library pages must use 0 <= offset and 1..500 items.");
    const url = endpointURL(access.endpoint, "Items");
    for (const [key, value] of Object.entries({
      userId: access.userID,
      recursive: "true",
      includeItemTypes: "MusicAlbum",
      sortBy: "SortName",
      sortOrder: "Ascending",
      fields: "ProviderIds",
      startIndex: String(offset),
      limit: String(limit),
    }))
      url.searchParams.set(key, value);
    if (query) url.searchParams.set("searchTerm", query);
    const result = parseBody(
      page,
      await this.#http.json(url, { headers: this.#headers(access) }, { service: SERVICE }),
      SERVICE,
    );
    const items = result.Items.map(toAlbum);
    const total = result.TotalRecordCount ?? offset + items.length;
    if (total < offset + items.length)
      throw new UpstreamError("upstream_protocol", 502, "Jellyfin returned an inconsistent album page.");
    return { items, total };
  }

  async #item(access: JellyfinAccess, id: string, signal?: AbortSignal): Promise<Item> {
    const value = parseBody(
      item,
      await this.#http.json(
        endpointURL(
          access.endpoint,
          `Users/${encodeURIComponent(access.userID)}/Items/${encodeURIComponent(id)}`,
        ),
        { headers: this.#headers(access) },
        { service: SERVICE, signal },
      ),
      SERVICE,
    );
    if (value.Id !== id)
      throw new UpstreamError("upstream_protocol", 502, "Jellyfin returned a different item.");
    return value;
  }

  async album(access: JellyfinAccess, albumID: string): Promise<AlbumDetail> {
    const album = await this.#item(access, albumID);
    if (album.Type !== "MusicAlbum")
      throw new UpstreamError("upstream_rejected", 404, "This item is not an album.", "not_applied");
    const tracks: Track[] = [];
    while (tracks.length < 5_000) {
      const url = endpointURL(access.endpoint, "Items");
      for (const [key, value] of Object.entries({
        userId: access.userID,
        parentId: albumID,
        recursive: "true",
        includeItemTypes: "Audio",
        sortBy: "ParentIndexNumber,IndexNumber,SortName",
        fields: "MediaSources,MediaStreams",
        startIndex: String(tracks.length),
        limit: "500",
      }))
        url.searchParams.set(key, value);
      const result = parseBody(
        page,
        await this.#http.json(url, { headers: this.#headers(access) }, { service: SERVICE }),
        SERVICE,
      );
      tracks.push(...result.Items.map(toTrack));
      if (!result.Items.length || tracks.length >= (result.TotalRecordCount ?? tracks.length))
        return { album: toAlbum(album), tracks };
    }
    throw new UpstreamError("upstream_protocol", 502, "Album has too many tracks.");
  }

  /** A user-scoped lookup: succeeding proves this Jellyfin user may play the track. */
  async track(access: JellyfinAccess, trackID: string, signal?: AbortSignal): Promise<Track> {
    const value = await this.#item(access, trackID, signal);
    if (value.Type !== "Audio")
      throw new UpstreamError("upstream_rejected", 404, "This item is not a track.", "not_applied");
    return toTrack(value);
  }

  async artwork(access: JellyfinAccess, itemID: string): Promise<Artwork> {
    await this.#item(access, itemID);
    const response = await this.#http.open(
      endpointURL(access.endpoint, `Items/${encodeURIComponent(itemID)}/Images/Primary`),
      { headers: this.#headers(access) },
      { service: SERVICE },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw statusError(response.status, SERVICE);
    }
    const type = (response.headers.get("content-type") ?? "")
      .split(";", 1)[0]
      .trim()
      .toLowerCase();
    if (!imageTypes.has(type)) {
      await response.body?.cancel();
      throw new UpstreamError("upstream_protocol", 502, "Jellyfin artwork is not an image.");
    }
    return { type, bytes: await readBounded(response, 5_000_000, SERVICE) };
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
    const headers = this.#headers(access);
    headers.set("Accept", "*/*");
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
      throw statusError(response.status, SERVICE);
    }
    return response;
  }
}
