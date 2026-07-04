import { create } from "zustand";
import { CharacterSummary } from "../net/protocol";

export type Screen = "boot" | "login" | "characters" | "game" | "assetlab";

const TOKEN_KEY = "wilder_token";
const USER_KEY = "wilder_user";
const GUEST_KEY = "wilder_guest";

/** Throwaway guest identity, persisted so the same runner returns on reload. */
interface GuestCreds {
  username: string;
  password: string;
}

function loadGuest(): GuestCreds | null {
  try {
    const raw = localStorage.getItem(GUEST_KEY);
    return raw ? (JSON.parse(raw) as GuestCreds) : null;
  } catch {
    return null;
  }
}

/** Random alphanumeric string of `n` chars (guest handles + passwords). */
function randToken(n: number): string {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => (b % 36).toString(36)).join("");
}

const TINTS = [0xffffff, 0x40e8ff, 0xff2d78, 0xffe14d, 0x39ff8e, 0xb64dff];

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
  /** Show the login/register screen (e.g. to claim a real account). */
  goToLogin: () => void;
  logout: () => void;
  /** Auto-authenticate as a guest and drop straight into the world. */
  bootstrap: () => Promise<void>;
}

export const useSession = create<SessionState>((set, get) => ({
  token: localStorage.getItem(TOKEN_KEY),
  username: localStorage.getItem(USER_KEY),
  screen: "boot",
  characters: [],
  activeCharacter: null,

  setAuth: (token, username) => {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, username);
    set({ token, username, screen: "characters" });
  },
  setCharacters: (characters) => set({ characters }),
  enterGame: (character) => set({ activeCharacter: character, screen: "game" }),
  exitToCharacters: () => set({ activeCharacter: null, screen: "characters" }),
  enterAssetLab: () => set({ screen: "assetlab" }),
  exitAssetLab: () => set({ screen: "login" }),
  goToLogin: () => set({ activeCharacter: null, screen: "login" }),
  logout: () => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    localStorage.removeItem(GUEST_KEY);
    set({ token: null, username: null, screen: "login", activeCharacter: null });
  },

  bootstrap: async () => {
    try {
      // 1. Ensure a token: reuse a stored one, re-login a saved guest, or
      //    register a fresh guest identity.
      let token = get().token;
      let username = get().username;
      if (!token) {
        const guest = loadGuest();
        if (guest) {
          const res = await api<AuthResponse>("/api/login", {
            method: "POST",
            body: { username: guest.username, password: guest.password },
          }).catch(() => null);
          if (res) {
            token = res.token;
            username = res.username;
          }
        }
      }
      if (!token) {
        const creds: GuestCreds = {
          username: `runner_${randToken(8)}`,
          password: randToken(16),
        };
        const res = await api<AuthResponse>("/api/register", {
          method: "POST",
          body: creds,
        });
        localStorage.setItem(GUEST_KEY, JSON.stringify(creds));
        token = res.token;
        username = res.username;
      }
      localStorage.setItem(TOKEN_KEY, token);
      if (username) localStorage.setItem(USER_KEY, username);
      set({ token, username });

      // 2. Ensure a character, then drop straight in.
      let characters = await api<CharacterSummary[]>("/api/characters", { token });
      if (characters.length === 0) {
        const tint = TINTS[Math.floor(Math.random() * TINTS.length)];
        const created = await api<CharacterSummary>("/api/characters", {
          method: "POST",
          token,
          body: { name: "Runner", appearance: { body: 0, tint } },
        });
        characters = [created];
      }
      set({ characters });
      get().enterGame(characters[0]);
    } catch {
      // Anything failed: fall back to the manual login screen.
      set({ screen: "login" });
    }
  },
}));

interface AuthResponse {
  token: string;
  username: string;
}

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
