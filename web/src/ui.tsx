import { Disc3, LoaderCircle, Music2 } from "lucide-react";
import { useState, type InputHTMLAttributes, type ReactNode } from "react";
import type { RequestStatus } from "./api.ts";

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

/** Loading, error and empty states around a section's content. */
export function SectionState({
  loading,
  error,
  empty,
  retry,
  emptyTitle = "Nothing here yet",
  emptyText,
  skeleton,
  children,
}: {
  loading: boolean;
  error: string;
  empty: boolean;
  retry: () => void;
  emptyTitle?: string;
  emptyText: ReactNode;
  skeleton?: ReactNode;
  children: ReactNode;
}) {
  if (loading && empty) return <>{skeleton ?? <Spinner />}</>;
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
        <h3>{emptyTitle}</h3>
        <p>{emptyText}</p>
      </div>
    );
  return <>{children}</>;
}

/** Cover art with an ordered list of sources; falls back to a placeholder. */
export function Artwork({ sources, className = "" }: { sources: string[]; className?: string }) {
  const [failed, setFailed] = useState<string[]>([]);
  const [loaded, setLoaded] = useState("");
  const url = sources.find((source) => source && !failed.includes(source)) ?? "";
  return (
    <div className={`artwork ${url && loaded === url ? "ready" : ""} ${className}`}>
      {url && (
        <img
          key={url}
          src={url}
          alt=""
          loading="lazy"
          decoding="async"
          onLoad={() => setLoaded(url)}
          onError={() => setFailed((previous) => [...previous, url])}
        />
      )}
      <Disc3 aria-hidden="true" />
    </div>
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

export function StatusBadge({ status }: { status: RequestStatus }) {
  return <span className={`status status-${status}`}>{statusLabels[status]}</span>;
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
