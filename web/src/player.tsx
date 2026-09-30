import { LoaderCircle, Pause, Play, SkipBack, SkipForward, X } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { artworkURL, errorMessage, request, ticketSchema, type Track } from "./api.ts";
import { Link } from "./router.tsx";
import { Artwork, formatDuration } from "./ui.tsx";

export type QueueItem = Track & { albumID: string; albumTitle: string };

type PlayerValue = {
  queue: QueueItem[];
  index: number;
  current: QueueItem | null;
  playing: boolean;
  loading: boolean;
  error: string;
  position: number;
  duration: number;
  playQueue: (items: QueueItem[], start: number) => void;
  toggle: () => void;
  next: () => void;
  previous: () => void;
  seek: (seconds: number) => void;
  stop: () => void;
};

const PlayerContext = createContext<PlayerValue | null>(null);

export function usePlayer(): PlayerValue {
  const value = useContext(PlayerContext);
  if (!value) throw new Error("usePlayer needs a PlayerProvider.");
  return value;
}

/**
 * One audio element for the whole app. Each track gets a stream ticket; if a
 * ticket stops working mid-track (e.g. after a long pause), playback resumes
 * from the same position with a fresh ticket, once.
 */
export function PlayerProvider({ children }: { children: ReactNode }) {
  const audio = useRef<HTMLAudioElement | null>(null);
  audio.current ??= new Audio();
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [index, setIndex] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const generation = useRef(0);
  const recovered = useRef(false);
  const current = index >= 0 ? (queue[index] ?? null) : null;

  const load = useCallback(async (item: QueueItem, resumeAt = 0) => {
    const element = audio.current;
    if (!element) return;
    const attempt = ++generation.current;
    setLoading(true);
    setError("");
    try {
      const ticket = await request("/stream-tickets", ticketSchema, {
        method: "POST",
        body: JSON.stringify({ trackID: item.id }),
      });
      if (attempt !== generation.current) return;
      element.src = ticket.url;
      if (resumeAt) element.currentTime = resumeAt;
      await element.play();
    } catch (cause) {
      if (attempt !== generation.current) return;
      setLoading(false);
      // Autoplay refusals are not errors: the user can press play.
      if (cause instanceof DOMException && cause.name === "NotAllowedError") return;
      setError(errorMessage(cause, "Playback failed."));
    }
  }, []);

  useEffect(() => {
    recovered.current = false;
    setPosition(0);
    setDuration(current?.duration ?? 0);
    if (current) void load(current);
    // Only a change of track reloads; the item object is stable within a queue.
  }, [queue, index, load]);

  const next = useCallback(() => {
    setIndex((value) => (value + 1 < queue.length ? value + 1 : value));
  }, [queue.length]);
  const previous = useCallback(() => {
    const element = audio.current;
    if (element && element.currentTime > 3) element.currentTime = 0;
    else setIndex((value) => Math.max(0, value - 1));
  }, []);

  useEffect(() => {
    const element = audio.current;
    if (!element) return;
    const events: Array<[string, () => void]> = [
      [
        "playing",
        () => {
          setPlaying(true);
          setLoading(false);
        },
      ],
      ["pause", () => setPlaying(false)],
      ["waiting", () => setLoading(true)],
      ["canplay", () => setLoading(false)],
      ["timeupdate", () => setPosition(element.currentTime)],
      [
        "durationchange",
        () => {
          if (Number.isFinite(element.duration)) setDuration(element.duration);
        },
      ],
      [
        "ended",
        () => {
          if (index + 1 < queue.length) next();
          else setPlaying(false);
        },
      ],
      [
        "error",
        () => {
          if (!current || !element.src) return;
          if (!recovered.current) {
            recovered.current = true;
            void load(current, element.currentTime);
            return;
          }
          setLoading(false);
          setPlaying(false);
          setError("This track could not be played. Its format may not be supported by this browser.");
        },
      ],
    ];
    for (const [name, handler] of events) element.addEventListener(name, handler);
    return () => {
      for (const [name, handler] of events) element.removeEventListener(name, handler);
    };
  }, [current, index, queue.length, next, load]);

  const toggle = useCallback(() => {
    const element = audio.current;
    if (!element || !current) return;
    if (element.paused) void element.play().catch((cause: Error) => setError(errorMessage(cause, "Playback failed.")));
    else element.pause();
  }, [current]);
  const seek = useCallback((seconds: number) => {
    const element = audio.current;
    if (element && Number.isFinite(seconds)) element.currentTime = seconds;
  }, []);
  const stop = useCallback(() => {
    generation.current++;
    const element = audio.current;
    if (element) {
      element.pause();
      element.removeAttribute("src");
      element.load();
    }
    setQueue([]);
    setIndex(-1);
    setPlaying(false);
    setLoading(false);
    setError("");
  }, []);
  const playQueue = useCallback((items: QueueItem[], start: number) => {
    setQueue(items);
    setIndex(start);
  }, []);

  useEffect(() => stop, [stop]);

  // Operating-system media controls and lock-screen metadata.
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.metadata = current
      ? new MediaMetadata({
          title: current.title,
          artist: current.artist,
          album: current.albumTitle,
          artwork: [{ src: artworkURL(current.albumID) }],
        })
      : null;
    const handlers: Array<[MediaSessionAction, MediaSessionActionHandler | null]> = [
      ["play", toggle],
      ["pause", toggle],
      ["nexttrack", next],
      ["previoustrack", previous],
      ["seekto", (details) => seek(details.seekTime ?? 0)],
    ];
    for (const [action, handler] of handlers) navigator.mediaSession.setActionHandler(action, handler);
  }, [current, toggle, next, previous, seek]);

  const value = useMemo(
    () => ({
      queue,
      index,
      current,
      playing,
      loading,
      error,
      position,
      duration,
      playQueue,
      toggle,
      next,
      previous,
      seek,
      stop,
    }),
    [queue, index, current, playing, loading, error, position, duration, playQueue, toggle, next, previous, seek, stop],
  );
  return <PlayerContext.Provider value={value}>{children}</PlayerContext.Provider>;
}

export function PlayerBar() {
  const player = usePlayer();
  const { current } = player;
  if (!current) return null;
  const max = player.duration || current.duration || 0;
  return (
    <section className="player" aria-label="Player">
      <Link to={`/albums/${encodeURIComponent(current.albumID)}`} className="playerNow" label={`Open ${current.albumTitle}`}>
        <Artwork sources={[artworkURL(current.albumID)]} />
        <span>
          <b>{current.title}</b>
          <small>{player.error || current.artist}</small>
        </span>
      </Link>
      <div className="playerControls">
        <button type="button" className="iconButton" onClick={player.previous} aria-label="Previous track">
          <SkipBack aria-hidden="true" />
        </button>
        <button
          type="button"
          className="playButton"
          onClick={player.toggle}
          aria-label={player.playing ? "Pause" : "Play"}
        >
          {player.loading ? (
            <LoaderCircle className="spin" aria-hidden="true" />
          ) : player.playing ? (
            <Pause aria-hidden="true" />
          ) : (
            <Play aria-hidden="true" />
          )}
        </button>
        <button
          type="button"
          className="iconButton"
          onClick={player.next}
          disabled={player.index + 1 >= player.queue.length}
          aria-label="Next track"
        >
          <SkipForward aria-hidden="true" />
        </button>
      </div>
      <div className="playerSeek">
        <span>{formatDuration(player.position)}</span>
        <input
          type="range"
          min={0}
          max={max || 1}
          step={1}
          value={Math.min(player.position, max || 1)}
          onChange={(event) => player.seek(Number(event.currentTarget.value))}
          aria-label="Seek"
          aria-valuetext={`${formatDuration(player.position)} of ${formatDuration(max)}`}
          disabled={!max}
        />
        <span>{formatDuration(max)}</span>
      </div>
      <button type="button" className="iconButton playerClose" onClick={player.stop} aria-label="Stop and close player">
        <X aria-hidden="true" />
      </button>
    </section>
  );
}
