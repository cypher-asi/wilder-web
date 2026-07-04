// Watch tab: 3D follow-cam on one owned agent. The tab itself is a
// transparent overlay — the game canvas (paused on every other tab) shows
// through behind it. While active it:
//  - sends C2S WatchAgent so the server re-anchors chunk streaming + entity
//    replication on the agent (and pins it Hot); cleared on leave,
//  - subscribes AgentDetailSub for the live action ticker (1 Hz log),
//  - drives the FollowCamera orbit from one-finger drag + pinch gestures.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { GameConnection } from "../net/connection";
import { AgentSummary } from "../net/protocol";
import { followCam } from "../render/FollowCamera";
import {
  game,
  getEntityRosterVersion,
  subscribeEntityRoster,
  useGame,
} from "../state/game";
import { AgentHpBar, fmtMild, formatAge, useAgents } from "../ui/useAgents";

/** Radians of yaw per pixel of horizontal drag. */
const YAW_SENS = 0.008;
/** Radians of pitch per pixel of vertical drag. */
const PITCH_SENS = 0.005;

export function WatchTab({ connection }: { connection: GameConnection }) {
  // Keeps AgentSub alive while the tab shows (roster refresh ~2 s).
  const agents = useAgents(connection, true);
  const roster = agents.roster;
  const watchAgentId = useGame((s) => s.watchAgentId);
  const joined = useGame((s) => s.joined);
  const set = useGame((s) => s.set);
  const setMobileTab = useGame((s) => s.setMobileTab);

  // No explicit pick ("Watch Live") yet, or the picked agent left the
  // roster: default to the first owned agent.
  useEffect(() => {
    if (!roster || roster.length === 0) return;
    if (!watchAgentId || !roster.some((a) => a.agent_id === watchAgentId)) {
      set({ watchAgentId: roster[0].agent_id });
    }
  }, [roster, watchAgentId, set]);

  // Server-side watch anchor while this tab is active. Re-sent when the
  // watched agent switches or after a reconnect (joined flips).
  useEffect(() => {
    if (!joined || !watchAgentId) return;
    connection.send({ t: "WatchAgent", d: { agent_id: watchAgentId } });
    return () => {
      connection.send({ t: "WatchAgent", d: { agent_id: null } });
    };
  }, [joined, watchAgentId, connection]);

  // Detail stream (1 Hz activity log) feeds the live action ticker.
  useEffect(() => {
    if (!joined || !watchAgentId) return;
    agents.openDetail(watchAgentId);
    return () => agents.closeDetail();
  }, [joined, watchAgentId, agents.openDetail, agents.closeDetail]);

  const summary = roster?.find((a) => a.agent_id === watchAgentId) ?? null;

  // Tracking state: is the watched agent's entity replicated yet? Recomputed
  // whenever entities spawn/despawn (external-store signal, no polling).
  const entityVersion = useSyncExternalStore(
    subscribeEntityRoster,
    getEntityRosterVersion,
  );
  const tracked = useMemo(
    () => (summary ? game.entities.has(summary.entity_id) : false),
    [summary, entityVersion],
  );

  if (roster !== null && roster.length === 0) {
    return (
      <div className="m-watch m-watch-solid">
        <div className="m-ag-empty">
          <div className="m-ag-empty-glyph">◎</div>
          <div className="ag-empty-title">NOTHING TO WATCH</div>
          <div className="m-ag-empty-sub">Hire an agent to start watching.</div>
          <button
            type="button"
            className="m-ag-cta"
            onClick={() => setMobileTab("agents")}
          >
            GO TO AGENTS
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="m-watch">
      <GestureLayer />
      {!tracked && (
        <div className="m-watch-veil">
          <span className="m-watch-veil-text">TRACKING…</span>
        </div>
      )}
      <div className="m-watch-hud">
        {summary ? (
          <div className="m-watch-card">
            <div className="ag-card-top">
              <span className="ag-card-name">{summary.name}</span>
              <span className="ag-chip">{summary.archetype}</span>
            </div>
            <AgentHpBar health={summary.health} maxHealth={summary.max_health} />
            <div className="m-watch-card-row">
              <span className="m-watch-mild num">
                {fmtMild(summary.carried_wild)} MILD
              </span>
              <span className="m-watch-activity">» {summary.activity}</span>
            </div>
          </div>
        ) : (
          <div className="m-watch-card m-watch-card-note">SYNCING ROSTER…</div>
        )}
        <div className="m-watch-bottom">
          {roster !== null && roster.length > 1 && (
            <AgentSwitcher
              roster={roster}
              activeId={watchAgentId}
              onPick={(id) => set({ watchAgentId: id })}
            />
          )}
          <ActionTicker
            log={
              agents.detail?.summary.agent_id === watchAgentId
                ? agents.detail.activity_log
                : null
            }
          />
        </div>
      </div>
    </div>
  );
}

/**
 * Full-surface touch layer driving the FollowCamera orbit: one-finger drag
 * steers yaw (horizontal) and pitch (vertical), two-finger pinch zooms.
 */
function GestureLayer() {
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinchDist = useRef(0);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinchDist.current = Math.hypot(a.x - b.x, a.y - b.y);
    }
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    prev.x = e.clientX;
    prev.y = e.clientY;

    if (pointers.current.size === 1) {
      followCam.yaw += dx * YAW_SENS;
      followCam.pitch = Math.min(
        followCam.maxPitch,
        Math.max(followCam.minPitch, followCam.pitch + dy * PITCH_SENS),
      );
    } else if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchDist.current > 0 && dist > 0) {
        followCam.distance = Math.min(
          followCam.maxDistance,
          Math.max(
            followCam.minDistance,
            followCam.distance * (pinchDist.current / dist),
          ),
        );
      }
      pinchDist.current = dist;
    }
  }, []);

  const onPointerEnd = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(e.pointerId);
    pinchDist.current = 0;
  }, []);

  return (
    <div
      className="m-watch-gesture"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
    />
  );
}

/** Horizontal strip of owned-agent chips (name + HP); tap to switch. */
function AgentSwitcher({
  roster,
  activeId,
  onPick,
}: {
  roster: AgentSummary[];
  activeId: string | null;
  onPick: (id: string) => void;
}) {
  return (
    <div className="m-watch-chips">
      {roster.map((a) => {
        const hp = Math.max(0, Math.min(1, a.health / Math.max(a.max_health, 1)));
        return (
          <button
            key={a.agent_id}
            type="button"
            className={`m-watch-chip${a.agent_id === activeId ? " active" : ""}`}
            onClick={() => onPick(a.agent_id)}
          >
            <span className="m-watch-chip-name">{a.name}</span>
            <span className="m-watch-chip-hp">
              <span
                className={`m-watch-chip-hp-fill${hp <= 0.3 ? " low" : ""}`}
                style={{ width: `${hp * 100}%` }}
              />
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Live action ticker: latest activity-log lines, newest on top. */
function ActionTicker({
  log,
}: {
  log: { at_ms: number; text: string }[] | null;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const rows = useMemo(() => (log ? [...log].reverse().slice(0, 4) : []), [log]);
  if (rows.length === 0) return null;
  return (
    <div className="m-watch-ticker">
      {rows.map((e, i) => (
        <div key={`${e.at_ms}-${i}`} className="m-watch-ticker-row">
          <span className="m-watch-ticker-text">{e.text}</span>
          <span className="m-watch-ticker-age num">{formatAge(e.at_ms, now)}</span>
        </div>
      ))}
    </div>
  );
}
