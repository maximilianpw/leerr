import { ArrowLeft, Check, ChevronRight, Disc3, RefreshCw, Search, UserRound, UsersRound, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  candidatePageSchema,
  coverArtURL,
  editionsSchema,
  recommendationsSchema,
  request,
  requestCreatedSchema,
  searchSchema,
  type Candidate,
} from "../api.ts";
import { useAction, useResource } from "../hooks.ts";
import { Link, navigate, useLocation } from "../router.tsx";
import { ArtSkeleton, Artwork, ErrorBox, SectionState, Spinner } from "../ui.tsx";

type Filter = "all" | "artists" | "albums";
const PAGE = 25;

export function DiscoverPage({ artistID }: { artistID: string | null }) {
  const { query } = useLocation();
  const q = query.get("q")?.trim() ?? "";
  const [draft, setDraft] = useState(q);
  const [filter, setFilter] = useState<Filter>("all");
  const [selected, setSelected] = useState<Candidate | null>(null);
  useEffect(() => setDraft(q), [q]);

  function submit(event: FormEvent) {
    event.preventDefault();
    const value = draft.trim();
    setFilter("all");
    navigate(value ? `/discover?q=${encodeURIComponent(value)}` : "/discover");
  }

  const title = artistID ? (query.get("name") ?? "Artist") : q ? `Results for “${q}”` : "Discover";
  const intro = artistID
    ? "Albums from MusicBrainz. Choose one to pick an edition and request it."
    : q
      ? "Artists and albums from MusicBrainz matching every word."
      : "Suggestions based on your Last.fm listening, minus what you already have or requested.";

  return (
    <div className="page">
      <header className="top">
        <div>
          <h1 tabIndex={-1}>{title}</h1>
          <p>{intro}</p>
        </div>
        <form className="search" role="search" onSubmit={submit}>
          <Search aria-hidden="true" />
          <input
            type="search"
            aria-label="Search artists and albums"
            placeholder="Search artists and albums"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            maxLength={200}
          />
        </form>
      </header>
      {artistID ? (
        <ArtistAlbums artistID={artistID} offset={Number(query.get("offset") ?? 0) || 0} onSelect={setSelected} />
      ) : q ? (
        <SearchResults q={q} filter={filter} setFilter={setFilter} onSelect={setSelected} />
      ) : (
        <Recommendations onSelect={setSelected} />
      )}
      {selected && <EditionDialog item={selected} close={() => setSelected(null)} />}
    </div>
  );
}

function SearchResults({
  q,
  filter,
  setFilter,
  onSelect,
}: {
  q: string;
  filter: Filter;
  setFilter: (filter: Filter) => void;
  onSelect: (item: Candidate) => void;
}) {
  const results = useResource((signal) => request(`/discover/search?q=${encodeURIComponent(q)}`, searchSchema, { signal }), [q]);
  const albums = results.data?.items ?? [];
  const artists = results.data?.artists ?? [];
  const showArtists = filter !== "albums" && artists.length > 0;
  const showAlbums = filter !== "artists" && albums.length > 0;
  return (
    <>
      <div className="segmented" role="group" aria-label="Show">
        {(["all", "artists", "albums"] as const).map((value) => (
          <button type="button" key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>
            {value === "all" ? "All" : value === "artists" ? `Artists (${artists.length})` : `Albums (${albums.length})`}
          </button>
        ))}
      </div>
      <SectionState
        loading={results.loading}
        error={results.error}
        empty={!showArtists && !showAlbums}
        retry={results.reload}
        emptyTitle="No matches"
        emptyText="Nothing matched every word. Try fewer words, or just the artist's name."
        skeleton={<ArtSkeleton />}
      >
        {showArtists && (
          <section aria-labelledby="artists-heading" className="artistList">
            <h2 id="artists-heading">Artists</h2>
            {artists.map((artist) => (
              <Link
                key={artist.id}
                to={`/discover/artists/${artist.id}?name=${encodeURIComponent(artist.name)}`}
                className="artistRow"
              >
                {artist.type === "Group" ? <UsersRound aria-hidden="true" /> : <UserRound aria-hidden="true" />}
                <span>
                  <b>{artist.name}</b>
                  <small>
                    {[artist.disambiguation, artist.type, artist.country].filter((part) => part).join(" · ") ||
                      "MusicBrainz artist"}
                  </small>
                </span>
                <ChevronRight aria-hidden="true" />
              </Link>
            ))}
          </section>
        )}
        {showAlbums && (
          <section aria-labelledby="albums-heading">
            <h2 id="albums-heading">Albums</h2>
            <CandidateGrid items={albums} onSelect={onSelect} />
            {(results.data?.total ?? 0) > albums.length && (
              <p className="muted small">Showing the best {albums.length} matches. Add words or open an artist to see more.</p>
            )}
          </section>
        )}
      </SectionState>
    </>
  );
}

function ArtistAlbums({ artistID, offset, onSelect }: { artistID: string; offset: number; onSelect: (item: Candidate) => void }) {
  const { query } = useLocation();
  const page = useResource(
    (signal) => request(`/discover/artists/${encodeURIComponent(artistID)}/albums?offset=${offset}`, candidatePageSchema, { signal }),
    [artistID, offset],
  );
  const items = page.data?.items ?? [];
  const total = page.data?.total ?? 0;
  const go = (next: number) => {
    const target = new URLSearchParams(query);
    target.set("offset", String(next));
    navigate(`/discover/artists/${artistID}?${target.toString()}`);
  };
  return (
    <>
      <button type="button" className="back" onClick={() => history.back()}>
        <ArrowLeft aria-hidden="true" /> Back
      </button>
      <SectionState
        loading={page.loading}
        error={page.error}
        empty={!items.length}
        retry={page.reload}
        emptyText="MusicBrainz lists no albums for this artist."
        skeleton={<ArtSkeleton />}
      >
        <CandidateGrid items={items} onSelect={onSelect} />
        {total > PAGE && (
          <nav className="pager" aria-label="Pages">
            <button type="button" className="secondary" disabled={offset === 0} onClick={() => go(Math.max(0, offset - PAGE))}>
              Previous
            </button>
            <span>
              {offset + 1}–{offset + items.length} of {total}
            </span>
            <button
              type="button"
              className="secondary"
              disabled={offset + items.length >= total || offset >= 10_000}
              onClick={() => go(offset + PAGE)}
            >
              Next
            </button>
          </nav>
        )}
      </SectionState>
    </>
  );
}

function Recommendations({ onSelect }: { onSelect: (item: Candidate) => void }) {
  const [refresh, setRefresh] = useState(0);
  const result = useResource(
    (signal) => request(`/discover/recommendations${refresh ? "?refresh=1" : ""}`, recommendationsSchema, { signal }),
    [refresh],
  );
  const empty =
    result.data?.emptyReason === "all_excluded"
      ? "You already have or requested every suggestion. Search for something new."
      : result.data?.source === "lastfm"
        ? "Last.fm had no suggestions from your recent listening. Try searching instead."
        : "Connect Last.fm in Settings for personal suggestions, or search above.";
  return (
    <>
      <div className="toolbar">
        <p className="muted small">
          {result.data?.source === "lastfm" ? "From artists similar to your Last.fm favourites." : "Recent albums on MusicBrainz."}{" "}
          {result.data?.source !== "lastfm" && <Link to="/settings">Connect Last.fm</Link>}
        </p>
        <button type="button" className="secondary" onClick={() => setRefresh((value) => value + 1)} disabled={result.loading}>
          <RefreshCw aria-hidden="true" className={result.loading ? "spin" : ""} /> Refresh
        </button>
      </div>
      <SectionState
        loading={result.loading}
        error={result.error}
        empty={!result.data?.items.length}
        retry={result.reload}
        emptyText={empty}
        skeleton={<ArtSkeleton />}
      >
        <CandidateGrid items={result.data?.items ?? []} onSelect={onSelect} />
      </SectionState>
    </>
  );
}

function CandidateGrid({ items, onSelect }: { items: Candidate[]; onSelect: (item: Candidate) => void }) {
  return (
    <ul className="artGrid">
      {items.map((item) => (
        <li key={item.id}>
          <button type="button" className="artCard" onClick={() => onSelect(item)}>
            <Artwork sources={[item.coverUrl ?? "", coverArtURL("release-group", item.id)]} />
            {item.status && (
              <span className={`artBadge ${item.status}`}>{item.status === "available" ? "In library" : "Requested"}</span>
            )}
            <span className="artMeta">
              <b>{item.title}</b>
              <small>
                {item.artist}
                {item.year ? ` · ${item.year}` : ""}
              </small>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function EditionDialog({ item, close }: { item: Candidate; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const editions = useResource(
    (signal) => request(`/discover/release-groups/${encodeURIComponent(item.id)}/editions`, editionsSchema, { signal }),
    [item.id],
  );
  const [choice, setChoice] = useState("");
  const [result, setResult] = useState<{ sharedEdition: boolean } | null>(null);
  const action = useAction();
  const chosen = choice || editions.data?.items[0]?.id || "";

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  const confirm = () =>
    void action.run(async () => {
      const created = await request("/requests", requestCreatedSchema, {
        method: "POST",
        body: JSON.stringify({ releaseGroupMBID: item.id, releaseMBID: chosen, artistMBID: item.artistMBID }),
      });
      setResult({ sharedEdition: created.sharedEdition });
    });

  return (
    <dialog ref={dialog} className="modal" aria-labelledby="edition-title" onClose={close}>
      <button type="button" className="iconButton modalClose" aria-label="Close" onClick={() => dialog.current?.close()}>
        <X aria-hidden="true" />
      </button>
      {result ? (
        <div className="success" role="status">
          <Check aria-hidden="true" />
          <h2 id="edition-title">Requested</h2>
          <p>
            {result.sharedEdition
              ? "Someone already requested a different edition of this album. You'll get that one, and it's tracked in your requests."
              : "Leerr will send it to Lidarr and show progress under Requests."}
          </p>
          <div className="actions">
            <Link to="/requests" className="primary">
              View requests
            </Link>
            <button type="button" className="secondary" onClick={() => dialog.current?.close()}>
              Keep browsing
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="editionHead">
            <Artwork sources={[item.coverUrl ?? "", coverArtURL("release-group", item.id)]} />
            <div>
              <h2 id="edition-title">{item.title}</h2>
              <p className="muted">
                {item.artist}
                {item.year ? ` · ${item.year}` : ""}
              </p>
            </div>
          </div>
          {item.status === "available" ? (
            <p className="notice">This album is already in your library.</p>
          ) : item.status === "requested" ? (
            <p className="notice">You've already requested this album.</p>
          ) : null}
          <fieldset className="editions">
            <legend>Choose an edition</legend>
            {editions.loading ? (
              <Spinner label="Loading editions…" />
            ) : editions.error ? (
              <ErrorBox message={editions.error} retry={editions.reload} />
            ) : !editions.data?.items.length ? (
              <p className="muted">MusicBrainz lists no editions for this album yet.</p>
            ) : (
              editions.data.items.map((edition) => (
                <label key={edition.id} className={chosen === edition.id ? "selected" : ""}>
                  <input
                    type="radio"
                    name="edition"
                    value={edition.id}
                    checked={chosen === edition.id}
                    onChange={() => setChoice(edition.id)}
                  />
                  <Disc3 aria-hidden="true" />
                  <span>
                    <b>{edition.title}</b>
                    <small>
                      {[edition.date, edition.country, edition.formats, edition.tracks ? `${edition.tracks} tracks` : ""]
                        .filter((part) => part)
                        .join(" · ") || "No details"}
                    </small>
                  </span>
                </label>
              ))
            )}
          </fieldset>
          {action.error && <ErrorBox message={action.error} />}
          <button
            type="button"
            className="primary wide"
            disabled={!chosen || action.pending || item.status === "available"}
            onClick={confirm}
          >
            {action.pending ? "Requesting…" : "Request this edition"}
          </button>
        </>
      )}
    </dialog>
  );
}
