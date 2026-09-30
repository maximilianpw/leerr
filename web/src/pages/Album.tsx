import { ArrowLeft, Clock3, Pause, Play } from "lucide-react";
import { albumDetailSchema, artworkURL, request, type Track } from "../api.ts";
import { useResource } from "../hooks.ts";
import { usePlayer, type QueueItem } from "../player.tsx";
import { Artwork, ErrorBox, formatDuration, Spinner } from "../ui.tsx";

function quality(track: Track): string {
  return [
    track.codec?.toUpperCase() ?? "",
    track.bitDepth ? `${track.bitDepth}-bit` : "",
    track.sampleRate ? `${track.sampleRate / 1000} kHz` : "",
  ]
    .filter((part) => part)
    .join(" · ");
}

export function AlbumPage({ id }: { id: string }) {
  const detail = useResource((signal) => request(`/albums/${encodeURIComponent(id)}`, albumDetailSchema, { signal }), [id]);
  const player = usePlayer();

  if (detail.loading && !detail.data)
    return (
      <div className="page">
        <h1 className="sr-only" tabIndex={-1}>
          Loading album
        </h1>
        <Spinner label="Loading album…" />
      </div>
    );
  if (!detail.data)
    return (
      <div className="page">
        <button type="button" className="back" onClick={() => history.back()}>
          <ArrowLeft aria-hidden="true" /> Back
        </button>
        <h1 tabIndex={-1}>Album unavailable</h1>
        <ErrorBox message={detail.error || "This album could not be loaded."} retry={detail.reload} />
      </div>
    );

  const { album, tracks } = detail.data;
  const queue: QueueItem[] = tracks.map((track) => ({ ...track, albumID: album.id, albumTitle: album.title }));
  const playingHere = player.current?.albumID === album.id;
  const total = tracks.reduce((sum, track) => sum + (track.duration ?? 0), 0);
  const discs = new Set(tracks.map((track) => track.disc ?? 1)).size;

  return (
    <div className="page">
      <button type="button" className="back" onClick={() => history.back()}>
        <ArrowLeft aria-hidden="true" /> Back
      </button>
      <section className="albumHero">
        <Artwork sources={[artworkURL(album.id)]} />
        <div>
          <span className="eyebrow">Album</span>
          <h1 tabIndex={-1}>{album.title}</h1>
          <p className="albumArtist">{album.artist}</p>
          <p className="muted">
            {[album.year, `${tracks.length} ${tracks.length === 1 ? "track" : "tracks"}`, total ? formatDuration(total) : ""]
              .filter((part) => part)
              .join(" · ")}
          </p>
          <button
            type="button"
            className="primary"
            disabled={!tracks.length}
            onClick={() => (playingHere ? player.toggle() : player.playQueue(queue, 0))}
          >
            {playingHere && player.playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
            {playingHere && player.playing ? "Pause" : playingHere ? "Resume" : "Play album"}
          </button>
        </div>
      </section>
      <ol className="tracks" aria-label="Tracks">
        <li className="track heading" aria-hidden="true">
          <span>#</span>
          <span>Title</span>
          <span>Source</span>
          <span>
            <Clock3 />
          </span>
        </li>
        {tracks.map((track, index) => {
          const active = playingHere && player.index === index;
          return (
            <li key={track.id} className={`track ${active ? "active" : ""}`}>
              <button
                type="button"
                className="trackPlay"
                onClick={() => (active ? player.toggle() : player.playQueue(queue, index))}
                aria-label={active && player.playing ? `Pause ${track.title}` : `Play ${track.title}`}
                aria-current={active ? "true" : undefined}
              >
                <span className="trackNumber">
                  {active && player.playing ? (
                    <Pause aria-hidden="true" />
                  ) : (
                    <>
                      <span className="number">{discs > 1 && track.disc ? `${track.disc}.` : ""}{track.number ?? index + 1}</span>
                      <Play aria-hidden="true" className="hoverPlay" />
                    </>
                  )}
                </span>
                <span className="trackTitle">
                  <b>{track.title}</b>
                  {track.artist && track.artist !== album.artist && <small>{track.artist}</small>}
                </span>
                <span className="trackQuality">{quality(track)}</span>
                <span className="trackDuration">{formatDuration(track.duration)}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
