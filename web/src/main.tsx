import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { z } from "zod";
import {
  ArrowLeft,
  Check,
  ChevronRight,
  Clock3,
  Compass,
  Disc3,
  Library,
  LoaderCircle,
  LogOut,
  Music2,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import "./styles.css";

const API = "/api/v1";
const userSchema = z.object({
  id: z.string(),
  username: z.string(),
  role: z.enum(["admin", "member"]),
});
const authSchema = z.object({ user: userSchema, csrf: z.string() });
const setupSchema = z.object({
  required: z.boolean(),
  fixturePreview: z.boolean(),
});
const albumItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  artist: z.string(),
  releaseGroupMBID: z.string().nullable(),
  releaseMBID: z.string().nullable(),
});
const librarySchema = z.object({
  items: z.array(albumItemSchema),
  total: z.number(),
});
const trackSchema = z.object({
  id: z.string(),
  title: z.string(),
  artist: z.string(),
  duration: z.number().nullable().optional(),
  sourceCodec: z.string().nullable().optional(),
  sourceSampleRate: z.number().nullable().optional(),
  sourceBitDepth: z.number().nullable().optional(),
});
const albumDetailSchema = z.object({
  album: albumItemSchema,
  tracks: z.array(trackSchema),
});
const resolveItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  artist: z.string(),
  artistMBID: z.string(),
});
const resolveSchema = z.object({ items: z.array(resolveItemSchema) });
const editionSchema = z.object({
  id: z.string(),
  title: z.string(),
  date: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
});
const editionsSchema = z.object({ items: z.array(editionSchema) });
const requestSchema = z.object({
  id: z.string(),
  releaseGroupMBID: z.string(),
  releaseMBID: z.string(),
  title: z.string(),
  artist: z.string(),
  status: z.string(),
  albumID: z.string().nullable().optional(),
});
const requestsSchema = z.object({ items: z.array(requestSchema) });
const connectionsSchema = z.object({
  jellyfinConfigured: z.boolean(),
  jellyfin: z.boolean(),
  lastfm: z.boolean(),
});
const adminSettingsSchema = z.object({
  jellyfinURL: z.string().nullable(),
  lidarrURL: z.string().nullable(),
  lidarrConfigured: z.boolean(),
  rootFolderPath: z.string().nullable().optional(),
  qualityProfileID: z.number().nullable().optional(),
  metadataProfileID: z.number().nullable().optional(),
});
const optionsSchema = z.object({
  roots: z.array(z.object({ id: z.number(), path: z.string() })),
  qualities: z.array(z.object({ id: z.number(), name: z.string() })),
  metadata: z.array(z.object({ id: z.number(), name: z.string() })),
});
const usersSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      username: z.string(),
      role: z.string(),
      disabled: z.boolean(),
    }),
  ),
});
const sessionsSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      expiresAt: z.string(),
      current: z.boolean(),
    }),
  ),
});
type User = z.infer<typeof userSchema>;
type AlbumItem = z.infer<typeof albumItemSchema>;
type ResolveItem = z.infer<typeof resolveItemSchema>;

class ApiError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  csrf?: string,
  init?: RequestInit,
): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body) headers.set("Content-Type", "application/json");
  if (csrf) headers.set("X-CSRF-Token", csrf);
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers,
    credentials: "include",
  });
  const body: unknown =
    response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) {
    const parsed = z
      .object({
        error: z.object({ code: z.string(), message: z.string() }),
      })
      .safeParse(body);
    throw new ApiError(
      parsed.success ? parsed.data.error.code : "unexpected_error",
      parsed.success
        ? parsed.data.error.message
        : "Something went wrong. Please try again.",
    );
  }
  return schema.parse(body);
}
const json = <T,>(value: T): string => JSON.stringify(value);
const artwork = (id: string): string =>
  `${API}/artwork/${encodeURIComponent(id)}`;
const releaseGroupArtwork = (id: string): string =>
  `https://coverartarchive.org/release-group/${encodeURIComponent(id)}/front-500`;
const releaseArtwork = (id: string): string =>
  `https://coverartarchive.org/release/${encodeURIComponent(id)}/front-500`;
const formatDuration = (seconds?: number | null): string =>
  seconds
    ? `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`
    : "—";

type Page = "discover" | "library" | "requests" | "settings";
function App() {
  const [setup, setSetup] = useState<boolean | null>(null);
  const [fixturePreview, setFixturePreview] = useState(false);
  const [auth, setAuth] = useState<z.infer<typeof authSchema> | null>(null);
  const [failure, setFailure] = useState("");
  const [page, setPage] = useState<Page>("discover");
  const [albumID, setAlbumID] = useState<string | null>(null);
  const bootstrap = useCallback(async () => {
    setFailure("");
    try {
      const state = await request("/setup", setupSchema);
      setSetup(state.required);
      setFixturePreview(state.fixturePreview);
      if (!state.required) setAuth(await request("/me", authSchema));
    } catch (error) {
      if (
        error instanceof ApiError &&
        (error.code === "unauthorized" || error.code === "not_authenticated")
      ) {
        setSetup(false);
        setAuth(null);
      } else
        setFailure(
          error instanceof Error ? error.message : "Unable to reach Leerr.",
        );
    }
  }, []);
  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);
  useEffect(() => {
    if (!auth) return;
    let active = true;
    void request("/connections", connectionsSchema)
      .then((state) => {
        if (active && !state.jellyfinConfigured) setPage("settings");
      })
      .catch(() => {
        /* Settings surfaces connection errors when opened. */
      });
    return () => {
      active = false;
    };
  }, [auth]);
  if (setup === null)
    return (
      <Centered>
        <LoaderCircle className="spin" aria-hidden="true" />
        <p>Opening your library…</p>
        {failure && <ErrorBox message={failure} retry={bootstrap} />}
      </Centered>
    );
  if (setup)
    return (
      <>
        {fixturePreview && <FixtureNotice />}
        <Setup
          onDone={() => {
            setSetup(false);
            setAuth(null);
          }}
        />
      </>
    );
  if (!auth)
    return (
      <>
        {fixturePreview && <FixtureNotice />}
        <Login onLogin={setAuth} />
      </>
    );
  const openAlbum = (id: string) => setAlbumID(id);
  return (
    <div className="shell">
      <a className="skip" href="#content">
        Skip to content
      </a>
      <Sidebar
        page={page}
        user={auth.user}
        select={(next) => {
          setPage(next);
          setAlbumID(null);
        }}
        logout={async () => {
          try {
            await request(
              "/sessions/current",
              z.object({}).passthrough(),
              auth.csrf,
              { method: "DELETE" },
            );
            setAuth(null);
          } catch (error) {
            setFailure(
              error instanceof Error ? error.message : "Sign out failed.",
            );
          }
        }}
      />
      {failure && (
        <div className="globalError">
          <ErrorBox message={failure} />
        </div>
      )}
      <main id="content">
        {fixturePreview && <FixtureNotice />}
        {albumID ? (
          <AlbumDetail id={albumID} back={() => setAlbumID(null)} />
        ) : page === "discover" ? (
          <Discover csrf={auth.csrf} open={openAlbum} />
        ) : page === "library" ? (
          <LibraryPage key={auth.user.id} open={openAlbum} />
        ) : page === "requests" ? (
          <Requests csrf={auth.csrf} open={openAlbum} />
        ) : (
          <SettingsPage auth={auth} fixturePreview={fixturePreview} />
        )}
      </main>
      <MobileNav
        page={page}
        select={(next) => {
          setPage(next);
          setAlbumID(null);
        }}
      />
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <main className="centered">{children}</main>;
}
function ErrorBox({ message, retry }: { message: string; retry?: () => void }) {
  return (
    <div className="error" role="alert">
      <span>{message}</span>
      {retry && (
        <button className="textButton" onClick={retry}>
          Try again
        </button>
      )}
    </div>
  );
}
function Brand() {
  return (
    <div className="brand">
      <div className="brandMark">
        <Music2 />
      </div>
      <strong>leerr</strong>
    </div>
  );
}
function AuthFrame({
  title,
  intro,
  children,
}: {
  title: string;
  intro: string;
  children: React.ReactNode;
}) {
  return (
    <div className="auth">
      <section className="authArt">
        <Brand />
        <div>
          <span className="eyebrow">MUSIC DISCOVERY</span>
          <h1>
            Find albums.
            <br />
            Request them.
          </h1>
          <p>
            Discover and request music for your Jellyfin library, then play it
            on your native Leerr apps.
          </p>
        </div>
        <small>One library. Every device.</small>
      </section>
      <section className="authPanel">
        <div className="authCard">
          <div className="authBrand">
            <Brand />
          </div>
          <h2>{title}</h2>
          <p className="muted">{intro}</p>
          {children}
        </div>
      </section>
    </div>
  );
}
function Login({
  onLogin,
}: {
  onLogin: (auth: z.infer<typeof authSchema>) => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      onLogin(
        await request("/sessions", authSchema, undefined, {
          method: "POST",
          body: json({
            username: data.get("username"),
            password: data.get("password"),
            device: "web",
            name: "Browser",
          }),
        }),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Sign in failed.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <AuthFrame title="Welcome back" intro="Sign in to continue to your music.">
      <form onSubmit={submit}>
        <Field label="Username" name="username" autoComplete="username" />
        <Field
          label="Password"
          name="password"
          type="password"
          autoComplete="current-password"
        />
        {error && <ErrorBox message={error} />}
        <button className="primary wide" disabled={busy}>
          {busy ? (
            <LoaderCircle className="spin" aria-hidden="true" />
          ) : (
            "Sign in"
          )}{" "}
          {!busy && <ChevronRight aria-hidden="true" />}
        </button>
      </form>
    </AuthFrame>
  );
}
function Setup({ onDone }: { onDone: () => void }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      await request("/setup", z.object({}).passthrough(), undefined, {
        method: "POST",
        body: json({
          token: data.get("token"),
          username: data.get("username"),
          password: data.get("password"),
        }),
      });
      onDone();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Setup failed.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <AuthFrame
      title="Set up Leerr"
      intro="Create the first administrator account for this server."
    >
      <form onSubmit={submit}>
        <Field label="Setup token" name="token" autoComplete="one-time-code" />
        <Field label="Admin username" name="username" autoComplete="username" />
        <Field
          label="Password"
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={10}
        />
        {error && <ErrorBox message={error} />}
        <button className="primary wide" disabled={busy}>
          {busy ? "Creating…" : "Create administrator"}
        </button>
      </form>
    </AuthFrame>
  );
}
function Field({
  label,
  required = true,
  ...props
}: {
  label: string;
  name: string;
  type?: string;
  autoComplete?: string;
  placeholder?: string;
  minLength?: number;
  required?: boolean;
  defaultValue?: string;
  value?: string;
  onChange?: React.ChangeEventHandler<HTMLInputElement>;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input required={required} {...props} />
    </label>
  );
}
function Sidebar({
  page,
  user,
  select,
  logout,
}: {
  page: Page;
  user: User;
  select: (p: Page) => void;
  logout: () => void;
}) {
  return (
    <aside>
      <Brand />
      <nav aria-label="Primary">
        <NavButton
          icon={<Compass />}
          label="Discover"
          active={page === "discover"}
          onClick={() => select("discover")}
        />
        <NavButton
          icon={<Library />}
          label="Library"
          active={page === "library"}
          onClick={() => select("library")}
        />
        <NavButton
          icon={<Clock3 />}
          label="Requests"
          active={page === "requests"}
          onClick={() => select("requests")}
        />
      </nav>
      <div className="asideBottom">
        <NavButton
          icon={<Settings />}
          label="Settings"
          active={page === "settings"}
          onClick={() => select("settings")}
        />
        <button className="profile" onClick={() => select("settings")}>
          <span className="avatar">
            {user.username.charAt(0).toUpperCase()}
          </span>
          <span>
            <b>{user.username}</b>
            <small>{user.role}</small>
          </span>
        </button>
        <button
          className="iconButton logout"
          aria-label="Sign out"
          onClick={() => void logout()}
        >
          <LogOut />
        </button>
      </div>
    </aside>
  );
}
function NavButton({
  icon,
  label,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={`navButton ${active ? "active" : ""}`}
      aria-current={active ? "page" : undefined}
      onClick={onClick}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}
function MobileNav({
  page,
  select,
}: {
  page: Page;
  select: (p: Page) => void;
}) {
  return (
    <nav className="mobileNav" aria-label="Primary">
      <NavButton
        icon={<Compass />}
        label="Discover"
        active={page === "discover"}
        onClick={() => select("discover")}
      />
      <NavButton
        icon={<Library />}
        label="Library"
        active={page === "library"}
        onClick={() => select("library")}
      />
      <NavButton
        icon={<Clock3 />}
        label="Requests"
        active={page === "requests"}
        onClick={() => select("requests")}
      />
      <NavButton
        icon={<Settings />}
        label="Settings"
        active={page === "settings"}
        onClick={() => select("settings")}
      />
    </nav>
  );
}

function Discover({
  csrf,
  open,
}: {
  csrf: string;
  open: (id: string) => void;
}) {
  const [items, setItems] = useState<ResolveItem[]>([]),
    [query, setQuery] = useState(""),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [selected, setSelected] = useState<ResolveItem | null>(null);
  const load = useCallback(async (q: string) => {
    setLoading(true);
    setError("");
    try {
      setItems(
        (
          await request(
            q ? `/resolve?q=${encodeURIComponent(q)}` : "/recommendations",
            resolveSchema,
          )
        ).items,
      );
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Discovery is unavailable.",
      );
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load("");
  }, [load]);
  function searchSubmit(event: React.FormEvent) {
    event.preventDefault();
    void load(query.trim());
  }
  return (
    <div className="page">
      <header className="top">
        <div>
          <h1>{query ? "Search" : "Discover"}</h1>
          <p>
            {query
              ? "Choose the exact album and edition you want."
              : "Recommendations from your connections."}
          </p>
        </div>
        <form className="search" onSubmit={searchSubmit}>
          <Search />
          <input
            aria-label="Search artists and albums"
            placeholder="Search artists and albums"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <kbd>↵</kbd>
        </form>
      </header>
      <SectionState
        loading={loading}
        error={error}
        empty={!items.length}
        retry={() => void load(query)}
        emptyText={
          query
            ? "No releases matched your search."
            : "Recommendations will appear when discovery services are connected."
        }
        skeleton={<ArtSkeleton />}
      >
        <div className="artGrid">
          {items.map((item) => (
            <button
              className="artCard discover"
              key={item.id}
              title={`${item.title} — ${item.artist}`}
              onClick={() => setSelected(item)}
            >
              <Artwork src={releaseGroupArtwork(item.id)} />
              <span className="artBadge">Album</span>
              <span className="artShade">
                <span className="artCopy">
                  <b>{item.title}</b>
                  <small>{item.artist}</small>
                </span>
                <span className="artCta">Request</span>
              </span>
            </button>
          ))}
        </div>
      </SectionState>
      {selected && (
        <EditionDialog
          item={selected}
          csrf={csrf}
          close={() => setSelected(null)}
          open={open}
        />
      )}
    </div>
  );
}
function Artwork({ id, src }: { id?: string; src?: string }) {
  const [ready, setReady] = useState(false);
  const url = src || (id ? artwork(id) : "");
  return (
    <div className={`artwork${ready ? " ready" : ""}`}>
      {url && (
        <img
          key={url}
          src={url}
          alt=""
          loading="lazy"
          onLoad={(event) => {
            event.currentTarget.hidden = false;
            setReady(true);
          }}
          onError={(event) => {
            event.currentTarget.hidden = true;
            setReady(false);
          }}
        />
      )}
      <Disc3 aria-hidden="true" />
    </div>
  );
}
function ArtSkeleton() {
  return (
    <>
      <p className="sr-only" role="status">
        Loading music…
      </p>
      <div className="artGrid" aria-hidden="true">
        {["a", "b", "c", "d", "e", "f", "g", "h"].map((slot) => (
          <div className="artCard skeleton" key={slot}>
            <div className="artwork" />
            <span className="artShade">
              <span className="artCopy">
                <b />
                <small />
              </span>
            </span>
          </div>
        ))}
      </div>
    </>
  );
}
function SectionState({
  loading,
  error,
  empty,
  retry,
  emptyText,
  children,
  skeleton,
}: {
  loading: boolean;
  error: string;
  empty: boolean;
  retry: () => void;
  emptyText: string;
  children: React.ReactNode;
  skeleton?: React.ReactNode;
}) {
  if (loading)
    return (
      skeleton ?? (
        <div className="state" role="status">
          <LoaderCircle className="spin" aria-hidden="true" />
          <p>Loading music…</p>
        </div>
      )
    );
  if (error)
    return (
      <div className="state">
        <ErrorBox message={error} retry={retry} />
      </div>
    );
  if (empty)
    return (
      <div className="state">
        <Disc3 aria-hidden="true" />
        <h3>Nothing here yet</h3>
        <p>{emptyText}</p>
      </div>
    );
  return <>{children}</>;
}
function EditionDialog({
  item,
  csrf,
  close,
}: {
  item: ResolveItem;
  csrf: string;
  close: () => void;
  open: (id: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [editions, setEditions] = useState<z.infer<typeof editionSchema>[]>([]),
    [selected, setSelected] = useState(""),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [sent, setSent] = useState(false);
  useEffect(() => {
    dialog.current?.showModal();
    request(`/resolve/${encodeURIComponent(item.id)}/editions`, editionsSchema)
      .then((data) => {
        setEditions(data.items);
        if (data.items[0]) setSelected(data.items[0].id);
      })
      .catch((caught: Error) => setError(caught.message))
      .finally(() => setLoading(false));
  }, [item.id]);
  async function confirm() {
    setLoading(true);
    setError("");
    try {
      await request("/requests", z.object({}).passthrough(), csrf, {
        method: "POST",
        body: json({
          releaseGroupMBID: item.id,
          releaseMBID: selected,
          artistMBID: item.artistMBID,
          confirmed: true,
        }),
      });
      setSent(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Request failed.");
    } finally {
      setLoading(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="modal"
      aria-labelledby="edition-title"
      onCancel={close}
      onClose={close}
    >
      <button
        className="iconButton modalClose"
        aria-label="Close edition chooser"
        onClick={() => dialog.current?.close()}
      >
        ×
      </button>
      {sent ? (
        <div className="success">
          <Check aria-hidden="true" />
          <h2 id="edition-title">Request added</h2>
          <p>
            We’ll follow this release through acquisition and into the library.
          </p>
          <button className="primary" onClick={() => dialog.current?.close()}>
            Done
          </button>
        </div>
      ) : (
        <>
          <div className="editionHead">
            <Artwork src={releaseGroupArtwork(item.id)} />
            <div>
              <span className="eyebrow">CONFIRM RELEASE</span>
              <h2 id="edition-title">Choose an edition</h2>
              <p className="muted">
                {item.artist} · {item.title}
              </p>
            </div>
          </div>
          {loading && !editions.length ? (
            <div className="state small" role="status">
              <LoaderCircle className="spin" aria-hidden="true" />
            </div>
          ) : editions.length ? (
            <div className="editions">
              {editions.map((edition) => (
                <label
                  className={selected === edition.id ? "selected" : ""}
                  key={edition.id}
                >
                  <input
                    type="radio"
                    name="edition"
                    value={edition.id}
                    checked={selected === edition.id}
                    onChange={() => setSelected(edition.id)}
                  />
                  <Disc3 aria-hidden="true" />
                  <span>
                    <b>{edition.title}</b>
                    <small>
                      {[edition.date, edition.country]
                        .filter(Boolean)
                        .join(" · ") || "Edition details unavailable"}
                    </small>
                  </span>
                </label>
              ))}
            </div>
          ) : (
            !error && (
              <p className="muted">
                No editions are available for this release.
              </p>
            )
          )}
          {error && <ErrorBox message={error} />}
          <button
            className="primary wide"
            disabled={!selected || loading}
            onClick={() => void confirm()}
          >
            Confirm & request
          </button>
        </>
      )}
    </dialog>
  );
}

function LibraryPage({ open }: { open: (id: string) => void }) {
  const [items, setItems] = useState<AlbumItem[]>([]),
    [total, setTotal] = useState(0),
    [query, setQuery] = useState(""),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  const load = useCallback(async (q: string) => {
    controller.current?.abort();
    const next = new AbortController();
    controller.current = next;
    setLoading(true);
    setError("");
    try {
      const all: AlbumItem[] = [];
      let result: z.infer<typeof librarySchema>;
      do {
        result = await request(
          `/library?q=${encodeURIComponent(q)}&offset=${all.length}&limit=60`,
          librarySchema,
          undefined,
          { signal: next.signal },
        );
        all.push(...result.items);
        setTotal(result.total);
      } while (result.items.length && all.length < result.total);
      setItems(all);
    } catch (caught) {
      if (!(caught instanceof DOMException && caught.name === "AbortError"))
        setError(
          caught instanceof Error ? caught.message : "Library unavailable.",
        );
    } finally {
      if (controller.current === next) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load("");
    return () => controller.current?.abort();
  }, [load]);
  return (
    <div className="page">
      <header className="top">
        <div>
          <h1>Library</h1>
          <p>
            {total} {total === 1 ? "album" : "albums"} available in Jellyfin.
          </p>
        </div>
        <form
          className="search"
          onSubmit={(e) => {
            e.preventDefault();
            void load(query.trim());
          }}
        >
          <Search />
          <input
            aria-label="Filter library"
            placeholder="Filter your library"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </form>
      </header>
      <SectionState
        loading={loading}
        error={error}
        empty={!items.length}
        retry={() => void load(query)}
        emptyText="Connected Jellyfin albums will appear here."
        skeleton={<ArtSkeleton />}
      >
        <div className="artGrid">
          {items.map((item) => (
            <button
              className="artCard"
              key={item.id}
              title={`${item.title} — ${item.artist}`}
              onClick={() => open(item.id)}
            >
              <Artwork id={item.id} />
              <span className="artBadge">Available</span>
              <span className="artShade">
                <span className="artCopy">
                  <b>{item.title}</b>
                  <small>{item.artist}</small>
                </span>
                <span className="artCta">Open</span>
              </span>
            </button>
          ))}
        </div>
      </SectionState>
    </div>
  );
}
function AlbumDetail({ id, back }: { id: string; back: () => void }) {
  const [detail, setDetail] = useState<z.infer<
      typeof albumDetailSchema
    > | null>(null),
    [error, setError] = useState("");
  const load = useCallback(async () => {
    setError("");
    try {
      setDetail(
        await request(`/albums/${encodeURIComponent(id)}`, albumDetailSchema),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Album unavailable.");
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);
  if (error)
    return (
      <div className="page">
        <button className="back" onClick={back}>
          <ArrowLeft aria-hidden="true" /> Back
        </button>
        <ErrorBox message={error} retry={() => void load()} />
      </div>
    );
  if (!detail)
    return (
      <div className="state" role="status">
        <LoaderCircle className="spin" aria-hidden="true" />
      </div>
    );
  return (
    <div className="page">
      <button className="back" onClick={back}>
        <ArrowLeft aria-hidden="true" /> Back to library
      </button>
      <section className="albumHero">
        <Artwork id={detail.album.id} />
        <div>
          <h1>{detail.album.title}</h1>
          <h2>{detail.album.artist}</h2>
          <p>
            {detail.tracks.length}{" "}
            {detail.tracks.length === 1 ? "track" : "tracks"}
          </p>
          <span className="chip">Play on your native Leerr apps</span>
        </div>
      </section>
      <div className="tracks">
        <div className="track heading">
          <span>#</span>
          <span>Title</span>
          <span>Source metadata</span>
          <span>
            <Clock3 aria-hidden="true" />
          </span>
        </div>
        {detail.tracks.map((track, index) => (
          <div className="track" key={track.id}>
            <span>{index + 1}</span>
            <span>
              <b>{track.title}</b>
              <small>{track.artist}</small>
            </span>
            <span>
              {[
                track.sourceCodec?.toUpperCase() || "Unknown codec",
                track.sourceSampleRate
                  ? `${track.sourceSampleRate / 1000} kHz`
                  : "",
                track.sourceBitDepth ? `${track.sourceBitDepth}-bit` : "",
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
            <span>{formatDuration(track.duration)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
function Requests({
  csrf,
  open,
}: {
  csrf: string;
  open: (id: string) => void;
}) {
  const [items, setItems] = useState<z.infer<typeof requestSchema>[]>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems((await request("/requests", requestsSchema)).items);
      setError("");
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Requests unavailable.",
      );
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  async function retry(id: string) {
    try {
      await request(
        `/requests/${encodeURIComponent(id)}/retry`,
        z.object({}).passthrough(),
        csrf,
        {
          method: "POST",
          body: "{}",
        },
      );
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Retry failed.");
    }
  }
  return (
    <div className="page">
      <header className="top">
        <div>
          <h1>Requests</h1>
          <p>Follow each release from request to your library.</p>
        </div>
        <button className="secondary" onClick={() => void load()}>
          <RefreshCw aria-hidden="true" /> Refresh
        </button>
      </header>
      <SectionState
        loading={loading}
        error={error}
        empty={!items.length}
        retry={() => void load()}
        emptyText="Albums you request will show their progress here."
      >
        <div className="requestList">
          {items.map((item) => (
            <article className="requestRow" key={item.id}>
              <Artwork
                id={item.albumID || undefined}
                src={
                  item.albumID ? undefined : releaseArtwork(item.releaseMBID)
                }
              />
              <div className="requestInfo">
                <b title={item.title}>{item.title}</b>
                <span>{item.artist}</span>
                <Progress status={item.status} />
              </div>
              <div className="requestAction">
                <Status status={item.status} />
                {item.status.toLowerCase().includes("fail") ? (
                  <button
                    className="secondary"
                    onClick={() => void retry(item.id)}
                  >
                    Retry
                  </button>
                ) : item.albumID ? (
                  <button
                    className="iconButton"
                    aria-label={`Open ${item.title}`}
                    onClick={() => open(item.albumID || "")}
                  >
                    <ChevronRight />
                  </button>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      </SectionState>
    </div>
  );
}
function Status({ status }: { status: string }) {
  const clean = status.replaceAll("_", " ");
  return <span className={`status ${status.toLowerCase()}`}>{clean}</span>;
}
function Progress({ status }: { status: string }) {
  const stages = ["requested", "acquiring", "imported", "available"];
  const index = Math.max(0, stages.indexOf(status.toLowerCase()));
  return (
    <div className="progress" aria-label={`Status: ${status}`}>
      {stages.map((stage, position) => (
        <span key={stage} className={position <= index ? "done" : ""} />
      ))}
    </div>
  );
}

function FixtureNotice() {
  return (
    <div className="fixtureNotice" role="note">
      <strong>DEMO · Fixture data only</strong>
      <p>
        No live Jellyfin connection. Albums and service status are simulated. Do
        not enter real credentials. Service settings are read-only; use a live
        Leerr deployment for your library.
      </p>
    </div>
  );
}

function SettingsPage({
  auth,
  fixturePreview,
}: {
  auth: z.infer<typeof authSchema>;
  fixturePreview: boolean;
}) {
  const [tab, setTab] = useState<"connections" | "account" | "admin">(
    "connections",
  );
  return (
    <div className="page settingsPage">
      <header>
        <h1>Settings</h1>
        <p className="muted">
          Manage your account, service connections, and this installation.
        </p>
      </header>
      <div className="tabs" role="tablist">
        <button
          role="tab"
          aria-selected={tab === "connections"}
          className={tab === "connections" ? "active" : ""}
          onClick={() => setTab("connections")}
        >
          Connections
        </button>
        <button
          role="tab"
          aria-selected={tab === "account"}
          className={tab === "account" ? "active" : ""}
          onClick={() => setTab("account")}
        >
          Sessions
        </button>
        {auth.user.role === "admin" && (
          <button
            role="tab"
            aria-selected={tab === "admin"}
            className={tab === "admin" ? "active" : ""}
            onClick={() => setTab("admin")}
          >
            Administration
          </button>
        )}
      </div>
      {tab === "connections" ? (
        <fieldset className="settingsFields" disabled={fixturePreview}>
          <Connections
            csrf={auth.csrf}
            admin={auth.user.role === "admin"}
            configure={() => setTab("admin")}
          />
        </fieldset>
      ) : tab === "account" ? (
        <Sessions csrf={auth.csrf} />
      ) : (
        <fieldset className="settingsFields" disabled={fixturePreview}>
          <Admin csrf={auth.csrf} />
        </fieldset>
      )}
    </div>
  );
}
function Connections({
  csrf,
  admin,
  configure,
}: {
  csrf: string;
  admin: boolean;
  configure: () => void;
}) {
  const [state, setState] = useState<z.infer<typeof connectionsSchema> | null>(
      null,
    ),
    [error, setError] = useState("");
  const load = useCallback(async () => {
    setError("");
    try {
      setState(await request("/connections", connectionsSchema));
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Connections unavailable.",
      );
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  async function save(
    event: React.FormEvent<HTMLFormElement>,
    service: "jellyfin" | "lastfm",
  ) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const body =
      service === "jellyfin"
        ? {
            username: data.get("username"),
            password: data.get("password"),
          }
        : { username: data.get("username"), apiKey: data.get("apiKey") };
    try {
      await request(
        `/connections/${service}`,
        z.object({}).passthrough(),
        csrf,
        { method: "PUT", body: json(body) },
      );
      await load();
      form.reset();
    } catch (caught) {
      setError(
        `${service === "jellyfin" ? "Jellyfin" : "Last.fm"}: ${caught instanceof Error ? caught.message : "Connection failed."}`,
      );
    }
  }
  async function remove(service: string) {
    try {
      await request(
        `/connections/${service}`,
        z.object({}).passthrough(),
        csrf,
        { method: "DELETE" },
      );
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Disconnect failed.");
    }
  }
  if (!state)
    return error ? (
      <ErrorBox message={error} retry={() => void load()} />
    ) : (
      <div className="state" role="status">
        <LoaderCircle className="spin" aria-hidden="true" />
      </div>
    );
  return (
    <section className="settingsStack">
      {error && <ErrorBox message={error} />}
      <ConnectionCard
        title="Jellyfin"
        description="Your personal library access"
        connected={state.jellyfin}
        remove={() => void remove("jellyfin")}
      >
        {!state.jellyfinConfigured ? (
          <div>
            <p>
              {admin
                ? "Set up the Jellyfin server URL before connecting your account."
                : "Ask an administrator to configure the Jellyfin server before connecting your account."}
            </p>
            {admin && (
              <button className="primary" onClick={configure}>
                Set up server connections
              </button>
            )}
          </div>
        ) : (
          <form onSubmit={(e) => void save(e, "jellyfin")}>
            <Field label="Username" name="username" />
            <Field label="Password" name="password" type="password" />
            <button className="primary">Connect</button>
          </form>
        )}
      </ConnectionCard>
      <ConnectionCard
        title="Last.fm"
        description="Personalized music discovery using your username and a Last.fm API key, not your account password or API secret."
        connected={state.lastfm}
        remove={() => void remove("lastfm")}
      >
        <form onSubmit={(e) => void save(e, "lastfm")}>
          <Field label="Username" name="username" />
          <Field label="API key" name="apiKey" type="password" />
          <button className="primary">Connect</button>
        </form>
      </ConnectionCard>
    </section>
  );
}
function ConnectionCard({
  title,
  description,
  connected,
  remove,
  children,
}: {
  title: string;
  description: string;
  connected: boolean;
  remove: () => void;
  children: React.ReactNode;
}) {
  return (
    <article className="settingCard">
      <div className="settingTitle">
        <div>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
        {connected && (
          <span className="connected">
            <Check aria-hidden="true" /> Credentials saved
          </span>
        )}
      </div>
      {connected ? (
        <>
          <p className="muted">
            Stored credentials are not a live health check. Upstream access is
            checked when the service is used.
          </p>
          <button className="danger" onClick={remove}>
            Disconnect
          </button>
        </>
      ) : (
        children
      )}
    </article>
  );
}
function Sessions({ csrf }: { csrf: string }) {
  const [sessions, setSessions] = useState<
      z.infer<typeof sessionsSchema>["items"]
    >([]),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  const load = useCallback(
    () =>
      request("/sessions", sessionsSchema)
        .then((data) => {
          setSessions(data.items);
          setError("");
        })
        .catch((caught: Error) => setError(caught.message))
        .finally(() => setLoading(false)),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);
  async function revoke(id: string) {
    try {
      await request(
        `/sessions/${encodeURIComponent(id)}`,
        z.object({}).passthrough(),
        csrf,
        { method: "DELETE" },
      );
      await load();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not revoke session.",
      );
    }
  }
  return (
    <section className="settingCard">
      <h2>Signed-in devices</h2>
      <p className="muted">Revoke any session you don’t recognize.</p>
      {error && <ErrorBox message={error} />}
      {loading ? (
        <div className="state small" role="status">
          <LoaderCircle className="spin" aria-hidden="true" />
          <p>Loading sessions…</p>
        </div>
      ) : !error && sessions.length === 0 ? (
        <div className="state small">
          <UserRound aria-hidden="true" />
          <h3>No sessions</h3>
          <p>Signed-in devices will appear here.</p>
        </div>
      ) : (
        <div className="sessionList">
          {sessions.map((session) => (
            <div key={session.id}>
              <UserRound aria-hidden="true" />
              <span>
                <b>{session.name}</b>
                <small>
                  {session.current
                    ? "This browser"
                    : `Expires ${new Date(session.expiresAt).toLocaleDateString()}`}
                </small>
              </span>
              {session.current ? (
                <span className="currentSession">Current</span>
              ) : (
                <button
                  className="danger"
                  onClick={() => void revoke(session.id)}
                >
                  Revoke
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
function Admin({ csrf }: { csrf: string }) {
  const [settings, setSettings] = useState<z.infer<
      typeof adminSettingsSchema
    > | null>(null),
    [options, setOptions] = useState<z.infer<typeof optionsSchema> | null>(
      null,
    ),
    [users, setUsers] = useState<z.infer<typeof usersSchema>["items"]>([]),
    [lidarrURL, setLidarrURL] = useState(""),
    [saved, setSaved] = useState(""),
    [error, setError] = useState("");
  const load = useCallback(async () => {
    setError("");
    try {
      const current = await request("/admin/settings", adminSettingsSchema);
      setSettings(current);
      setLidarrURL(current.lidarrURL || "");
      setUsers((await request("/admin/users", usersSchema)).items);
      try {
        setOptions(await request("/admin/lidarr/options", optionsSchema));
      } catch {
        setOptions(null);
      }
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Admin settings unavailable.",
      );
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  async function saveSettings(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const d = new FormData(form);
    const lidarrKey = String(d.get("lidarrKey") || "");
    const jellyfinOnly = d.has("jellyfinURL");
    setSaved("");
    if (
      !jellyfinOnly &&
      lidarrURL &&
      !lidarrKey.trim() &&
      !(settings?.lidarrConfigured && lidarrURL === settings.lidarrURL)
    ) {
      setError(
        "Enter a Lidarr API key from Lidarr Settings → General → Security.",
      );
      return;
    }
    try {
      await request("/admin/settings", z.object({}).passthrough(), csrf, {
        method: "PUT",
        body: json(
          jellyfinOnly
            ? { jellyfinURL: d.get("jellyfinURL") }
            : {
                lidarrURL: d.get("lidarrURL"),
                lidarrKey,
                rootFolderPath: d.get("rootFolderPath"),
                qualityProfileID: Number(d.get("qualityProfileID")),
                metadataProfileID: Number(d.get("metadataProfileID")),
              },
        ),
      });
      if (!jellyfinOnly) form.reset();
      await load();
      setSaved(
        jellyfinOnly
          ? "Jellyfin server saved. Open Connections to sign into your Jellyfin account."
          : d.get("rootFolderPath") &&
              Number(d.get("qualityProfileID")) > 0 &&
              Number(d.get("metadataProfileID")) > 0
            ? "Lidarr settings saved."
            : "Lidarr connection saved. Select a root folder and both profiles, then save Lidarr settings again.",
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Save failed.");
    }
  }
  async function addUser(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const d = new FormData(form);
    try {
      await request("/admin/users", z.object({}).passthrough(), csrf, {
        method: "POST",
        body: json({
          username: d.get("username"),
          password: d.get("password"),
          role: d.get("role"),
        }),
      });
      form.reset();
      await load();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not add user.",
      );
    }
  }
  async function toggle(id: string, disabled: boolean) {
    try {
      await request(
        `/admin/users/${encodeURIComponent(id)}`,
        z.object({}).passthrough(),
        csrf,
        {
          method: "PATCH",
          body: json({ disabled }),
        },
      );
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Update failed.");
    }
  }
  if (!settings)
    return error ? (
      <ErrorBox message={error} retry={() => void load()} />
    ) : (
      <div className="state" role="status">
        <LoaderCircle className="spin" aria-hidden="true" />
      </div>
    );
  return (
    <div className="settingsStack">
      {error && <ErrorBox message={error} />}
      {saved && <p role="status">{saved}</p>}
      <form
        key={`${settings.jellyfinURL}-${settings.lidarrURL}-${settings.rootFolderPath}-${settings.qualityProfileID}-${settings.metadataProfileID}`}
        className="settingCard"
        onSubmit={(e) => void saveSettings(e)}
      >
        <div className="settingTitle">
          <div>
            <h2>Jellyfin server setup</h2>
            <p>
              Save the server URL first, then connect your personal account in
              Connections.
            </p>
          </div>
          <ShieldCheck aria-hidden="true" />
        </div>
        <div className="formGrid">
          <Field
            label="Jellyfin URL"
            name="jellyfinURL"
            type="url"
            placeholder="https://media.example.com"
            defaultValue={settings.jellyfinURL || ""}
            required={false}
          />
        </div>
        <button className="primary">Save Jellyfin server</button>
      </form>
      <form className="settingCard" onSubmit={(e) => void saveSettings(e)}>
        <h2>Lidarr setup</h2>
        <p>
          Enter the server URL and required API key from Lidarr Settings →
          General → Security. Save to load root folders and profiles.
        </p>
        <div className="formGrid">
          <Field
            label="Lidarr URL"
            name="lidarrURL"
            type="url"
            placeholder="https://lidarr.example.com"
            value={lidarrURL}
            onChange={(event) => setLidarrURL(event.currentTarget.value)}
            required={false}
          />
          <Field
            label={
              settings.lidarrConfigured && lidarrURL === settings.lidarrURL
                ? "Lidarr API key (saved; leave blank to keep current)"
                : "Lidarr API key (required)"
            }
            name="lidarrKey"
            type="password"
            required={
              !!lidarrURL &&
              !(settings.lidarrConfigured && lidarrURL === settings.lidarrURL)
            }
          />
          <label className="field">
            <span>Root folder</span>
            <select
              key={`root-${settings.rootFolderPath}-${options?.roots.length}`}
              name="rootFolderPath"
              defaultValue={settings.rootFolderPath || ""}
            >
              <option value="">Select after saving Lidarr credentials</option>
              {options?.roots.map((root) => (
                <option key={root.id} value={root.path}>
                  {root.path}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Quality profile</span>
            <select
              key={`quality-${settings.qualityProfileID}-${options?.qualities.length}`}
              name="qualityProfileID"
              defaultValue={settings.qualityProfileID || 0}
            >
              <option value="0">Select after saving Lidarr credentials</option>
              {options?.qualities.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Metadata profile</span>
            <select
              key={`metadata-${settings.metadataProfileID}-${options?.metadata.length}`}
              name="metadataProfileID"
              defaultValue={settings.metadataProfileID || 0}
            >
              <option value="0">Select after saving Lidarr credentials</option>
              {options?.metadata.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <button className="primary">Save Lidarr settings</button>
      </form>
      <section className="settingCard">
        <h2>Users</h2>
        {users.length === 0 ? (
          <div className="state small">
            <UserRound aria-hidden="true" />
            <h3>No users</h3>
            <p>Add the first account for this installation.</p>
          </div>
        ) : null}
        <div className="userList">
          {users.map((user) => (
            <div key={user.id}>
              <span className="avatar">
                {user.username.charAt(0).toUpperCase()}
              </span>
              <span>
                <b>{user.username}</b>
                <small className="roleChip">{user.role}</small>
              </span>
              <button
                className="danger"
                onClick={() => void toggle(user.id, !user.disabled)}
              >
                {user.disabled ? "Enable" : "Disable"}
              </button>
            </div>
          ))}
        </div>
        <form className="inlineForm" onSubmit={(e) => void addUser(e)}>
          <Field label="Username" name="username" />
          <Field label="Temporary password" name="password" type="password" />
          <label className="field">
            <span>Role</span>
            <select name="role">
              <option value="member">Member</option>
              <option value="admin">Administrator</option>
            </select>
          </label>
          <button className="primary">Add user</button>
        </form>
      </section>
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");
createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
