import { create } from "zustand";
import { CharacterSummary } from "../net/protocol";

export type Screen = "boot" | "login" | "characters" | "game" | "assetlab";

const TOKEN_KEY = "wilder_token";
const USER_KEY = "wilder_user";
const GUEST_KEY = "wilder_guest";

/**
 * Throwaway guest identity. Stored in sessionStorage, which is scoped to a
 * single browser tab: it survives reloads (same runner returns) but is unique
 * per tab, so opening the site in a second tab spins up its own guest +
 * character instead of both tabs fighting over one identity (the server only
 * lets a character be "in world" once, so the second tab would otherwise error
 * with "character already in world"). Real, explicitly logged-in accounts stay
 * in localStorage and auto-resume across tabs.
 */
interface GuestCreds {
  username: string;
  password: string;
}

function loadGuest(): GuestCreds | null {
  try {
    const raw = sessionStorage.getItem(GUEST_KEY);
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
  // Prefer this tab's own guest identity; fall back to a real logged-in account.
  token: sessionStorage.getItem(TOKEN_KEY) ?? localStorage.getItem(TOKEN_KEY),
  username: sessionStorage.getItem(USER_KEY) ?? localStorage.getItem(USER_KEY),
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
    for (const store of [localStorage, sessionStorage]) {
      store.removeItem(TOKEN_KEY);
      store.removeItem(USER_KEY);
      store.removeItem(GUEST_KEY);
    }
    set({ token: null, username: null, screen: "login", activeCharacter: null });
  },

  bootstrap: async () => {
    try {
      // A real, explicitly logged-in account lives in localStorage (no guest
      // creds) and auto-resumes. Everything else uses a PER-TAB guest identity
      // in sessionStorage, so a second tab on the same machine gets its own
      // runner + character rather than colliding on one shared identity.
      const realToken = localStorage.getItem(TOKEN_KEY);
      const isRealAccount = !!realToken && !localStorage.getItem(GUEST_KEY);

      let token: string | null;
      let username: string | null;

      if (isRealAccount) {
        token = realToken;
        username = localStorage.getItem(USER_KEY);
      } else {
        // 1. Ensure a per-tab token: reuse this tab's, re-login its saved
        //    guest, or register a fresh guest identity for this tab.
        token = sessionStorage.getItem(TOKEN_KEY);
        username = sessionStorage.getItem(USER_KEY);
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
          sessionStorage.setItem(GUEST_KEY, JSON.stringify(creds));
          token = res.token;
          username = res.username;
        }
        sessionStorage.setItem(TOKEN_KEY, token);
        if (username) sessionStorage.setItem(USER_KEY, username);
      }
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
