import { z } from "zod";

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

let csrfToken = "";
let onUnauthorized: () => void = () => {};

/** Called by the session layer: the CSRF token for writes, and what to do when a session ends. */
export function configureApi(csrf: string, unauthorized: () => void) {
  csrfToken = csrf;
  onUnauthorized = unauthorized;
}

const errorBody = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
const empty = z.object({}).loose();

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type RequestOptions = { method?: Method; body?: string; signal?: AbortSignal };

export async function request<T>(path: string, schema: z.ZodType<T>, options: RequestOptions = {}): Promise<T> {
  const headers = new Headers({ Accept: "application/json" });
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  if (options.method && options.method !== "GET" && csrfToken) headers.set("X-CSRF-Token", csrfToken);
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method: options.method ?? "GET",
      body: options.body,
      headers,
      credentials: "same-origin",
      signal: options.signal,
    });
  } catch (caught) {
    if (caught instanceof DOMException && caught.name === "AbortError") throw caught;
    throw new ApiError(0, "network", "Leerr is unreachable. Check your connection and try again.");
  }
  const text = await response.text();
  let body: z.infer<ReturnType<typeof z.json>> = {};
  try {
    body = text ? z.json().parse(JSON.parse(text)) : {};
  } catch {
    body = {};
  }
  if (!response.ok) {
    const parsed = errorBody.safeParse(body);
    const error = parsed.success
      ? new ApiError(response.status, parsed.data.error.code, parsed.data.error.message)
      : new ApiError(response.status, "unexpected", "Something went wrong. Please try again.");
    if (response.status === 401 && path !== "/sessions") onUnauthorized();
    throw error;
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ApiError(response.status, "unexpected_response", "Leerr sent a response this page does not understand. Reload the page.");
  return parsed.data;
}

export const send = (path: string, method: Method, body?: z.infer<ReturnType<typeof z.json>>) =>
  request(path, empty, { method, body: body === undefined ? undefined : JSON.stringify(body) });

export const errorMessage = (cause: unknown, fallback = "Something went wrong.") =>
  cause instanceof Error ? cause.message : fallback;
export const isAbort = (cause: unknown) => cause instanceof DOMException && cause.name === "AbortError";

// Response contracts (see docs/openapi.yaml)

export const roleSchema = z.enum(["admin", "member"]);
export const userSchema = z.object({ id: z.string(), username: z.string(), role: roleSchema });
export type User = z.infer<typeof userSchema>;
export const meSchema = z.object({ user: userSchema, csrf: z.string().nullable() });
export const setupSchema = z.object({ required: z.boolean(), fixturePreview: z.boolean() });

export const albumSchema = z.object({
  id: z.string(),
  title: z.string(),
  artist: z.string(),
  year: z.number().nullable(),
  releaseGroupMBID: z.string().nullable(),
  releaseMBID: z.string().nullable(),
});
export type Album = z.infer<typeof albumSchema>;
export const libraryPageSchema = z.object({ items: z.array(albumSchema), total: z.number() });
export const trackSchema = z.object({
  id: z.string(),
  title: z.string(),
  artist: z.string(),
  disc: z.number().nullable(),
  number: z.number().nullable(),
  duration: z.number().nullable(),
  codec: z.string().nullable(),
  sampleRate: z.number().nullable(),
  bitDepth: z.number().nullable(),
});
export type Track = z.infer<typeof trackSchema>;
export const albumDetailSchema = z.object({ album: albumSchema, tracks: z.array(trackSchema) });
export const ticketSchema = z.object({ url: z.string(), expiresAt: z.string() });

export const candidateSchema = z.object({
  id: z.string(),
  title: z.string(),
  artist: z.string(),
  artistMBID: z.string(),
  year: z.string().nullable(),
  coverUrl: z.string().nullable(),
  status: z.enum(["available", "requested"]).nullable(),
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
export const searchSchema = candidatePageSchema.extend({ artists: z.array(artistSchema) });
export const recommendationsSchema = z.object({
  items: z.array(candidateSchema),
  source: z.enum(["lastfm", "musicbrainz"]),
  emptyReason: z.enum(["no_candidates", "all_excluded"]).nullable(),
});
export const editionSchema = z.object({
  id: z.string(),
  title: z.string(),
  date: z.string().nullable(),
  country: z.string().nullable(),
  formats: z.string(),
  tracks: z.number().nullable(),
});
export type Edition = z.infer<typeof editionSchema>;
export const editionsSchema = z.object({ items: z.array(editionSchema) });
export const requestCreatedSchema = z.object({ id: z.string(), edition: z.string(), sharedEdition: z.boolean() });

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
  reason: z.string().nullable(),
  retryable: z.boolean(),
  albumID: z.string().nullable(),
  requestedAt: z.string(),
  updatedAt: z.string(),
});
export type RequestItem = z.infer<typeof requestItemSchema>;
export const requestsSchema = z.object({ items: z.array(requestItemSchema), libraryChecked: z.boolean() });

export const connectionsSchema = z.object({
  jellyfinConfigured: z.boolean(),
  jellyfin: z.string().nullable(),
  lastfm: z.string().nullable(),
  lidarrConfigured: z.boolean(),
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
export const adminSettingsSchema = z.object({
  jellyfinURL: z.string().nullable(),
  lidarrURL: z.string().nullable(),
  lidarrConfigured: z.boolean(),
  rootFolderPath: z.string().nullable(),
  qualityProfileID: z.number().nullable(),
  metadataProfileID: z.number().nullable(),
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
  items: z.array(userSchema.extend({ disabled: z.boolean(), createdAt: z.string() })),
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
      reason: z.string().nullable(),
      phase: z.string(),
      requesters: z.number(),
      retryable: z.boolean(),
      updatedAt: z.string(),
    }),
  ),
});

export const artworkURL = (albumID: string) => `${BASE}/artwork/${encodeURIComponent(albumID)}`;
export const coverArtURL = (kind: "release-group" | "release", id: string) =>
  `https://coverartarchive.org/${kind}/${encodeURIComponent(id)}/front-500`;
