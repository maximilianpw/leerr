import { createContext, useContext } from "react";
import type { User } from "./api.ts";

export type Session = {
  user: User;
  fixturePreview: boolean;
  signOut: () => Promise<void>;
};

export const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error("useSession needs a signed-in view.");
  return session;
}
