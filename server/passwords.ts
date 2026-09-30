import { argon2id, hash, verify } from "argon2";
import { opaque } from "./store.ts";

export const hashPassword = (password: string) =>
  hash(password, { type: argon2id, memoryCost: 65_536, timeCost: 3, parallelism: 1 });

let dummy: Promise<string> | null = null;

/** Verifies against a throwaway hash when the user does not exist, so timing does not reveal usernames. */
export function verifyPassword(stored: string | undefined, password: string): Promise<boolean> {
  if (stored) return verify(stored, password);
  dummy ??= hashPassword(opaque());
  return dummy.then((value) => verify(value, password)).then(() => false);
}
