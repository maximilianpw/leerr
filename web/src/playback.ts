/**
 * Playback without React: one audio element, its queue, stream tickets,
 * recovery, persistence and reporting. The React layer (player.tsx) only
 * subscribes to it, so it can be tested with a fake audio element.
 */
import * as z from "zod/mini";
import { errorMessage, trackSchema, type Track } from "./api.ts";

export type Repeat = "off" | "all" | "one";
export type PlayerState = {
  /** In play order (shuffled when shuffle is on). */
  queue: Track[];
  index: number;
  current: Track | null;
  playing: boolean;
  loading: boolean;
  error: string;
  duration: number;
  shuffle: boolean;
  repeat: Repeat;
};
export type PlaybackEvent = "start" | "progress" | "stop";

/** The parts of an HTMLAudioElement the controller uses; tests pass a fake. */
export interface AudioLike extends EventTarget {
  src: string;
  currentTime: number;
  readonly duration: number;
  readonly paused: boolean;
  readonly error: { readonly code: number } | null;
  play(): Promise<void>;
  pause(): void;
  load(): void;
  removeAttribute(name: string): void;
  getAttribute(name: string): string | null;
}
export type PlaybackServices = {
  /** `transcoded`: Plex converts the track, so the stream cannot be ranged and seeking restarts it. */
  ticket: (trackID: string) => Promise<{ url: string; expiresAt: string; transcoded?: boolean }>;
  /**
   * Best effort, never rejects; `keepalive` lets the last report outlive the
   * page. May resolve with Plex's reason for ending playback.
   */
  report: (event: PlaybackEvent, trackID: string, position: number, paused: boolean, keepalive: boolean) => Promise<string | null | void> | void;
  /** Why a stream URL fails, in the server's words, or null when it serves audio fine. */
  probe: (url: string) => Promise<string | null>;
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
  now: () => number;
};

// Plex expects a timeline report about every ten seconds while playing.
const PROGRESS_REPORT = 10_000;
const SAVE_EVERY = 5_000;
const MAX_SAVED = 1_000;
// A prefetched ticket must still admit the stream when the track starts.
const TICKET_MARGIN = 60_000;
const saved = z.object({
  v: z.literal(1),
  queue: z.array(trackSchema),
  original: z.array(z.number()),
  index: z.number(),
  position: z.number(),
  shuffle: z.boolean(),
  repeat: z.enum(["off", "all", "one"]),
});
const empty: PlayerState = {
  queue: [],
  index: -1,
  current: null,
  playing: false,
  loading: false,
  error: "",
  duration: 0,
  shuffle: false,
  repeat: "off",
};
const quietPlayErrors = new Set(["NotAllowedError", "AbortError", "NotSupportedError"]);

export class PlaybackController {
  readonly #audio: AudioLike;
  readonly #services: PlaybackServices;
  readonly #storageKey: string | null;
  #state: PlayerState = empty;
  #position = 0;
  /** Queue positions in their original (unshuffled) order. */
  #original: number[] = [];
  readonly #listeners = new Set<() => void>();
  readonly #positionListeners = new Set<() => void>();
  #generation = 0;
  #recovered = false;
  /** The track Plex was told started; its stop must name it even after the queue moved on. */
  #started: Track | null = null;
  /** Whether the load in flight should start playing when its stream arrives. */
  #wantPlay = false;
  #lastProgress = 0;
  #lastSave = 0;
  /** A restored queue starts paused here; the first play loads from this point. */
  #resumeAt: number | null = null;
  #prefetched: { trackID: string; url: string; expiresAt: number; transcoded: boolean } | null = null;
  /** The stream attached now. A converted one starts `#offset` seconds into the track. */
  #stream: { url: string; transcoded: boolean } | null = null;
  #offset = 0;
  #attached = false;
  readonly #handlers: Array<[string, () => void]>;

  constructor(audio: AudioLike, services: PlaybackServices, storageKey: string | null) {
    this.#audio = audio;
    this.#services = services;
    this.#storageKey = storageKey;
    this.#handlers = [
      ["playing", () => this.#onPlaying()],
      ["pause", () => this.#onPause()],
      ["waiting", () => this.#set({ loading: true })],
      ["canplay", () => this.#set({ loading: false })],
      ["timeupdate", () => this.#onTime()],
      ["durationchange", () => {
        // A converted stream only knows its own length from where it started; the track's length stays.
        if (Number.isFinite(this.#audio.duration) && !this.#stream?.transcoded) this.#set({ duration: this.#audio.duration });
      }],
      ["ended", () => this.#onEnded()],
      ["error", () => this.#onError()],
    ];
    this.#restore();
  }

  /** Starts listening to the audio element. Safe to call again after dispose(). */
  attach() {
    if (this.#attached) return;
    this.#attached = true;
    for (const [name, handler] of this.#handlers) this.#audio.addEventListener(name, handler);
  }
  /** Stops playback and listening, keeping the saved queue for the next visit. */
  dispose() {
    if (!this.#attached) return;
    this.#attached = false;
    // A ticket still on its way must not start the detached element.
    this.#generation++;
    this.#prefetched = null;
    for (const [name, handler] of this.#handlers) this.#audio.removeEventListener(name, handler);
    this.#reportStop(true);
    this.#detach();
  }

  getState = (): PlayerState => this.#state;
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  };
  /** Position changes several times a second, so it has its own subscription. */
  getPosition = (): number => this.#position;
  subscribePosition = (listener: () => void) => {
    this.#positionListeners.add(listener);
    return () => void this.#positionListeners.delete(listener);
  };

  /** Every track in random order, the first one included. */
  playShuffled(tracks: Track[]) {
    const items = playable(tracks);
    if (!items.length) return;
    const order = shuffled(items.map((_, position) => position));
    this.#original = items.map((_, position) => order.indexOf(position));
    this.#commit({ queue: order.map((position) => items[position]), index: 0, shuffle: true });
    void this.#load(0, true);
  }

  playQueue(tracks: Track[], start: number) {
    const chosen = tracks[Math.min(Math.max(start, 0), tracks.length - 1)];
    const items = playable(tracks);
    if (!chosen?.available || !items.length) return;
    const first = items.indexOf(chosen);
    if (this.#state.shuffle) {
      // order[q] is the album position played q-th; #original maps album positions back to the queue.
      const order = [first, ...shuffled(items.flatMap((_, position) => (position === first ? [] : [position])))];
      this.#original = items.map((_, position) => order.indexOf(position));
      this.#commit({ queue: order.map((position) => items[position]), index: 0 });
    } else {
      this.#original = items.map((_, position) => position);
      this.#commit({ queue: items, index: first });
    }
    void this.#load(0, true);
  }

  /**
   * Adds tracks right after the current one, or at the end, without
   * interrupting it. With nothing playing they start at once: "playing".
   */
  enqueue(tracks: Track[], where: "next" | "end"): "queued" | "playing" | null {
    const items = playable(tracks);
    if (!items.length) return null;
    if (!this.#state.current) {
      this.playQueue(items, 0);
      return "playing";
    }
    const at = where === "next" ? this.#state.index + 1 : this.#state.queue.length;
    const queue = [...this.#state.queue.slice(0, at), ...items, ...this.#state.queue.slice(at)];
    // In original order they go after the current track too, or at the end.
    const shift = (position: number) => (position >= at ? position + items.length : position);
    const inserted = items.map((_, offset) => at + offset);
    const currentOriginal = this.#original.indexOf(this.#state.index);
    const original = this.#original.map(shift);
    if (where === "next") original.splice(currentOriginal + 1, 0, ...inserted);
    else original.push(...inserted);
    this.#original = original;
    this.#commit({ queue });
    return "queued";
  }

  removeAt(position: number) {
    const { queue, index } = this.#state;
    if (position < 0 || position >= queue.length) return;
    if (queue.length === 1) {
      this.stop();
      return;
    }
    const next = queue.filter((_, at) => at !== position);
    this.#original = this.#original.flatMap((at) => (at === position ? [] : [at > position ? at - 1 : at]));
    if (position < index) this.#commit({ queue: next, index: index - 1 });
    else if (position > index) this.#commit({ queue: next });
    else {
      this.#commit({ queue: next, index: Math.min(index, next.length - 1) });
      void this.#load(0, !this.#audio.paused || this.#state.loading);
    }
  }

  /** Moves a queued track one place up (-1) or down (+1). */
  move(position: number, delta: -1 | 1) {
    const target = position + delta;
    const { queue, index } = this.#state;
    if (position < 0 || target < 0 || position >= queue.length || target >= queue.length) return;
    const next = [...queue];
    [next[position], next[target]] = [next[target], next[position]];
    this.#original = this.#original.map((at) => (at === position ? target : at === target ? position : at));
    const moved = index === position ? target : index === target ? position : index;
    this.#commit({ queue: next, index: moved });
  }

  jumpTo(position: number) {
    if (position < 0 || position >= this.#state.queue.length) return;
    this.#commit({ index: position });
    void this.#load(0, true);
  }

  setShuffle(on: boolean) {
    const { queue, index, current } = this.#state;
    if (on === this.#state.shuffle) return;
    if (!current) {
      this.#commit({ shuffle: on });
      return;
    }
    if (on) {
      // The current track stays first; the rest play in random order.
      const rest = shuffled(queue.flatMap((_, at) => (at === index ? [] : [at])));
      const order = [index, ...rest];
      this.#original = queue.map((_, at) => order.indexOf(at));
      this.#commit({ queue: order.map((at) => queue[at]), index: 0, shuffle: true });
    } else {
      const ordered = this.#original.map((at) => queue[at]);
      this.#commit({ queue: ordered, index: this.#original.indexOf(index), shuffle: false });
      this.#original = ordered.map((_, at) => at);
    }
  }

  cycleRepeat() {
    const next: Record<Repeat, Repeat> = { off: "all", all: "one", one: "off" };
    this.#commit({ repeat: next[this.#state.repeat] });
  }

  /** Whether playback is on or about to start: what a play/pause button should offer to stop. */
  intendsToPlay(): boolean {
    return this.#state.playing || !this.#audio.paused || (this.#state.loading && this.#wantPlay);
  }
  toggle() {
    if (this.intendsToPlay()) this.pause();
    else this.play();
  }
  /** Starts or resumes; does nothing when already playing or starting. */
  play() {
    if (!this.#state.current || (this.#state.loading && this.#wantPlay)) return;
    // Nothing attached (restored queue) or the stream failed: get a fresh ticket.
    if (this.#audio.error || !this.#audio.getAttribute("src")) {
      // A ticket already on its way (paused while loading) just plays when it arrives.
      if (this.#state.loading && !this.#audio.error) {
        this.#wantPlay = true;
        this.#set({});
      } else void this.#load(this.#resumeAt ?? this.#time(), true);
      return;
    }
    if (!this.#audio.paused) return;
    this.#audio.play().catch((cause: Error) => {
      if (!quietPlayErrors.has(cause.name)) this.#set({ error: errorMessage(cause, "Playback failed.") });
    });
  }
  /** Pauses, including a track that is still loading; does nothing when already paused. */
  pause() {
    if (this.#wantPlay) {
      this.#wantPlay = false;
      // A new snapshot: the play button reads intendsToPlay(), which just changed.
      this.#set({});
    }
    if (!this.#audio.paused) this.#audio.pause();
  }

  next() {
    const { index, queue, repeat } = this.#state;
    if (index + 1 < queue.length) this.jumpTo(index + 1);
    else if (repeat === "all" && queue.length) this.jumpTo(0);
  }
  /** After the first three seconds, restarts the track instead. */
  previous() {
    const { index, queue, repeat } = this.#state;
    // A restored queue has no stream yet: its position is where it will resume.
    const position = this.#resumeAt ?? this.#time();
    if (position > 3 || (index === 0 && repeat !== "all")) this.seek(0);
    else this.jumpTo(index > 0 ? index - 1 : queue.length - 1);
  }
  hasNext(): boolean {
    return this.#state.index + 1 < this.#state.queue.length || (this.#state.repeat === "all" && this.#state.queue.length > 0);
  }

  seek(seconds: number) {
    if (!Number.isFinite(seconds)) return;
    if (!this.#audio.getAttribute("src")) {
      // Paused after a restore: remember where to start.
      this.#resumeAt = Math.max(0, seconds);
      this.#setPosition(this.#resumeAt);
      return;
    }
    if (this.#stream?.transcoded) {
      this.#restart(Math.max(0, seconds));
      return;
    }
    this.#audio.currentTime = Math.max(0, seconds);
    this.#setPosition(this.#audio.currentTime);
  }

  /** Seconds into the track: a converted stream's own clock starts where it was asked to. */
  #time(): number {
    return this.#offset + this.#audio.currentTime;
  }
  /** A converted stream cannot be ranged: seeking asks Plex to start converting from there. */
  #restart(seconds: number) {
    const stream = this.#stream;
    if (!stream) return;
    const resume = this.intendsToPlay();
    this.#offset = seconds;
    this.#audio.src = `${stream.url}?start=${seconds}`;
    this.#setPosition(seconds);
    if (resume)
      this.#audio.play().catch((cause: Error) => {
        if (!quietPlayErrors.has(cause.name)) this.#set({ error: errorMessage(cause, "Playback failed.") });
      });
  }

  stop() {
    this.#generation++;
    this.#reportStop(false);
    this.#detach();
    this.#original = [];
    this.#resumeAt = null;
    this.#prefetched = null;
    this.#state = { ...empty, shuffle: this.#state.shuffle, repeat: this.#state.repeat };
    this.#setPosition(0);
    this.#notify();
    if (this.#storageKey) this.#services.storage?.removeItem(this.#storageKey);
  }

  /** The page is going away: tell Plex, and keep the position for next time. */
  pageHidden() {
    this.#reportStop(true);
    this.#save(true);
  }

  /**
   * Before signing out: pause and tell Plex the track stopped while the
   * session still exists. The queue stays. Resolves once the report is done.
   */
  async halt(): Promise<void> {
    this.#wantPlay = false;
    const report = this.#reportStop(false);
    this.#audio.pause();
    await report;
  }

  // Internals

  #notify() {
    for (const listener of this.#listeners) listener();
  }
  #setPosition(position: number) {
    this.#position = position;
    for (const listener of this.#positionListeners) listener();
  }
  #set(patch: Partial<PlayerState>) {
    this.#state = { ...this.#state, ...patch };
    this.#notify();
  }
  /** A queue change: recompute the current track and save. */
  #commit(patch: Partial<PlayerState>) {
    const next = { ...this.#state, ...patch };
    next.current = next.index >= 0 ? (next.queue[next.index] ?? null) : null;
    this.#state = next;
    this.#notify();
    this.#save(true);
  }

  #detach() {
    this.#audio.pause();
    this.#audio.removeAttribute("src");
    this.#audio.load();
    this.#stream = null;
    this.#offset = 0;
  }

  /** The prefetched ticket for this track, if still fresh; a ticket for another track is kept. */
  #takePrefetched(trackID: string): { url: string; transcoded: boolean } | null {
    const prefetched = this.#prefetched;
    if (!prefetched || prefetched.trackID !== trackID) return null;
    this.#prefetched = null;
    return prefetched.expiresAt - this.#services.now() > TICKET_MARGIN ? prefetched : null;
  }

  async #load(resumeAt: number, autoplay: boolean) {
    const item = this.#state.current;
    // E.g. an operating-system media key after sign-out.
    if (!item || !this.#attached) return;
    const attempt = ++this.#generation;
    this.#reportStop(false);
    // The old track must stop now, not when the new ticket arrives.
    this.#detach();
    this.#resumeAt = null;
    this.#wantPlay = autoplay;
    this.#set({ loading: true, error: "", playing: false, duration: item.duration ?? 0 });
    this.#setPosition(resumeAt);
    try {
      const ticket = this.#takePrefetched(item.id) ?? (await this.#services.ticket(item.id));
      if (attempt !== this.#generation) return;
      const transcoded = ticket.transcoded === true;
      this.#stream = { url: ticket.url, transcoded };
      if (transcoded) {
        this.#offset = resumeAt;
        this.#audio.src = resumeAt ? `${ticket.url}?start=${resumeAt}` : ticket.url;
      } else {
        this.#audio.src = ticket.url;
        if (resumeAt) this.#audio.currentTime = resumeAt;
      }
      // Read after the wait: pause() or play() meanwhile changed the intent.
      const play = this.#wantPlay;
      this.#wantPlay = false;
      if (play) await this.#audio.play();
      else this.#set({ loading: false });
    } catch (cause) {
      if (attempt !== this.#generation) return;
      this.#wantPlay = false;
      this.#set({ loading: false, playing: false });
      // Autoplay refusals and interrupted loads are not errors; a source error is reported by the "error" event.
      if (cause instanceof Error && quietPlayErrors.has(cause.name)) return;
      this.#set({ error: errorMessage(cause, "Playback failed.") });
    }
  }

  #onPlaying() {
    this.#recovered = false;
    this.#set({ playing: true, loading: false, error: "" });
    const current = this.#state.current;
    if (current && !this.#started) {
      this.#started = current;
      this.#lastProgress = this.#services.now();
      this.#report("start", current.id, this.#time(), false, false);
      this.#prefetchNext();
    }
  }
  #onPause() {
    this.#set({ playing: false });
    if (this.#started) this.#report("progress", this.#started.id, this.#time(), true, false);
    this.#save(true);
  }
  #onTime() {
    this.#setPosition(this.#time());
    const now = this.#services.now();
    if (this.#started && !this.#audio.paused && now - this.#lastProgress >= PROGRESS_REPORT) {
      this.#lastProgress = now;
      this.#report("progress", this.#started.id, this.#time(), false, false);
    }
    this.#save(false);
  }
  #onEnded() {
    this.#reportStop(false);
    if (this.#state.repeat === "one") {
      if (this.#stream?.transcoded) {
        this.#offset = 0;
        this.#audio.src = this.#stream.url;
      } else this.#audio.currentTime = 0;
      void this.#audio.play().catch(() => this.#set({ playing: false }));
      return;
    }
    if (this.hasNext()) this.next();
    else {
      this.#set({ playing: false });
      this.#setPosition(0);
    }
  }
  #onError() {
    const current = this.#state.current;
    const url = this.#audio.getAttribute("src");
    // A detached element (track change, stop) reports nothing worth showing.
    if (!current || !url) return;
    if (!this.#recovered) {
      // E.g. the ticket expired during a long pause: one fresh ticket, same position.
      this.#recovered = true;
      void this.#load(this.#time(), true);
      return;
    }
    const attempt = this.#generation;
    this.#set({ loading: false, playing: false });
    void this.#services.probe(url).then((message) => {
      if (attempt !== this.#generation) return;
      const format = current.codec ? ` (${current.codec.toUpperCase()})` : "";
      this.#set({ error: message ?? `This track${format} could not be played. Its format may not be supported by this browser.` });
    });
  }

  /** Must run before the element is detached, so the position is the outgoing track's. */
  #reportStop(keepalive: boolean): Promise<string | null | void> | void {
    const started = this.#started;
    if (!started) return;
    this.#started = null;
    return this.#services.report("stop", started.id, this.#time(), true, keepalive);
  }
  /** Plex can end a playback (for example its owner stopped it): the player then stops and says why. */
  #report(event: "start" | "progress", trackID: string, position: number, paused: boolean, keepalive: boolean) {
    const reply = this.#services.report(event, trackID, position, paused, keepalive);
    if (!reply) return;
    void reply.then((stopped) => {
      if (!stopped || this.#started?.id !== trackID) return;
      this.pause();
      this.#set({ error: stopped });
    });
  }

  #prefetchNext() {
    const { index, queue, repeat } = this.#state;
    const next = queue[index + 1] ?? (repeat === "all" ? queue[0] : undefined);
    if (!next || next === this.#state.current || this.#prefetched?.trackID === next.id) return;
    const attempt = this.#generation;
    this.#services
      .ticket(next.id)
      .then((ticket) => {
        if (attempt === this.#generation)
          this.#prefetched = { trackID: next.id, url: ticket.url, expiresAt: Date.parse(ticket.expiresAt), transcoded: ticket.transcoded === true };
      })
      .catch(() => {
        // Optional: the track fetches its own ticket when it starts.
      });
  }

  #save(force: boolean) {
    const storage = this.#services.storage;
    if (!storage || !this.#storageKey) return;
    const now = this.#services.now();
    if (!force && now - this.#lastSave < SAVE_EVERY) return;
    this.#lastSave = now;
    const { queue, index, shuffle, repeat } = this.#state;
    if (!queue.length) {
      storage.removeItem(this.#storageKey);
      return;
    }
    // Large queues keep the part around the current track. Tickets are never saved: they are credentials.
    const start = Math.max(0, Math.min(index - MAX_SAVED / 2, queue.length - MAX_SAVED));
    const kept = queue.slice(start, start + MAX_SAVED);
    const original = this.#original.flatMap((at) => (at >= start && at < start + MAX_SAVED ? [at - start] : []));
    const value = { v: 1, queue: kept, original, index: index - start, position: this.#position, shuffle, repeat };
    try {
      storage.setItem(this.#storageKey, JSON.stringify(value));
    } catch {
      // Storage full or disabled: playback does not depend on it.
    }
  }

  #restore() {
    const storage = this.#services.storage;
    if (!storage || !this.#storageKey) return;
    let raw: string | null = null;
    try {
      raw = storage.getItem(this.#storageKey);
    } catch {
      return;
    }
    if (!raw) return;
    let value: z.infer<typeof saved> | null = null;
    try {
      const parsed = saved.safeParse(JSON.parse(raw));
      if (parsed.success) value = parsed.data;
    } catch {
      // Not JSON: treated like any other unusable value below.
    }
    if (!value || !value.queue.length || value.index < 0 || value.index >= value.queue.length) {
      storage.removeItem(this.#storageKey);
      return;
    }
    const valid = value.original.length === value.queue.length;
    this.#original = valid ? value.original : value.queue.map((_, at) => at);
    this.#state = {
      ...empty,
      queue: value.queue,
      index: value.index,
      current: value.queue[value.index],
      duration: value.queue[value.index].duration ?? 0,
      shuffle: value.shuffle && valid,
      repeat: value.repeat,
    };
    // Restored paused: starting playback on page load would surprise people.
    this.#resumeAt = value.position;
    this.#position = value.position;
  }
}

/** Fisher–Yates; a copy, the input is left alone. */
/** Tracks in Plex's trash have no file left to play. */
export const playable = (tracks: Track[]) => tracks.filter((track) => track.available);

function shuffled<T>(items: T[]): T[] {
  const copy = [...items];
  for (let at = copy.length - 1; at > 0; at--) {
    const other = Math.floor(Math.random() * (at + 1));
    [copy[at], copy[other]] = [copy[other], copy[at]];
  }
  return copy;
}
