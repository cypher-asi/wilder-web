// Isometric orbit camera: fixed pitch band, orbits and follows the player.
// Drag (right/middle mouse) or Q/E rotates; wheel zooms street<->overview.

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { game } from "../state/game";

export const cameraState = {
  yaw: Math.PI / 4,
  distance: 26,
  minDistance: 10,
  maxDistance: 60,
  /** camera pitch above horizon, radians (isometric band) */
  pitch: THREE.MathUtils.degToRad(52),
};

export function CameraRig() {
  const { camera, gl } = useThree();
  const target = useRef(new THREE.Vector3());
  const keys = useRef({ q: false, e: false });

  useEffect(() => {
    const canvas = gl.domElement;
    let dragging = false;
    let lastX = 0;

    const onPointerDown = (event: PointerEvent) => {
      if (event.button === 1 || event.button === 2) {
        dragging = true;
        lastX = event.clientX;
      }
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!dragging) return;
      const dx = event.clientX - lastX;
      lastX = event.clientX;
      cameraState.yaw += dx * 0.008;
    };
    const onPointerUp = () => (dragging = false);
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
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("contextmenu", onContext);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      canvas.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("contextmenu", onContext);
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

    // Zoom-dependent pitch: slightly lower at street level for drama.
    const zoomFrac =
      (cameraState.distance - cameraState.minDistance) /
      (cameraState.maxDistance - cameraState.minDistance);
    const pitch = THREE.MathUtils.lerp(
      THREE.MathUtils.degToRad(42),
      THREE.MathUtils.degToRad(58),
      zoomFrac,
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
