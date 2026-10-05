import { z } from "zod";
import { endpointURL, UpstreamError } from "./errors.ts";
import { HttpClient, parseBody, statusError, type JsonValue } from "./http.ts";

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
export type LidarrRelease = { id: string; monitored: boolean };
export type LidarrAlbum = {
  id: number;
  artistID: number | null;
  monitored: boolean;
  /** Lidarr imports any edition, not just the monitored one. */
  anyReleaseOk: boolean;
  /** Every track of the monitored edition has a file. Any edition counts: the album is in the library. */
  imported: boolean;
  releases: LidarrRelease[];
  resource: z.infer<typeof albumResource>;
};
/**
 * A download Lidarr is handling for an album: progressing, stalled in the
 * download client (often brief), or a problem Lidarr itself reports.
 */
export type LidarrDownload = { state: "active" | "stalled" | "problem"; detail: string };
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
const command = z
  .object({
    id: z.number().int().positive(),
    name: z.string(),
    status: z.string(),
    body: z
      .object({
        albumIds: z.array(z.number().int()).optional(),
        albumId: z.number().int().optional(),
        artistId: z.number().int().optional(),
        artistIds: z.array(z.number().int()).optional(),
      })
      .loose()
      .optional(),
  })
  .loose();
const commandList = z.array(command);
const commandStatus = (value: string): CommandStatus => commandStatuses.find((status) => status === value) ?? "unknown";
const refreshCommands = new Set(["RefreshArtist", "RefreshAlbum", "BulkRefreshArtist"]);
const queueItem = z
  .object({
    status: z.string().optional(),
    trackedDownloadStatus: z.string().optional(),
    trackedDownloadState: z.string().optional(),
    statusMessages: z
      .array(z.object({ title: z.string().optional(), messages: z.array(z.string()).optional() }).loose())
      .optional(),
    errorMessage: z.string().nullable().optional(),
  })
  .loose();
// Lidarr's TrackedDownloadState and TrackedDownloadStatus values that need a person.
const problemStates = new Set(["importBlocked", "importFailed", "downloadFailed", "downloadFailedPending"]);
const problemStatuses = new Set(["warning", "error"]);
// Download-client states; a stalled torrent reports "warning" while it waits for peers.
const stalledStatuses = new Set(["warning", "error", "failed"]);

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

  /** Lidarr's version, proving the address and key work. */
  async version(access: LidarrAccess): Promise<string> {
    return parseBody(z.object({ version: z.string() }).loose(), await this.#get(access, "system/status"), SERVICE).version;
  }

  async album(access: LidarrAccess, releaseGroupMBID: string): Promise<LidarrAlbum | null> {
    const group = mbid.parse(releaseGroupMBID);
    const url = endpointURL(access.endpoint, "api/v1/album");
    url.searchParams.set("foreignAlbumId", group);
    const schema = z.array(
      z
        .object({
          id: z.number().int().positive(),
          artistId: z.number().int().positive().optional(),
          foreignAlbumId: z.string(),
          monitored: z.boolean().optional(),
          anyReleaseOk: z.boolean().optional(),
          releases: z.array(release).default([]),
          statistics: z
            .object({
              trackCount: z.number().int().nonnegative().optional(),
              totalTrackCount: z.number().int().nonnegative().optional(),
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
    // trackCount only counts wanted tracks: for an unmonitored or undated album it
    // equals the file count as soon as one file exists. totalTrackCount does not.
    const tracks = Math.max(value.statistics?.totalTrackCount ?? 0, value.statistics?.trackCount ?? 0);
    const files = value.statistics?.trackFileCount ?? 0;
    return {
      id: value.id,
      artistID: value.artistId ?? null,
      monitored: value.monitored === true,
      anyReleaseOk: value.anyReleaseOk === true,
      imported: tracks > 0 && files >= tracks,
      releases: value.releases.map((entry) => ({
        id: entry.foreignReleaseId.toLowerCase(),
        monitored: entry.monitored === true,
      })),
      resource: albumResource.parse(value),
    };
  }

  /**
   * Builds the add payload. Lidarr discards the posted edition flags and
   * monitors its own pick once it has loaded the album, so the worker pins the
   * requested edition afterwards; until then any edition may import.
   */
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
          // Lidarr applies these after its first scan: an empty list would unmonitor this album too.
          addOptions: { monitor: "none", albumsToMonitor: [group], searchForMissingAlbums: false },
        };
    return {
      ...found,
      artist: artistPayload,
      monitored: true,
      anyReleaseOk: true,
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
    return commands.reduce((highest, entry) => Math.max(highest, entry.id), 0);
  }

  /** Newest AlbumSearch for this album with an id above `after`. */
  async latestSearch(access: LidarrAccess, albumID: number, after: number): Promise<LidarrCommand | null> {
    let latest: LidarrCommand | null = null;
    for (const entry of parseBody(commandList, await this.#get(access, "command"), SERVICE)) {
      if (
        entry.id > after &&
        entry.name === "AlbumSearch" &&
        entry.body?.albumIds?.includes(albumID) &&
        (!latest || entry.id > latest.id)
      )
        latest = { id: entry.id, status: commandStatus(entry.status) };
    }
    return latest;
  }

  /**
   * One command by id. Unlike the command list, which Lidarr empties on
   * restart, this reads Lidarr's database. Null once Lidarr has forgotten it.
   */
  async command(access: LidarrAccess, id: number): Promise<LidarrCommand | null> {
    const response = await this.#http.jsonResponse(
      endpointURL(access.endpoint, `api/v1/command/${id}`),
      { headers: { Accept: "application/json", "X-Api-Key": access.key } },
      { service: SERVICE },
    );
    if (response.status === 404) return null;
    if (response.status < 200 || response.status > 299) throw statusError(response.status, SERVICE);
    const value = parseBody(command, response.body, SERVICE);
    if (value.id !== id) throw new UpstreamError("upstream_protocol", 502, "Lidarr returned a different command.");
    return { id: value.id, status: commandStatus(value.status) };
  }

  /** Whether Lidarr is still (re)loading this album or its artist, e.g. right after an add. */
  async refreshing(access: LidarrAccess, album: LidarrAlbum): Promise<boolean> {
    return parseBody(commandList, await this.#get(access, "command"), SERVICE).some((entry) => {
      if (!refreshCommands.has(entry.name) || (entry.status !== "queued" && entry.status !== "started")) return false;
      const body = entry.body ?? {};
      // Current Lidarr sends artistIds (artistId is legacy); empty lists mean every artist.
      const scoped =
        body.albumId !== undefined ||
        (body.albumIds?.length ?? 0) > 0 ||
        body.artistId !== undefined ||
        (body.artistIds?.length ?? 0) > 0;
      // An unscoped refresh covers every artist.
      if (!scoped) return true;
      return (
        body.albumId === album.id ||
        body.albumIds?.includes(album.id) === true ||
        (album.artistID !== null && (body.artistId === album.artistID || body.artistIds?.includes(album.artistID) === true))
      );
    });
  }

  /** Downloads Lidarr is tracking for this album. */
  async downloads(access: LidarrAccess, albumID: number): Promise<LidarrDownload[]> {
    const url = endpointURL(access.endpoint, "api/v1/queue/details");
    url.searchParams.set("albumIds", String(albumID));
    url.searchParams.set("includeAlbum", "false");
    return parseBody(z.array(queueItem), await this.#get(access, "queue/details", url), SERVICE).map((item) => {
      const state = item.trackedDownloadState ?? "";
      const tracked = (item.trackedDownloadStatus ?? "").toLowerCase();
      const client = (item.status ?? "").toLowerCase();
      const problem = problemStates.has(state) || problemStatuses.has(tracked);
      const stalled = !problem && stalledStatuses.has(client);
      const message = item.errorMessage || item.statusMessages?.flatMap((entry) => entry.messages ?? [])[0] || "";
      return {
        state: problem ? "problem" : stalled ? "stalled" : "active",
        detail: (message || state || client || "queued").slice(0, 200),
      };
    });
  }

  async search(access: LidarrAccess, albumID: number): Promise<number> {
    return parseBody(
      z.object({ id: z.number().int().positive() }).loose(),
      await this.#send(access, "command", "POST", JSON.stringify({ name: "AlbumSearch", albumIds: [albumID] })),
      SERVICE,
    ).id;
  }
}
