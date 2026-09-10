import { z } from "zod";
import { acquisitionSchema, Store } from "./store.ts";
import { Upstreams } from "./upstream.ts";

const journalSchema = z.object({
  acquisitionID: z.string(),
  phase: z.enum([
    "ready",
    "pending_add",
    "pending_monitor",
    "pending_search",
    "searching",
    "failed_search",
    "retry_requested",
  ]),
  albumID: z.number().int().positive().nullable(),
  commandID: z.number().int().positive().nullable(),
  searchFloor: z.number().int().nonnegative(),
});

/** Serial, durable reconciliation. Every write is journalled first and an
 * uncertain write is resolved by authoritative Lidarr reads, never repeated. */
export class Worker {
  private active: Promise<void> | null = null;
  constructor(
    private readonly store: Store,
    private readonly upstream: Upstreams,
    private readonly now = Date.now,
  ) {}
  async settle() {
    await this.active;
  }
  run(): Promise<void> {
    if (this.active) return this.active;
    this.active = this.reconcile().finally(() => {
      this.active = null;
    });
    return this.active;
  }
  private async reconcile() {
    this.store.prune(this.now());
    const settings = this.store.settings();
    if (!settings.lidarrURL || !settings.lidarrKey) return;
    const rows = z
      .array(acquisitionSchema)
      .parse(
        this.store.db
          .prepare(
            "SELECT * FROM acquisitions WHERE nextAt<=? AND status!='imported' ORDER BY nextAt LIMIT 10",
          )
          .all(this.now()),
      );
    for (const row of rows) {
      try {
        await this.advance(row, settings);
      } catch {
        const failures = row.failures + 1;
        this.store.db
          .prepare(
            "UPDATE acquisitions SET status='uncertain',failures=?,nextAt=? WHERE id=?",
          )
          .run(
            failures,
            this.now() +
              Math.min(3_600_000, 30_000 * 2 ** Math.min(failures, 7)),
            row.id,
          );
      }
    }
  }
  private async advance(
    row: z.infer<typeof acquisitionSchema>,
    settings: ReturnType<Store["settings"]>,
  ) {
    const db = this.store.db;
    db.prepare(
      "INSERT OR IGNORE INTO acquisition_mutations(acquisitionID) VALUES(?)",
    ).run(row.id);
    let journal = journalSchema.parse(
      db
        .prepare("SELECT * FROM acquisition_mutations WHERE acquisitionID=?")
        .get(row.id),
    );
    let album = await this.upstream.lidarrAlbum(
      settings.lidarrURL!,
      settings.lidarrKey,
      row.releaseGroupMBID,
      row.releaseMBID,
    );
    if (!album) {
      if (journal.phase !== "ready" || journal.albumID !== null) {
        this.defer(row.id, "uncertain", 300_000);
        return;
      }
      const candidate = await this.upstream.lidarrLookup(
        settings.lidarrURL!,
        settings.lidarrKey,
        row,
        settings,
      );
      if (
        !db
          .prepare(
            "UPDATE acquisition_mutations SET phase='pending_add' WHERE acquisitionID=? AND phase='ready' AND albumID IS NULL",
          )
          .run(row.id).changes
      )
        return;
      await this.upstream.lidarrCreate(
        settings.lidarrURL!,
        settings.lidarrKey,
        candidate,
      );
      album = await this.upstream.lidarrAlbum(
        settings.lidarrURL!,
        settings.lidarrKey,
        row.releaseGroupMBID,
        row.releaseMBID,
      );
      if (!album) {
        this.defer(row.id, "uncertain", 300_000);
        return;
      }
      db.prepare(
        "UPDATE acquisition_mutations SET phase='ready',albumID=? WHERE acquisitionID=? AND phase='pending_add'",
      ).run(album.id, row.id);
    }
    if (album.imported) {
      db.prepare(
        "UPDATE acquisitions SET status='imported',failures=0,nextAt=? WHERE id=?",
      ).run(this.now() + 60_000, row.id);
      return;
    }
    if (!album.monitored) {
      if (journal.phase === "pending_monitor") {
        this.defer(row.id, "uncertain", 300_000);
        return;
      }
      if (
        !db
          .prepare(
            "UPDATE acquisition_mutations SET phase='pending_monitor',albumID=? WHERE acquisitionID=? AND phase IN ('ready','pending_add')",
          )
          .run(album.id, row.id).changes
      )
        return;
      await this.upstream.lidarrMonitor(
        settings.lidarrURL!,
        settings.lidarrKey,
        album,
        row.releaseMBID,
      );
      const checked = await this.upstream.lidarrAlbum(
        settings.lidarrURL!,
        settings.lidarrKey,
        row.releaseGroupMBID,
        row.releaseMBID,
      );
      if (!checked?.monitored) {
        this.defer(row.id, "uncertain", 300_000);
        return;
      }
      album = checked;
      db.prepare(
        "UPDATE acquisition_mutations SET phase='ready' WHERE acquisitionID=? AND phase='pending_monitor'",
      ).run(row.id);
    }
    journal = journalSchema.parse(
      db
        .prepare("SELECT * FROM acquisition_mutations WHERE acquisitionID=?")
        .get(row.id),
    );
    const command = await this.upstream.lidarrLatestSearch(
      settings.lidarrURL!,
      settings.lidarrKey,
      album.id,
      journal.searchFloor,
    );
    if (command) {
      const failed =
        command.status === "failed" || command.status === "aborted";
      const uncertain = ["cancelled", "orphaned", "unknown"].includes(
        command.status,
      );
      if (
        failed &&
        journal.phase === "retry_requested" &&
        command.id === journal.commandID
      ) {
        db.prepare(
          "UPDATE acquisition_mutations SET phase='ready',searchFloor=? WHERE acquisitionID=?",
        ).run(command.id, row.id);
        this.defer(row.id, "requested", 0);
        return;
      }
      db.prepare(
        "UPDATE acquisition_mutations SET phase=?,commandID=? WHERE acquisitionID=?",
      ).run(
        failed ? "failed_search" : uncertain ? "pending_search" : "searching",
        command.id,
        row.id,
      );
      this.defer(
        row.id,
        failed ? "failed" : uncertain ? "uncertain" : "acquiring",
        failed ? 3_600_000 : 60_000,
      );
      return;
    }
    // A missing command after a journalled search is unknown (history can expire).
    if (
      [
        "pending_search",
        "searching",
        "failed_search",
        "retry_requested",
      ].includes(journal.phase)
    ) {
      this.defer(
        row.id,
        journal.phase === "failed_search" ? "failed" : "uncertain",
        300_000,
      );
      return;
    }
    const latest = await this.upstream.lidarrLatestSearch(
      settings.lidarrURL!,
      settings.lidarrKey,
      album.id,
    );
    const floor = latest?.id ?? 0;
    if (
      !db
        .prepare(
          "UPDATE acquisition_mutations SET phase='pending_search',albumID=?,searchFloor=? WHERE acquisitionID=? AND phase IN ('ready','pending_add','pending_monitor')",
        )
        .run(album.id, floor, row.id).changes
    )
      return;
    const commandID = await this.upstream.lidarrSearch(
      settings.lidarrURL!,
      settings.lidarrKey,
      album.id,
    );
    db.prepare(
      "UPDATE acquisition_mutations SET phase='searching',commandID=? WHERE acquisitionID=?",
    ).run(commandID, row.id);
    this.defer(row.id, "acquiring", 60_000);
  }
  private defer(id: string, status: string, delay: number) {
    this.store.db
      .prepare(
        "UPDATE acquisitions SET status=?,failures=0,nextAt=? WHERE id=?",
      )
      .run(status, this.now() + delay, id);
  }
}
