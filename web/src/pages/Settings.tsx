import { Check, LogOut, Monitor, Smartphone } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import {
  acquisitionsSchema,
  adminSettingsSchema,
  connectionsSchema,
  lidarrOptionsSchema,
  request,
  send,
  sessionsSchema,
  usersSchema,
  type AdminSettings,
} from "../api.ts";
import { useAction, useResource } from "../hooks.ts";
import { Link } from "../router.tsx";
import { useSession } from "../session.tsx";
import { ErrorBox, Field, formatDate, formatRelative, Notice, SectionState, Spinner, StatusBadge } from "../ui.tsx";

const tabs = [
  { id: "connections", label: "Connections", admin: false },
  { id: "devices", label: "Devices", admin: false },
  { id: "server", label: "Server", admin: true },
  { id: "users", label: "Users", admin: true },
  { id: "acquisitions", label: "All requests", admin: true },
];

export function SettingsPage({ tab }: { tab: string }) {
  const { user, signOut } = useSession();
  const visible = tabs.filter((entry) => !entry.admin || user.role === "admin");
  const current = visible.find((entry) => entry.id === tab) ?? visible[0];
  return (
    <div className="page settingsPage">
      <header className="top">
        <div>
          <h1 tabIndex={-1}>Settings</h1>
          <p>
            Signed in as <b>{user.username}</b> ({user.role === "admin" ? "administrator" : "member"}).
          </p>
        </div>
        <button type="button" className="secondary" onClick={() => void signOut()}>
          <LogOut aria-hidden="true" /> Sign out
        </button>
      </header>
      <nav className="tabs" aria-label="Settings sections">
        {visible.map((entry) => (
          <Link
            key={entry.id}
            to={entry.id === "connections" ? "/settings" : `/settings/${entry.id}`}
            current={entry.id === current.id}
          >
            {entry.label}
          </Link>
        ))}
      </nav>
      {current.id === "connections" && <ConnectionsSection />}
      {current.id === "devices" && <DevicesSection />}
      {current.id === "server" && <ServerSection />}
      {current.id === "users" && <UsersSection />}
      {current.id === "acquisitions" && <AcquisitionsSection />}
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

function formValues(event: FormEvent<HTMLFormElement>) {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  return (name: string) => String(data.get(name) ?? "");
}

function ConnectionsSection() {
  const { user, fixturePreview } = useSession();
  const connections = useResource((signal) => request("/connections", connectionsSchema, { signal }), []);
  const jellyfin = useAction();
  const lastfm = useAction();
  const state = connections.data;
  if (!state) return <SectionState loading={connections.loading} error={connections.error} empty retry={connections.reload} emptyText="">{null}</SectionState>;

  const save = (action: typeof jellyfin, service: "jellyfin" | "lastfm") => (event: FormEvent<HTMLFormElement>) => {
    const form = event.currentTarget;
    const value = formValues(event);
    const secret = service === "jellyfin" ? "password" : "apiKey";
    void action.run(async () => {
      await send(`/connections/${service}`, "PUT", { username: value("username"), [secret]: value(secret) });
      form.reset();
      connections.reload();
    });
  };
  const disconnect = (action: typeof jellyfin, service: "jellyfin" | "lastfm") =>
    void action.run(async () => {
      await send(`/connections/${service}`, "DELETE");
      connections.reload();
    });

  return (
    <div className="stack">
      <Card
        title="Jellyfin"
        description="Your own Jellyfin account: Leerr shows exactly what it can see. Your password is only used to sign in; Leerr stores the resulting token, encrypted."
        badge={state.jellyfin && <Connected label={`Connected as ${state.jellyfin}`} />}
      >
        {!state.jellyfinConfigured ? (
          <p>
            {user.role === "admin" ? (
              <>
                First <Link to="/settings/server">set the Jellyfin server address</Link>.
              </>
            ) : (
              "An administrator needs to set up the Jellyfin server first."
            )}
          </p>
        ) : state.jellyfin ? (
          <button type="button" className="danger" disabled={jellyfin.pending} onClick={() => disconnect(jellyfin, "jellyfin")}>
            Disconnect Jellyfin
          </button>
        ) : (
          <form className="formGrid" onSubmit={save(jellyfin, "jellyfin")}>
            <fieldset disabled={fixturePreview || jellyfin.pending}>
              <Field label="Jellyfin username" name="username" autoComplete="off" />
              <Field label="Jellyfin password" name="password" type="password" autoComplete="off" required={false} />
              <button className="primary">{jellyfin.pending ? "Connecting…" : "Connect"}</button>
            </fieldset>
          </form>
        )}
        {jellyfin.error && <ErrorBox message={jellyfin.error} />}
      </Card>
      <Card
        title="Last.fm"
        description={
          <>
            Optional: personal suggestions and album art from your public listening history. Use an{" "}
            <a href="https://www.last.fm/api/account/create" target="_blank" rel="noreferrer">
              API key
            </a>
            , not your password.
          </>
        }
        badge={state.lastfm && <Connected label={`Connected as ${state.lastfm}`} />}
      >
        {state.lastfm ? (
          <button type="button" className="danger" disabled={lastfm.pending} onClick={() => disconnect(lastfm, "lastfm")}>
            Disconnect Last.fm
          </button>
        ) : (
          <form className="formGrid" onSubmit={save(lastfm, "lastfm")}>
            <fieldset disabled={fixturePreview || lastfm.pending}>
              <Field label="Last.fm username" name="username" autoComplete="off" />
              <Field label="API key" name="apiKey" autoComplete="off" spellCheck={false} />
              <button className="primary">{lastfm.pending ? "Checking…" : "Connect"}</button>
            </fieldset>
          </form>
        )}
        {lastfm.error && <ErrorBox message={lastfm.error} />}
      </Card>
      {!state.lidarrConfigured && (
        <Notice>
          Requests need Lidarr.{" "}
          {user.role === "admin" ? <Link to="/settings/server">Connect Lidarr</Link> : "Ask an administrator to connect it."}
        </Notice>
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
  if (!settings.data)
    return <SectionState loading={settings.loading} error={settings.error} empty retry={settings.reload} emptyText="">{null}</SectionState>;
  return (
    <fieldset className="stack plain" disabled={fixturePreview}>
      {fixturePreview && <Notice>The demo's server settings are read-only.</Notice>}
      <JellyfinServer settings={settings.data} saved={settings.reload} />
      <LidarrServer key={settings.data.lidarrURL ?? ""} settings={settings.data} saved={settings.reload} />
    </fieldset>
  );
}

function JellyfinServer({ settings, saved }: { settings: AdminSettings; saved: () => void }) {
  const action = useAction();
  const [done, setDone] = useState(false);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    const value = formValues(event);
    const url = value("url").trim();
    if (settings.jellyfinURL && url !== settings.jellyfinURL && !confirm("Changing the Jellyfin server disconnects every user's Jellyfin account. Continue?"))
      return;
    setDone(false);
    void action.run(async () => {
      await send("/admin/settings/jellyfin", "PUT", { url });
      setDone(true);
      saved();
    });
  };
  return (
    <Card
      title="Jellyfin server"
      description="The HTTPS address of your Jellyfin server. Each person then connects their own account under Connections."
      badge={settings.jellyfinURL && <Connected label="Configured" />}
    >
      <form className="formGrid" onSubmit={submit}>
        <Field label="Server address" name="url" type="url" placeholder="https://jellyfin.example.com" defaultValue={settings.jellyfinURL ?? ""} required={false} />
        <button className="primary" disabled={action.pending}>
          {action.pending ? "Saving…" : "Save"}
        </button>
      </form>
      {done && !action.error && (
        <Notice>
          Saved. Now <Link to="/settings">connect your Jellyfin account</Link>.
        </Notice>
      )}
      {action.error && <ErrorBox message={action.error} />}
    </Card>
  );
}

function LidarrServer({ settings, saved }: { settings: AdminSettings; saved: () => void }) {
  const action = useAction();
  const [url, setURL] = useState(settings.lidarrURL ?? "");
  const [done, setDone] = useState("");
  const options = useResource(
    (signal) =>
      settings.lidarrConfigured ? request("/admin/lidarr/options", lidarrOptionsSchema, { signal }) : Promise.resolve(null),
    [settings.lidarrConfigured, settings.lidarrURL],
  );
  const sameHost = settings.lidarrConfigured && url.trim() === settings.lidarrURL;
  const complete = !!settings.rootFolderPath && !!settings.qualityProfileID && !!settings.metadataProfileID;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    const value = formValues(event);
    setDone("");
    void action.run(async () => {
      await send("/admin/settings/lidarr", "PUT", {
        url: value("url").trim(),
        apiKey: value("apiKey").trim(),
        rootFolderPath: value("rootFolderPath"),
        qualityProfileID: Number(value("qualityProfileID")) || 0,
        metadataProfileID: Number(value("metadataProfileID")) || 0,
      });
      setDone(sameHost ? "Lidarr settings saved." : "Connected. Now choose where albums go and which profiles to use, then save again.");
      saved();
    });
  };

  return (
    <Card
      title="Lidarr"
      description="Lidarr downloads requested albums. Find the API key in Lidarr under Settings → General → Security."
      badge={settings.lidarrConfigured && <Connected label={complete ? "Ready" : "Needs profiles"} />}
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
            {options.error && <ErrorBox message={options.error} retry={options.reload} />}
            {options.data && (
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
        <button className="primary" disabled={action.pending}>
          {action.pending ? "Checking Lidarr…" : "Save"}
        </button>
      </form>
      {done && !action.error && <Notice>{done}</Notice>}
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

function UsersSection() {
  const { user: me } = useSession();
  const users = useResource((signal) => request("/admin/users", usersSchema, { signal }), []);
  const add = useAction();
  const update = useAction();
  const [added, setAdded] = useState("");

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
  const patch = (id: string, body: { disabled?: boolean; role?: string; password?: string }) =>
    void update.run(async () => {
      await send(`/admin/users/${id}`, "PATCH", body);
      users.reload();
    });
  const resetPassword = (id: string, name: string) => {
    const password = prompt(`New password for ${name} (at least 10 characters). Their devices will be signed out.`);
    if (password) patch(id, { password });
  };

  return (
    <div className="stack">
      <Card title="People" description="Everyone gets their own requests and connects their own Jellyfin account.">
        {update.error && <ErrorBox message={update.error} />}
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
                </span>
                <div className="rowActions">
                  <button
                    type="button"
                    className="secondary"
                    disabled={update.pending}
                    onClick={() => patch(user.id, { role: user.role === "admin" ? "member" : "admin" })}
                    aria-label={user.role === "admin" ? `Make ${user.username} a member` : `Make ${user.username} an administrator`}
                  >
                    {user.role === "admin" ? "Make member" : "Make admin"}
                  </button>
                  <button type="button" className="secondary" disabled={update.pending} onClick={() => resetPassword(user.id, user.username)} aria-label={`Set a new password for ${user.username}`}>
                    New password
                  </button>
                  {user.id !== me.id && (
                    <button
                      type="button"
                      className={user.disabled ? "secondary" : "danger"}
                      disabled={update.pending}
                      onClick={() => patch(user.id, { disabled: !user.disabled })}
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
        {added && !add.error && <Notice>Added {added}. Share the temporary password with them privately.</Notice>}
        {add.error && <ErrorBox message={add.error} />}
      </Card>
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
      description="Every album requested on this server. “Needs attention” means Leerr couldn't confirm a change in Lidarr: check Lidarr, then retry or remove it."
    >
      {action.error && <ErrorBox message={action.error} />}
      <SectionState loading={acquisitions.loading} error={acquisitions.error} empty={!items.length} retry={acquisitions.reload} emptyText="Nobody has requested anything yet.">
        <ul className="rows">
          {items.map((item) => (
            <li key={item.id}>
              <span>
                <b>
                  {item.title} <span className="muted">· {item.artist}</span>
                </b>
                <small>
                  {item.requesters} {item.requesters === 1 ? "person" : "people"} · updated {formatRelative(item.updatedAt)}
                  {item.reason ? ` · ${item.reason}` : ""}
                </small>
              </span>
              <div className="rowActions">
                <StatusBadge status={item.status} />
                {item.retryable && (
                  <button type="button" className="secondary" disabled={action.pending} onClick={() => retry(item.id)} aria-label={`Retry ${item.title}`}>
                    Retry
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
