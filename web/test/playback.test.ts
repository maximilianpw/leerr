import assert from "node:assert/strict";
import test from "node:test";
import type { Track } from "../src/api.ts";
import { PlaybackController, type AudioLike, type PlaybackEvent, type PlaybackServices } from "../src/playback.ts";

/** Just enough of an <audio> element: attributes, events and a controllable play(). */
class FakeAudio extends EventTarget implements AudioLike {
  #src: string | null = null;
  currentTime = 0;
  duration = Number.NaN;
  paused = true;
  error: { code: number } | null = null;
  playResult: () => Promise<void> = async () => {};
  get src() {
    return this.#src ?? "";
  }
  set src(value: string) {
    this.#src = value;
    this.error = null;
  }
  getAttribute(name: string) {
    return name === "src" ? this.#src : null;
  }
  removeAttribute(name: string) {
    if (name === "src") this.#src = null;
  }
  load() {
    this.currentTime = 0;
  }
  async play() {
    await this.playResult();
    this.paused = false;
    this.emit("playing");
  }
  pause() {
    if (this.paused) return;
    this.paused = true;
    this.emit("pause");
  }
  emit(name: string) {
    // As in browsers, reaching the end pauses the element first.
    if (name === "ended" && !this.paused) {
      this.paused = true;
      this.dispatchEvent(new Event("pause"));
    }
    this.dispatchEvent(new Event(name));
  }
  fail() {
    this.error = { code: 4 };
    this.paused = true;
    this.emit("error");
  }
}

const track = (id: string, duration = 200): Track => ({
  id,
  title: `Track ${id}`,
  artist: "Artist",
  albumID: "album",
  albumTitle: "Album",
  disc: 1,
  number: Number(id.replace(/\D/g, "")) || 1,
  duration,
  codec: "flac",
  sampleRate: 44_100,
  bitDepth: 16,
  favorite: false,
});
const tracks = ["t1", "t2", "t3", "t4"].map((id) => track(id));
const settle = () => new Promise((resolve) => setImmediate(resolve));

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

function setup(options: { storage?: ReturnType<typeof memoryStorage>; probe?: string | null } = {}) {
  const audio = new FakeAudio();
  const tickets: string[] = [];
  const reports: Array<{ event: PlaybackEvent; trackID: string; position: number }> = [];
  const clock = { now: 0 };
  // Tickets resolve when the test says so, to exercise late responses.
  let held: Array<() => void> | null = null;
  const services: PlaybackServices = {
    ticket: async (trackID) => {
      tickets.push(trackID);
      if (held) await new Promise<void>((resolve) => held?.push(resolve));
      return { url: `/api/v1/streams/${trackID}-${tickets.length}`, expiresAt: new Date(Date.now() + 6 * 3_600_000).toISOString() };
    },
    report: (event, trackID, position) => void reports.push({ event, trackID, position }),
    probe: async () => options.probe ?? null,
    storage: options.storage ?? null,
    now: () => clock.now,
  };
  const controller = new PlaybackController(audio, services, options.storage ? "leerr.player.u1" : null);
  controller.attach();
  return {
    audio,
    controller,
    tickets,
    reports,
    clock,
    hold: () => {
      held = [];
    },
    release: () => {
      const waiting = held ?? [];
      held = null;
      for (const resolve of waiting) resolve();
    },
  };
}

test("playing a queue loads the chosen track with its own ticket and reports it to Jellyfin", async () => {
  const s = setup();
  s.controller.playQueue(tracks, 1);
  await settle();
  const state = s.controller.getState();
  assert.equal(state.current?.id, "t2");
  assert.equal(state.playing, true);
  assert.equal(s.audio.src, "/api/v1/streams/t2-1");
  assert.deepEqual(s.reports[0], { event: "start", trackID: "t2", position: 0 });
  assert.equal(s.tickets.at(-1), "t3", "the next track's ticket is fetched ahead of time");
  s.controller.next();
  await settle();
  assert.equal(s.audio.src, "/api/v1/streams/t3-2", "the prefetched ticket is used");
  assert.deepEqual(s.reports.map((report) => `${report.event} ${report.trackID}`), ["start t2", "stop t2", "start t3"]);
});

test("every way of changing track reports the stop for the track that was playing, at its position", async () => {
  const s = setup();
  const stops = () => s.reports.filter((report) => report.event === "stop").map((report) => `${report.trackID}@${report.position}`);
  s.controller.playQueue(tracks, 0);
  await settle();
  s.audio.currentTime = 150;
  s.controller.jumpTo(3);
  await settle();
  s.audio.currentTime = 2;
  s.controller.previous();
  await settle();
  s.audio.currentTime = 40;
  s.controller.removeAt(s.controller.getState().index);
  await settle();
  s.audio.currentTime = 60;
  s.controller.playQueue([track("z1"), track("z2")], 0);
  await settle();
  assert.deepEqual(stops(), ["t1@150", "t4@2", "t3@40", "t4@60"]);
});

test("changing track stops the old one at once, and a late ticket for it is ignored", async () => {
  const s = setup();
  s.controller.playQueue(tracks, 0);
  await settle();
  s.hold();
  s.controller.jumpTo(2);
  assert.equal(s.audio.getAttribute("src"), null, "the old track is detached before the new ticket arrives");
  assert.equal(s.audio.paused, true);
  s.controller.jumpTo(3);
  s.release();
  await settle();
  assert.equal(s.controller.getState().current?.id, "t4");
  assert.match(s.audio.src, /^\/api\/v1\/streams\/t4-/);
});

test("a failed stream gets one fresh ticket at the same position; recovery resets once it plays again", async () => {
  const s = setup({ probe: "Playback authorization expired. Start playback again." });
  s.controller.playQueue(tracks, 0);
  await settle();
  s.audio.currentTime = 42;
  s.audio.fail();
  await settle();
  assert.equal(s.audio.currentTime, 42, "resumed where it stopped");
  assert.equal(s.controller.getState().playing, true);
  const ticketsAfterFirst = s.tickets.length;
  // It played again, so a later failure (another long pause) recovers too.
  s.audio.fail();
  await settle();
  assert.equal(s.tickets.length, ticketsAfterFirst + 1);
  // A failure right after recovering, before playing, gives up with the server's reason.
  s.audio.playResult = async () => {
    throw new DOMException("no source", "NotSupportedError");
  };
  s.audio.fail();
  await settle();
  s.audio.fail();
  await settle();
  assert.equal(s.controller.getState().error, "Playback authorization expired. Start playback again.");
  assert.equal(s.controller.getState().playing, false);
});

test("an unplayable file names its format when the server serves it fine", async () => {
  const s = setup({ probe: null });
  s.controller.playQueue(tracks, 0);
  await settle();
  s.audio.playResult = async () => {
    throw new DOMException("no source", "NotSupportedError");
  };
  s.audio.fail();
  await settle();
  s.audio.fail();
  await settle();
  assert.match(s.controller.getState().error, /\(FLAC\) could not be played/);
});

test("pausing while a track loads is not an error, and play after a failure fetches a new ticket", async () => {
  const s = setup();
  s.audio.playResult = async () => {
    throw new DOMException("interrupted", "AbortError");
  };
  s.controller.playQueue(tracks, 0);
  await settle();
  assert.equal(s.controller.getState().error, "");
  s.audio.playResult = async () => {};
  s.audio.error = { code: 2 };
  const forFirst = () => s.tickets.filter((id) => id === "t1").length;
  const before = forFirst();
  s.controller.toggle();
  await settle();
  assert.equal(forFirst(), before + 1);
  assert.equal(s.controller.getState().playing, true);
});

test("the end of the queue stops, repeat-all wraps around and repeat-one restarts the track", async () => {
  const s = setup();
  s.controller.playQueue(tracks, 3);
  await settle();
  s.audio.emit("ended");
  await settle();
  assert.equal(s.controller.getState().playing, false);
  assert.equal(s.controller.getState().current?.id, "t4");
  s.controller.cycleRepeat();
  assert.equal(s.controller.getState().repeat, "all");
  assert.equal(s.controller.hasNext(), true);
  s.controller.toggle();
  await settle();
  s.audio.emit("ended");
  await settle();
  assert.equal(s.controller.getState().current?.id, "t1");
  s.controller.cycleRepeat();
  s.audio.currentTime = 100;
  s.audio.emit("ended");
  await settle();
  assert.equal(s.controller.getState().current?.id, "t1");
  assert.equal(s.audio.currentTime, 0);
});

test("Previous on a restored queue restarts the saved track without loading it", () => {
  const storage = memoryStorage();
  storage.setItem(
    "leerr.player.u1",
    JSON.stringify({ v: 1, queue: tracks, original: [0, 1, 2, 3], index: 1, position: 73, shuffle: false, repeat: "off" }),
  );
  const s = setup({ storage });
  s.controller.previous();
  assert.equal(s.controller.getState().current?.id, "t2");
  assert.equal(s.controller.getPosition(), 0);
  assert.equal(s.tickets.length, 0);
  assert.equal(s.controller.getState().playing, false);
});

test("previous restarts a track after three seconds, and goes back before that", async () => {
  const s = setup();
  s.controller.playQueue(tracks, 2);
  await settle();
  s.audio.currentTime = 30;
  s.controller.previous();
  assert.equal(s.audio.currentTime, 0);
  assert.equal(s.controller.getState().current?.id, "t3");
  s.controller.previous();
  await settle();
  assert.equal(s.controller.getState().current?.id, "t2");
});

test("tracks can be queued next or last, moved and removed without interrupting playback", async () => {
  const s = setup();
  s.controller.playQueue(tracks.slice(0, 2), 0);
  await settle();
  const ticketsBefore = s.tickets.length;
  s.controller.enqueue([track("x1")], "next");
  s.controller.enqueue([track("x2")], "end");
  const ids = () => s.controller.getState().queue.map((item) => item.id);
  assert.deepEqual(ids(), ["t1", "x1", "t2", "x2"]);
  assert.equal(s.tickets.length, ticketsBefore, "the current track keeps playing");
  s.controller.move(3, -1);
  assert.deepEqual(ids(), ["t1", "x1", "x2", "t2"]);
  s.controller.removeAt(1);
  assert.deepEqual(ids(), ["t1", "x2", "t2"]);
  assert.equal(s.controller.getState().index, 0);
  s.controller.removeAt(0);
  await settle();
  assert.equal(s.controller.getState().current?.id, "x2", "removing the playing track plays the next one");
});

test("Shuffle play starts anywhere in the list, not always on the first track", async () => {
  const s = setup();
  const many = Array.from({ length: 10 }, (_, index) => track(`t${index + 1}`));
  const firsts = new Set<string>();
  for (let run = 0; run < 30; run++) {
    s.controller.playShuffled(many);
    await settle();
    const state = s.controller.getState();
    assert.equal(state.shuffle, true);
    assert.deepEqual(state.queue.map((item) => item.id).sort(), many.map((item) => item.id).sort());
    firsts.add(state.current?.id ?? "");
  }
  assert.ok(firsts.size > 1, "the first track varies");
  s.controller.setShuffle(false);
  assert.deepEqual(s.controller.getState().queue.map((item) => item.id), many.map((item) => item.id));
});

test("play and pause are idempotent, and pausing a loading track keeps it from starting", async () => {
  const s = setup();
  s.controller.playQueue(tracks, 0);
  await settle();
  const tickets = s.tickets.length;
  s.controller.play();
  assert.equal(s.audio.paused, false);
  assert.equal(s.tickets.length, tickets, "play while playing does nothing");
  s.controller.pause();
  s.controller.pause();
  assert.equal(s.audio.paused, true, "pause while paused stays paused");
  s.hold();
  s.controller.jumpTo(2);
  assert.equal(s.controller.intendsToPlay(), true);
  s.controller.pause();
  s.release();
  await settle();
  assert.equal(s.audio.paused, true, "the stream arrived but did not start");
  assert.equal(s.audio.getAttribute("src") !== null, true);
  assert.equal(s.controller.getState().loading, false);
  s.controller.toggle();
  await settle();
  assert.equal(s.controller.getState().playing, true);
});

test("a ticket that arrives after dispose() never starts the detached element", async () => {
  const s = setup();
  s.hold();
  s.controller.playQueue(tracks, 0);
  s.controller.dispose();
  s.release();
  await settle();
  assert.equal(s.audio.getAttribute("src"), null);
  assert.equal(s.audio.paused, true);
  s.controller.toggle();
  await settle();
  assert.equal(s.tickets.length, 1, "a disposed controller loads nothing, e.g. for a media key after sign-out");
});

test("halting before sign-out reports the stop and keeps the queue", async () => {
  const s = setup();
  s.controller.playQueue(tracks, 1);
  await settle();
  s.audio.currentTime = 42;
  await s.controller.halt();
  assert.deepEqual(s.reports.at(-1), { event: "stop", trackID: "t2", position: 42 });
  assert.equal(s.audio.paused, true);
  assert.equal(s.controller.getState().current?.id, "t2");
  s.controller.dispose();
  assert.equal(s.reports.filter((report) => report.event === "stop").length, 1, "dispose has nothing left to report");
});

test("shuffle keeps the current track first and turning it off restores the original order", async () => {
  const s = setup();
  const many = Array.from({ length: 20 }, (_, index) => track(`t${index + 1}`));
  s.controller.playQueue(many, 4);
  await settle();
  s.controller.setShuffle(true);
  const shuffledIDs = s.controller.getState().queue.map((item) => item.id);
  assert.equal(shuffledIDs[0], "t5");
  assert.deepEqual([...shuffledIDs].sort(), many.map((item) => item.id).sort());
  s.controller.next();
  await settle();
  const playing = s.controller.getState().current?.id;
  s.controller.setShuffle(false);
  const state = s.controller.getState();
  assert.deepEqual(state.queue.map((item) => item.id), many.map((item) => item.id));
  assert.equal(state.current?.id, playing, "the playing track stays current");
});

test("the queue survives a reload paused at the same place, and only plays when asked", async () => {
  const storage = memoryStorage();
  const first = setup({ storage });
  first.controller.playQueue(tracks, 1);
  await settle();
  first.audio.currentTime = 73;
  first.clock.now = 10_000;
  first.audio.emit("timeupdate");
  first.controller.pageHidden();
  assert.ok(storage.values.get("leerr.player.u1"));
  assert.equal(storage.values.get("leerr.player.u1")?.includes("/api/v1/streams/"), false, "tickets are never stored");
  const second = setup({ storage });
  const state = second.controller.getState();
  assert.equal(state.current?.id, "t2");
  assert.equal(state.playing, false);
  assert.equal(second.tickets.length, 0, "nothing loads until the person presses play");
  assert.equal(second.controller.getPosition(), 73);
  second.controller.toggle();
  await settle();
  assert.equal(second.audio.currentTime, 73);
  assert.equal(second.controller.getState().playing, true);
  second.controller.stop();
  assert.equal(storage.values.has("leerr.player.u1"), false);
  storage.values.set("leerr.player.u1", "{not json");
  assert.equal(setup({ storage }).controller.getState().current, null, "a broken saved queue is ignored");
});

test("progress is reported every 30 seconds while playing, and on pause", async () => {
  const s = setup();
  s.controller.playQueue(tracks, 0);
  await settle();
  s.audio.currentTime = 10;
  s.clock.now = 10_000;
  s.audio.emit("timeupdate");
  s.audio.currentTime = 31;
  s.clock.now = 31_000;
  s.audio.emit("timeupdate");
  s.audio.pause();
  assert.deepEqual(
    s.reports.map((report) => [report.event, report.position]),
    [
      ["start", 0],
      ["progress", 31],
      ["progress", 31],
    ],
  );
});
