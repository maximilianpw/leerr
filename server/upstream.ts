import { z } from "zod";

const jsonValueSchema = z.json();
type JsonValue = z.infer<typeof jsonValueSchema>;

export type Album = {
  id: string;
  title: string;
  artist: string;
  releaseGroupMBID: string | null;
  releaseMBID: string | null;
};
export type Track = {
  id: string;
  title: string;
  artist: string;
  duration: number | null;
  sourceCodec: string | null;
  sourceSampleRate: number | null;
  sourceBitDepth: number | null;
};
export type Identity = {
  artistMBID: string;
  releaseGroupMBID: string;
  releaseMBID: string;
  title: string;
  artist: string;
};
export type LidarrOptions = {
  roots: Array<{ id: number; name: string }>;
  qualities: Array<{ id: number; name: string }>;
  metadata: Array<{ id: number; name: string }>;
};
const lidarrCandidateSchema = z
  .object({
    foreignAlbumId: z.string(),
    artist: z.object({ foreignArtistId: z.string() }).passthrough(),
    releases: z
      .array(
        z
          .object({
            foreignReleaseId: z.string(),
            monitored: z.boolean().optional(),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();
const lidarrResourceSchema = lidarrCandidateSchema.omit({ artist: true });
export type LidarrCandidate = z.infer<typeof lidarrCandidateSchema>;
export type LidarrAlbumState = {
  id: number;
  imported: boolean;
  monitored: boolean;
  resource: z.infer<typeof lidarrResourceSchema>;
};
export type LidarrCommand = {
  id: number;
  status:
    | "queued"
    | "started"
    | "completed"
    | "failed"
    | "aborted"
    | "cancelled"
    | "orphaned"
    | "unknown";
};

export type UpstreamCode =
  | "upstream_auth"
  | "upstream_unavailable"
  | "upstream_protocol"
  | "invalid_endpoint";

export class UpstreamError extends Error {
  constructor(
    public readonly code: UpstreamCode,
    public readonly status: number,
    detail?: string,
  ) {
    super(
      detail ??
        (code === "invalid_endpoint"
          ? "Enter an HTTPS server URL without embedded credentials, query parameters, or a fragment."
          : code === "upstream_auth"
            ? "The upstream service rejected its credentials."
            : code === "upstream_unavailable"
              ? "The upstream service is unavailable."
              : "The upstream service returned an invalid response."),
    );
    this.name = "UpstreamError";
  }
}

export function validateEndpoint(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new UpstreamError("invalid_endpoint", 400);
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.hostname
  )
    throw new UpstreamError("invalid_endpoint", 400);
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

const id = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const safeString = z.string().min(1).max(10_000);
const artistSchema = z
  .object({
    Name: z.string().optional(),
    name: z.string().optional(),
    Id: z.string().optional(),
    id: z.string().optional(),
  })
  .passthrough();
const streamSchema = z
  .object({
    Type: z.string().optional(),
    Codec: z.string().nullable().optional(),
    SampleRate: z.number().finite().nonnegative().nullable().optional(),
    BitDepth: z.number().int().nonnegative().nullable().optional(),
  })
  .passthrough();
const jellyItemSchema = z
  .object({
    Id: safeString,
    Name: safeString,
    Type: z.string().optional(),
    Artists: z.array(z.string()).optional(),
    AlbumArtist: z.string().optional(),
    AlbumArtists: z.array(artistSchema).optional(),
    RunTimeTicks: z.number().finite().nonnegative().nullable().optional(),
    ProviderIds: z.record(z.string(), z.string()).optional(),
    MediaStreams: z.array(streamSchema).optional(),
    MediaSources: z
      .array(
        z
          .object({ MediaStreams: z.array(streamSchema).optional() })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();
const jellyPageSchema = z
  .object({
    Items: z.array(jellyItemSchema),
    TotalRecordCount: z.number().int().nonnegative().optional(),
  })
  .passthrough();

const mbArtistCredit = z
  .object({ artist: z.object({ id, name: safeString }).passthrough() })
  .passthrough();
const mbGroup = z
  .object({
    id,
    title: safeString,
    "artist-credit": z.array(mbArtistCredit).min(1),
  })
  .passthrough();
const mbRelease = z
  .object({
    id,
    title: safeString,
    date: z.string().nullable().optional(),
    country: z.string().nullable().optional(),
    "artist-credit": z.array(mbArtistCredit).min(1),
    "release-group": z.object({ id }).passthrough().optional(),
  })
  .passthrough();

function pathURL(endpoint: string, path: string): URL {
  return new URL(`${validateEndpoint(endpoint)}/${path}`);
}
function headers(values: Record<string, string>): Headers {
  const result = new Headers({ Accept: "application/json" });
  for (const [key, value] of Object.entries(values)) result.set(key, value);
  return result;
}
function classify(status: number): never {
  if (status === 401)
    throw new UpstreamError(
      "upstream_auth",
      502,
      "The upstream service returned HTTP 401 (unauthorized). Check the account or API key and any proxy authentication requirements.",
    );
  if (status === 403)
    throw new UpstreamError(
      "upstream_auth",
      502,
      "The upstream service returned HTTP 403 (forbidden). Check account permissions, remote-access policy, and proxy access rules; this does not necessarily mean the password is wrong.",
    );
  if (status >= 500 || status === 429)
    throw new UpstreamError("upstream_unavailable", 503);
  throw new UpstreamError("upstream_protocol", 502);
}

export class Upstreams {
  private musicBrainzNext = 0;
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  private async request(
    url: URL,
    init: RequestInit = {},
    lastfmErrors = false,
  ): Promise<JsonValue> {
    if (url.hostname === "musicbrainz.org") {
      const delay = Math.max(0, this.musicBrainzNext - Date.now());
      if (delay > 30_000) throw new UpstreamError("upstream_unavailable", 503);
      this.musicBrainzNext = Date.now() + delay + 1100;
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    let response: Response | undefined;
    try {
      response = await this.fetcher(url, {
        ...init,
        redirect: "manual",
        signal: controller.signal,
      });
      if (response.status >= 300 && response.status < 400)
        throw new UpstreamError("upstream_protocol", 502);
      if (!response.ok && !lastfmErrors) classify(response.status);
      const bytes = await this.boundedBody(response, 2_000_000);
      const body = z.json().parse(JSON.parse(new TextDecoder().decode(bytes)));
      if (
        !response.ok &&
        !z.object({ error: z.number().int() }).safeParse(body).success
      )
        classify(response.status);
      return body;
    } catch (error) {
      if (error instanceof UpstreamError) throw error;
      if (error instanceof SyntaxError) {
        if (response && !response.ok) classify(response.status);
        throw new UpstreamError(
          "upstream_protocol",
          502,
          "The upstream service did not return valid JSON. Check the server URL and reverse-proxy route.",
        );
      }
      throw new UpstreamError("upstream_unavailable", 503);
    } finally {
      clearTimeout(timer);
    }
  }

  private async boundedBody(
    response: Response,
    maximum: number,
  ): Promise<Uint8Array> {
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (!Number.isFinite(declared) || declared < 0 || declared > maximum)
      throw new UpstreamError("upstream_protocol", 502);
    if (!response.body) return new Uint8Array();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > maximum) {
          await reader.cancel();
          throw new UpstreamError("upstream_protocol", 502);
        }
        chunks.push(next.value);
      }
    } catch (error) {
      if (error instanceof UpstreamError) throw error;
      throw new UpstreamError("upstream_unavailable", 503);
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return body;
  }

  async jellyfinLogin(
    endpoint: string,
    username: string,
    password: string,
  ): Promise<{ token: string; userID: string }> {
    const schema = z
      .object({
        AccessToken: safeString,
        User: z.object({ Id: safeString }).passthrough(),
      })
      .passthrough();
    const body = await this.request(
      pathURL(endpoint, "Users/AuthenticateByName"),
      {
        method: "POST",
        headers: headers({
          "Content-Type": "application/json",
          Authorization:
            'MediaBrowser Client="Leerr",Device="Leerr Server",DeviceId="leerr-server",Version="0.1"',
        }),
        body: JSON.stringify({ Username: username, Pw: password }),
      },
    );
    const parsed = this.parse(schema, body);
    return { token: parsed.AccessToken, userID: parsed.User.Id };
  }

  async jellyfinLibrary(
    endpoint: string,
    token: string,
    userID: string,
    offset: number,
    limit: number,
    q = "",
  ): Promise<{ items: Album[]; total: number }> {
    if (
      !Number.isInteger(offset) ||
      offset < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 500
    )
      throw new UpstreamError("upstream_protocol", 400);
    const url = pathURL(endpoint, "Items");
    const query = {
      userId: userID,
      recursive: "true",
      includeItemTypes: "MusicAlbum",
      sortBy: "SortName",
      sortOrder: "Ascending",
      fields: "ProviderIds",
      startIndex: String(offset),
      limit: String(limit),
    };
    for (const [key, value] of Object.entries(query))
      url.searchParams.set(key, value);
    if (q) url.searchParams.set("searchTerm", q);
    const page = this.parse(
      jellyPageSchema,
      await this.request(url, {
        headers: headers({ "X-Emby-Token": token }),
      }),
    );
    const items: Album[] = [];
    for (const item of page.Items) items.push(this.album(item));
    const total = page.TotalRecordCount ?? items.length;
    if (total < offset + items.length && items.length > 0)
      throw new UpstreamError("upstream_protocol", 502);
    return { items, total };
  }

  async jellyfinAlbum(
    endpoint: string,
    token: string,
    userID: string,
    albumID: string,
  ): Promise<{ album: Album; tracks: Track[] }> {
    const album = this.parse(
      jellyItemSchema,
      await this.request(
        pathURL(
          endpoint,
          `Users/${encodeURIComponent(userID)}/Items/${encodeURIComponent(albumID)}`,
        ),
        { headers: headers({ "X-Emby-Token": token }) },
      ),
    );
    if (album.Id !== albumID || album.Type !== "MusicAlbum")
      throw new UpstreamError("upstream_protocol", 502);
    const tracks: Track[] = [];
    let offset = 0;
    while (offset < 5_000) {
      const url = pathURL(endpoint, "Items");
      for (const [key, value] of Object.entries({
        userId: userID,
        parentId: albumID,
        recursive: "true",
        includeItemTypes: "Audio",
        sortBy: "ParentIndexNumber,IndexNumber",
        fields: "MediaSources,MediaStreams",
        startIndex: String(offset),
        limit: "500",
      }))
        url.searchParams.set(key, value);
      const page = this.parse(
        jellyPageSchema,
        await this.request(url, {
          headers: headers({ "X-Emby-Token": token }),
        }),
      );
      for (const item of page.Items) tracks.push(this.track(item));
      offset += page.Items.length;
      if (
        page.Items.length === 0 ||
        offset >= (page.TotalRecordCount ?? offset)
      )
        return { album: this.album(album), tracks };
    }
    throw new UpstreamError("upstream_protocol", 502);
  }

  async jellyfinTrack(
    endpoint: string,
    token: string,
    userID: string,
    trackID: string,
  ): Promise<Track> {
    const item = this.parse(
      jellyItemSchema,
      await this.request(
        pathURL(
          endpoint,
          `Users/${encodeURIComponent(userID)}/Items/${encodeURIComponent(trackID)}`,
        ),
        { headers: headers({ "X-Emby-Token": token }) },
      ),
    );
    if (item.Type !== "Audio" || item.Id !== trackID)
      throw new UpstreamError("upstream_protocol", 502);
    return this.track(item);
  }

  async jellyfinArtwork(
    endpoint: string,
    token: string,
    userID: string,
    itemID: string,
  ): Promise<Response> {
    const item = this.parse(
      jellyItemSchema,
      await this.request(
        pathURL(
          endpoint,
          `Users/${encodeURIComponent(userID)}/Items/${encodeURIComponent(itemID)}`,
        ),
        {
          headers: headers({ "X-Emby-Token": token }),
        },
      ),
    );
    if (item.Id !== itemID) throw new UpstreamError("upstream_protocol", 502);
    let response: Response;
    try {
      response = await this.fetcher(
        pathURL(endpoint, `Items/${encodeURIComponent(itemID)}/Images/Primary`),
        {
          headers: headers({ "X-Emby-Token": token }),
          redirect: "manual",
          signal: AbortSignal.timeout(10_000),
        },
      );
    } catch {
      throw new UpstreamError("upstream_unavailable", 503);
    }
    if (response.status >= 300 && response.status < 400)
      throw new UpstreamError("upstream_protocol", 502);
    if (!response.ok) classify(response.status);
    const type = (response.headers.get("content-type") ?? "")
      .split(";", 1)[0]
      .trim()
      .toLowerCase();
    if (
      ![
        "image/jpeg",
        "image/png",
        "image/gif",
        "image/webp",
        "image/avif",
      ].includes(type)
    )
      throw new UpstreamError("upstream_protocol", 502);
    const body = await this.boundedBody(response, 5_000_000);
    const copy = new Uint8Array(body.byteLength);
    copy.set(body);
    return new Response(copy.buffer, {
      status: response.status,
      headers: {
        "Content-Type": type,
        "Content-Length": String(body.byteLength),
      },
    });
  }

  async jellyfinOriginal(
    endpoint: string,
    token: string,
    userID: string,
    trackID: string,
    range: string | undefined,
    signal: AbortSignal,
  ): Promise<Response> {
    await this.jellyfinTrack(endpoint, token, userID, trackID); // A user-scoped lookup is the authorization check.
    const requestHeaders = headers({
      "X-Emby-Token": token,
      "Accept-Encoding": "identity",
    });
    if (range) requestHeaders.set("Range", range);
    let response: Response;
    try {
      response = await this.fetcher(
        pathURL(
          endpoint,
          `Audio/${encodeURIComponent(trackID)}/stream?static=true`,
        ),
        {
          headers: requestHeaders,
          redirect: "manual",
          signal,
        },
      );
    } catch (error) {
      if (signal.aborted) throw error;
      throw new UpstreamError("upstream_unavailable", 503);
    }
    if (response.status >= 300 && response.status < 400)
      throw new UpstreamError("upstream_protocol", 502);
    if (
      response.headers.has("content-encoding") &&
      response.headers.get("content-encoding") !== "identity"
    )
      throw new UpstreamError("upstream_protocol", 502);
    if (
      response.status === 416 ||
      response.status === 206 ||
      response.status === 200
    )
      return response;
    classify(response.status);
  }

  async lidarrOptions(endpoint: string, key: string): Promise<LidarrOptions> {
    const option = z
      .object({ id: z.number().int().positive(), name: safeString })
      .passthrough();
    const root = z
      .object({ id: z.number().int().positive(), path: safeString })
      .passthrough();
    const load = async <T>(
      resource: "rootfolder" | "qualityprofile" | "metadataprofile",
      schema: z.ZodType<T>,
    ) => {
      try {
        return this.parse(
          z.array(schema),
          await this.lidarrGet(endpoint, key, resource),
        );
      } catch (error) {
        if (error instanceof UpstreamError)
          throw new UpstreamError(
            error.code,
            error.status,
            `Lidarr ${resource}: ${error.message}`,
          );
        throw error;
      }
    };
    const [parsedRoots, parsedQualities, parsedMetadata] = await Promise.all([
      load("rootfolder", root),
      load("qualityprofile", option),
      load("metadataprofile", option),
    ]);
    return {
      roots: parsedRoots.map((value) => ({
        id: value.id,
        name: value.path,
      })),
      qualities: parsedQualities.map((value) => ({
        id: value.id,
        name: value.name,
      })),
      metadata: parsedMetadata.map((value) => ({
        id: value.id,
        name: value.name,
      })),
    };
  }

  async lidarrAlbum(
    endpoint: string,
    key: string,
    groupMBID: string,
    releaseMBID?: string,
  ): Promise<LidarrAlbumState | null> {
    const url = pathURL(endpoint, "api/v1/album");
    url.searchParams.set("foreignAlbumId", id.parse(groupMBID));
    const schema = z.array(
      z
        .object({
          id: z.number().int().positive(),
          foreignAlbumId: id,
          monitored: z.boolean().optional(),
          anyReleaseOk: z.boolean().optional(),
          releases: z
            .array(
              z
                .object({
                  foreignReleaseId: id,
                  monitored: z.boolean().optional(),
                })
                .passthrough(),
            )
            .default([]),
          statistics: z
            .object({
              trackCount: z.number().int().nonnegative().optional(),
              trackFileCount: z.number().int().nonnegative().optional(),
            })
            .optional(),
        })
        .passthrough(),
    );
    const matches: z.infer<typeof schema> = [];
    for (const value of this.parse(
      schema,
      await this.request(url, { headers: headers({ "X-Api-Key": key }) }),
    ))
      if (value.foreignAlbumId === groupMBID.toLowerCase()) matches.push(value);
    if (matches.length === 0) return null;
    if (matches.length !== 1) throw new UpstreamError("upstream_protocol", 502);
    const value = matches[0];
    const total = value.statistics?.trackCount ?? 0;
    const files = value.statistics?.trackFileCount ?? 0;
    const edition =
      releaseMBID === undefined ||
      (value.anyReleaseOk === false &&
        value.releases.filter((release) => release.monitored === true)
          .length === 1 &&
        value.releases.some(
          (release) =>
            release.foreignReleaseId === releaseMBID.toLowerCase() &&
            release.monitored === true,
        ));
    const resource = lidarrResourceSchema.parse(value);
    return {
      id: value.id,
      monitored: value.monitored === true && edition,
      imported: total > 0 && files >= total && edition,
      resource,
    };
  }

  async lidarrLookup(
    endpoint: string,
    key: string,
    identity: Identity,
    settings: {
      rootFolderPath: string;
      qualityProfileID: number;
      metadataProfileID: number;
    },
  ): Promise<LidarrCandidate> {
    const canonical = {
      ...identity,
      artistMBID: id.parse(identity.artistMBID),
      releaseGroupMBID: id.parse(identity.releaseGroupMBID),
      releaseMBID: id.parse(identity.releaseMBID),
    };
    const url = pathURL(endpoint, "api/v1/album/lookup");
    url.searchParams.set("term", `lidarr:${canonical.releaseGroupMBID}`);
    const candidates = this.parse(
      z.array(lidarrCandidateSchema),
      await this.request(url, { headers: headers({ "X-Api-Key": key }) }),
    );
    const matches = candidates.filter(
      (value) =>
        value.foreignAlbumId.toLowerCase() === canonical.releaseGroupMBID &&
        value.artist.foreignArtistId.toLowerCase() === canonical.artistMBID,
    );
    if (
      matches.length !== 1 ||
      matches[0].releases.filter(
        (value) =>
          value.foreignReleaseId.toLowerCase() === canonical.releaseMBID,
      ).length !== 1
    )
      throw new UpstreamError("upstream_protocol", 502);
    const options = await this.lidarrOptions(endpoint, key);
    if (
      !options.roots.some((value) => value.name === settings.rootFolderPath) ||
      !options.qualities.some(
        (value) => value.id === settings.qualityProfileID,
      ) ||
      !options.metadata.some((value) => value.id === settings.metadataProfileID)
    )
      throw new UpstreamError("upstream_protocol", 400);
    const candidate = matches[0];
    const existingArtist = z
      .object({ id: z.number().int().positive() })
      .safeParse(candidate.artist);
    if (!existingArtist.success)
      candidate.artist = {
        ...candidate.artist,
        rootFolderPath: settings.rootFolderPath,
        qualityProfileId: settings.qualityProfileID,
        metadataProfileId: settings.metadataProfileID,
        monitored: false,
        monitorNewItems: "none",
        addOptions: {
          monitor: "none",
          albumsToMonitor: [],
          searchForMissingAlbums: false,
        },
      };
    return {
      ...candidate,
      monitored: true,
      anyReleaseOk: false,
      releases: candidate.releases.map((value) => ({
        ...value,
        monitored:
          value.foreignReleaseId.toLowerCase() === canonical.releaseMBID,
      })),
      addOptions: { searchForNewAlbum: false },
    };
  }

  async lidarrCreate(
    endpoint: string,
    key: string,
    candidate: LidarrCandidate,
  ): Promise<void> {
    await this.lidarrSend(endpoint, key, "album", "POST", candidate);
  }
  async lidarrMonitor(
    endpoint: string,
    key: string,
    album: LidarrAlbumState,
    releaseMBID: string,
  ): Promise<void> {
    const releaseID = id.parse(releaseMBID);
    const releases = z
      .array(z.object({ foreignReleaseId: id }).passthrough())
      .parse(album.resource.releases);
    if (
      releases.filter((release) => release.foreignReleaseId === releaseID)
        .length !== 1
    )
      throw new UpstreamError("upstream_protocol", 422);
    await this.lidarrSend(endpoint, key, `album/${album.id}`, "PUT", {
      ...album.resource,
      monitored: true,
      anyReleaseOk: false,
      releases: releases.map((value) => ({
        ...value,
        monitored: value.foreignReleaseId === releaseID,
      })),
    });
  }
  async lidarrLatestSearch(
    endpoint: string,
    key: string,
    albumID: number,
    after = 0,
  ): Promise<LidarrCommand | null> {
    const schema = z.array(
      z
        .object({
          id: z.number().int().positive(),
          name: z.string(),
          status: z.string(),
          body: z
            .object({ albumIds: z.array(z.number().int()).optional() })
            .optional(),
        })
        .passthrough(),
    );
    const matches = this.parse(
      schema,
      await this.lidarrGet(endpoint, key, "command"),
    ).filter(
      (value) =>
        value.id > after &&
        value.name === "AlbumSearch" &&
        value.body?.albumIds?.includes(albumID),
    );
    const latest = matches.sort((a, b) => b.id - a.id)[0];
    if (!latest) return null;
    const statuses = [
      "queued",
      "started",
      "completed",
      "failed",
      "aborted",
      "cancelled",
      "orphaned",
    ] as const;
    return {
      id: latest.id,
      status: statuses.find((value) => value === latest.status) ?? "unknown",
    };
  }
  async lidarrSearch(
    endpoint: string,
    key: string,
    albumID: number,
  ): Promise<number> {
    return this.parse(
      z.object({ id: z.number().int().positive() }).passthrough(),
      await this.lidarrSend(endpoint, key, "command", "POST", {
        name: "AlbumSearch",
        albumIds: [albumID],
      }),
    ).id;
  }

  async resolve(q: string): Promise<{
    items: Array<{
      id: string;
      title: string;
      artist: string;
      artistMBID: string;
    }>;
  }> {
    const url = new URL("https://musicbrainz.org/ws/2/release-group");
    url.searchParams.set("query", q);
    url.searchParams.set("fmt", "json");
    url.searchParams.set("limit", "25");
    const page = this.parse(
      z
        .object({
          "release-groups": z.array(mbGroup),
          count: z.number().int().nonnegative(),
        })
        .passthrough(),
      await this.request(url, {
        headers: headers({
          "User-Agent": "Leerr/0.1 (https://github.com/leerr-app/leerr)",
        }),
      }),
    );
    const items = [];
    for (const group of page["release-groups"]) {
      const credit = group["artist-credit"][0].artist;
      items.push({
        id: group.id,
        title: group.title,
        artist: credit.name,
        artistMBID: credit.id,
      });
    }
    return { items };
  }

  async editions(group: string): Promise<{
    items: Array<{
      id: string;
      title: string;
      date: string | null;
      country: string | null;
    }>;
  }> {
    const groupID = id.parse(group);
    const url = new URL("https://musicbrainz.org/ws/2/release");
    url.searchParams.set("release-group", groupID);
    url.searchParams.set("inc", "artist-credits");
    url.searchParams.set("fmt", "json");
    url.searchParams.set("limit", "100");
    const page = this.parse(
      z
        .object({
          releases: z.array(mbRelease),
          "release-count": z.number().int().nonnegative(),
        })
        .passthrough(),
      await this.request(url, {
        headers: headers({
          "User-Agent": "Leerr/0.1 (https://github.com/leerr-app/leerr)",
        }),
      }),
    );
    const items = [];
    for (const release of page.releases)
      items.push({
        id: release.id,
        title: release.title,
        date: release.date ?? null,
        country: release.country ?? null,
      });
    return { items };
  }

  async confirmedIdentity(
    group: string,
    release: string,
    artist: string,
  ): Promise<Identity> {
    const groupID = id.parse(group),
      releaseID = id.parse(release),
      artistID = id.parse(artist);
    const [groupBody, releaseBody] = await Promise.all([
      this.mbLookup(`release-group/${groupID}`, "artist-credits"),
      this.mbLookup(`release/${releaseID}`, "release-groups+artist-credits"),
    ]);
    const parsedGroup = this.parse(mbGroup, groupBody);
    const parsedRelease = this.parse(mbRelease, releaseBody);
    const groupArtists = parsedGroup["artist-credit"].map(
      (value) => value.artist.id,
    );
    const releaseArtists = parsedRelease["artist-credit"].map(
      (value) => value.artist.id,
    );
    if (
      parsedGroup.id !== groupID ||
      parsedRelease.id !== releaseID ||
      parsedRelease["release-group"]?.id !== groupID ||
      !groupArtists.includes(artistID) ||
      !releaseArtists.includes(artistID)
    )
      throw new UpstreamError("upstream_protocol", 422);
    const credit = parsedGroup["artist-credit"].find(
      (value) => value.artist.id === artistID,
    );
    if (!credit) throw new UpstreamError("upstream_protocol", 422);
    return {
      artistMBID: artistID,
      releaseGroupMBID: groupID,
      releaseMBID: releaseID,
      title: parsedGroup.title,
      artist: credit.artist.name,
    };
  }

  async recommendations(
    username: string,
    apiKey: string,
  ): Promise<{
    items: Array<{
      id: string;
      title: string;
      artist: string;
      artistMBID: string;
    }>;
  }> {
    const seeds = this.parse(
      z.object({
        topartists: z.object({
          artist: z
            .array(z.object({ name: safeString }).passthrough())
            .default([]),
        }),
      }),
      await this.lastfm("user.getTopArtists", apiKey, {
        user: username,
        period: "3month",
        limit: "3",
      }),
    );
    const items: Array<{
      id: string;
      title: string;
      artist: string;
      artistMBID: string;
    }> = [];
    const seen = new Set<string>();
    for (const seed of seeds.topartists.artist.slice(0, 3)) {
      const similar = this.parse(
        z.object({
          similarartists: z.object({
            artist: z
              .array(z.object({ name: safeString }).passthrough())
              .default([]),
          }),
        }),
        await this.lastfm("artist.getSimilar", apiKey, {
          artist: seed.name,
          limit: "2",
        }),
      );
      for (const suggestion of similar.similarartists.artist.slice(0, 2)) {
        const normalized = suggestion.name.toLowerCase();
        if (seen.has(normalized)) continue;
        seen.add(normalized);
        const albums = this.parse(
          z.object({
            topalbums: z.object({
              album: z
                .array(z.object({ name: safeString }).passthrough())
                .default([]),
            }),
          }),
          await this.lastfm("artist.getTopAlbums", apiKey, {
            artist: suggestion.name,
            limit: "3",
          }),
        );
        for (const album of albums.topalbums.album.slice(0, 3)) {
          if (album.name === "(null)") continue;
          const resolved = await this.resolve(
            `releasegroup:"${album.name}" AND artist:"${suggestion.name}"`,
          );
          if (resolved.items[0]) items.push(resolved.items[0]);
        }
      }
    }
    return { items };
  }

  async checkLastfm(username: string, apiKey: string): Promise<void> {
    this.parse(
      z
        .object({ user: z.object({ name: safeString }).passthrough() })
        .passthrough(),
      await this.lastfm("user.getInfo", apiKey, { user: username }),
    );
  }

  private album(item: z.infer<typeof jellyItemSchema>): Album {
    return {
      id: item.Id,
      title: item.Name,
      artist: this.artist(item),
      releaseGroupMBID: this.mbid(item.ProviderIds?.MusicBrainzReleaseGroup),
      releaseMBID: this.mbid(item.ProviderIds?.MusicBrainzAlbum),
    };
  }
  private track(item: z.infer<typeof jellyItemSchema>): Track {
    const streams =
      item.MediaStreams ??
      item.MediaSources?.flatMap((source) => source.MediaStreams ?? []) ??
      [];
    const stream = streams.find((value) => value.Type === "Audio");
    return {
      id: item.Id,
      title: item.Name,
      artist: this.artist(item),
      duration:
        item.RunTimeTicks === undefined || item.RunTimeTicks === null
          ? null
          : item.RunTimeTicks / 10_000_000,
      sourceCodec: stream?.Codec ?? null,
      sourceSampleRate: stream?.SampleRate ?? null,
      sourceBitDepth: stream?.BitDepth ?? null,
    };
  }
  private artist(item: z.infer<typeof jellyItemSchema>): string {
    const artists = item.Artists?.filter((value) => value.length > 0) ?? [];
    if (artists.length) return artists.join(", ");
    if (item.AlbumArtist) return item.AlbumArtist;
    return (item.AlbumArtists ?? [])
      .map((value) => value.Name ?? value.name ?? "")
      .join(", ");
  }
  private mbid(value: string | undefined): string | null {
    const parsed = id.safeParse(value);
    return parsed.success ? parsed.data : null;
  }
  private parse<T>(schema: z.ZodType<T>, body: JsonValue): T {
    const result = schema.safeParse(body);
    if (!result.success) throw new UpstreamError("upstream_protocol", 502);
    return result.data;
  }
  private lidarrGet(
    endpoint: string,
    key: string,
    resource: string,
  ): Promise<JsonValue> {
    return this.request(pathURL(endpoint, `api/v1/${resource}`), {
      headers: headers({ "X-Api-Key": key }),
    });
  }
  private lidarrSend<T>(
    endpoint: string,
    key: string,
    resource: string,
    method: string,
    body: T,
  ): Promise<JsonValue> {
    return this.request(pathURL(endpoint, `api/v1/${resource}`), {
      method,
      headers: headers({
        "X-Api-Key": key,
        "Content-Type": "application/json",
      }),
      body: JSON.stringify(body),
    });
  }
  private mbLookup(resource: string, inc: string): Promise<JsonValue> {
    const url = new URL(`https://musicbrainz.org/ws/2/${resource}`);
    url.searchParams.set("inc", inc);
    url.searchParams.set("fmt", "json");
    return this.request(url, {
      headers: headers({
        "User-Agent": "Leerr/0.1 (https://ampcode.com/@maxpw/leerr)",
      }),
    });
  }
  private async lastfm(
    method: string,
    apiKey: string,
    parameters: Record<string, string>,
  ): Promise<JsonValue> {
    const url = new URL("https://ws.audioscrobbler.com/2.0/");
    for (const [key, value] of Object.entries({
      method,
      api_key: apiKey,
      format: "json",
      ...parameters,
    }))
      url.searchParams.set(key, value);
    const body = await this.request(url, {}, true);
    const envelope = this.parse(
      z.object({ error: z.number().int().optional() }).passthrough(),
      body,
    );
    if (envelope.error !== undefined) {
      if (envelope.error === 10)
        throw new UpstreamError(
          "upstream_auth",
          502,
          "Last.fm error 10: invalid API key. Enter a Last.fm API key, not your password or API secret.",
        );
      if (envelope.error === 26)
        throw new UpstreamError(
          "upstream_auth",
          502,
          "Last.fm error 26: this API key is suspended. Check its status with Last.fm.",
        );
      if (envelope.error === 6)
        throw new UpstreamError(
          "upstream_protocol",
          502,
          "Last.fm error 6: check the Last.fm username; the requested profile or parameter was not found.",
        );
      if ([4, 9].includes(envelope.error))
        throw new UpstreamError(
          "upstream_auth",
          502,
          `Last.fm rejected access (API error ${envelope.error}). This connection uses a username and API key, not account-password authentication.`,
        );
      throw new UpstreamError(
        "upstream_unavailable",
        503,
        `Last.fm could not complete the request (API error ${envelope.error}).`,
      );
    }
    return body;
  }
}
