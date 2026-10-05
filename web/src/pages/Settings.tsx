import { AlertTriangle, Check, LogOut, Monitor, Smartphone } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  acquisitionsSchema,
  adminSettingsSchema,
  connectionsSchema,
  lidarrOptionsSchema,
  notifyFormats,
  plexSectionsSchema,
  request,
  send,
  sessionsSchema,
  statusSchema,
  usersSchema,
  type AdminSettings,
  type Connections,
  type Probe,
} from "../api.ts";
import { useAction, useResource } from "../hooks.ts";
import { PlexLinkProgress, usePlexLink } from "../plexlink.tsx";
import { Link } from "../router.tsx";
import { useSession } from "../session.tsx";
import { ErrorBox, Field, formatDate, formatRelative, Notice, PasswordDialog, SectionState, Spinner, StatusBadge, Title } from "../ui.tsx";

const tabs = [
  { id: "connections", label: "Connections", admin: false },
  { id: "account", label: "Account", admin: false },
  { id: "devices", label: "Devices", admin: false },
  { id: "server", label: "Server", admin: true },
  { id: "users", label: "Users", admin: true },
  { id: "acquisitions", label: "All requests", admin: true },
  { id: "status", label: "Status", admin: true },
];

export function SettingsPage({ tab }: { tab: string }) {
  const { user, signOut } = useSession();
  const signOutAction = useAction();
  const visible = tabs.filter((entry) => !entry.admin || user.role === "admin");
  const current = visible.find((entry) => entry.id === tab) ?? visible[0];
  const nav = useRef<HTMLElement>(null);
  // On phones the tabs scroll sideways: keep the selected one in view, without scrolling the page.
  useLayoutEffect(() => {
    const strip = nav.current;
    const selected = strip?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!strip || !selected) return;
    const left = selected.offsetLeft - strip.offsetLeft;
    if (left < strip.scrollLeft || left + selected.offsetWidth > strip.scrollLeft + strip.clientWidth)
      strip.scrollLeft = left - 16;
  }, [current.id]);
  return (
    <div className="page settingsPage">
      <Title text={`Settings · ${current.label}`} />
      <header className="top">
        <div>
          <h1 tabIndex={-1}>Settings</h1>
          <p>
            Signed in as <b>{user.username}</b> ({user.role === "admin" ? "administrator" : "member"}).
          </p>
        </div>
        <button type="button" className="secondary" aria-disabled={signOutAction.pending} onClick={() => void signOutAction.run(signOut)}>
          <LogOut aria-hidden="true" /> {signOutAction.pending ? "Signing out…" : "Sign out"}
        </button>
      </header>
      {signOutAction.error && <ErrorBox message={signOutAction.error} />}
      <nav className="tabs" aria-label="Settings sections" ref={nav}>
        {visible.map((entry) => (
          <Link key={entry.id} to={entry.id === "connections" ? "/settings" : `/settings/${entry.id}`} current={entry.id === current.id}>
            {entry.label}
          </Link>
        ))}
      </nav>
      {current.id === "connections" && <ConnectionsSection />}
      {current.id === "account" && <AccountSection />}
      {current.id === "devices" && <DevicesSection />}
      {current.id === "server" && <ServerSection />}
      {current.id === "users" && <UsersSection />}
      {current.id === "acquisitions" && <AcquisitionsSection />}
      {current.id === "status" && <StatusSection />}
    </div>
  );
}

function Card({ title, description, badge, children }: { title: string; description?: ReactNode; badge?: ReactNode; children: ReactNode }) {
  return (
    <section className="card">
      <div className="cardTitle">
        <div>
          <h2>{title}</h2>
          {description && <p className="muted">{description}</p>}
        </div>
        {badge}
      </div>
      {children}
    </section>
  );
}

const Connected = ({ label }: { label: string }) => (
  <span className="connected">
    <Check aria-hidden="true" /> {label}
  </span>
);
const Warning = ({ label }: { label: string }) => (
  <span className="connected warning">
    <AlertTriangle aria-hidden="true" /> {label}
  </span>
);

function formValues(event: FormEvent<HTMLFormElement>) {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  return (name: string) => String(data.get(name) ?? "");
}

/**
 * Signing in happens on Plex's own page; Leerr's server holds the sign-in and
 * this card follows it until it is approved.
 */
function PlexCard({ state, reload }: { state: Connections; reload: () => void }) {
  const { user, fixturePreview } = useSession();
  const flow = usePlexLink("leerr.plexLink", reload);
  const remove = useAction();
  const linked = state.plex;
  const begin = () => {
    if (!fixturePreview) flow.begin("/connections/plex/links");
  };
  const disconnect = () => {
    if (!confirm("Disconnect Plex? Your library, playback and request progress stop until you sign in again.")) return;
    void remove.run(async () => {
      await send("/connections/plex", "DELETE");
      flow.cancel();
      reload();
    });
  };
  const busy = flow.following || flow.link?.state === "choose_profile";
  return (
    <Card
      title="Plex"
      description="Your own Plex account: Leerr shows exactly the music it can see, and plays, loves and playlists go to it. You sign in on Plex's page; Leerr never sees your Plex password."
      badge={
        linked &&
        (state.plexValid === false ? (
          <Warning label="Needs signing in again" />
        ) : (
          <Connected label={`Signed in as ${linked.username}${linked.managed ? " (managed profile)" : ""}`} />
        ))
      }
    >
      {!state.plexConfigured ? (
        <p>
          {user.role === "admin" ? (
            <>
              First <Link to="/settings/server">set the Plex server address</Link>.
            </>
          ) : (
            "An administrator needs to set up the Plex server first."
          )}
        </p>
      ) : (
        <>
          <PlexLinkProgress flow={flow} retry={begin} />
          {!busy && (
            <>
              {state.plexValid === false && linked && (
                <Notice>
                  {linked.managed
                    ? `Plex no longer accepts ${linked.username}'s sign-in. Ask an administrator to link the profile again in Settings → Users.`
                    : `Plex no longer accepts the saved sign-in for ${linked.username}, for example after it was signed out in Plex. Sign in again.`}
                </Notice>
              )}
              <div className="rowActions start">
                <button
                  type="button"
                  className={linked?.managed ? "secondary" : "primary"}
                  aria-disabled={flow.starting || fixturePreview}
                  onClick={begin}
                >
                  {flow.starting ? "Opening Plex…" : linked?.managed ? "Sign in with my own Plex account" : linked ? "Sign in again" : "Sign in with Plex"}
                </button>
                {linked && (
                  <button type="button" className="danger" aria-disabled={remove.pending} onClick={() => !remove.pending && disconnect()}>
                    Disconnect Plex
                  </button>
                )}
              </div>
              <p className="muted small">
                Using a managed Plex Home profile (one without its own Plex sign-in)? An administrator links it for you in Settings → Users.
              </p>
            </>
          )}
        </>
      )}
      {remove.error && <ErrorBox message={remove.error} />}
    </Card>
  );
}

function ConnectionsSection() {
  const { user, fixturePreview } = useSession();
  const connections = useResource((signal) => request("/connections", connectionsSchema, { signal }), []);
  const lastfm = useAction();
  const state = connections.data;
  if (!state)
    return (
      <SectionState loading={connections.loading} error={connections.error} empty retry={connections.reload} emptyText="">
        {null}
      </SectionState>
    );

  const save = (event: FormEvent<HTMLFormElement>) => {
    const form = event.currentTarget;
    const value = formValues(event);
    void lastfm.run(async () => {
      await send("/connections/lastfm", "PUT", { username: value("username"), apiKey: value("apiKey") });
      form.reset();
      connections.reload();
    });
  };
  const disconnect = () => {
    if (!confirm("Disconnect Last.fm? Your suggestions stop using your Last.fm listening.")) return;
    void lastfm.run(async () => {
      await send("/connections/lastfm", "DELETE");
      connections.reload();
    });
  };

  return (
    <div className="stack">
      <PlexCard state={state} reload={connections.reload} />
      <Card
        title="Last.fm"
        description={
          state.lastfmKeyProvided ? (
            "Optional: personal suggestions and album art from your public listening history. Your Last.fm username is enough."
          ) : (
            <>
              Optional: personal suggestions and album art from your public listening history. Use an{" "}
              <a href="https://www.last.fm/api/account/create" target="_blank" rel="noreferrer">
                API key
              </a>
              , not your password.
            </>
          )
        }
        badge={state.lastfm && <Connected label={`Connected as ${state.lastfm}`} />}
      >
        {state.lastfm ? (
          <button type="button" className="danger" aria-disabled={lastfm.pending} onClick={() => !lastfm.pending && disconnect()}>
            Disconnect Last.fm
          </button>
        ) : (
          <form className="formGrid" onSubmit={save}>
            <fieldset disabled={fixturePreview || lastfm.pending}>
              <Field label="Last.fm username" name="username" autoComplete="off" />
              <Field
                label="API key"
                name="apiKey"
                autoComplete="off"
                spellCheck={false}
                required={!state.lastfmKeyProvided}
                placeholder={state.lastfmKeyProvided ? "Optional: the server's key is used" : ""}
              />
              <button className="primary">{lastfm.pending ? "Checking…" : "Connect"}</button>
            </fieldset>
          </form>
        )}
        {lastfm.error && <ErrorBox message={lastfm.error} />}
      </Card>
      {!state.lidarrReady && (
        <Notice>
          {state.lidarrConfigured ? "Lidarr needs its root folder and profiles before requests can start." : "Requests need Lidarr."}{" "}
          {user.role === "admin" ? <Link to="/settings/server">Finish Lidarr setup</Link> : "Ask an administrator to set it up."}
        </Notice>
      )}
    </div>
  );
}

function AccountSection() {
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState(false);
  return (
    <div className="stack">
      <Card title="Password" description="Changing your password signs out your other devices. This one stays signed in.">
        <button type="button" className="secondary" onClick={() => setOpen(true)}>
          Change password
        </button>
        {done && <Notice>Password changed. Your other devices have been signed out.</Notice>}
      </Card>
      {open && (
        <PasswordDialog
          title="Change your password"
          description="Enter your current password, then the new one twice."
          submitLabel="Change password"
          current
          close={() => setOpen(false)}
          submit={async ({ current, password }) => {
            await send("/me/password", "PUT", { current, password });
            setDone(true);
          }}
        />
      )}
    </div>
  );
}

function DevicesSection() {
  const sessions = useResource((signal) => request("/sessions", sessionsSchema, { signal }), []);
  const action = useAction();
  const revoke = (id: string) =>
    void action.run(async () => {
      await send(`/sessions/${encodeURIComponent(id)}`, "DELETE");
      sessions.reload();
    });
  const items = sessions.data?.items ?? [];
  return (
    <Card title="Signed-in devices" description="Sign out any device you don't recognise. Its playback stops immediately.">
      {action.error && <ErrorBox message={action.error} />}
      <SectionState loading={sessions.loading} error={sessions.error} empty={!items.length} retry={sessions.reload} emptyText="No active sessions.">
        <ul className="rows">
          {items.map((session) => (
            <li key={session.id}>
              {session.device === "native" ? <Smartphone aria-hidden="true" /> : <Monitor aria-hidden="true" />}
              <span>
                <b>{session.name}</b>
                <small>
                  Signed in {formatDate(session.createdAt)} · expires {formatDate(session.expiresAt)}
                </small>
              </span>
              {session.current ? (
                <span className="pill">This device</span>
              ) : (
                <button type="button" className="danger" disabled={action.pending} onClick={() => revoke(session.id)} aria-label={`Sign out ${session.name}`}>
                  Sign out
                </button>
              )}
            </li>
          ))}
        </ul>
      </SectionState>
    </Card>
  );
}

function ServerSection() {
  const { fixturePreview } = useSession();
  const settings = useResource((signal) => request("/admin/settings", adminSettingsSchema, { signal }), []);
  // Kept here so it survives the reload that follows a save.
  const [lidarrNotice, setLidarrNotice] = useState("");
  if (!settings.data)
    return (
      <SectionState loading={settings.loading} error={settings.error} empty retry={settings.reload} emptyText="">
        {null}
      </SectionState>
    );
  return (
    <fieldset className="stack plain" disabled={fixturePreview}>
      {fixturePreview && <Notice>The demo's server settings are read-only.</Notice>}
      <PlexServer settings={settings.data} saved={settings.reload} />
      <LidarrServer settings={settings.data} saved={settings.reload} notice={lidarrNotice} setNotice={setLidarrNotice} />
      <LastfmServer settings={settings.data} saved={settings.reload} />
      <NotificationsServer settings={settings.data} saved={settings.reload} />
    </fieldset>
  );
}

function PlexServer({ settings, saved }: { settings: AdminSettings; saved: () => void }) {
  const action = useAction();
  const section = useAction();
  const [done, setDone] = useState(false);
  const sections = useResource(
    (signal) => (settings.plexURL ? request("/admin/plex/sections", plexSectionsSchema, { signal }) : Promise.resolve(null)),
    [settings.plexURL],
  );
  const submit = (event: FormEvent<HTMLFormElement>) => {
    const value = formValues(event);
    const url = value("url").trim();
    if (
      settings.plexURL &&
      url !== settings.plexURL &&
      !confirm(
        url
          ? "If this address is a different Plex server, everyone's Plex sign-in is removed and they sign in again. Continue?"
          : "Switch Plex off for everyone? Libraries and playback stop until the address is saved again; everyone's Plex sign-in is kept.",
      )
    )
      return;
    setDone(false);
    void action.run(async () => {
      await send("/admin/settings/plex", "PUT", { url });
      setDone(true);
      saved();
    });
  };
  // A library re-created in Plex gets a new key: the saved one then matches no option.
  const missingSection =
    settings.plexSection && sections.data && !sections.data.items.some((item) => item.key === settings.plexSection) ? settings.plexSection : null;
  const choose = (key: string) =>
    void section.run(async () => {
      await send("/admin/settings/plex/section", "PUT", { key: key || null });
      saved();
    });
  return (
    <Card
      title="Plex server"
      description="The HTTPS address of your Plex Media Server. Each person then signs in with their own Plex account under Connections."
      badge={settings.plexURL && <Connected label="Configured" />}
    >
      <form className="formGrid" onSubmit={submit}>
        <Field
          label="Server address"
          name="url"
          type="url"
          placeholder="https://192-168-1-10.<id>.plex.direct:32400"
          defaultValue={settings.plexURL ?? ""}
          required={false}
          hint="HTTPS only: the server's plex.direct address or a reverse proxy. The deployment guide shows how to find it."
        />
        <button className="primary" aria-disabled={action.pending}>
          {action.pending ? "Checking Plex…" : "Save"}
        </button>
      </form>
      {done && !action.error && (
        <Notice>
          Saved. Now <Link to="/settings">sign in with your Plex account</Link>.
        </Notice>
      )}
      {action.error && <ErrorBox message={action.error} />}
      {settings.plexURL &&
        (sections.code === "plex_not_connected" ? (
          <p className="muted small">
            <Link to="/settings">Sign in with Plex</Link> to choose which music library Leerr uses.
          </p>
        ) : sections.error ? (
          <ErrorBox message={sections.error} retry={sections.reload} />
        ) : sections.data ? (
          <label className="field">
            <span>Music library</span>
            <select value={settings.plexSection ?? ""} onChange={(event) => choose(event.currentTarget.value)} aria-busy={section.pending}>
              <option value="">Automatic: the Plex Music library</option>
              {missingSection && <option value={missingSection}>Library {missingSection} (no longer in Plex)</option>}
              {sections.data.items.map((item) => (
                <option key={item.key} value={item.key}>
                  {item.title}
                  {item.agent === "tv.plex.agents.music" ? "" : " (not matched by Plex Music: requests cannot be recognised)"}
                </option>
              ))}
            </select>
            <small>Albums arrive in this library; Leerr matches them to requests by their MusicBrainz release.</small>
            {missingSection && (
              <ErrorBox message="The music library chosen here is no longer on the Plex server (a re-created library gets a new number), so libraries and requests fail. Choose another, or Automatic." />
            )}
          </label>
        ) : null)}
      {section.error && <ErrorBox message={section.error} />}
    </Card>
  );
}

function LidarrServer({
  settings,
  saved,
  notice,
  setNotice,
}: {
  settings: AdminSettings;
  saved: () => void;
  notice: string;
  setNotice: (notice: string) => void;
}) {
  const action = useAction();
  const [url, setURL] = useState(settings.lidarrURL ?? "");
  const [saves, setSaves] = useState(0);
  // The server normalises addresses; show what it stored.
  useEffect(() => setURL(settings.lidarrURL ?? ""), [settings.lidarrURL]);
  const options = useResource(
    (signal) => (settings.lidarrConfigured ? request("/admin/lidarr/options", lidarrOptionsSchema, { signal }) : Promise.resolve(null)),
    [settings.lidarrConfigured, settings.lidarrURL, saves],
  );
  const sameHost = settings.lidarrConfigured && url.trim() === settings.lidarrURL;
  // Only lists that belong to the saved host and are current: a reload in progress may be for a new host.
  const choosing = sameHost && !!options.data && !options.loading && !options.error;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    const value = formValues(event);
    const target = value("url").trim();
    setNotice("");
    const connection = { url: target, apiKey: value("apiKey").trim() };
    // Profiles are sent only when their fields are shown; otherwise the saved ones stay.
    const body = choosing
      ? {
          ...connection,
          rootFolderPath: value("rootFolderPath"),
          qualityProfileID: Number(value("qualityProfileID")) || 0,
          metadataProfileID: Number(value("metadataProfileID")) || 0,
        }
      : connection;
    void action.run(async () => {
      await send("/admin/settings/lidarr", "PUT", body);
      setNotice(
        !target
          ? "Lidarr disconnected."
          : sameHost
            ? "Lidarr settings saved."
            : "Connected. Now choose where albums go and which profiles to use, then save again.",
      );
      setSaves((count) => count + 1);
      saved();
    });
  };

  return (
    <Card
      title="Lidarr"
      description="Lidarr downloads requested albums. Find the API key in Lidarr under Settings → General → Security."
      badge={settings.lidarrConfigured && (settings.lidarrReady ? <Connected label="Ready" /> : <Warning label="Needs profiles" />)}
    >
      <form className="formGrid" onSubmit={submit}>
        <Field
          label="Server address"
          name="url"
          type="url"
          placeholder="https://lidarr.example.com"
          value={url}
          onChange={(event) => setURL(event.currentTarget.value)}
          required={false}
        />
        <Field
          label="API key"
          name="apiKey"
          type="password"
          autoComplete="off"
          required={!!url.trim() && !sameHost}
          placeholder={sameHost ? "Saved — leave blank to keep" : ""}
        />
        {settings.lidarrConfigured && sameHost && (
          <>
            {options.loading && <Spinner label="Loading Lidarr options…" />}
            {options.error && <ErrorBox message={`${options.error} The saved root folder and profiles are kept.`} retry={options.reload} />}
            {choosing && options.data && (
              <>
                <Select label="Root folder" name="rootFolderPath" value={settings.rootFolderPath ?? ""} options={options.data.roots.map((root) => [root.path, root.path])} />
                <Select
                  label="Quality profile"
                  name="qualityProfileID"
                  value={String(settings.qualityProfileID ?? "")}
                  options={options.data.qualities.map((option) => [String(option.id), option.name])}
                />
                <Select
                  label="Metadata profile"
                  name="metadataProfileID"
                  value={String(settings.metadataProfileID ?? "")}
                  options={options.data.metadata.map((option) => [String(option.id), option.name])}
                />
              </>
            )}
          </>
        )}
        {/* aria-disabled rather than disabled keeps keyboard focus on the button while saving. */}
        <button className="primary" aria-disabled={action.pending}>
          {action.pending ? "Checking Lidarr…" : "Save"}
        </button>
      </form>
      {notice && !action.error && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {action.error && <ErrorBox message={action.error} />}
    </Card>
  );
}

function Select({ label, name, value, options }: { label: string; name: string; value: string; options: Array<[string, string]> }) {
  return (
    <label className="field">
      <span>{label}</span>
      <select name={name} defaultValue={value} required>
        <option value="">Choose…</option>
        {options.map(([optionValue, text]) => (
          <option key={optionValue} value={optionValue}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );
}

function LastfmServer({ settings, saved }: { settings: AdminSettings; saved: () => void }) {
  const action = useAction();
  const [done, setDone] = useState("");
  const save = (apiKey: string) =>
    void action.run(async () => {
      await send("/admin/settings/lastfm", "PUT", { apiKey });
      setDone(apiKey ? "Saved. Members can now connect Last.fm with just a username." : "Removed.");
      saved();
    });
  return (
    <Card
      title="Last.fm for everyone"
      description={
        <>
          Optional: one{" "}
          <a href="https://www.last.fm/api/account/create" target="_blank" rel="noreferrer">
            Last.fm API key
          </a>{" "}
          for the whole server. People then connect Last.fm with only a username, search shows Last.fm cover art, and people without Last.fm get
          suggestions from the artists in their own library.
        </>
      }
      badge={settings.lastfmConfigured && <Connected label="Key saved" />}
    >
      <form
        className="formGrid"
        onSubmit={(event) => {
          const value = formValues(event);
          save(value("apiKey").trim());
        }}
      >
        <Field label="API key" name="apiKey" autoComplete="off" spellCheck={false} placeholder={settings.lastfmConfigured ? "Saved — enter a new key to replace it" : ""} />
        <button className="primary" disabled={action.pending}>
          {action.pending ? "Checking…" : "Save"}
        </button>
      </form>
      {settings.lastfmConfigured && (
        <button type="button" className="textButton" disabled={action.pending} onClick={() => save("")}>
          Remove the key
        </button>
      )}
      {done && !action.error && <Notice>{done}</Notice>}
      {action.error && <ErrorBox message={action.error} />}
    </Card>
  );
}

const formatNames: Record<(typeof notifyFormats)[number], string> = {
  ntfy: "ntfy topic",
  discord: "Discord webhook",
  json: "Other webhook (JSON)",
};

function NotificationsServer({ settings, saved }: { settings: AdminSettings; saved: () => void }) {
  const action = useAction();
  const test = useAction();
  const [done, setDone] = useState("");
  // A token is kept only with the saved address: a new address never inherits it.
  const [newAddress, setNewAddress] = useState(false);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    const value = formValues(event);
    setDone("");
    void action.run(async () => {
      await send("/admin/settings/notifications", "PUT", { url: value("url").trim(), format: value("format"), token: value("token").trim() });
      setDone("Saved.");
      saved();
    });
  };
  const turnOff = () =>
    void action.run(async () => {
      await send("/admin/settings/notifications", "PUT", { url: null, format: settings.notifyFormat });
      setDone("Notifications turned off.");
      saved();
    });
  return (
    <Card
      title="Notifications"
      description="Announce when a requested album arrives in Lidarr, fails, or needs an administrator. Messages name the album and who asked for it."
      badge={settings.notifyTarget && <Connected label={`On · ${settings.notifyTarget}`} />}
    >
      <form className="formGrid" onSubmit={submit}>
        <Field
          label="Address"
          name="url"
          type="url"
          placeholder={settings.notifyTarget ? "Saved — leave blank to keep" : "https://ntfy.sh/your-topic"}
          required={!settings.notifyTarget}
          hint={settings.notifyTarget ? "The saved address is not shown: for Discord and ntfy it works like a password." : undefined}
          onChange={(event) => setNewAddress(!!event.currentTarget.value.trim())}
        />
        <label className="field">
          <span>Kind</span>
          <select name="format" defaultValue={settings.notifyFormat}>
            {notifyFormats.map((format) => (
              <option key={format} value={format}>
                {formatNames[format]}
              </option>
            ))}
          </select>
        </label>
        <Field
          label="Access token"
          name="token"
          type="password"
          autoComplete="off"
          required={false}
          placeholder={settings.notifyTokenSet && !newAddress ? "Saved — leave blank to keep" : "Optional"}
          hint={
            settings.notifyTokenSet && newAddress
              ? "Enter the token again: a new address never gets the saved one."
              : "For a private ntfy server or webhook. Never sent to Discord."
          }
        />
        <button className="primary" aria-disabled={action.pending}>
          {action.pending ? "Saving…" : "Save"}
        </button>
      </form>
      {settings.notifyTarget && (
        <div className="rowActions start">
        <button type="button" className="danger" aria-disabled={action.pending} onClick={turnOff}>
          Turn off
        </button>
        <button
          type="button"
          className="secondary"
          aria-disabled={test.pending}
          onClick={() =>
            void test.run(async () => {
              await send("/admin/notifications/test", "POST");
              setDone("Test notification sent.");
            })
          }
        >
          {test.pending ? "Sending…" : "Send a test"}
        </button>
        </div>
      )}
      {done && !action.error && !test.error && <Notice>{done}</Notice>}
      {(action.error || test.error) && <ErrorBox message={action.error || test.error} />}
    </Card>
  );
}

/** Whom this tab is linking a Plex profile for, across Plex's round trip. */
const LINK_TARGET = "leerr.plexProfileFor";
function readLinkTarget(): string {
  try {
    return sessionStorage.getItem(LINK_TARGET) ?? "";
  } catch {
    return "";
  }
}
function saveLinkTarget(username: string) {
  try {
    sessionStorage.setItem(LINK_TARGET, username);
  } catch {
    // Only the "for whom" label is lost.
  }
}

function UsersSection() {
  const { user: me, refresh, fixturePreview } = useSession();
  const users = useResource((signal) => request("/admin/users", usersSchema, { signal }), []);
  const add = useAction();
  const update = useAction();
  const [added, setAdded] = useState("");
  const [resetting, setResetting] = useState<{ id: string; username: string } | null>(null);
  // Linking a managed Plex Home profile for someone, from the administrator's own device.
  const profileLink = usePlexLink("leerr.plexProfileLink", users.reload);
  const [linkingFor, setLinkingFor] = useState(() => readLinkTarget());
  const linkProfile = (id: string, username: string) => {
    if (profileLink.starting || fixturePreview) return;
    saveLinkTarget(username);
    setLinkingFor(username);
    profileLink.begin(`/admin/users/${encodeURIComponent(id)}/plex/links`);
  };
  const unlink = (id: string, username: string, plexName: string) => {
    if (update.pending) return;
    if (!confirm(`Unlink ${username} from ${plexName} in Plex? Their library and playback stop until a Plex account or profile is linked again.`))
      return;
    void update.run(async () => {
      await send(`/admin/users/${encodeURIComponent(id)}/plex`, "DELETE");
      users.reload();
    });
  };

  const create = (event: FormEvent<HTMLFormElement>) => {
    const form = event.currentTarget;
    const value = formValues(event);
    setAdded("");
    void add.run(async () => {
      await send("/admin/users", "POST", { username: value("username"), password: value("password"), role: value("role") });
      setAdded(value("username"));
      form.reset();
      users.reload();
    });
  };
  const patch = (id: string, body: { disabled?: boolean; role?: string }) =>
    void update.run(async () => {
      await send(`/admin/users/${id}`, "PATCH", body);
      users.reload();
      // A change to one's own role changes what this page may show.
      if (id === me.id) await refresh();
    });
  const toggleRole = (id: string, username: string, role: string) => {
    if (update.pending) return;
    if (id === me.id && role === "admin" && !confirm("Make yourself a member? You lose access to Server, Users, All requests and Status."))
      return;
    patch(id, { role: role === "admin" ? "member" : "admin" });
  };
  const toggleDisabled = (id: string, username: string, disabled: boolean) => {
    if (update.pending) return;
    if (!disabled && !confirm(`Disable ${username}? They are signed out on every device and their playback stops. You can enable them again later.`))
      return;
    patch(id, { disabled: !disabled });
  };

  return (
    <div className="stack">
      <Card title="People" description="Everyone gets their own requests and signs in with their own Plex account.">
        {update.error && <ErrorBox message={update.error} />}
        {(profileLink.following || profileLink.link || profileLink.error) && (
          <div className="stack">
            {linkingFor && <p className="muted small">Linking a Plex Home profile for {linkingFor}.</p>}
            <PlexLinkProgress
              flow={profileLink}
              forOther={linkingFor || "this person"}
              retry={() => {
                const target = users.data?.items.find((entry) => entry.username === linkingFor);
                if (target) linkProfile(target.id, target.username);
              }}
            />
          </div>
        )}
        <SectionState loading={users.loading} error={users.error} empty={!users.data?.items.length} retry={users.reload} emptyText="No users.">
          <ul className="rows">
            {users.data?.items.map((user) => (
              <li key={user.id} className={user.disabled ? "disabled" : ""}>
                <span className="avatar" aria-hidden="true">
                  {user.username.charAt(0).toUpperCase()}
                </span>
                <span>
                  <b>
                    {user.username}
                    {user.id === me.id ? " (you)" : ""}
                  </b>
                  <small>
                    {user.role === "admin" ? "Administrator" : "Member"} · joined {formatDate(user.createdAt)}
                    {user.disabled ? " · disabled" : ""}
                  </small>
                  <small>
                    {user.plex ? `Plays as ${user.plex.username} in Plex${user.plex.managed ? " (managed profile)" : ""}` : "Not signed in to Plex"}
                  </small>
                </span>
                <div className="rowActions">
                  <button
                    type="button"
                    className="secondary"
                    aria-disabled={profileLink.starting || fixturePreview}
                    onClick={() => linkProfile(user.id, user.username)}
                    aria-label={`Link a Plex Home profile for ${user.username}`}
                  >
                    Link Plex profile
                  </button>
                  {user.plex && (
                    <button
                      type="button"
                      className="secondary"
                      aria-disabled={update.pending || fixturePreview}
                      onClick={() => !fixturePreview && user.plex && unlink(user.id, user.username, user.plex.username)}
                      aria-label={`Unlink ${user.username} from Plex`}
                    >
                      Unlink Plex
                    </button>
                  )}
                  <button
                    type="button"
                    className="secondary"
                    aria-disabled={update.pending}
                    onClick={() => toggleRole(user.id, user.username, user.role)}
                    aria-label={user.role === "admin" ? `Make ${user.username} a member` : `Make ${user.username} an administrator`}
                  >
                    {user.role === "admin" ? "Make member" : "Make admin"}
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    aria-disabled={update.pending}
                    onClick={() => !update.pending && setResetting({ id: user.id, username: user.username })}
                    aria-label={`Set a new password for ${user.username}`}
                  >
                    New password
                  </button>
                  {user.id !== me.id && (
                    <button
                      type="button"
                      className={user.disabled ? "secondary" : "danger"}
                      aria-disabled={update.pending}
                      onClick={() => toggleDisabled(user.id, user.username, user.disabled)}
                      aria-label={`${user.disabled ? "Enable" : "Disable"} ${user.username}`}
                    >
                      {user.disabled ? "Enable" : "Disable"}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </SectionState>
      </Card>
      <Card title="Add someone">
        <form className="formGrid" onSubmit={create}>
          <fieldset disabled={add.pending}>
            <Field label="Username" name="username" autoComplete="off" autoCapitalize="none" pattern="[a-zA-Z0-9_.\-]+" />
            <Field label="Temporary password" name="password" type="password" autoComplete="new-password" minLength={10} hint="At least 10 characters." />
            <label className="field">
              <span>Role</span>
              <select name="role" defaultValue="member">
                <option value="member">Member</option>
                <option value="admin">Administrator</option>
              </select>
            </label>
            <button className="primary">{add.pending ? "Adding…" : "Add"}</button>
          </fieldset>
        </form>
        {added && !add.error && (
          <Notice>Added {added}. Share the temporary password with them privately; they can change it under Settings → Account.</Notice>
        )}
        {add.error && <ErrorBox message={add.error} />}
      </Card>
      {resetting && (
        <PasswordDialog
          title={resetting.id === me.id ? "Your new password" : `New password for ${resetting.username}`}
          description={
            resetting.id === me.id
              ? "Your other devices are signed out; this one stays signed in."
              : "Their devices are signed out, and a sign-in lock on their account is lifted."
          }
          submitLabel="Set password"
          close={() => setResetting(null)}
          submit={async ({ password }) => {
            await send(`/admin/users/${resetting.id}`, "PATCH", { password });
            users.reload();
          }}
        />
      )}
    </div>
  );
}

function AcquisitionsSection() {
  const acquisitions = useResource((signal) => request("/admin/acquisitions", acquisitionsSchema, { signal }), []);
  const action = useAction();
  const items = acquisitions.data?.items ?? [];
  const retry = (id: string) =>
    void action.run(async () => {
      await send(`/admin/acquisitions/${id}/retry`, "POST");
      acquisitions.reload();
    });
  const remove = (id: string, title: string) => {
    if (!confirm(`Stop tracking “${title}” and remove it from everyone's requests? Lidarr is not changed.`)) return;
    void action.run(async () => {
      await send(`/admin/acquisitions/${id}`, "DELETE");
      acquisitions.reload();
    });
  };
  return (
    <Card
      title="All requests"
      description="Every album requested on this server. “Needs attention” means Leerr couldn't confirm a change in Lidarr or a download is stuck: check Lidarr, then retry or remove it."
    >
      {action.error && <ErrorBox message={action.error} />}
      <SectionState
        loading={acquisitions.loading}
        error={acquisitions.error}
        empty={!items.length}
        retry={acquisitions.reload}
        stale
        emptyText="Nobody has requested anything yet."
      >
        <ul className="rows">
          {items.map((item) => (
            <li key={item.id}>
              <span>
                <b>
                  {item.title} <span className="muted">· {item.artist}</span>
                </b>
                <small>
                  {item.requesters} {item.requesters === 1 ? "person" : "people"} · changed {formatRelative(item.updatedAt)}
                  {item.reason ? ` · ${item.reason}` : ""}
                </small>
              </span>
              <div className="rowActions">
                <StatusBadge status={item.status} />
                {item.retryable && (
                  <button
                    type="button"
                    className="secondary"
                    disabled={action.pending}
                    onClick={() => retry(item.id)}
                    aria-label={`${item.status === "imported" ? "Check Lidarr again for" : "Retry"} ${item.title}`}
                  >
                    {item.status === "imported" ? "Re-check" : "Retry"}
                  </button>
                )}
                <button type="button" className="danger" disabled={action.pending} onClick={() => remove(item.id, item.title)} aria-label={`Remove ${item.title}`}>
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      </SectionState>
    </Card>
  );
}

function ProbeRow({ name, probe }: { name: string; probe: Probe }) {
  return (
    <li>
      <span>
        <b>{name}</b>
        <small>
          {probe.state === "ok"
            ? `Connected${probe.version ? ` · version ${probe.version}` : ""}${probe.latencyMs === null ? "" : ` · ${probe.latencyMs} ms`}`
            : probe.message}
        </small>
      </span>
      {probe.state === "ok" ? <Connected label="OK" /> : probe.state === "error" ? <Warning label="Problem" /> : <span className="pill">Not set up</span>}
    </li>
  );
}

function StatusSection() {
  const status = useResource((signal) => request("/admin/status", statusSchema, { signal }), []);
  const data = status.data;
  return (
    <div className="stack">
      <Card title="Services" description="Checked when this page loads.">
        <SectionState loading={status.loading} error={status.error} empty={!data} retry={status.reload} stale emptyText="">
          {data && (
            <ul className="rows">
              <ProbeRow name="Plex" probe={data.plex} />
              <ProbeRow name="Lidarr" probe={data.lidarr} />
              {data.lidarr.state === "ok" && !data.lidarrReady && (
                <li>
                  <span>
                    <b>Lidarr profiles</b>
                    <small>Choose a root folder and profiles under Server before requests can start.</small>
                  </span>
                  <Warning label="Missing" />
                </li>
              )}
            </ul>
          )}
        </SectionState>
        <button type="button" className="secondary" onClick={() => !status.loading && status.reload()} aria-disabled={status.loading}>
          {status.loading ? "Checking…" : "Check again"}
        </button>
      </Card>
      {data && (
        <>
          <Card title="Requests worker" description="Leerr checks Lidarr every 15 seconds.">
            <ul className="rows">
              <li>
                <span>
                  <b>Last pass</b>
                  <small>{data.worker.lastPassAt ? formatRelative(data.worker.lastPassAt) : "Not yet"}</small>
                </span>
              </li>
              {data.worker.lastError && (
                <li>
                  <span>
                    <b>Last problem</b>
                    <small>
                      {data.worker.lastError}
                      {data.worker.lastErrorAt ? ` · ${formatRelative(data.worker.lastErrorAt)}` : ""}
                    </small>
                  </span>
                  <Warning label="Error" />
                </li>
              )}
              <li>
                <span>
                  <b>Albums</b>
                  <small>
                    {data.acquisitions.requested} queued · {data.acquisitions.acquiring} downloading · {data.acquisitions.imported} imported ·{" "}
                    {data.acquisitions.failed} failed · {data.acquisitions.attention} need attention
                  </small>
                </span>
                {data.acquisitions.attention > 0 && <Link to="/settings/acquisitions">Review</Link>}
              </li>
              {data.worker.pendingChanges > 0 && (
                <li>
                  <span>
                    <b>Unconfirmed Lidarr changes</b>
                    <small>{data.worker.pendingChanges} waiting for Lidarr to confirm. Switching Lidarr is refused until they settle.</small>
                  </span>
                </li>
              )}
            </ul>
          </Card>
          <Card title="This server">
            <ul className="rows">
              <li>
                <span>
                  <b>Running since</b>
                  <small>{formatDate(data.startedAt)}</small>
                </span>
              </li>
              <li>
                <span>
                  <b>Playing now</b>
                  <small>
                    {data.streams} {data.streams === 1 ? "stream" : "streams"}
                  </small>
                </span>
              </li>
              <li>
                <span>
                  <b>Last backup</b>
                  <small>
                    {data.lastBackup
                      ? `${data.lastBackup.ok ? "Succeeded" : "Failed"} ${formatRelative(data.lastBackup.at)}`
                      : "No scheduled backups since this start. See LEERR_BACKUP_DIR in the deployment guide."}
                  </small>
                </span>
                {data.lastBackup && !data.lastBackup.ok && <Warning label="Failed" />}
              </li>
            </ul>
          </Card>
        </>
      )}
    </div>
  );
}
