import { z } from "zod";
import { UpstreamError } from "./errors.ts";
import { HttpClient, parseBody, statusError, type JsonValue } from "./http.ts";

export type LastfmAccount = { username: string; apiKey: string };
export type LastfmAlbum = { name: string; artist: string; coverUrl: string | null };

const SERVICE = "Last.fm";
/** Query-string parameters for one Last.fm API method. */
type QueryParameters = Record<string, string>;
const text = z.string().min(1).max(10_000);
const images = z.array(z.object({ size: z.string(), "#text": z.string() }).loose()).default([]);
// Covers are only ever handed to browsers, never fetched server-side, and only
// from Last.fm's image CDN (also the CSP img-src allowlist).
const coverPattern =
  /^https:\/\/lastfm-img\.freetls\.fastly\.net\/i\/u\/[a-zA-Z0-9/_-]+\.(?:jpg|jpeg|png|webp)$/;

export function lastfmCover(values: z.infer<typeof images>): string | null {
  for (const size of ["extralarge", "large", "medium", "small"]) {
    const image = values.find((candidate) => candidate.size === size);
    if (image && coverPattern.test(image["#text"])) return image["#text"];
  }
  return null;
}

function applicationError(code: number): UpstreamError {
  if (code === 10)
    return new UpstreamError(
      "upstream_auth",
      502,
      "Last.fm error 10: invalid API key. Enter a Last.fm API key, not your password or API secret.",
      "not_applied",
    );
  if (code === 26)
    return new UpstreamError(
      "upstream_auth",
      502,
      "Last.fm error 26: this API key is suspended. Check its status with Last.fm.",
      "not_applied",
    );
  if (code === 6)
    return new UpstreamError(
      "upstream_rejected",
      502,
      "Last.fm error 6: check the Last.fm username; the requested profile or parameter was not found.",
      "not_applied",
    );
  if (code === 4 || code === 9)
    return new UpstreamError(
      "upstream_auth",
      502,
      `Last.fm rejected access (API error ${code}). This connection uses a username and API key, not account-password authentication.`,
      "not_applied",
    );
  return new UpstreamError(
    "upstream_unavailable",
    503,
    `Last.fm could not complete the request (API error ${code}).`,
  );
}

export class Lastfm {
  readonly #http: HttpClient;
  constructor(http: HttpClient) {
    this.#http = http;
  }

  async #call(method: string, apiKey: string, parameters: QueryParameters): Promise<JsonValue> {
    const url = new URL("https://ws.audioscrobbler.com/2.0/");
    for (const [key, value] of Object.entries({ method, api_key: apiKey, format: "json", ...parameters }))
      url.searchParams.set(key, value);
    const response = await this.#http.jsonResponse(url, { headers: { Accept: "application/json" } }, { service: SERVICE });
    const envelope = z.object({ error: z.number().int() }).loose().safeParse(response.body);
    if (envelope.success) throw applicationError(envelope.data.error);
    if (response.status < 200 || response.status > 299) throw statusError(response.status, SERVICE);
    return response.body;
  }

  async checkUser(account: LastfmAccount): Promise<void> {
    parseBody(
      z.object({ user: z.object({ name: text }).loose() }).loose(),
      await this.#call("user.getInfo", account.apiKey, { user: account.username }),
      SERVICE,
    );
  }

  async searchAlbums(apiKey: string, album: string): Promise<LastfmAlbum[]> {
    const result = parseBody(
      z.object({
        results: z.object({
          albummatches: z.object({
            album: z.array(z.object({ name: text, artist: text, image: images }).loose()),
          }).loose(),
        }).loose(),
      }).loose(),
      await this.#call("album.search", apiKey, { album, limit: "30" }),
      SERVICE,
    );
    return result.results.albummatches.album.map((value) => ({
      name: value.name,
      artist: value.artist,
      coverUrl: lastfmCover(value.image),
    }));
  }

  async topAlbums(apiKey: string, artist: { mbid?: string; name?: string }, limit: number): Promise<LastfmAlbum[]> {
    const response = artist.mbid
      ? await this.#call("artist.getTopAlbums", apiKey, { limit: String(limit), mbid: artist.mbid })
      : await this.#call("artist.getTopAlbums", apiKey, { limit: String(limit), artist: artist.name ?? "" });
    const result = parseBody(
      z.object({
        topalbums: z.object({
          album: z.array(
            z.object({ name: text, image: images, artist: z.object({ name: text }).loose().optional() }).loose(),
          ).default([]),
        }).loose(),
      }).loose(),
      response,
      SERVICE,
    );
    return result.topalbums.album.map((value) => ({
      name: value.name,
      artist: value.artist?.name ?? artist.name ?? "",
      coverUrl: lastfmCover(value.image),
    }));
  }

  async topArtists(account: LastfmAccount, limit: number): Promise<string[]> {
    const result = parseBody(
      z.object({
        topartists: z.object({ artist: z.array(z.object({ name: text }).loose()).default([]) }).loose(),
      }).loose(),
      await this.#call("user.getTopArtists", account.apiKey, {
        user: account.username,
        period: "3month",
        limit: String(limit),
      }),
      SERVICE,
    );
    return result.topartists.artist.map((artist) => artist.name);
  }

  async similarArtists(apiKey: string, artist: string, limit: number): Promise<string[]> {
    const result = parseBody(
      z.object({
        similarartists: z.object({ artist: z.array(z.object({ name: text }).loose()).default([]) }).loose(),
      }).loose(),
      await this.#call("artist.getSimilar", apiKey, { artist, limit: String(limit) }),
      SERVICE,
    );
    return result.similarartists.artist.map((value) => value.name);
  }
}
