// TPS-style follow camera driven by pointer-lock mouse-look: moving the mouse
// steers yaw/pitch directly and the character turns with the camera
// (PlayerInput aims along camera forward). Holding RMB free-looks — the
// camera still rotates but character facing stays frozen. The wheel zooms
// from a far tactical view all the way into a Fortnite-style over-the-
// shoulder view (raised eye-height target, right-shoulder offset, wider FOV).
// Pointer lock is released whenever a UI panel needs the cursor and
// re-acquired on the next canvas click; an Escape-driven unlock opens the
// game menu (the keydown never reaches the page while locked).

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { chunkKey } from "../game/collision";
import { interiorRegistry } from "../game/interiors";
import { CHUNK_SIZE, TILE_SIZE } from "../net/protocol";
import { perf } from "../perf/perf";
import { game, useGame } from "../state/game";
import { styleRuntime } from "./styles";

/**
 * Camera far plane, shared by GameCanvas and the Ocean horizon rim. Sized so
 * the CityProxy far-field skyline stays visible when the fog thins at high
 * zoom; at street-level zoom the fog fully absorbs the extra range.
 */
export const CAMERA_FAR = 1000;

// Wiami streets are boulevard-scale (17-37 m curb to curb), so the resting
// distance is pulled back far enough that a full road plus both sidewalks and
// building faces fit the frame instead of one asphalt plane filling it.
export const cameraState = {
  yaw: Math.PI / 4,
  distance: 48,
  minDistance: 1.4,
  maxDistance: 140,
  // True while RMB is held (free-look). Consumed by PlayerInput to freeze
  // character facing so the camera can swing without the body tracking it.
  dragging: false,
  // True while the canvas holds pointer lock (mouse-look active).
  locked: false,
  // Set when a lock request errors (embedded browsers, test harnesses…):
  // the game stays fully playable on the legacy twin-stick scheme, so
  // PlayerInput must not gate firing on a lock that can never engage.
  lockUnavailable: false,
  // Set (to a performance.now() deadline) when Escape was consumed to close
  // a panel. The same keypress can kick out the freshly re-acquired pointer
  // lock via the browser's built-in Escape-unlocks behavior; that unlock
  // must not be read as "open the game menu".
  suppressMenuUntil: 0,
  // Mouse-look pitch offset (radians) relative to the zoom-derived base
  // pitch. Lives here (not a component ref) so dev tooling can steer it.
  pitchOffset: 0,
};

// Debug handle for development tooling (mirrors window.__game in state/game).
if (typeof window !== "undefined" && import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__cameraState = cameraState;
}

/** Decaying recoil offset applied to the whole view (position + look target). */
const recoil = { x: 0, z: 0, jolt: 0 };

/**
 * Kick the camera opposite the shot direction with a touch of random jitter.
 * Called by PlayerInput when the local player fires.
 */
export function cameraKick(strength: number, yaw: number) {
  recoil.x -= Math.cos(yaw) * strength;
  recoil.z -= Math.sin(yaw) * strength;
  recoil.jolt = Math.min(0.6, recoil.jolt + strength * 0.5);
}

/** Default-zoom fog distance; density comes from the active visual style
 * (styleRuntime.fogBaseDensity) and thins as the camera pulls back. */
const FOG_BASE_DISTANCE = 48;

/** Scratch vector for the follow target, reused across frames. */
const nextTargetScratch = new THREE.Vector3();

const PITCH_NEAR = THREE.MathUtils.degToRad(52);
const PITCH_FAR = THREE.MathUtils.degToRad(62);
/** Pitch band floor at normal zoom; dips below the horizon so the camera can
 * drop low and angle up to see tall buildings / the sky. */
const PITCH_MIN = THREE.MathUtils.degToRad(-25);
const PITCH_MAX = THREE.MathUtils.degToRad(80);

// Over-the-shoulder blend: fully engaged at OTS_NEAR m of zoom, fully off at
// OTS_START. Zooming in raises the look target to eye height, offsets the
// camera over the right shoulder, flattens the pitch and widens the FOV.
export const OTS_START_DISTANCE = 6;
const OTS_NEAR_DISTANCE = 2.5;
/** Resting pitch of the shoulder view (slightly above horizontal). */
const OTS_PITCH = THREE.MathUtils.degToRad(10);
/** At the shoulder the player may look up past the horizon. */
const OTS_PITCH_MIN = THREE.MathUtils.degToRad(-25);
const LOOK_HEIGHT = 1.2;
const OTS_EYE_HEIGHT = 1.6;
const OTS_SHOULDER_OFFSET = 0.75;
const FOV_BASE = 34;
const FOV_OTS = 55;

/**
 * How far ahead of the character the look target (and thus the crosshair)
 * leads, as a fraction of the zoom distance. Keeps the on-screen lead roughly
 * constant across zoom so the crosshair shows where shots land instead of
 * sitting on top of the character. Faded out as the shoulder view engages.
 */
const LOOK_AHEAD_FRAC = 0.12;

/**
 * Lateral framing: slide the character off toward the left of the frame (the
 * camera looks slightly right of the body) so the crosshair at screen center
 * sits on open space instead of on top of the character. Sized as a fraction
 * of the zoom distance so the on-screen offset stays roughly constant.
 */
const OFFCENTER_FRAC = 0.16;
/**
 * The off-center framing fades back to a centered view once you pull far
 * enough out — a tactical overview reads better with the character in the
 * middle and the cursor visible all around it. Full off-center below
 * OFFCENTER_FADE_START; centered by OFFCENTER_FADE_END.
 */
const OFFCENTER_FADE_START = 70;
const OFFCENTER_FADE_END = 120;

/** Mouse-look sensitivity (radians per pixel of pointer-lock movement). */
const LOOK_SENS = 0.0032;
/** RMB-drag sensitivity when unlocked (legacy orbit feel). */
const DRAG_SENS = 0.005;

// --- Camera wall collision -------------------------------------------------

/** Gap (m) kept between the camera and the wall that clipped it. */
const OCCLUDE_PAD = 0.5;
/** The occlusion clamp never pulls the camera closer than this to the head. */
const OCCLUDE_MIN_FRAC = 0.04;
/** Extra roaming margin (m) around a walk-in room for the confined camera. */
const ROOM_CAM_MARGIN = 1.5;
/** Ground offset of building bases (render/building.ts GROUND_Y). */
const BUILDING_BASE_Y = 0.14;

/**
 * Smallest t in (0, 1] where the head->camera segment enters a building
 * volume (footprint x full height + parapet), or 1 when the view is clear.
 * Buildings only — props, low interior walls and front bands never block
 * the camera. `skipKey` excludes one building (the room the player is in).
 */
function cameraOcclusionT(
  hx: number,
  hy: number,
  hz: number,
  cx: number,
  cy: number,
  cz: number,
  skipChunk: string | null,
  skipBuilding: number,
): number {
  const dx = cx - hx;
  const dy = cy - hy;
  const dz = cz - hz;
  const cx0 = Math.floor(Math.min(hx, cx) / CHUNK_SIZE);
  const cx1 = Math.floor(Math.max(hx, cx) / CHUNK_SIZE);
  const cz0 = Math.floor(Math.min(hz, cz) / CHUNK_SIZE);
  const cz1 = Math.floor(Math.max(hz, cz) / CHUNK_SIZE);
  let best = 1;
  for (let gz = cz0; gz <= cz1; gz++) {
    for (let gx = cx0; gx <= cx1; gx++) {
      const key = chunkKey(gx, gz);
      const chunk = game.chunks.chunks.get(key);
      if (!chunk) continue;
      const ox = gx * CHUNK_SIZE;
      const oz = gz * CHUNK_SIZE;
      for (let bi = 0; bi < chunk.buildings.length; bi++) {
        if (bi === skipBuilding && key === skipChunk) continue;
        const b = chunk.buildings[bi];
        const top = BUILDING_BASE_Y + 4.5 + (b.stories - 1) * 3 + 1.0;
        // 3D slab test of the segment against the building volume.
        let tmin = 0;
        let tmax = 1;
        let miss = false;
        for (let axis = 0; axis < 3 && !miss; axis++) {
          const o = axis === 0 ? hx : axis === 1 ? hy : hz;
          const d = axis === 0 ? dx : axis === 1 ? dy : dz;
          const lo =
            axis === 0 ? ox + b.tx0 * TILE_SIZE : axis === 1 ? 0 : oz + b.tz0 * TILE_SIZE;
          const hi =
            axis === 0 ? ox + b.tx1 * TILE_SIZE : axis === 1 ? top : oz + b.tz1 * TILE_SIZE;
          if (Math.abs(d) < 1e-8) {
            if (o < lo || o > hi) miss = true;
            continue;
          }
          let t1 = (lo - o) / d;
          let t2 = (hi - o) / d;
          if (t1 > t2) {
            const tmp = t1;
            t1 = t2;
            t2 = tmp;
          }
          if (t1 > tmin) tmin = t1;
          if (t2 < tmax) tmax = t2;
          if (tmin > tmax) miss = true;
        }
        if (!miss && tmin < best) best = tmin;
      }
    }
  }
  return best;
}

/** 0 = normal follow camera, 1 = full over-the-shoulder view. */
function shoulderBlend(): number {
  return (
    1 -
    THREE.MathUtils.smoothstep(
      cameraState.distance,
      OTS_NEAR_DISTANCE,
      OTS_START_DISTANCE,
    )
  );
}

/** Effective pitch band at the current zoom (base pitch + clamp floor). */
function pitchBand(): { base: number; min: number } {
  const zoomFrac =
    (cameraState.distance - cameraState.minDistance) /
    (cameraState.maxDistance - cameraState.minDistance);
  const t = shoulderBlend();
  const base = THREE.MathUtils.lerp(
    THREE.MathUtils.lerp(PITCH_NEAR, PITCH_FAR, zoomFrac),
    OTS_PITCH,
    t,
  );
  const min = THREE.MathUtils.lerp(PITCH_MIN, OTS_PITCH_MIN, t);
  return { base, min };
}

type UiState = ReturnType<typeof useGame.getState>;

/** Panels that need the OS cursor back (pointer lock released while open). The
 * central menu (map/economy/leaderboard/inventory/settings/exit) is a single
 * `menuOpen` flag now. */
function uiBlocksPointerLock(s: UiState): boolean {
  return (
    s.menuOpen ||
    s.chatOpen ||
    s.craftOpen ||
    s.marketOpen ||
    s.vendorOpen
  );
}

export function CameraRig() {
  const { camera, gl, scene, events } = useThree();
  const target = useRef(new THREE.Vector3());
  const keys = useRef({ q: false, e: false });
  const dragging = useRef(false);
  const lastPointer = useRef({ x: 0, y: 0 });
  /** Smoothed occlusion fraction: snaps in fast, recovers slowly. */
  const occT = useRef(1);
  /** 0 = street camera, 1 = confined to the walk-in room (blended). */
  const insideBlend = useRef(0);
  /** Last room the player stood in (host building excluded from occlusion,
   * bounds confine the camera); fields are mutated in place, no per-frame
   * allocations. */
  const roomRef = useRef({ key: "", building: -1, x0: 0, z0: 0, x1: 0, z1: 0 });

  useEffect(() => {
    const canvas = gl.domElement;

    const requestLock = () => {
      if (document.pointerLockElement === canvas) return;
      try {
        // Returns a promise in modern browsers; rejection (e.g. the ~1.3 s
        // cooldown after an Escape exit) just means the next click retries.
        const req = canvas.requestPointerLock() as unknown as
          | Promise<void>
          | undefined;
        req?.catch?.(() => {});
      } catch {
        // Older engines throw synchronously; same story.
      }
    };

    const onLockError = () => {
      cameraState.lockUnavailable = true;
    };

    const onLockChange = () => {
      const locked = document.pointerLockElement === canvas;
      cameraState.locked = locked;
      if (locked) cameraState.lockUnavailable = false;
      if (!locked) {
        dragging.current = false;
        cameraState.dragging = false;
        // Escape exits pointer lock at the browser level (returning the OS
        // cursor) without ever reaching the page — that first press just frees
        // the mouse. The menu is opened by a *second* Escape, which now lands
        // as a normal keydown in PlayerInput because the page is unlocked.
      }
    };

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      // Multiplicative steps: constant feel across the whole zoom range.
      cameraState.distance = THREE.MathUtils.clamp(
        cameraState.distance * Math.exp(event.deltaY * 0.0009),
        cameraState.minDistance,
        cameraState.maxDistance,
      );
    };
    const onContext = (event: MouseEvent) => event.preventDefault();
    // Z/X rotate the camera (Q/E belong to the ability hotbar).
    const onKey = (event: KeyboardEvent, down: boolean) => {
      if (event.code === "KeyZ") keys.current.q = down;
      if (event.code === "KeyX") keys.current.e = down;
    };
    const onKeyDown = (e: KeyboardEvent) => onKey(e, true);
    const onKeyUp = (e: KeyboardEvent) => onKey(e, false);

    const onPointerDown = (event: PointerEvent) => {
      if (event.button === 2) {
        dragging.current = true;
        cameraState.dragging = true;
        lastPointer.current = { x: event.clientX, y: event.clientY };
      }
      // Any canvas press (re)acquires mouse-look when no panel needs the
      // cursor. PlayerInput ignores the unlocked click, so the acquiring
      // click never fires the weapon.
      if (!cameraState.locked && !uiBlocksPointerLock(useGame.getState())) {
        requestLock();
      }
    };
    const onPointerMove = (event: PointerEvent) => {
      if (cameraState.locked) {
        // Mouse-look: deltas rotate the view directly. Applies during RMB
        // free-look too — the RMB flag only freezes character facing.
        cameraState.yaw += event.movementX * LOOK_SENS;
        const { base, min } = pitchBand();
        cameraState.pitchOffset = THREE.MathUtils.clamp(
          cameraState.pitchOffset + event.movementY * LOOK_SENS,
          min - base,
          PITCH_MAX - base,
        );
        return;
      }
      if (!dragging.current) return;
      const dx = event.clientX - lastPointer.current.x;
      const dy = event.clientY - lastPointer.current.y;
      lastPointer.current = { x: event.clientX, y: event.clientY };
      // Unlocked fallback (UI open / pointer lock unavailable): RMB drag
      // orbits like the legacy scheme and persists on release.
      cameraState.yaw += dx * DRAG_SENS;
      const { base, min } = pitchBand();
      cameraState.pitchOffset = THREE.MathUtils.clamp(
        cameraState.pitchOffset + dy * DRAG_SENS,
        min - base,
        PITCH_MAX - base,
      );
    };
    const onPointerUp = (event: PointerEvent) => {
      if (event.button === 2) {
        dragging.current = false;
        cameraState.dragging = false;
      }
    };
    const onBlur = () => {
      dragging.current = false;
      cameraState.dragging = false;
    };

    // Release the lock whenever a panel opens; try to re-acquire the moment
    // everything closes (works when the close came from a click/keypress —
    // both count as user activation — otherwise the next canvas click does).
    let wasBlocked = uiBlocksPointerLock(useGame.getState());
    const unsubscribe = useGame.subscribe((s) => {
      const blocked = uiBlocksPointerLock(s);
      if (blocked === wasBlocked) return;
      wasBlocked = blocked;
      if (blocked) {
        if (document.pointerLockElement === canvas) document.exitPointerLock();
      } else {
        requestLock();
      }
    });

    document.addEventListener("pointerlockchange", onLockChange);
    document.addEventListener("pointerlockerror", onLockError);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("contextmenu", onContext);
    canvas.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("blur", onBlur);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      unsubscribe();
      cameraState.locked = false;
      if (document.pointerLockElement === canvas) document.exitPointerLock();
      document.removeEventListener("pointerlockchange", onLockChange);
      document.removeEventListener("pointerlockerror", onLockError);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("contextmenu", onContext);
      canvas.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [gl]);

  useFrame((_, dt) => {
    // Dev/screenshot override: window.__freecam = { pos: [x,y,z], look: [x,y,z] }
    // pins the camera for validation captures (set to null to release).
    if (import.meta.env.DEV) {
      const fc = (
        window as unknown as { __freecam?: { pos: number[]; look: number[] } | null }
      ).__freecam;
      if (fc) {
        camera.position.set(fc.pos[0], fc.pos[1], fc.pos[2]);
        camera.lookAt(fc.look[0], fc.look[1], fc.look[2]);
        return;
      }
    }
    perf.begin("camera");
    if (keys.current.q) cameraState.yaw += dt * 1.8;
    if (keys.current.e) cameraState.yaw -= dt * 1.8;

    const player = game.entities.get(game.localEntityId);
    const tx = player ? player.x : game.predicted.x;
    const tz = player ? player.z : game.predicted.z;

    // Smooth follow; snap on long-range teleports (death/extraction respawn).
    const next = nextTargetScratch.set(tx, 0, tz);
    if (target.current.distanceTo(next) > 40) {
      target.current.copy(next);
    } else {
      target.current.lerp(next, Math.min(1, dt * 8));
    }

    const shoulderT = shoulderBlend();
    const { base: basePitch, min: pitchMin } = pitchBand();
    const pitch = THREE.MathUtils.clamp(
      basePitch + cameraState.pitchOffset,
      pitchMin,
      PITCH_MAX,
    );
    const yaw = cameraState.yaw;

    // Recoil: translate the whole view (camera + look target) by the decaying
    // kick, plus a tiny random jitter while the jolt is fresh. Scales gently
    // with zoom so the kick stays visible when pulled back.
    const decay = Math.exp(-dt * 10);
    recoil.x *= decay;
    recoil.z *= decay;
    recoil.jolt *= Math.exp(-dt * 14);
    const kickScale = 0.6 + cameraState.distance / 60;
    const jitter = recoil.jolt * kickScale;
    const offX = recoil.x * kickScale + (Math.random() - 0.5) * jitter;
    const offZ = recoil.z * kickScale + (Math.random() - 0.5) * jitter;

    // Shoulder view: raise the look target to eye height and slide the whole
    // rig over the right shoulder (perpendicular to camera forward).
    const lookY = THREE.MathUtils.lerp(LOOK_HEIGHT, OTS_EYE_HEIGHT, shoulderT);
    // General off-center framing along camera-right: pushes the character to
    // the left of the frame at normal/close zoom, then fades to a centered
    // view as you pull far out (so the tactical overview reads with the cursor
    // visible around the character). Also fades as the shoulder view engages,
    // which supplies its own (larger) shoulder slide instead.
    const offCenterFade =
      1 -
      THREE.MathUtils.smoothstep(
        cameraState.distance,
        OFFCENTER_FADE_START,
        OFFCENTER_FADE_END,
      );
    const offCenter =
      cameraState.distance * OFFCENTER_FRAC * offCenterFade * (1 - shoulderT);
    const side = OTS_SHOULDER_OFFSET * shoulderT + offCenter;
    // Lead the look target ahead of the character along camera-forward so the
    // crosshair shows where you can shoot; fades out as the shoulder view
    // (which uses the shoulder offset instead) engages.
    const forwardX = -Math.cos(yaw);
    const forwardZ = -Math.sin(yaw);
    const lookAhead = cameraState.distance * LOOK_AHEAD_FRAC * (1 - shoulderT);
    const lookX =
      target.current.x + offX + Math.sin(yaw) * side + forwardX * lookAhead;
    const lookZ =
      target.current.z + offZ - Math.cos(yaw) * side + forwardZ * lookAhead;

    const horizontal = Math.cos(pitch) * cameraState.distance;
    const height = Math.sin(pitch) * cameraState.distance;
    const desX = lookX + Math.cos(yaw) * horizontal;
    const desY = lookY + height;
    const desZ = lookZ + Math.sin(yaw) * horizontal;

    // --- Wall collision ----------------------------------------------------
    // Inside a walk-in room the exterior shell is hidden, so instead of
    // testing walls the camera is confined to the room's footprint; on the
    // street, buildings between the player's head and the lens pull the
    // camera in so walls never cross the view. Both blend smoothly.
    const room = interiorRegistry.roomAt(target.current.x, target.current.z, 0.3);
    if (room) {
      const r = roomRef.current;
      r.key = chunkKey(room.coord.x, room.coord.z);
      r.building = room.building;
      r.x0 = room.bounds[0];
      r.z0 = room.bounds[1];
      r.x1 = room.bounds[2];
      r.z1 = room.bounds[3];
    }
    insideBlend.current +=
      ((room ? 1 : 0) - insideBlend.current) * Math.min(1, dt * 6);
    const headX = target.current.x;
    const headY = lookY + 0.4;
    const headZ = target.current.z;
    // Occlusion clamp (the host building of the current/last room is exempt —
    // its shell is hidden while the confinement takes over).
    const skipHost = insideBlend.current > 0.01 && roomRef.current.building >= 0;
    const rawT = cameraOcclusionT(
      headX,
      headY,
      headZ,
      desX,
      desY,
      desZ,
      skipHost ? roomRef.current.key : null,
      skipHost ? roomRef.current.building : -1,
    );
    occT.current =
      rawT < occT.current
        ? THREE.MathUtils.lerp(occT.current, rawT, Math.min(1, dt * 16))
        : THREE.MathUtils.lerp(occT.current, rawT, Math.min(1, dt * 4));
    const segLen = Math.max(
      1e-4,
      Math.hypot(desX - headX, desY - headY, desZ - headZ),
    );
    const tEff = Math.max(occT.current - OCCLUDE_PAD / segLen, OCCLUDE_MIN_FRAC);
    const occX = headX + (desX - headX) * tEff;
    const occY = headY + (desY - headY) * tEff;
    const occZ = headZ + (desZ - headZ) * tEff;
    // Room confinement: pull the camera in ALONG its view ray until it sits
    // inside the room rect (plus margin). Scaling the ray instead of clamping
    // X/Z per axis keeps the full outdoor pitch range available inside — a
    // low pan just brings the lens closer instead of snapping top-down.
    const blend = insideBlend.current;
    let finalX = occX;
    let finalY = occY;
    let finalZ = occZ;
    if (blend > 0.001) {
      const r = roomRef.current;
      const ddx = desX - headX;
      const ddz = desZ - headZ;
      let tRoom = 1;
      if (ddx > 1e-6) tRoom = Math.min(tRoom, (r.x1 + ROOM_CAM_MARGIN - headX) / ddx);
      else if (ddx < -1e-6) tRoom = Math.min(tRoom, (r.x0 - ROOM_CAM_MARGIN - headX) / ddx);
      if (ddz > 1e-6) tRoom = Math.min(tRoom, (r.z1 + ROOM_CAM_MARGIN - headZ) / ddz);
      else if (ddz < -1e-6) tRoom = Math.min(tRoom, (r.z0 - ROOM_CAM_MARGIN - headZ) / ddz);
      tRoom = Math.max(tRoom, OCCLUDE_MIN_FRAC);
      const confX = headX + ddx * tRoom;
      const confY = headY + (desY - headY) * tRoom;
      const confZ = headZ + ddz * tRoom;
      finalX = THREE.MathUtils.lerp(occX, confX, blend);
      finalY = THREE.MathUtils.lerp(occY, confY, blend);
      finalZ = THREE.MathUtils.lerp(occZ, confZ, blend);
    }
    camera.position.set(finalX, finalY, finalZ);
    camera.lookAt(lookX, lookY, lookZ);

    // The default 34° FOV is telephoto — right for the pulled-back view but
    // claustrophobic at 1.5 m — so widen it as the shoulder view engages.
    const persp = camera as THREE.PerspectiveCamera;
    const fov = THREE.MathUtils.lerp(FOV_BASE, FOV_OTS, shoulderT);
    if (Math.abs(persp.fov - fov) > 0.01) {
      persp.fov = fov;
      persp.updateProjectionMatrix();
    }

    // Thin the fog when zoomed far out so the wider view stays readable.
    // Slightly superlinear so the CityProxy skyline reaches the horizon at
    // max zoom instead of drowning in haze; street-level zoom is unchanged.
    if (scene.fog instanceof THREE.FogExp2) {
      const spread = Math.max(1, (cameraState.distance / FOG_BASE_DISTANCE) ** 1.35);
      scene.fog.density = styleRuntime.fogBaseDensity / spread;
    }

    // While locked, no mouse events fire as the camera/character moves, so
    // re-raycast the center crosshair each frame to keep enemy hover fresh.
    if (cameraState.locked) events.update?.();
    perf.end("camera");
  });

  return null;
}
