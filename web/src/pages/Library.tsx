import { Heart, ListMusic, Search, UserRound, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  artistPageSchema,
  artworkURL,
  errorMessage,
  isAbort,
  libraryPageSchema,
  librarySorts,
  playlistsSchema,
  request,
  type Album,
  type LibrarySort,
} from "../api.ts";
import { useResource } from "../hooks.ts";
import { Link, navigate, useLocation } from "../router.tsx";
import { ArtSkeleton, Artwork, ErrorBox, SectionState, Title, formatDuration } from "../ui.tsx";

export type LibraryView = "albums" | "artists" | "playlists";
const PAGE = 60;
const ARTIST_PAGE = 100;
const sortLabels: Record<LibrarySort, string> = { title: "Title", artist: "Artist", year: "Newest year", added: "Recently added" };
const views: Array<{ id: LibraryView; label: string; to: string }> = [
  { id: "albums", label: "Albums", to: "/library" },
  { id: "artists", label: "Artists", to: "/library/artists" },
  { id: "playlists", label: "Playlists", to: "/library/playlists" },
];
const notConnected = new Set(["plex_not_connected", "plex_not_configured", "plex_reconnect", "plex_wrong_server"]);

export function LibraryPage({ view }: { view: LibraryView }) {
  return (
    <div className="page libraryPage">
      <header className="collectionHeader">
        <span className="eyebrow">Collected, not just saved</span>
        <h1 tabIndex={-1}>Your library</h1>
        <p>The records you come back to. All together, all yours.</p>
      </header>
      <nav className="tabs" aria-label="Library views">
        {views.map((entry) => (
          <Link key={entry.id} to={entry.to} current={entry.id === view}>
            {entry.label}
          </Link>
        ))}
      </nav>
      {view === "albums" ? <Albums /> : view === "artists" ? <Artists /> : <Playlists />}
    </div>
  );
}

/** Library errors that only Settings can fix get a link there instead of a pointless retry. */
function ConnectionState({ code, message }: { code: string | null; message: string }) {
  return (
    <div className="state">
      <ErrorBox message={message} />
      {code && notConnected.has(code) && (
        <p>
          <Link to="/settings">Open Settings → Connections</Link>
        </p>
      )}
    </div>
  );
}

function Albums() {
  const { query } = useLocation();
  const q = query.get("q")?.trim() ?? "";
  const sortParameter = query.get("sort");
  const sort = librarySorts.find((value) => value === sortParameter) ?? "title";
  const artistID = query.get("artist") ?? "";
  const artistName = query.get("name") ?? "this artist";
  const favorites = query.get("favorites") === "1";
  const [draft, setDraft] = useState(q);
  useEffect(() => setDraft(q), [q]);

  const filter = new URLSearchParams();
  if (q) filter.set("q", q);
  if (sort !== "title") filter.set("sort", sort);
  if (artistID) filter.set("artist", artistID);
  if (favorites) filter.set("favorites", "1");
  const key = filter.toString();
  const first = useResource(
    (signal) => request(`/library?limit=${PAGE}&${key}`, libraryPageSchema, { signal }),
    [key],
  );
  const paged = useMorePages(key, first.data, (offset, signal) =>
    request(`/library?limit=${PAGE}&offset=${offset}&${key}`, libraryPageSchema, { signal }),
  );
  const { items, total } = paged;
  const go = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(filter);
    if (artistID) next.set("name", artistName);
    for (const [name, value] of Object.entries(changes)) {
      if (value === null) next.delete(name);
      else next.set(name, value);
    }
    const search = next.toString();
    navigate(search ? `/library?${search}` : "/library");
  };
  function submit(event: FormEvent) {
    event.preventDefault();
    go({ q: draft.trim() || null });
  }

  const describe = artistID ? `albums by ${artistName}` : favorites ? "favourite albums" : "albums";
  return (
    <>
      <Title text={artistID ? `Albums by ${artistName}` : "Library"} />
      <header className="top">
        <div>
          <h2>{artistID ? artistName : favorites ? "Favourite albums" : "All albums"}</h2>
          <p>
            {first.data
              ? `${total} ${total === 1 ? describe.replace("albums", "album") : describe}${q ? ` matching “${q}”` : ""}.`
              : "Your Plex albums."}
          </p>
        </div>
        <form className="search" role="search" onSubmit={submit}>
          <Search aria-hidden="true" />
          <input
            type="search"
            aria-label="Filter albums by title"
            placeholder="Filter albums by title"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            maxLength={200}
          />
        </form>
      </header>
      <div className="toolbar libraryTools">
        <label className="inlineField">
          <span>Sort</span>
          <select value={sort} onChange={(event) => go({ sort: event.target.value === "title" ? null : event.target.value })}>
            {librarySorts.map((value) => (
              <option key={value} value={value}>
                {sortLabels[value]}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className={`secondary ${favorites ? "selectedFilter" : ""}`} aria-pressed={favorites} onClick={() => go({ favorites: favorites ? null : "1" })}>
          <Heart aria-hidden="true" /> Favourites
        </button>
        {artistID && (
          <button type="button" className="secondary" onClick={() => go({ artist: null, name: null })}>
            <X aria-hidden="true" /> All artists
          </button>
        )}
      </div>
      {first.error && !first.data ? (
        <ConnectionState code={first.code} message={first.error} />
      ) : (
        <SectionState
          loading={first.loading}
          error={first.error}
          empty={!items.length}
          retry={first.reload}
          stale
          emptyTitle={q || artistID || favorites ? "No matches" : "Your library is empty"}
          emptyText={
            q ? (
              "No album titles match that filter. To find an artist, open Artists."
            ) : favorites ? (
              "Mark albums as favourites with the heart on an album page."
            ) : (
              <>
                Albums in your Plex music library appear here. <Link to="/settings">Check your Plex sign-in</Link>.
              </>
            )
          }
          skeleton={<ArtSkeleton />}
        >
          <AlbumGrid items={items} />
          <ShowMore paged={paged} noun="albums" />
        </SectionState>
      )}
    </>
  );
}

type Paged<T> = {
  items: T[];
  total: number;
  more: { pending: boolean; error: string };
  loadMore: () => Promise<void>;
};

/** "Show more" pages after a first page. A new filter discards pages loaded for the old one, even in flight. */
function useMorePages<T>(
  key: string,
  first: { items: T[]; total: number } | null,
  page: (offset: number, signal: AbortSignal) => Promise<{ items: T[] }>,
): Paged<T> {
  const [extra, setExtra] = useState<T[]>([]);
  const [more, setMore] = useState<{ pending: boolean; error: string }>({ pending: false, error: "" });
  const loading = useRef<AbortController | null>(null);
  useEffect(() => {
    loading.current?.abort();
    setExtra([]);
    setMore({ pending: false, error: "" });
    return () => loading.current?.abort();
  }, [key, first]);
  const items = [...(first?.items ?? []), ...extra];
  async function loadMore() {
    if (!first || more.pending) return;
    const controller = new AbortController();
    loading.current = controller;
    setMore({ pending: true, error: "" });
    try {
      const next = await page(items.length, controller.signal);
      if (controller.signal.aborted) return;
      setExtra((previous) => [...previous, ...next.items]);
      setMore({ pending: false, error: "" });
    } catch (cause) {
      if (isAbort(cause) || controller.signal.aborted) return;
      setMore({ pending: false, error: errorMessage(cause) });
    }
  }
  return { items, total: first?.total ?? 0, more, loadMore };
}

/** Stays mounted while loading, so keyboard focus stays on it. */
function ShowMore<T>({ paged, noun }: { paged: Paged<T>; noun: string }) {
  const { items, total, more, loadMore } = paged;
  if (items.length >= total) return null;
  return (
    <div className="loadMore">
      {more.error && <ErrorBox message={more.error} />}
      <button type="button" className="secondary" aria-busy={more.pending} aria-disabled={more.pending} onClick={() => void loadMore()}>
        {more.pending ? `Loading more ${noun}…` : `Show more (${total - items.length} left)`}
      </button>
    </div>
  );
}

function AlbumGrid({ items }: { items: Album[] }) {
  return (
    <ul className="artGrid">
      {items.map((album) => (
        <li key={album.id}>
          <Link to={`/albums/${encodeURIComponent(album.id)}`} className={`artCard ${album.available ? "" : "trashed"}`}>
            <Artwork sources={album.hasArtwork ? [artworkURL(album.id, "medium")] : []} />
            {!album.available && <span className="artBadge trashed">In Plex's trash</span>}
            {album.favorite && (
              <span className="artBadge favorite" aria-label="Favourite">
                <Heart aria-hidden="true" />
              </span>
            )}
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
  );
}

export function RecentlyAdded() {
  const recent = useResource((signal) => request("/library?limit=6&sort=added", libraryPageSchema, { signal }), []);
  if (!recent.data?.items.length) return null;
  return (
    <section className="shelf" aria-labelledby="recent-heading">
      <div className="shelfHead">
        <h2 id="recent-heading">Recently added</h2>
        <Link to="/library?sort=added">See all</Link>
      </div>
      <AlbumGrid items={recent.data.items} />
    </section>
  );
}

function Artists() {
  const { query } = useLocation();
  const q = query.get("q")?.trim() ?? "";
  const [draft, setDraft] = useState(q);
  useEffect(() => setDraft(q), [q]);
  const artists = useResource(
    (signal) => request(`/library/artists?limit=${ARTIST_PAGE}&q=${encodeURIComponent(q)}`, artistPageSchema, { signal }),
    [q],
  );
  const paged = useMorePages(q, artists.data, (offset, signal) =>
    request(`/library/artists?limit=${ARTIST_PAGE}&offset=${offset}&q=${encodeURIComponent(q)}`, artistPageSchema, { signal }),
  );
  const { items } = paged;
  const count = artists.data?.total ?? 0;
  const noun = count === 1 ? "album artist" : "album artists";
  function submit(event: FormEvent) {
    event.preventDefault();
    const value = draft.trim();
    navigate(value ? `/library/artists?q=${encodeURIComponent(value)}` : "/library/artists");
  }
  return (
    <>
      <Title text="Artists" />
      <header className="top">
        <div>
          <h2>Artists</h2>
          <p>
            {!artists.data ? "Album artists in your library." : q ? `${count} ${noun} matching “${q}”.` : `${count} ${noun} in your library.`}
          </p>
        </div>
        <form className="search" role="search" onSubmit={submit}>
          <Search aria-hidden="true" />
          <input
            type="search"
            aria-label="Find an artist"
            placeholder="Find an artist"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            maxLength={200}
          />
        </form>
      </header>
      {artists.error && !artists.data ? (
        <ConnectionState code={artists.code} message={artists.error} />
      ) : (
        <SectionState
          loading={artists.loading}
          error={artists.error}
          empty={!items.length}
          retry={artists.reload}
          stale
          emptyTitle={q ? "No matches" : "No artists yet"}
          emptyText={q ? "No album artist matches that name." : "Album artists in your Plex library appear here."}
        >
          <ul className="artistList">
            {items.map((artist) => (
              <li key={artist.id}>
                <Link to={`/library?artist=${encodeURIComponent(artist.id)}&name=${encodeURIComponent(artist.name)}`} className="artistRow">
                  {artist.hasArtwork ? <Artwork sources={[artworkURL(artist.id, "small")]} className="round" /> : <UserRound aria-hidden="true" />}
                  <span>
                    <b>{artist.name}</b>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          <ShowMore paged={paged} noun="artists" />
        </SectionState>
      )}
    </>
  );
}

function Playlists() {
  const playlists = useResource((signal) => request("/playlists", playlistsSchema, { signal }), []);
  const items = playlists.data?.items ?? [];
  return (
    <>
      <Title text="Playlists" />
      <header className="top">
        <div>
          <h2>Playlists</h2>
          <p>Your Plex music playlists.</p>
        </div>
      </header>
      {playlists.error && !playlists.data ? (
        <ConnectionState code={playlists.code} message={playlists.error} />
      ) : (
        <SectionState
          loading={playlists.loading}
          error={playlists.error}
          empty={!items.length}
          retry={playlists.reload}
          stale
          emptyTitle="No playlists yet"
          emptyText="Add tracks to a playlist from an album page, or create playlists in Plex or Plexamp."
        >
          <ul className="artistList">
            {items.map((playlist) => (
              <li key={playlist.id}>
                <Link to={`/playlists/${encodeURIComponent(playlist.id)}`} className="artistRow">
                  {playlist.hasArtwork ? <Artwork sources={[artworkURL(playlist.id, "small")]} /> : <ListMusic aria-hidden="true" />}
                  <span>
                    <b>{playlist.name}</b>
                    <small>
                      {[
                        playlist.smart ? "Smart playlist" : "",
                        playlist.tracks === null ? "" : `${playlist.tracks} ${playlist.tracks === 1 ? "track" : "tracks"}`,
                        playlist.duration ? formatDuration(playlist.duration) : "",
                      ]
                        .filter((part) => part)
                        .join(" · ")}
                    </small>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </SectionState>
      )}
    </>
  );
}
