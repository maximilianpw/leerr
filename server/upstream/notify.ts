import { validateEndpoint } from "./errors.ts";
import { HttpClient, statusError } from "./http.ts";
import type { NotifyFormat } from "../store.ts";

export type NotifyTarget = { url: string; format: NotifyFormat; token: string };
/** What happened, in words people read on a phone; never ids, tokens or URLs. */
export type Notification = {
  event: "imported" | "failed" | "attention" | "test";
  title: string;
  message: string;
  album: { title: string; artist: string } | null;
  requesters: string[];
};

const SERVICE = "Notification target";
const tags: Record<Notification["event"], string> = {
  imported: "white_check_mark",
  failed: "x",
  attention: "warning",
  test: "bell",
};

/** Delivers notifications to an administrator-configured ntfy topic, Discord webhook or JSON webhook. */
export class Notifier {
  readonly #http: HttpClient;
  constructor(http: HttpClient) {
    this.#http = http;
  }

  async send(target: NotifyTarget, notification: Notification): Promise<void> {
    const url = new URL(validateEndpoint(target.url));
    const headers = new Headers({ Accept: "application/json" });
    if (target.token && target.format !== "discord") headers.set("Authorization", `Bearer ${target.token}`);
    let body: string;
    if (target.format === "ntfy") {
      // Header values must be Latin-1, so non-ASCII titles travel as query parameters.
      url.searchParams.set("title", notification.title);
      url.searchParams.set("tags", tags[notification.event]);
      headers.set("Content-Type", "text/plain; charset=utf-8");
      body = notification.message;
    } else if (target.format === "discord") {
      headers.set("Content-Type", "application/json");
      body = JSON.stringify({ content: `**${notification.title}**\n${notification.message}`.slice(0, 2000), allowed_mentions: { parse: [] } });
    } else {
      headers.set("Content-Type", "application/json");
      body = JSON.stringify({ source: "leerr", ...notification });
    }
    const status = await this.#http.empty(url, { method: "POST", headers, body }, { service: SERVICE, maxBytes: 100_000 });
    if (status < 200 || status > 299) throw statusError(status, SERVICE);
  }
}
