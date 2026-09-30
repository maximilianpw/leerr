import type { Logger } from "./log.ts";
import type { Acquisition, AcquisitionStatus, Phase, Settings, Store } from "./store.ts";
import { UpstreamError, type LidarrAccess, type LidarrAlbum, type Upstreams } from "./upstream/index.ts";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
/** How often in-flight work is re-read from Lidarr. */
export const POLL = MINUTE;
/** How long an unconfirmed add/monitor/search may stay unresolved before surfacing. */
export const CONFIRM_GRACE = 15 * MINUTE;
/** A search that finished without an import is reported as not found after this. */
export const IMPORT_DEADLINE = 24 * HOUR;
/** Failed and attention rows are still re-read occasionally: Lidarr may import later. */
export const IDLE_POLL = HOUR;
const NEVER = Number.MAX_SAFE_INTEGER;
const BATCH = 25;

type Changes = Parameters<Store["updateAcquisition"]>[2];

/**
 * Drives each acquisition through Lidarr, one row at a time.
 *
 * Every Lidarr mutation is journalled as a `pending_*` phase before it is
 * sent. If the outcome is unknown (timeout, 5xx), later passes resolve it by
 * reading Lidarr and never repeat the mutation automatically. An unresolved
 * mutation surfaces as `attention` after CONFIRM_GRACE, and only an explicit
 * retry sends it again.
 */
export class Reconciler {
  readonly #store: Store;
  readonly #upstream: Upstreams;
  readonly #now: () => number;
  readonly #log: Logger;
  #active: Promise<void> | null = null;
  #again = false;
  #stopped = false;

  constructor(store: Store, upstream: Upstreams, now: () => number, log: Logger) {
    this.#store = store;
    this.#upstream = upstream;
    this.#now = now;
    this.#log = log;
  }

  /** Runs a pass; a call during a pass schedules exactly one follow-up pass. */
  run(): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    if (this.#active) {
      this.#again = true;
      return this.#active;
    }
    this.#active = (async () => {
      do {
        this.#again = false;
        await this.#pass();
      } while (this.#again && !this.#stopped);
    })().finally(() => {
      this.#active = null;
    });
    return this.#active;
  }
  async settle(): Promise<void> {
    await this.#active;
  }
  /** Finishes the current row, then refuses new passes. */
  async stop(): Promise<void> {
    this.#stopped = true;
    await this.#active;
  }

  /** Re-arms a failed or attention acquisition. Returns false if it is not retryable. */
  retry(id: string): boolean {
    const now = this.#now();
    const reset: Changes = {
      status: "requested",
      reason: null,
      phase: "ready",
      phaseAt: now,
      commandID: null,
      failures: 0,
      nextAt: 0,
    };
    return (
      this.#store.updateAcquisition(id, { status: "failed" }, reset, now) ||
      this.#store.updateAcquisition(id, { status: "attention" }, reset, now)
    );
  }

  async #pass() {
    const now = this.#now();
    this.#store.prune(now);
    const settings = this.#store.settings();
    if (!settings.lidarrURL || !settings.lidarrKey) return;
    const access: LidarrAccess = { endpoint: settings.lidarrURL, key: settings.lidarrKey };
    for (const row of this.#store.dueAcquisitions(now, BATCH)) {
      if (this.#stopped) return;
      try {
        await this.#advance(row, access, settings);
      } catch (cause) {
        this.#failed(row, cause);
      }
    }
  }

  #update(row: Acquisition, expectedPhase: Phase, changes: Changes): boolean {
    return this.#store.updateAcquisition(row.id, { phase: expectedPhase }, changes, this.#now());
  }
  #wait(row: Acquisition, status: AcquisitionStatus, delay: number, reason: string | null = null) {
    this.#update(row, row.phase, { status, reason, failures: 0, nextAt: this.#now() + delay });
  }

  #failed(row: Acquisition, cause: unknown) {
    const now = this.#now();
    const failures = row.failures + 1;
    const nextAt = now + Math.min(HOUR, 30 * SECOND * 2 ** Math.min(failures, 7));
    if (cause instanceof UpstreamError) {
      this.#log("acquisition_upstream_error", {
        acquisition: row.id,
        phase: row.phase,
        code: cause.code,
        status: cause.status,
      });
      // The phase is untouched: a pending mutation is still resolved by reading.
      this.#store.updateAcquisition(row.id, {}, { failures, nextAt, reason: cause.message }, now);
      return;
    }
    this.#log("acquisition_error", {
      acquisition: row.id,
      phase: row.phase,
      error: cause instanceof Error ? `${cause.name}: ${cause.message}` : "non-error thrown",
    });
    this.#store.updateAcquisition(
      row.id,
      {},
      {
        failures,
        nextAt,
        status: "attention",
        reason: "Leerr hit an unexpected error while processing this request. An administrator should check the server log.",
      },
      now,
    );
  }

  /**
   * Journals `pending` before running a mutation. If the mutation is known not
   * to have been applied, the journal is rolled back so it is safe to repeat.
   * Returns null when another writer already moved the row on.
   */
  async #mutate<T>(
    row: Acquisition,
    from: Phase,
    pending: Phase,
    extra: Changes,
    action: () => Promise<T>,
  ): Promise<{ value: T } | null> {
    if (!this.#update(row, from, { ...extra, phase: pending, phaseAt: this.#now() })) return null;
    try {
      return { value: await action() };
    } catch (cause) {
      if (cause instanceof UpstreamError && cause.outcome === "not_applied")
        this.#update(row, pending, { phase: from, phaseAt: this.#now() });
      throw cause;
    }
  }

  async #advance(row: Acquisition, access: LidarrAccess, settings: Settings) {
    const album = await this.#upstream.lidarrAlbum(access, row.releaseGroupMBID);
    if (album?.imported) {
      this.#store.updateAcquisition(
        row.id,
        {},
        { status: "imported", reason: null, phase: "finished", lidarrAlbumID: album.id, failures: 0, nextAt: NEVER },
        this.#now(),
      );
      return;
    }
    switch (row.phase) {
      case "ready":
        return this.#start(row, album, access, settings);
      case "pending_add":
        if (album && this.#update(row, "pending_add", { phase: "ready", lidarrAlbumID: album.id }))
          return this.#start({ ...row, phase: "ready" }, album, access, settings);
        return this.#awaitConfirmation(row, "Lidarr did not confirm adding this album. Check Lidarr, then retry.");
      case "pending_monitor":
        if (album?.monitored && this.#update(row, "pending_monitor", { phase: "ready" }))
          return this.#start({ ...row, phase: "ready" }, album, access, settings);
        return this.#awaitConfirmation(row, "Lidarr did not confirm monitoring this album. Check Lidarr, then retry.");
      case "pending_search":
      case "searching":
        if (!album) {
          this.#update(row, row.phase, {
            status: "failed",
            reason: "The album was removed from Lidarr. Retry to add it again.",
            phase: "finished",
            nextAt: this.#now() + IDLE_POLL,
          });
          return;
        }
        return this.#followSearch(row, album, access);
      case "finished":
        this.#wait(row, row.status, IDLE_POLL, row.reason);
        return;
    }
  }

  #awaitConfirmation(row: Acquisition, reason: string) {
    if (this.#now() - row.phaseAt > CONFIRM_GRACE) this.#wait(row, "attention", IDLE_POLL, reason);
    else this.#wait(row, "requested", POLL);
  }

  async #start(row: Acquisition, found: LidarrAlbum | null, access: LidarrAccess, settings: Settings) {
    let album = found;
    if (!album) {
      const candidate = await this.#upstream.lidarrLookup(
        access,
        {
          releaseGroupMBID: row.releaseGroupMBID,
          releaseMBID: row.releaseMBID,
          artistMBID: row.artistMBID,
          title: row.title,
          artist: row.artist,
        },
        {
          rootFolderPath: settings.rootFolderPath,
          qualityProfileID: settings.qualityProfileID,
          metadataProfileID: settings.metadataProfileID,
        },
      );
      const added = await this.#mutate(row, "ready", "pending_add", { status: "requested", reason: null }, () =>
        this.#upstream.lidarrCreate(access, candidate),
      );
      if (!added) return;
      album = await this.#upstream.lidarrAlbum(access, row.releaseGroupMBID);
      if (!album) {
        this.#update(row, "pending_add", { nextAt: this.#now() + 30 * SECOND });
        return;
      }
      if (!this.#update(row, "pending_add", { phase: "ready", lidarrAlbumID: album.id })) return;
    }
    if (!album.monitored) {
      const target = album;
      const monitored = await this.#mutate(row, "ready", "pending_monitor", { lidarrAlbumID: target.id }, () =>
        this.#upstream.lidarrMonitor(access, target, row.releaseMBID),
      );
      if (!monitored) return;
      const checked = await this.#upstream.lidarrAlbum(access, row.releaseGroupMBID);
      if (!checked?.monitored) {
        this.#update(row, "pending_monitor", { nextAt: this.#now() + 30 * SECOND });
        return;
      }
      if (!this.#update(row, "pending_monitor", { phase: "ready" })) return;
      album = checked;
    }
    // The floor excludes every search that existed before this one was sent.
    const floor = await this.#upstream.lidarrLatestCommandID(access);
    const albumID = album.id;
    const searched = await this.#mutate(
      row,
      "ready",
      "pending_search",
      { lidarrAlbumID: albumID, searchFloor: floor, commandID: null },
      () => this.#upstream.lidarrSearch(access, albumID),
    );
    if (!searched) return;
    this.#update(row, "pending_search", {
      phase: "searching",
      phaseAt: this.#now(),
      commandID: searched.value,
      status: "acquiring",
      reason: null,
      failures: 0,
      nextAt: this.#now() + POLL,
    });
  }

  async #followSearch(row: Acquisition, album: LidarrAlbum, access: LidarrAccess) {
    const command = await this.#upstream.lidarrLatestSearch(access, album.id, row.searchFloor);
    let current = row;
    if (row.phase === "pending_search") {
      if (!command) {
        if (this.#now() - row.phaseAt > CONFIRM_GRACE)
          this.#update(row, "pending_search", {
            status: "failed",
            reason: "Lidarr did not confirm the search. Retry to search again.",
            phase: "finished",
            nextAt: this.#now() + IDLE_POLL,
          });
        else this.#wait(row, "requested", POLL);
        return;
      }
      const phaseAt = this.#now();
      if (!this.#update(row, "pending_search", { phase: "searching", commandID: command.id, phaseAt })) return;
      current = { ...row, phase: "searching", commandID: command.id, phaseAt };
    }
    // Lidarr forgets old commands; a missing command has finished one way or another.
    const status = command?.status ?? "completed";
    if (status === "queued" || status === "started") {
      this.#wait(current, "acquiring", POLL);
      return;
    }
    if (status === "failed" || status === "aborted" || status === "cancelled" || status === "orphaned") {
      this.#update(current, "searching", {
        status: "failed",
        reason: `Lidarr's search ${status === "failed" ? "failed" : `was ${status}`}. Retry to search again.`,
        phase: "finished",
        failures: 0,
        nextAt: this.#now() + IDLE_POLL,
      });
      return;
    }
    if (this.#now() - current.phaseAt > IMPORT_DEADLINE) {
      this.#update(current, "searching", {
        status: "failed",
        reason: "Lidarr found nothing to download within a day. Check Lidarr's indexers, then retry.",
        phase: "finished",
        failures: 0,
        nextAt: this.#now() + IDLE_POLL,
      });
      return;
    }
    this.#wait(current, "acquiring", 5 * POLL, "Searched. Waiting for Lidarr to download and import.");
  }
}
