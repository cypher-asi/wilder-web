import { create } from "zustand";
import { CharacterSummary } from "../net/protocol";

export type Screen = "login" | "characters" | "game" | "assetlab";

interface SessionState {
  token: string | null;
  username: string | null;
  screen: Screen;
  characters: CharacterSummary[];
  activeCharacter: CharacterSummary | null;

  setAuth: (token: string, username: string) => void;
  setCharacters: (chars: CharacterSummary[]) => void;
  enterGame: (character: CharacterSummary) => void;
  /** Leave the game world and return to the character picker. */
  exitToCharacters: () => void;
  enterAssetLab: () => void;
  exitAssetLab: () => void;
  logout: () => void;
}

export const useSession = create<SessionState>((set) => ({
  token: sessionStorage.getItem("wilder_token"),
  username: sessionStorage.getItem("wilder_user"),
  screen: sessionStorage.getItem("wilder_token") ? "characters" : "login",
  characters: [],
  activeCharacter: null,

  setAuth: (token, username) => {
    sessionStorage.setItem("wilder_token", token);
    sessionStorage.setItem("wilder_user", username);
    set({ token, username, screen: "characters" });
  },
  setCharacters: (characters) => set({ characters }),
  enterGame: (character) => set({ activeCharacter: character, screen: "game" }),
  exitToCharacters: () => set({ activeCharacter: null, screen: "characters" }),
  enterAssetLab: () => set({ screen: "assetlab" }),
  exitAssetLab: () => set({ screen: "login" }),
  logout: () => {
    sessionStorage.removeItem("wilder_token");
    sessionStorage.removeItem("wilder_user");
    set({ token: null, username: null, screen: "login", activeCharacter: null });
  },
}));

export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown; token?: string | null } = {},
): Promise<T> {
  const res = await fetch(path, {
    method: options.method ?? "GET",
    headers: {
      "content-type": "application/json",
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return data as T;
}
