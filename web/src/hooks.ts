import { useCallback, useEffect, useRef, useState, type DependencyList } from "react";
import { errorMessage, isAbort } from "./api.ts";

export type Resource<T> = {
  data: T | null;
  error: string;
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
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);
  const loader = useRef(load);
  loader.current = load;
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    loader
      .current(controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setData(value);
      })
      .catch((cause: Error) => {
        if (!controller.signal.aborted && !isAbort(cause)) setError(errorMessage(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
    // The caller's dependencies decide when to reload.
  }, [...dependencies, version]);
  const reload = useCallback(() => setVersion((value) => value + 1), []);
  return { data, error, loading, reload, set: setData };
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
