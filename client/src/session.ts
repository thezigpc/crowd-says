import { createSessionStore } from "@bargames/gamekit/client";
import type { Role } from "@crowdsays/shared";

export interface StoredSession {
  roomCode: string;
  token: string;
  name: string;
  role: Role;
}

// The kit's session store: the seat is per tab (hosting in one tab and opening the TV view in
// another don't overwrite each other) and survives a phone evicting a background tab.
export const sessions = createSessionStore<StoredSession>("crowdsays");

export const loadSession = (): StoredSession | null => sessions.load();
export const saveSession = (s: StoredSession): void => sessions.save(s);
export const clearSession = (): void => sessions.clear();

/** Last name typed on this device, to prefill the join form. */
export const lastName = (): string => sessions.pref("last_name");
export const rememberName = (name: string): void => sessions.setPref("last_name", name);

/** The host showing the TV board on their own screen, per room. */
export const getBoardHere = (code: string): boolean => sessions.pref(`board:${code}`) === "1";
export const setBoardHere = (code: string, on: boolean): void => sessions.setPref(`board:${code}`, on ? "1" : null);
