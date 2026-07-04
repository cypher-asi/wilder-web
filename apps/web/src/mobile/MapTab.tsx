// Mobile Map tab: the holographic city map (shared HoloMapView in standalone
// mode) filling the area above the tab bar, with touch-first chrome on top:
// a legend sheet, a "my agents" recenter button, owned-agent markers with a
// tap-to-watch info chip, and a tapped-district readout.
//
// The map component owns the MapIntelSub lifecycle (on while mounted); this
// tab keeps AgentSub alive so owned-agent marker positions stay fresh.

import { useMemo, useRef, useState } from "react";
import { LEGEND_CATEGORIES } from "../game/poi";
import { GameConnection } from "../net/connection";
import { AgentSummary } from "../net/protocol";
import { useGame } from "../state/game";
import { HoloMapHandle, HoloMapTap, HoloMapView } from "../ui/HoloMap";
import { AgentHpBar, useAgents, useFactionMeta } from "../ui/useAgents";

/** Zoom applied when jumping to an agent (close enough for name labels). */
const AGENT_FOCUS_DIST = 1600;

/** Ignore ground taps farther than this from every district anchor. */
const DISTRICT_TAP_RANGE = 1500;

type TapInfo =
  | { type: "agent"; agentId: string }
  | { type: "district"; name: string; danger: string };

export function MapTab({ connection }: { connection: GameConnection }) {
  // Keeps AgentSub alive while the tab shows (owned marker positions ~2 s).
  const agents = useAgents(connection, true);
  const roster = agents.roster;
  const districts = useGame((s) => s.districts);
  const set = useGame((s) => s.set);
  const setMobileTab = useGame((s) => s.setMobileTab);

  const mapHandle = useRef<HoloMapHandle | null>(null);
  const [legendOpen, setLegendOpen] = useState(false);
  const [tapped, setTapped] = useState<TapInfo | null>(null);

  const onTap = (tap: HoloMapTap) => {
    if (tap.agentId) {
      setTapped({ type: "agent", agentId: tap.agentId });
      return;
    }
    // District readout: nearest anchor to the tapped ground point, in range.
    let best: (typeof districts)[number] | null = null;
    let bestD = DISTRICT_TAP_RANGE;
    for (const d of districts) {
      const dist = Math.hypot(d.x - tap.x, d.z - tap.z);
      if (dist < bestD) {
        bestD = dist;
        best = d;
      }
    }
    setTapped(best ? { type: "district", name: best.name, danger: best.danger } : null);
  };

  const focusAgents = () => {
    const first = roster?.[0];
    if (first) mapHandle.current?.centerOn(first.x, first.z, AGENT_FOCUS_DIST);
  };

  const tappedAgent =
    tapped?.type === "agent"
      ? (roster?.find((a) => a.agent_id === tapped.agentId) ?? null)
      : null;

  return (
    <div className="m-map">
      <HoloMapView
        open
        connection={connection}
        standalone
        ownedAgents={roster}
        onTap={onTap}
        handleRef={mapHandle}
      />

      {tapped?.type === "district" && (
        <div className="m-map-chip">
          <span className="m-map-chip-name">{tapped.name.toUpperCase()}</span>
          <span className={`m-map-chip-danger danger-${tapped.danger.toLowerCase()}`}>
            {tapped.danger.toUpperCase()}
          </span>
        </div>
      )}

      {tappedAgent && (
        <AgentChip
          agent={tappedAgent}
          onWatch={() => {
            set({ watchAgentId: tappedAgent.agent_id });
            setMobileTab("watch");
          }}
          onClose={() => setTapped(null)}
        />
      )}

      <div className="m-map-fabs">
        {roster !== null && roster.length > 0 && (
          <button type="button" className="m-map-fab" onClick={focusAgents}>
            ◈ MY AGENTS
          </button>
        )}
        <button
          type="button"
          className={`m-map-fab${legendOpen ? " active" : ""}`}
          onClick={() => setLegendOpen((v) => !v)}
        >
          LEGEND
        </button>
      </div>

      {legendOpen && <MobileLegend />}
    </div>
  );
}

/** Small info chip for a tapped owned-agent marker, with the watch hand-off. */
function AgentChip({
  agent,
  onWatch,
  onClose,
}: {
  agent: AgentSummary;
  onWatch: () => void;
  onClose: () => void;
}) {
  return (
    <div className="m-map-agent-chip">
      <div className="m-map-agent-info">
        <div className="ag-card-top">
          <span className="ag-card-name">{agent.name}</span>
          <span className="ag-chip">{agent.archetype}</span>
        </div>
        <AgentHpBar health={agent.health} maxHealth={agent.max_health} />
        <div className="m-map-agent-activity">» {agent.activity}</div>
      </div>
      <div className="m-map-agent-actions">
        <button type="button" className="m-map-watch-btn" onClick={onWatch}>
          WATCH
        </button>
        <button type="button" className="m-map-chip-close" onClick={onClose}>
          ✕
        </button>
      </div>
    </div>
  );
}

/** Compact legend panel: blip meanings, faction colors, POI categories. */
function MobileLegend() {
  const factions = useGame((s) => s.factions);
  const factionMeta = useFactionMeta();

  const blipRows = useMemo(
    () => [
      { glyph: "◆", color: "#bdf6ff", label: "YOUR AGENTS" },
      { glyph: "●", color: "#9ff4ff", label: "PLAYERS" },
      { glyph: "●", color: "#ffb072", label: "FACTION AGENTS (FACTION COLOR)" },
      { glyph: "●", color: "#7f8ea0", label: "WILD WAPES (DIMMED)" },
      { glyph: "●", color: "#ffffff", label: "AMMO CACHE" },
      { glyph: "▢", color: "#29d98c", label: "SAFE ZONE" },
      { glyph: "▣", color: "#ff3860", label: "ENEMY TERRITORY" },
    ],
    [],
  );

  return (
    <div className="m-map-legend m-scroll">
      <div className="m-map-legend-title">MARKERS</div>
      {blipRows.map((r) => (
        <div key={r.label} className="m-map-legend-row">
          <span className="m-map-legend-glyph" style={{ color: r.color }}>
            {r.glyph}
          </span>
          <span>{r.label}</span>
        </div>
      ))}
      {factions.length > 0 && (
        <>
          <div className="m-map-legend-title">FACTIONS · TERRITORY</div>
          {factions.map((f) => {
            const meta = factionMeta(f.id);
            return (
              <div key={f.id} className="m-map-legend-row">
                <span className="m-map-legend-glyph" style={{ color: meta.color }}>
                  ■
                </span>
                <span>{meta.name.toUpperCase()}</span>
              </div>
            );
          })}
        </>
      )}
      <div className="m-map-legend-title">LOCATIONS</div>
      {LEGEND_CATEGORIES.map((c) => (
        <div key={c.id} className="m-map-legend-row">
          <span className="m-map-legend-glyph" style={{ color: c.color }}>
            ◇
          </span>
          <span>{c.label}</span>
        </div>
      ))}
    </div>
  );
}
