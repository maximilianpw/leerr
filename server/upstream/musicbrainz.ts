import { z } from "zod";
import { UpstreamError } from "./errors.ts";
import { HttpClient, parseBody, type JsonValue } from "./http.ts";
import type { Identity } from "./lidarr.ts";

export type AlbumCandidate = {
  /** MusicBrainz release-group id: the identity requests are keyed by. */
  id: string;
  title: string;
  artist: string;
  artistMBID: string;
  year: string | null;
  coverUrl: string | null;
};
export type CandidatePage = { items: AlbumCandidate[]; total: number };
export type ArtistMatch = {
  id: string;
  name: string;
  disambiguation: string;
  country: string;
  type: string;
};
export type Edition = {
  id: string;
  title: string;
  date: string | null;
  country: string | null;
  formats: string;
  tracks: number | null;
};

const SERVICE = "MusicBrainz";
const BASE = "https://musicbrainz.org/ws/2/";
const USER_AGENT = "Leerr/0.2 (self-hosted music requests; https://ampcode.com/@maxpw/leerr)";
// MusicBrainz allows one request per second per client.
const SPACING = 1_100;
const MAX_QUEUE = 20_000;

const mbid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const text = z.string().min(1).max(10_000);
const credit = z
  .object({ name: text.optional(), artist: z.object({ id: mbid, name: text }).loose() })
  .loose();
const group = z
  .object({
    id: mbid,
    title: text,
    "first-release-date": z.string().optional(),
    "artist-credit": z.array(credit).min(1),
  })
  .loose();
const release = z
  .object({
    id: mbid,
    title: text,
    date: z.string().nullable().optional(),
    country: z.string().nullable().optional(),
    "artist-credit": z.array(credit).min(1),
    "release-group": z.object({ id: mbid }).loose().optional(),
    media: z
      .array(
        z
          .object({
            format: z.string().nullable().optional(),
            "track-count": z.number().int().nonnegative().optional(),
          })
          .loose(),
      )
      .optional(),
  })
  .loose();

/** Quotes each term so user and provider text can never become Lucene syntax. */
export function luceneTerms(value: string): string {
  return value
    .trim()
    .split(/\s+/u)
    .filter((term) => term.length > 0)
    .map((term) => `"${term.replace(/[\\"]/g, "\\$&")}"`)
    .join(" AND ");
}

function toCandidate(value: z.infer<typeof group>): AlbumCandidate {
  const first = value["artist-credit"][0];
  const date = value["first-release-date"];
  return {
    id: value.id,
    title: value.title,
    artist: value["artist-credit"]
      .map((entry) => entry.name ?? entry.artist.name)
      .join(", "),
    artistMBID: first.artist.id,
    year: date && /^\d{4}/.test(date) ? date.slice(0, 4) : null,
    coverUrl: null,
  };
}

export class MusicBrainz {
  readonly #http: HttpClient;
  #next = 0;
  constructor(http: HttpClient) {
    this.#http = http;
  }

  async #get(path: string, parameters: Record<string, string>): Promise<JsonValue> {
    const delay = Math.max(0, this.#next - Date.now());
    if (delay > MAX_QUEUE)
      throw new UpstreamError("upstream_unavailable", 503, "MusicBrainz is busy. Try again in a few seconds.");
    this.#next = Date.now() + delay + SPACING;
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    const url = new URL(path, BASE);
    for (const [key, value] of Object.entries({ ...parameters, fmt: "json" }))
      url.searchParams.set(key, value);
    return this.#http.json(
      url,
      { headers: { Accept: "application/json", "User-Agent": USER_AGENT } },
      { service: SERVICE },
    );
  }

  async releaseGroups(query: string, offset = 0, limit = 25): Promise<CandidatePage> {
    const result = parseBody(
      z.object({ "release-groups": z.array(group), count: z.number().int().nonnegative() }).loose(),
      await this.#get("release-group", { query, offset: String(offset), limit: String(limit) }),
      SERVICE,
    );
    return { items: result["release-groups"].map(toCandidate), total: result.count };
  }

  async artists(terms: string): Promise<ArtistMatch[]> {
    const result = parseBody(
      z.object({
        artists: z.array(
          z
            .object({
              id: mbid,
              name: text,
              disambiguation: z.string().default(""),
              country: z.string().default(""),
              type: z.string().default(""),
            })
            .loose(),
        ),
      }).loose(),
      await this.#get("artist", { query: terms, limit: "10" }),
      SERVICE,
    );
    return result.artists.map((artist) => ({
      id: artist.id,
      name: artist.name,
      disambiguation: artist.disambiguation,
      country: artist.country,
      type: artist.type,
    }));
  }

  async editions(releaseGroupMBID: string): Promise<Edition[]> {
    const result = parseBody(
      z.object({ releases: z.array(release) }).loose(),
      await this.#get("release", {
        "release-group": mbid.parse(releaseGroupMBID),
        inc: "artist-credits+media",
        limit: "100",
      }),
      SERVICE,
    );
    return result.releases
      .map((value) => {
        const media = value.media ?? [];
        const counts = media.map((medium) => medium["track-count"] ?? 0);
        const formats = [...new Set(media.map((medium) => medium.format ?? "").filter((format) => format))];
        return {
          id: value.id,
          title: value.title,
          date: value.date || null,
          country: value.country || null,
          formats: formats.join(" + "),
          tracks: counts.length ? counts.reduce((sum, count) => sum + count, 0) : null,
        };
      })
      .sort((a, b) => (a.date ?? "9999").localeCompare(b.date ?? "9999"));
  }

  /** Confirms that the group, edition and artist really belong together. */
  async identity(releaseGroupMBID: string, releaseMBID: string, artistMBID: string): Promise<Identity> {
    const groupID = mbid.parse(releaseGroupMBID);
    const releaseID = mbid.parse(releaseMBID);
    const artistID = mbid.parse(artistMBID);
    const parsedGroup = parseBody(group, await this.#get(`release-group/${groupID}`, { inc: "artist-credits" }), SERVICE);
    const parsedRelease = parseBody(
      release,
      await this.#get(`release/${releaseID}`, { inc: "release-groups+artist-credits" }),
      SERVICE,
    );
    const groupCredit = parsedGroup["artist-credit"].find((entry) => entry.artist.id === artistID);
    if (
      parsedGroup.id !== groupID ||
      parsedRelease.id !== releaseID ||
      parsedRelease["release-group"]?.id !== groupID ||
      !groupCredit ||
      !parsedRelease["artist-credit"].some((entry) => entry.artist.id === artistID)
    )
      throw new UpstreamError(
        "upstream_rejected",
        422,
        "MusicBrainz does not confirm this album, edition and artist combination.",
        "not_applied",
      );
    return {
      artistMBID: artistID,
      releaseGroupMBID: groupID,
      releaseMBID: releaseID,
      title: parsedGroup.title,
      artist: groupCredit.artist.name,
    };
  }
}
