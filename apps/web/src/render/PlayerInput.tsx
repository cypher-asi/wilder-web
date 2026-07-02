// Input: WASD (camera-relative) with client prediction at the server tick
// rate, and click-to-move via ground raycast.

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { stepMove } from "../game/collision";
import { GameConnection } from "../net/connection";
import { game, useGame } from "../state/game";
import { cameraState } from "./CameraRig";

const TICK_DT = 1 / 20;

export function PlayerInput({ connection }: { connection: GameConnection }) {
  const { camera, gl } = useThree();
  const keys = useRef<Record<string, boolean>>({});
  const accumulator = useRef(0);
  const raycaster = useRef(new THREE.Raycaster());
  const groundPlane = useRef(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0));

  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      // Ignore game keys while typing in chat/UI inputs.
      if ((event.target as HTMLElement)?.tagName === "INPUT") return;
      keys.current[event.code] = true;
      if (event.code === "KeyI" || event.code === "Tab") {
        event.preventDefault();
        useGame.getState().toggleInventory();
      }
      if (event.code === "Enter") {
        useGame.getState().set({ chatOpen: true });
      }
    };
    const up = (event: KeyboardEvent) => {
      keys.current[event.code] = false;
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  // Click-to-move on left click.
  useEffect(() => {
    const canvas = gl.domElement;
    const onClick = (event: PointerEvent) => {
      if (event.button !== 0) return;
      const rect = canvas.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.current.setFromCamera(ndc, camera);
      const hit = new THREE.Vector3();
      if (raycaster.current.ray.intersectPlane(groundPlane.current, hit)) {
        const seq = game.nextSeq++;
        connection.send({ t: "MoveTo", d: { seq, x: hit.x, z: hit.z } });
        game.moveMarker = { x: hit.x, z: hit.z, at: performance.now() };
      }
    };
    canvas.addEventListener("pointerdown", onClick);
    return () => canvas.removeEventListener("pointerdown", onClick);
  }, [camera, gl, connection]);

  useFrame((_, dt) => {
    accumulator.current += dt;
    while (accumulator.current >= TICK_DT) {
      accumulator.current -= TICK_DT;
      stepInput();
    }
  });

  function stepInput() {
    const k = keys.current;
    let ix = 0;
    let iz = 0;
    if (k.KeyW || k.ArrowUp) iz -= 1;
    if (k.KeyS || k.ArrowDown) iz += 1;
    if (k.KeyA || k.ArrowLeft) ix -= 1;
    if (k.KeyD || k.ArrowRight) ix += 1;
    if (ix === 0 && iz === 0) return;

    const run = !k.ShiftLeft && !k.ShiftRight; // run by default, shift walks

    // Camera-relative: forward = away from camera on XZ.
    const yaw = cameraState.yaw;
    const fx = -Math.cos(yaw);
    const fz = -Math.sin(yaw);
    const rx = -fz;
    const rz = fx;
    let dx = fx * -iz + rx * ix;
    let dz = fz * -iz + rz * ix;
    const len = Math.hypot(dx, dz);
    dx /= len;
    dz /= len;

    const seq = game.nextSeq++;
    connection.send({ t: "MoveInput", d: { seq, dx, dz, run } });
    game.pendingInputs.push({ seq, dx, dz, run, dt: TICK_DT });
    if (game.pendingInputs.length > 120) game.pendingInputs.shift();

    // Predict locally with identical rules.
    const [nx, nz] = stepMove(
      game.chunks,
      game.predicted.x,
      game.predicted.z,
      dx,
      dz,
      run,
      TICK_DT,
    );
    game.predicted.x = nx;
    game.predicted.z = nz;
    game.predicted.yaw = Math.atan2(dz, dx);
    game.lastDirectInputAt = performance.now();
    game.moveMarker = null;
  }

  return <MoveMarker />;
}

function MoveMarker() {
  const ref = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    if (!ref.current) return;
    const marker = game.moveMarker;
    if (!marker || performance.now() - marker.at > 4000) {
      ref.current.visible = false;
      return;
    }
    ref.current.visible = true;
    ref.current.position.set(marker.x, 0.05, marker.z);
    const pulse = 0.8 + Math.sin(clock.elapsedTime * 6) * 0.2;
    ref.current.scale.setScalar(pulse);
  });
  return (
    <mesh ref={ref} rotation={[-Math.PI / 2, 0, 0]} visible={false}>
      <ringGeometry args={[0.35, 0.5, 24]} />
      <meshBasicMaterial color="#40e8ff" transparent opacity={0.85} depthWrite={false} />
    </mesh>
  );
}
