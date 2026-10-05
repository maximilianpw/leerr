import type { StatusChange, StatusListener } from "./acquisitions.ts";
import type { Logger } from "./log.ts";
import type { Store } from "./store.ts";
import type { Notification, Upstreams } from "./upstream/index.ts";

const wording: Record<StatusChange["status"], (title: string) => { title: string; detail: string }> = {
  imported: (title) => ({ title: `${title} is ready`, detail: "Lidarr imported it. It appears in Plex after its next library scan." }),
  failed: (title) => ({ title: `${title} could not be downloaded`, detail: "Open Leerr to retry." }),
  attention: (title) => ({ title: `${title} needs attention`, detail: "An administrator should check Lidarr, then retry or remove it in Leerr." }),
};

export function describeChange(change: StatusChange, requesters: string[]): Notification {
  const { title, artist } = change.acquisition;
  const words = wording[change.status](`${title} by ${artist}`);
  const lines = [words.detail];
  if (change.reason && change.status !== "imported") lines.unshift(change.reason);
  if (requesters.length) lines.push(`Requested by ${requesters.join(", ")}.`);
  return { event: change.status, title: words.title, message: lines.join("\n"), album: { title, artist }, requesters };
}

/**
 * Sends acquisition outcomes to the administrator's notification target.
 * Fire-and-forget: a slow or broken target never holds up the worker.
 */
export function notificationListener(store: Store, upstream: Upstreams, log: Logger): StatusListener {
  return (change) => {
    const settings = store.settings();
    if (!settings.notifyURL) return;
    const notification = describeChange(change, store.requesterNames(change.acquisition.id));
    upstream
      .notify({ url: settings.notifyURL, format: settings.notifyFormat, token: settings.notifyToken }, notification)
      .then(() => log("notification_sent", { event: change.status, acquisition: change.acquisition.id }))
      .catch((cause: Error) => log("notification_failed", { event: change.status, error: cause.message }));
  };
}
