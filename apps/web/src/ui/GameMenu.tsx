// Central full-screen game menu (Escape). A single overlay with a horizontal
// top nav (Map / Leaderboard / Economy / Inventory / Settings / Exit); each
// section is its own tab. Shortcut keys (M / K / B) open the menu straight on
// their tab. Rendering is paused while it's open (GameCanvas switches its
// frameloop off), so the last frame stays frozen behind the section overlays.
//
// This component owns only the nav bar plus the Settings and Exit sections.
// The Map / Economy / Leaderboard / Inventory sections are heavier screens
// kept mounted in the HUD; they self-gate on the active tab.

import { STYLES, VISUAL_STYLE_IDS, type VisualStyleId } from "../render/styles";
import { MenuTab, useGame } from "../state/game";
import { useSession } from "../state/session";

const TABS: { id: MenuTab; label: string; keycap?: string }[] = [
  { id: "map", label: "Map", keycap: "M" },
  { id: "leaderboard", label: "Leaderboard" },
  { id: "economy", label: "Economy", keycap: "K" },
  { id: "inventory", label: "Inventory", keycap: "B" },
  { id: "settings", label: "Settings" },
  { id: "exit", label: "Exit" },
];

export function GameMenu() {
  const menuOpen = useGame((s) => s.menuOpen);
  const menuTab = useGame((s) => s.menuTab);
  const openMenu = useGame((s) => s.openMenu);
  const closeMenu = useGame((s) => s.closeMenu);

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
      {menuTab === "settings" && <SettingsSection />}
      {menuTab === "exit" && <ExitSection />}
    </>
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

/** Exit: leave the round for character select, or log out entirely. Exiting
 * unmounts <Game />, which closes the connection and resets the sim. */
function ExitSection() {
  const closeOverlays = useGame((s) => s.closeOverlays);
  const exitToCharacters = useSession((s) => s.exitToCharacters);
  const logout = useSession((s) => s.logout);

  return (
    <div className="map-overlay menu-section">
      <div className="panel menu-panel">
        <h2 className="menu-title">EXIT</h2>
        <div className="menu-hint">LEAVE THE CITY</div>
        <button
          className="btn btn-ghost"
          onClick={() => {
            closeOverlays();
            exitToCharacters();
          }}
        >
          Exit to Character Select
        </button>
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
