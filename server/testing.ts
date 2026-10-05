/** In-memory fakes shared by tests and the fixture preview. Never used in production. */
import { readFileSync } from "node:fs";
import { emptySettings, Store, type Settings } from "./store.ts";
import {
  UpstreamError,
  type Album,
  type AlbumCandidate,
  type AlbumDetail,
  type AlbumPage,
  type AlbumType,
  type ArtistPage,
  type Artwork,
  type ArtworkSize,
  type CandidatePage,
  type EditionList,
  type Identity,
  type JellyfinAccess,
  type JellyfinAccount,
  type LastfmAccount,
  type LibraryQuery,
  type LidarrAccess,
  type LidarrAlbum,
  type LidarrCandidate,
  type LidarrCommand,
  type LidarrDownload,
  type LidarrOptions,
  type LidarrProfile,
  type Notification,
  type NotifyTarget,
  type PlaybackEvent,
  type Playlist,
  type PlaylistDetail,
  type RecommendationSeed,
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
/** A longer edition of every fixture album: Lidarr monitors it by itself after an add. */
export const DELUXE = "99999999-9999-4999-8999-999999999999";

export const fixtureKey = Buffer.alloc(32, 7);
export const makeStore = () => new Store(":memory:", fixtureKey);
export const audio = readFileSync(new URL("./fixtures/tone.flac", import.meta.url));
export const configuredSettings: Settings = {
  ...emptySettings,
  jellyfinURL: "https://jellyfin.test",
  lidarrURL: "https://lidarr.test",
  lidarrKey: "lidarr-key",
  rootFolderPath: "/music",
  qualityProfileID: 1,
  metadataProfileID: 1,
};

export const fixtureAlbum = (values: Pick<Album, "id" | "title" | "artist"> & Partial<Album>): Album => ({
  artistID: null,
  artistMBID: null,
  year: null,
  releaseGroupMBID: null,
  releaseMBID: null,
  hasArtwork: true,
  favorite: false,
  ...values,
});
export const fixtureTrack = (id: string, albumID: string | null = null): Track => ({
  id,
  title: id === "tone" ? "Tone" : `Track ${id}`,
  artist: identities.album.artist,
  albumID,
  albumTitle: albumID ? identities.album.title : null,
  disc: 1,
  number: 1,
  duration: 0.1,
  codec: "flac",
  sampleRate: 8000,
  bitDepth: 16,
  favorite: false,
});
const notFound = () => new UpstreamError("upstream_rejected", 404, "Jellyfin rejected the request (HTTP 404).", "not_applied");

/** A controllable fake of every upstream service. Unused methods fail loudly. */
export class FakeUpstreams implements Upstreams {
  logins = new Map<string, JellyfinAccount>([
    ["admin", { token: "admin-jelly-token", userID: "jf-admin" }],
    ["member", { token: "member-jelly-token", userID: "jf-member" }],
  ]);
  /** Device ids Jellyfin logins were made with, in order. */
  loginDevices: string[] = [];
  /** Tokens Jellyfin no longer accepts (e.g. after a password change there). */
  revokedTokens = new Set<string>();
  libraries = new Map<string, Album[]>([
    [
      "admin-jelly-token",
      [
        fixtureAlbum({
          id: "available",
          title: identities.album.title,
          artist: identities.album.artist,
          artistID: "artist-quiet",
          artistMBID: identities.album.artistMBID,
          year: 2024,
          releaseGroupMBID: identities.album.releaseGroupMBID,
          releaseMBID: identities.album.releaseMBID,
        }),
        fixtureAlbum({ id: "untagged", title: "Untagged", artist: "Nobody", hasArtwork: false }),
      ],
    ],
    [
      "member-jelly-token",
      [
        fixtureAlbum({
          id: "member-only",
          title: identities.other.title,
          artist: identities.other.artist,
          artistMBID: identities.other.artistMBID,
          year: 2021,
          releaseGroupMBID: identities.other.releaseGroupMBID,
          releaseMBID: identities.other.releaseMBID,
        }),
      ],
    ],
  ]);
  playlists = new Map<string, Array<{ playlist: Playlist; tracks: string[] }>>([
    ["admin-jelly-token", [{ playlist: { id: "dinner", name: "Dinner", tracks: 1, duration: 0.1, hasArtwork: false }, tracks: ["tone"] }]],
  ]);
  candidates: AlbumCandidate[] = Object.values(identities).map((identity) => ({
    id: identity.releaseGroupMBID,
    title: identity.title,
    artist: identity.artist,
    artistMBID: identity.artistMBID,
    year: "2024",
    date: "2024-09-01",
    primaryType: "Album",
    secondaryTypes: [],
    coverUrl: null,
  }));
  libraryCalls = 0;
  libraryQueries: LibraryQuery[] = [];
  artworkSizes: ArtworkSize[] = [];
  streamRanges: Array<string | undefined> = [];
  favorites = new Set<string>();
  playlistAdds: Array<{ playlistID: string; trackIDs: string[] }> = [];
  reports: Array<{ event: PlaybackEvent; trackID: string; position: number; paused: boolean }> = [];
  failLibrary: UpstreamError | null = null;
  seeds: RecommendationSeed[] = [];
  newReleaseQueries: Array<{ artists: string[]; since: string }> = [];
  notifications: Array<{ target: NotifyTarget; notification: Notification }> = [];
  failNotify: UpstreamError | null = null;

  // Lidarr state machine fake
  lidarr: LidarrAlbum | null = null;
  commands: LidarrCommand[] = [];
  /** Commands Lidarr forgot from its list (e.g. after a restart) but still has in its database. */
  storedCommands: LidarrCommand[] = [];
  downloads: LidarrDownload[] = [];
  createCalls = 0;
  monitorCalls = 0;
  searchCalls = 0;
  failCreate: UpstreamError | null = null;
  createApplies = true;
  failMonitor: UpstreamError | null = null;
  failSearch: UpstreamError | null = null;
  searchRegisters = true;
  /**
   * Editions Lidarr loads after an add, with track counts; it monitors the longest.
   * By default: the requested edition and a longer deluxe one.
   */
  editionsAfterAdd: Array<{ id: string; tracks: number }> | null = null;
  #added: Array<{ id: string; tracks: number }> = [];
  /** Album reads after an add during which Lidarr is still loading the editions. */
  refreshReads = 1;
  #refreshing = 0;

  async jellyfinVersion(_endpoint: string): Promise<string> {
    return "10.11.0";
  }
  async jellyfinLogin(_endpoint: string, username: string, password: string, deviceID: string): Promise<JellyfinAccount> {
    this.loginDevices.push(deviceID);
    const account = this.logins.get(username);
    if (!account || password !== "jelly-password")
      throw new UpstreamError("upstream_auth", 502, "Jellyfin returned HTTP 401 (unauthorized).", "not_applied");
    return account;
  }
  async jellyfinTokenValid(access: JellyfinAccess): Promise<boolean> {
    return !this.revokedTokens.has(access.token);
  }
  #albums(access: JellyfinAccess): Album[] {
    if (this.failLibrary) throw this.failLibrary;
    if (this.revokedTokens.has(access.token))
      throw new UpstreamError("jellyfin_reconnect", 409, "Jellyfin no longer accepts your saved sign-in.", "not_applied");
    return (this.libraries.get(access.token) ?? []).map((album) => ({ ...album, favorite: this.favorites.has(album.id) }));
  }
  async jellyfinLibrary(access: JellyfinAccess, query: LibraryQuery): Promise<AlbumPage> {
    this.libraryCalls++;
    this.libraryQueries.push(query);
    const all = this.#albums(access).filter(
      (album) =>
        (!query.q || album.title.toLowerCase().includes(query.q.toLowerCase())) &&
        (!query.artistID || album.artistID === query.artistID) &&
        (!query.favorites || album.favorite),
    );
    if (query.sort === "artist") all.sort((a, b) => a.artist.localeCompare(b.artist));
    else if (query.sort === "year") all.sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
    else if (query.sort === "title") all.sort((a, b) => a.title.localeCompare(b.title));
    return { items: all.slice(query.offset, query.offset + query.limit), total: all.length };
  }
  async jellyfinArtists(access: JellyfinAccess, offset: number, limit: number, q: string): Promise<ArtistPage> {
    const names = new Map<string, string>();
    for (const album of this.#albums(access)) if (album.artistID) names.set(album.artistID, album.artist);
    const items = [...names]
      .flatMap(([id, name]) => (!q || name.toLowerCase().includes(q.toLowerCase()) ? [{ id, name, hasArtwork: false }] : []))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { items: items.slice(offset, offset + limit), total: items.length };
  }
  async jellyfinAlbum(access: JellyfinAccess, albumID: string): Promise<AlbumDetail> {
    const album = this.#albums(access).find((candidate) => candidate.id === albumID);
    if (!album) throw notFound();
    return { album, tracks: [{ ...fixtureTrack("tone", album.id), favorite: this.favorites.has("tone") }] };
  }
  async jellyfinPlaylists(access: JellyfinAccess): Promise<Playlist[]> {
    this.#albums(access);
    return (this.playlists.get(access.token) ?? []).map((entry) => entry.playlist);
  }
  async jellyfinPlaylist(access: JellyfinAccess, playlistID: string): Promise<PlaylistDetail> {
    const entry = (this.playlists.get(access.token) ?? []).find((candidate) => candidate.playlist.id === playlistID);
    if (!entry) throw notFound();
    return { playlist: entry.playlist, tracks: entry.tracks.map((id) => fixtureTrack(id, "available")) };
  }
  async jellyfinAddToPlaylist(access: JellyfinAccess, playlistID: string, trackIDs: string[]): Promise<void> {
    await this.jellyfinPlaylist(access, playlistID);
    this.playlistAdds.push({ playlistID, trackIDs });
  }
  async jellyfinFavorite(access: JellyfinAccess, itemID: string, favorite: boolean): Promise<void> {
    if (itemID !== "tone" && !this.#albums(access).some((album) => album.id === itemID)) throw notFound();
    if (favorite) this.favorites.add(itemID);
    else this.favorites.delete(itemID);
  }
  async jellyfinReport(access: JellyfinAccess, event: PlaybackEvent, trackID: string, position: number, paused: boolean): Promise<void> {
    await this.jellyfinTrack(access, trackID);
    this.reports.push({ event, trackID, position, paused });
  }
  async jellyfinTrack(access: JellyfinAccess, trackID: string): Promise<Track> {
    if (!this.#albums(access).length) throw notFound();
    return fixtureTrack(trackID, "available");
  }
  async jellyfinArtwork(access: JellyfinAccess, itemID: string, size: ArtworkSize): Promise<Artwork> {
    this.artworkSizes.push(size);
    const album = this.#albums(access).find((candidate) => candidate.id === itemID);
    if (!album) throw notFound();
    if (!album.hasArtwork) throw new UpstreamError("upstream_rejected", 404, "This item has no artwork.", "not_applied");
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

  async lidarrVersion(_access: LidarrAccess): Promise<string> {
    return "3.1.0";
  }
  async lidarrOptions(_access: LidarrAccess): Promise<LidarrOptions> {
    return {
      roots: [{ id: 1, path: "/music" }],
      qualities: [{ id: 1, name: "Lossless" }],
      metadata: [{ id: 1, name: "Standard" }],
    };
  }
  /** Lidarr loads a new album's editions after the add, ignoring the posted flags. */
  async lidarrAlbum(_access: LidarrAccess, _group: string): Promise<LidarrAlbum | null> {
    if (this.lidarr && this.#refreshing > 0) {
      this.#refreshing--;
      if (this.#refreshing === 0) {
        const editions = this.editionsAfterAdd ?? this.#added;
        const longest = editions.reduce((best, edition) => (edition.tracks > best.tracks ? edition : best));
        this.lidarr.releases = editions.map((edition) => ({ id: edition.id, monitored: edition.id === longest.id }));
        this.lidarr.resource.releases = this.lidarr.releases.map((release) => ({ foreignReleaseId: release.id, monitored: release.monitored }));
      }
    }
    return this.lidarr ? structuredClone(this.lidarr) : null;
  }
  async lidarrLookup(_access: LidarrAccess, identity: Identity, _profile: LidarrProfile): Promise<LidarrCandidate> {
    return {
      foreignAlbumId: identity.releaseGroupMBID,
      artist: { foreignArtistId: identity.artistMBID },
      anyReleaseOk: true,
      releases: [identity.releaseMBID, DELUXE].map((id) => ({ foreignReleaseId: id, monitored: id === identity.releaseMBID })),
    };
  }
  async lidarrCreate(_access: LidarrAccess, candidate: LidarrCandidate): Promise<void> {
    this.createCalls++;
    const failure = this.failCreate;
    this.failCreate = null;
    if (!failure || (failure.outcome === "unknown" && this.createApplies)) {
      this.lidarr = {
        id: 17,
        artistID: 3,
        monitored: true,
        anyReleaseOk: candidate.anyReleaseOk === true,
        imported: false,
        releases: [],
        resource: { foreignAlbumId: candidate.foreignAlbumId, releases: [] },
      };
      this.#added = candidate.releases.map((release) => ({ id: release.foreignReleaseId, tracks: release.foreignReleaseId === DELUXE ? 16 : 10 }));
      this.#refreshing = this.refreshReads + 1;
    }
    if (failure) throw failure;
  }
  async lidarrMonitor(_access: LidarrAccess, _album: LidarrAlbum, release: string): Promise<void> {
    this.monitorCalls++;
    const failure = this.failMonitor;
    this.failMonitor = null;
    if (this.lidarr && (!failure || failure.outcome === "unknown")) {
      this.lidarr.monitored = true;
      this.lidarr.anyReleaseOk = false;
      for (const entry of this.lidarr.releases) entry.monitored = entry.id === release;
    }
    if (failure) throw failure;
  }
  async lidarrLatestCommandID(_access: LidarrAccess): Promise<number> {
    return this.commands.reduce((highest, command) => Math.max(highest, command.id), 0);
  }
  async lidarrLatestSearch(_access: LidarrAccess, _albumID: number, after: number): Promise<LidarrCommand | null> {
    return [...this.commands].reverse().find((command) => command.id > after) ?? null;
  }
  async lidarrCommand(_access: LidarrAccess, id: number): Promise<LidarrCommand | null> {
    return this.commands.find((command) => command.id === id) ?? this.storedCommands.find((command) => command.id === id) ?? null;
  }
  async lidarrRefreshing(_access: LidarrAccess, _album: LidarrAlbum): Promise<boolean> {
    return this.#refreshing > 0;
  }
  async lidarrDownloads(_access: LidarrAccess, _albumID: number): Promise<LidarrDownload[]> {
    return this.downloads.map((download) => ({ ...download }));
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
    await this.lastfmCheckKey(account.apiKey);
  }
  async lastfmCheckKey(apiKey: string): Promise<void> {
    if (apiKey !== "lastfm-key")
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
  async artistAlbums(artistMBID: string, _offset: number, type: AlbumType, _key: string | null): Promise<CandidatePage> {
    const items = this.candidates.flatMap((item) =>
      item.artistMBID === artistMBID && (type === "all" || type === "studio") ? [{ ...item }] : [],
    );
    return { items, total: items.length };
  }
  async newReleases(artistMBIDs: string[], since: string): Promise<AlbumCandidate[]> {
    this.newReleaseQueries.push({ artists: artistMBIDs, since });
    return this.candidates.flatMap((item) => (artistMBIDs.includes(item.artistMBID) ? [{ ...item }] : []));
  }
  async editions(group: string): Promise<EditionList> {
    const identity = Object.values(identities).find((value) => value.releaseGroupMBID === group);
    const items = identity
      ? [
          {
            id: identity.releaseMBID,
            title: identity.title,
            status: "Official",
            disambiguation: "",
            date: "2024-09-01",
            country: "GB",
            formats: "Digital Media",
            tracks: 9,
          },
        ]
      : [];
    return { items, total: items.length };
  }
  async identity(group: string, release: string, artist: string): Promise<Identity> {
    const found = Object.values(identities).find(
      (value) => value.releaseGroupMBID === group && value.releaseMBID === release && value.artistMBID === artist,
    );
    if (!found)
      throw new UpstreamError("upstream_rejected", 422, "MusicBrainz does not confirm this combination.", "not_applied");
    return found;
  }
  async recommendations(seed: RecommendationSeed): Promise<AlbumCandidate[]> {
    this.seeds.push(seed);
    return this.candidates.map((item) => ({ ...item }));
  }

  async notify(target: NotifyTarget, notification: Notification): Promise<void> {
    if (this.failNotify) throw this.failNotify;
    this.notifications.push({ target, notification });
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
