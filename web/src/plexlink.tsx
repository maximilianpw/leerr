import { LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ApiError, errorCode, errorMessage, plexLinkSchema, plexLinkStartSchema, request, type PlexLink } from "./api.ts";
import { useAction } from "./hooks.ts";
import { navigate, useLocation } from "./router.tsx";
import { ErrorBox, Field, Notice } from "./ui.tsx";

type Problem = "expired" | "no_access" | "no_profiles" | "in_use";
const LOST = "Leerr lost track of this Plex sign-in (it restarted, or a newer sign-in replaced it). Start again.";
const FIRST_RETRY = 2_000;
const LAST_RETRY = 30_000;

/** Leerr or plex.tv not answering for a moment: the sign-in itself is fine, so it is asked about again. */
const passing = (cause: unknown) => cause instanceof ApiError && (cause.status === 0 || cause.status === 429 || cause.status >= 500);

function problem(state: Problem, forOther: string | null): string {
  if (state === "expired") return "The Plex sign-in expired before it was finished. Start again.";
  if (!forOther)
    return {
      no_access:
        "That Plex account cannot reach this Leerr's Plex server. Ask the server's owner to share its music library with it, or sign in with another account.",
      no_profiles: "That Plex Home has no managed profiles.",
      in_use: "That Plex account already belongs to another Leerr user. Each Plex account can be linked to one Leerr user.",
    }[state];
  return {
    no_access: `That Plex profile cannot reach this Leerr's Plex server. Give it access to the music library in Plex, then try again.`,
    no_profiles: `The Plex account you signed in with has no managed profiles. Sign in to Plex as a full member of the Plex Home that has ${forOther}'s profile (sign out at app.plex.tv first if Plex is signed in as someone else), or ask ${forOther} to sign in with their own Plex account.`,
    in_use: "That Plex profile already belongs to another Leerr user. Unlink it from them first, then try again.",
  }[state];
}

/**
 * A Plex sign-in this page started and follows. Leerr's server holds the
 * sign-in; this page only knows its opaque id, which Plex hands back on
 * return (`?plexLink=`) and `storageKey` keeps for this tab until the
 * sign-in ends, so a reload or another tab of Settings can pick it up again.
 */
export function usePlexLink(storageKey: string, linked: () => void) {
  const { query } = useLocation();
  const [linkID, setLinkID] = useState<string | null>(() => query.get("plexLink") ?? readKey(storageKey));
  const [link, setLink] = useState<PlexLink | null>(null);
  const [error, setError] = useState("");
  /** Leerr or plex.tv did not answer the last check; the next one comes after a pause. */
  const [retrying, setRetrying] = useState(false);
  const start = useAction();
  const choose = useAction();

  /** Ends following the sign-in in this tab, and says why when `message` is given. */
  const forget = useCallback(
    (message = "") => {
      writeKey(storageKey, null);
      setLinkID(null);
      setLink(null);
      setRetrying(false);
      setError(message);
    },
    [storageKey],
  );

  useEffect(() => {
    if (!linkID) return;
    let stopped = false;
    let timer = 0;
    let pause = FIRST_RETRY;
    writeKey(storageKey, linkID);
    // Plex's return address carries the sign-in's id: the tab keeps it instead of the address bar and history.
    if (new URLSearchParams(location.search).has("plexLink")) navigate(location.pathname, true);
    const check = async () => {
      try {
        const next = await request(`/connections/plex/links/${encodeURIComponent(linkID)}`, plexLinkSchema);
        if (stopped) return;
        setLink(next);
        setRetrying(false);
        pause = FIRST_RETRY;
        if (next.state === "waiting") timer = window.setTimeout(() => void check(), FIRST_RETRY);
        // A profile still to be chosen survives a reload: only an ended sign-in is forgotten.
        else if (next.state !== "choose_profile") {
          writeKey(storageKey, null);
          if (next.state === "linked") linked();
        }
      } catch (cause) {
        if (stopped) return;
        if (passing(cause)) {
          setRetrying(true);
          timer = window.setTimeout(() => void check(), pause);
          pause = Math.min(pause * 2, LAST_RETRY);
        } else forget(errorCode(cause) === "not_found" ? LOST : errorMessage(cause));
      }
    };
    void check();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [linkID, linked, storageKey, forget]);

  /** Starts a sign-in on Plex's page in this tab; Plex sends the person back here. */
  const begin = useCallback(
    (path: string) =>
      void start.run(async () => {
        // An earlier sign-in's result must not stand in for this one while it starts, or if it fails to.
        forget();
        choose.clear();
        const started = await request(path, plexLinkStartSchema, { method: "POST", body: "{}" });
        writeKey(storageKey, started.id);
        location.assign(started.authURL);
      }),
    [start, choose, forget, storageKey],
  );
  const pick = (uuid: string, pin: string) => {
    if (!linkID) return;
    const path = `/connections/plex/links/${encodeURIComponent(linkID)}`;
    void choose.run(async () => {
      try {
        const next = await request(`${path}/profile`, plexLinkSchema, { method: "POST", body: JSON.stringify({ uuid, pin }) });
        setLink(next);
        if (next.state !== "choose_profile") writeKey(storageKey, null);
        if (next.state === "linked") linked();
      } catch (cause) {
        if (errorCode(cause) === "not_found") return forget(LOST);
        // E.g. it expired while the profile was being chosen: show where it stands now.
        if (errorCode(cause) === "plex_link_state") {
          const now = await request(path, plexLinkSchema).catch(() => null);
          if (!now) return forget(LOST);
          setLink(now);
          if (now.state !== "choose_profile") writeKey(storageKey, null);
          return;
        }
        // A wrong PIN, or plex.tv not answering: the choice stays open.
        throw cause;
      }
    });
  };
  const cancel = () => {
    forget();
    start.clear();
    choose.clear();
  };
  const following = link?.state === "waiting" || (linkID !== null && !link);
  return {
    link,
    error: error || start.error,
    pickError: choose.error,
    retrying,
    following,
    starting: start.pending,
    choosing: choose.pending,
    begin,
    pick,
    cancel,
  };
}
export type PlexLinkFlow = ReturnType<typeof usePlexLink>;

/**
 * Where a sign-in stands: waiting, the managed-profile picker, or why it did
 * not work. `forOther` names the person an administrator is linking a profile for.
 */
export function PlexLinkProgress({ flow, retry, forOther = null }: { flow: PlexLinkFlow; retry: () => void; forOther?: string | null }) {
  const [profile, setProfile] = useState("");
  const { link } = flow;
  const cancel = (
    <button type="button" className="textButton" onClick={flow.cancel}>
      Cancel
    </button>
  );
  if (flow.following)
    return (
      <div className="notice" role="status">
        <p>
          <LoaderCircle className="spin" aria-hidden="true" /> Waiting for Plex. Approve the sign-in on Plex's page; this updates by itself.{" "}
          {cancel}
        </p>
        {flow.retrying && <p className="small">Plex or Leerr isn't answering right now. Still trying…</p>}
      </div>
    );
  if (link?.state === "choose_profile") {
    const chosen = link.profiles.find((candidate) => candidate.uuid === profile);
    const submit = (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (profile && !flow.choosing) flow.pick(profile, String(new FormData(event.currentTarget).get("pin") ?? ""));
    };
    return (
      <form className="formGrid" onSubmit={submit}>
        <fieldset className="plain" disabled={flow.choosing}>
          <legend>
            Signed in as {link.username}. Which managed profile is {forOther ? `${forOther}'s` : "this for"}?
          </legend>
          {link.profiles.map((candidate) => (
            <label key={candidate.uuid} className="choice">
              <input type="radio" name="profile" value={candidate.uuid} checked={profile === candidate.uuid} onChange={() => setProfile(candidate.uuid)} />
              {candidate.name}
            </label>
          ))}
          {chosen?.protected && <Field label="Profile PIN" name="pin" type="password" inputMode="numeric" autoComplete="off" pattern="[0-9]{4,8}" />}
        </fieldset>
        {flow.pickError && <ErrorBox message={flow.pickError} />}
        <p className="rowActions start">
          <button className="primary" aria-disabled={flow.choosing || !profile}>
            {flow.choosing ? "Linking…" : "Link this profile"}
          </button>
          {cancel}
        </p>
      </form>
    );
  }
  return (
    <>
      {link?.state === "linked" && <Notice>{forOther ? `${forOther} now plays as ${link.username} in Plex.` : `Linked to ${link.username} in Plex.`}</Notice>}
      {link && link.state !== "linked" && link.state !== "waiting" && <ErrorBox message={problem(link.state, forOther)} retry={retry} />}
      {flow.error && <ErrorBox message={flow.error} />}
    </>
  );
}

function readKey(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeKey(key: string, value: string | null) {
  try {
    if (value) sessionStorage.setItem(key, value);
    else sessionStorage.removeItem(key);
  } catch {
    // Without storage the sign-in still finishes while the page stays open.
  }
}
