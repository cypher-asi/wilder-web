// Walk-in store interiors: for every InteriorSpec (game/interiors.ts) this
// renders the room the server carved out of the host building's ground
// floor — glossy dark floor with an accent keyline border, Sims-style low
// walls with glowing caps, the service counter (clickable), per-store
// furniture, a sliding tron door in each doorway, and a room light.
//
// The room renders whether the player is inside or not: from the street it
// is only visible through the doorway; once the player walks in, the host
// building's exterior shell hides (Buildings.tsx) and these low walls take
// over as the cutaway dollhouse view.

import { useMemo, useRef, useSyncExternalStore } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { openServicePanel } from "../game/interact";
import { interiorRegistry, InteriorDeco, InteriorSpec } from "../game/interiors";
import { POI_STYLES } from "../game/poi";
import { game } from "../state/game";
import { GROUND_Y } from "./building";

/** Sims-style wall cut height for interior walls. */
const WALL_H = 1.1;
/** Visual wall thickness (collision walls are 0.3; visuals sit inset). */
const WALL_T = 0.2;
/** Inset from the collision wall so exterior/interior surfaces never
 * coincide when the room spans the full footprint. */
const WALL_IN = 0.05;
/** Visual door gap half-width (matches the shell's carved hole). */
const DOOR_HALF = 1.1;
/** Doors slide open when the player is this close (either side). */
const DOOR_OPEN_RANGE = 2.6;
/** Seconds a door forced open with E stays open without proximity. */
const DOOR_FORCE_MS = 4000;

// ---------------------------------------------------------------------------
// Door state: module-level so PlayerInput (E key) and the HUD prompt can
// reach it without threading refs through the tree.
// ---------------------------------------------------------------------------

interface DoorState {
  /** 0 closed .. 1 open, animated. */
  openT: number;
  forcedUntil: number;
}

const doorStates = new Map<string, DoorState>();

function doorState(key: string): DoorState {
  let s = doorStates.get(key);
  if (!s) {
    s = { openT: 0, forcedUntil: 0 };
    doorStates.set(key, s);
  }
  return s;
}

export interface NearestDoor {
  spec: InteriorSpec;
  doorIndex: number;
  dist: number;
  open: boolean;
}

/** Nearest interior door to a world position within `maxDist`. */
export function nearestDoor(px: number, pz: number, maxDist = 3.5): NearestDoor | null {
  let best: NearestDoor | null = null;
  for (const spec of interiorRegistry.allSpecs()) {
    const frontZ = spec.bounds[1];
    for (let i = 0; i < spec.doors.length; i++) {
      const d = Math.hypot(spec.doors[i].x - px, frontZ - pz);
      if (d <= maxDist && (best === null || d < best.dist)) {
        best = {
          spec,
          doorIndex: i,
          dist: d,
          open: doorState(`${spec.key}#${i}`).openT > 0.5,
        };
      }
    }
  }
  return best;
}

/** E near a door: force it open for a few seconds. True if one was in range. */
export function pressOpenDoor(px: number, pz: number): boolean {
  const near = nearestDoor(px, pz);
  if (!near) return false;
  doorState(`${near.spec.key}#${near.doorIndex}`).forcedUntil =
    performance.now() + DOOR_FORCE_MS;
  return true;
}

// ---------------------------------------------------------------------------
// Shared materials (per accent color, cached — rooms of the same store kind
// share everything).
// ---------------------------------------------------------------------------

const floorMat = new THREE.MeshStandardMaterial({
  color: "#070b11",
  roughness: 0.16,
  metalness: 0.85,
  envMapIntensity: 0.9,
});
const wallMat = new THREE.MeshStandardMaterial({
  color: "#0a0f16",
  roughness: 0.42,
  metalness: 0.55,
});
const darkMetalMat = new THREE.MeshStandardMaterial({
  color: "#0b1018",
  roughness: 0.24,
  metalness: 0.85,
});
const doorPanelMat = new THREE.MeshStandardMaterial({
  color: "#0a1116",
  roughness: 0.12,
  metalness: 0.95,
  envMapIntensity: 1.1,
});

const glowCache = new Map<string, THREE.MeshBasicMaterial>();

/** Unlit emissive material (blooms); `boost` scales past 1 for hot lines. */
function glowMat(color: string, boost: number): THREE.MeshBasicMaterial {
  const key = `${color}@${boost}`;
  let mat = glowCache.get(key);
  if (!mat) {
    mat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(color).multiplyScalar(boost),
      toneMapped: false,
    });
    glowCache.set(key, mat);
  }
  return mat;
}

// ---------------------------------------------------------------------------
// Room geometry helpers
// ---------------------------------------------------------------------------

interface WallBox {
  x: number;
  z: number;
  w: number;
  d: number;
}

/** Low-wall boxes in room-local coords (origin at room center). */
function wallLayout(spec: InteriorSpec): WallBox[] {
  const [x0, z0, x1, z1] = spec.bounds;
  const w = x1 - x0;
  const d = z1 - z0;
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  const walls: WallBox[] = [];
  const inEdge = WALL_IN + WALL_T / 2;
  // Side + back walls.
  walls.push({ x: -w / 2 + inEdge, z: 0, w: WALL_T, d: d - WALL_IN * 2 });
  walls.push({ x: w / 2 - inEdge, z: 0, w: WALL_T, d: d - WALL_IN * 2 });
  walls.push({ x: 0, z: d / 2 - inEdge, w: w - (WALL_IN + WALL_T) * 2, d: WALL_T });
  // Front wall segments between the door gaps.
  const gaps = spec.doors
    .map((dr) => dr.x - cx)
    .sort((a, b) => a - b);
  let cursor = -w / 2 + WALL_IN + WALL_T;
  const frontZ = -d / 2 + inEdge;
  for (const gx of gaps) {
    const segEnd = gx - DOOR_HALF;
    if (segEnd > cursor + 0.05) {
      walls.push({ x: (cursor + segEnd) / 2, z: frontZ, w: segEnd - cursor, d: WALL_T });
    }
    cursor = gx + DOOR_HALF;
  }
  const end = w / 2 - WALL_IN - WALL_T;
  if (end > cursor + 0.05) {
    walls.push({ x: (cursor + end) / 2, z: frontZ, w: end - cursor, d: WALL_T });
  }
  return walls;
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

function Furniture({ deco, accent }: { deco: InteriorDeco; accent: string }) {
  const [x0, z0, x1, z1] = deco.box;
  const w = x1 - x0;
  const d = z1 - z0;
  const x = (x0 + x1) / 2;
  const z = (z0 + z1) / 2;
  const edge = glowMat(accent, 1.6);
  switch (deco.type) {
    case "shelf":
      return (
        <group position={[x, 0, z]}>
          <mesh position={[0, 0.85, 0]} material={wallMat} castShadow>
            <boxGeometry args={[w, 1.7, d]} />
          </mesh>
          {/* Glowing shelf lips. */}
          {[0.55, 1.1, 1.65].map((y) => (
            <mesh key={y} position={[0, y, 0]} material={edge}>
              <boxGeometry args={[w + 0.03, 0.025, d + 0.03]} />
            </mesh>
          ))}
        </group>
      );
    case "machine":
      return (
        <group position={[x, 0, z]}>
          <mesh position={[0, 0.8, 0]} material={darkMetalMat} castShadow>
            <boxGeometry args={[w, 1.6, d]} />
          </mesh>
          <mesh position={[0, 1.61, 0]} material={edge}>
            <boxGeometry args={[w * 0.8, 0.03, d * 0.8]} />
          </mesh>
          {/* Status panel strip on the aisle-facing side. */}
          <mesh
            position={[x0 < 0 ? w / 2 + 0.01 : -w / 2 - 0.01, 1.05, 0]}
            rotation={[0, x0 < 0 ? Math.PI / 2 : -Math.PI / 2, 0]}
            material={glowMat(accent, 2.0)}
          >
            <planeGeometry args={[d * 0.6, 0.14]} />
          </mesh>
        </group>
      );
    case "bench":
      return (
        <group position={[x, 0, z]}>
          <mesh position={[0, 0.475, 0]} material={darkMetalMat} castShadow>
            <boxGeometry args={[w, 0.95, d]} />
          </mesh>
          <mesh position={[0, 0.96, 0]} material={floorMat}>
            <boxGeometry args={[w + 0.05, 0.04, d + 0.05]} />
          </mesh>
          <mesh position={[0, 0.985, 0]} material={edge}>
            <boxGeometry args={[w + 0.06, 0.02, 0.03]} />
          </mesh>
        </group>
      );
    case "pedestal":
      return (
        <group position={[x, 0, z]}>
          <mesh position={[0, 0.25, 0]} material={darkMetalMat} castShadow>
            <cylinderGeometry args={[Math.min(w, d) / 2, Math.min(w, d) / 2 + 0.08, 0.5, 24]} />
          </mesh>
          <mesh position={[0, 0.51, 0]} rotation={[-Math.PI / 2, 0, 0]} material={edge}>
            <ringGeometry args={[Math.min(w, d) / 2 - 0.09, Math.min(w, d) / 2 - 0.02, 32]} />
          </mesh>
        </group>
      );
  }
}

/** The service counter: body, glossy top, glowing front edge, and a small
 * terminal screen. Clicking it interacts with the door's service. */
function Counter({
  box,
  accent,
  kind,
  entityId,
}: {
  box: [number, number, number, number];
  accent: string;
  kind: InteriorSpec["doors"][number]["kind"];
  entityId: number;
}) {
  const [x0, z0, x1, z1] = box;
  const w = x1 - x0;
  const d = z1 - z0;
  if (w < 0.05 || d < 0.05) return null;
  return (
    <group
      position={[(x0 + x1) / 2, 0, (z0 + z1) / 2]}
      onClick={(e) => {
        e.stopPropagation();
        openServicePanel(kind, entityId);
      }}
      onPointerOver={() => (document.body.style.cursor = "pointer")}
      onPointerOut={() => (document.body.style.cursor = "default")}
    >
      <mesh position={[0, 0.49, 0]} material={darkMetalMat} castShadow>
        <boxGeometry args={[w, 0.98, d]} />
      </mesh>
      <mesh position={[0, 1.0, 0]} material={floorMat}>
        <boxGeometry args={[w + 0.1, 0.05, d + 0.1]} />
      </mesh>
      {/* Hot line along the customer-facing (front, -z) edge. */}
      <mesh position={[0, 1.03, -d / 2 - 0.03]} material={glowMat(accent, 2.4)}>
        <boxGeometry args={[w + 0.1, 0.025, 0.03]} />
      </mesh>
      {/* Terminal screen angled toward the door. */}
      <group position={[0, 1.28, 0.05]} rotation={[-0.5, Math.PI, 0]}>
        <mesh material={darkMetalMat}>
          <boxGeometry args={[0.62, 0.44, 0.04]} />
        </mesh>
        <mesh position={[0, 0, 0.025]} material={glowMat(accent, 1.9)}>
          <planeGeometry args={[0.54, 0.36]} />
        </mesh>
      </group>
    </group>
  );
}

/**
 * Sliding tron door filling one carved doorway. The panel sinks into the
 * floor when the local player is near (or after E forces it); purely visual —
 * collision always allows passage through the gap.
 */
function SlidingDoor({
  spec,
  doorIndex,
  accent,
}: {
  spec: InteriorSpec;
  doorIndex: number;
  accent: string;
}) {
  const frontZ = spec.bounds[1];
  const doorX = spec.doors[doorIndex].x;
  const key = `${spec.key}#${doorIndex}`;
  const panel = useRef<THREE.Group>(null);
  const glowRef = useRef<THREE.Mesh>(null);

  useFrame((_, dt) => {
    const s = doorState(key);
    const px = game.predicted.x;
    const pz = game.predicted.z;
    const near = Math.hypot(px - doorX, pz - frontZ) < DOOR_OPEN_RANGE;
    const target = near || performance.now() < s.forcedUntil ? 1 : 0;
    const speed = dt / 0.4;
    s.openT = THREE.MathUtils.clamp(
      s.openT + (target > s.openT ? speed : -speed),
      0,
      1,
    );
    const t = THREE.MathUtils.smoothstep(s.openT, 0, 1);
    if (panel.current) {
      panel.current.position.y = 1.32 - t * 2.5;
      panel.current.visible = t < 0.99;
    }
    if (glowRef.current) {
      // Seam glows hotter mid-slide (the "dematerialize" pulse).
      const pulse = 1 + Math.sin(Math.min(t, 1 - t) * Math.PI) * 1.5;
      (glowRef.current.material as THREE.MeshBasicMaterial).color
        .set(accent)
        .multiplyScalar(1.8 * pulse);
    }
  });

  // The doorway band the exterior shell carved: z in [frontZ-0.3, frontZ].
  const z = -0.15;
  return (
    <group position={[doorX, 0, frontZ]}>
      {/* Frame: jambs + header with an accent keyline inner edge. */}
      <mesh position={[-1.04, DOOR_HOLE_VIS_H / 2, z]} material={darkMetalMat} castShadow>
        <boxGeometry args={[0.13, DOOR_HOLE_VIS_H, 0.34]} />
      </mesh>
      <mesh position={[1.04, DOOR_HOLE_VIS_H / 2, z]} material={darkMetalMat} castShadow>
        <boxGeometry args={[0.13, DOOR_HOLE_VIS_H, 0.34]} />
      </mesh>
      <mesh position={[0, DOOR_HOLE_VIS_H - 0.08, z]} material={darkMetalMat} castShadow>
        <boxGeometry args={[2.2, 0.16, 0.34]} />
      </mesh>
      <mesh position={[-0.975, DOOR_HOLE_VIS_H / 2 - 0.08, z]} material={glowMat(accent, 1.5)}>
        <boxGeometry args={[0.02, DOOR_HOLE_VIS_H - 0.16, 0.36]} />
      </mesh>
      <mesh position={[0.975, DOOR_HOLE_VIS_H / 2 - 0.08, z]} material={glowMat(accent, 1.5)}>
        <boxGeometry args={[0.02, DOOR_HOLE_VIS_H - 0.16, 0.36]} />
      </mesh>
      {/* Sliding panel (sinks into the floor). */}
      <group ref={panel} position={[0, 1.32, z]}>
        <mesh material={doorPanelMat} castShadow>
          <boxGeometry args={[1.93, 2.6, 0.09]} />
        </mesh>
        <mesh ref={glowRef} material={glowMat(accent, 1.8)}>
          <boxGeometry args={[0.035, 2.5, 0.11]} />
        </mesh>
        <mesh position={[0, -1.24, 0]} material={glowMat(accent, 1.8)}>
          <boxGeometry args={[1.85, 0.03, 0.11]} />
        </mesh>
      </group>
    </group>
  );
}

/** Matches DOOR_HOLE_H in building.ts (the shell's carved opening). */
const DOOR_HOLE_VIS_H = 2.9;

function InteriorRoom({ spec }: { spec: InteriorSpec }) {
  const [x0, z0, x1, z1] = spec.bounds;
  const w = x1 - x0;
  const d = z1 - z0;
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  const accent = POI_STYLES[spec.doors[0]?.kind]?.color ?? "#4fc3ff";
  const walls = useMemo(() => wallLayout(spec), [spec]);
  const capMat = glowMat(accent, 1.3);
  const lineMat = glowMat(accent, 1.1);

  return (
    <group position={[cx, GROUND_Y, cz]}>
      {/* Floor: glossy near-black slab with an accent keyline border. */}
      <mesh position={[0, -0.005, 0]} material={floorMat} receiveShadow>
        <boxGeometry args={[w - 0.08, 0.06, d - 0.08]} />
      </mesh>
      {[
        { x: 0, z: -d / 2 + 0.34, w: w - 0.75, d: 0.045 },
        { x: 0, z: d / 2 - 0.34, w: w - 0.75, d: 0.045 },
        { x: -w / 2 + 0.34, z: 0, w: 0.045, d: d - 0.75 },
        { x: w / 2 - 0.34, z: 0, w: 0.045, d: d - 0.75 },
      ].map((s, i) => (
        <mesh key={i} position={[s.x, 0.032, s.z]} material={lineMat}>
          <boxGeometry args={[s.w, 0.012, s.d]} />
        </mesh>
      ))}
      {/* Low walls with glowing caps (the Sims cutaway edge). */}
      {walls.map((wall, i) => (
        <group key={i} position={[wall.x, 0, wall.z]}>
          <mesh position={[0, WALL_H / 2, 0]} material={wallMat} castShadow>
            <boxGeometry args={[wall.w, WALL_H, wall.d]} />
          </mesh>
          <mesh position={[0, WALL_H + 0.02, 0]} material={capMat}>
            <boxGeometry args={[wall.w + 0.03, 0.045, wall.d + 0.03]} />
          </mesh>
        </group>
      ))}
      {/* Counters + furniture (world-space boxes, so re-center them). */}
      <group position={[-cx, 0, -cz]}>
        {spec.counters.map((c, i) =>
          spec.doors[i] ? (
            <Counter
              key={i}
              box={c}
              accent={POI_STYLES[spec.doors[i].kind]?.color ?? accent}
              kind={spec.doors[i].kind}
              entityId={spec.doors[i].entity}
            />
          ) : null,
        )}
        {spec.deco.map((deco, i) => (
          <Furniture key={i} deco={deco} accent={accent} />
        ))}
        {spec.doors.map((_, i) => (
          <SlidingDoor key={i} spec={spec} doorIndex={i} accent={accent} />
        ))}
      </group>
      {/* Room fill light in the store's accent color. */}
      <pointLight
        position={[0, 2.6, 0]}
        color={accent}
        intensity={14}
        distance={Math.max(w, d) * 1.4}
        decay={1.8}
      />
    </group>
  );
}

export function Interiors() {
  useSyncExternalStore(interiorRegistry.subscribe, interiorRegistry.getVersion);
  const specs = interiorRegistry.allSpecs();
  return (
    <>
      {specs.map((spec) => (
        <InteriorRoom key={spec.key} spec={spec} />
      ))}
    </>
  );
}
