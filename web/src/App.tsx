import { Clock3, Compass, Library, LoaderCircle, LogOut, Settings } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ApiError, configureApi, errorMessage, meSchema, request, send, setupSchema, type User } from "./api.ts";
import { AuthPage } from "./pages/Auth.tsx";
import { AlbumPage } from "./pages/Album.tsx";
import { DiscoverPage } from "./pages/Discover.tsx";
import { LibraryPage } from "./pages/Library.tsx";
import { RequestsPage } from "./pages/Requests.tsx";
import { SettingsPage } from "./pages/Settings.tsx";
import { PlayerBar, PlayerProvider, usePlayer } from "./player.tsx";
import { Link, match, navigate, useLocation } from "./router.tsx";
import { SessionContext, useSession, type Session } from "./session.tsx";
import { Brand, ErrorBox } from "./ui.tsx";

type Boot =
  | { phase: "loading" }
  | { phase: "failed"; message: string }
  | { phase: "setup"; fixturePreview: boolean }
  | { phase: "signedOut"; fixturePreview: boolean; notice: string }
  | { phase: "signedIn"; fixturePreview: boolean; user: User };

export function App() {
  const [boot, setBoot] = useState<Boot>({ phase: "loading" });

  const signedOut = useCallback((fixturePreview: boolean, notice = "") => {
    configureApi("", () => {});
    setBoot({ phase: "signedOut", fixturePreview, notice });
  }, []);
  const signedIn = useCallback(
    (fixturePreview: boolean, user: User, csrf: string | null) => {
      configureApi(csrf ?? "", () => signedOut(fixturePreview, "Your session ended. Sign in again."));
      setBoot({ phase: "signedIn", fixturePreview, user });
    },
    [signedOut],
  );

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
  }, [signedIn, signedOut]);

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
      user={boot.user}
      fixturePreview={boot.fixturePreview}
      onSignedOut={() => signedOut(boot.fixturePreview)}
    />
  );
}

function SignedIn({ user, fixturePreview, onSignedOut }: { user: User; fixturePreview: boolean; onSignedOut: () => void }) {
  const session = useMemo<Session>(
    () => ({
      user,
      fixturePreview,
      signOut: async () => {
        try {
          await send("/sessions/current", "DELETE");
        } finally {
          onSignedOut();
        }
      },
    }),
    [user, fixturePreview, onSignedOut],
  );
  return (
    <SessionContext.Provider value={session}>
      <PlayerProvider>
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

function Shell() {
  const { path } = useLocation();
  const { user, fixturePreview, signOut } = useSession();
  const player = usePlayer();
  const main = useRef<HTMLElement>(null);
  const firstRender = useRef(true);

  useEffect(() => {
    if (path === "/") navigate("/discover", true);
  }, [path]);
  // Move focus to the new view so keyboard and screen-reader users land on it.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    main.current?.querySelector("h1")?.focus();
  }, [path]);

  const nav = (className: string) => (
    <nav className={className} aria-label="Main">
      {sections.map((section) => (
        <Link
          key={section.to}
          to={section.to}
          className="navLink"
          current={path === section.to || path.startsWith(`${section.to}/`)}
        >
          {section.icon}
          <span>{section.label}</span>
        </Link>
      ))}
    </nav>
  );

  return (
    <div className={`shell ${player.current ? "withPlayer" : ""}`}>
      <a className="skip" href="#content">
        Skip to content
      </a>
      <aside className="sidebar">
        <Brand />
        {nav("sideNav")}
        <div className="account">
          <Link to="/settings" className="profile" label={`${user.username}, account settings`}>
            <span className="avatar" aria-hidden="true">
              {user.username.charAt(0).toUpperCase()}
            </span>
            <span>
              <b>{user.username}</b>
              <small>{user.role === "admin" ? "Administrator" : "Member"}</small>
            </span>
          </Link>
          <button type="button" className="iconButton" aria-label="Sign out" onClick={() => void signOut()}>
            <LogOut aria-hidden="true" />
          </button>
        </div>
      </aside>
      <main id="content" ref={main} tabIndex={-1}>
        {fixturePreview && <FixtureNotice />}
        <Routes path={path} />
      </main>
      <PlayerBar />
      {nav("bottomNav")}
    </div>
  );
}

function Routes({ path }: { path: string }): ReactNode {
  const album = match("/albums/:id", path);
  if (album) return <AlbumPage key={album.get("id")} id={album.get("id") ?? ""} />;
  const artist = match("/discover/artists/:id", path);
  if (artist) return <DiscoverPage artistID={artist.get("id") ?? null} />;
  if (path === "/discover" || path === "/") return <DiscoverPage artistID={null} />;
  if (path === "/library") return <LibraryPage />;
  if (path === "/requests") return <RequestsPage />;
  const settings = match("/settings/:tab", path);
  if (path === "/settings" || settings) return <SettingsPage tab={settings?.get("tab") ?? "connections"} />;
  return (
    <div className="page">
      <h1 tabIndex={-1}>Page not found</h1>
      <p className="muted">
        <Link to="/discover">Go to Discover</Link>
      </p>
    </div>
  );
}

function FixtureNotice() {
  return (
    <div className="fixtureNotice" role="note">
      <strong>Demo with sample data.</strong> Nothing here is connected to real services, and credentials cannot be saved.
    </div>
  );
}
