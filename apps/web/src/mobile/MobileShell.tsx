// Mobile agent-management shell: replaces the desktop HUD on coarse-pointer
// narrow viewports. The 3D canvas stays mounted underneath (world/network
// alive); this shell overlays the active tab's screen plus the bottom tab
// bar. Only the Watch tab lets the canvas show through (later phase).

import { GameConnection } from "../net/connection";
import { useGame } from "../state/game";
import { AgentsTab } from "./AgentsTab";
import { EconomyTab } from "./EconomyTab";
import { MapTab } from "./MapTab";
import "./mobile.css";
import { TabBar } from "./TabBar";
import { TradeTab } from "./TradeTab";
import { WatchTab } from "./WatchTab";

export function MobileShell({ connection }: { connection: GameConnection }) {
  const connected = useGame((s) => s.connected);
  const tab = useGame((s) => s.mobileTab);

  return (
    <div className="m-shell">
      {!connected && <div className="disconnect-banner">RECONNECTING…</div>}
      <div className="m-content">
        {tab === "agents" && <AgentsTab />}
        {tab === "watch" && <WatchTab />}
        {tab === "map" && <MapTab />}
        {tab === "economy" && <EconomyTab />}
        {tab === "trade" && <TradeTab />}
      </div>
      <TabBar />
    </div>
  );
}
