import { ListMusic, LoaderCircle, Pause, Play, Repeat, Repeat1, Shuffle, SkipBack, SkipForward, X } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { artworkURL, request, sendInBackground, streamProblem, ticketSchema, type Track } from "./api.ts";
import { PlaybackController, type PlayerState } from "./playback.ts";
import { Link } from "./router.tsx";
import { Artwork, focusLost, formatDuration } from "./ui.tsx";

export type { Track };

const ControllerContext = createContext<PlaybackController | null>(null);
const AnnounceContext = createContext<(message: string) => void>(() => {});

function useController(): PlaybackController {
  const controller = useContext(ControllerContext);
  if (!controller) throw new Error("The player needs a PlayerProvider.");
  return controller;
}

/** Player state and controls. Does not change with the playback position. */
export function usePlayer(): PlayerState & { controller: PlaybackController } {
  const controller = useController();
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  return useMemo(() => ({ ...state, controller }), [state, controller]);
}
/** Seconds into the current track; changes several times a second, so only the seek bar uses it. */
export function usePosition(): number {
  const controller = useController();
  return useSyncExternalStore(controller.subscribePosition, controller.getPosition);
}

/** Whether `track` is the one loaded in the player, by queue identity rather than position. */
export function useIsCurrent(trackID: string): boolean {
  return usePlayer().current?.id === trackID;
}

/** Says something briefly, on screen and to screen readers (e.g. what was queued). */
export const useAnnounce = () => useContext(AnnounceContext);

/** Queues tracks next or last, and says so. */
export function useEnqueue(): (items: Track[], where: "next" | "end") => void {
  const controller = useController();
  const announce = useAnnounce();
  return useCallback(
    (items, where) => {
      const outcome = controller.enqueue(items, where);
      if (!outcome) return;
      const subject = items.length === 1 ? `“${items[0].title}”` : `${items.length} tracks`;
      announce(
        outcome === "playing"
          ? `Playing ${subject}`
          : where === "next"
            ? `${subject} will play next`
            : `${subject} added to the queue`,
      );
    },
    [controller, announce],
  );
}

export const storageKey = (userID: string) => `leerr.player.${userID}`;
export const storagePrefix = "leerr.player.";

/** One player per signed-in user; its queue survives reloads in this browser only. */
export function createController(userID: string): PlaybackController {
  return new PlaybackController(
    new Audio(),
    {
      ticket: (trackID) => request("/stream-tickets", ticketSchema, { method: "POST", body: JSON.stringify({ trackID }) }),
      report: (event, trackID, position, paused, keepalive) =>
        sendInBackground("/playback", { trackID, event, position: Math.max(0, position), paused }, keepalive),
      probe: streamProblem,
      storage: safeStorage(),
      now: () => Date.now(),
    },
    storageKey(userID),
  );
}

export function PlayerProvider({ controller, children }: { controller: PlaybackController; children: ReactNode }) {
  const [message, announce] = useAnnouncer();
  useEffect(() => {
    controller.attach();
    const hidden = () => controller.pageHidden();
    window.addEventListener("pagehide", hidden);
    return () => {
      window.removeEventListener("pagehide", hidden);
      controller.dispose();
    };
  }, [controller]);
  return (
    <ControllerContext.Provider value={controller}>
      <AnnounceContext.Provider value={announce}>
        <MediaSession />
        {children}
        {/* Always mounted, so screen readers announce each new message. */}
        <div className="toastRegion" role="status">
          {message && <p className="toast">{message}</p>}
        </div>
      </AnnounceContext.Provider>
    </ControllerContext.Provider>
  );
}

function useAnnouncer(): [string, (message: string) => void] {
  const [message, setMessage] = useState("");
  const timer = useRef(0);
  const announce = useCallback((text: string) => {
    window.clearTimeout(timer.current);
    // Cleared first, so the same message twice is announced twice.
    setMessage("");
    timer.current = window.setTimeout(() => {
      setMessage(text);
      timer.current = window.setTimeout(() => setMessage(""), 4_000);
    }, 50);
  }, []);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return [message, announce];
}

function safeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

const mediaActions: MediaSessionAction[] = ["play", "pause", "nexttrack", "previoustrack", "seekto", "stop"];

/** Operating-system media controls and lock-screen metadata. */
function MediaSession() {
  const { current, playing, loading, controller } = usePlayer();
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.metadata = current
      ? new MediaMetadata({
          title: current.title,
          artist: current.artist,
          album: current.albumTitle ?? "",
          artwork: current.albumID
            ? [
                { src: artworkURL(current.albumID, "medium"), sizes: "512x512" },
                { src: artworkURL(current.albumID, "large"), sizes: "1024x1024" },
              ]
            : [],
        })
      : null;
  }, [current]);
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    // Play and pause are commands, not toggles: a headset's "pause" must never start playback.
    const handlers: Array<[MediaSessionAction, MediaSessionActionHandler]> = [
      ["play", () => controller.play()],
      ["pause", () => controller.pause()],
      ["nexttrack", () => controller.next()],
      ["previoustrack", () => controller.previous()],
      ["seekto", (details) => controller.seek(details.seekTime ?? 0)],
      ["stop", () => controller.stop()],
    ];
    for (const [action, handler] of handlers) setAction(action, handler);
    return () => {
      // Signed out: the lock screen must not keep the last person's track or controls.
      for (const action of mediaActions) setAction(action, null);
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.playbackState = "none";
    };
  }, [controller]);
  useEffect(() => {
    if ("mediaSession" in navigator)
      navigator.mediaSession.playbackState = current ? (controller.intendsToPlay() ? "playing" : "paused") : "none";
  }, [current, playing, loading, controller]);
  return null;
}

function setAction(action: MediaSessionAction, handler: MediaSessionActionHandler | null) {
  try {
    navigator.mediaSession.setActionHandler(action, handler);
  } catch {
    // Older browsers reject actions they do not know.
  }
}

export function PlayerBar() {
  const { current } = usePlayer();
  const shown = current !== null;
  const wasShown = useRef(shown);
  useEffect(() => {
    // Closing the player removes the control that had focus (its close button, or the queue's last row).
    if (wasShown.current && !shown && focusLost()) document.getElementById("content")?.focus({ preventScroll: true });
    wasShown.current = shown;
  }, [shown]);
  // The bar's own state (e.g. an open queue) starts afresh each time the player appears.
  return current ? <PlayerBarContent current={current} /> : null;
}

function PlayerBarContent({ current }: { current: Track }) {
  const player = usePlayer();
  const { controller } = player;
  const [queueOpen, setQueueOpen] = useState(false);
  const artwork = current.albumID ? [artworkURL(current.albumID, "small")] : [];
  const label = `${current.title} by ${current.artist}${current.albumTitle ? `, from ${current.albumTitle}` : ""}`;
  const playing = controller.intendsToPlay();
  const hasNext = controller.hasNext();
  return (
    <section className="player" aria-label="Player">
      {current.albumID ? (
        <Link to={`/albums/${encodeURIComponent(current.albumID)}`} className="playerNow" label={`${label}. Open album`}>
          <Artwork sources={artwork} />
          <NowPlaying title={current.title} artist={current.artist} />
        </Link>
      ) : (
        <div className="playerNow">
          <Artwork sources={artwork} />
          <NowPlaying title={current.title} artist={current.artist} />
        </div>
      )}
      <div className="playerControls">
        <button
          type="button"
          className={`iconButton toggle ${player.shuffle ? "on" : ""}`}
          onClick={() => controller.setShuffle(!player.shuffle)}
          aria-pressed={player.shuffle}
          aria-label="Shuffle"
        >
          <Shuffle aria-hidden="true" />
        </button>
        <button type="button" className="iconButton" onClick={() => controller.previous()} aria-label="Previous track">
          <SkipBack aria-hidden="true" />
        </button>
        <button type="button" className="playButton" onClick={() => controller.toggle()} aria-label={playing ? "Pause" : "Play"}>
          {player.loading ? (
            <LoaderCircle className="spin" aria-hidden="true" />
          ) : playing ? (
            <Pause aria-hidden="true" />
          ) : (
            <Play aria-hidden="true" />
          )}
        </button>
        {/* aria-disabled, not disabled: reaching the last track must not drop keyboard focus. */}
        <button type="button" className="iconButton" onClick={() => controller.next()} aria-disabled={!hasNext} aria-label="Next track">
          <SkipForward aria-hidden="true" />
        </button>
        <button
          type="button"
          className={`iconButton toggle ${player.repeat !== "off" ? "on" : ""}`}
          onClick={() => controller.cycleRepeat()}
          aria-label={player.repeat === "one" ? "Repeat this track" : player.repeat === "all" ? "Repeat the queue" : "Repeat off"}
        >
          {player.repeat === "one" ? <Repeat1 aria-hidden="true" /> : <Repeat aria-hidden="true" />}
        </button>
      </div>
      <SeekBar duration={player.duration || current.duration || 0} />
      <div className="playerEnd">
        <button type="button" className="iconButton" onClick={() => setQueueOpen(true)} aria-label={`Up next, ${player.queue.length} tracks`}>
          <ListMusic aria-hidden="true" />
        </button>
        <button type="button" className="iconButton playerClose" onClick={() => controller.stop()} aria-label="Stop and close player">
          <X aria-hidden="true" />
        </button>
      </div>
      {/* Always mounted so screen readers announce a new error. */}
      <p className="playerError" role="status" title={player.error || undefined}>
        {player.error}
      </p>
      {queueOpen && <QueueDialog close={() => setQueueOpen(false)} />}
    </section>
  );
}

function NowPlaying({ title, artist }: { title: string; artist: string }) {
  return (
    <span>
      <b>{title}</b>
      <small>{artist}</small>
    </span>
  );
}

/**
 * Dragging only moves the thumb; the seek happens on release, so the slider
 * neither snaps back mid-drag nor seeks on every step.
 */
function SeekBar({ duration }: { duration: number }) {
  const { controller } = usePlayer();
  const position = usePosition();
  const [scrub, setScrub] = useState<number | null>(null);
  const max = Math.max(1, Math.floor(duration));
  const shown = scrub ?? Math.min(Math.floor(position), max);
  const commit = () => {
    if (scrub === null) return;
    controller.seek(scrub);
    setScrub(null);
  };
  return (
    <div className="playerSeek">
      <span>{formatDuration(shown)}</span>
      <input
        type="range"
        min={0}
        max={max}
        step={1}
        value={shown}
        onChange={(event) => setScrub(Number(event.currentTarget.value))}
        onPointerUp={commit}
        onPointerCancel={commit}
        onKeyUp={commit}
        onBlur={commit}
        aria-label="Seek"
        aria-valuetext={`${formatDuration(shown)} of ${formatDuration(duration)}`}
        disabled={!duration}
      />
      <span>{formatDuration(duration)}</span>
    </div>
  );
}

type QueueAction = "up" | "down" | "remove";

function QueueDialog({ close }: { close: () => void }) {
  const { queue, index, controller } = usePlayer();
  const announce = useAnnounce();
  const dialog = useRef<HTMLDialogElement>(null);
  const list = useRef<HTMLOListElement>(null);
  // Rows are keyed by position, so a move or removal remounts them: focus follows the track by hand.
  const refocus = useRef<{ position: number; action: QueueAction } | null>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  useLayoutEffect(() => {
    const target = refocus.current;
    if (!target) return;
    refocus.current = null;
    const row = list.current?.children.item(target.position);
    const button =
      row?.querySelector<HTMLButtonElement>(`[data-action="${target.action}"]:not(:disabled)`) ??
      row?.querySelector<HTMLButtonElement>("[data-action]:not(:disabled)") ??
      row?.querySelector<HTMLButtonElement>(".queueJump");
    button?.focus();
  }, [queue]);
  const move = (track: Track, position: number, delta: -1 | 1) => {
    refocus.current = { position: position + delta, action: delta < 0 ? "up" : "down" };
    controller.move(position, delta);
    announce(`“${track.title}” moved to position ${position + delta + 1}`);
  };
  const remove = (track: Track, position: number) => {
    if (queue.length > 1) refocus.current = { position: Math.min(position, queue.length - 2), action: "remove" };
    controller.removeAt(position);
    announce(`“${track.title}” removed from the queue`);
  };
  return (
    <dialog ref={dialog} className="modal queueDialog" aria-labelledby="queue-title" onClose={close}>
      <button type="button" className="iconButton modalClose" aria-label="Close" onClick={() => dialog.current?.close()}>
        <X aria-hidden="true" />
      </button>
      <h2 id="queue-title">Up next</h2>
      <ol className="queueList" ref={list}>
        {queue.map((track, position) => (
          // Positions identify entries: the same track can be queued twice.
          <li key={`${position}-${track.id}`} className={position === index ? "active" : ""}>
            <button
              type="button"
              className="queueJump"
              onClick={() => controller.jumpTo(position)}
              aria-current={position === index ? "true" : undefined}
            >
              <b>{track.title}</b>
              <small>
                {track.artist} · {formatDuration(track.duration)}
              </small>
            </button>
            <div className="queueActions">
              <button
                type="button"
                className="iconButton"
                data-action="up"
                disabled={position === 0}
                onClick={() => move(track, position, -1)}
                aria-label={`Move ${track.title} up`}
              >
                ↑
              </button>
              <button
                type="button"
                className="iconButton"
                data-action="down"
                disabled={position === queue.length - 1}
                onClick={() => move(track, position, 1)}
                aria-label={`Move ${track.title} down`}
              >
                ↓
              </button>
              <button
                type="button"
                className="iconButton"
                data-action="remove"
                onClick={() => remove(track, position)}
                aria-label={`Remove ${track.title} from the queue`}
              >
                <X aria-hidden="true" />
              </button>
            </div>
          </li>
        ))}
      </ol>
    </dialog>
  );
}
