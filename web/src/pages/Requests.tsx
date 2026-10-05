import { ChevronRight, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { useEffect } from "react";
import { artworkURL, connectionsSchema, coverArtURL, request, requestsSchema, send, type RequestItem } from "../api.ts";
import { markRequestsSeen, useAction, useResource } from "../hooks.ts";
import { Link } from "../router.tsx";
import { Artwork, ErrorBox, formatRelative, Notice, Progress, SectionState, StatusBadge, Title } from "../ui.tsx";

// An album in Plex that Plex did not match changes only when someone fixes it there.
const inProgress = (item: RequestItem) =>
  item.status === "requested" || item.status === "acquiring" || (item.status === "imported" && !item.unmatchedAlbumID);

export function RequestsPage() {
  const requests = useResource((signal) => request("/requests", requestsSchema, { signal }), []);
  const connections = useResource((signal) => request("/connections", connectionsSchema, { signal }), []);
  const items = requests.data?.items ?? [];
  const active = items.some(inProgress);
  const { reload } = requests;

  // Poll while something is moving and the tab is visible.
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") reload();
    }, 30_000);
    return () => clearInterval(timer);
  }, [active, reload]);
  // What this page showed no longer counts as news in the navigation badge.
  useEffect(() => {
    if (requests.data) markRequestsSeen(requests.data.items);
  }, [requests.data]);

  const library = requests.data?.library;
  const plex = connections.data;
  const waitingForPlex = items.some((item) => item.status === "imported" && !item.unmatchedAlbumID);
  const unmatched = items.filter((item) => item.unmatchedAlbumID).length;
  return (
    <div className="page">
      <Title text="Requests" />
      <header className="top">
        <div>
          <h1 tabIndex={-1}>Requests</h1>
          <p>Follow each album from request to your library.</p>
        </div>
        <button type="button" className="secondary" onClick={() => !requests.loading && reload()} aria-disabled={requests.loading}>
          <RefreshCw aria-hidden="true" className={requests.loading ? "spin" : ""} /> Refresh
        </button>
      </header>
      {plex && !plex.plex ? (
        <Notice>
          {plex.plexConfigured ? (
            <>
              <Link to="/settings">Sign in with Plex</Link> to play albums and see when requests arrive.
            </>
          ) : (
            "An administrator needs to set up the Plex server before requests can show as ready to play."
          )}
        </Notice>
      ) : plex?.plexValid === false ? (
        <Notice>
          Plex no longer accepts your saved sign-in. <Link to="/settings">Sign in to Plex again</Link> to see which requests have arrived.
        </Notice>
      ) : requests.data && !requests.data.libraryChecked ? (
        <Notice>Your Plex library couldn't be checked, so albums that have arrived may not show as ready yet.</Notice>
      ) : unmatched > 0 ? (
        <Notice>
          {unmatched === 1 ? "One requested album is" : `${unmatched} requested albums are`} in your Plex library, but Plex hasn't matched{" "}
          {unmatched === 1 ? "it" : "them"} to the album that was requested, so {unmatched === 1 ? "it can't show" : "they can't show"} as
          ready. You can already play {unmatched === 1 ? "it" : "them"}. An administrator can fix this with Fix Match in Plex.
        </Notice>
      ) : library && library.unmatched > 0 && waitingForPlex ? (
        <Notice>
          {library.unmatched} of {library.albums} albums in your Plex library aren't matched to MusicBrainz, so Leerr can't tell when some
          requests arrive. An administrator can use Fix Match on them in Plex, or turn on tag writing in Lidarr.
        </Notice>
      ) : null}
      {plex && !plex.lidarrReady && (
        <Notice>Lidarr isn't fully set up yet, so new requests wait until an administrator finishes it.</Notice>
      )}
      <SectionState
        loading={requests.loading}
        error={requests.error}
        empty={!items.length}
        retry={reload}
        stale
        emptyTitle="No requests yet"
        emptyText={
          <>
            Find an album in <Link to="/discover">Discover</Link> and request it.
          </>
        }
      >
        <ul className="requestList">
          {items.map((item) => (
            <RequestRow key={item.id} item={item} changed={reload} />
          ))}
        </ul>
      </SectionState>
    </div>
  );
}

function RequestRow({ item, changed }: { item: RequestItem; changed: () => void }) {
  const retry = useAction();
  const withdraw = useAction();
  const cover = item.albumID ? artworkURL(item.albumID, "small") : coverArtURL("release", item.releaseMBID);
  const playable = item.albumID ?? item.unmatchedAlbumID;
  const remove = () => {
    if (
      !confirm(
        `Withdraw your request for “${item.title}”? Leerr stops following it for you. Lidarr is not changed, so an album it already has or is getting stays there.`,
      )
    )
      return;
    void withdraw.run(async () => {
      await send(`/requests/${encodeURIComponent(item.id)}`, "DELETE");
      changed();
    });
  };
  return (
    <li className="requestRow">
      <Artwork sources={[cover, coverArtURL("release-group", item.releaseGroupMBID)]} />
      <div className="requestInfo">
        <b>{item.title}</b>
        <span>{item.artist}</span>
        <Progress status={item.status} />
        {item.reason && <small className={item.retryable ? "reason problem" : "reason"}>{item.reason}</small>}
        {item.unmatchedAlbumID && <small className="reason">In your Plex library, but Plex hasn't matched it to this album yet.</small>}
        {retry.error && <ErrorBox message={retry.error} />}
        {withdraw.error && <ErrorBox message={withdraw.error} />}
      </div>
      <div className="requestAction">
        <StatusBadge status={item.status} />
        <small className="muted" title={`Requested ${formatRelative(item.requestedAt)}`}>
          {formatRelative(item.updatedAt)}
        </small>
        {item.retryable ? (
          <button
            type="button"
            className="secondary"
            onClick={() =>
              void retry.run(async () => {
                await send(`/requests/${encodeURIComponent(item.id)}/retry`, "POST");
                changed();
              })
            }
            aria-disabled={retry.pending}
            aria-label={`Retry ${item.title}`}
          >
            <RotateCcw aria-hidden="true" /> {retry.pending ? "Retrying…" : "Retry"}
          </button>
        ) : playable ? (
          <Link to={`/albums/${encodeURIComponent(playable)}`} className="secondary" label={`Open ${item.title}`}>
            Open <ChevronRight aria-hidden="true" />
          </Link>
        ) : null}
        {item.status !== "available" && (
          <button
            type="button"
            className="iconButton"
            onClick={() => !withdraw.pending && remove()}
            aria-disabled={withdraw.pending}
            aria-label={`Withdraw request for ${item.title}`}
          >
            <Trash2 aria-hidden="true" />
          </button>
        )}
      </div>
    </li>
  );
}
