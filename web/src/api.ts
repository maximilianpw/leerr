// zod/mini: the same boundary parsing as the server, at a fraction of the bundle size.
import * as z from "zod/mini";

const BASE = "/api/v1";

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

type SessionHooks = {
  /** The session ended (401): sign the person out. */
  unauthorized: () => void;
  /** The server refused for permission or CSRF reasons: the role or token may have changed. */
  stale: () => void;
};
let csrfToken = "";
let hooks: SessionHooks = { unauthorized: () => {}, stale: () => {} };
// Requests started under an earlier session must not end the current one.
let generation = 0;

/** Called by the session layer: the CSRF token for writes, and what to do when the session changes. */
export function configureApi(csrf: string, next: SessionHooks) {
  csrfToken = csrf;
  hooks = next;
  generation++;
}

const errorBody = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
const empty = z.looseObject({});
type Json = z.infer<ReturnType<typeof z.json>>;

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type RequestOptions = { method?: Method; body?: string; signal?: AbortSignal };

export async function request<T>(path: string, schema: z.ZodMiniType<T>, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? "GET";
  const headers = new Headers({ Accept: "application/json" });
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  if (method !== "GET" && csrfToken) headers.set("X-CSRF-Token", csrfToken);
  const sentIn = generation;
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, { method, body: options.body, headers, credentials: "same-origin", signal: options.signal });
  } catch (caught) {
    if (caught instanceof DOMException && caught.name === "AbortError") throw caught;
    throw new ApiError(0, "network", "Leerr is unreachable. Check your connection and try again.");
  }
  const text = await response.text();
  let body: Json = {};
  try {
    body = text ? z.json().parse(JSON.parse(text)) : {};
  } catch {
    body = {};
  }
  if (!response.ok) {
    const parsed = errorBody.safeParse(body);
    const error = parsed.success
      ? new ApiError(response.status, parsed.data.error.code, parsed.data.error.message)
      : response.status >= 502 && response.status <= 504
        ? // A proxy's own error page: Leerr itself is down or restarting.
          new ApiError(response.status, "unavailable", "Leerr is restarting or unreachable. Try again in a moment.")
        : new ApiError(response.status, "unexpected", "Something went wrong. Please try again.");
    // A wrong password at sign-in is a 401 too, but no session has ended.
    const signingIn = path === "/sessions" && method === "POST";
    if (sentIn === generation) {
      if (response.status === 401 && !signingIn) hooks.unauthorized();
      else if (response.status === 403 && (error.code === "forbidden" || error.code === "csrf")) hooks.stale();
    }
    throw error;
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success)
    throw new ApiError(response.status, "unexpected_response", "Leerr sent a response this page does not understand. Reload the page.");
  return parsed.data;
}

export const send = (path: string, method: Method, body?: Json) =>
  request(path, empty, { method, body: body === undefined ? undefined : JSON.stringify(body) });

/**
 * A write whose outcome nobody waits for (playback reports). `keepalive` lets
 * it finish while the page unloads; sendBeacon cannot carry the CSRF header.
 */
const playbackReply = z.object({ stop: z.optional(z.string()) });

/**
 * Reports playback; best effort, never rejects. Resolves with Plex's reason
 * when it ended this playback (for example its owner stopped it), else null.
 */
export async function reportPlayback(body: Json, keepalive: boolean): Promise<string | null> {
  const headers = new Headers({ Accept: "application/json", "Content-Type": "application/json" });
  if (csrfToken) headers.set("X-CSRF-Token", csrfToken);
  try {
    const response = await fetch(`${BASE}/playback`, { method: "POST", body: JSON.stringify(body), headers, credentials: "same-origin", keepalive });
    if (!response.ok) return null;
    const parsed = playbackReply.safeParse(await response.json());
    return parsed.success ? (parsed.data.stop ?? null) : null;
  } catch {
    return null;
  }
}

/** Best effort by design: resolves when the request is done, and never rejects. */
export async function sendInBackground(path: string, body: Json, keepalive = false): Promise<void> {
  const headers = new Headers({ Accept: "application/json", "Content-Type": "application/json" });
  if (csrfToken) headers.set("X-CSRF-Token", csrfToken);
  try {
    await fetch(`${BASE}${path}`, { method: "POST", body: JSON.stringify(body), headers, credentials: "same-origin", keepalive });
  } catch {
    // Reports and marks are conveniences; nothing waits on their outcome.
  }
}

/** Why a stream URL fails, from the server's error envelope; null when it serves audio. */
export async function streamProblem(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, { headers: { Range: "bytes=0-0" }, credentials: "same-origin" });
    if (response.ok) {
      await response.body?.cancel();
      return null;
    }
    const parsed = errorBody.safeParse(await response.json());
    return parsed.success ? parsed.data.error.message : `Leerr could not stream this track (HTTP ${response.status}).`;
  } catch {
    return "Leerr is unreachable. Check your connection and try again.";
  }
}

export const errorMessage = (cause: unknown, fallback = "Something went wrong.") =>
  cause instanceof Error ? cause.message : fallback;
export const isAbort = (cause: unknown) => cause instanceof DOMException && cause.name === "AbortError";
export const errorCode = (cause: unknown) => (cause instanceof ApiError ? cause.code : null);

// Response contracts (see docs/openapi.yaml)

const nullableString = z.nullable(z.string());
const nullableNumber = z.nullable(z.number());

export const roleSchema = z.enum(["admin", "member"]);
export const userSchema = z.object({ id: z.string(), username: z.string(), role: roleSchema });
export type User = z.infer<typeof userSchema>;
export const meSchema = z.object({ user: userSchema, csrf: nullableString });
export const setupSchema = z.object({ required: z.boolean(), fixturePreview: z.boolean() });

export const albumSchema = z.object({
  id: z.string(),
  title: z.string(),
  artist: z.string(),
  artistID: nullableString,
  artistMBID: nullableString,
  year: nullableNumber,
  releaseGroupMBID: nullableString,
  releaseMBID: nullableString,
  hasArtwork: z.boolean(),
  favorite: z.boolean(),
  /** False for albums in Plex's trash: their files are gone. */
  available: z.boolean(),
});
export type Album = z.infer<typeof albumSchema>;
export const libraryPageSchema = z.object({ items: z.array(albumSchema), total: z.number() });
export const librarySorts = ["title", "artist", "year", "added"] as const;
export type LibrarySort = (typeof librarySorts)[number];
export const artistPageSchema = z.object({
  items: z.array(z.object({ id: z.string(), name: z.string(), hasArtwork: z.boolean() })),
  total: z.number(),
});
export const trackSchema = z.object({
  id: z.string(),
  title: z.string(),
  artist: z.string(),
  albumID: nullableString,
  albumTitle: nullableString,
  disc: nullableNumber,
  number: nullableNumber,
  duration: nullableNumber,
  codec: nullableString,
  sampleRate: nullableNumber,
  bitDepth: nullableNumber,
  favorite: z.boolean(),
  /** False for tracks in Plex's trash. */
  available: z.boolean(),
});
export type Track = z.infer<typeof trackSchema>;
export const albumDetailSchema = z.object({ album: albumSchema, tracks: z.array(trackSchema) });
export const playlistSchema = z.object({
  id: z.string(),
  name: z.string(),
  tracks: nullableNumber,
  duration: nullableNumber,
  hasArtwork: z.boolean(),
  /** Plex fills smart playlists from rules: tracks cannot be added to them. */
  smart: z.boolean(),
});
export type Playlist = z.infer<typeof playlistSchema>;
export const playlistsSchema = z.object({ items: z.array(playlistSchema) });
export const playlistDetailSchema = z.object({ playlist: playlistSchema, tracks: z.array(trackSchema) });
export const ticketSchema = z.object({
  url: z.string(),
  expiresAt: z.string(),
  /** Plex converts this track for the browser: the stream cannot be ranged, so seeking asks for a new start. */
  transcoded: z.boolean(),
});

export const candidateSchema = z.object({
  id: z.string(),
  title: z.string(),
  artist: z.string(),
  artistMBID: z.string(),
  year: nullableString,
  date: nullableString,
  primaryType: nullableString,
  secondaryTypes: z.array(z.string()),
  coverUrl: nullableString,
  status: z.nullable(z.enum(["available", "requested"])),
  albumID: nullableString,
});
export type Candidate = z.infer<typeof candidateSchema>;
export const artistSchema = z.object({
  id: z.string(),
  name: z.string(),
  disambiguation: z.string(),
  country: z.string(),
  type: z.string(),
});
export type Artist = z.infer<typeof artistSchema>;
export const candidatePageSchema = z.object({ items: z.array(candidateSchema), total: z.number() });
export const artistAlbumsSchema = z.extend(candidatePageSchema, { pageSize: z.number() });
export const albumTypes = ["studio", "ep", "live", "compilation", "all"] as const;
export type AlbumType = (typeof albumTypes)[number];
export const searchSchema = z.extend(candidatePageSchema, { artists: z.array(artistSchema) });
export const recommendationsSchema = z.object({
  items: z.array(candidateSchema),
  source: z.enum(["lastfm", "library", "musicbrainz"]),
  emptyReason: z.nullable(z.enum(["no_candidates", "all_excluded"])),
});
export const newReleasesSchema = z.object({ items: z.array(candidateSchema) });
export const editionSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: nullableString,
  disambiguation: z.string(),
  date: nullableString,
  country: nullableString,
  formats: z.string(),
  tracks: nullableNumber,
});
export type Edition = z.infer<typeof editionSchema>;
export const editionsSchema = z.object({ items: z.array(editionSchema), total: z.number() });
export const requestCreatedSchema = z.object({
  id: z.string(),
  edition: z.string(),
  alreadyRequested: z.boolean(),
  sharedEdition: z.boolean(),
});

export const acquisitionStatusSchema = z.enum(["requested", "acquiring", "imported", "failed", "attention"]);
export const requestStatusSchema = z.enum([...acquisitionStatusSchema.options, "available"]);
export type RequestStatus = z.infer<typeof requestStatusSchema>;
export const requestItemSchema = z.object({
  id: z.string(),
  releaseGroupMBID: z.string(),
  releaseMBID: z.string(),
  title: z.string(),
  artist: z.string(),
  status: requestStatusSchema,
  /** An outcome this person has not seen on the Requests page yet. */
  unseen: z.boolean(),
  reason: nullableString,
  retryable: z.boolean(),
  albumID: nullableString,
  /** An arrived album Plex has not matched to this request's album (Fix Match in Plex). */
  unmatchedAlbumID: nullableString,
  requestedAt: z.string(),
  updatedAt: z.string(),
});
export type RequestItem = z.infer<typeof requestItemSchema>;
export const requestsSchema = z.object({
  items: z.array(requestItemSchema),
  libraryChecked: z.boolean(),
  library: z.nullable(z.object({ albums: z.number(), unmatched: z.number() })),
});

export const connectionsSchema = z.object({
  plexConfigured: z.boolean(),
  plex: z.nullable(z.object({ username: z.string(), managed: z.boolean() })),
  plexValid: z.nullable(z.boolean()),
  lastfm: nullableString,
  lastfmKeyProvided: z.boolean(),
  lidarrConfigured: z.boolean(),
  lidarrReady: z.boolean(),
});
export type Connections = z.infer<typeof connectionsSchema>;
export const sessionsSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      device: z.enum(["web", "native"]),
      createdAt: z.string(),
      expiresAt: z.string(),
      current: z.boolean(),
    }),
  ),
});
export const notifyFormats = ["ntfy", "discord", "json"] as const;
export const plexLinkStartSchema = z.object({ id: z.string(), authURL: z.string(), expiresAt: z.string() });
export const plexLinkSchema = z.object({
  state: z.enum(["waiting", "choose_profile", "linked", "expired", "no_access", "no_profiles", "in_use"]),
  mode: z.enum(["own", "managed"]),
  username: nullableString,
  profiles: z.array(z.object({ uuid: z.string(), name: z.string(), protected: z.boolean() })),
  expiresAt: z.string(),
});
export type PlexLink = z.infer<typeof plexLinkSchema>;
export const plexSectionsSchema = z.object({
  items: z.array(z.object({ key: z.string(), title: z.string(), agent: z.string(), scanner: z.string() })),
  selected: nullableString,
});
export const adminSettingsSchema = z.object({
  plexURL: nullableString,
  plexSection: nullableString,
  lidarrURL: nullableString,
  lidarrConfigured: z.boolean(),
  lidarrReady: z.boolean(),
  rootFolderPath: nullableString,
  qualityProfileID: nullableNumber,
  metadataProfileID: nullableNumber,
  lastfmConfigured: z.boolean(),
  notifyTarget: nullableString,
  notifyFormat: z.enum(notifyFormats),
  notifyTokenSet: z.boolean(),
});
export type AdminSettings = z.infer<typeof adminSettingsSchema>;
const option = z.object({ id: z.number(), name: z.string() });
export const lidarrOptionsSchema = z.object({
  roots: z.array(z.object({ id: z.number(), path: z.string() })),
  qualities: z.array(option),
  metadata: z.array(option),
});
export type LidarrOptions = z.infer<typeof lidarrOptionsSchema>;
export const usersSchema = z.object({
  items: z.array(
    z.extend(userSchema, {
      disabled: z.boolean(),
      createdAt: z.string(),
      plex: z.nullable(z.object({ username: z.string(), managed: z.boolean() })),
    }),
  ),
});
export const acquisitionsSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      releaseGroupMBID: z.string(),
      releaseMBID: z.string(),
      title: z.string(),
      artist: z.string(),
      status: acquisitionStatusSchema,
      reason: nullableString,
      phase: z.string(),
      requesters: z.number(),
      retryable: z.boolean(),
      updatedAt: z.string(),
    }),
  ),
});
const probeSchema = z.object({
  state: z.enum(["ok", "error", "unconfigured"]),
  message: z.string(),
  version: nullableString,
  latencyMs: nullableNumber,
});
export type Probe = z.infer<typeof probeSchema>;
export const statusSchema = z.object({
  plex: probeSchema,
  lidarr: probeSchema,
  lidarrReady: z.boolean(),
  worker: z.object({
    lastPassAt: nullableString,
    lastError: nullableString,
    lastErrorAt: nullableString,
    pendingChanges: z.number(),
  }),
  acquisitions: z.object({
    requested: z.number(),
    acquiring: z.number(),
    imported: z.number(),
    failed: z.number(),
    attention: z.number(),
  }),
  streams: z.number(),
  startedAt: z.string(),
  lastBackup: z.nullable(z.object({ at: z.string(), ok: z.boolean() })),
});

export type ArtworkSize = "small" | "medium" | "large";
export const artworkURL = (itemID: string, size: ArtworkSize = "medium") =>
  `${BASE}/artwork/${encodeURIComponent(itemID)}?size=${size}`;
export const coverArtURL = (kind: "release-group" | "release", id: string) =>
  `https://coverartarchive.org/${kind}/${encodeURIComponent(id)}/front-500`;
