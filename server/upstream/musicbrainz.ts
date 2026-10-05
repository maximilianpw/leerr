import { z } from "zod";
import { UpstreamError } from "./errors.ts";
import { HttpClient, parseBody, statusError, type JsonValue } from "./http.ts";
import type { Identity } from "./lidarr.ts";

export type AlbumCandidate = {
  /** MusicBrainz release-group id: the identity requests are keyed by. */
  id: string;
  title: string;
  artist: string;
  artistMBID: string;
  year: string | null;
  /** First release date as MusicBrainz records it (YYYY, YYYY-MM or YYYY-MM-DD). */
  date: string | null;
  primaryType: string | null;
  secondaryTypes: string[];
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
  /** e.g. "Official", "Bootleg", "Promotion". */
  status: string | null;
  /** MusicBrainz's note telling editions apart, e.g. "2017 remaster". */
  disambiguation: string;
  date: string | null;
  country: string | null;
  formats: string;
  tracks: number | null;
};
export type EditionList = { items: Edition[]; total: number };

const SERVICE = "MusicBrainz";
const BASE = "https://musicbrainz.org/ws/2/";
const USER_AGENT = "Leerr/0.3 (self-hosted music requests; https://ampcode.com/@maxpw/leerr)";
// MusicBrainz allows one request per second per client.
const SPACING = 1_100;
const MAX_QUEUE = 20_000;
/** Each page of editions costs one rate-limited call. */
const MAX_EDITIONS = 300;
/** Releases resolved per search call; MusicBrainz returns at most 100 results. */
const RELEASE_BATCH = 100;
/** Releases a search missed (new, or merged into another id) that are then looked up one by one. */
const MAX_SINGLE_LOOKUPS = 10;

const mbid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const text = z.string().min(1).max(10_000);
const credit = z
  .object({
    name: text.optional(),
    // Not `text`: MusicBrainz sends "" between and after credits.
    joinphrase: z.string().max(10_000).optional(),
    artist: z.object({ id: mbid, name: text }).loose(),
  })
  .loose();
const group = z
  .object({
    id: mbid,
    title: text,
    "first-release-date": z.string().optional(),
    "primary-type": z.string().nullable().optional(),
    "secondary-types": z.array(z.string()).nullable().optional(),
    "artist-credit": z.array(credit).min(1),
  })
  .loose();
const release = z
  .object({
    id: mbid,
    title: text,
    status: z.string().nullable().optional(),
    disambiguation: z.string().nullable().optional(),
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

/** The artist credit as printed, e.g. "Greenhouse Effect vs. Radiohead". */
export function creditedName(credits: Array<z.infer<typeof credit>>): string {
  return credits
    .map((entry) => `${entry.name ?? entry.artist.name}${entry.joinphrase ?? ""}`)
    .join("")
    .trim();
}

function toCandidate(value: z.infer<typeof group>): AlbumCandidate {
  const first = value["artist-credit"][0];
  const date = value["first-release-date"];
  return {
    id: value.id,
    title: value.title,
    artist: creditedName(value["artist-credit"]),
    artistMBID: first.artist.id,
    year: date && /^\d{4}/.test(date) ? date.slice(0, 4) : null,
    date: date && /^\d{4}/.test(date) ? date : null,
    primaryType: value["primary-type"] ?? null,
    secondaryTypes: value["secondary-types"] ?? [],
    coverUrl: null,
  };
}

/** MusicBrainz failed part-way through: what was resolved before is kept, the rest waits for a later call. */
export class PartialReleaseLookup extends UpstreamError {
  readonly resolved: Map<string, string | null>;
  constructor(cause: UpstreamError, resolved: Map<string, string | null>) {
    super(cause.code, cause.status, cause.message, cause.outcome);
    this.resolved = resolved;
  }
}

export class MusicBrainz {
  readonly #http: HttpClient;
  /** Monotonic: a wall-clock step backwards must not stall every call. */
  readonly #clock: () => number;
  #next = 0;
  constructor(http: HttpClient, clock: () => number = () => performance.now()) {
    this.#http = http;
    this.#clock = clock;
  }

  /** Waits for this call's turn: every call, of every kind, shares one rate limit. */
  async #turn(path: string, parameters: Record<string, string>): Promise<URL> {
    const delay = Math.max(0, this.#next - this.#clock());
    if (delay > MAX_QUEUE)
      throw new UpstreamError("upstream_unavailable", 503, "MusicBrainz is busy. Try again in a few seconds.");
    this.#next = this.#clock() + delay + SPACING;
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    const url = new URL(path, BASE);
    for (const [key, value] of Object.entries({ ...parameters, fmt: "json" })) url.searchParams.set(key, value);
    return url;
  }
  async #get(path: string, parameters: Record<string, string>): Promise<JsonValue> {
    return this.#http.json(await this.#turn(path, parameters), { headers: { Accept: "application/json", "User-Agent": USER_AGENT } }, { service: SERVICE });
  }

  /** Like #get, but a 404 is an answer (no such entity) rather than an error. */
  async #lookup(path: string, parameters: Record<string, string>): Promise<JsonValue | null> {
    const result = await this.#http.jsonResponse(
      await this.#turn(path, parameters),
      { headers: { Accept: "application/json", "User-Agent": USER_AGENT } },
      { service: SERVICE },
    );
    if (result.status === 404) return null;
    if (result.status < 200 || result.status > 299) throw statusError(result.status, SERVICE);
    return result.body;
  }

  /**
   * The release group of each release (Plex identifies albums by release).
   * Unknown releases map to null; ids beyond this call's lookup budget are
   * left out, for a later call.
   */
  async releaseGroupsOf(releaseMBIDs: string[]): Promise<Map<string, string | null>> {
    const found = new Map<string, string | null>();
    const wanted = new Set<string>();
    for (const id of releaseMBIDs) {
      const parsed = mbid.safeParse(id);
      // Not a MusicBrainz id at all (e.g. a hand-edited file tag): nothing to look up.
      if (parsed.success) wanted.add(parsed.data);
      else found.set(id, null);
    }
    const ids = [...wanted];
    const searched = z.object({ releases: z.array(z.object({ id: mbid, "release-group": z.object({ id: mbid }).loose() }).loose()) }).loose();
    try {
      for (let start = 0; start < ids.length; start += RELEASE_BATCH) {
        const batch = ids.slice(start, start + RELEASE_BATCH);
        const result = parseBody(
          searched,
          await this.#get("release", { query: `reid:(${batch.map((id) => `"${id}"`).join(" OR ")})`, limit: String(RELEASE_BATCH) }),
          SERVICE,
        );
        // Search results come in relevance order, so they are matched by id.
        const asked = new Set(batch);
        for (const release of result.releases) if (asked.has(release.id)) found.set(release.id, release["release-group"].id);
      }
      // Merged ids redirect, so the answer is keyed by the id asked for, not the one returned.
      for (const id of ids.filter((value) => !found.has(value)).slice(0, MAX_SINGLE_LOOKUPS)) {
        const body = await this.#lookup(`release/${id}`, { inc: "release-groups" });
        found.set(id, body === null ? null : parseBody(z.object({ "release-group": z.object({ id: mbid }).loose() }).loose(), body, SERVICE)["release-group"].id);
      }
    } catch (cause) {
      if (!(cause instanceof UpstreamError) || !found.size) throw cause;
      throw new PartialReleaseLookup(cause, found);
    }
    return found;
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

  /** Every edition of a release group (up to MAX_EDITIONS), oldest first. */
  async editions(releaseGroupMBID: string): Promise<EditionList> {
    const releases: Array<z.infer<typeof release>> = [];
    let total = 0;
    do {
      const result = parseBody(
        z.object({ releases: z.array(release), "release-count": z.number().int().nonnegative().optional() }).loose(),
        await this.#get("release", {
          "release-group": mbid.parse(releaseGroupMBID),
          inc: "artist-credits+media",
          limit: "100",
          offset: String(releases.length),
        }),
        SERVICE,
      );
      releases.push(...result.releases);
      total = result["release-count"] ?? releases.length;
      if (!result.releases.length) break;
    } while (releases.length < total && releases.length < MAX_EDITIONS);
    const items = releases
      .map((value) => {
        const media = value.media ?? [];
        const counts = media.map((medium) => medium["track-count"] ?? 0);
        const formats = [...new Set(media.flatMap((medium) => (medium.format ? [medium.format] : [])))];
        return {
          id: value.id,
          title: value.title,
          status: value.status || null,
          disambiguation: value.disambiguation ?? "",
          date: value.date || null,
          country: value.country || null,
          formats: formats.join(" + "),
          tracks: counts.length ? counts.reduce((sum, count) => sum + count, 0) : null,
        };
      })
      .sort((a, b) => (a.date ?? "9999").localeCompare(b.date ?? "9999"));
    return { items, total: Math.max(total, items.length) };
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
      // As credited on the album, so the request reads the same as the card that was clicked.
      artist: creditedName(parsedGroup["artist-credit"]),
    };
  }
}
