// Mobile Watch-tab camera: orbits the watched owned agent's replicated
// entity (agentRoster carries the agent's live entity_id, so the entity is
// looked up straight out of game.entities). One-finger drag on the Watch
// tab's gesture layer steers yaw/pitch and pinch zooms by mutating the
// exported `followCam` state; this component only reads it per frame.
//
// While the agent isn't replicated yet (cold→hot promotion, chunks still
// streaming after a WatchAgent re-anchor) the camera hovers over the
// agent's last roster position looking down — the WatchTab shows its
// "TRACKING…" veil until the entity appears.

import { useFrame, useThree } from "@react-three/fiber";
import { useRef } from "react";
import * as THREE from "three";
import { game, useGame } from "../state/game";
import { groundHeightAt } from "./Ground";
import { styleRuntime } from "./styles";

/** Orbit state mutated by the Watch tab's touch gestures. */
export const followCam = {
  yaw: Math.PI / 4,
  /** Elevation angle (rad); ~0.4 puts the camera ≈4 m up at 10 m out. */
  pitch: 0.42,
  distance: 10,
  minDistance: 4,
  maxDistance: 25,
  minPitch: THREE.MathUtils.degToRad(4),
  maxPitch: THREE.MathUtils.degToRad(72),
};

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
    const entity = s ? game.entities.get(s.entity_id) : undefined;
    // Follow the interpolated entity; fall back to the ~2 s roster position
    // (agent not replicated yet), then to the character's join position.
    const tx = entity ? entity.x : (s?.x ?? game.predicted.x);
    const tz = entity ? entity.z : (s?.z ?? game.predicted.z);
    const ty = groundHeightAt(tx, tz);

    // Smooth follow; snap on long-range jumps (agent switch, respawn).
    const next = nextTargetScratch.set(tx, ty, tz);
    if (target.current.distanceTo(next) > 60) {
      target.current.copy(next);
    } else {
      target.current.lerp(next, Math.min(1, dt * 6));
    }
    const t = target.current;

    let lookY: number;
    if (entity) {
      const pitch = THREE.MathUtils.clamp(
        followCam.pitch,
        followCam.minPitch,
        followCam.maxPitch,
      );
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
