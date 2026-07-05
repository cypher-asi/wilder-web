// Shared live-watch view, used by both the mobile Watch tab and the desktop
// watch overlay (opened from the Agents menu). It renders a transparent HUD
// over the live 3D canvas whose FollowCamera tracks one owned agent, and:
//  - sends C2S WatchAgent so the server re-anchors chunk streaming + entity
//    replication on the agent (and pins it Hot); cleared on leave,
//  - subscribes AgentDetailSub for the live action ticker (1 Hz log),
//  - FOLLOW: drives the FollowCamera orbit from drag + pinch/wheel/buttons,
//  - EXPLORE: detaches the camera; drag pans across the map, zoom widens the
//    survey, and the panned position streams to the server as C2S SpectateAt
//    (throttled) so chunk/entity interest follows the camera.
// The two hosts differ only in CSS skin (`variant`) and the exit affordance:
// the mobile tab lives in the bottom bar; the desktop overlay adds a LEAVE
// button and enables mouse-wheel zoom.

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
import { followCam, zoomFollowCam } from "../render/FollowCamera";
import {
  game,
  getEntityRosterVersion,
  subscribeEntityRoster,
  useGame,
} from "../state/game";
import { AgentHpBar, fmtMild, formatAge, useAgents, UseAgentsApi } from "./useAgents";

/** Radians of yaw per pixel of horizontal drag. */
const YAW_SENS = 0.008;
/** Radians of pitch per pixel of vertical drag. */
const PITCH_SENS = 0.005;
/** Explore pan: world meters per pixel per meter of orbit distance. */
const PAN_SENS = 0.0022;
/** Explore anchor updates: send at most every this many ms... */
const SPECTATE_SEND_MS = 500;
/** ...and only when the camera moved this far since the last send (m). */
const SPECTATE_MIN_MOVE = 8;
/** Per-click multiplicative zoom step for the on-screen +/- buttons. */
const ZOOM_BUTTON_STEP = 1.35;

export type CamMode = "follow" | "explore";

export interface WatchController {
  agents: UseAgentsApi;
  roster: AgentSummary[] | null;
  watchAgentId: string | null;
  summary: AgentSummary | null;
  tracked: boolean;
  camMode: CamMode;
  setMode: (mode: CamMode) => void;
  pickAgent: (id: string) => void;
}

/**
 * Own the watch session: default-agent selection, camera mode, the server
 * interest anchors (WatchAgent / SpectateAt), and the detail stream feeding
 * the action ticker. Mounted only while a watch surface is visible.
 */
export function useWatchController(connection: GameConnection): WatchController {
  // Keeps AgentSub alive while the surface shows (roster refresh ~2 s).
  const agents = useAgents(connection, true);
  const roster = agents.roster;
  const watchAgentId = useGame((s) => s.watchAgentId);
  const joined = useGame((s) => s.joined);
  // Backgrounded (visibilitychange -> hidden): drop the watch anchor and the
  // detail stream; both re-send when the app returns to the foreground.
  const appVisible = useGame((s) => s.appVisible);
  const set = useGame((s) => s.set);

  // No explicit pick yet, or the picked agent left the roster: default to the
  // first owned agent.
  useEffect(() => {
    if (!roster || roster.length === 0) return;
    if (!watchAgentId || !roster.some((a) => a.agent_id === watchAgentId)) {
      set({ watchAgentId: roster[0].agent_id });
    }
  }, [roster, watchAgentId, set]);

  // Camera mode. Entering / switching agents resets to FOLLOW.
  const [camMode, setCamMode] = useState<CamMode>("follow");
  useEffect(() => {
    followCam.mode = "follow";
    setCamMode("follow");
  }, [watchAgentId]);
  useEffect(
    () => () => {
      followCam.mode = "follow";
    },
    [],
  );

  const setMode = useCallback(
    (mode: CamMode) => {
      if (mode === "explore") {
        // Detach in place: explore starts from wherever the camera is looking.
        followCam.explore.x = followCam.target.x;
        followCam.explore.z = followCam.target.z;
      } else {
        // Recenter: pull the wider explore zoom back into orbit range, and
        // re-send WatchAgent so the server re-anchors interest to the agent
        // and clears the free SpectateAt anchor.
        followCam.distance = Math.min(followCam.distance, followCam.maxDistance);
        if (joined && watchAgentId) {
          connection.send({ t: "WatchAgent", d: { agent_id: watchAgentId } });
        }
      }
      followCam.mode = mode;
      setCamMode(mode);
    },
    [joined, watchAgentId, connection],
  );

  // Server-side watch anchor while this surface is active. Re-sent when the
  // watched agent switches or after a reconnect (joined flips).
  useEffect(() => {
    if (!joined || !appVisible || !watchAgentId) return;
    connection.send({ t: "WatchAgent", d: { agent_id: watchAgentId } });
    return () => {
      connection.send({ t: "WatchAgent", d: { agent_id: null } });
    };
  }, [joined, appVisible, watchAgentId, connection]);

  // Explore: stream the panned position to the server (throttled) so chunk
  // streaming + entity replication follow the free camera.
  useEffect(() => {
    if (camMode !== "explore" || !joined || !appVisible) return;
    const last = { x: followCam.explore.x, z: followCam.explore.z };
    connection.send({ t: "SpectateAt", d: { x: last.x, z: last.z } });
    const timer = setInterval(() => {
      const { x, z } = followCam.explore;
      if (Math.hypot(x - last.x, z - last.z) < SPECTATE_MIN_MOVE) return;
      last.x = x;
      last.z = z;
      connection.send({ t: "SpectateAt", d: { x, z } });
    }, SPECTATE_SEND_MS);
    return () => clearInterval(timer);
  }, [camMode, joined, appVisible, connection]);

  // Detail stream (1 Hz activity log) feeds the live action ticker.
  useEffect(() => {
    if (!joined || !appVisible || !watchAgentId) return;
    agents.openDetail(watchAgentId);
    return () => agents.closeDetail();
  }, [joined, appVisible, watchAgentId, agents.openDetail, agents.closeDetail]);

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

  const pickAgent = useCallback((id: string) => set({ watchAgentId: id }), [set]);

  return {
    agents,
    roster,
    watchAgentId,
    summary,
    tracked,
    camMode,
    setMode,
    pickAgent,
  };
}

export interface WatchViewProps {
  ctrl: WatchController;
  /** CSS skin prefix: "m" (mobile tab) or "w" (desktop overlay). */
  variant: "m" | "w";
  /** Shown as a LEAVE button (desktop overlay); omitted on the mobile tab. */
  onExit?: () => void;
  /** Empty-state call to action (mobile → Agents tab, desktop → Agents menu). */
  onEmptyCta: () => void;
  emptyCtaLabel: string;
  /** Enable mouse-wheel zoom over the gesture layer (desktop). */
  wheelZoom?: boolean;
}

/** Full-surface transparent watch HUD over the live canvas. */
export function WatchView({
  ctrl,
  variant,
  onExit,
  onEmptyCta,
  emptyCtaLabel,
  wheelZoom,
}: WatchViewProps) {
  const { agents, roster, watchAgentId, summary, tracked, camMode, setMode } = ctrl;
  const cls = (suffix: string) => `${variant}-watch${suffix}`;

  if (roster !== null && roster.length === 0) {
    // Rare/transient: the server auto-assigns a starter agent on join, so an
    // empty roster only shows for a beat while that grant replicates.
    return (
      <div className="watch-empty-screen">
        <div className="watch-empty">
          <div className="watch-empty-glyph">◎</div>
          <div className="ag-empty-title">DEPLOYING AGENT</div>
          <div className="watch-empty-sub">Assigning your first agent…</div>
          <button type="button" className="watch-cta" onClick={onEmptyCta}>
            {emptyCtaLabel}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={cls("")}>
      <GestureLayer mode={camMode} className={cls("-gesture")} wheelZoom={wheelZoom} />
      {!tracked && camMode === "follow" && (
        <div className={cls("-veil")}>
          <span className={cls("-veil-text")}>TRACKING…</span>
        </div>
      )}
      <div className={cls("-hud")}>
        <div className={cls("-top")}>
          {summary ? (
            <div className={cls("-card")}>
              <div className="ag-card-top">
                <span className="ag-card-name">{summary.name}</span>
                <span className="ag-chip">{summary.archetype}</span>
              </div>
              <AgentHpBar health={summary.health} maxHealth={summary.max_health} />
              <div className={cls("-card-row")}>
                <span className={`${cls("-mild")} num`}>
                  {fmtMild(summary.carried_wild)} MILD
                </span>
                <span className={cls("-activity")}>» {summary.activity}</span>
              </div>
            </div>
          ) : (
            <div className={`${cls("-card")} ${cls("-card-note")}`}>SYNCING ROSTER…</div>
          )}
          <div className={cls("-modes")}>
            <button
              type="button"
              className={`${cls("-mode")}${camMode === "follow" ? " active" : ""}`}
              onClick={() => setMode("follow")}
            >
              ◎ FOLLOW
            </button>
            <button
              type="button"
              className={`${cls("-mode")}${camMode === "explore" ? " active" : ""}`}
              onClick={() => setMode("explore")}
            >
              ✥ EXPLORE
            </button>
            {camMode === "explore" && (
              <button
                type="button"
                className={`${cls("-mode")} ${cls("-recenter")}`}
                onClick={() => setMode("follow")}
              >
                ⌖ RECENTER
              </button>
            )}
            {/* Zoom works in both follow and explore, clamped per mode. */}
            <button
              type="button"
              className={`${cls("-mode")} watch-zoom-btn`}
              title="Zoom in"
              onClick={() => zoomFollowCam(1 / ZOOM_BUTTON_STEP)}
            >
              +
            </button>
            <button
              type="button"
              className={`${cls("-mode")} watch-zoom-btn`}
              title="Zoom out"
              onClick={() => zoomFollowCam(ZOOM_BUTTON_STEP)}
            >
              −
            </button>
            {onExit && (
              <button
                type="button"
                className={`${cls("-mode")} ${cls("-exit")}`}
                onClick={onExit}
              >
                ✕ LEAVE
              </button>
            )}
          </div>
        </div>
        <div className={cls("-bottom")}>
          {roster !== null && roster.length > 1 && (
            <AgentSwitcher
              roster={roster}
              activeId={watchAgentId}
              onPick={ctrl.pickAgent}
              variant={variant}
            />
          )}
          <ActionTicker
            variant={variant}
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
 * Full-surface pointer layer driving the camera.
 * FOLLOW: one-finger/LMB drag steers yaw/pitch, pinch/wheel zooms.
 * EXPLORE: drag pans the look target across the map (screen-space, scaled by
 * orbit distance so panning feels constant at any zoom), pinch/wheel zooms out
 * to a wider survey range.
 */
function GestureLayer({
  mode,
  className,
  wheelZoom,
}: {
  mode: CamMode;
  className: string;
  wheelZoom?: boolean;
}) {
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinchDist = useRef(0);
  const modeRef = useRef(mode);
  modeRef.current = mode;

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
    const explore = modeRef.current === "explore";

    if (pointers.current.size === 1) {
      if (explore) {
        // Screen-space pan on the ground plane, content follows the finger.
        // Camera forward on XZ points from camera toward target.
        const fx = -Math.cos(followCam.yaw);
        const fz = -Math.sin(followCam.yaw);
        // right = forward × up
        const rx = -fz;
        const rz = fx;
        const scale = PAN_SENS * followCam.distance;
        followCam.explore.x += (-rx * dx + fx * dy) * scale;
        followCam.explore.z += (-rz * dx + fz * dy) * scale;
      } else {
        followCam.yaw += dx * YAW_SENS;
        followCam.pitch = Math.min(
          followCam.maxPitch,
          Math.max(followCam.minPitch, followCam.pitch + dy * PITCH_SENS),
        );
      }
    } else if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchDist.current > 0 && dist > 0) {
        zoomFollowCam(pinchDist.current / dist);
      }
      pinchDist.current = dist;
    }
  }, []);

  const onPointerEnd = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(e.pointerId);
    pinchDist.current = 0;
  }, []);

  const onWheel = useCallback(
    (e: React.WheelEvent<HTMLDivElement>) => {
      if (!wheelZoom) return;
      // Multiplicative steps: constant feel across the whole zoom range.
      zoomFollowCam(Math.exp(e.deltaY * 0.0012));
    },
    [wheelZoom],
  );

  return (
    <div
      className={className}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onWheel={wheelZoom ? onWheel : undefined}
    />
  );
}

/** Horizontal strip of owned-agent chips (name + HP); tap to switch. */
function AgentSwitcher({
  roster,
  activeId,
  onPick,
  variant,
}: {
  roster: AgentSummary[];
  activeId: string | null;
  onPick: (id: string) => void;
  variant: "m" | "w";
}) {
  const cls = (suffix: string) => `${variant}-watch${suffix}`;
  return (
    <div className={cls("-chips")}>
      {roster.map((a) => {
        const hp = Math.max(0, Math.min(1, a.health / Math.max(a.max_health, 1)));
        return (
          <button
            key={a.agent_id}
            type="button"
            className={`${cls("-chip")}${a.agent_id === activeId ? " active" : ""}`}
            onClick={() => onPick(a.agent_id)}
          >
            <span className={cls("-chip-name")}>{a.name}</span>
            <span className={cls("-chip-hp")}>
              <span
                className={`${cls("-chip-hp-fill")}${hp <= 0.3 ? " low" : ""}`}
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
  variant,
}: {
  log: { at_ms: number; text: string }[] | null;
  variant: "m" | "w";
}) {
  const cls = (suffix: string) => `${variant}-watch${suffix}`;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const rows = useMemo(() => (log ? [...log].reverse().slice(0, 4) : []), [log]);
  if (rows.length === 0) return null;
  return (
    <div className={cls("-ticker")}>
      {rows.map((e, i) => (
        <div key={`${e.at_ms}-${i}`} className={cls("-ticker-row")}>
          <span className={cls("-ticker-text")}>{e.text}</span>
          <span className={`${cls("-ticker-age")} num`}>{formatAge(e.at_ms, now)}</span>
        </div>
      ))}
    </div>
  );
}
