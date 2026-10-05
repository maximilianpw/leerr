import { Disc3, LoaderCircle, Music2, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type InputHTMLAttributes, type ReactNode } from "react";
import type { RequestStatus } from "./api.ts";
import { useAction } from "./hooks.ts";

/** The browser tab's title; React hoists it into <head>. */
export function Title({ text }: { text: string }) {
  return <title>{text ? `${text} – Leerr` : "Leerr"}</title>;
}

export function Brand() {
  return (
    <div className="brand">
      <div className="brandMark">
        <Music2 aria-hidden="true" />
      </div>
      <strong>leerr</strong>
    </div>
  );
}

export function Spinner({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="state small" role="status">
      <LoaderCircle className="spin" aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </div>
  );
}

export function ErrorBox({ message, retry }: { message: string; retry?: () => void }) {
  return (
    <div className="error" role="alert">
      <span>{message}</span>
      {retry && (
        <button type="button" className="textButton" onClick={retry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function Notice({ children }: { children: ReactNode }) {
  return (
    <p className="notice" role="status">
      {children}
    </p>
  );
}

export function Field({ label, hint, ...input }: { label: string; hint?: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="field">
      <span>{label}</span>
      <input required {...input} />
      {hint && <small>{hint}</small>}
    </label>
  );
}

/**
 * Loading, error and empty states around a section's content. With `stale`,
 * a failed refresh keeps showing what was loaded, with a small notice.
 */
export function SectionState({
  loading,
  error,
  empty,
  retry,
  emptyTitle = "Nothing here yet",
  emptyText,
  skeleton,
  stale = false,
  children,
}: {
  loading: boolean;
  error: string;
  empty: boolean;
  retry: () => void;
  emptyTitle?: string;
  emptyText: ReactNode;
  skeleton?: ReactNode;
  stale?: boolean;
  children: ReactNode;
}) {
  if (loading && empty) return <>{skeleton ?? <Spinner />}</>;
  if (error && !(stale && !empty))
    return (
      <div className="state">
        <ErrorBox message={error} retry={retry} />
      </div>
    );
  if (empty)
    return (
      <div className="state">
        <Disc3 aria-hidden="true" />
        <h3>{emptyTitle}</h3>
        <p>{emptyText}</p>
      </div>
    );
  // The same structure with or without a failed refresh: the loaded content keeps
  // its identity (and focus), and the notice is a live region that is already there.
  return (
    <>
      {stale && (
        <p className={error ? "staleNotice" : "staleNotice idle"} role="status">
          {error ? (
            <>
              Couldn't refresh ({error}) Showing the last update.{" "}
              <button type="button" className="textButton" onClick={retry}>
                Try again
              </button>
            </>
          ) : null}
        </p>
      )}
      <div aria-busy={loading} className={loading ? "refreshing" : undefined}>
        {children}
      </div>
    </>
  );
}

/** Whether keyboard focus was lost (to the page body or a removed element). */
export function focusLost(): boolean {
  const active = document.activeElement;
  return !active || active === document.body || !active.isConnected;
}

const RETRY_DELAY = 4_000;

/**
 * Cover art from an ordered list of sources, falling back to a placeholder.
 * A failed source is retried once after a pause (e.g. after a brief rate
 * limit) before the next one is tried.
 */
export function Artwork({ sources, className = "" }: { sources: string[]; className?: string }) {
  const [failed, setFailed] = useState<string[]>([]);
  const [retried, setRetried] = useState<string[]>([]);
  const [waiting, setWaiting] = useState("");
  const [loaded, setLoaded] = useState("");
  const url = sources.find((source) => source && !failed.includes(source)) ?? "";
  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(() => {
      setRetried((previous) => [...previous, waiting]);
      setWaiting("");
    }, RETRY_DELAY);
    return () => clearTimeout(timer);
  }, [waiting]);
  const attempt = retried.includes(url) ? `${url}${url.includes("?") ? "&" : "?"}retry=1` : url;
  return (
    <div className={`artwork ${url && loaded === url ? "ready" : ""} ${className}`}>
      {url && waiting !== url && (
        <img
          key={attempt}
          src={attempt}
          alt=""
          loading="lazy"
          decoding="async"
          onLoad={() => setLoaded(url)}
          onError={() => {
            // Only our own artwork is worth a second try; other hosts fall through at once.
            if (!retried.includes(url) && url.startsWith("/")) setWaiting(url);
            else setFailed((previous) => [...previous, url]);
          }}
        />
      )}
      <Disc3 aria-hidden="true" />
    </div>
  );
}

/** A small modal form for choosing a new password, masked and confirmed. */
export function PasswordDialog({
  title,
  description,
  submitLabel,
  current = false,
  close,
  submit,
}: {
  title: string;
  description: string;
  submitLabel: string;
  current?: boolean;
  close: () => void;
  submit: (values: { current: string; password: string }) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const action = useAction();
  const [mismatch, setMismatch] = useState(false);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const value = (name: string) => String(data.get(name) ?? "");
    if (value("password") !== value("confirm")) {
      setMismatch(true);
      return;
    }
    setMismatch(false);
    void action.run(async () => {
      await submit({ current: value("current"), password: value("password") });
      dialog.current?.close();
    });
  };
  return (
    <dialog ref={dialog} className="modal" aria-labelledby="password-title" onClose={close}>
      <button type="button" className="iconButton modalClose" aria-label="Close" onClick={() => dialog.current?.close()}>
        <X aria-hidden="true" />
      </button>
      <h2 id="password-title">{title}</h2>
      <p className="muted">{description}</p>
      <form className="dialogForm" onSubmit={onSubmit}>
        <fieldset disabled={action.pending}>
          {current && <Field label="Current password" name="current" type="password" autoComplete="current-password" />}
          <Field label="New password" name="password" type="password" autoComplete="new-password" minLength={10} hint="At least 10 characters." />
          <Field label="Repeat the new password" name="confirm" type="password" autoComplete="new-password" minLength={10} />
        </fieldset>
        {mismatch && <ErrorBox message="The two passwords are different." />}
        {action.error && <ErrorBox message={action.error} />}
        {/* Not disabled while saving: a disabled button would drop keyboard focus. */}
        <button className="primary wide" aria-disabled={action.pending}>
          {action.pending ? "Saving…" : submitLabel}
        </button>
      </form>
    </dialog>
  );
}

export function ArtSkeleton({ count = 12 }: { count?: number }) {
  return (
    <>
      <p className="sr-only" role="status">
        Loading…
      </p>
      <div className="artGrid" aria-hidden="true">
        {Array.from({ length: count }, (_, index) => (
          <div className="artCard skeleton" key={index}>
            <div className="artwork" />
            <div className="artMeta">
              <b />
              <small />
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

export const statusLabels: Record<RequestStatus, string> = {
  requested: "Queued",
  acquiring: "Downloading",
  imported: "Imported",
  available: "In your library",
  failed: "Failed",
  attention: "Needs attention",
};
const stages: RequestStatus[] = ["requested", "acquiring", "imported", "available"];

/** A request's place on its way to the library, for people using screen readers too. */
export const statusDescriptions: Record<RequestStatus, string> = {
  requested: "Queued for Lidarr",
  acquiring: "Lidarr is searching or downloading",
  imported: "In Lidarr; appears after Plex scans",
  available: "Ready to play",
  failed: "Failed",
  attention: "Needs attention",
};

export function StatusBadge({ status }: { status: RequestStatus }) {
  return (
    <span className={`status status-${status}`} title={statusDescriptions[status]}>
      {statusLabels[status]}
    </span>
  );
}

export function Progress({ status }: { status: RequestStatus }) {
  const reached = stages.indexOf(status);
  return (
    <div className={`progress ${reached < 0 ? "stalled" : ""}`} aria-hidden="true">
      {stages.map((stage, index) => (
        <span key={stage} className={index <= reached ? "done" : ""} />
      ))}
    </div>
  );
}

export function formatDuration(seconds: number | null | undefined): string {
  if (!seconds || !Number.isFinite(seconds)) return "—";
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = String(whole % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function formatRelative(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return formatDate(iso);
}
