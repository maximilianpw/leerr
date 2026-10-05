import { z } from "zod";
import { UpstreamError } from "./errors.ts";
import { HttpClient, parseBody, parseJson, statusError, type JsonValue } from "./http.ts";
import { PLEX_PRODUCT, PLEX_VERSION, reconnectError } from "./plex.ts";

/** A sign-in request the person approves on Plex's own page; Leerr never sees a Plex password. */
export type PlexPin = { id: number; code: string; expiresAt: number };
export type PlexAccount = {
  id: number;
  uuid: string;
  username: string;
  /** A managed Home profile: it has no credentials of its own. */
  restricted: boolean;
  home: boolean;
};
/** A managed profile in the signed-in person's Plex Home. */
export type PlexProfile = { uuid: string; name: string; protected: boolean };

const SERVICE = "plex.tv";
const TV = "https://plex.tv/api/v2/";
const CLIENTS = "https://clients.plex.tv/api/v2/";

const pin = z.object({
  id: z.number().int().positive(),
  code: z.string().min(4).max(64),
  expiresAt: z.string(),
  authToken: z.string().min(1).max(500).nullable().optional(),
});
const account = z
  .object({
    id: z.number().int(),
    uuid: z.string().min(1).max(100),
    username: z.string().nullable().optional(),
    title: z.string().nullable().optional(),
    restricted: z.boolean().default(false),
    home: z.boolean().default(false),
  })
  .loose();
const resource = z
  .object({
    clientIdentifier: z.string(),
    provides: z.string().default(""),
    owned: z.boolean().default(false),
    accessToken: z.string().min(1).max(500).nullable().optional(),
  })
  .loose();
const homeUser = z
  .object({
    uuid: z.string().min(1).max(100),
    title: z.string().nullable().optional(),
    friendlyName: z.string().nullable().optional(),
    username: z.string().nullable().optional(),
    restricted: z.boolean().default(false),
    protected: z.boolean().default(false),
  })
  .loose();
const switched = z
  .object({ authToken: z.string().min(1).max(500).optional(), authenticationToken: z.string().min(1).max(500).optional() })
  .loose();

/** The PIN is gone or past its lifetime: the person has to start again. */
export const pinExpired = () =>
  new UpstreamError("upstream_rejected", 410, "The Plex sign-in expired. Start again.", "not_applied");

/**
 * plex.tv: the PIN sign-in, account checks and the per-server tokens. Every
 * call carries the person's own client identifier, which plex.tv ties PINs to.
 */
export class PlexTV {
  readonly #http: HttpClient;
  constructor(http: HttpClient) {
    this.#http = http;
  }

  #headers(clientID: string, token?: string, deviceName = PLEX_PRODUCT): Headers {
    const headers = new Headers({
      Accept: "application/json",
      "X-Plex-Client-Identifier": clientID,
      "X-Plex-Product": PLEX_PRODUCT,
      "X-Plex-Version": PLEX_VERSION,
      "X-Plex-Platform": "Web",
      "X-Plex-Device": PLEX_PRODUCT,
      "X-Plex-Device-Name": deviceName,
    });
    if (token) headers.set("X-Plex-Token", token);
    return headers;
  }
  async #call(url: URL, init: RequestInit): Promise<{ status: number; body: JsonValue | null }> {
    const response = await this.#http.binary(url, init, { service: SERVICE, maxBytes: 2_000_000 });
    if (response.status < 200 || response.status > 299) return { status: response.status, body: null };
    return { status: response.status, body: response.bytes.length ? parseJson(response.bytes, SERVICE) : null };
  }
  /** Only a 401 from plex.tv means the token is no longer valid; outages and rate limits are not proof. */
  #accountFailure(status: number): UpstreamError {
    return status === 401 ? reconnectError() : statusError(status, SERVICE);
  }

  async createPin(clientID: string, deviceName: string): Promise<PlexPin> {
    const url = new URL("pins", TV);
    url.searchParams.set("strong", "true");
    const result = await this.#call(url, { method: "POST", headers: this.#headers(clientID, undefined, deviceName) });
    if (!result.body) throw statusError(result.status, SERVICE);
    const value = parseBody(pin, result.body, SERVICE);
    const expiresAt = Date.parse(value.expiresAt);
    if (!Number.isFinite(expiresAt)) throw new UpstreamError("upstream_protocol", 502, "plex.tv returned a sign-in without an expiry.");
    return { id: value.id, code: value.code, expiresAt };
  }

  /** The account token once the person approved the sign-in; null while they have not yet. */
  async checkPin(clientID: string, pinID: number): Promise<string | null> {
    const result = await this.#call(new URL(`pins/${pinID}`, TV), { headers: this.#headers(clientID) });
    if (result.status === 404 || result.status === 410) throw pinExpired();
    if (!result.body) throw statusError(result.status, SERVICE);
    return parseBody(pin, result.body, SERVICE).authToken ?? null;
  }

  async account(clientID: string, token: string): Promise<PlexAccount> {
    const result = await this.#call(new URL("user", TV), { headers: this.#headers(clientID, token) });
    if (!result.body) throw this.#accountFailure(result.status);
    const value = parseBody(account, result.body, SERVICE);
    return { id: value.id, uuid: value.uuid, username: value.username || value.title || "Plex user", restricted: value.restricted, home: value.home };
  }

  /**
   * The token this account must use on the server with `machineID`, or null
   * when the account cannot reach that server. A shared server's token differs
   * from the account token; the account token must never be sent to it.
   */
  async serverToken(clientID: string, token: string, machineID: string): Promise<string | null> {
    const url = new URL("resources", CLIENTS);
    for (const name of ["includeHttps", "includeRelay", "includeIPv6"]) url.searchParams.set(name, "1");
    const result = await this.#call(url, { headers: this.#headers(clientID, token) });
    if (!result.body) throw this.#accountFailure(result.status);
    const server = parseBody(z.array(resource), result.body, SERVICE).find(
      (entry) => entry.clientIdentifier === machineID && entry.provides.split(",").includes("server"),
    );
    if (!server) return null;
    return server.accessToken ?? (server.owned ? token : null);
  }

  /** The managed profiles of the signed-in person's Plex Home (never full members or the administrator). */
  async managedProfiles(clientID: string, token: string): Promise<PlexProfile[]> {
    const result = await this.#call(new URL("home/users", TV), { headers: this.#headers(clientID, token) });
    if (result.status === 404) return [];
    if (!result.body) throw this.#accountFailure(result.status);
    const users = parseBody(z.object({ users: z.array(homeUser).default([]) }).loose(), result.body, SERVICE).users;
    return users.flatMap((user) =>
      user.restricted ? [{ uuid: user.uuid, name: user.title || user.friendlyName || user.username || "Profile", protected: user.protected }] : [],
    );
  }

  /** Switches the signed-in Home member to a managed profile and returns that profile's own token. */
  async switchProfile(clientID: string, token: string, uuid: string, profilePin: string): Promise<string> {
    const url = new URL(`home/users/${encodeURIComponent(uuid)}/switch`, TV);
    if (profilePin) url.searchParams.set("pin", profilePin);
    const result = await this.#call(url, { method: "POST", headers: this.#headers(clientID, token) });
    if (result.status === 401 || result.status === 403)
      throw new UpstreamError("upstream_rejected", 403, "Plex refused the switch. Check the profile's PIN.", "not_applied");
    if (!result.body) throw statusError(result.status, SERVICE);
    const value = parseBody(switched, result.body, SERVICE);
    const profileToken = value.authToken ?? value.authenticationToken;
    if (!profileToken) throw new UpstreamError("upstream_protocol", 502, "plex.tv did not return the profile's token.");
    return profileToken;
  }

  /** Ends this sign-in on plex.tv. Best effort: the local copy is deleted either way. */
  async signOut(clientID: string, token: string): Promise<void> {
    await this.#http.empty(new URL("users/signout", TV), { method: "DELETE", headers: this.#headers(clientID, token) }, { service: SERVICE });
  }

  /** Keeps an otherwise idle token from expiring, as Plex's own apps do. */
  async ping(clientID: string, token: string): Promise<void> {
    const status = await this.#http.empty(new URL("ping", TV), { headers: this.#headers(clientID, token) }, { service: SERVICE });
    if (status < 200 || status > 299) throw this.#accountFailure(status);
  }
}
