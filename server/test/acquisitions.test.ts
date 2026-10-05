import assert from "node:assert/strict";
import test from "node:test";
import { CONFIRM_GRACE, DOWNLOAD_DEADLINE, IDLE_POLL, IMPORT_DEADLINE, POLL, Reconciler, STALL_GRACE, type StatusChange } from "../acquisitions.ts";
import { silentLogger } from "../log.ts";
import { configuredSettings, DELUXE, FakeUpstreams, identities, makeStore, Clock } from "../testing.ts";
import { UpstreamError, type LidarrAlbum } from "../upstream/index.ts";

function setup() {
  const store = makeStore();
  const upstream = new FakeUpstreams();
  const clock = new Clock();
  store.saveSettings({ ...configuredSettings, jellyfinURL: null });
  const user = store.createUser("alice", "hash", "member", clock.now());
  const { acquisition } = store.request(user.id, identities.album, clock.now());
  const changes: StatusChange[] = [];
  const worker = () => new Reconciler(store, upstream, clock.now, silentLogger, (change) => changes.push(change));
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
  /** Passes until the row reaches `phase` (the add/pin/search sequence takes several). */
  const until = async (phase: string, limit = 6) => {
    let row = state();
    for (let attempt = 0; attempt < limit && row.phase !== phase; attempt++) row = await pass();
    assert.equal(row.phase, phase);
    return row;
  };
  return { store, upstream, clock, worker, state, pass, until, changes, user, id: acquisition.id };
}

const timeout = () => new UpstreamError("upstream_unavailable", 503, "Lidarr did not respond in time.");
const refused = () => new UpstreamError("upstream_unavailable", 503, "Lidarr could not be reached (ECONNREFUSED).", "not_applied");
const existing = (values: Partial<LidarrAlbum> = {}): LidarrAlbum => ({
  id: 5,
  artistID: 2,
  monitored: false,
  anyReleaseOk: false,
  imported: false,
  releases: [{ id: identities.album.releaseMBID, monitored: false }],
  resource: { foreignAlbumId: identities.album.releaseGroupMBID, releases: [{ foreignReleaseId: identities.album.releaseMBID }] },
  ...values,
});
/** A promise the test resolves by hand, to hold an upstream call open. */
function gate() {
  let open = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

test("happy path: add, wait for Lidarr's editions, pin the requested one, search, then imported", async () => {
  const s = setup();
  let row = await s.pass();
  assert.equal(row.phase, "pending_add");
  assert.equal(row.pinEdition, true);
  assert.equal(s.upstream.searchCalls, 0, "nothing is searched before Lidarr has loaded the editions");
  row = await s.pass();
  assert.equal(row.phase, "ready");
  assert.equal(s.upstream.searchCalls, 0);
  row = await s.until("searching");
  assert.equal(row.status, "acquiring");
  assert.deepEqual([s.upstream.createCalls, s.upstream.monitorCalls, s.upstream.searchCalls], [1, 1, 1]);
  assert.ok(s.upstream.lidarr);
  assert.deepEqual(
    s.upstream.lidarr.releases.map((release) => [release.id, release.monitored]),
    [
      [identities.album.releaseMBID, true],
      [DELUXE, false],
    ],
    "Lidarr's own pick (the longest edition) is replaced by the requested one",
  );
  assert.equal(s.upstream.lidarr.anyReleaseOk, false);
  s.upstream.lidarr.imported = true;
  row = await s.pass();
  assert.equal(row.status, "imported");
  assert.equal(row.phase, "finished");
  assert.deepEqual([s.upstream.createCalls, s.upstream.searchCalls], [1, 1]);
  assert.deepEqual(
    s.changes.map((change) => change.status),
    ["imported"],
  );
});

test("an edition Lidarr's metadata lacks fails clearly instead of searching for another one", async () => {
  const s = setup();
  s.upstream.editionsAfterAdd = [{ id: DELUXE, tracks: 16 }];
  const row = await s.until("finished");
  assert.equal(row.status, "failed");
  assert.match(row.reason ?? "", /does not include the requested edition/);
  assert.equal(s.upstream.searchCalls, 0);
});

test("an album still loading in Lidarr past the grace period needs attention", async () => {
  const s = setup();
  s.upstream.refreshReads = 1_000;
  await s.pass();
  for (let attempt = 0; attempt < 3; attempt++) await s.pass();
  assert.equal(s.state().status, "requested");
  s.clock.advance(CONFIRM_GRACE + 1);
  const row = await s.pass();
  assert.equal(row.status, "attention");
  assert.match(row.reason ?? "", /not finished loading/);
  assert.equal(s.upstream.searchCalls, 0);
});

test("an add with unknown outcome is resolved by reading, never repeated", async () => {
  const s = setup();
  s.upstream.failCreate = timeout();
  let row = await s.pass();
  assert.equal(row.phase, "pending_add");
  // A fresh worker (as after a restart) sees the album and continues without re-adding.
  row = await s.until("searching");
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
  assert.deepEqual(
    s.changes.map((change) => change.status),
    ["attention"],
  );
  assert.equal(s.worker().retry(s.id), true);
  row = await s.until("searching");
  assert.equal(row.status, "acquiring");
  assert.equal(s.upstream.createCalls, 2);
});

test("an add that provably never reached Lidarr is rolled back and retried automatically", async () => {
  const s = setup();
  s.upstream.failCreate = refused();
  let row = await s.pass();
  assert.equal(row.phase, "ready");
  assert.equal(row.pinEdition, false, "nothing was added, so there is nothing to pin");
  assert.equal(row.status, "requested");
  assert.match(row.reason ?? "", /ECONNREFUSED/);
  assert.ok(row.nextAt > s.clock.now());
  row = await s.until("searching");
  assert.equal(s.upstream.createCalls, 2);
});

test("a monitor with unknown outcome is not repeated, and is confirmed only once the edition is pinned", async () => {
  const s = setup();
  s.upstream.lidarr = existing();
  s.upstream.failMonitor = timeout();
  let row = await s.pass();
  assert.equal(row.phase, "pending_monitor");
  row = await s.pass(s.worker());
  assert.equal(row.phase, "searching");
  assert.deepEqual([s.upstream.monitorCalls, s.upstream.createCalls], [1, 0]);
});

test("a monitor whose edition never gets pinned is not confirmed by the album being monitored", async () => {
  const s = setup();
  s.upstream.lidarr = existing();
  // Lidarr monitors the album but leaves another edition chosen.
  s.upstream.lidarrMonitor = async () => {
    s.upstream.monitorCalls++;
    if (s.upstream.lidarr) s.upstream.lidarr.monitored = true;
    throw timeout();
  };
  s.upstream.lidarr.releases.push({ id: DELUXE, monitored: true });
  await s.pass();
  let row = await s.pass();
  assert.equal(row.phase, "pending_monitor");
  s.clock.advance(CONFIRM_GRACE + 1);
  row = await s.pass();
  assert.equal(row.status, "attention");
  assert.match(row.reason ?? "", /monitoring this edition/);
  assert.equal(s.upstream.searchCalls, 0);
});

test("an album the operator already monitors is searched but never modified", async () => {
  const s = setup();
  s.upstream.lidarr = existing({ monitored: true, anyReleaseOk: true, releases: [] });
  s.upstream.commands.push({ id: 50, status: "failed" });
  const row = await s.pass();
  assert.equal(row.status, "acquiring");
  assert.equal(row.searchFloor, 50, "a search from before this request is never adopted");
  assert.deepEqual([s.upstream.monitorCalls, s.upstream.createCalls, s.upstream.searchCalls], [0, 0, 1]);
});

test("an album already imported in Lidarr in any edition completes without mutations", async () => {
  const s = setup();
  s.upstream.lidarr = existing({ monitored: true, imported: true });
  const row = await s.pass();
  assert.equal(row.status, "imported");
  assert.deepEqual([s.upstream.createCalls, s.upstream.searchCalls], [0, 0]);
});

test("a search with unknown outcome is confirmed from Lidarr's command list", async () => {
  const s = setup();
  s.upstream.lidarr = existing({ monitored: true });
  s.upstream.failSearch = timeout();
  let row = await s.pass();
  assert.equal(row.phase, "pending_search");
  row = await s.pass(s.worker());
  assert.equal(row.phase, "searching");
  assert.equal(row.status, "acquiring");
  assert.equal(s.upstream.searchCalls, 1);
});

test("an unconfirmed search needs attention after the grace period, blocks a Lidarr switch, and retry searches once more", async () => {
  const s = setup();
  s.upstream.lidarr = existing({ monitored: true });
  s.upstream.searchRegisters = false;
  s.upstream.failSearch = timeout();
  await s.pass();
  s.clock.advance(CONFIRM_GRACE + 1);
  const row = await s.pass();
  assert.equal(row.status, "attention");
  assert.equal(row.phase, "pending_search");
  assert.match(row.reason ?? "", /did not confirm the search/);
  assert.equal(s.store.pendingMutationCount(), 1);
  assert.equal(s.upstream.searchCalls, 1);
  assert.ok(s.worker().retry(s.id));
  assert.equal((await s.pass()).status, "acquiring");
  assert.equal(s.upstream.searchCalls, 2);
});

test("a failed search fails the request; retry issues exactly one new search above the old one", async () => {
  const s = setup();
  s.upstream.lidarr = existing({ monitored: true });
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

test("searches are followed by id, so a Lidarr restart's orphaned search is reported at once", async () => {
  const s = setup();
  s.upstream.lidarr = existing({ monitored: true });
  await s.pass();
  // Lidarr restarted: its in-memory list is empty, its database marked the search orphaned.
  s.upstream.storedCommands = [{ id: s.upstream.commands[0].id, status: "orphaned" }];
  s.upstream.commands = [];
  const row = await s.pass();
  assert.equal(row.status, "failed");
  assert.match(row.reason ?? "", /was orphaned/);
});

test("after the search, Lidarr's queue decides between downloading, stuck and nothing found", async () => {
  const s = setup();
  s.upstream.lidarr = existing({ monitored: true });
  await s.pass();
  s.upstream.commands[0].status = "completed";
  let row = await s.pass();
  assert.equal(row.status, "acquiring");
  assert.match(row.reason ?? "", /Waiting for Lidarr/);
  s.upstream.downloads = [{ state: "active", detail: "downloading" }];
  s.clock.advance(IMPORT_DEADLINE);
  row = await s.pass();
  assert.equal(row.status, "acquiring", "a slow download is not 'nothing found'");
  assert.match(row.reason ?? "", /Downloading in Lidarr/);
  s.upstream.downloads = [{ state: "problem", detail: "No files found are eligible for import" }];
  row = await s.pass();
  assert.equal(row.status, "attention");
  assert.match(row.reason ?? "", /cannot finish it \(No files found/);
  s.upstream.downloads = [{ state: "active", detail: "downloading" }];
  row = await s.pass();
  assert.equal(row.status, "acquiring", "a recovered download goes back to acquiring");
  s.clock.advance(DOWNLOAD_DEADLINE);
  row = await s.pass();
  assert.equal(row.status, "attention");
  assert.match(row.reason ?? "", /for a week/);
});

test("a completed search that grabbed nothing becomes a retryable not-found", async () => {
  const s = setup();
  s.upstream.lidarr = existing({ monitored: true });
  await s.pass();
  s.upstream.commands[0].status = "completed";
  await s.pass();
  // Lidarr forgets old commands: a missing command still counts as completed.
  s.upstream.commands.length = 0;
  s.clock.advance(IMPORT_DEADLINE);
  const row = await s.pass();
  assert.equal(row.status, "failed");
  assert.match(row.reason ?? "", /nothing to download/);
  assert.ok(s.worker().retry(s.id));
});

test("a failed request keeps its reason through brief Lidarr outages and stays put in the list", async () => {
  const s = setup();
  s.upstream.lidarr = existing({ monitored: true });
  await s.pass();
  s.upstream.commands[0].status = "failed";
  const failed = await s.pass();
  const lidarrAlbum = s.upstream.lidarrAlbum.bind(s.upstream);
  s.upstream.lidarrAlbum = async () => {
    throw timeout();
  };
  let row = await s.pass();
  assert.match(row.reason ?? "", /search failed/);
  s.upstream.lidarrAlbum = lidarrAlbum;
  for (let hour = 0; hour < 24; hour++) row = await s.pass();
  assert.equal(row.status, "failed");
  assert.match(row.reason ?? "", /search failed/);
  assert.equal(row.updatedAt, failed.updatedAt, "idle re-checks do not count as updates");
});

test("a failed request that Lidarr later imports becomes imported", async () => {
  const s = setup();
  s.upstream.lidarr = existing({ monitored: true });
  await s.pass();
  s.upstream.commands[0].status = "failed";
  await s.pass();
  assert.ok(s.upstream.lidarr);
  s.upstream.lidarr.imported = true;
  assert.equal((await s.pass()).status, "imported");
});

test("retry only applies to settled rows, never to a mutation in flight", async () => {
  const s = setup();
  assert.equal(s.worker().retry(s.id), false);
  s.upstream.lidarr = existing({ monitored: true });
  await s.pass();
  assert.equal(s.worker().retry(s.id), false, "in-progress work is not retryable");
  // An attention row being resumed by the worker cannot be retried mid-mutation.
  s.store.updateAcquisition(s.id, {}, { status: "attention", phase: "ready", nextAt: 0 }, s.clock.now());
  const held = gate();
  const search = s.upstream.lidarrSearch.bind(s.upstream);
  s.upstream.lidarrSearch = async (access, albumID) => {
    await held.opened;
    return search(access, albumID);
  };
  const running = s.worker().run();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(s.state().phase, "pending_search");
  assert.equal(s.worker().retry(s.id), false);
  held.open();
  await running;
  assert.equal(s.upstream.searchCalls, 2);
});

test("a removed Lidarr album fails the request instead of polling forever", async () => {
  const s = setup();
  s.upstream.lidarr = existing({ monitored: true });
  await s.pass();
  s.upstream.lidarr = null;
  const row = await s.pass();
  assert.equal(row.status, "failed");
  assert.match(row.reason ?? "", /removed from Lidarr/);
});

test("reads failing with upstream errors back off without changing the phase, capped at an hour", async () => {
  const s = setup();
  s.upstream.lidarr = existing({ monitored: true });
  await s.pass();
  const lidarrAlbum = s.upstream.lidarrAlbum.bind(s.upstream);
  s.upstream.lidarrAlbum = async () => {
    throw timeout();
  };
  let row = await s.pass();
  assert.equal(row.phase, "searching");
  assert.equal(row.failures, 1);
  assert.ok(row.nextAt - s.clock.now() >= POLL);
  for (let attempt = 0; attempt < 10; attempt++) row = await s.pass();
  assert.equal(row.nextAt - s.clock.now(), IDLE_POLL);
  s.upstream.lidarrAlbum = lidarrAlbum;
  row = await s.pass();
  assert.equal(row.failures, 0);
});

test("an unconfirmed change needs attention even while Lidarr stays unreachable, so it can be retried", async () => {
  const s = setup();
  s.upstream.createApplies = false;
  s.upstream.failCreate = timeout();
  await s.pass();
  s.upstream.lidarrAlbum = async () => {
    throw refused();
  };
  let row = await s.pass();
  assert.equal(row.status, "requested");
  s.clock.advance(CONFIRM_GRACE + 1);
  row = await s.pass();
  assert.equal(row.status, "attention");
  assert.equal(row.phase, "pending_add");
  assert.match(row.reason ?? "", /cannot be reached/);
  assert.ok(s.worker().retry(s.id));
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

test("a run() during a pass queues exactly one follow-up pass, which picks up newly due work", async () => {
  const s = setup();
  s.upstream.lidarr = existing({ monitored: true });
  const reconciler = s.worker();
  const other = s.store.request(s.user.id, identities.other, s.clock.now()).acquisition.id;
  s.store.updateAcquisition(other, {}, { nextAt: Number.MAX_SAFE_INTEGER }, s.clock.now());
  let passes = 0;
  const lidarrAlbum = s.upstream.lidarrAlbum.bind(s.upstream);
  s.upstream.lidarrAlbum = async (access, group) => {
    if (group === identities.album.releaseGroupMBID && passes++ === 0) {
      // Something becomes due while the first pass is running, and two kicks arrive.
      s.store.updateAcquisition(other, {}, { nextAt: 0 }, s.clock.now());
      void reconciler.run();
      void reconciler.run();
    }
    return lidarrAlbum(access, group);
  };
  await reconciler.run();
  assert.notEqual(s.store.acquisition(other)?.nextAt, 0, "the follow-up pass processed the newly due row");
  await reconciler.stop();
  s.clock.advance(POLL * 10);
  await reconciler.run();
  assert.equal(passes, 1, "a stopped reconciler starts no new passes");
});

test("stopping lets an in-flight call finish but starts no new Lidarr change", async () => {
  const s = setup();
  const held = gate();
  const lookup = s.upstream.lidarrLookup.bind(s.upstream);
  s.upstream.lidarrLookup = async (access, identity, profile) => {
    await held.opened;
    return lookup(access, identity, profile);
  };
  const reconciler = s.worker();
  const running = reconciler.run();
  await new Promise((resolve) => setImmediate(resolve));
  const stopped = reconciler.stop();
  held.open();
  await Promise.all([running, stopped]);
  assert.equal(s.upstream.createCalls, 0);
  assert.equal(s.state().phase, "ready", "the row is resumed after a restart");
});

test("switching Lidarr mid-pass never sends the old installation a change meant for the new one", async () => {
  const s = setup();
  const held = gate();
  const lidarrAlbum = s.upstream.lidarrAlbum.bind(s.upstream);
  const seen: string[] = [];
  s.upstream.lidarrAlbum = async (access, group) => {
    seen.push(access.endpoint);
    if (seen.length === 1) await held.opened;
    return lidarrAlbum(access, group);
  };
  const create = s.upstream.lidarrCreate.bind(s.upstream);
  const created: string[] = [];
  s.upstream.lidarrCreate = async (access, candidate) => {
    created.push(access.endpoint);
    return create(access, candidate);
  };
  const reconciler = s.worker();
  const running = reconciler.run();
  await new Promise((resolve) => setImmediate(resolve));
  s.store.saveSettings({ ...s.store.settings(), lidarrURL: "https://other.test", lidarrKey: "k2" });
  s.store.restartAcquisitions(s.clock.now());
  // As the settings route does: a follow-up pass on the new installation.
  void reconciler.run();
  held.open();
  await running;
  assert.deepEqual(created, ["https://other.test"]);
});

test("without root folder and profiles, requests wait without failing, and saving them wakes them", async () => {
  const s = setup();
  s.store.saveSettings({ ...s.store.settings(), rootFolderPath: "", qualityProfileID: 0 });
  let row = await s.pass();
  assert.equal(row.status, "requested");
  assert.equal(row.failures, 0);
  assert.match(row.reason ?? "", /finish setting up Lidarr/);
  assert.equal(s.upstream.createCalls, 0);
  s.store.saveSettings({ ...s.store.settings(), rootFolderPath: "/music", qualityProfileID: 1 });
  assert.equal(s.store.wakeWaitingAcquisitions(s.clock.now()), 1);
  assert.equal(s.state().nextAt, 0);
  row = await s.pass();
  assert.equal(row.phase, "pending_add");
});

test("requesting an imported album again re-checks Lidarr: still there completes, gone is re-added", async () => {
  const s = setup();
  s.upstream.lidarr = existing({ monitored: true, imported: true });
  assert.equal((await s.pass()).status, "imported");
  const bob = s.store.createUser("bob", "hash", "member", s.clock.now());
  s.store.request(bob.id, identities.album, s.clock.now());
  assert.equal(s.state().status, "requested");
  assert.equal((await s.pass()).status, "imported");
  assert.deepEqual([s.upstream.createCalls, s.upstream.searchCalls], [0, 0]);
  s.upstream.lidarr = null;
  s.store.request(s.user.id, identities.album, s.clock.now());
  const row = await s.until("searching");
  assert.equal(row.status, "acquiring");
  assert.equal(s.upstream.createCalls, 1);
});

test("a pass handles at most 25 rows and leaves the rest due", async () => {
  const s = setup();
  s.upstream.lidarr = existing({ monitored: true, imported: true });
  const ids = [s.id];
  for (let index = 0; index < 30; index++) {
    const group = `${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`;
    ids.push(s.store.request(s.user.id, { ...identities.album, releaseGroupMBID: group }, s.clock.now()).acquisition.id);
  }
  await s.worker().run();
  const imported = ids.filter((id) => s.store.acquisition(id)?.status === "imported").length;
  assert.equal(imported, 25);
});

test("a stalled download gets an hour's grace, and each outcome is announced once", async () => {
  const s = setup();
  // One worker throughout, as in the server: it remembers when a stall began.
  const reconciler = s.worker();
  const pass = () => s.pass(reconciler);
  s.upstream.lidarr = existing({ monitored: true });
  await pass();
  s.upstream.commands[0].status = "completed";
  const stalled = { state: "stalled" as const, detail: "The download is stalled with no connections" };
  const moving = { state: "active" as const, detail: "downloading" };
  for (const downloads of [[stalled], [moving], [stalled]]) {
    s.upstream.downloads = downloads;
    assert.equal((await pass()).status, "acquiring", "a brief stall is not a problem");
  }
  assert.match(s.state().reason ?? "", /currently The download is stalled/);
  s.clock.advance(STALL_GRACE + 1);
  let row = await pass();
  assert.equal(row.status, "attention");
  // Flapping between stalled and moving updates the status quietly after the first announcement.
  s.upstream.downloads = [moving];
  assert.equal((await pass()).status, "acquiring");
  s.upstream.downloads = [stalled];
  assert.equal((await pass()).status, "acquiring", "the grace starts again");
  s.clock.advance(STALL_GRACE + 1);
  row = await pass();
  assert.equal(row.status, "attention");
  assert.deepEqual(
    s.changes.map((change) => change.status),
    ["attention"],
  );
});

test("an error after the row moved on in the same pass is still recorded, with backoff", async () => {
  const s = setup();
  s.upstream.lidarr = existing({ monitored: true });
  s.upstream.failSearch = new UpstreamError("upstream_unavailable", 503, "Lidarr did not respond in time.");
  const row = await s.pass();
  assert.equal(row.phase, "pending_search");
  assert.equal(row.failures, 1, "the timeout after journalling is counted");
  assert.match(row.reason ?? "", /did not respond/);
  assert.ok(row.nextAt > s.clock.now());
});

test("a retry while the worker waits on Lidarr is not overwritten by the worker's stale decision", async () => {
  const s = setup();
  s.upstream.refreshReads = 1_000;
  await s.pass();
  s.clock.advance(CONFIRM_GRACE + 1);
  assert.equal((await s.pass()).status, "attention");
  // The hourly re-check is in flight when an administrator retries.
  const held = gate();
  const refreshing = s.upstream.lidarrRefreshing.bind(s.upstream);
  s.upstream.lidarrRefreshing = async (access, album) => {
    await held.opened;
    return refreshing(access, album);
  };
  s.clock.advance(IDLE_POLL);
  const running = s.worker().run();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(s.worker().retry(s.id));
  held.open();
  await running;
  assert.equal(s.state().status, "requested", "the retry stands");
});

test("profiles saved while a pass waits on Lidarr are used by that pass", async () => {
  const s = setup();
  s.store.saveSettings({ ...s.store.settings(), rootFolderPath: "" });
  const held = gate();
  const lidarrAlbum = s.upstream.lidarrAlbum.bind(s.upstream);
  s.upstream.lidarrAlbum = async (access, group) => {
    await held.opened;
    return lidarrAlbum(access, group);
  };
  const running = s.worker().run();
  await new Promise((resolve) => setImmediate(resolve));
  s.store.saveSettings({ ...s.store.settings(), rootFolderPath: "/music" });
  held.open();
  await running;
  assert.equal(s.state().phase, "pending_add");
});

test("a pin waits for Lidarr's refresh even once editions are listed, and pins even when Lidarr chose right", async () => {
  const s = setup();
  // Lidarr happens to choose the requested edition itself (it is the longest).
  s.upstream.editionsAfterAdd = [
    { id: identities.album.releaseMBID, tracks: 20 },
    { id: DELUXE, tracks: 16 },
  ];
  await s.pass();
  await s.pass();
  const refreshing = s.upstream.lidarrRefreshing.bind(s.upstream);
  let stillRefreshing = true;
  s.upstream.lidarrRefreshing = async (access, album) => stillRefreshing || refreshing(access, album);
  let row = await s.pass();
  assert.equal(row.phase, "ready");
  assert.equal(s.upstream.monitorCalls, 0, "no pin while Lidarr is still saving its choice");
  stillRefreshing = false;
  row = await s.until("searching");
  // anyReleaseOk was posted as true for the add; the pin turns it off so other editions are refused.
  assert.equal(s.upstream.monitorCalls, 1);
  assert.equal(s.upstream.lidarr?.anyReleaseOk, false);
});

test("re-checking an album that is still imported does not announce it again", async () => {
  const s = setup();
  s.upstream.lidarr = existing({ monitored: true, imported: true });
  await s.pass();
  assert.equal(s.worker().retry(s.id), false, "members cannot re-check imported albums");
  assert.ok(s.worker().retry(s.id, true));
  assert.equal((await s.pass()).status, "imported");
  assert.deepEqual(
    s.changes.map((change) => change.status),
    ["imported"],
  );
});

test("the worker's last problem stays visible after later passes", async () => {
  const s = setup();
  s.upstream.lidarrAlbum = async () => {
    throw new UpstreamError("upstream_auth", 502, "Lidarr returned HTTP 401 (unauthorized).", "not_applied");
  };
  const reconciler = s.worker();
  await reconciler.run();
  s.store.updateAcquisition(s.id, {}, { nextAt: Number.MAX_SAFE_INTEGER }, s.clock.now());
  await reconciler.run();
  assert.match(reconciler.status().lastError?.message ?? "", /401/);
});

test("a failing notification target never stops the worker", async () => {
  const s = setup();
  const logged: string[] = [];
  const failing = new Reconciler(s.store, s.upstream, s.clock.now, (event) => void logged.push(event), () => {
    throw new Error("notification target down");
  });
  s.upstream.lidarr = existing({ monitored: true, imported: true });
  s.clock.advance(Math.max(0, s.state().nextAt - s.clock.now()));
  await failing.run();
  assert.equal(s.state().status, "imported");
  assert.ok(logged.includes("notification_failed"));
});
