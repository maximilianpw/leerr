import { Search } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { artworkURL, isAbort, errorMessage, libraryPageSchema, request, type Album } from "../api.ts";
import { Link, navigate, useLocation } from "../router.tsx";
import { ArtSkeleton, Artwork, ErrorBox, SectionState, Spinner } from "../ui.tsx";

const PAGE = 60;
type Loaded = { items: Album[]; total: number };
// Survives navigating into an album and back, per filter.
const cache = new Map<string, Loaded>();

export function LibraryPage() {
  const { query } = useLocation();
  const q = query.get("q")?.trim() ?? "";
  const [draft, setDraft] = useState(q);
  const [loaded, setLoaded] = useState<Loaded | null>(cache.get(q) ?? null);
  const [loading, setLoading] = useState(!cache.has(q));
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const [more, setMore] = useState<{ pending: boolean; error: string }>({ pending: false, error: "" });

  useEffect(() => setDraft(q), [q]);
  useEffect(() => {
    const cached = cache.get(q);
    setLoaded(cached ?? null);
    if (cached && version === 0) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError("");
    request(`/library?limit=${PAGE}&q=${encodeURIComponent(q)}`, libraryPageSchema, { signal: controller.signal })
      .then((page) => {
        cache.set(q, page);
        setLoaded(page);
      })
      .catch((cause: Error) => {
        if (!isAbort(cause)) setError(errorMessage(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [q, version]);

  async function loadMore() {
    if (!loaded || more.pending) return;
    setMore({ pending: true, error: "" });
    try {
      const page = await request(`/library?limit=${PAGE}&offset=${loaded.items.length}&q=${encodeURIComponent(q)}`, libraryPageSchema);
      const next = { items: [...loaded.items, ...page.items], total: page.total };
      cache.set(q, next);
      setLoaded(next);
      setMore({ pending: false, error: "" });
    } catch (cause) {
      setMore({ pending: false, error: errorMessage(cause) });
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const value = draft.trim();
    navigate(value ? `/library?q=${encodeURIComponent(value)}` : "/library");
  }

  const items = loaded?.items ?? [];
  const total = loaded?.total ?? 0;
  return (
    <div className="page">
      <header className="top">
        <div>
          <h1 tabIndex={-1}>Library</h1>
          <p>{loaded ? `${total} ${total === 1 ? "album" : "albums"}${q ? ` matching “${q}”` : " in your Jellyfin library"}.` : "Your Jellyfin albums."}</p>
        </div>
        <form className="search" role="search" onSubmit={submit}>
          <Search aria-hidden="true" />
          <input
            type="search"
            aria-label="Filter your library"
            placeholder="Filter your library"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            maxLength={200}
          />
        </form>
      </header>
      <SectionState
        loading={loading}
        error={error}
        empty={!items.length}
        retry={() => setVersion((value) => value + 1)}
        emptyTitle={q ? "No matches" : "Your library is empty"}
        emptyText={
          q ? (
            "No album titles match that filter."
          ) : (
            <>
              Albums in your Jellyfin library appear here. <Link to="/settings">Check your Jellyfin connection</Link>.
            </>
          )
        }
        skeleton={<ArtSkeleton />}
      >
        <ul className="artGrid">
          {items.map((album) => (
            <li key={album.id}>
              <Link to={`/albums/${encodeURIComponent(album.id)}`} className="artCard">
                <Artwork sources={[artworkURL(album.id)]} />
                <span className="artMeta">
                  <b>{album.title}</b>
                  <small>
                    {album.artist}
                    {album.year ? ` · ${album.year}` : ""}
                  </small>
                </span>
              </Link>
            </li>
          ))}
        </ul>
        {items.length < total && (
          <div className="loadMore">
            {more.error && <ErrorBox message={more.error} />}
            {more.pending ? (
              <Spinner label="Loading more albums…" />
            ) : (
              <button type="button" className="secondary" onClick={() => void loadMore()}>
                Show more ({total - items.length} left)
              </button>
            )}
          </div>
        )}
      </SectionState>
    </div>
  );
}
