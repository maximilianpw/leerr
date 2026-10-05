import { createContext, useContext } from "react";
import type { User } from "./api.ts";

export type Session = {
  user: User;
  fixturePreview: boolean;
  /** Ends the session on the server; rejects (and stays signed in) if that failed. */
  signOut: () => Promise<void>;
  /** Re-reads who is signed in, e.g. after a role change. */
  refresh: () => Promise<void>;
};

export const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error("useSession needs a signed-in view.");
  return session;
}
