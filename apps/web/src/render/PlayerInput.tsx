// Input: WASD (camera-relative) with client prediction at the server tick
// rate, twin-stick mouse aim (character faces the cursor), hold-LMB to fire
// at the aim point, and right-click-to-move via ground raycast.

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { stepMove } from "../game/collision";
import { GameConnection } from "../net/connection";
import { game, useGame } from "../state/game";
import { cameraState } from "./CameraRig";
import { groundHeightAt } from "./Ground";

const TICK_DT = 1 / 20;

/** Client mirror of server weapon cooldowns (seconds) for fire pacing. */
const WEAPON_COOLDOWN: Record<string, number> = {
  Pistol: 0.6,
  Smg: 0.15,
  Pipe: 1.0,
  Knife: 0.55,
};
const FIST_COOLDOWN = 0.8;

export function equippedCooldown(): number {
  const weapon = useGame.getState().inventory?.equipped_weapon;
  return (weapon && WEAPON_COOLDOWN[weapon]) || FIST_COOLDOWN;
}

export function PlayerInput({ connection }: { connection: GameConnection }) {
  const { camera, gl } = useThree();
  const keys = useRef<Record<string, boolean>>({});
  const accumulator = useRef(0);
  const pointer = useRef({ x: 0, y: 0, inside: false });
  const firing = useRef(false);
  const lastShotAt = useRef(0);
  const raycaster = useRef(new THREE.Raycaster());
  const groundPlane = useRef(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0));

  useEffect(() => {
    const canvas = gl.domElement;

    const down = (event: KeyboardEvent) => {
      // Ignore game keys while typing in chat/UI inputs.
      if ((event.target as HTMLElement)?.tagName === "INPUT") return;
      keys.current[event.code] = true;
      if (event.code === "KeyI" || event.code === "Tab") {
        event.preventDefault();
        useGame.getState().toggleInventory();
      }
      if (event.code === "KeyM") {
        event.preventDefault();
        useGame.getState().toggleMap();
      }
      if (event.code === "Enter") {
        useGame.getState().set({ chatOpen: true });
      }
      if (event.code === "Space") {
        event.preventDefault();
        // Attack toward the aim point (fallback to facing).
        const seq = game.nextSeq++;
        const tx = game.aim.active
          ? game.aim.x
          : game.predicted.x + Math.cos(game.predicted.yaw) * 3;
        const tz = game.aim.active
          ? game.aim.z
          : game.predicted.z + Math.sin(game.predicted.yaw) * 3;
        connection.send({ t: "Attack", d: { seq, tx, tz } });
      }
    };
    const up = (event: KeyboardEvent) => {
      keys.current[event.code] = false;
    };

    const onPointerMove = (event: PointerEvent) => {
      pointer.current.x = (event.clientX / window.innerWidth) * 2 - 1;
      pointer.current.y = -(event.clientY / window.innerHeight) * 2 + 1;
      pointer.current.inside = true;
    };
    const onPointerLeave = () => (pointer.current.inside = false);
    const onPointerDown = (event: PointerEvent) => {
      if (event.button === 0) firing.current = true;
    };
    const onPointerUp = (event: PointerEvent) => {
      if (event.button === 0) firing.current = false;
    };
    const onBlur = () => (firing.current = false);

    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("pointermove", onPointerMove);
    document.documentElement.addEventListener("pointerleave", onPointerLeave);
    canvas.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("pointermove", onPointerMove);
      document.documentElement.removeEventListener("pointerleave", onPointerLeave);
      canvas.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [gl, connection]);

  function onGroundClick(x: number, z: number) {
    const seq = game.nextSeq++;
    connection.send({ t: "MoveTo", d: { seq, x, z } });
    game.moveMarker = { x, z, at: performance.now() };
  }

  useFrame((_, dt) => {
    updateAim();
    updateFire();
    accumulator.current += dt;
    while (accumulator.current >= TICK_DT) {
      accumulator.current -= TICK_DT;
      stepInput();
    }
  });

  /** Project the cursor onto the ground plane at the player's elevation. */
  function updateAim() {
    if (!pointer.current.inside) {
      game.aim.active = false;
      return;
    }
    const px = game.predicted.x;
    const pz = game.predicted.z;
    groundPlane.current.constant = -groundHeightAt(px, pz);
    raycaster.current.setFromCamera(
      new THREE.Vector2(pointer.current.x, pointer.current.y),
      camera,
    );
    const hit = new THREE.Vector3();
    if (!raycaster.current.ray.intersectPlane(groundPlane.current, hit)) return;
    game.aim.x = hit.x;
    game.aim.z = hit.z;
    const dx = hit.x - px;
    const dz = hit.z - pz;
    if (dx * dx + dz * dz > 0.01) {
      game.aim.yaw = Math.atan2(dz, dx);
    }
    game.aim.active = true;
  }

  /** Hold-to-fire at the equipped weapon's rate, aimed at the cursor. */
  function updateFire() {
    if (!firing.current || !game.aim.active) return;
    const now = performance.now();
    if (now - lastShotAt.current < equippedCooldown() * 1000) return;
    lastShotAt.current = now;
    const seq = game.nextSeq++;
    connection.send({ t: "Attack", d: { seq, tx: game.aim.x, tz: game.aim.z } });
  }

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

    // Camera-relative: forward = away from camera on XZ (including any
    // temporary RMB-drag orbit so controls match what's on screen).
    const yaw = cameraState.yaw + cameraState.yawOffset;
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
    // Facing follows the aim (twin-stick); fall back to move direction.
    game.predicted.yaw = game.aim.active ? game.aim.yaw : Math.atan2(dz, dx);
    game.lastDirectInputAt = performance.now();
    game.moveMarker = null;
  }

  return (
    <>
      <GroundClickPlane onGroundClick={onGroundClick} />
      <MoveMarker />
      <AimRing />
    </>
  );
}

/** Invisible plane that follows the player and receives click-to-move. */
function GroundClickPlane({
  onGroundClick,
}: {
  onGroundClick: (x: number, z: number) => void;
}) {
  const ref = useRef<THREE.Mesh>(null);
  useFrame(() => {
    ref.current?.position.set(game.predicted.x, 0, game.predicted.z);
  });
  return (
    <mesh
      ref={ref}
      rotation={[-Math.PI / 2, 0, 0]}
      // Right-click to move (context menu is suppressed on the canvas).
      onContextMenu={(e) => {
        if (e.delta > 4) return; // ignore drags
        onGroundClick(e.point.x, e.point.z);
      }}
    >
      <planeGeometry args={[400, 400]} />
      <meshBasicMaterial transparent opacity={0} depthWrite={false} colorWrite={false} />
    </mesh>
  );
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

/**
 * The Ascent-style aim ring: a red ring under the player with a directional
 * arc + aim line that tracks the mouse in real time.
 */
function AimRing() {
  const group = useRef<THREE.Group>(null);

  useFrame(() => {
    if (!group.current) return;
    const visible = game.localEntityId !== 0 && game.aim.active;
    group.current.visible = visible;
    if (!visible) return;
    const px = game.predicted.x;
    const pz = game.predicted.z;
    group.current.position.set(px, groundHeightAt(px, pz) + 0.05, pz);
    // Flat group: local +X maps to world +X, local +Y to world -Z, so a world
    // yaw of φ is a local rotation of -φ (see Euler XYZ order: Z applies first).
    group.current.rotation.set(-Math.PI / 2, 0, -game.aim.yaw);
  });

  return (
    <group ref={group} visible={false}>
      {/* base ring */}
      <mesh>
        <ringGeometry args={[0.55, 0.64, 40]} />
        <meshBasicMaterial color="#ff3040" transparent opacity={0.65} depthWrite={false} />
      </mesh>
      {/* direction arc (centered on local +X = aim direction) */}
      <mesh>
        <ringGeometry args={[0.68, 0.84, 16, 1, -0.45, 0.9]} />
        <meshBasicMaterial color="#ff3040" transparent opacity={0.95} depthWrite={false} />
      </mesh>
      {/* aim line extending toward the cursor */}
      <mesh position={[2.05, 0, 0]}>
        <planeGeometry args={[2.2, 0.05]} />
        <meshBasicMaterial color="#ff3040" transparent opacity={0.3} depthWrite={false} />
      </mesh>
    </group>
  );
}
