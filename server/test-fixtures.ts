import { readFileSync } from "node:fs";
import { Store } from "./store.ts";
import {
  Upstreams,
  type Album,
  type Track,
  type Identity,
  type LidarrAlbumState,
  type LidarrCandidate,
  type LidarrCommand,
} from "./upstream.ts";

export const identities = {
  album: {
    releaseGroupMBID: "11111111-1111-4111-8111-111111111111",
    releaseMBID: "22222222-2222-4222-8222-222222222222",
    artistMBID: "33333333-3333-4333-8333-333333333333",
    title: "Fixture Album",
    artist: "Fixture Artist",
  },
  other: {
    releaseGroupMBID: "44444444-4444-4444-8444-444444444444",
    releaseMBID: "55555555-5555-4555-8555-555555555555",
    artistMBID: "66666666-6666-4666-8666-666666666666",
    title: "Other Album",
    artist: "Other Artist",
  },
} satisfies Record<string, Identity>;

export const fixtureKey = Buffer.alloc(32, 7);
export const makeStore = () => new Store(":memory:", fixtureKey);

export class FakeUpstreams extends Upstreams {
  constructor() {
    super(async () => {
      throw new Error("Unexpected live request in fixture.");
    });
  }
  logins = new Map([
    ["admin", { token: "admin-jelly-token", userID: "jf-admin" }],
    ["member", { token: "member-jelly-token", userID: "jf-member" }],
  ]);
  libraries = new Map<string, Album[]>([
    [
      "admin-jelly-token",
      [
        {
          id: "available",
          title: "Fixture Album",
          artist: "Fixture Artist",
          releaseGroupMBID: identities.album.releaseGroupMBID,
          releaseMBID: identities.album.releaseMBID,
        },
        {
          id: "untagged",
          title: "Untagged",
          artist: "Nobody",
          releaseGroupMBID: null,
          releaseMBID: null,
        },
      ],
    ],
    [
      "member-jelly-token",
      [
        {
          id: "member-only",
          title: "Member Album",
          artist: "Other Artist",
          releaseGroupMBID: identities.other.releaseGroupMBID,
          releaseMBID: identities.other.releaseMBID,
        },
      ],
    ],
  ]);
  audio = readFileSync(new URL("./fixtures/tone.flac", import.meta.url));
  loginCalls = 0;
  createCalls = 0;
  monitorCalls = 0;
  searchCalls = 0;
  latestCalls = 0;
  lidarrState: LidarrAlbumState | null = null;
  commands: LidarrCommand[] = [];
  failCreateAfterWrite = false;
  failMonitorAfterWrite = false;
  failSearchAfterWrite = false;

  override async jellyfinLogin(
    _endpoint: string,
    username: string,
    password: string,
  ) {
    this.loginCalls++;
    const value = this.logins.get(username);
    if (!value || password !== "jelly-password")
      throw new Error("bad fixture credentials");
    return value;
  }
  override async jellyfinLibrary(
    _e: string,
    token: string,
    _u: string,
    offset: number,
    limit: number,
    q = "",
  ) {
    const all = (this.libraries.get(token) ?? []).filter(
      (a) => !q || a.title.toLowerCase().includes(q.toLowerCase()),
    );
    return { items: all.slice(offset, offset + limit), total: all.length };
  }
  override async jellyfinAlbum(
    e: string,
    token: string,
    u: string,
    id: string,
  ): Promise<{ album: Album; tracks: Track[] }> {
    const album = (await this.jellyfinLibrary(e, token, u, 0, 500)).items.find(
      (x) => x.id === id,
    );
    if (!album) throw new Error("not permitted");
    return { album, tracks: [] };
  }
  override async jellyfinTrack(_e: string, _t: string, _u: string, id: string) {
    return {
      id,
      title: "Tone",
      artist: "Fixture Artist",
      duration: 0.1,
      sourceCodec: "flac",
      sourceSampleRate: 8000,
      sourceBitDepth: 16,
    };
  }
  override async jellyfinOriginal(
    _e: string,
    _t: string,
    _u: string,
    _id: string,
    range: string | undefined,
  ) {
    const headers = { "Content-Type": "audio/flac", "Accept-Ranges": "bytes" };
    if (!range)
      return new Response(this.audio, {
        status: 200,
        headers: { ...headers, "Content-Length": String(this.audio.length) },
      });
    const match = /^bytes=(\d+)-(\d*)$/.exec(range);
    const start = match ? Number(match[1]) : this.audio.length;
    const end = match?.[2] ? Number(match[2]) : this.audio.length - 1;
    if (start >= this.audio.length || end < start)
      return new Response(null, {
        status: 416,
        headers: {
          ...headers,
          "Content-Range": `bytes */${this.audio.length}`,
        },
      });
    const bounded = Math.min(end, this.audio.length - 1),
      body = this.audio.subarray(start, bounded + 1);
    return new Response(body, {
      status: 206,
      headers: {
        ...headers,
        "Content-Length": String(body.length),
        "Content-Range": `bytes ${start}-${bounded}/${this.audio.length}`,
      },
    });
  }
  override async confirmedIdentity(
    group: string,
    release: string,
    artist: string,
  ) {
    const found = Object.values(identities).find(
      (x) =>
        x.releaseGroupMBID === group &&
        x.releaseMBID === release &&
        x.artistMBID === artist,
    );
    if (!found) throw new Error("identity mismatch");
    return found;
  }
  override async lidarrOptions() {
    return {
      roots: [{ id: 1, name: "/music" }],
      qualities: [{ id: 1, name: "Lossless" }],
      metadata: [{ id: 1, name: "Standard" }],
    };
  }
  override async lidarrAlbum() {
    return this.lidarrState;
  }
  override async lidarrLookup(
    _e: string,
    _k: string,
    identity: Identity,
  ): Promise<LidarrCandidate> {
    return {
      foreignAlbumId: identity.releaseGroupMBID,
      artist: { foreignArtistId: identity.artistMBID },
      releases: [{ foreignReleaseId: identity.releaseMBID, monitored: true }],
    };
  }
  override async lidarrCreate(
    _e: string,
    _k: string,
    candidate: LidarrCandidate,
  ) {
    this.createCalls++;
    this.lidarrState = {
      id: 17,
      imported: false,
      monitored: true,
      resource: candidate,
    };
    if (this.failCreateAfterWrite) {
      this.failCreateAfterWrite = false;
      throw new Error("timeout after add");
    }
  }
  override async lidarrMonitor(
    _e: string,
    _k: string,
    album: LidarrAlbumState,
  ) {
    this.monitorCalls++;
    album.monitored = true;
    if (this.failMonitorAfterWrite) {
      this.failMonitorAfterWrite = false;
      throw new Error("timeout after monitor");
    }
  }
  override async lidarrLatestSearch(
    _e: string,
    _k: string,
    _id: number,
    after = 0,
  ) {
    this.latestCalls++;
    return [...this.commands].reverse().find((c) => c.id > after) ?? null;
  }
  override async lidarrSearch() {
    this.searchCalls++;
    const id = 100 + this.searchCalls;
    this.commands.push({ id, status: "started" });
    if (this.failSearchAfterWrite) {
      this.failSearchAfterWrite = false;
      throw new Error("timeout after search");
    }
    return id;
  }
}
