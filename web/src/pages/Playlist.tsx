import { ArrowLeft, Disc3, ListMusic, Play, Shuffle } from "lucide-react";
import { useEffect, useRef } from "react";
import { artworkURL, playlistDetailSchema, request } from "../api.ts";
import { useResource } from "../hooks.ts";
import { playable } from "../playback.ts";
import { usePlayer } from "../player.tsx";
import { goBack } from "../router.tsx";
import { TrackList } from "../tracks.tsx";
import { Artwork, ErrorBox, formatDuration, Spinner, Title } from "../ui.tsx";

export function PlaylistPage({ id }: { id: string }) {
  const detail = useResource((signal) => request(`/playlists/${encodeURIComponent(id)}`, playlistDetailSchema, { signal }), [id]);
  const player = usePlayer();
  const heading = useRef<HTMLHeadingElement>(null);
  const settled = detail.data !== null || !detail.loading;
  useEffect(() => {
    if (settled && document.activeElement === document.body) heading.current?.focus();
  }, [settled]);
  const back = (
    <button type="button" className="back" onClick={() => goBack("/library/playlists")}>
      <ArrowLeft aria-hidden="true" /> Back
    </button>
  );
  if (!detail.data)
    return (
      <div className="page">
        <Title text={detail.loading ? "Loading playlist" : "Playlist unavailable"} />
        {back}
        <h1 tabIndex={-1} ref={heading} className={detail.loading ? "sr-only" : undefined}>
          {detail.loading ? "Loading playlist" : "Playlist unavailable"}
        </h1>
        {detail.loading ? <Spinner label="Loading playlist…" /> : <ErrorBox message={detail.error} retry={detail.reload} />}
      </div>
    );
  const { playlist, tracks } = detail.data;
  const ready = playable(tracks);
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
      <Title text={playlist.name} />
      {back}
      <section className="albumHero">
        {playlist.hasArtwork ? (
          <Artwork sources={[artworkURL(playlist.id, "large")]} />
        ) : (
          <div className="artwork placeholder">
            <ListMusic aria-hidden="true" />
          </div>
        )}
        <div>
          <span className="eyebrow">Playlist</span>
          <h1 tabIndex={-1} ref={heading}>
            {playlist.name}
          </h1>
          <p className="muted">
            {[`${tracks.length} ${tracks.length === 1 ? "track" : "tracks"}`, total ? formatDuration(total) : ""].filter((part) => part).join(" · ")}
          </p>
          <div className="heroActions">
            <button type="button" className="primary" disabled={!ready.length} onClick={() => play(false)}>
              <Play aria-hidden="true" /> Play
            </button>
            <button type="button" className="secondary" disabled={!ready.length} onClick={() => play(true)}>
              <Shuffle aria-hidden="true" /> Shuffle
            </button>
          </div>
        </div>
      </section>
      {tracks.length ? (
        <TrackList tracks={tracks} showArtistUnless="" showAlbum />
      ) : (
        <div className="state">
          <Disc3 aria-hidden="true" />
          <h3>No playable tracks</h3>
          <p>Add tracks to this playlist from an album page, or from a track's … menu.</p>
        </div>
      )}
    </div>
  );
}
