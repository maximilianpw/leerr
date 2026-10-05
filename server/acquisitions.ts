import type { Logger } from "./log.ts";
import { lidarrReady, type Acquisition, type AcquisitionStatus, type Phase, type Store } from "./store.ts";
import { UpstreamError, type LidarrAccess, type LidarrAlbum, type Upstreams } from "./upstream/index.ts";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** How often in-flight work is re-read from Lidarr. */
export const POLL = MINUTE;
/** A short re-check while Lidarr settles, e.g. right after an add. */
export const SETTLE = 30 * SECOND;
/** How long an unconfirmed add/monitor/search, or Lidarr loading a new album, may take before surfacing. */
export const CONFIRM_GRACE = 15 * MINUTE;
/** A search that grabbed nothing is reported as not found after this. */
export const IMPORT_DEADLINE = DAY;
/** A grabbed download that never finishes still surfaces eventually. */
export const DOWNLOAD_DEADLINE = 7 * DAY;
/** Download clients report brief stalls as warnings; only a lasting one needs a person. */
export const STALL_GRACE = HOUR;
/** Failed and attention rows are still re-read occasionally: Lidarr may import later. */
export const IDLE_POLL = HOUR;
const NEVER = Number.MAX_SAFE_INTEGER;
const BATCH = 25;

type Changes = Parameters<Store["updateAcquisition"]>[2];

/** A user-visible outcome worth telling people about. */
export type StatusChange = { acquisition: Acquisition; status: "imported" | "failed" | "attention"; reason: string | null };
export type StatusListener = (change: StatusChange) => void;

const WAITING_FOR_PROFILES = "Waiting for an administrator to finish setting up Lidarr (root folder and profiles).";

/** The requested edition is the one Lidarr wants, and the only one. */
export function pinned(album: LidarrAlbum, releaseMBID: string): boolean {
  return (
    album.monitored &&
    !album.anyReleaseOk &&
    album.releases.some((release) => release.id === releaseMBID && release.monitored) &&
    album.releases.every((release) => release.id === releaseMBID || !release.monitored)
  );
}

/** The row after `changes`; undefined leaves a column as it was, as in the store. */
function merge(row: Acquisition, changes: Changes): Acquisition {
  const keep = <T>(value: T | undefined, current: T): T => (value === undefined ? current : value);
  return {
    ...row,
    status: keep(changes.status, row.status),
    reason: keep(changes.reason, row.reason),
    phase: keep(changes.phase, row.phase),
    lidarrAlbumID: keep(changes.lidarrAlbumID, row.lidarrAlbumID),
    commandID: keep(changes.commandID, row.commandID),
    searchFloor: keep(changes.searchFloor, row.searchFloor),
    phaseAt: keep(changes.phaseAt, row.phaseAt),
    failures: keep(changes.failures, row.failures),
    nextAt: keep(changes.nextAt, row.nextAt),
    pinEdition: keep(changes.pinEdition, row.pinEdition),
    notified: keep(changes.notified, row.notified),
  };
}

/** Each outcome is announced once: an import per album, a failure or attention per attempt. */
function announcement(status: AcquisitionStatus, phaseAt: number): string | null {
  if (status === "imported") return "imported";
  if (status === "failed" || status === "attention") return `${status}:${phaseAt}`;
  return null;
}

/**
 * Drives each acquisition through Lidarr, one row at a time.
 *
 * Every Lidarr mutation is journalled as a `pending_*` phase before it is
 * sent. If the outcome is unknown (timeout, 5xx), later passes resolve it by
 * reading Lidarr and never repeat the mutation automatically. An unresolved
 * mutation surfaces as `attention` after CONFIRM_GRACE, and only an explicit
 * retry sends it again.
 *
 * Every write is a compare-and-set on the row as this pass last wrote it
 * (phase and phaseAt), so a retry or a Lidarr switch in the meantime wins.
 */
export class Reconciler {
  readonly #store: Store;
  readonly #upstream: Upstreams;
  readonly #now: () => number;
  readonly #log: Logger;
  readonly #listener: StatusListener;
  #active: Promise<void> | null = null;
  #again = false;
  #stopped = false;
  #lastPassAt: number | null = null;
  #lastError: { at: number; message: string } | null = null;
  /** When a download client first reported a stall (in memory: a restart restarts the grace). */
  readonly #stalledSince = new Map<string, number>();

  constructor(store: Store, upstream: Upstreams, now: () => number, log: Logger, listener: StatusListener = () => {}) {
    this.#store = store;
    this.#upstream = upstream;
    this.#now = now;
    this.#log = log;
    this.#listener = listener;
  }

  /** Runs a pass; a call during a pass schedules exactly one follow-up pass. Never rejects. */
  run(): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    if (this.#active) {
      this.#again = true;
      return this.#active;
    }
    this.#again = true;
    this.#active = (async () => {
      // Yield first, so #active is set before any work can call run() again.
      await Promise.resolve();
      while (this.#again && !this.#stopped) {
        this.#again = false;
        try {
          await this.#pass();
        } catch (cause) {
          // A broken pass (e.g. the database) must not take the server down.
          this.#log("reconcile_failed", { error: cause instanceof Error ? `${cause.name}: ${cause.message}` : "non-error thrown" });
          this.#lastError = { at: this.#now(), message: "Leerr hit an internal error. Check the server log." };
          return;
        }
      }
    })().finally(() => {
      this.#active = null;
    });
    return this.#active;
  }
  async settle(): Promise<void> {
    await this.#active;
  }
  /** Lets an in-flight Lidarr call finish, but starts no new mutation and no new pass. */
  async stop(): Promise<void> {
    this.#stopped = true;
    await this.#active;
  }
  /** Worker health for the administrator status page; the last problem stays until a newer one. */
  status() {
    return { lastPassAt: this.#lastPassAt, lastError: this.#lastError };
  }

  /**
   * Re-arms a failed or attention acquisition, or (for administrators) re-checks
   * an imported one. Returns false if it is still in progress.
   */
  retry(id: string, includeImported = false): boolean {
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
    this.#stalledSince.delete(id);
    return (
      this.#store.updateAcquisition(id, { status: "failed" }, reset, now) ||
      this.#store.updateAcquisition(id, { status: "attention" }, reset, now) ||
      (includeImported && this.#store.updateAcquisition(id, { status: "imported" }, reset, now))
    );
  }

  async #pass() {
    const now = this.#now();
    this.#lastPassAt = now;
    this.#store.prune(now);
    const settings = this.#store.settings();
    if (!settings.lidarrURL || !settings.lidarrKey) return;
    const access: LidarrAccess = { endpoint: settings.lidarrURL, key: settings.lidarrKey };
    for (const due of this.#store.dueAcquisitions(now, BATCH)) {
      // A switch to another Lidarr ends this pass; the follow-up pass uses the new one.
      if (this.#stopped || !this.#current(access)) return;
      // Another writer (a retry, a request) may have changed the row since the batch was read.
      const row = this.#store.acquisition(due.id);
      if (!row || row.nextAt > this.#now()) continue;
      try {
        await this.#advance(row, access);
      } catch (cause) {
        this.#failed(row.id, access, cause);
      }
    }
  }

  #current(access: LidarrAccess): boolean {
    const settings = this.#store.settings();
    return settings.lidarrURL === access.endpoint && settings.lidarrKey === access.key;
  }

  /**
   * Compare-and-set on the row as last written, announcing new outcomes once.
   * Returns the row as it now is, or null if someone else changed it first.
   */
  #update(row: Acquisition, changes: Changes): Acquisition | null {
    const next = merge(row, changes);
    const key = changes.status === undefined ? null : announcement(next.status, next.phaseAt);
    const announce = key !== null && key !== row.notified;
    if (announce) next.notified = key;
    const applied = this.#store.updateAcquisition(
      row.id,
      { phase: row.phase, phaseAt: row.phaseAt },
      announce ? { ...changes, notified: key } : changes,
      this.#now(),
    );
    if (!applied) return null;
    if (announce && (next.status === "imported" || next.status === "failed" || next.status === "attention"))
      try {
        this.#listener({ acquisition: next, status: next.status, reason: next.reason });
      } catch (cause) {
        // Telling people is a side effect: it must never change the acquisition.
        this.#log("notification_failed", { event: next.status, error: cause instanceof Error ? cause.message : "non-error thrown" });
      }
    return next;
  }
  /** Parks the row until `delay` from now. An undefined reason keeps the current one. */
  #wait(row: Acquisition, status: AcquisitionStatus, delay: number, reason?: string | null) {
    return this.#update(row, { status, reason, failures: 0, nextAt: this.#now() + delay });
  }
  #finish(row: Acquisition, status: "failed" | "attention", reason: string) {
    return this.#update(row, { status, reason, phase: "finished", failures: 0, nextAt: this.#now() + IDLE_POLL });
  }

  #failed(id: string, access: LidarrAccess, cause: unknown) {
    // The row may have been restarted for a new Lidarr; this error belongs to the old one.
    if (!this.#current(access)) return;
    // The pass may have moved the row on (e.g. journalled a mutation) before failing.
    const row = this.#store.acquisition(id);
    if (!row) return;
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
      this.#lastError = { at: now, message: cause.message };
      // The phase is untouched: a pending mutation is still resolved by reading.
      const changes: Changes = { failures, nextAt };
      if (row.phase.startsWith("pending_") && now - row.phaseAt > CONFIRM_GRACE) {
        changes.status = "attention";
        changes.reason = `Lidarr did not confirm a change and cannot be reached (${cause.message}). Check Lidarr, then retry or remove this request.`;
      } else if (row.phase !== "finished") {
        // A finished row keeps the reason it finished with; a brief outage must not replace it.
        changes.reason = cause.message;
      }
      this.#update(row, changes);
      return;
    }
    this.#log("acquisition_error", {
      acquisition: row.id,
      phase: row.phase,
      error: cause instanceof Error ? `${cause.name}: ${cause.message}` : "non-error thrown",
    });
    this.#lastError = { at: now, message: "Leerr hit an internal error. Check the server log." };
    this.#update(row, {
      failures,
      nextAt,
      status: "attention",
      reason: "Leerr hit an unexpected error while processing this request. An administrator should check the server log.",
    });
  }

  /**
   * Journals `pending` before running a mutation. If the mutation is known not
   * to have been applied, the journal is rolled back so it is safe to repeat.
   * Returns the journalled row, or null when shutting down, after a Lidarr
   * switch, or when another writer already moved the row on.
   */
  async #mutate<T>(
    row: Acquisition,
    access: LidarrAccess,
    pending: Phase,
    extra: Changes,
    action: () => Promise<T>,
  ): Promise<{ row: Acquisition; value: T } | null> {
    if (this.#stopped || !this.#current(access)) return null;
    // Status `requested` while in flight: a retry cannot interleave with this mutation.
    const journalled = this.#update(row, { status: "requested", reason: null, ...extra, phase: pending, phaseAt: this.#now() });
    if (!journalled) return null;
    try {
      return { row: journalled, value: await action() };
    } catch (cause) {
      if (cause instanceof UpstreamError && cause.outcome === "not_applied")
        // An add that never happened leaves nothing in Lidarr for Leerr to pin.
        this.#update(journalled, { phase: row.phase, phaseAt: this.#now(), pinEdition: pending === "pending_add" ? false : undefined });
      throw cause;
    }
  }

  async #advance(row: Acquisition, access: LidarrAccess) {
    const album = await this.#upstream.lidarrAlbum(access, row.releaseGroupMBID);
    if (!this.#current(access)) return;
    if (album?.imported) {
      this.#stalledSince.delete(row.id);
      this.#update(row, { status: "imported", reason: null, phase: "finished", lidarrAlbumID: album.id, failures: 0, nextAt: NEVER });
      return;
    }
    switch (row.phase) {
      case "ready":
        return this.#start(row, album, access);
      case "pending_add": {
        const added = album ? this.#update(row, { phase: "ready", lidarrAlbumID: album.id, status: "requested", reason: null }) : null;
        if (added && album) return this.#start(added, album, access);
        return this.#awaitConfirmation(row, "Lidarr did not confirm adding this album. Check Lidarr, then retry.");
      }
      case "pending_monitor": {
        const confirmed = album && pinned(album, row.releaseMBID) ? this.#update(row, { phase: "ready", status: "requested", reason: null }) : null;
        if (confirmed && album) return this.#start(confirmed, album, access);
        return this.#awaitConfirmation(row, "Lidarr did not confirm monitoring this edition. Check Lidarr, then retry.");
      }
      case "pending_search":
      case "searching":
        if (!album) {
          this.#finish(row, "failed", "The album was removed from Lidarr. Retry to add it again.");
          return;
        }
        return this.#followSearch(row, album, access);
      case "finished":
        this.#wait(row, row.status, IDLE_POLL);
        return;
    }
  }

  #awaitConfirmation(row: Acquisition, reason: string) {
    if (this.#now() - row.phaseAt > CONFIRM_GRACE) this.#wait(row, "attention", IDLE_POLL, reason);
    else this.#wait(row, "requested", POLL, null);
  }

  async #start(row: Acquisition, found: LidarrAlbum | null, access: LidarrAccess) {
    if (!found) {
      // Read now, not at the start of the pass: profiles saved meanwhile must not be missed.
      const settings = this.#store.settings();
      if (!lidarrReady(settings)) {
        // Not a failure: nothing can be added until the profiles exist, and saving them wakes this row.
        this.#update(row, { status: "requested", reason: WAITING_FOR_PROFILES, failures: 0, nextAt: this.#now() + POLL });
        return;
      }
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
      const added = await this.#mutate(row, access, "pending_add", { pinEdition: true }, () =>
        this.#upstream.lidarrCreate(access, candidate),
      );
      // Lidarr loads the new album's editions in the background: pin and search on a later pass.
      if (added) this.#update(added.row, { nextAt: this.#now() + SETTLE });
      return;
    }
    let current = row;
    let album = found;
    if (current.pinEdition) {
      const loading = !album.releases.length || (await this.#upstream.lidarrRefreshing(access, album));
      if (this.#stopped || !this.#current(access)) return;
      if (loading) {
        // A pin sent while Lidarr is still saving its own edition choice could be undone.
        if (this.#now() - current.phaseAt > CONFIRM_GRACE)
          this.#wait(current, "attention", IDLE_POLL, "Lidarr has not finished loading this album's editions. Check Lidarr, then retry.");
        else this.#wait(current, "requested", SETTLE, null);
        return;
      }
      const requested = current.releaseMBID;
      if (!album.releases.some((release) => release.id === requested)) {
        this.#finish(current, "failed", "Lidarr's metadata does not include the requested edition. Retry later, or request a different edition.");
        return;
      }
    }
    // Leerr pins the edition on albums it added or that nobody monitors; an operator's album is left alone.
    if (current.pinEdition ? !pinned(album, current.releaseMBID) : !album.monitored) {
      const target = album;
      const edition = current.releaseMBID;
      const monitored = await this.#mutate(current, access, "pending_monitor", { lidarrAlbumID: target.id }, () =>
        this.#upstream.lidarrMonitor(access, target, edition),
      );
      if (!monitored || this.#stopped) return;
      const checked = await this.#upstream.lidarrAlbum(access, current.releaseGroupMBID);
      if (!this.#current(access)) return;
      if (!checked || !pinned(checked, edition)) {
        this.#update(monitored.row, { nextAt: this.#now() + SETTLE });
        return;
      }
      const ready = this.#update(monitored.row, { phase: "ready" });
      if (!ready) return;
      current = ready;
      album = checked;
    }
    // The floor excludes every search that existed before this one was sent.
    const floor = await this.#upstream.lidarrLatestCommandID(access);
    const albumID = album.id;
    const searched = await this.#mutate(current, access, "pending_search", { lidarrAlbumID: albumID, searchFloor: floor, commandID: null }, () =>
      this.#upstream.lidarrSearch(access, albumID),
    );
    if (!searched) return;
    this.#update(searched.row, {
      phase: "searching",
      phaseAt: this.#now(),
      commandID: searched.value,
      status: "acquiring",
      reason: "Lidarr is searching for this album.",
      failures: 0,
      nextAt: this.#now() + POLL,
    });
  }

  async #followSearch(row: Acquisition, album: LidarrAlbum, access: LidarrAccess) {
    let current = row;
    let status: string;
    if (row.phase === "pending_search") {
      const command = await this.#upstream.lidarrLatestSearch(access, album.id, row.searchFloor);
      if (!this.#current(access)) return;
      if (!command) return this.#awaitConfirmation(row, "Lidarr did not confirm the search. Check Lidarr, then retry.");
      const searching = this.#update(row, {
        phase: "searching",
        commandID: command.id,
        phaseAt: this.#now(),
        status: "acquiring",
        reason: "Lidarr is searching for this album.",
      });
      if (!searching) return;
      current = searching;
      status = command.status;
    } else {
      // By id first: Lidarr's command list is emptied on restart and skips deduplicated searches.
      const command =
        (row.commandID === null ? null : await this.#upstream.lidarrCommand(access, row.commandID)) ??
        (await this.#upstream.lidarrLatestSearch(access, album.id, row.searchFloor));
      if (!this.#current(access)) return;
      // A command Lidarr no longer has at all finished about a day ago.
      status = command?.status ?? "completed";
    }
    if (status === "queued" || status === "started") {
      this.#wait(current, "acquiring", POLL, "Lidarr is searching for this album.");
      return;
    }
    if (status === "failed" || status === "aborted" || status === "cancelled" || status === "orphaned") {
      this.#finish(current, "failed", `Lidarr's search ${status === "failed" ? "failed" : `was ${status}`}. Retry to search again.`);
      return;
    }
    const downloads = await this.#upstream.lidarrDownloads(access, album.id);
    if (!this.#current(access)) return;
    const now = this.#now();
    const problem = downloads.find((download) => download.state === "problem");
    const stalled = downloads.find((download) => download.state === "stalled");
    if (!stalled) this.#stalledSince.delete(row.id);
    else if (!this.#stalledSince.has(row.id)) this.#stalledSince.set(row.id, now);
    const lasting = stalled && now - (this.#stalledSince.get(row.id) ?? now) > STALL_GRACE ? stalled : undefined;
    const trouble = problem ?? lasting;
    if (trouble) {
      // Still polled: the download may recover, or an operator may fix the import.
      this.#wait(current, "attention", 5 * POLL, `Lidarr grabbed a release but cannot finish it (${trouble.detail}). Check Lidarr's Activity queue.`);
      return;
    }
    if (downloads.length) {
      if (now - current.phaseAt > DOWNLOAD_DEADLINE)
        this.#wait(current, "attention", IDLE_POLL, "Lidarr has been downloading this album for a week. Check Lidarr's Activity queue.");
      else this.#wait(current, "acquiring", 5 * POLL, stalled ? `Downloading in Lidarr (currently ${stalled.detail}).` : "Downloading in Lidarr.");
      return;
    }
    if (now - current.phaseAt > IMPORT_DEADLINE) {
      this.#finish(current, "failed", "Lidarr found nothing to download within a day. Check Lidarr's indexers, then retry.");
      return;
    }
    this.#wait(current, "acquiring", 5 * POLL, "Searched. Waiting for Lidarr to find and download a release.");
  }
}
