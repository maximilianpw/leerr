import { useCallback, useEffect, useRef, useState, type DependencyList } from "react";
import { errorCode, errorMessage, isAbort, request, requestsSchema, sendInBackground } from "./api.ts";

export type Resource<T> = {
  data: T | null;
  error: string;
  /** The API error code behind `error`, e.g. "plex_not_connected". */
  code: string | null;
  loading: boolean;
  reload: () => void;
  /** Replaces the loaded data locally, e.g. after a successful write. */
  set: (value: T) => void;
};

/**
 * Loads data for the current dependencies. Stale responses are discarded and
 * in-flight requests are aborted when dependencies change or the view unmounts.
 */
export function useResource<T>(load: (signal: AbortSignal) => Promise<T>, dependencies: DependencyList): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [code, setCode] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);
  const loader = useRef(load);
  loader.current = load;
  const hasData = useRef(false);
  const shown = useRef<DependencyList | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    const previous = shown.current;
    shown.current = dependencies;
    const refresh = previous !== null && previous.length === dependencies.length && previous.every((value, at) => Object.is(value, dependencies[at]));
    // Refreshing what is on screen keeps a failed refresh's notice until one succeeds,
    // so the notice (and its focused "Try again") does not flicker away at each retry.
    if (!(refresh && hasData.current)) {
      setError("");
      setCode(null);
    }
    loader
      .current(controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return;
        hasData.current = true;
        setData(value);
        setError("");
        setCode(null);
      })
      .catch((cause: Error) => {
        if (controller.signal.aborted || isAbort(cause)) return;
        setError(errorMessage(cause));
        setCode(errorCode(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
    // The caller's dependencies decide when to reload.
  }, [...dependencies, version]);
  const reload = useCallback(() => setVersion((value) => value + 1), []);
  const set = useCallback((value: T) => {
    hasData.current = true;
    setData(value);
  }, []);
  return { data, error, code, loading, reload, set };
}

export type Action = {
  pending: boolean;
  error: string;
  run: (work: () => Promise<void>) => Promise<boolean>;
  clear: () => void;
};

/** Runs one write at a time; a second submit while pending is ignored. */
export function useAction(): Action {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const busy = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const run = useCallback(async (work: () => Promise<void>) => {
    if (busy.current) return false;
    busy.current = true;
    setPending(true);
    setError("");
    try {
      await work();
      return true;
    } catch (cause) {
      if (mounted.current) setError(errorMessage(cause));
      return false;
    } finally {
      busy.current = false;
      if (mounted.current) setPending(false);
    }
  }, []);
  const clear = useCallback(() => setError(""), []);
  return { pending, error, run, clear };
}

// Requests badge. What the person has seen is kept on the server, so nothing
// about their requests stays in a shared browser after they sign out.

const seenListeners = new Set<(seen: Map<string, string>) => void>();

/** Records the outcomes the Requests page just showed, clearing the badge for them. */
export function markRequestsSeen(items: Array<{ id: string; status: string; unseen: boolean }>) {
  const marks = items.flatMap((item) => (item.unseen ? [{ id: item.id, status: item.status }] : []));
  if (!marks.length) return;
  void sendInBackground("/requests/seen", { items: marks });
  const seen = new Map(marks.map((mark) => [mark.id, mark.status]));
  for (const listener of seenListeners) listener(seen);
}

/** How many requests arrived, failed or need attention since the Requests page last showed them. */
export function useRequestUpdates(enabled: boolean): number {
  const [items, setItems] = useState<Array<{ id: string; status: string; unseen: boolean }>>([]);
  // Listens even while disabled: leaving the Requests page must show the cleared count at once.
  useEffect(() => {
    const listener = (seen: Map<string, string>) =>
      setItems((previous) => previous.map((item) => (seen.get(item.id) === item.status ? { ...item, unseen: false } : item)));
    seenListeners.add(listener);
    return () => void seenListeners.delete(listener);
  }, []);
  useEffect(() => {
    if (!enabled) return;
    let controller = new AbortController();
    const poll = () => {
      if (document.visibilityState !== "visible") return;
      controller.abort();
      controller = new AbortController();
      request("/requests", requestsSchema, { signal: controller.signal })
        .then((value) => setItems(value.items))
        .catch(() => {
          // The badge is best effort; the Requests page shows errors.
        });
    };
    poll();
    // Every 5 minutes at most: each poll may walk the Plex library.
    const timer = setInterval(poll, 5 * 60_000);
    document.addEventListener("visibilitychange", poll);
    return () => {
      controller.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [enabled]);
  return enabled ? items.filter((item) => item.unseen).length : 0;
}
