import { Clock3, Compass, Library, LoaderCircle, LogOut, Settings } from "lucide-react";
import { Component, memo, useCallback, useEffect, useMemo, useRef, useState, type ErrorInfo, type ReactNode } from "react";
import { ApiError, configureApi, errorMessage, meSchema, request, send, setupSchema, type User } from "./api.ts";
import { useAction, useRequestUpdates } from "./hooks.ts";
import { AuthPage } from "./pages/Auth.tsx";
import { AlbumPage } from "./pages/Album.tsx";
import { DiscoverPage } from "./pages/Discover.tsx";
import { LibraryPage, type LibraryView } from "./pages/Library.tsx";
import { PlaylistPage } from "./pages/Playlist.tsx";
import { RequestsPage } from "./pages/Requests.tsx";
import { SettingsPage } from "./pages/Settings.tsx";
import { createController, PlayerBar, PlayerProvider, storageKey, storagePrefix, usePlayer } from "./player.tsx";
import { Link, match, navigate, useLocation } from "./router.tsx";
import { SessionContext, useSession, type Session } from "./session.tsx";
import { Brand, ErrorBox, focusLost, Title } from "./ui.tsx";

type Boot =
  | { phase: "loading" }
  | { phase: "failed"; message: string }
  | { phase: "setup"; fixturePreview: boolean }
  | { phase: "signedOut"; fixturePreview: boolean; notice: string }
  | { phase: "signedIn"; fixturePreview: boolean; user: User };

// Earlier releases kept "leerr.player." queues and "leerr.requests.seen." keys; they are swept away too.
const personalPrefixes = [storagePrefix, "leerr.player.", "leerr.requests.seen."];

/**
 * Nothing of one person's listening may linger for the next person in this
 * browser: every saved queue except `keep` goes, including those of people
 * whose session ended while this page was closed.
 */
function forgetOthers(keep: string | null) {
  try {
    const stale: string[] = [];
    for (let at = 0; at < localStorage.length; at++) {
      const key = localStorage.key(at);
      if (key && key !== keep && personalPrefixes.some((prefix) => key.startsWith(prefix))) stale.push(key);
    }
    for (const key of stale) localStorage.removeItem(key);
  } catch {
    // Storage may be disabled.
  }
}

/** Tells this browser's other tabs that a person signed out, so they stop (and stop saving) too. */
const sessionChannel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("leerr-session");

export function App() {
  const [boot, setBoot] = useState<Boot>({ phase: "loading" });

  /** `ended`: the person whose session ended here, announced to other tabs. */
  const signedOut = useCallback((fixturePreview: boolean, notice = "", ended: string | null = null) => {
    if (ended) sessionChannel?.postMessage({ signedOut: ended });
    configureApi("", { unauthorized: () => {}, stale: () => {} });
    setBoot({ phase: "signedOut", fixturePreview, notice });
  }, []);

  // After the commit that unmounted the player, so nothing it saves can come back.
  useEffect(() => {
    if (boot.phase === "signedIn") forgetOthers(storageKey(boot.user.id));
    else if (boot.phase === "setup" || boot.phase === "signedOut") forgetOthers(null);
  }, [boot]);

  useEffect(() => {
    if (!sessionChannel || boot.phase !== "signedIn") return;
    const { user, fixturePreview } = boot;
    const listener = (event: MessageEvent<{ signedOut?: string }>) => {
      if (event.data.signedOut === user.id) signedOut(fixturePreview, "You signed out in another tab.");
    };
    sessionChannel.addEventListener("message", listener);
    return () => sessionChannel.removeEventListener("message", listener);
  }, [boot, signedOut]);

  const start = useCallback(async () => {
    setBoot({ phase: "loading" });
    try {
      const setup = await request("/setup", setupSchema);
      if (setup.required) {
        setBoot({ phase: "setup", fixturePreview: setup.fixturePreview });
        return;
      }
      try {
        const me = await request("/me", meSchema);
        signedIn(setup.fixturePreview, me.user, me.csrf);
      } catch (cause) {
        if (cause instanceof ApiError && cause.status === 401) signedOut(setup.fixturePreview);
        else throw cause;
      }
    } catch (cause) {
      setBoot({ phase: "failed", message: errorMessage(cause, "Leerr is unreachable.") });
    }
    // signedIn is defined below and only closes over stable callbacks.
  }, [signedOut]);

  /** Re-reads the signed-in user; another account in this browser means starting over. */
  const refresh = useCallback(
    async (fixturePreview: boolean, user: User) => {
      try {
        const me = await request("/me", meSchema);
        if (me.user.id !== user.id) await start();
        else signedIn(fixturePreview, me.user, me.csrf);
      } catch (cause) {
        if (!(cause instanceof ApiError && cause.status === 401)) throw cause;
      }
    },
    [start],
  );

  function signedIn(fixturePreview: boolean, user: User, csrf: string | null) {
    configureApi(csrf ?? "", {
      unauthorized: () => signedOut(fixturePreview, "Your session ended. Sign in again.", user.id),
      stale: () => void refresh(fixturePreview, user).catch(() => {}),
    });
    setBoot({ phase: "signedIn", fixturePreview, user });
  }

  useEffect(() => {
    void start();
  }, [start]);

  if (boot.phase === "loading")
    return (
      <main className="centered">
        <LoaderCircle className="spin" aria-hidden="true" />
        <p>Opening Leerr…</p>
      </main>
    );
  if (boot.phase === "failed")
    return (
      <main className="centered">
        <Brand />
        <ErrorBox message={boot.message} retry={() => void start()} />
      </main>
    );
  if (boot.phase === "setup" || boot.phase === "signedOut")
    return (
      <>
        <Title text={boot.phase === "setup" ? "Set up" : "Sign in"} />
        {boot.fixturePreview && <FixtureNotice />}
        <AuthPage
          mode={boot.phase === "setup" ? "setup" : "login"}
          notice={boot.phase === "signedOut" ? boot.notice : ""}
          onSetup={() => signedOut(boot.fixturePreview, "Administrator created. Sign in to continue.")}
          onLogin={(user, csrf) => signedIn(boot.fixturePreview, user, csrf)}
        />
      </>
    );
  return (
    <SignedIn
      key={boot.user.id}
      user={boot.user}
      fixturePreview={boot.fixturePreview}
      onSignedOut={() => signedOut(boot.fixturePreview, "", boot.user.id)}
      refresh={() => refresh(boot.fixturePreview, boot.user)}
    />
  );
}

function SignedIn({
  user,
  fixturePreview,
  onSignedOut,
  refresh,
}: {
  user: User;
  fixturePreview: boolean;
  onSignedOut: () => void;
  refresh: () => Promise<void>;
}) {
  const controller = useMemo(() => createController(user.id), [user.id]);
  const session = useMemo<Session>(
    () => ({
      user,
      fixturePreview,
      signOut: async () => {
        // While the session still exists: Plex hears that the track stopped.
        await Promise.race([controller.halt(), new Promise((resolve) => setTimeout(resolve, 2_000))]);
        try {
          await send("/sessions/current", "DELETE");
        } catch (cause) {
          // Already ended is fine; anything else means this device is still signed in.
          if (!(cause instanceof ApiError && (cause.status === 401 || cause.status === 404)))
            throw new Error(`Couldn't sign out. ${errorMessage(cause)} Try again.`);
        }
        onSignedOut();
      },
      refresh,
    }),
    [user, fixturePreview, onSignedOut, refresh, controller],
  );
  return (
    <SessionContext.Provider value={session}>
      <PlayerProvider controller={controller}>
        <Shell />
      </PlayerProvider>
    </SessionContext.Provider>
  );
}

const sections = [
  { to: "/discover", label: "Discover", icon: <Compass aria-hidden="true" /> },
  { to: "/library", label: "Library", icon: <Library aria-hidden="true" /> },
  { to: "/requests", label: "Requests", icon: <Clock3 aria-hidden="true" /> },
  { to: "/settings", label: "Settings", icon: <Settings aria-hidden="true" /> },
];
const section = (path: string) => path.split("/")[1] ?? "";

function Shell() {
  const { path, href } = useLocation();
  const { user, fixturePreview, signOut } = useSession();
  const player = usePlayer();
  const main = useRef<HTMLElement>(null);
  const previous = useRef(section(path));
  const signOutAction = useAction();
  const updates = useRequestUpdates(path !== "/requests");

  useEffect(() => {
    if (path === "/") navigate("/discover", true);
  }, [path]);
  // Focus the new view's heading so keyboard and screen-reader users land on it.
  // Within a section (tabs, filters) only when the control that had focus went away.
  useEffect(() => {
    const now = section(path);
    const moved = previous.current !== now;
    previous.current = now;
    if (moved || focusLost()) main.current?.querySelector("h1")?.focus();
  }, [path, href]);

  const nav = (className: string) => (
    <nav className={className} aria-label="Main">
      {sections.map((entry) => {
        const badge = entry.to === "/requests" && updates > 0;
        return (
          <Link
            key={entry.to}
            to={entry.to}
            className="navLink"
            current={path === entry.to || path.startsWith(`${entry.to}/`)}
            label={badge ? `${entry.label}, ${updates} ${updates === 1 ? "update" : "updates"}` : undefined}
          >
            {entry.icon}
            <span>{entry.label}</span>
            {badge && (
              <span className="navBadge" aria-hidden="true">
                {updates}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );

  return (
    <div className={`shell ${player.current ? "withPlayer" : ""}`}>
      {/* Focuses directly: a fragment navigation would add a history entry the Back button cannot place. */}
      <a
        className="skip"
        href="#content"
        onClick={(event) => {
          event.preventDefault();
          main.current?.focus();
        }}
      >
        Skip to content
      </a>
      <aside className="sidebar">
        <Brand />
        {nav("sideNav")}
        <div className="account">
          <Link to="/settings/account" className="profile" label={`${user.username}, account settings`}>
            <span className="avatar" aria-hidden="true">
              {user.username.charAt(0).toUpperCase()}
            </span>
            <span>
              <b>{user.username}</b>
              <small>{user.role === "admin" ? "Administrator" : "Member"}</small>
            </span>
          </Link>
          <button
            type="button"
            className="iconButton"
            aria-label="Sign out"
            aria-disabled={signOutAction.pending}
            onClick={() => void signOutAction.run(signOut)}
          >
            <LogOut aria-hidden="true" />
          </button>
        </div>
        {signOutAction.error && <ErrorBox message={signOutAction.error} />}
      </aside>
      <main id="content" ref={main} tabIndex={-1}>
        {fixturePreview && <FixtureNotice />}
        <ErrorBoundary path={path}>
          <Routes path={path} />
        </ErrorBoundary>
      </main>
      <PlayerBar />
      {nav("bottomNav")}
    </div>
  );
}

// Memoised: the player changes often, and the current page does not depend on it.
const Routes = memo(function Routes({ path }: { path: string }): ReactNode {
  const album = match("/albums/:id", path);
  if (album) return <AlbumPage key={album.get("id")} id={album.get("id") ?? ""} />;
  const playlist = match("/playlists/:id", path);
  if (playlist) return <PlaylistPage key={playlist.get("id")} id={playlist.get("id") ?? ""} />;
  const artist = match("/discover/artists/:id", path);
  if (artist) return <DiscoverPage artistID={artist.get("id") ?? null} />;
  if (path === "/discover" || path === "/") return <DiscoverPage artistID={null} />;
  const libraryView = match("/library/:view", path)?.get("view");
  if (path === "/library" || libraryView === "artists" || libraryView === "playlists")
    return <LibraryPage view={libraryView === "artists" || libraryView === "playlists" ? (libraryView satisfies LibraryView) : "albums"} />;
  if (path === "/requests") return <RequestsPage />;
  const settings = match("/settings/:tab", path);
  if (path === "/settings" || settings) return <SettingsPage tab={settings?.get("tab") ?? "connections"} />;
  return (
    <div className="page">
      <Title text="Page not found" />
      <h1 tabIndex={-1}>Page not found</h1>
      <p className="muted">
        <Link to="/discover">Go to Discover</Link>
      </p>
    </div>
  );
});

/**
 * A page that crashes shows an error instead of taking the player and
 * navigation down with it, until the next navigation.
 */
class ErrorBoundary extends Component<{ path: string; children: ReactNode }, { failed: boolean; path: string }> {
  state = { failed: false, path: this.props.path };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  static getDerivedStateFromProps(props: { path: string }, state: { path: string }) {
    return props.path === state.path ? null : { failed: false, path: props.path };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(error, info.componentStack);
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="page">
        <h1 tabIndex={-1}>Something went wrong</h1>
        <ErrorBox message="This page hit an error. Reload to try again." retry={() => location.reload()} />
      </div>
    );
  }
}

function FixtureNotice() {
  return (
    <div className="fixtureNotice" role="note">
      <strong>Demo with sample data.</strong> Nothing here is connected to real services, and credentials cannot be saved.
    </div>
  );
}
