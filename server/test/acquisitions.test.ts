import assert from "node:assert/strict";
import test from "node:test";
import { CONFIRM_GRACE, IMPORT_DEADLINE, POLL, Reconciler } from "../acquisitions.ts";
import { silentLogger } from "../log.ts";
import { Clock, FakeUpstreams, identities, makeStore } from "../testing.ts";
import { UpstreamError } from "../upstream/index.ts";

function setup() {
  const store = makeStore();
  const upstream = new FakeUpstreams();
  const clock = new Clock();
  store.saveSettings({
    jellyfinURL: null,
    lidarrURL: "https://lidarr.test",
    lidarrKey: "key",
    rootFolderPath: "/music",
    qualityProfileID: 1,
    metadataProfileID: 1,
  });
  const user = store.createUser("alice", "hash", "member", clock.now());
  const { acquisition } = store.request(user.id, identities.album, clock.now());
  const worker = () => new Reconciler(store, upstream, clock.now, silentLogger);
  const state = () => {
    const row = store.acquisition(acquisition.id);
    assert.ok(row);
    return row;
  };
  // Runs a pass once the row is due.
  const pass = async (reconciler = worker()) => {
    clock.advance(Math.max(0, state().nextAt - clock.now()));
    await reconciler.run();
    return state();
  };
  return { store, upstream, clock, worker, state, pass, id: acquisition.id };
}

const timeout = () => new UpstreamError("upstream_unavailable", 503, "Lidarr did not respond in time.");
const refused = () => new UpstreamError("upstream_unavailable", 503, "Lidarr could not be reached (ECONNREFUSED).", "not_applied");

test("happy path: add, search, then imported", async () => {
  const s = setup();
  let row = await s.pass();
  assert.equal(row.status, "acquiring");
  assert.equal(row.phase, "searching");
  assert.deepEqual([s.upstream.createCalls, s.upstream.searchCalls], [1, 1]);
  row = await s.pass();
  assert.equal(row.status, "acquiring");
  assert.ok(s.upstream.lidarr);
  s.upstream.lidarr.imported = true;
  row = await s.pass();
  assert.equal(row.status, "imported");
  assert.equal(row.phase, "finished");
  assert.deepEqual([s.upstream.createCalls, s.upstream.searchCalls], [1, 1]);
});

test("an add with unknown outcome is resolved by reading, never repeated", async () => {
  const s = setup();
  s.upstream.failCreate = timeout();
  let row = await s.pass();
  assert.equal(row.phase, "pending_add");
  // A fresh worker (as after a restart) sees the album and continues without re-adding.
  row = await s.pass(s.worker());
  assert.equal(row.phase, "searching");
  assert.deepEqual([s.upstream.createCalls, s.upstream.searchCalls], [1, 1]);
});

test("an unconfirmed add surfaces for attention after the grace period, and retry adds again", async () => {
  const s = setup();
  s.upstream.createApplies = false;
  s.upstream.failCreate = timeout();
  await s.pass();
  let row = await s.pass();
  assert.equal(row.status, "requested");
  assert.equal(s.upstream.createCalls, 1);
  s.clock.advance(CONFIRM_GRACE + 1);
  row = await s.pass();
  assert.equal(row.status, "attention");
  assert.match(row.reason ?? "", /did not confirm adding/);
  assert.equal(s.upstream.createCalls, 1);
  assert.equal(s.worker().retry(s.id), true);
  row = await s.pass();
  assert.equal(row.status, "acquiring");
  assert.equal(s.upstream.createCalls, 2);
});

test("an add that provably never reached Lidarr is rolled back and retried automatically", async () => {
  const s = setup();
  s.upstream.failCreate = refused();
  let row = await s.pass();
  assert.equal(row.phase, "ready");
  assert.equal(row.status, "requested");
  assert.match(row.reason ?? "", /ECONNREFUSED/);
  assert.ok(row.nextAt > s.clock.now());
  row = await s.pass();
  assert.equal(row.phase, "searching");
  assert.equal(s.upstream.createCalls, 2);
});

test("a monitor with unknown outcome is not repeated", async () => {
  const s = setup();
  s.upstream.lidarr = {
    id: 5,
    monitored: false,
    imported: false,
    resource: { foreignAlbumId: identities.album.releaseGroupMBID, releases: [{ foreignReleaseId: identities.album.releaseMBID }] },
  };
  s.upstream.failMonitor = timeout();
  let row = await s.pass();
  assert.equal(row.phase, "pending_monitor");
  row = await s.pass(s.worker());
  assert.equal(row.phase, "searching");
  assert.deepEqual([s.upstream.monitorCalls, s.upstream.createCalls], [1, 0]);
});

test("an album the operator already monitors is searched but never modified", async () => {
  const s = setup();
  s.upstream.lidarr = {
    id: 5,
    monitored: true,
    imported: false,
    resource: { foreignAlbumId: identities.album.releaseGroupMBID, anyReleaseOk: true, releases: [] },
  };
  s.upstream.commands.push({ id: 50, status: "failed" });
  const row = await s.pass();
  assert.equal(row.status, "acquiring");
  assert.equal(row.searchFloor, 50, "a search from before this request is never adopted");
  assert.deepEqual([s.upstream.monitorCalls, s.upstream.createCalls, s.upstream.searchCalls], [0, 0, 1]);
});

test("an album already imported in Lidarr in any edition completes without mutations", async () => {
  const s = setup();
  s.upstream.lidarr = { id: 5, monitored: true, imported: true, resource: { foreignAlbumId: "x", releases: [] } };
  const row = await s.pass();
  assert.equal(row.status, "imported");
  assert.deepEqual([s.upstream.createCalls, s.upstream.searchCalls], [0, 0]);
});

test("a search with unknown outcome is confirmed from Lidarr's command list", async () => {
  const s = setup();
  s.upstream.failSearch = timeout();
  let row = await s.pass();
  assert.equal(row.phase, "pending_search");
  row = await s.pass(s.worker());
  assert.equal(row.phase, "searching");
  assert.equal(row.status, "acquiring");
  assert.equal(s.upstream.searchCalls, 1);
});

test("an unconfirmed search fails after the grace period and is retryable", async () => {
  const s = setup();
  s.upstream.searchRegisters = false;
  s.upstream.failSearch = timeout();
  await s.pass();
  s.clock.advance(CONFIRM_GRACE + 1);
  const row = await s.pass();
  assert.equal(row.status, "failed");
  assert.equal(s.upstream.searchCalls, 1);
  assert.ok(s.worker().retry(s.id));
  assert.equal((await s.pass()).status, "acquiring");
  assert.equal(s.upstream.searchCalls, 2);
});

test("a failed search fails the request; retry issues exactly one new search above the old one", async () => {
  const s = setup();
  await s.pass();
  s.upstream.commands[0].status = "failed";
  let row = await s.pass();
  assert.equal(row.status, "failed");
  assert.match(row.reason ?? "", /search failed/);
  row = await s.pass();
  assert.equal(row.status, "failed", "failed requests stay failed without a retry");
  assert.equal(s.upstream.searchCalls, 1);
  assert.ok(s.worker().retry(s.id));
  row = await s.pass();
  assert.equal(row.status, "acquiring");
  assert.equal(s.upstream.searchCalls, 2);
  assert.equal(row.searchFloor, 101);
  assert.equal(row.commandID, 102);
});

test("a completed search that never imports becomes a retryable not-found", async () => {
  const s = setup();
  await s.pass();
  s.upstream.commands[0].status = "completed";
  let row = await s.pass();
  assert.equal(row.status, "acquiring");
  assert.match(row.reason ?? "", /Waiting for Lidarr/);
  // Lidarr forgets old commands: a missing command still counts as completed.
  s.upstream.commands.length = 0;
  s.clock.advance(IMPORT_DEADLINE);
  row = await s.pass();
  assert.equal(row.status, "failed");
  assert.match(row.reason ?? "", /nothing to download/);
  assert.ok(s.worker().retry(s.id));
});

test("a failed request that Lidarr later imports becomes imported", async () => {
  const s = setup();
  await s.pass();
  s.upstream.commands[0].status = "failed";
  await s.pass();
  assert.ok(s.upstream.lidarr);
  s.upstream.lidarr.imported = true;
  assert.equal((await s.pass()).status, "imported");
});

test("retry only applies to failed or attention rows, and never races the worker", async () => {
  const s = setup();
  assert.equal(s.worker().retry(s.id), false);
  await s.pass();
  assert.equal(s.worker().retry(s.id), false, "in-progress work is not retryable");
});

test("a removed Lidarr album fails the request instead of polling forever", async () => {
  const s = setup();
  await s.pass();
  s.upstream.lidarr = null;
  const row = await s.pass();
  assert.equal(row.status, "failed");
  assert.match(row.reason ?? "", /removed from Lidarr/);
});

test("reads failing with upstream errors back off without changing the phase", async () => {
  const s = setup();
  await s.pass();
  const lidarrAlbum = s.upstream.lidarrAlbum.bind(s.upstream);
  s.upstream.lidarrAlbum = async () => {
    throw timeout();
  };
  let row = await s.pass();
  assert.equal(row.phase, "searching");
  assert.equal(row.failures, 1);
  assert.ok(row.nextAt - s.clock.now() >= POLL);
  s.upstream.lidarrAlbum = lidarrAlbum;
  row = await s.pass();
  assert.equal(row.failures, 0);
});

test("unexpected errors mark the request for attention", async () => {
  const s = setup();
  s.upstream.lidarrAlbum = async () => {
    throw new TypeError("bug");
  };
  const row = await s.pass();
  assert.equal(row.status, "attention");
  assert.equal(row.phase, "ready");
});

test("concurrent run() calls share one pass and queue exactly one follow-up", async () => {
  const s = setup();
  const reconciler = s.worker();
  let passes = 0;
  const lidarrAlbum = s.upstream.lidarrAlbum.bind(s.upstream);
  s.upstream.lidarrAlbum = (access, group) => {
    passes++;
    return lidarrAlbum(access, group);
  };
  await Promise.all([reconciler.run(), reconciler.run(), reconciler.run()]);
  // Pass one adds and searches (three reads); the follow-up finds nothing due.
  assert.equal(passes, 2);
  await reconciler.stop();
  s.clock.advance(POLL * 10);
  await reconciler.run();
  assert.equal(passes, 2, "a stopped reconciler starts no new passes");
});
