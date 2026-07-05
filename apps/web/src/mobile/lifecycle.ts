// Background/foreground handling for the mobile shell: mirrors the document
// visibility into useGame.appVisible while mounted. Consumers react to it:
//  - GameCanvas ANDs it into its frameloop pause condition (no GPU work while
//    the PWA is backgrounded),
//  - the live-subscription effects (AgentSub, AgentDetailSub, WatchAgent,
//    MapIntelSub, EconomySub) gate on it, so the active tab's streams are
//    turned off on hide and restored on return.
// The WebSocket itself stays open; if the OS kills it in the background the
// existing auto-reconnect + `connected`-keyed effects resubscribe everything.

import { useEffect } from "react";
import { useGame } from "../state/game";

/** Keep useGame.appVisible in sync with document visibility (mobile shell). */
export function useAppVisibility(): void {
  useEffect(() => {
    const sync = () => {
      const visible = document.visibilityState === "visible";
      if (useGame.getState().appVisible !== visible) {
        useGame.getState().set({ appVisible: visible });
      }
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => {
      document.removeEventListener("visibilitychange", sync);
      // Never leave the flag stuck false if the shell unmounts (e.g. the
      // viewport stops matching the mobile query) while backgrounded.
      useGame.getState().set({ appVisible: true });
    };
  }, []);
}
