/** In-memory fakes shared by tests and the fixture preview. Never used in production. */
import { readFileSync } from "node:fs";
import { emptySettings, Store, type Settings } from "./store.ts";
import {
  pinExpired,
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
  type LastfmAccount,
  type LibraryContents,
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
  type PlayableTrack,
  type Playlist,
  type PlaylistDetail,
  type PlexAccess,
  type PlexAccount,
  type PlexIdentity,
  type PlexPin,
  type PlexProfile,
  type PlexSection,
  type RecommendationSeed,
  type SearchResult,
  type TimelineReport,
  type Track,
  type Upstreams,
} from "./upstream/index.ts";
import { reconnectError } from "./upstream/plex.ts";

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
export const PLEX_MACHINE = "fixture-plex-machine";
/** Fixture Plex items (ratingKeys are decimal). */
export const plexIDs = {
  album: "101",
  untagged: "102",
  memberAlbum: "201",
  track: "1001",
  /** An ALAC track, which browsers cannot play as it is. */
  alacTrack: "1002",
  playlist: "301",
  smartPlaylist: "302",
  artist: "501",
} as const;

export const fixtureKey = Buffer.alloc(32, 7);
export const makeStore = () => new Store(":memory:", fixtureKey);
export const audio = readFileSync(new URL("./fixtures/tone.flac", import.meta.url));
export const configuredSettings: Settings = {
  ...emptySettings,
  plexURL: "https://plex.test",
  plexMachineID: PLEX_MACHINE,
  lidarrURL: "https://lidarr.test",
  lidarrKey: "lidarr-key",
  rootFolderPath: "/music",
  qualityProfileID: 1,
  metadataProfileID: 1,
};
/** A person's saved link, as the store keeps it. */
export const plexLinkFor = (who: "admin" | "member", username: string = who) => ({
  accountToken: `${who}-account`,
  serverToken: `${who}-plex-token`,
  machineID: PLEX_MACHINE,
  username,
  uuid: `${who}-uuid`,
  managed: false,
});

export const fixtureAlbum = (values: Pick<Album, "id" | "title" | "artist"> & Partial<Album>): Album => ({
  artistID: null,
  artistMBID: null,
  year: null,
  releaseGroupMBID: null,
  releaseMBID: null,
  hasArtwork: true,
  favorite: false,
  available: true,
  ...values,
});
export const fixtureTrack = (id: string, albumID: string | null = null): Track => ({
  id,
  title: id === plexIDs.track ? "Tone" : `Track ${id}`,
  artist: identities.album.artist,
  albumID,
  albumTitle: albumID ? identities.album.title : null,
  disc: 1,
  number: 1,
  duration: 0.1,
  codec: id === plexIDs.alacTrack ? "alac" : "flac",
  sampleRate: 8000,
  bitDepth: 16,
  favorite: false,
  available: true,
});
const notFound = () => new UpstreamError("upstream_rejected", 404, "Plex has no such item, or your account cannot see it.", "not_applied");
type FakeAccount = { account: PlexAccount; serverToken: string | null; profiles: Array<PlexProfile & { token: string; pin: string }> };

/** A controllable fake of every upstream service. Unused methods fail loudly. */
export class FakeUpstreams implements Upstreams {
  machineID = PLEX_MACHINE;
  claimed = true;
  /** plex.tv accounts by account token: who they are and which server token resources gives them. */
  accounts = new Map<string, FakeAccount>([
    [
      "admin-account",
      {
        account: { id: 1, uuid: "admin-uuid", username: "admin", restricted: false, home: true },
        serverToken: "admin-plex-token",
        profiles: [{ uuid: "kid-uuid", name: "Kid", protected: true, token: "kid-account", pin: "1234" }],
      },
    ],
    ["member-account", { account: { id: 2, uuid: "member-uuid", username: "member", restricted: false, home: false }, serverToken: "member-plex-token", profiles: [] }],
    ["kid-account", { account: { id: 3, uuid: "kid-uuid", username: "Kid", restricted: true, home: true }, serverToken: "kid-plex-token", profiles: [] }],
    // An account the household server is not shared with.
    ["stranger-account", { account: { id: 4, uuid: "stranger-uuid", username: "stranger", restricted: false, home: false }, serverToken: null, profiles: [] }],
  ]);
  pins = new Map<number, { clientID: string; deviceName: string; token: string | null; expired: boolean }>();
  #nextPin = 7000;
  signOuts: string[] = [];
  pings: string[] = [];
  identityChecks = 0;
  /** What the saved address answers instead of Plex's identity (an outage, a proxy's error page…). */
  failIdentity: UpstreamError | null = null;
  serverTokenCalls = 0;
  failServerToken: UpstreamError | null = null;
  /** Server tokens Plex no longer accepts (the share ended or was re-created). */
  revokedTokens = new Set<string>();
  libraries = new Map<string, Album[]>([
    [
      "admin-plex-token",
      [
        fixtureAlbum({
          id: plexIDs.album,
          title: identities.album.title,
          artist: identities.album.artist,
          artistID: plexIDs.artist,
          artistMBID: identities.album.artistMBID,
          year: 2024,
          releaseMBID: identities.album.releaseMBID,
        }),
        fixtureAlbum({ id: plexIDs.untagged, title: "Untagged", artist: "Nobody", hasArtwork: false }),
      ],
    ],
    [
      "member-plex-token",
      [
        fixtureAlbum({
          id: plexIDs.memberAlbum,
          title: identities.other.title,
          artist: identities.other.artist,
          artistID: "502",
          artistMBID: identities.other.artistMBID,
          year: 2021,
          releaseMBID: identities.other.releaseMBID,
        }),
      ],
    ],
  ]);
  playlists = new Map<string, Array<{ playlist: Playlist; tracks: string[] }>>([
    [
      "admin-plex-token",
      [
        { playlist: { id: plexIDs.playlist, name: "Dinner", tracks: 1, duration: 0.1, hasArtwork: false, smart: false }, tracks: [plexIDs.track] },
        { playlist: { id: plexIDs.smartPlaylist, name: "Top rated", tracks: 0, duration: null, hasArtwork: false, smart: true }, tracks: [] },
      ],
    ],
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
  indexCalls = 0;
  libraryQueries: LibraryQuery[] = [];
  releaseLookups: string[][] = [];
  artworkSizes: ArtworkSize[] = [];
  streamRanges: Array<string | undefined> = [];
  transcodes: Array<{ trackID: string; offset: number; session: string }> = [];
  stoppedTranscodes: string[] = [];
  favorites = new Set<string>();
  playlistAdds: Array<{ playlistID: string; trackIDs: string[] }> = [];
  reports: Array<TimelineReport & { session: string | undefined }> = [];
  /** Plex's reason for ending playback, returned with the next report. */
  terminate: string | null = null;
  failLibrary: UpstreamError | null = null;
  failReleaseLookup: UpstreamError | null = null;
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

  /** Approves the latest Plex sign-in as this plex.tv account, as the person would on Plex's page. */
  approvePin(accountToken: string, pinID = this.#nextPin - 1) {
    const pin = this.pins.get(pinID);
    if (!pin) throw new Error(`No Plex PIN ${pinID}.`);
    pin.token = accountToken;
  }

  async plexIdentity(_endpoint: string): Promise<PlexIdentity> {
    this.identityChecks++;
    if (this.failIdentity) throw this.failIdentity;
    return { machineID: this.machineID, version: "1.43.3.10861", claimed: this.claimed };
  }
  async plexCreatePin(clientID: string, deviceName: string): Promise<PlexPin> {
    const id = this.#nextPin++;
    this.pins.set(id, { clientID, deviceName, token: null, expired: false });
    return { id, code: `code${id}`, expiresAt: Date.UTC(2099, 0, 1) };
  }
  async plexCheckPin(clientID: string, pinID: number): Promise<string | null> {
    const pin = this.pins.get(pinID);
    if (!pin || pin.expired) throw pinExpired();
    // plex.tv only reveals the token to the client identifier that created the PIN.
    return pin.clientID === clientID ? pin.token : null;
  }
  #account(token: string): FakeAccount {
    const entry = this.accounts.get(token);
    if (!entry) throw reconnectError();
    return entry;
  }
  async plexAccount(_clientID: string, token: string): Promise<PlexAccount> {
    return this.#account(token).account;
  }
  async plexServerToken(_clientID: string, token: string, machineID: string): Promise<string | null> {
    this.serverTokenCalls++;
    await new Promise((resolve) => setImmediate(resolve));
    if (this.failServerToken) throw this.failServerToken;
    const entry = this.#account(token);
    return machineID === this.machineID ? entry.serverToken : null;
  }
  async plexProfiles(_clientID: string, token: string): Promise<PlexProfile[]> {
    return this.#account(token).profiles.map((profile) => ({ uuid: profile.uuid, name: profile.name, protected: profile.protected }));
  }
  async plexSwitchProfile(_clientID: string, token: string, uuid: string, pin: string): Promise<string> {
    const profile = this.#account(token).profiles.find((candidate) => candidate.uuid === uuid);
    if (!profile || profile.pin !== pin)
      throw new UpstreamError("upstream_rejected", 403, "Plex refused the switch. Check the profile's PIN.", "not_applied");
    return profile.token;
  }
  async plexSignOut(_clientID: string, token: string): Promise<void> {
    this.signOuts.push(token);
  }
  async plexPing(_clientID: string, token: string): Promise<void> {
    this.#account(token);
    this.pings.push(token);
  }
  #albums(access: PlexAccess): Album[] {
    if (this.failLibrary) throw this.failLibrary;
    if (this.revokedTokens.has(access.token)) throw reconnectError();
    const albums = this.libraries.get(access.token);
    if (!albums) throw reconnectError();
    return albums.map((album) => ({ ...album, artistMBID: null, favorite: this.favorites.has(album.id) }));
  }
  async plexTokenValid(access: PlexAccess): Promise<boolean> {
    return !this.revokedTokens.has(access.token) && this.libraries.has(access.token);
  }
  async plexSections(access: PlexAccess): Promise<PlexSection[]> {
    this.#albums(access);
    return [{ key: "3", title: "Music", agent: "tv.plex.agents.music", scanner: "Plex Music" }];
  }
  async plexLibrary(access: PlexAccess, query: LibraryQuery): Promise<AlbumPage> {
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
  async plexArtists(access: PlexAccess, offset: number, limit: number, q: string): Promise<ArtistPage> {
    const names = new Map<string, string>();
    for (const album of this.#albums(access)) if (album.artistID) names.set(album.artistID, album.artist);
    const items = [...names]
      .flatMap(([id, name]) => (!q || name.toLowerCase().includes(q.toLowerCase()) ? [{ id, name, hasArtwork: false }] : []))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { items: items.slice(offset, offset + limit), total: items.length };
  }
  async plexAlbum(access: PlexAccess, albumID: string): Promise<AlbumDetail> {
    const album = this.#albums(access).find((candidate) => candidate.id === albumID);
    if (!album) throw notFound();
    const original = this.libraries.get(access.token)?.find((candidate) => candidate.id === albumID);
    return {
      album: { ...album, artistMBID: original?.artistMBID ?? null },
      tracks: [{ ...fixtureTrack(plexIDs.track, album.id), favorite: this.favorites.has(plexIDs.track) }],
    };
  }
  async plexLibraryIndex(access: PlexAccess): Promise<LibraryContents> {
    this.indexCalls++;
    const albums = this.libraries.get(access.token) ?? [];
    this.#albums(access);
    const artistMBIDs = new Map<string, string>();
    for (const album of albums) if (album.artistID && album.artistMBID) artistMBIDs.set(album.artistID, album.artistMBID);
    return {
      albums: albums.map((album) => ({ id: album.id, title: album.title, artist: album.artist, artistID: album.artistID, releaseMBID: album.releaseMBID })),
      artistMBIDs,
    };
  }
  async releaseGroupsOf(releaseMBIDs: string[]): Promise<Map<string, string | null>> {
    this.releaseLookups.push(releaseMBIDs);
    if (this.failReleaseLookup) throw this.failReleaseLookup;
    return new Map(
      releaseMBIDs.map((id) => [id, Object.values(identities).find((identity) => identity.releaseMBID === id)?.releaseGroupMBID ?? null]),
    );
  }
  async plexPlaylists(access: PlexAccess): Promise<Playlist[]> {
    this.#albums(access);
    return (this.playlists.get(access.token) ?? []).map((entry) => entry.playlist);
  }
  async plexPlaylist(access: PlexAccess, playlistID: string): Promise<PlaylistDetail> {
    this.#albums(access);
    const entry = (this.playlists.get(access.token) ?? []).find((candidate) => candidate.playlist.id === playlistID);
    if (!entry) throw notFound();
    return { playlist: entry.playlist, tracks: entry.tracks.map((id) => fixtureTrack(id, plexIDs.album)) };
  }
  async plexAddToPlaylist(access: PlexAccess, playlistID: string, trackIDs: string[]): Promise<void> {
    const { playlist } = await this.plexPlaylist(access, playlistID);
    if (playlist.smart)
      throw new UpstreamError("upstream_rejected", 409, "Smart playlists fill themselves in Plex. Choose a regular playlist.", "not_applied");
    this.playlistAdds.push({ playlistID, trackIDs });
  }
  async plexFavorite(access: PlexAccess, itemID: string, favorite: boolean): Promise<void> {
    if (itemID !== plexIDs.track && !this.#albums(access).some((album) => album.id === itemID)) throw notFound();
    if (favorite) this.favorites.add(itemID);
    else this.favorites.delete(itemID);
  }
  async plexReport(access: PlexAccess, report: TimelineReport): Promise<string | null> {
    await this.plexTrack(access, report.trackID);
    this.reports.push({ ...report, session: access.session });
    return this.terminate;
  }
  async plexTrack(access: PlexAccess, trackID: string): Promise<PlayableTrack> {
    if (!this.#albums(access).length || ![plexIDs.track, plexIDs.alacTrack].some((id) => id === trackID)) throw notFound();
    const alac = trackID === plexIDs.alacTrack;
    return {
      ...fixtureTrack(trackID, plexIDs.album),
      partKey: `/library/parts/${trackID}/1/file.${alac ? "m4a" : "flac"}`,
      transcode: alac,
      durationMs: 100,
    };
  }
  async plexArtwork(access: PlexAccess, itemID: string, size: ArtworkSize): Promise<Artwork> {
    this.artworkSizes.push(size);
    const album = this.#albums(access).find((candidate) => candidate.id === itemID);
    if (!album) throw notFound();
    if (!album.hasArtwork) throw new UpstreamError("upstream_rejected", 404, "This item has no artwork.", "not_applied");
    return { type: "image/png", bytes: readFileSync(new URL("./fixtures/cover-evening.png", import.meta.url)) };
  }
  async plexStream(
    _access: PlexAccess,
    _track: PlayableTrack,
    range: string | undefined,
    _ifRange: string | undefined,
    signal: AbortSignal,
  ): Promise<Response> {
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
  async plexTranscode(_access: PlexAccess, track: PlayableTrack, offset: number, session: string, signal: AbortSignal): Promise<Response> {
    signal.throwIfAborted();
    this.transcodes.push({ trackID: track.id, offset, session });
    return new Response(audio, { status: 200, headers: { "Content-Type": "audio/mpeg" } });
  }
  async plexStopTranscode(_access: PlexAccess, session: string): Promise<void> {
    this.stoppedTranscodes.push(session);
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
