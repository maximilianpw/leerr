import { ChevronRight, RefreshCw, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import { artworkURL, coverArtURL, errorMessage, request, requestsSchema, send, type RequestItem } from "../api.ts";
import { useResource } from "../hooks.ts";
import { Link } from "../router.tsx";
import { Artwork, ErrorBox, formatRelative, Notice, Progress, SectionState, StatusBadge } from "../ui.tsx";

const inProgress = (item: RequestItem) => item.status === "requested" || item.status === "acquiring" || item.status === "imported";

export function RequestsPage() {
  const requests = useResource((signal) => request("/requests", requestsSchema, { signal }), []);
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

  return (
    <div className="page">
      <header className="top">
        <div>
          <h1 tabIndex={-1}>Requests</h1>
          <p>Follow each album from request to your library.</p>
        </div>
        <button type="button" className="secondary" onClick={reload} disabled={requests.loading}>
          <RefreshCw aria-hidden="true" className={requests.loading ? "spin" : ""} /> Refresh
        </button>
      </header>
      {requests.data && !requests.data.libraryChecked && (
        <Notice>Your Jellyfin library couldn't be checked, so albums that have arrived may not show as ready yet.</Notice>
      )}
      <SectionState
        loading={requests.loading}
        error={requests.error}
        empty={!items.length}
        retry={reload}
        emptyTitle="No requests yet"
        emptyText={
          <>
            Find an album in <Link to="/discover">Discover</Link> and request it.
          </>
        }
      >
        <ul className="requestList">
          {items.map((item) => (
            <RequestRow key={item.id} item={item} retried={reload} />
          ))}
        </ul>
      </SectionState>
    </div>
  );
}

function RequestRow({ item, retried }: { item: RequestItem; retried: () => void }) {
  const [state, setState] = useState<{ pending: boolean; error: string }>({ pending: false, error: "" });
  async function retry() {
    if (state.pending) return;
    setState({ pending: true, error: "" });
    try {
      await send(`/requests/${encodeURIComponent(item.id)}/retry`, "POST");
      setState({ pending: false, error: "" });
      retried();
    } catch (cause) {
      setState({ pending: false, error: errorMessage(cause, "Retry failed.") });
    }
  }
  const cover = item.albumID ? artworkURL(item.albumID) : coverArtURL("release", item.releaseMBID);
  return (
    <li className="requestRow">
      <Artwork sources={[cover, coverArtURL("release-group", item.releaseGroupMBID)]} />
      <div className="requestInfo">
        <b>{item.title}</b>
        <span>{item.artist}</span>
        <Progress status={item.status} />
        {item.reason && <small className={item.retryable ? "reason problem" : "reason"}>{item.reason}</small>}
        {state.error && <ErrorBox message={state.error} />}
      </div>
      <div className="requestAction">
        <StatusBadge status={item.status} />
        <small className="muted">{formatRelative(item.updatedAt)}</small>
        {item.retryable ? (
          <button type="button" className="secondary" onClick={() => void retry()} disabled={state.pending} aria-label={`Retry ${item.title}`}>
            <RotateCcw aria-hidden="true" /> {state.pending ? "Retrying…" : "Retry"}
          </button>
        ) : item.albumID ? (
          <Link to={`/albums/${encodeURIComponent(item.albumID)}`} className="secondary" label={`Open ${item.title}`}>
            Open <ChevronRight aria-hidden="true" />
          </Link>
        ) : null}
      </div>
    </li>
  );
}
