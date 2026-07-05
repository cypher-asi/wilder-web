// Mobile Watch-tab camera. Two modes, driven by the Watch tab's gesture
// layer mutating the exported `followCam` state:
//
//  FOLLOW  — orbits the watched owned agent's replicated entity (agentRoster
//            carries the agent's live entity_id, so the entity is looked up
//            straight out of game.entities). One-finger drag steers
//            yaw/pitch, pinch zooms. While the agent isn't replicated yet
//            (cold→hot promotion, chunks still streaming after a WatchAgent
//            re-anchor) the camera hovers over the agent's last roster
//            position looking down — the WatchTab shows its "TRACKING…"
//            veil until the entity appears.
//
//  EXPLORE — detached free camera: the orbit target is `followCam.explore`
//            (panned across the map by one-finger drag, pinch zooms), keeping
//            the same angled pitch as the sim view. The Watch tab streams the
//            position to the server (C2S SpectateAt) so chunk/entity interest
//            follows the exploration.
//
// Spectators have no local avatar, so nothing else writes game.predicted /
// game.rendered. Every world-anchored system reads them — the tron ground
// grid's proximity glow, the CityProxy occupancy + tile windows, chunk build
// ordering, the light rigs — so this camera also anchors them to its target
// each frame.

import { useFrame, useThree } from "@react-three/fiber";
import { useRef } from "react";
import * as THREE from "three";
import { game, useGame } from "../state/game";
import { groundHeightAt } from "./Ground";
import { styleRuntime } from "./styles";

/** Orbit state mutated by the Watch tab's touch gestures. */
export const followCam = {
  /** FOLLOW orbits the watched agent; EXPLORE orbits the free target. */
  mode: "follow" as "follow" | "explore",
  yaw: Math.PI / 4,
  /** Elevation angle (rad); ~0.4 puts the camera ≈4 m up at 10 m out. */
  pitch: 0.42,
  distance: 10,
  minDistance: 4,
  maxDistance: 25,
  /** Explore mode may pull much further out to survey the map (past the
   * desktop rig's 140 m — the CityProxy far-field and the fog thinning keep
   * the wider view readable, and pan is unclamped because SpectateAt walks
   * the server's streaming anchor along with the camera). */
  maxDistanceExplore: 180,
  minPitch: THREE.MathUtils.degToRad(4),
  maxPitch: THREE.MathUtils.degToRad(72),
  /** EXPLORE look target (world XZ), panned by the gesture layer. */
  explore: { x: 0, z: 0 },
  /** Live look target (world XZ), written per frame; read by the Watch tab
   * to seed `explore` when detaching from the agent. */
  target: { x: 0, z: 0 },
};

// Debug handle for development tooling (mirrors window.__cameraState).
if (typeof window !== "undefined" && import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__followCam = followCam;
}

/**
 * Multiplicative zoom step for the watch camera, clamped to the active mode's
 * range (explore may pull much further out than follow orbit). `factor < 1`
 * zooms in, `factor > 1` zooms out. Shared by the touch pinch, the desktop
 * mouse wheel, and the on-screen zoom buttons.
 */
export function zoomFollowCam(factor: number): void {
  const max =
    followCam.mode === "explore"
      ? followCam.maxDistanceExplore
      : followCam.maxDistance;
  followCam.distance = Math.min(
    max,
    Math.max(followCam.minDistance, followCam.distance * factor),
  );
}

/** Look target height above the ground (agent chest height). */
const LOOK_HEIGHT = 1.3;
/** Overhead hover height while the watched agent isn't replicated yet. */
const SEARCH_HEIGHT = 55;
/** Mirrors CameraRig's FOG_BASE_DISTANCE so fog reads the same per style. */
const FOG_BASE_DISTANCE = 48;

const nextTargetScratch = new THREE.Vector3();
const desiredPosScratch = new THREE.Vector3();

export function FollowCamera() {
  const { camera, scene } = useThree();
  const watchAgentId = useGame((s) => s.watchAgentId);
  const roster = useGame((s) => s.agentRoster);
  const summary = roster?.find((a) => a.agent_id === watchAgentId) ?? null;
  // useFrame reads through a ref so the frame loop never closes over stale
  // props between renders.
  const summaryRef = useRef(summary);
  summaryRef.current = summary;

  const target = useRef(
    new THREE.Vector3(game.predicted.x, 0, game.predicted.z),
  );

  useFrame((_, dt) => {
    const s = summaryRef.current;
    const explore = followCam.mode === "explore";
    const entity = s ? game.entities.get(s.entity_id) : undefined;
    // Explore: free target. Follow: the interpolated entity, falling back to
    // the ~2 s roster position (agent not replicated yet), then to the
    // character's join position.
    const tx = explore ? followCam.explore.x : entity ? entity.x : (s?.x ?? game.predicted.x);
    const tz = explore ? followCam.explore.z : entity ? entity.z : (s?.z ?? game.predicted.z);
    const ty = groundHeightAt(tx, tz);

    // Smooth follow; snap on long-range jumps (agent switch, respawn).
    const next = nextTargetScratch.set(tx, ty, tz);
    if (target.current.distanceTo(next) > 60) {
      target.current.copy(next);
    } else {
      target.current.lerp(next, Math.min(1, dt * 6));
    }
    const t = target.current;
    followCam.target.x = t.x;
    followCam.target.z = t.z;

    // Anchor the "player position" the rest of the renderer keys off (grid
    // glow, proxy windows, chunk build order); spectators never write it.
    game.predicted.x = t.x;
    game.predicted.z = t.z;
    game.rendered.x = t.x;
    game.rendered.z = t.z;

    let lookY: number;
    if (entity || explore) {
      let pitch = THREE.MathUtils.clamp(
        followCam.pitch,
        followCam.minPitch,
        followCam.maxPitch,
      );
      if (explore) {
        // Survey tilt: past follow-orbit range the camera eases toward
        // top-down as the pinch pulls out, so a zoomed-out explore reads as
        // a map instead of a wall of far geometry. One-finger drag doesn't
        // steer pitch in explore, so this is the only pitch control there.
        const t = THREE.MathUtils.clamp(
          (followCam.distance - followCam.maxDistance) /
            (followCam.maxDistanceExplore - followCam.maxDistance),
          0,
          1,
        );
        pitch = THREE.MathUtils.lerp(pitch, followCam.maxPitch, t);
      }
      const horiz = Math.cos(pitch) * followCam.distance;
      lookY = t.y + LOOK_HEIGHT;
      desiredPosScratch.set(
        t.x + Math.cos(followCam.yaw) * horiz,
        lookY + Math.sin(pitch) * followCam.distance,
        t.z + Math.sin(followCam.yaw) * horiz,
      );
    } else {
      // Searching: hover overhead, tilted just off vertical so lookAt keeps
      // a stable roll.
      lookY = t.y;
      desiredPosScratch.set(t.x, t.y + SEARCH_HEIGHT, t.z + 6);
    }
    // Damped glide between modes and while orbiting; snap over teleports.
    if (camera.position.distanceTo(desiredPosScratch) > 120) {
      camera.position.copy(desiredPosScratch);
    } else {
      camera.position.lerp(desiredPosScratch, Math.min(1, dt * 8));
    }
    camera.lookAt(t.x, lookY, t.z);

    // Fog thins as the orbit pulls back (mirrors the desktop CameraRig so
    // visual styles read the same on mobile).
    if (scene.fog instanceof THREE.FogExp2) {
      const spread = Math.max(1, (followCam.distance / FOG_BASE_DISTANCE) ** 1.35);
      scene.fog.density = styleRuntime.fogBaseDensity / spread;
    }
  });

  return null;
}
