import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Backups } from "./config.ts";
import type { Runtime } from "./http/context.ts";
import type { Logger } from "./log.ts";
import type { Store } from "./store.ts";

const pattern = /^leerr-\d{8}T\d{6}Z\.sqlite$/;
// What an interrupted backup leaves behind. Safe to remove at startup: the
// server holds the database exclusively, so no other Leerr is writing here.
const leftover = /^leerr-\d{8}T\d{6}Z\.sqlite\.partial(-journal|-wal|-shm)?$/;
const FIRST_BACKUP = 60_000;

/** `leerr-20260930T120000Z.sqlite`: sorts by time, and only these names are ever pruned. */
export const backupName = (at: Date) => `leerr-${at.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")}.sqlite`;

/** When the newest scheduled backup in `directory` was taken, from its name; null when there is none. */
export function newestBackup(directory: string): number | null {
  const newest = readdirSync(directory)
    .filter((file) => pattern.test(file))
    .sort()
    .at(-1);
  if (!newest) return null;
  const stamp = newest.slice("leerr-".length, "leerr-".length + 15);
  return Date.parse(
    `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`,
  );
}

/**
 * How long until the next backup is due. Counted from the newest one, so
 * restarts (or a crash loop) never add copies that push older ones out.
 */
export function nextBackupDelay(newest: number | null, everyHours: number, now: number): number {
  // No backup yet, or one from the future (the clock moved back): take one soon.
  if (newest === null || newest > now) return FIRST_BACKUP;
  return Math.max(FIRST_BACKUP, newest + everyHours * 3_600_000 - now);
}

/** Deletes all but the newest `keep` scheduled backups; other files are never touched. */
export function pruneBackups(directory: string, keep: number): number {
  const old = readdirSync(directory)
    .filter((file) => pattern.test(file))
    .sort()
    .slice(0, -keep);
  for (const file of old) rmSync(join(directory, file), { force: true });
  return old.length;
}

/** One scheduled backup: a consistent copy, then pruning. Never throws. */
export async function backupOnce(store: Store, backups: Backups, runtime: Runtime, log: Logger, at: Date): Promise<void> {
  const name = backupName(at);
  try {
    await store.backup(join(backups.directory, name));
    runtime.lastBackup = { at: at.getTime(), ok: true };
    log("backup_completed", { file: name, pruned: pruneBackups(backups.directory, backups.keep) });
  } catch (cause) {
    runtime.lastBackup = { at: at.getTime(), ok: false };
    log("backup_failed", { error: cause instanceof Error ? cause.message : "unknown error" });
  }
}

/**
 * Consistent copies of the live database on a schedule, keeping the newest
 * `keep`. The key is never copied: back it up separately.
 */
export function scheduleBackups(store: Store, backups: Backups, runtime: Runtime, log: Logger, now = Date.now): () => void {
  mkdirSync(backups.directory, { recursive: true, mode: 0o700 });
  for (const file of readdirSync(backups.directory))
    if (leftover.test(file)) rmSync(join(backups.directory, file), { force: true });
  const newest = newestBackup(backups.directory);
  if (newest !== null && !runtime.lastBackup) runtime.lastBackup = { at: newest, ok: true };
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  // Chained rather than an interval: each backup is due a full period after the last one.
  const arm = (delay: number) => {
    timer = setTimeout(() => void run(), delay);
  };
  const run = async () => {
    await backupOnce(store, backups, runtime, log, new Date(now()));
    if (!stopped) arm(backups.everyHours * 3_600_000);
  };
  arm(nextBackupDelay(newest, backups.everyHours, now()));
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
