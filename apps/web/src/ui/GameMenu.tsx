// Central full-screen game menu (Escape). A single overlay with a horizontal
// top nav (Map / Leaderboard / Economy / Inventory / Settings / Exit); each
// section is its own tab. Shortcut keys (M / K / B) open the menu straight on
// their tab. Rendering is paused while it's open (GameCanvas switches its
// frameloop off), so the last frame stays frozen behind the section overlays.
//
// This component owns only the nav bar plus the Settings and Exit sections.
// The Map / Economy / Leaderboard / Inventory sections are heavier screens
// kept mounted in the HUD; they self-gate on the active tab.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { CharacterSummary } from "../net/protocol";
import { cameraState } from "../render/CameraRig";
import { STYLES, VISUAL_STYLE_IDS, type VisualStyleId } from "../render/styles";
import { MenuTab, useGame } from "../state/game";
import { api, useSession } from "../state/session";

const TINTS = [0xffffff, 0x40e8ff, 0xff2d78, 0xffe14d, 0x39ff8e, 0xb64dff];

/** Pickable factions (ids/colors mirror the server registry). */
const FACTIONS: { id: number; label: string; color: string }[] = [
  { id: 1, label: "REBELS", color: "#40e8ff" },
  { id: 2, label: "THE FORUM", color: "#ff3860" },
  { id: 3, label: "WAPES", color: "#b45cff" },
];

function factionOf(id: number | undefined) {
  return FACTIONS.find((f) => f.id === (id ?? 1)) ?? FACTIONS[0];
}

// Sections with their own Escape listener: HoloMap closes the menu itself,
// and EconomyDashboard (economy + leaderboard) backs out of an item detail
// page before closing. Every other tab relies on GameMenu's handler below.
const SELF_HANDLED_ESCAPE: ReadonlySet<MenuTab> = new Set([
  "map",
  "economy",
  "leaderboard",
]);

const TABS: { id: MenuTab; label: string; keycap?: string }[] = [
  { id: "map", label: "Map", keycap: "M" },
  { id: "agents", label: "Agents" },
  { id: "leaderboard", label: "Leaderboard" },
  { id: "economy", label: "Economy", keycap: "K" },
  { id: "inventory", label: "Inventory", keycap: "B" },
  { id: "profile", label: "Profile" },
  { id: "settings", label: "Settings" },
  { id: "exit", label: "Logout" },
];

export function GameMenu() {
  const menuOpen = useGame((s) => s.menuOpen);
  const menuTab = useGame((s) => s.menuTab);
  const openMenu = useGame((s) => s.openMenu);
  const closeMenu = useGame((s) => s.closeMenu);

  // Escape closes the menu from any section that doesn't run its own Escape
  // handler (inventory, settings, exit).
  useEffect(() => {
    if (!menuOpen || SELF_HANDLED_ESCAPE.has(menuTab)) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      if (e.code === "Escape") {
        // Escape spent on closing the menu: don't let the relock/unlock
        // bounce read as an "open game menu" Escape (see CameraRig).
        cameraState.suppressMenuUntil = performance.now() + 1500;
        useGame.getState().closeMenu();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [menuOpen, menuTab]);

  if (!menuOpen) return null;

  return (
    <>
      <nav className="menu-nav">
        <div className="menu-nav-brand">WILDER</div>
        <div className="menu-nav-tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`menu-nav-item${menuTab === t.id ? " active" : ""}`}
              onClick={() => openMenu(t.id)}
            >
              {t.label}
              {t.keycap && <span className="menu-nav-key">{t.keycap}</span>}
            </button>
          ))}
        </div>
        <button className="menu-nav-close" onClick={closeMenu} title="Resume (ESC)">
          <span className="menu-nav-key">ESC</span>✕
        </button>
      </nav>
      {menuTab === "profile" && <ProfileSection />}
      {menuTab === "settings" && <SettingsSection />}
      {menuTab === "exit" && <ExitSection />}
    </>
  );
}

/** Profile: switch between runners, spin up a new one, or manage the account. */
function ProfileSection() {
  const token = useSession((s) => s.token);
  const username = useSession((s) => s.username);
  const activeCharacter = useSession((s) => s.activeCharacter);
  const enterGame = useSession((s) => s.enterGame);
  const goToLogin = useSession((s) => s.goToLogin);
  const logout = useSession((s) => s.logout);
  const closeOverlays = useGame((s) => s.closeOverlays);
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [tintIndex, setTintIndex] = useState(0);
  const [faction, setFaction] = useState(1);
  const [error, setError] = useState("");

  const characters = useQuery({
    queryKey: ["characters"],
    queryFn: () => api<CharacterSummary[]>("/api/characters", { token }),
    retry: false,
  });

  // Switching runner just sets the active character; <Game /> reconnects to
  // the new character id (its connection is keyed on token + character).
  const switchTo = (character: CharacterSummary) => {
    closeOverlays();
    enterGame(character);
  };

  const create = useMutation({
    mutationFn: (charName: string) =>
      api<CharacterSummary>("/api/characters", {
        method: "POST",
        token,
        body: {
          name: charName,
          appearance: { body: 0, tint: TINTS[tintIndex] },
          faction,
        },
      }),
    onSuccess: (character) => {
      setName("");
      setError("");
      queryClient.invalidateQueries({ queryKey: ["characters"] });
      switchTo(character);
    },
    onError: (e) => setError((e as Error).message),
  });

  return (
    <div className="map-overlay menu-section">
      <div className="panel menu-panel">
        <h2 className="menu-title">PROFILE</h2>
        <div className="menu-hint">SIGNED IN AS {username ?? "GUEST"}</div>

        {(characters.data ?? []).map((c) => {
          const active = c.id === activeCharacter?.id;
          return (
            <div
              key={c.id}
              className={`char-card${active ? " active" : ""}`}
              onClick={() => !active && switchTo(c)}
            >
              <div>
                <div className="char-name">{c.name}</div>
                <div className="char-level">
                  {active ? "Active" : `Level ${c.level}`}
                  {" · "}
                  <span style={{ color: factionOf(c.faction).color }}>
                    {factionOf(c.faction).label}
                  </span>
                </div>
              </div>
              <div
                style={{
                  width: 18,
                  height: 18,
                  borderRadius: 9,
                  background: `#${c.appearance.tint.toString(16).padStart(6, "0")}`,
                  boxShadow: "0 0 10px rgba(255,255,255,0.25)",
                }}
              />
            </div>
          );
        })}

        <div style={{ marginTop: 18 }}>
          <input
            className="field"
            placeholder="New runner name"
            value={name}
            maxLength={20}
            onChange={(e) => setName(e.target.value)}
          />
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            {TINTS.map((tint, i) => (
              <div
                key={tint}
                onClick={() => setTintIndex(i)}
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: 13,
                  cursor: "pointer",
                  background: `#${tint.toString(16).padStart(6, "0")}`,
                  border: i === tintIndex ? "2px solid #fff" : "2px solid transparent",
                }}
              />
            ))}
          </div>
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            {FACTIONS.map((f) => (
              <button
                key={f.id}
                className="btn btn-ghost"
                onClick={() => setFaction(f.id)}
                style={{
                  flex: 1,
                  color: f.color,
                  borderColor: faction === f.id ? f.color : undefined,
                  opacity: faction === f.id ? 1 : 0.55,
                }}
              >
                {f.label}
              </button>
            ))}
          </div>
          <div className="error">{error}</div>
          <button
            className="btn btn-primary"
            disabled={name.trim().length < 2 || create.isPending}
            onClick={() => create.mutate(name.trim())}
          >
            CREATE RUNNER
          </button>
          <button className="btn btn-ghost" onClick={() => { closeOverlays(); goToLogin(); }}>
            Sign in / Register
          </button>
          <button className="btn btn-ghost" onClick={() => { closeOverlays(); logout(); }}>
            Log Out
          </button>
        </div>
      </div>
    </div>
  );
}

/** Settings: music + visual style (moved here from the HUD comms controls). */
function SettingsSection() {
  const musicOn = useGame((s) => s.musicOn);
  const setMusicOn = useGame((s) => s.setMusicOn);
  const visualStyle = useGame((s) => s.visualStyle);
  const setVisualStyle = useGame((s) => s.setVisualStyle);

  return (
    <div className="map-overlay menu-section">
      <div className="panel menu-panel">
        <h2 className="menu-title">SETTINGS</h2>
        <div className="menu-setting-row">
          <span className="menu-setting-label">Music</span>
          <button
            className={`btn btn-ghost${musicOn ? " on" : ""}`}
            onClick={() => setMusicOn(!musicOn)}
          >
            {musicOn ? "ON" : "OFF"}
          </button>
        </div>
        <div className="menu-setting-row">
          <span className="menu-setting-label">Visual style</span>
          <select
            className="style-picker"
            value={visualStyle}
            onChange={(e) => setVisualStyle(e.target.value as VisualStyleId)}
          >
            {VISUAL_STYLE_IDS.map((id) => (
              <option key={id} value={id}>
                {STYLES[id].label}
              </option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}

/** Logout: leave the world entirely. Logging out unmounts <Game />, which
 * closes the connection and resets the sim. Runner switching lives in Profile. */
function ExitSection() {
  const closeOverlays = useGame((s) => s.closeOverlays);
  const logout = useSession((s) => s.logout);

  return (
    <div className="map-overlay menu-section">
      <div className="panel menu-panel">
        <h2 className="menu-title">LOG OUT</h2>
        <div className="menu-hint">LEAVE THE CITY</div>
        <button
          className="btn btn-ghost"
          onClick={() => {
            closeOverlays();
            logout();
          }}
        >
          Log Out
        </button>
      </div>
    </div>
  );
}
