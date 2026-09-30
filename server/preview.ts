/**
 * Fixture preview: an in-memory demo with fake upstreams, for UI work and
 * screenshots. It never reads deployment configuration or touches disk, and
 * refuses to store credentials. Never deploy it.
 */
import { readFileSync } from "node:fs";
import { buildApp } from "./http/app.ts";
import { logEvent } from "./log.ts";
import { hashPassword } from "./passwords.ts";
import { FakeUpstreams, identities, makeStore } from "./testing.ts";
import { UpstreamError, type Album, type AlbumDetail, type Artwork, type JellyfinAccess } from "./upstream/index.ts";

const covers = ["evening", "coastal", "rooms"].map((name) =>
  readFileSync(new URL(`./fixtures/cover-${name}.png`, import.meta.url)),
);
const titles = [
  "Blue in the Morning",
  "Rooms with a View",
  "Soft Focus",
  "A Different Sky",
  "The Long Way Home",
  "After the Rain",
  "Frequencies",
  "Slow Motion",
];

class PreviewUpstreams extends FakeUpstreams {
  constructor() {
    super();
    const albums: Album[] = [
      {
        id: "available",
        title: identities.album.title,
        artist: identities.album.artist,
        year: 2024,
        releaseGroupMBID: identities.album.releaseGroupMBID,
        releaseMBID: identities.album.releaseMBID,
      },
      ...titles.map((title, index) => ({
        id: `preview-${index}`,
        title,
        artist: ["Coastal Lines", "Mira Sol", "Northbound"][index % 3],
        year: 2015 + index,
        releaseGroupMBID: null,
        releaseMBID: null,
      })),
    ];
    this.libraries.set("admin-jelly-token", albums);
  }
  override async jellyfinAlbum(access: JellyfinAccess, albumID: string): Promise<AlbumDetail> {
    const detail = await super.jellyfinAlbum(access, albumID);
    const names = ["Opening", "Low Tide", "Paper Lanterns", "Northern Line", "Closing Time"];
    return {
      album: detail.album,
      tracks: names.map((title, index) => ({
        ...detail.tracks[0],
        id: `${albumID}-t${index + 1}`,
        title,
        number: index + 1,
        artist: detail.album.artist,
      })),
    };
  }
  override async jellyfinArtwork(access: JellyfinAccess, itemID: string): Promise<Artwork> {
    await super.jellyfinAlbum(access, itemID);
    // One deliberately missing cover keeps the placeholder visible.
    if (itemID === "preview-7") throw new UpstreamError("upstream_rejected", 404, "No artwork.", "not_applied");
    const index = itemID === "available" ? 0 : (Number(itemID.slice(8)) + 1) % covers.length;
    return { type: "image/png", bytes: covers[index] };
  }
}

const store = makeStore();
const upstream = new PreviewUpstreams();
const now = Date.now();
if (!process.env.LEERR_PREVIEW_SETUP) {
  const admin = store.createUser("preview", await hashPassword("preview-password"), "admin", now);
  store.saveSettings({
    jellyfinURL: "https://jellyfin.fixture.invalid",
    lidarrURL: "https://lidarr.fixture.invalid",
    lidarrKey: "fixture-key",
    rootFolderPath: "/music",
    qualityProfileID: 1,
    metadataProfileID: 1,
  });
  store.putSecret(admin.id, "jellyfin", JSON.stringify({ token: "admin-jelly-token", userID: "jf-admin", username: "preview" }));
  const imported = store.request(admin.id, identities.album, now - 86_400_000);
  store.updateAcquisition(imported.acquisition.id, {}, { status: "imported", phase: "finished", nextAt: Number.MAX_SAFE_INTEGER }, now);
  // Leave the Lidarr fake empty for the second album so the worker demonstrates progress.
  upstream.lidarr = null;
}
const port = Number(process.env.PORT ?? 3000);
const { app, reconciler } = await buildApp({
  store,
  origin: process.env.LEERR_PREVIEW_ORIGIN ?? `http://localhost:${port}`,
  setupToken: "preview-setup-token",
  upstream,
  secure: false,
  fixturePreview: true,
  webRoot: new URL("../dist/web", import.meta.url).pathname,
  log: logEvent,
});
setInterval(() => void reconciler.run(), 5_000).unref();
await app.listen({ host: process.env.HOST ?? "127.0.0.1", port });
logEvent("preview_ready", { url: `http://localhost:${port}`, username: "preview", password: "preview-password" });
