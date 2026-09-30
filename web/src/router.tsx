import { useSyncExternalStore, type MouseEvent, type ReactNode } from "react";

const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};
window.addEventListener("popstate", notify);

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
const snapshot = () => `${location.pathname}${location.search}`;

/** Current path and query, re-rendering on navigation. */
export function useLocation() {
  const href = useSyncExternalStore(subscribe, snapshot);
  const url = new URL(href, location.origin);
  return { path: url.pathname, query: url.searchParams, href };
}

export function navigate(to: string, replace = false) {
  if (to === snapshot()) return;
  if (replace) history.replaceState(null, "", to);
  else history.pushState(null, "", to);
  window.scrollTo(0, 0);
  notify();
}

/** Matches `/albums/:id`-style patterns, returning decoded parameters. */
export function match(pattern: string, path: string): Map<string, string> | null {
  const expected = pattern.split("/");
  const actual = path.replace(/\/+$/, "").split("/");
  if (expected.length !== actual.length) return null;
  const parameters = new Map<string, string>();
  for (const [index, part] of expected.entries()) {
    if (part.startsWith(":")) parameters.set(part.slice(1), decodeURIComponent(actual[index]));
    else if (part !== actual[index]) return null;
  }
  return parameters;
}

export function Link({
  to,
  className,
  children,
  label,
  current,
}: {
  to: string;
  className?: string;
  children: ReactNode;
  label?: string;
  current?: boolean;
}) {
  const click = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return;
    event.preventDefault();
    navigate(to);
  };
  return (
    <a href={to} className={className} onClick={click} aria-label={label} aria-current={current ? "page" : undefined}>
      {children}
    </a>
  );
}
