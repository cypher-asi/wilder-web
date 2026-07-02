// Isometric orbit camera: orbits and follows the player.
// Yaw auto-rotates toward the cursor's horizontal offset from screen center
// (with a center deadzone); Q/E also rotates. Right-mouse drag tilts the
// camera up/down; wheel zooms street<->overview.

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { game } from "../state/game";

export const cameraState = {
  yaw: Math.PI / 4,
  distance: 26,
  minDistance: 10,
  maxDistance: 60,
  /** user pitch adjustment (RMB drag), radians, added to zoom-based pitch */
  pitchOffset: 0,
};

const YAW_DEADZONE = 0.15; // normalized screen fraction around center
const YAW_MAX_SPEED = 1.5; // rad/s at screen edge
const PITCH_MIN = THREE.MathUtils.degToRad(20);
const PITCH_MAX = THREE.MathUtils.degToRad(80);

export function CameraRig() {
  const { camera, gl } = useThree();
  const target = useRef(new THREE.Vector3());
  const keys = useRef({ q: false, e: false });
  const mouse = useRef({ x: 0, active: false });
  const basePitch = useRef(THREE.MathUtils.degToRad(52));

  useEffect(() => {
    const canvas = gl.domElement;
    let tilting = false;
    let lastY = 0;

    const onPointerDown = (event: PointerEvent) => {
      if (event.button === 2) {
        tilting = true;
        lastY = event.clientY;
      }
    };
    const onPointerMove = (event: PointerEvent) => {
      mouse.current.x = event.clientX;
      mouse.current.active = true;
      if (!tilting) return;
      const dy = event.clientY - lastY;
      lastY = event.clientY;
      // Clamp so total pitch (zoom base + offset) stays in the allowed band.
      cameraState.pitchOffset = THREE.MathUtils.clamp(
        cameraState.pitchOffset - dy * 0.005,
        PITCH_MIN - basePitch.current,
        PITCH_MAX - basePitch.current,
      );
    };
    const onPointerUp = () => (tilting = false);
    const onPointerLeave = () => (mouse.current.active = false);
    const onBlur = () => (mouse.current.active = false);
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      cameraState.distance = THREE.MathUtils.clamp(
        cameraState.distance + event.deltaY * 0.03,
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

    canvas.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    document.documentElement.addEventListener("pointerleave", onPointerLeave);
    window.addEventListener("blur", onBlur);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("contextmenu", onContext);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      canvas.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      document.documentElement.removeEventListener("pointerleave", onPointerLeave);
      window.removeEventListener("blur", onBlur);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("contextmenu", onContext);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [gl]);

  useFrame((_, dt) => {
    if (keys.current.q) cameraState.yaw += dt * 1.8;
    if (keys.current.e) cameraState.yaw -= dt * 1.8;

    // Auto-yaw: rotation speed proportional to cursor offset from center,
    // with a deadzone so the camera holds still near the middle.
    if (mouse.current.active && window.innerWidth > 0) {
      const nx = (mouse.current.x / window.innerWidth) * 2 - 1;
      const mag = Math.abs(nx);
      if (mag > YAW_DEADZONE) {
        const t = (mag - YAW_DEADZONE) / (1 - YAW_DEADZONE);
        cameraState.yaw += Math.sign(nx) * t * YAW_MAX_SPEED * dt;
      }
    }

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

    // Zoom-dependent base pitch plus user tilt (RMB drag), clamped to band.
    const zoomFrac =
      (cameraState.distance - cameraState.minDistance) /
      (cameraState.maxDistance - cameraState.minDistance);
    basePitch.current = THREE.MathUtils.lerp(
      THREE.MathUtils.degToRad(42),
      THREE.MathUtils.degToRad(58),
      zoomFrac,
    );
    const pitch = THREE.MathUtils.clamp(
      basePitch.current + cameraState.pitchOffset,
      PITCH_MIN,
      PITCH_MAX,
    );

    const horizontal = Math.cos(pitch) * cameraState.distance;
    const height = Math.sin(pitch) * cameraState.distance;
    camera.position.set(
      target.current.x + Math.cos(cameraState.yaw) * horizontal,
      height,
      target.current.z + Math.sin(cameraState.yaw) * horizontal,
    );
    camera.lookAt(target.current.x, 1.2, target.current.z);
  });

  return null;
}
