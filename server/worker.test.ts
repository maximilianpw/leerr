import assert from "node:assert/strict";
import test from "node:test";
import { Worker } from "./worker.ts";
import { FakeUpstreams, identities, makeStore } from "./test-fixtures.ts";

function fixture() {
  const store = makeStore(),
    upstream = new FakeUpstreams();
  let now = 1_700_000_000_000;
  store.putSecret(
    "installation",
    "settings",
    JSON.stringify({
      jellyfinURL: null,
      lidarrURL: "https://lidarr.test",
      lidarrKey: "key",
      rootFolderPath: "/music",
      qualityProfileID: 1,
      metadataProfileID: 1,
    }),
  );
  const x = identities.album;
  store.db
    .prepare(
      "INSERT INTO acquisitions(id,releaseGroupMBID,releaseMBID,artistMBID,title,artist) VALUES(?,?,?,?,?,?)",
    )
    .run(
      "acq",
      x.releaseGroupMBID,
      x.releaseMBID,
      x.artistMBID,
      x.title,
      x.artist,
    );
  return {
    store,
    upstream,
    clock: () => now,
    due() {
      now += 4_000_000;
      store.db.prepare("UPDATE acquisitions SET nextAt=0").run();
    },
  };
}

test("timeout after add is reconciled by a new Worker without duplicate add or search", async (t) => {
  const f = fixture();
  t.after(() => f.store.close());
  f.upstream.failCreateAfterWrite = true;
  await Promise.all([
    new Worker(f.store, f.upstream, f.clock).run(),
    new Worker(f.store, f.upstream, f.clock).run(),
  ]);
  assert.equal(f.upstream.createCalls, 1);
  f.due();
  const restarted = new Worker(f.store, f.upstream, f.clock);
  await Promise.all([restarted.run(), restarted.run()]);
  assert.equal(f.upstream.createCalls, 1);
  assert.equal(f.upstream.searchCalls, 1);
  f.due();
  await new Worker(f.store, f.upstream, f.clock).run();
  assert.equal(f.upstream.searchCalls, 1);
});

test("timeout after search persists upstream state and never repeats an uncertain command", async (t) => {
  const f = fixture();
  t.after(() => f.store.close());
  f.upstream.lidarrState = {
    id: 17,
    imported: false,
    monitored: true,
    resource: {
      foreignAlbumId: identities.album.releaseGroupMBID,
      artist: { foreignArtistId: identities.album.artistMBID },
      releases: [],
    },
  };
  f.upstream.failSearchAfterWrite = true;
  await new Worker(f.store, f.upstream, f.clock).run();
  assert.equal(f.upstream.searchCalls, 1);
  f.due();
  await new Worker(f.store, f.upstream, f.clock).run();
  assert.equal(f.upstream.searchCalls, 1);
  f.upstream.commands.length = 0;
  f.due();
  await new Worker(f.store, f.upstream, f.clock).run();
  assert.equal(f.upstream.searchCalls, 1);
  assert.equal(
    f.store.db
      .prepare("SELECT status FROM acquisitions WHERE id='acq'")
      .pluck()
      .get(),
    "uncertain",
  );
});

test("explicit retry of failed search advances floor and issues exactly one new command", async (t) => {
  const f = fixture();
  t.after(() => f.store.close());
  f.upstream.lidarrState = {
    id: 17,
    imported: false,
    monitored: true,
    resource: {
      foreignAlbumId: identities.album.releaseGroupMBID,
      artist: { foreignArtistId: identities.album.artistMBID },
      releases: [],
    },
  };
  await new Worker(f.store, f.upstream, f.clock).run();
  assert.equal(f.upstream.searchCalls, 1);
  f.upstream.commands[0].status = "failed";
  f.due();
  await new Worker(f.store, f.upstream, f.clock).run();
  assert.equal(
    f.store.db
      .prepare(
        "SELECT phase FROM acquisition_mutations WHERE acquisitionID='acq'",
      )
      .pluck()
      .get(),
    "failed_search",
  );
  f.store.db
    .prepare(
      "UPDATE acquisition_mutations SET phase='retry_requested' WHERE acquisitionID='acq'",
    )
    .run();
  f.due();
  await new Worker(f.store, f.upstream, f.clock).run();
  f.due();
  await new Worker(f.store, f.upstream, f.clock).run();
  assert.equal(f.upstream.searchCalls, 2);
  f.due();
  await new Worker(f.store, f.upstream, f.clock).run();
  assert.equal(f.upstream.searchCalls, 2);
});

test("monitor timeout is journalled and not repeated after restart", async (t) => {
  const f = fixture();
  t.after(() => f.store.close());
  f.upstream.lidarrState = {
    id: 17,
    imported: false,
    monitored: false,
    resource: {
      foreignAlbumId: identities.album.releaseGroupMBID,
      artist: { foreignArtistId: identities.album.artistMBID },
      releases: [],
    },
  };
  f.upstream.failMonitorAfterWrite = true;
  await new Worker(f.store, f.upstream, f.clock).run();
  assert.equal(f.upstream.monitorCalls, 1);
  f.due();
  await new Worker(f.store, f.upstream, f.clock).run();
  assert.equal(f.upstream.monitorCalls, 1);
});
