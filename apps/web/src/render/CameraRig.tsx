// Ascent-style follow camera: high default pitch, pulled back so the character
// stays small against the environment. The resting camera changes with Q/E
// (yaw), wheel (zoom), and RMB drag (orbit/tilt, which persists).
// Holding right-click and dragging orbits the view: horizontal drag rotates
// around the player, vertical drag tilts up/down. Both stay where you leave
// them on release. (A quick RMB tap without dragging is still click-to-move,
// handled in PlayerInput.)

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { game } from "../state/game";

export const cameraState = {
  yaw: Math.PI / 4,
  distance: 34,
  minDistance: 20,
  maxDistance: 120,
};

/** Fog density at the default zoom; thinned as the camera pulls back. */
const FOG_BASE_DENSITY = 0.016;
const FOG_BASE_DISTANCE = 48;

const PITCH_NEAR = THREE.MathUtils.degToRad(52);
const PITCH_FAR = THREE.MathUtils.degToRad(62);
/** Total pitch band while RMB-dragging; the low end is near-horizontal. */
const PITCH_MIN = THREE.MathUtils.degToRad(5);
const PITCH_MAX = THREE.MathUtils.degToRad(80);

export function CameraRig() {
  const { camera, gl, scene } = useThree();
  const target = useRef(new THREE.Vector3());
  const keys = useRef({ q: false, e: false });
  const pitchOffset = useRef(0);
  const dragging = useRef(false);
  const lastPointer = useRef({ x: 0, y: 0 });

  useEffect(() => {
    const canvas = gl.domElement;

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
    const onKey = (event: KeyboardEvent, down: boolean) => {
      if (event.code === "KeyQ") keys.current.q = down;
      if (event.code === "KeyE") keys.current.e = down;
    };
    const onKeyDown = (e: KeyboardEvent) => onKey(e, true);
    const onKeyUp = (e: KeyboardEvent) => onKey(e, false);

    const onPointerDown = (event: PointerEvent) => {
      if (event.button === 2) {
        dragging.current = true;
        lastPointer.current = { x: event.clientX, y: event.clientY };
      }
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!dragging.current) return;
      const dx = event.clientX - lastPointer.current.x;
      const dy = event.clientY - lastPointer.current.y;
      lastPointer.current = { x: event.clientX, y: event.clientY };
      // Horizontal drag orbits around the player and persists on release.
      cameraState.yaw += dx * 0.005;
      // Vertical drag tilts; clamp so the total pitch stays in the band.
      const zoomFrac =
        (cameraState.distance - cameraState.minDistance) /
        (cameraState.maxDistance - cameraState.minDistance);
      const basePitch = THREE.MathUtils.lerp(PITCH_NEAR, PITCH_FAR, zoomFrac);
      pitchOffset.current = THREE.MathUtils.clamp(
        pitchOffset.current + dy * 0.005,
        PITCH_MIN - basePitch,
        PITCH_MAX - basePitch,
      );
    };
    const onPointerUp = (event: PointerEvent) => {
      if (event.button === 2) dragging.current = false;
    };
    const onBlur = () => (dragging.current = false);

    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("contextmenu", onContext);
    canvas.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("blur", onBlur);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
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
    if (keys.current.q) cameraState.yaw += dt * 1.8;
    if (keys.current.e) cameraState.yaw -= dt * 1.8;

    const player = game.entities.get(game.localEntityId);
    const tx = player ? player.x : game.predicted.x;
    const tz = player ? player.z : game.predicted.z;

    // Smooth follow; snap on long-range teleports (death/extraction respawn).
    const next = new THREE.Vector3(tx, 0, tz);
    if (target.current.distanceTo(next) > 40) {
      target.current.copy(next);
    } else {
      target.current.lerp(next, Math.min(1, dt * 8));
    }

    // Slightly steeper look-down when zoomed out (reads more top-down).
    const zoomFrac =
      (cameraState.distance - cameraState.minDistance) /
      (cameraState.maxDistance - cameraState.minDistance);
    const basePitch = THREE.MathUtils.lerp(PITCH_NEAR, PITCH_FAR, zoomFrac);
    const pitch = THREE.MathUtils.clamp(
      basePitch + pitchOffset.current,
      PITCH_MIN,
      PITCH_MAX,
    );
    const yaw = cameraState.yaw;

    const horizontal = Math.cos(pitch) * cameraState.distance;
    const height = Math.sin(pitch) * cameraState.distance;
    camera.position.set(
      target.current.x + Math.cos(yaw) * horizontal,
      height,
      target.current.z + Math.sin(yaw) * horizontal,
    );
    camera.lookAt(target.current.x, 1.2, target.current.z);

    // Thin the fog when zoomed far out so the wider view stays readable.
    if (scene.fog instanceof THREE.FogExp2) {
      const spread = Math.max(1, cameraState.distance / FOG_BASE_DISTANCE);
      scene.fog.density = FOG_BASE_DENSITY / spread;
    }
  });

  return null;
}
