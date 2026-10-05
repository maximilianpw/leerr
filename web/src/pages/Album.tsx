import { ArrowLeft, ListEnd, ListPlus, ListStart, Pause, Play, Shuffle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { albumDetailSchema, artworkURL, request, type Track } from "../api.ts";
import { useResource } from "../hooks.ts";
import { playable } from "../playback.ts";
import { useEnqueue, usePlayer } from "../player.tsx";
import { goBack, Link } from "../router.tsx";
import { AddToPlaylist, FavoriteButton, TrackList } from "../tracks.tsx";
import { Artwork, ErrorBox, formatDuration, Spinner, Title } from "../ui.tsx";

export function AlbumPage({ id }: { id: string }) {
  const detail = useResource((signal) => request(`/albums/${encodeURIComponent(id)}`, albumDetailSchema, { signal }), [id]);
  const player = usePlayer();
  const enqueue = useEnqueue();
  const heading = useRef<HTMLHeadingElement>(null);
  const [adding, setAdding] = useState<Track[] | null>(null);
  const settled = detail.data !== null || !detail.loading;
  // The heading that had focus during loading is replaced: move focus to the new one,
  // unless the person has already moved on.
  useEffect(() => {
    if (settled && document.activeElement === document.body) heading.current?.focus();
  }, [settled]);

  const back = (
    <button type="button" className="back" onClick={() => goBack("/library")}>
      <ArrowLeft aria-hidden="true" /> Back
    </button>
  );
  if (detail.loading && !detail.data)
    return (
      <div className="page">
        <Title text="Loading album" />
        {back}
        <h1 className="sr-only" tabIndex={-1} ref={heading}>
          Loading album
        </h1>
        <Spinner label="Loading album…" />
      </div>
    );
  if (!detail.data)
    return (
      <div className="page">
        <Title text="Album unavailable" />
        {back}
        <h1 tabIndex={-1} ref={heading}>
          Album unavailable
        </h1>
        <ErrorBox message={detail.error || "This album could not be loaded."} retry={detail.reload} />
        {detail.code === "plex_reconnect" && <Link to="/settings">Sign in to Plex again in Settings</Link>}
      </div>
    );

  const { album } = detail.data;
  // The queue needs to know where each track comes from (artwork, the link back here).
  const tracks = detail.data.tracks.map((track) => ({ ...track, albumID: album.id, albumTitle: album.title }));
  const ready = playable(tracks);
  const playingHere = player.current?.albumID === album.id;
  const total = tracks.reduce((sum, track) => sum + (track.duration ?? 0), 0);
  const play = (shuffle: boolean) => {
    if (shuffle) {
      player.controller.playShuffled(ready);
      return;
    }
    player.controller.setShuffle(false);
    player.controller.playQueue(ready, 0);
  };

  return (
    <div className="page">
      <Title text={`${album.title} – ${album.artist}`} />
      {back}
      <section className="albumHero">
        <Artwork sources={album.hasArtwork ? [artworkURL(album.id, "large")] : []} />
        <div>
          <span className="eyebrow">Album</span>
          <h1 tabIndex={-1} ref={heading}>
            {album.title}
          </h1>
          <p className="albumArtist">
            {album.artistMBID ? (
              <Link to={`/discover/artists/${album.artistMBID}?name=${encodeURIComponent(album.artist)}`} label={`More by ${album.artist} on Discover`}>
                {album.artist}
              </Link>
            ) : (
              album.artist
            )}
          </p>
          {!album.available && <p className="notice">This album is in Plex's trash: its files are gone until someone restores them or Plex empties the trash.</p>}
          <p className="muted">
            {[album.year, `${tracks.length} ${tracks.length === 1 ? "track" : "tracks"}`, total ? formatDuration(total) : ""]
              .filter((part) => part)
              .join(" · ")}
            {album.artistID && (
              <>
                {" · "}
                <Link to={`/library?artist=${encodeURIComponent(album.artistID)}&name=${encodeURIComponent(album.artist)}`}>
                  All {album.artist} in your library
                </Link>
              </>
            )}
          </p>
          <div className="heroActions">
            <button
              type="button"
              className="primary"
              disabled={!ready.length}
              onClick={() => (playingHere ? player.controller.toggle() : play(false))}
            >
              {playingHere && player.playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
              {playingHere && player.playing ? "Pause" : playingHere && !player.loading ? "Resume" : "Play album"}
            </button>
            <button type="button" className="secondary" disabled={!ready.length} onClick={() => play(true)}>
              <Shuffle aria-hidden="true" /> Shuffle
            </button>
            <button type="button" className="secondary" disabled={!ready.length} onClick={() => enqueue(ready, "next")}>
              <ListStart aria-hidden="true" /> Play next
            </button>
            <button type="button" className="secondary" disabled={!ready.length} onClick={() => enqueue(ready, "end")}>
              <ListEnd aria-hidden="true" /> Add to queue
            </button>
            <button type="button" className="secondary" disabled={!ready.length} onClick={() => setAdding(ready)}>
              <ListPlus aria-hidden="true" /> Add to playlist
            </button>
            <FavoriteButton itemID={album.id} name={album.title} initial={album.favorite} />
          </div>
          {album.artistMBID && (
            <p className="small">
              <Link to={`/discover/artists/${album.artistMBID}?name=${encodeURIComponent(album.artist)}`}>More by {album.artist}</Link> — albums you could request.
            </p>
          )}
        </div>
      </section>
      <TrackList tracks={tracks} showArtistUnless={album.artist} />
      {adding && <AddToPlaylist tracks={adding} close={() => setAdding(null)} />}
    </div>
  );
}
