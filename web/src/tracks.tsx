import { Check, Clock3, Heart, ListEnd, ListPlus, ListStart, MoreHorizontal, Pause, Play, X } from "lucide-react";
import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import { playlistsSchema, request, send, type Track } from "./api.ts";
import { useAction, useResource } from "./hooks.ts";
import { useEnqueue, usePlayer } from "./player.tsx";
import { ErrorBox, formatDuration, Spinner } from "./ui.tsx";

export function quality(track: Track): string {
  return [
    track.codec?.toUpperCase() ?? "",
    track.bitDepth ? `${track.bitDepth}-bit` : "",
    track.sampleRate ? `${track.sampleRate / 1000} kHz` : "",
  ]
    .filter((part) => part)
    .join(" · ");
}

/** A heart that marks an album or track as a favourite in the person's Jellyfin account. */
export function FavoriteButton({ itemID, name, initial, compact = false }: { itemID: string; name: string; initial: boolean; compact?: boolean }) {
  const [favorite, setFavorite] = useState(initial);
  const action = useAction();
  useEffect(() => setFavorite(initial), [initial]);
  const toggle = () =>
    void action.run(async () => {
      const next = !favorite;
      setFavorite(next);
      try {
        await send(`/favorites/${encodeURIComponent(itemID)}`, next ? "PUT" : "DELETE");
      } catch (cause) {
        setFavorite(!next);
        throw cause;
      }
    });
  return (
    <>
      {/* aria-disabled while saving: a disabled button would drop keyboard focus. */}
      <button
        type="button"
        className={`${compact ? "iconButton" : "secondary"} favoriteButton ${favorite ? "on" : ""}`}
        aria-pressed={favorite}
        aria-label={compact ? `Favourite ${name}` : undefined}
        aria-disabled={action.pending}
        title={compact && action.error ? `Couldn't update favourite: ${action.error}` : undefined}
        onClick={toggle}
      >
        <Heart aria-hidden="true" />
        {!compact && (favorite ? "Favourite" : "Add to favourites")}
      </button>
      {action.error &&
        (compact ? (
          <span className="sr-only" role="alert">
            Couldn't update favourite for {name}: {action.error}
          </span>
        ) : (
          <ErrorBox message={action.error} />
        ))}
    </>
  );
}

/** Tracks of an album or playlist; the row's main button plays from that track. */
export function TrackList({ tracks, showArtistUnless, showAlbum = false }: { tracks: Track[]; showArtistUnless: string; showAlbum?: boolean }) {
  const player = usePlayer();
  const discs = new Set(tracks.map((track) => track.disc ?? 1)).size;
  const [adding, setAdding] = useState<Track[] | null>(null);
  return (
    <>
      <ol className="tracks" aria-label="Tracks">
        <li className="track heading" aria-hidden="true">
          <span>#</span>
          <span>Title</span>
          <span>Source</span>
          <span>
            <Clock3 />
          </span>
          <span />
        </li>
        {tracks.map((track, index) => {
          // By id: a mixed or shuffled queue makes positions meaningless.
          const active = player.current?.id === track.id;
          return (
            <li key={`${index}-${track.id}`} className={`track ${active ? "active" : ""}`}>
              <button
                type="button"
                className="trackPlay"
                onClick={() => (active ? player.controller.toggle() : player.controller.playQueue(tracks, index))}
                aria-label={active && player.playing ? `Pause ${track.title}` : `Play ${track.title}`}
                aria-current={active ? "true" : undefined}
              >
                <span className="trackNumber">
                  {active && player.playing ? (
                    <Pause aria-hidden="true" />
                  ) : (
                    <>
                      <span className="number">
                        {showAlbum ? index + 1 : `${discs > 1 && track.disc ? `${track.disc}.` : ""}${track.number ?? index + 1}`}
                      </span>
                      <Play aria-hidden="true" className="hoverPlay" />
                    </>
                  )}
                </span>
                <span className="trackTitle">
                  <b>{track.title}</b>
                  {(track.artist && track.artist !== showArtistUnless) || (showAlbum && track.albumTitle) ? (
                    <small>{[track.artist !== showArtistUnless ? track.artist : "", showAlbum ? track.albumTitle : ""].filter((part) => part).join(" · ")}</small>
                  ) : null}
                </span>
                <span className="trackQuality">{quality(track)}</span>
                <span className="trackDuration">{formatDuration(track.duration)}</span>
              </button>
              <div className="trackEnd">
                <FavoriteButton itemID={track.id} name={track.title} initial={track.favorite} compact />
                <TrackMenu track={track} addToPlaylist={() => setAdding([track])} />
              </div>
            </li>
          );
        })}
      </ol>
      {adding && <AddToPlaylist tracks={adding} close={() => setAdding(null)} />}
    </>
  );
}

/** The bottom of the visible page, above the fixed player and navigation bar. */
function usableBottom(): number {
  const tops = [".player", ".bottomNav"].flatMap((selector) => {
    const element = document.querySelector(selector);
    const top = element?.getBoundingClientRect().top;
    // A hidden bar (e.g. the bottom navigation on wide screens) measures 0.
    return top && element.getClientRects().length ? [top] : [];
  });
  return Math.min(innerHeight, ...tops);
}

function TrackMenu({ track, addToPlaylist }: { track: Track; addToPlaylist: () => void }) {
  const enqueue = useEnqueue();
  const menu = useRef<HTMLDetailsElement>(null);
  const summary = useRef<HTMLElement>(null);
  const items = useRef<HTMLDivElement>(null);
  const [up, setUp] = useState(false);
  const close = (refocus: boolean) => {
    menu.current?.removeAttribute("open");
    if (refocus) summary.current?.focus();
  };
  // Synchronous on purpose: focus is on the summary before a dialog opens, so closing it returns there.
  const run = (work: () => void) => () => {
    close(true);
    work();
  };
  const toggled = (event: SyntheticEvent<HTMLDetailsElement>) => {
    if (!event.currentTarget.open) return;
    const bottom = summary.current?.getBoundingClientRect().bottom ?? 0;
    setUp(bottom + (items.current?.offsetHeight ?? 0) > usableBottom());
  };
  useEffect(() => {
    const details = menu.current;
    if (!details) return;
    const outside = (event: PointerEvent) => {
      if (details.open && event.target instanceof Node && !details.contains(event.target)) close(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (details.open && event.key === "Escape") {
        event.preventDefault();
        close(true);
      }
    };
    // Only when focus moves to something else: Safari blurs to nothing when a menu button is clicked.
    const leave = (event: FocusEvent) => {
      if (event.relatedTarget instanceof Node && !details.contains(event.relatedTarget)) close(false);
    };
    document.addEventListener("pointerdown", outside);
    details.addEventListener("keydown", escape);
    details.addEventListener("focusout", leave);
    return () => {
      document.removeEventListener("pointerdown", outside);
      details.removeEventListener("keydown", escape);
      details.removeEventListener("focusout", leave);
    };
  }, []);
  return (
    // One name for every track menu: opening one closes the others.
    <details className="trackMenu" name="track-menu" ref={menu} onToggle={toggled}>
      <summary className="iconButton" ref={summary} aria-label={`More options for ${track.title}`}>
        <MoreHorizontal aria-hidden="true" />
      </summary>
      <div className={`menu ${up ? "up" : ""}`} ref={items} role="group" aria-label={`Options for ${track.title}`}>
        <button type="button" onClick={run(() => enqueue([track], "next"))}>
          <ListStart aria-hidden="true" /> Play next
        </button>
        <button type="button" onClick={run(() => enqueue([track], "end"))}>
          <ListEnd aria-hidden="true" /> Add to queue
        </button>
        <button type="button" onClick={run(addToPlaylist)}>
          <ListPlus aria-hidden="true" /> Add to playlist…
        </button>
      </div>
    </details>
  );
}

/** Picks one of the person's Jellyfin playlists and appends the tracks to it. */
export function AddToPlaylist({ tracks, close }: { tracks: Track[]; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const playlists = useResource((signal) => request("/playlists", playlistsSchema, { signal }), []);
  const action = useAction();
  const [done, setDone] = useState("");
  const success = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  // The list (and the focused Add button) is replaced by the confirmation.
  useEffect(() => {
    if (done) success.current?.focus();
  }, [done]);
  const add = (id: string, name: string) =>
    void action.run(async () => {
      await send(`/playlists/${encodeURIComponent(id)}/tracks`, "POST", { trackIDs: tracks.map((track) => track.id) });
      setDone(name);
    });
  const subject = tracks.length === 1 ? `“${tracks[0].title}”` : `${tracks.length} tracks`;
  return (
    <dialog ref={dialog} className="modal" aria-labelledby="playlist-title" onClose={close}>
      <button type="button" className="iconButton modalClose" aria-label="Close" onClick={() => dialog.current?.close()}>
        <X aria-hidden="true" />
      </button>
      <h2 id="playlist-title">Add {subject} to a playlist</h2>
      {done ? (
        <p className="success" role="status" tabIndex={-1} ref={success}>
          <Check aria-hidden="true" /> Added to {done}.
        </p>
      ) : playlists.loading ? (
        <Spinner label="Loading playlists…" />
      ) : playlists.error ? (
        <ErrorBox message={playlists.error} retry={playlists.reload} />
      ) : !playlists.data?.items.length ? (
        <p className="muted">You have no playlists yet. Create one in Jellyfin first.</p>
      ) : (
        <ul className="rows">
          {playlists.data.items.map((playlist) => (
            <li key={playlist.id}>
              <span>
                <b>{playlist.name}</b>
                <small>{playlist.tracks === null ? "" : `${playlist.tracks} tracks`}</small>
              </span>
              <button type="button" className="secondary" aria-disabled={action.pending} onClick={() => add(playlist.id, playlist.name)}>
                Add
              </button>
            </li>
          ))}
        </ul>
      )}
      {action.error && <ErrorBox message={action.error} />}
    </dialog>
  );
}
