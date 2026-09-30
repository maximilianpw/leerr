/** In-memory fakes shared by tests and the fixture preview. Never used in production. */
import { readFileSync } from "node:fs";
import { Store } from "./store.ts";
import {
  UpstreamError,
  type Album,
  type AlbumCandidate,
  type AlbumDetail,
  type AlbumPage,
  type Artwork,
  type CandidatePage,
  type Edition,
  type Identity,
  type JellyfinAccess,
  type JellyfinAccount,
  type LastfmAccount,
  type LidarrAccess,
  type LidarrAlbum,
  type LidarrCandidate,
  type LidarrCommand,
  type LidarrOptions,
  type SearchResult,
  type Track,
  type Upstreams,
} from "./upstream/index.ts";

export const identities = {
  album: {
    releaseGroupMBID: "11111111-1111-4111-8111-111111111111",
    releaseMBID: "22222222-2222-4222-8222-222222222222",
    artistMBID: "33333333-3333-4333-8333-333333333333",
    title: "Evening Signals",
    artist: "The Quiet Hours",
  },
  other: {
    releaseGroupMBID: "44444444-4444-4444-8444-444444444444",
    releaseMBID: "55555555-5555-4555-8555-555555555555",
    artistMBID: "66666666-6666-4666-8666-666666666666",
    title: "Coastal Lines",
    artist: "Mira Sol",
  },
} satisfies Record<string, Identity>;

export const fixtureKey = Buffer.alloc(32, 7);
export const makeStore = () => new Store(":memory:", fixtureKey);
export const audio = readFileSync(new URL("./fixtures/tone.flac", import.meta.url));

const fixtureTrack = (id: string): Track => ({
  id,
  title: id === "tone" ? "Tone" : `Track ${id}`,
  artist: identities.album.artist,
  disc: 1,
  number: 1,
  duration: 0.1,
  codec: "flac",
  sampleRate: 8000,
  bitDepth: 16,
});

/** A controllable fake of every upstream service. Unused methods fail loudly. */
export class FakeUpstreams implements Upstreams {
  logins = new Map<string, JellyfinAccount>([
    ["admin", { token: "admin-jelly-token", userID: "jf-admin" }],
    ["member", { token: "member-jelly-token", userID: "jf-member" }],
  ]);
  libraries = new Map<string, Album[]>([
    [
      "admin-jelly-token",
      [
        {
          id: "available",
          title: identities.album.title,
          artist: identities.album.artist,
          year: 2024,
          releaseGroupMBID: identities.album.releaseGroupMBID,
          releaseMBID: identities.album.releaseMBID,
        },
        { id: "untagged", title: "Untagged", artist: "Nobody", year: null, releaseGroupMBID: null, releaseMBID: null },
      ],
    ],
    [
      "member-jelly-token",
      [
        {
          id: "member-only",
          title: identities.other.title,
          artist: identities.other.artist,
          year: 2021,
          releaseGroupMBID: identities.other.releaseGroupMBID,
          releaseMBID: identities.other.releaseMBID,
        },
      ],
    ],
  ]);
  candidates: AlbumCandidate[] = Object.values(identities).map((identity) => ({
    id: identity.releaseGroupMBID,
    title: identity.title,
    artist: identity.artist,
    artistMBID: identity.artistMBID,
    year: "2024",
    coverUrl: null,
  }));
  libraryCalls = 0;
  streamRanges: Array<string | undefined> = [];
  failLibrary: UpstreamError | null = null;

  // Lidarr state machine fake
  lidarr: LidarrAlbum | null = null;
  commands: LidarrCommand[] = [];
  createCalls = 0;
  monitorCalls = 0;
  searchCalls = 0;
  failCreate: UpstreamError | null = null;
  createApplies = true;
  failMonitor: UpstreamError | null = null;
  failSearch: UpstreamError | null = null;
  searchRegisters = true;

  async jellyfinLogin(_endpoint: string, username: string, password: string): Promise<JellyfinAccount> {
    const account = this.logins.get(username);
    if (!account || password !== "jelly-password")
      throw new UpstreamError("upstream_auth", 502, "Jellyfin returned HTTP 401 (unauthorized).", "not_applied");
    return account;
  }
  #albums(access: JellyfinAccess): Album[] {
    if (this.failLibrary) throw this.failLibrary;
    return this.libraries.get(access.token) ?? [];
  }
  async jellyfinLibrary(access: JellyfinAccess, offset: number, limit: number, query = ""): Promise<AlbumPage> {
    this.libraryCalls++;
    const all = this.#albums(access).filter(
      (album) => !query || album.title.toLowerCase().includes(query.toLowerCase()),
    );
    return { items: all.slice(offset, offset + limit), total: all.length };
  }
  async jellyfinAlbum(access: JellyfinAccess, albumID: string): Promise<AlbumDetail> {
    const album = this.#albums(access).find((candidate) => candidate.id === albumID);
    if (!album) throw new UpstreamError("upstream_rejected", 404, "Jellyfin rejected the request (HTTP 404).", "not_applied");
    return { album, tracks: [fixtureTrack("tone")] };
  }
  async jellyfinTrack(access: JellyfinAccess, trackID: string): Promise<Track> {
    if (!this.#albums(access).length)
      throw new UpstreamError("upstream_rejected", 404, "Jellyfin rejected the request (HTTP 404).", "not_applied");
    return fixtureTrack(trackID);
  }
  async jellyfinArtwork(access: JellyfinAccess, itemID: string): Promise<Artwork> {
    await this.jellyfinAlbum(access, itemID);
    return { type: "image/png", bytes: readFileSync(new URL("./fixtures/cover-evening.png", import.meta.url)) };
  }
  async jellyfinStream(
    access: JellyfinAccess,
    trackID: string,
    range: string | undefined,
    _ifRange: string | undefined,
    signal: AbortSignal,
  ): Promise<Response> {
    await this.jellyfinTrack(access, trackID);
    signal.throwIfAborted();
    this.streamRanges.push(range);
    const headers = { "Content-Type": "audio/flac", "Accept-Ranges": "bytes" };
    if (!range)
      return new Response(audio, { status: 200, headers: { ...headers, "Content-Length": String(audio.length) } });
    const match = /^bytes=(\d+)-(\d*)$/.exec(range);
    const start = match ? Number(match[1]) : audio.length;
    const end = match?.[2] ? Math.min(Number(match[2]), audio.length - 1) : audio.length - 1;
    if (start >= audio.length || end < start)
      return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${audio.length}` } });
    const body = audio.subarray(start, end + 1);
    return new Response(body, {
      status: 206,
      headers: { ...headers, "Content-Length": String(body.length), "Content-Range": `bytes ${start}-${end}/${audio.length}` },
    });
  }

  async lidarrOptions(_access: LidarrAccess): Promise<LidarrOptions> {
    return {
      roots: [{ id: 1, path: "/music" }],
      qualities: [{ id: 1, name: "Lossless" }],
      metadata: [{ id: 1, name: "Standard" }],
    };
  }
  async lidarrAlbum(_access: LidarrAccess, _group: string): Promise<LidarrAlbum | null> {
    return this.lidarr ? structuredClone(this.lidarr) : null;
  }
  async lidarrLookup(_access: LidarrAccess, identity: Identity): Promise<LidarrCandidate> {
    return {
      foreignAlbumId: identity.releaseGroupMBID,
      artist: { foreignArtistId: identity.artistMBID },
      releases: [{ foreignReleaseId: identity.releaseMBID, monitored: true }],
    };
  }
  async lidarrCreate(_access: LidarrAccess, candidate: LidarrCandidate): Promise<void> {
    this.createCalls++;
    const failure = this.failCreate;
    this.failCreate = null;
    if (!failure || (failure.outcome === "unknown" && this.createApplies))
      this.lidarr = { id: 17, monitored: true, imported: false, resource: { ...candidate, artist: undefined } };
    if (failure) throw failure;
  }
  async lidarrMonitor(_access: LidarrAccess, _album: LidarrAlbum, _release: string): Promise<void> {
    this.monitorCalls++;
    const failure = this.failMonitor;
    this.failMonitor = null;
    if (this.lidarr && (!failure || failure.outcome === "unknown")) this.lidarr.monitored = true;
    if (failure) throw failure;
  }
  async lidarrLatestCommandID(_access: LidarrAccess): Promise<number> {
    return this.commands.reduce((highest, command) => Math.max(highest, command.id), 0);
  }
  async lidarrLatestSearch(_access: LidarrAccess, _albumID: number, after: number): Promise<LidarrCommand | null> {
    return [...this.commands].reverse().find((command) => command.id > after) ?? null;
  }
  async lidarrSearch(_access: LidarrAccess, _albumID: number): Promise<number> {
    this.searchCalls++;
    const id = 100 + this.searchCalls;
    const failure = this.failSearch;
    this.failSearch = null;
    if (!failure || (failure.outcome === "unknown" && this.searchRegisters))
      this.commands.push({ id, status: "started" });
    if (failure) throw failure;
    return id;
  }

  async lastfmCheck(account: LastfmAccount): Promise<void> {
    if (account.apiKey !== "lastfm-key")
      throw new UpstreamError("upstream_auth", 502, "Last.fm error 10: invalid API key.", "not_applied");
  }
  async search(query: string, _key: string | null): Promise<SearchResult> {
    if (query === "error") throw new UpstreamError("upstream_unavailable", 503, "MusicBrainz returned HTTP 503.");
    const items = query === "empty" ? [] : this.candidates.map((item) => ({ ...item }));
    return {
      items,
      total: items.length,
      artists: items.length
        ? [{ id: identities.album.artistMBID, name: identities.album.artist, disambiguation: "", country: "GB", type: "Group" }]
        : [],
    };
  }
  async artistAlbums(artistMBID: string, _offset: number, _key: string | null): Promise<CandidatePage> {
    const items = this.candidates.filter((item) => item.artistMBID === artistMBID).map((item) => ({ ...item }));
    return { items, total: items.length };
  }
  async editions(group: string): Promise<Edition[]> {
    const identity = Object.values(identities).find((value) => value.releaseGroupMBID === group);
    return identity
      ? [{ id: identity.releaseMBID, title: identity.title, date: "2024-09-01", country: "GB", formats: "Digital Media", tracks: 9 }]
      : [];
  }
  async identity(group: string, release: string, artist: string): Promise<Identity> {
    const found = Object.values(identities).find(
      (value) => value.releaseGroupMBID === group && value.releaseMBID === release && value.artistMBID === artist,
    );
    if (!found)
      throw new UpstreamError("upstream_rejected", 422, "MusicBrainz does not confirm this combination.", "not_applied");
    return found;
  }
  async recommendations(_account: LastfmAccount | null): Promise<AlbumCandidate[]> {
    return this.candidates.map((item) => ({ ...item }));
  }
}

/** A controllable clock for deterministic time-based tests. */
export class Clock {
  value: number;
  constructor(start = Date.UTC(2026, 8, 30, 12)) {
    this.value = start;
  }
  now = () => this.value;
  advance(milliseconds: number) {
    this.value += milliseconds;
  }
}
