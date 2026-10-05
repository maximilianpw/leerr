/**
 * Fixture preview: an in-memory demo with fake upstreams, for UI work and
 * screenshots. It never reads deployment configuration or touches disk, and
 * refuses to store credentials. Never deploy it.
 */
import { readFileSync } from "node:fs";
import { buildApp } from "./http/app.ts";
import { logEvent } from "./log.ts";
import { hashPassword } from "./passwords.ts";
import { configuredSettings, FakeUpstreams, fixtureAlbum, identities, makeStore, plexIDs, plexLinkFor } from "./testing.ts";
import { UpstreamError, type Album, type AlbumDetail, type Artwork, type ArtworkSize, type PlayableTrack, type PlexAccess } from "./upstream/index.ts";

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
      fixtureAlbum({
        id: plexIDs.album,
        title: identities.album.title,
        artist: identities.album.artist,
        artistID: plexIDs.artist,
        artistMBID: identities.album.artistMBID,
        year: 2024,
        releaseMBID: identities.album.releaseMBID,
      }),
      ...titles.map((title, index) =>
        fixtureAlbum({
          id: String(110 + index),
          title,
          artist: ["Coastal Lines", "Mira Sol", "Northbound"][index % 3],
          artistID: String(510 + (index % 3)),
          year: 2015 + index,
          // One deliberately missing cover keeps the placeholder visible.
          hasArtwork: index !== 7,
          // One album in Plex's trash shows how deleted files look.
          available: index !== 5,
        }),
      ),
    ];
    this.libraries.set("admin-plex-token", albums);
  }
  /** Five tracks per album, numbered album id × 10 + n; the last of "Frequencies" is in Plex's trash. */
  override async plexAlbum(access: PlexAccess, albumID: string): Promise<AlbumDetail> {
    const detail = await super.plexAlbum(access, albumID);
    const names = ["Opening", "Low Tide", "Paper Lanterns", "Northern Line", "Closing Time"];
    return {
      album: detail.album,
      tracks: names.map((title, index) => ({
        ...detail.tracks[0],
        id: String(Number(albumID) * 10 + index + 1),
        title,
        number: index + 1,
        artist: detail.album.artist,
        albumID,
        albumTitle: detail.album.title,
        available: detail.album.available && !(albumID === "116" && index === names.length - 1),
      })),
    };
  }
  override async plexTrack(access: PlexAccess, trackID: string): Promise<PlayableTrack> {
    return { ...(await super.plexTrack(access, plexIDs.track)), id: trackID };
  }
  override async plexArtwork(access: PlexAccess, itemID: string, _size: ArtworkSize): Promise<Artwork> {
    const { album } = await super.plexAlbum(access, itemID);
    if (!album.hasArtwork) throw new UpstreamError("upstream_rejected", 404, "No artwork.", "not_applied");
    return { type: "image/png", bytes: covers[Number(itemID) % covers.length] };
  }
}

const store = makeStore();
const upstream = new PreviewUpstreams();
const now = Date.now();
if (!process.env.LEERR_PREVIEW_SETUP) {
  const admin = store.createUser("preview", await hashPassword("preview-password"), "admin", now);
  store.saveSettings({
    ...configuredSettings,
    plexURL: "https://plex.fixture.invalid",
    lidarrURL: "https://lidarr.fixture.invalid",
    lidarrKey: "fixture-key",
  });
  store.putSecret(admin.id, "plex", JSON.stringify(plexLinkFor("admin", "preview")));
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
