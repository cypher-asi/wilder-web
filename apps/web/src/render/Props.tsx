// Street props. Most archetypes render GPU-instanced cyberpunk kit GLBs
// (INSTANCED_PROPS below); the rest are procedural (neon signs, steam).

import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { CHUNK_SIZE, ChunkData, PropInstance } from "../net/protocol";
import { perf } from "../perf/perf";
import { useGame } from "../state/game";
import { mulberry, NEON_COLORS } from "./facade";
import { groundHeightAt } from "./Ground";
import { KitEntry, KitFit } from "./InstancedKit";
import { isTronStyle, tronifyMaterial } from "./styles";

// Archetype ids from wilder-terrain.
export const STREETLIGHT = 0;
export const BENCH = 1;
export const TRASH = 2;
export const HYDRANT = 3;
export const NEON_SIGN = 4;
export const VENT = 5;
export const TREE = 6;
export const CAR = 7;
export const BARRIER = 8;
export const KIOSK = 9;
export const TRAFFIC_LIGHT = 10;
export const STOP_SIGN = 11;

const poleMat = new THREE.MeshStandardMaterial({ color: "#1a1c20", roughness: 0.6, metalness: 0.7 });
const darkMetal = new THREE.MeshStandardMaterial({ color: "#22252b", roughness: 0.5, metalness: 0.5 });
tronifyMaterial(poleMat);
tronifyMaterial(darkMetal);

/** Teal-only sign palette for the tron style (dim steel-teal = "dead"). */
const TRON_NEON_COLORS = ["#4fd0e0", "#72deea", "#a9eef5", "#d6fbff", "#2a9cb0"];

/**
 * Flickering neon sign plane: mostly steady, with per-seed random dropouts
 * and buzz so streets feel alive.
 */
export function NeonPlane({
  color,
  width,
  height,
  seed,
}: {
  color: string;
  width: number;
  height: number;
  seed: number;
}) {
  const mat = useRef<THREE.MeshStandardMaterial>(null);
  const phase = useMemo(() => (seed % 97) * 0.37, [seed]);
  useFrame(({ clock }) => {
    if (!mat.current) return;
    perf.begin("shaders.misc");
    const t = clock.elapsedTime + phase;
    // Occasional dropout window (~5% of the time) plus a subtle 50Hz-ish buzz.
    const dropout = Math.sin(t * 0.7 + phase * 13) > 0.97 ? 0.15 : 1;
    const buzz = 0.92 + 0.08 * Math.sin(t * 37);
    mat.current.emissiveIntensity = 2.8 * dropout * buzz;
    perf.end("shaders.misc");
  });
  return (
    <mesh>
      <planeGeometry args={[width, height]} />
      <meshStandardMaterial
        ref={mat}
        color={color}
        emissive={color}
        emissiveIntensity={2.8}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}

/**
 * Standing street neon sign (archetype NEON_SIGN): pole + sign box with a
 * flickering neon face. ~25% are dead — dark, unlit, grimy — so streets
 * don't glow uniformly.
 */
function NeonSignProp({ seed }: { seed: number }) {
  const tron = useGame((s) => isTronStyle(s.visualStyle));
  const { color, dead, h, w } = useMemo(() => {
    const rng = mulberry(seed);
    const palette = tron ? TRON_NEON_COLORS : NEON_COLORS;
    return {
      color: palette[Math.floor(rng() * palette.length)],
      dead: rng() < 0.25,
      h: 0.6 + rng() * 0.5,
      w: 1.0 + rng() * 0.7,
    };
  }, [seed, tron]);
  return (
    <group>
      <mesh material={poleMat} position={[0, 1.5, 0]} castShadow>
        <cylinderGeometry args={[0.045, 0.06, 3.0, 6]} />
      </mesh>
      <mesh material={darkMetal} position={[0, 2.6, 0]} castShadow>
        <boxGeometry args={[w + 0.14, h + 0.14, 0.12]} />
      </mesh>
      {dead ? (
        <mesh position={[0, 2.6, 0.065]}>
          <planeGeometry args={[w, h]} />
          <meshStandardMaterial color="#15171a" roughness={0.5} />
        </mesh>
      ) : (
        <>
          <group position={[0, 2.6, 0.065]}>
            <NeonPlane color={color} width={w} height={h} seed={seed} />
          </group>
          <group position={[0, 2.6, -0.065]} rotation={[0, Math.PI, 0]}>
            <NeonPlane color={color} width={w} height={h} seed={seed + 3} />
          </group>
        </>
      )}
    </group>
  );
}

/**
 * Soft warm glow pool cast on the pavement under a streetlight head:
 * emissive gradient disc standing in for a real point light + wet-road SSR.
 */
const poolTexture = (() => {
  if (typeof document === "undefined") return null;
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d")!;
  const grad = ctx.createRadialGradient(32, 32, 2, 32, 32, 32);
  grad.addColorStop(0, "rgba(255, 205, 140, 0.30)");
  grad.addColorStop(0.45, "rgba(255, 185, 110, 0.10)");
  grad.addColorStop(1, "rgba(255, 170, 90, 0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
})();
const poolMat = new THREE.MeshBasicMaterial({
  color: "#ffbe78",
  map: poolTexture,
  blending: THREE.AdditiveBlending,
  transparent: true,
  opacity: 0.5,
  depthWrite: false,
  polygonOffset: true,
  polygonOffsetFactor: -2,
  polygonOffsetUnits: -2,
});
const poolGeo = new THREE.CircleGeometry(2.4, 24).rotateX(-Math.PI / 2);

/** Light pools under this chunk's streetlights (they render instanced). */
export function LightPools({ chunk }: { chunk: ChunkData }) {
  // Warm sodium pools by default; cold teal in tron (shared material, so
  // every mounted chunk agrees — the set is idempotent).
  const tron = useGame((s) => isTronStyle(s.visualStyle));
  poolMat.color.set(tron ? "#4fd0e0" : "#ffbe78");
  const pools = useMemo(
    () =>
      chunk.props
        .filter((p) => p.archetype === STREETLIGHT)
        .map((p) => {
          // Lamp head hangs ~1 m along the prop's facing.
          const hx = p.x + Math.cos(p.rotation) * 1.0;
          const hz = p.z - Math.sin(p.rotation) * 1.0;
          const wx = chunk.coord.x * CHUNK_SIZE + hx;
          const wz = chunk.coord.z * CHUNK_SIZE + hz;
          return { x: hx, z: hz, y: groundHeightAt(wx, wz) + 0.015 };
        }),
    [chunk],
  );
  return (
    <>
      {pools.map((p, i) => (
        <mesh key={i} geometry={poolGeo} material={poolMat} position={[p.x, p.y, p.z]} />
      ))}
    </>
  );
}

const STEAM_SPRITES = 5;
const steamMaterial = new THREE.MeshBasicMaterial({
  color: "#9aa7b8",
  transparent: true,
  opacity: 0.16,
  depthWrite: false,
});

/** Slow steam puffs rising from a street vent. */
function Steam({ seed }: { seed: number }) {
  const group = useRef<THREE.Group>(null);
  const offsets = useMemo(() => {
    const rng = mulberry(seed);
    return Array.from({ length: STEAM_SPRITES }, () => rng() * 4);
  }, [seed]);
  useFrame(({ camera, clock }) => {
    const g = group.current;
    if (!g) return;
    perf.begin("shaders.misc");
    for (let i = 0; i < g.children.length; i++) {
      const puff = g.children[i] as THREE.Mesh;
      const life = ((clock.elapsedTime * 0.45 + offsets[i]) % 4) / 4; // 0..1
      puff.position.y = 0.3 + life * 2.6;
      const s = 0.4 + life * 1.1;
      puff.scale.setScalar(s);
      (puff.material as THREE.MeshBasicMaterial).opacity = 0.18 * (1 - life);
      puff.quaternion.copy(camera.quaternion); // billboard
    }
    perf.end("shaders.misc");
  });
  return (
    <group ref={group}>
      {offsets.map((_, i) => (
        <mesh key={i} material={steamMaterial.clone()}>
          <planeGeometry args={[1, 1]} />
        </mesh>
      ))}
    </group>
  );
}

/** Steam plumes over this chunk's vents (the vent models render instanced). */
export function SteamVents({ chunk }: { chunk: ChunkData }) {
  const vents = useMemo(
    () =>
      chunk.props
        .filter((p) => p.archetype === VENT)
        .map((p) => {
          const wx = chunk.coord.x * CHUNK_SIZE + p.x;
          const wz = chunk.coord.z * CHUNK_SIZE + p.z;
          return { x: p.x, z: p.z, y: groundHeightAt(wx, wz), seed: Math.floor(p.x * 11 + p.z * 23) };
        }),
    [chunk],
  );
  return (
    <>
      {vents.map((v, i) => (
        <group key={i} position={[v.x, v.y, v.z]}>
          <Steam seed={v.seed} />
        </group>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// Instanced kit props (cyberpunk kit via InstancedKit)
// ---------------------------------------------------------------------------

interface InstancedVariant {
  assetId: string;
  /** Per-variant uniform scale multiplier (default 1). */
  scale?: number;
}

/**
 * Archetypes rendered through InstancedKit instead of per-prop scene clones.
 * Multiple variants per archetype rotate by position hash so streets vary
 * without per-instance state. Kit assets are meter-scaled, so most render at
 * their authored size; oversized source models get a fit below.
 */
const INSTANCED_PROPS: Record<number, InstancedVariant[]> = {
  [STREETLIGHT]: [{ assetId: "lab_sm_lamp_005" }],
  [BENCH]: [{ assetId: "lab_sm_bench01" }],
  [TRASH]: [{ assetId: "lab_sm_bin_001" }],
  [BARRIER]: [{ assetId: "lab_sm_barrier01" }, { assetId: "lab_sm_barrier08" }],
  [TREE]: [
    { assetId: "lab_sm_tree1" },
    { assetId: "lab_sm_tree2" },
    { assetId: "lab_sm_tree2", scale: 0.85 },
    { assetId: "lab_sm_tree3", scale: 1.4 },
    { assetId: "lab_sm_bush_1" },
  ],
  // Parked hover bikes hold the curb slots until the kit's multi-part hover
  // cars get an assembly pass; scale variance keeps rows from reading cloned.
  [CAR]: [
    { assetId: "lab_sm_motorbike01" },
    { assetId: "lab_sm_motorbike01", scale: 0.94 },
    { assetId: "lab_sm_motorbike01", scale: 1.05 },
  ],
  // No hydrants in the cyberpunk kit: streets get utility barrels instead.
  [HYDRANT]: [{ assetId: "lab_sm_citybarrels_01" }, { assetId: "lab_sm_cyberbarrels01" }],
  [VENT]: [{ assetId: "lab_sm_recylcer_01" }],
  [KIOSK]: [{ assetId: "lab_sm_cpticketmachine01" }],
  [TRAFFIC_LIGHT]: [{ assetId: "lab_sm_traffic_lamp_001" }],
  [STOP_SIGN]: [
    { assetId: "lab_sm_trafficsign01" },
    { assetId: "lab_sm_trafficsign02" },
    { assetId: "lab_sm_trafficsign05" },
  ],
};

/** Bbox normalization for kit models whose authored size doesn't fit streets. */
export const INSTANCED_PROP_FITS: Record<string, KitFit> = {
  lab_sm_tree1: { size: 9, axis: "height" },
  lab_sm_tree2: { size: 7.5, axis: "height" },
};

export function isInstancedProp(archetype: number): boolean {
  return archetype in INSTANCED_PROPS;
}

/** Gather world-space kit placements for instanced prop archetypes. */
export function collectInstancedProps(chunks: ChunkData[]): KitEntry[] {
  const out: KitEntry[] = [];
  for (const chunk of chunks) {
    const ox = chunk.coord.x * CHUNK_SIZE;
    const oz = chunk.coord.z * CHUNK_SIZE;
    for (const prop of chunk.props) {
      const variants = INSTANCED_PROPS[prop.archetype];
      if (!variants) continue;
      const hash = Math.abs(Math.floor(prop.x * 7 + prop.z * 13 + prop.archetype * 5));
      const v = variants[hash % variants.length];
      const x = ox + prop.x;
      const z = oz + prop.z;
      out.push({
        assetId: v.assetId,
        x,
        y: groundHeightAt(x, z),
        z,
        rotationY: prop.rotation,
        scale: v.scale,
      });
    }
  }
  return out;
}

/**
 * Representative meshes for the shared procedural prop materials (light
 * pools, sign metal, steam), used by the chunk prewarm to compile their
 * programs off the render path before a chunk reveals.
 */
export function propPrewarmObjects(): THREE.Object3D[] {
  return [
    new THREE.Mesh(poolGeo, poolMat),
    new THREE.Mesh(poolGeo, darkMetal),
    new THREE.Mesh(poolGeo, steamMaterial),
  ];
}

/**
 * Non-instanced archetypes: procedural props with per-instance animation
 * state (neon flicker). Everything model-based renders through InstancedKit.
 */
export function PropMesh({ prop, chunk }: { prop: PropInstance; chunk?: ChunkData }) {
  // Stand on the visual ground surface (raised sidewalk vs road grade). The
  // parent group sits at the chunk origin, so prop.x/z are chunk-local.
  const groundY = chunk
    ? groundHeightAt(chunk.coord.x * CHUNK_SIZE + prop.x, chunk.coord.z * CHUNK_SIZE + prop.z)
    : 0;

  return (
    <group position={[prop.x, groundY, prop.z]} rotation={[0, prop.rotation, 0]}>
      {prop.archetype === NEON_SIGN ? (
        <NeonSignProp seed={Math.floor(prop.x * 29 + prop.z * 41)} />
      ) : (
        <mesh material={darkMetal} position={[0, 0.3, 0]}>
          <boxGeometry args={[0.6, 0.6, 0.6]} />
        </mesh>
      )}
    </group>
  );
}
