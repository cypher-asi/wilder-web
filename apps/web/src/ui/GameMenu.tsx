// Pause / game menu (Escape). Rendering is paused while open (GameCanvas
// switches its frameloop off); the last frame stays visible behind the dim
// backdrop. Exit/logout simply switch screens — unmounting <Game /> closes
// the connection and resets the sim.

import { useGame } from "../state/game";
import { useSession } from "../state/session";

export function GameMenu() {
  const menuOpen = useGame((s) => s.menuOpen);
  const set = useGame((s) => s.set);
  const closeOverlays = useGame((s) => s.closeOverlays);
  const musicOn = useGame((s) => s.musicOn);
  const setMusicOn = useGame((s) => s.setMusicOn);
  const exitToCharacters = useSession((s) => s.exitToCharacters);
  const logout = useSession((s) => s.logout);

  if (!menuOpen) return null;

  return (
    <div className="menu-overlay">
      <div className="panel">
        <h2 className="menu-title">PAUSED</h2>
        <div className="menu-hint">ESC TO RESUME</div>
        <button className="btn btn-primary" onClick={() => set({ menuOpen: false })}>
          Resume
        </button>
        <button className="btn btn-ghost" onClick={() => setMusicOn(!musicOn)}>
          Music: {musicOn ? "ON" : "OFF"}
        </button>
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
