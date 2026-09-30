/** Live stream proxies per session, so revocation can cut them off immediately. */
export class StreamRegistry {
  readonly #bySession = new Map<string, Set<AbortController>>();
  readonly #limit: number;

  constructor(limit: number) {
    this.#limit = limit;
  }

  /** Returns null when the session already has `limit` open streams. */
  open(sessionID: string): AbortController | null {
    const active = this.#bySession.get(sessionID) ?? new Set<AbortController>();
    if (active.size >= this.#limit) return null;
    const controller = new AbortController();
    active.add(controller);
    this.#bySession.set(sessionID, active);
    return controller;
  }

  release(sessionID: string, controller: AbortController) {
    controller.abort();
    const active = this.#bySession.get(sessionID);
    if (!active) return;
    active.delete(controller);
    if (!active.size) this.#bySession.delete(sessionID);
  }

  abortSession(sessionID: string) {
    for (const controller of this.#bySession.get(sessionID) ?? []) controller.abort();
    this.#bySession.delete(sessionID);
  }

  abortAll() {
    for (const id of this.#bySession.keys()) this.abortSession(id);
  }
}
