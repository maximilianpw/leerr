import { ArrowLeft, ArrowRight, Check, ChevronRight, Disc3, RefreshCw, Search, UserRound, UsersRound, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  albumTypes,
  artistAlbumsSchema,
  coverArtURL,
  editionsSchema,
  newReleasesSchema,
  recommendationsSchema,
  request,
  requestCreatedSchema,
  searchSchema,
  type AlbumType,
  type Candidate,
  type Edition,
} from "../api.ts";
import { useAction, useResource } from "../hooks.ts";
import { goBack, Link, navigate, useLocation } from "../router.tsx";
import { ArtSkeleton, Artwork, ErrorBox, SectionState, Spinner, Title } from "../ui.tsx";
import { RecentlyAdded } from "./Library.tsx";

type Filter = "all" | "artists" | "albums";
const typeLabels: Record<AlbumType, string> = { studio: "Studio albums", ep: "EPs", live: "Live", compilation: "Compilations", all: "Everything" };

export function DiscoverPage({ artistID }: { artistID: string | null }) {
  const { query } = useLocation();
  const q = query.get("q")?.trim() ?? "";
  const [draft, setDraft] = useState(q);
  const [filter, setFilter] = useState<Filter>("all");
  const [selected, setSelected] = useState<Candidate | null>(null);
  // Requests made here, so every grid on the page shows them at once.
  const [requested, setRequested] = useState<Set<string>>(new Set());
  useEffect(() => setDraft(q), [q]);

  function submit(event: FormEvent) {
    event.preventDefault();
    const value = draft.trim();
    setFilter("all");
    navigate(value ? `/discover?q=${encodeURIComponent(value)}` : "/discover");
  }
  const typeParameter = query.get("type");
  const type = albumTypes.find((value) => value === typeParameter) ?? "studio";
  const offset = Number(query.get("offset") ?? 0) || 0;
  const title = artistID ? (query.get("name") ?? "Artist") : q ? `Results for “${q}”` : "Discover";
  const intro = artistID
    ? "Releases from MusicBrainz. Choose one to pick an edition and request it."
    : q
      ? "Artists and albums from MusicBrainz matching every word."
      : "A new favourite is waiting to be found.";
  const mark = (items: Candidate[]) =>
    items.map((item) => (requested.has(item.id) && !item.status ? { ...item, status: "requested" as const } : item));
  const grid = { onSelect: setSelected, mark };

  return (
    <div className="page">
      <Title text={title} />
      <header className="top">
        <div>
          <span className="eyebrow">Explore your next obsession</span>
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
      {/* Keyed per query: a new search starts from a skeleton, never under the old results. */}
      {artistID ? (
        <ArtistAlbums key={artistID} artistID={artistID} type={type} offset={offset} {...grid} />
      ) : q ? (
        <SearchResults key={q} q={q} filter={filter} setFilter={setFilter} {...grid} />
      ) : (
        <>
          <Recommendations {...grid} />
          <RecentlyAdded />
          <NewReleases {...grid} />
          <div className="discoveryGuide">
            <Disc3 aria-hidden="true" />
            <div><h2>Find it. Make it yours.</h2><p>Search an album, choose your edition, and follow it all the way to your Plex library.</p></div>
            <Link to="/requests">Follow your requests <ArrowRight aria-hidden="true" /></Link>
          </div>
        </>
      )}
      {selected && (
        <EditionDialog
          item={mark([selected])[0]}
          close={() => setSelected(null)}
          requested={(id) => setRequested((previous) => new Set(previous).add(id))}
        />
      )}
    </div>
  );
}

type GridProps = { onSelect: (item: Candidate) => void; mark: (items: Candidate[]) => Candidate[] };

function SearchResults({ q, filter, setFilter, onSelect, mark }: { q: string; filter: Filter; setFilter: (filter: Filter) => void } & GridProps) {
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
              <Link key={artist.id} to={`/discover/artists/${artist.id}?name=${encodeURIComponent(artist.name)}`} className="artistRow">
                {artist.type === "Group" ? <UsersRound aria-hidden="true" /> : <UserRound aria-hidden="true" />}
                <span>
                  <b>{artist.name}</b>
                  <small>{[artist.disambiguation, artist.type, artist.country].filter((part) => part).join(" · ") || "MusicBrainz artist"}</small>
                </span>
                <ChevronRight aria-hidden="true" />
              </Link>
            ))}
          </section>
        )}
        {showAlbums && (
          <section aria-labelledby="albums-heading">
            <h2 id="albums-heading">Albums</h2>
            <CandidateGrid items={mark(albums)} onSelect={onSelect} />
            {(results.data?.total ?? 0) > albums.length && (
              <p className="muted small">Showing the best {albums.length} matches. Add words or open an artist to see more.</p>
            )}
          </section>
        )}
      </SectionState>
    </>
  );
}

type ArtistPage = { artistID: string; type: AlbumType; offset: number };

/** The release-type control stays mounted (and focused) while each type or page loads below it. */
function ArtistAlbums({ artistID, type, offset, onSelect, mark }: ArtistPage & GridProps) {
  const { query } = useLocation();
  const go = (changes: Record<string, string>) => {
    const target = new URLSearchParams(query);
    for (const [name, value] of Object.entries(changes)) target.set(name, value);
    navigate(`/discover/artists/${artistID}?${target.toString()}`);
  };
  return (
    <>
      <button type="button" className="back" onClick={() => goBack("/discover")}>
        <ArrowLeft aria-hidden="true" /> Back
      </button>
      <div className="segmented" role="group" aria-label="Release type">
        {albumTypes.map((value) => (
          <button type="button" key={value} aria-pressed={type === value} onClick={() => go({ type: value, offset: "0" })}>
            {typeLabels[value]}
          </button>
        ))}
      </div>
      {type !== "studio" && type !== "all" && (
        <p className="muted small">Lidarr only adds these if its metadata profile allows {typeLabels[type].toLowerCase()}.</p>
      )}
      {/* Keyed: a new type or page starts from a skeleton, never under the old results. */}
      <ArtistReleases key={`${type}:${offset}`} artistID={artistID} type={type} offset={offset} go={go} onSelect={onSelect} mark={mark} />
    </>
  );
}

function ArtistReleases({ artistID, type, offset, go, onSelect, mark }: ArtistPage & GridProps & { go: (changes: Record<string, string>) => void }) {
  const page = useResource(
    (signal) =>
      request(`/discover/artists/${encodeURIComponent(artistID)}/albums?type=${type}&offset=${offset}`, artistAlbumsSchema, { signal }),
    [artistID, type, offset],
  );
  const items = page.data?.items ?? [];
  const total = page.data?.total ?? 0;
  const size = page.data?.pageSize ?? 100;
  return (
    <SectionState
      loading={page.loading}
      error={page.error}
      empty={!items.length}
      retry={page.reload}
      emptyText={`MusicBrainz lists no ${typeLabels[type].toLowerCase()} for this artist.`}
      skeleton={<ArtSkeleton />}
    >
      <CandidateGrid items={mark(items)} onSelect={onSelect} showType={type === "all"} />
      {total > size && (
        <nav className="pager" aria-label="Pages">
          <button type="button" className="secondary" disabled={offset === 0} onClick={() => go({ offset: String(Math.max(0, offset - size)) })}>
            Previous
          </button>
          <span>
            {offset + 1}–{offset + items.length} of {total}
          </span>
          <button
            type="button"
            className="secondary"
            disabled={offset + items.length >= total || offset >= 10_000}
            onClick={() => go({ offset: String(offset + size) })}
          >
            Next
          </button>
        </nav>
      )}
    </SectionState>
  );
}

function NewReleases({ onSelect, mark }: GridProps) {
  const releases = useResource((signal) => request("/discover/new-releases", newReleasesSchema, { signal }), []);
  if (!releases.data?.items.length) return null;
  return (
    <section className="shelf" aria-labelledby="new-heading">
      <div className="shelfHead">
        <h2 id="new-heading">New from your artists</h2>
      </div>
      <CandidateGrid items={mark(releases.data.items)} onSelect={onSelect} />
    </section>
  );
}

function Recommendations({ onSelect, mark }: GridProps) {
  const [refresh, setRefresh] = useState(0);
  const result = useResource(
    (signal) => request(`/discover/recommendations${refresh ? "?refresh=1" : ""}`, recommendationsSchema, { signal }),
    [refresh],
  );
  const source = result.data?.source;
  const items = mark(result.data?.items ?? []);
  const spotlight = items[0];
  const empty =
    result.data?.emptyReason === "all_excluded"
      ? "You already have or requested every suggestion. Search for something new."
      : source === "lastfm"
        ? "Last.fm had no suggestions from your recent listening. Try searching instead."
        : source === "library"
          ? "No suggestions from the artists in your library yet. Try searching instead."
          : "Connect Last.fm in Settings for personal suggestions, or search above.";
  return (
    <section className="recommendations" aria-labelledby="suggestions-heading">
      <div className="toolbar">
        <div>
          <h2 id="suggestions-heading">A little outside your rotation</h2>
          <p className="muted small">
            {source === "lastfm"
              ? "From artists similar to your Last.fm favourites."
              : source === "library"
                ? "From artists similar to the ones in your library."
                : "Recent albums on MusicBrainz. "}
            {source === "musicbrainz" && <Link to="/settings">Connect Last.fm for personal suggestions</Link>}
          </p>
        </div>
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
        {spotlight && (
          <div className="discoverySpotlight">
            <div className="spotlightCopy">
              <span className="eyebrow">On your radar</span>
              <h2>{spotlight.title}</h2>
              <p className="spotlightArtist">{spotlight.artist}{spotlight.year ? ` / ${spotlight.year}` : ""}</p>
              <p>Your next great discovery starts with an album.<br />Choose the edition that belongs in your collection.</p>
              <button type="button" className="primary" onClick={() => onSelect(spotlight)}>
                {spotlight.status === "available" ? "In your library" : spotlight.status === "requested" ? "View request" : "Explore album"} <ArrowRight aria-hidden="true" />
              </button>
            </div>
            <button type="button" className="spotlightSleeve" aria-label={`Explore ${spotlight.title} by ${spotlight.artist}`} onClick={() => onSelect(spotlight)}>
              <span className="vinyl" aria-hidden="true" />
              <Artwork sources={[spotlight.coverUrl ?? "", coverArtURL("release-group", spotlight.id)]} />
            </button>
            <span className="spotlightFoot">DISCOVER SOMETHING THAT STAYS WITH YOU</span>
          </div>
        )}
        {items.length > 1 && <CandidateGrid items={items.slice(1)} onSelect={onSelect} />}
      </SectionState>
    </section>
  );
}

function CandidateGrid({ items, onSelect, showType = false }: { items: Candidate[]; onSelect: (item: Candidate) => void; showType?: boolean }) {
  return (
    <ul className="artGrid">
      {items.map((item) => (
        <li key={item.id}>
          <button type="button" className="artCard" onClick={() => onSelect(item)}>
            <Artwork sources={[item.coverUrl ?? "", coverArtURL("release-group", item.id)]} />
            {item.status && <span className={`artBadge ${item.status}`}>{item.status === "available" ? "In library" : "Requested"}</span>}
            <span className="artMeta">
              <b>{item.title}</b>
              <small>
                {item.artist}
                {item.year ? ` · ${item.year}` : ""}
                {showType && item.primaryType ? ` · ${[item.primaryType, ...item.secondaryTypes].join(" + ")}` : ""}
              </small>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Official editions first by date, as the default choice; bootlegs and promos are labelled. */
const defaultEdition = (items: Edition[]) => items.find((edition) => edition.status === "Official") ?? items[0];

function EditionDialog({ item, close, requested }: { item: Candidate; close: () => void; requested: (id: string) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const resultHeading = useRef<HTMLHeadingElement>(null);
  const editions = useResource(
    (signal) => request(`/discover/release-groups/${encodeURIComponent(item.id)}/editions`, editionsSchema, { signal }),
    [item.id],
  );
  const [choice, setChoice] = useState("");
  const [result, setResult] = useState<{ sharedEdition: boolean; alreadyRequested: boolean } | null>(null);
  const action = useAction();
  const chosen = choice || (editions.data ? (defaultEdition(editions.data.items)?.id ?? "") : "");

  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  // The request button disappears on success: focus the outcome so it is read out.
  useEffect(() => {
    if (result) resultHeading.current?.focus();
  }, [result]);

  const confirm = () =>
    void action.run(async () => {
      const created = await request("/requests", requestCreatedSchema, {
        method: "POST",
        body: JSON.stringify({ releaseGroupMBID: item.id, releaseMBID: chosen, artistMBID: item.artistMBID }),
      });
      requested(item.id);
      setResult({ sharedEdition: created.sharedEdition, alreadyRequested: created.alreadyRequested });
    });

  return (
    <dialog ref={dialog} className="modal" aria-labelledby="edition-title" onClose={close}>
      <button type="button" className="iconButton modalClose" aria-label="Close" onClick={() => dialog.current?.close()}>
        <X aria-hidden="true" />
      </button>
      {result ? (
        <div className="success">
          <Check aria-hidden="true" />
          <h2 id="edition-title" tabIndex={-1} ref={resultHeading}>
            {result.alreadyRequested ? "Already requested" : "Requested"}
          </h2>
          <p>
            {result.alreadyRequested
              ? "You requested this album before. Leerr keeps getting the edition you chose first; follow it under Requests."
              : result.sharedEdition
                ? "Someone else already requested a different edition of this album. You'll get that one, and it's tracked in your requests."
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
            <p className="notice">
              This album is already in your library.{" "}
              {item.albumID && <Link to={`/albums/${encodeURIComponent(item.albumID)}`}>Open it</Link>}
            </p>
          ) : item.status === "requested" ? (
            <p className="notice">You've already requested this album. Leerr keeps the edition you chose first.</p>
          ) : null}
          {item.status !== "available" && (
            <fieldset className="editions">
              <legend>Choose an edition</legend>
              {editions.loading ? (
                <Spinner label="Loading editions…" />
              ) : editions.error ? (
                <ErrorBox message={editions.error} retry={editions.reload} />
              ) : !editions.data?.items.length ? (
                <p className="muted">MusicBrainz lists no editions for this album yet.</p>
              ) : (
                <>
                  {editions.data.items.map((edition) => (
                    <label key={edition.id} className={chosen === edition.id ? "selected" : ""}>
                      <input type="radio" name="edition" value={edition.id} checked={chosen === edition.id} onChange={() => setChoice(edition.id)} />
                      <Disc3 aria-hidden="true" />
                      <span>
                        <b>
                          {edition.title}
                          {edition.disambiguation ? <span className="muted"> ({edition.disambiguation})</span> : null}
                          {edition.status && edition.status !== "Official" ? <span className="editionStatus">{edition.status}</span> : null}
                        </b>
                        <small>
                          {[edition.date, edition.country, edition.formats, edition.tracks ? `${edition.tracks} tracks` : ""]
                            .filter((part) => part)
                            .join(" · ") || "No details"}
                        </small>
                      </span>
                    </label>
                  ))}
                  {editions.data.total > editions.data.items.length && (
                    <p className="muted small">
                      Showing {editions.data.items.length} of {editions.data.total} editions.
                    </p>
                  )}
                </>
              )}
            </fieldset>
          )}
          {action.error && <ErrorBox message={action.error} />}
          {item.status !== "available" && (
            <button
              type="button"
              className="primary wide"
              disabled={!chosen || action.pending || item.status === "requested"}
              onClick={confirm}
            >
              {action.pending ? "Requesting…" : item.status === "requested" ? "Already requested" : "Request this edition"}
            </button>
          )}
        </>
      )}
    </dialog>
  );
}
