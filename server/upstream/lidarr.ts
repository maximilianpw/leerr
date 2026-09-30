import { z } from "zod";
import { endpointURL, UpstreamError } from "./errors.ts";
import { HttpClient, parseBody, type JsonValue } from "./http.ts";

export type LidarrAccess = { endpoint: string; key: string };
export type LidarrProfile = {
  rootFolderPath: string;
  qualityProfileID: number;
  metadataProfileID: number;
};
export type LidarrOptions = {
  roots: Array<{ id: number; path: string }>;
  qualities: Array<{ id: number; name: string }>;
  metadata: Array<{ id: number; name: string }>;
};
export type Identity = {
  artistMBID: string;
  releaseGroupMBID: string;
  releaseMBID: string;
  title: string;
  artist: string;
};

const SERVICE = "Lidarr";
// Mutations can make Lidarr fetch artist metadata before answering.
const MUTATION_TIMEOUT = 45_000;
const mbid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const text = z.string().min(1).max(10_000);
const release = z
  .object({ foreignReleaseId: z.string(), monitored: z.boolean().optional() })
  .loose();
const candidate = z
  .object({
    foreignAlbumId: z.string(),
    artist: z.object({ foreignArtistId: z.string() }).loose(),
    releases: z.array(release).default([]),
  })
  .loose();
const albumResource = candidate.omit({ artist: true });
export type LidarrCandidate = z.infer<typeof candidate>;
export type LidarrAlbum = {
  id: number;
  monitored: boolean;
  /** Every track has a file. Any edition counts: the album is in the library. */
  imported: boolean;
  resource: z.infer<typeof albumResource>;
};
export type CommandStatus =
  | "queued"
  | "started"
  | "completed"
  | "failed"
  | "aborted"
  | "cancelled"
  | "orphaned"
  | "unknown";
export type LidarrCommand = { id: number; status: CommandStatus };

const commandStatuses: readonly CommandStatus[] = [
  "queued",
  "started",
  "completed",
  "failed",
  "aborted",
  "cancelled",
  "orphaned",
];
const commandList = z.array(
  z
    .object({
      id: z.number().int().positive(),
      name: z.string(),
      status: z.string(),
      body: z.object({ albumIds: z.array(z.number().int()).optional() }).loose().optional(),
    })
    .loose(),
);

export class Lidarr {
  readonly #http: HttpClient;
  constructor(http: HttpClient) {
    this.#http = http;
  }

  #get(access: LidarrAccess, path: string, url = endpointURL(access.endpoint, `api/v1/${path}`)): Promise<JsonValue> {
    return this.#http.json(
      url,
      { headers: { Accept: "application/json", "X-Api-Key": access.key } },
      { service: SERVICE },
    );
  }
  #send(access: LidarrAccess, path: string, method: "POST" | "PUT", body: string): Promise<JsonValue> {
    return this.#http.json(
      endpointURL(access.endpoint, `api/v1/${path}`),
      {
        method,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Api-Key": access.key,
        },
        body,
      },
      { service: SERVICE, timeoutMs: MUTATION_TIMEOUT },
    );
  }

  async options(access: LidarrAccess): Promise<LidarrOptions> {
    const option = z.object({ id: z.number().int().positive(), name: text }).loose();
    const root = z.object({ id: z.number().int().positive(), path: text }).loose();
    const load = async <T>(resource: string, schema: z.ZodType<T>): Promise<T[]> => {
      try {
        return parseBody(z.array(schema), await this.#get(access, resource), SERVICE);
      } catch (cause) {
        if (cause instanceof UpstreamError)
          throw new UpstreamError(cause.code, cause.status, `Lidarr ${resource}: ${cause.message}`, cause.outcome);
        throw cause;
      }
    };
    const [roots, qualities, metadata] = await Promise.all([
      load("rootfolder", root),
      load("qualityprofile", option),
      load("metadataprofile", option),
    ]);
    return {
      roots: roots.map((value) => ({ id: value.id, path: value.path })),
      qualities: qualities.map((value) => ({ id: value.id, name: value.name })),
      metadata: metadata.map((value) => ({ id: value.id, name: value.name })),
    };
  }

  async album(access: LidarrAccess, releaseGroupMBID: string): Promise<LidarrAlbum | null> {
    const group = mbid.parse(releaseGroupMBID);
    const url = endpointURL(access.endpoint, "api/v1/album");
    url.searchParams.set("foreignAlbumId", group);
    const schema = z.array(
      z
        .object({
          id: z.number().int().positive(),
          foreignAlbumId: z.string(),
          monitored: z.boolean().optional(),
          releases: z.array(release).default([]),
          statistics: z
            .object({
              trackCount: z.number().int().nonnegative().optional(),
              trackFileCount: z.number().int().nonnegative().optional(),
            })
            .loose()
            .optional(),
        })
        .loose(),
    );
    const matches = parseBody(schema, await this.#get(access, "album", url), SERVICE).filter(
      (value) => value.foreignAlbumId.toLowerCase() === group,
    );
    if (matches.length === 0) return null;
    if (matches.length > 1)
      throw new UpstreamError("upstream_protocol", 502, "Lidarr lists this album more than once.");
    const value = matches[0];
    const tracks = value.statistics?.trackCount ?? 0;
    const files = value.statistics?.trackFileCount ?? 0;
    return {
      id: value.id,
      monitored: value.monitored === true,
      imported: tracks > 0 && files >= tracks,
      resource: albumResource.parse(value),
    };
  }

  /** Builds the add payload: only this album and exactly one edition are monitored. */
  async lookup(access: LidarrAccess, identity: Identity, profile: LidarrProfile): Promise<LidarrCandidate> {
    const group = mbid.parse(identity.releaseGroupMBID);
    const artist = mbid.parse(identity.artistMBID);
    const edition = mbid.parse(identity.releaseMBID);
    const options = await this.options(access);
    if (
      !options.roots.some((value) => value.path === profile.rootFolderPath) ||
      !options.qualities.some((value) => value.id === profile.qualityProfileID) ||
      !options.metadata.some((value) => value.id === profile.metadataProfileID)
    )
      throw new UpstreamError(
        "upstream_rejected",
        409,
        "Lidarr settings are incomplete. An administrator must choose a root folder and profiles.",
        "not_applied",
      );
    const url = endpointURL(access.endpoint, "api/v1/album/lookup");
    url.searchParams.set("term", `lidarr:${group}`);
    const matches = parseBody(z.array(candidate), await this.#get(access, "album/lookup", url), SERVICE).filter(
      (value) =>
        value.foreignAlbumId.toLowerCase() === group &&
        value.artist.foreignArtistId.toLowerCase() === artist,
    );
    if (
      matches.length !== 1 ||
      matches[0].releases.filter((value) => value.foreignReleaseId.toLowerCase() === edition).length !== 1
    )
      throw new UpstreamError(
        "upstream_rejected",
        404,
        "Lidarr's metadata does not contain this edition yet.",
        "not_applied",
      );
    const found = matches[0];
    const existingArtist = z.object({ id: z.number().int().positive() }).loose().safeParse(found.artist);
    const artistPayload = existingArtist.success
      ? found.artist
      : {
          ...found.artist,
          rootFolderPath: profile.rootFolderPath,
          qualityProfileId: profile.qualityProfileID,
          metadataProfileId: profile.metadataProfileID,
          monitored: false,
          monitorNewItems: "none",
          addOptions: { monitor: "none", albumsToMonitor: [], searchForMissingAlbums: false },
        };
    return {
      ...found,
      artist: artistPayload,
      monitored: true,
      anyReleaseOk: false,
      releases: found.releases.map((value) => ({
        ...value,
        monitored: value.foreignReleaseId.toLowerCase() === edition,
      })),
      addOptions: { searchForNewAlbum: false },
    };
  }

  async create(access: LidarrAccess, payload: LidarrCandidate): Promise<void> {
    await this.#send(access, "album", "POST", JSON.stringify(payload));
  }

  /** Monitors an unmonitored album, pinning the requested edition. */
  async monitor(access: LidarrAccess, album: LidarrAlbum, releaseMBID: string): Promise<void> {
    const edition = mbid.parse(releaseMBID);
    if (album.resource.releases.filter((value) => value.foreignReleaseId.toLowerCase() === edition).length !== 1)
      throw new UpstreamError(
        "upstream_rejected",
        404,
        "Lidarr's copy of this album does not include the requested edition.",
        "not_applied",
      );
    await this.#send(access, `album/${album.id}`, "PUT", JSON.stringify({
      ...album.resource,
      monitored: true,
      anyReleaseOk: false,
      releases: album.resource.releases.map((value) => ({
        ...value,
        monitored: value.foreignReleaseId.toLowerCase() === edition,
      })),
    }));
  }

  /** Highest command id Lidarr currently remembers; searches issued later exceed it. */
  async latestCommandID(access: LidarrAccess): Promise<number> {
    const commands = parseBody(commandList, await this.#get(access, "command"), SERVICE);
    return commands.reduce((highest, command) => Math.max(highest, command.id), 0);
  }

  /** Newest AlbumSearch for this album with an id above `after`. */
  async latestSearch(access: LidarrAccess, albumID: number, after: number): Promise<LidarrCommand | null> {
    let latest: LidarrCommand | null = null;
    for (const command of parseBody(commandList, await this.#get(access, "command"), SERVICE)) {
      if (
        command.id > after &&
        command.name === "AlbumSearch" &&
        command.body?.albumIds?.includes(albumID) &&
        (!latest || command.id > latest.id)
      )
        latest = {
          id: command.id,
          status: commandStatuses.find((status) => status === command.status) ?? "unknown",
        };
    }
    return latest;
  }

  async search(access: LidarrAccess, albumID: number): Promise<number> {
    return parseBody(
      z.object({ id: z.number().int().positive() }).loose(),
      await this.#send(access, "command", "POST", JSON.stringify({ name: "AlbumSearch", albumIds: [albumID] })),
      SERVICE,
    ).id;
  }
}
