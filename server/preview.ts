/** Isolated review server. Never imports deployment credentials or touches disk.
 * Not the production entry point. All upstream traffic is rejected unless fake. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildApp, passwordHash } from "./app.ts";
import { FakeUpstreams, identities, makeStore } from "./test-fixtures.ts";
import { type Album, UpstreamError } from "./upstream.ts";

class PreviewUpstreams extends FakeUpstreams {
  constructor() {
    super();
    this.libraries.set("admin-jelly-token", [
      {
        id: "available",
        title: "Evening Signals",
        artist: "The Quiet Hours",
        releaseGroupMBID: identities.album.releaseGroupMBID,
        releaseMBID: identities.album.releaseMBID,
      },
      ...[
        "Blue in the Morning",
        "Rooms with a View",
        "Soft Focus",
        "A Different Sky",
        "The Long Way Home",
        "After the Rain",
        "Frequencies",
        "Slow Motion",
      ].map(
        (title, index): Album => ({
          id: `preview-${index}`,
          title,
          artist: ["Coastal Lines", "Mira Sol", "Northbound"][index % 3],
          releaseGroupMBID: null,
          releaseMBID: null,
        }),
      ),
    ]);
  }
  override async resolve(q: string) {
    if (q === "error") throw new UpstreamError("upstream_unavailable", 503);
    if (q === "empty") return { items: [] };
    return {
      items: Object.values(identities).map((item) => ({
        id: item.releaseGroupMBID,
        title: item.title,
        artist: item.artist,
        artistMBID: item.artistMBID,
      })),
    };
  }
  override async recommendations() {
    return this.resolve("");
  }
  override async search(q: string) {
    return { ...(await this.resolve(q)), artists: [] };
  }
  override async editions() {
    return {
      items: [
        {
          id: identities.other.releaseMBID,
          title: "Original edition",
          date: "2024-09-01",
          country: "GB",
        },
      ],
    };
  }
  override async checkLastfm() {}
  override async jellyfinArtwork(
    endpoint: string,
    token: string,
    userID: string,
    id: string,
  ): Promise<Response> {
    await super.jellyfinAlbum(endpoint, token, userID, id);
    // One deliberately missing cover keeps the real fallback visible.
    if (id === "preview-7")
      throw new UpstreamError("upstream_unavailable", 404);
    const covers = ["evening", "coastal", "rooms"];
    const index =
      id === "available" ? 0 : (Number(id.slice(8)) + 1) % covers.length;
    const bytes = readFileSync(
      new URL(`./fixtures/cover-${covers[index]}.png`, import.meta.url),
    );
    return new Response(bytes, { headers: { "Content-Type": "image/png" } });
  }
  override async jellyfinAlbum(
    e: string,
    token: string,
    u: string,
    id: string,
  ) {
    const detail = await super.jellyfinAlbum(e, token, u, id);
    return {
      album: detail.album,
      tracks: [await this.jellyfinTrack(e, token, u, "tone")],
    };
  }
}

const store = makeStore();
const upstream = new PreviewUpstreams();
const origin = process.env.LEERR_PREVIEW_ORIGIN ?? "http://localhost:3000";
if (!process.env.LEERR_PREVIEW_SETUP) {
  store.db
    .prepare("INSERT INTO users(id,username,password,role) VALUES(?,?,?,?)")
    .run(
      "preview-admin",
      "preview",
      await passwordHash("preview-password"),
      "admin",
    );
  store.putSecret(
    "installation",
    "settings",
    JSON.stringify({
      jellyfinURL: "https://fixture.invalid",
      lidarrURL: "https://fixture.invalid",
      lidarrKey: "fixture-key",
      rootFolderPath: "/music",
      qualityProfileID: 1,
      metadataProfileID: 1,
    }),
  );
  store.putSecret(
    "preview-admin",
    "jellyfin",
    JSON.stringify({ token: "admin-jelly-token", userID: "jf-admin" }),
  );
  const item = identities.album;
  store.db
    .prepare(
      "INSERT INTO acquisitions(id,releaseGroupMBID,releaseMBID,artistMBID,title,artist,status) VALUES(?,?,?,?,?,?,?)",
    )
    .run(
      "preview-acq",
      item.releaseGroupMBID,
      item.releaseMBID,
      item.artistMBID,
      "Evening Signals",
      "The Quiet Hours",
      "imported",
    );
  store.db
    .prepare("INSERT INTO requests VALUES(?,?,?)")
    .run("preview-request", "preview-admin", "preview-acq");
}
const { app } = await buildApp({
  store,
  origin,
  setupToken: "preview-setup-token",
  upstream,
  secure: false,
  fixturePreview: true,
  webRoot: resolve("dist/web"),
});
await app.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? 3000) });
