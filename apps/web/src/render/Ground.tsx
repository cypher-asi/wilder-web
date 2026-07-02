// Ground rendering for a chunk: raised sidewalk/plaza slabs with curb faces,
// bevels and wheelchair ramps at intersection corners, roads at grade, and
// deterministic street furniture (manholes, storm drains). Surface detail
// (textures, markings, puddles, cracks) lives in the ground shader (ground.ts).

import { useMemo } from "react";
import * as THREE from "three";
import { ChunkData, TileKind, TILE_SIZE, TILES_PER_CHUNK } from "../net/protocol";
import { groundMaterial } from "./groundShader";

/** Height of the raised sidewalk/plaza slab above road grade. */
const CURB_H = 0.14;
/** Curb-cut ramps drop the road-facing corner down to this. */
const RAMP_H = 0.02;
/** Chamfer on the curb's top edge so it catches light. */
const BEVEL = 0.03;

/** aKind vertex attribute values consumed by the ground shader. */
const KIND_ID: Record<TileKind, number> = {
  Road: 0,
  RoadLine: 0, // legacy center-line marker tiles render as plain road
  Sidewalk: 1,
  Plaza: 2,
  Building: 3,
  Park: 4,
  Water: 5,
};

function isLowKind(kind: TileKind): boolean {
  return kind === "Road" || kind === "RoadLine" || kind === "Water";
}

function rem(n: number, m: number): number {
  return ((n % m) + m) % m;
}

/**
 * Classify any world tile (global tile coords) as road or raised using the
 * deterministic road-grid math from wilder-terrain: chunks on even rows/cols
 * carry a road band on tiles [0, w), w = 6 on avenues (every 4th), else 3.
 * Everything that is not road counts as "raised" for curb purposes.
 */
export function tileKindAt(worldTx: number, worldTz: number): "road" | "raised" {
  const n = TILES_PER_CHUNK;
  const cz = Math.floor(worldTz / n);
  const cx = Math.floor(worldTx / n);
  const tz = worldTz - cz * n;
  const tx = worldTx - cx * n;
  if (rem(cz, 2) === 0 && tz < (rem(cz, 4) === 0 ? 6 : 3)) return "road";
  if (rem(cx, 2) === 0 && tx < (rem(cx, 4) === 0 ? 6 : 3)) return "road";
  return "raised";
}

/**
 * Visual ground height (meters) at a world position, e.g. raised sidewalks.
 * Kept in one place so entities and props can sit on the same surface.
 */
export function groundHeightAt(x: number, z: number): number {
  const tx = Math.floor(x / TILE_SIZE);
  const tz = Math.floor(z / TILE_SIZE);
  return tileKindAt(tx, tz) === "road" ? 0 : CURB_H;
}

class GeoBuilder {
  positions: number[] = [];
  normals: number[] = [];
  kinds: number[] = [];

  tri(a: number[], b: number[], c: number[], kind: number) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    this.positions.push(...a, ...b, ...c);
    for (let i = 0; i < 3; i++) {
      this.normals.push(nx, ny, nz);
      this.kinds.push(kind);
    }
  }

  quad(a: number[], b: number[], c: number[], d: number[], kind: number) {
    this.tri(a, b, c, kind);
    this.tri(a, c, d, kind);
  }

  build(): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(this.positions, 3));
    geometry.setAttribute("normal", new THREE.Float32BufferAttribute(this.normals, 3));
    geometry.setAttribute("aKind", new THREE.Float32BufferAttribute(this.kinds, 1));
    return geometry;
  }
}

function buildGroundGeometry(chunk: ChunkData): THREE.BufferGeometry {
  const n = TILES_PER_CHUNK;
  const g = new GeoBuilder();
  const baseTx = chunk.coord.x * n;
  const baseTz = chunk.coord.z * n;

  // Is the (possibly out-of-chunk) neighbor tile at road grade?
  const lowAt = (tx: number, tz: number): boolean => {
    if (tx >= 0 && tx < n && tz >= 0 && tz < n) return isLowKind(chunk.tiles[tz * n + tx]);
    return tileKindAt(baseTx + tx, baseTz + tz) === "road";
  };

  for (let tz = 0; tz < n; tz++) {
    for (let tx = 0; tx < n; tx++) {
      const tileKind = chunk.tiles[tz * n + tx];
      const kind = KIND_ID[tileKind] ?? 2;
      const x0 = tx * TILE_SIZE, x1 = x0 + TILE_SIZE;
      const z0 = tz * TILE_SIZE, z1 = z0 + TILE_SIZE;

      if (isLowKind(tileKind)) {
        g.quad([x0, 0, z0], [x0, 0, z1], [x1, 0, z1], [x1, 0, z0], kind);
        continue;
      }

      const roadXm = lowAt(tx - 1, tz);
      const roadXp = lowAt(tx + 1, tz);
      const roadZm = lowAt(tx, tz - 1);
      const roadZp = lowAt(tx, tz + 1);

      // Curb-cut ramp where a sidewalk corner meets a road intersection
      // corner (roads on two orthogonal sides): sink that corner vertex.
      const ramp = tileKind === "Sidewalk" && (roadXm || roadXp) && (roadZm || roadZp);
      // Per-corner top heights: [x][z] with 0 = low side of the tile.
      const h = [
        [CURB_H, CURB_H],
        [CURB_H, CURB_H],
      ];
      if (ramp) h[roadXm ? 0 : 1][roadZm ? 0 : 1] = RAMP_H;
      const c00: number[] = [x0, h[0][0], z0];
      const c01: number[] = [x0, h[0][1], z1];
      const c11: number[] = [x1, h[1][1], z1];
      const c10: number[] = [x1, h[1][0], z0];

      if (ramp) {
        // Top surface split along the diagonal through the sunk corner so
        // it slopes cleanly; curb faces follow the corner heights.
        const sunk00or11 = h[0][0] < CURB_H || h[1][1] < CURB_H;
        if (sunk00or11) {
          g.tri(c00, c01, c11, kind);
          g.tri(c00, c11, c10, kind);
        } else {
          g.tri(c00, c01, c10, kind);
          g.tri(c10, c01, c11, kind);
        }
        if (roadXm) g.quad([x0, h[0][0], z0], [x0, 0, z0], [x0, 0, z1], [x0, h[0][1], z1], 1);
        if (roadXp) g.quad([x1, h[1][1], z1], [x1, 0, z1], [x1, 0, z0], [x1, h[1][0], z0], 1);
        if (roadZm) g.quad([x1, h[1][0], z0], [x1, 0, z0], [x0, 0, z0], [x0, h[0][0], z0], 1);
        if (roadZp) g.quad([x0, h[0][1], z1], [x0, 0, z1], [x1, 0, z1], [x1, h[1][1], z1], 1);
        continue;
      }

      // Regular raised tile: top plate inset on road-facing edges, a 45°
      // bevel strip on those edges, and a vertical curb face below it.
      const H = CURB_H;
      const xi0 = x0 + (roadXm ? BEVEL : 0);
      const xi1 = x1 - (roadXp ? BEVEL : 0);
      const zi0 = z0 + (roadZm ? BEVEL : 0);
      const zi1 = z1 - (roadZp ? BEVEL : 0);
      g.quad([xi0, H, zi0], [xi0, H, zi1], [xi1, H, zi1], [xi1, H, zi0], kind);

      if (roadXm) {
        g.quad([x0 + BEVEL, H, z0], [x0, H - BEVEL, z0], [x0, H - BEVEL, z1], [x0 + BEVEL, H, z1], 1);
        g.quad([x0, H - BEVEL, z0], [x0, 0, z0], [x0, 0, z1], [x0, H - BEVEL, z1], 1);
      }
      if (roadXp) {
        g.quad([x1 - BEVEL, H, z1], [x1, H - BEVEL, z1], [x1, H - BEVEL, z0], [x1 - BEVEL, H, z0], 1);
        g.quad([x1, H - BEVEL, z1], [x1, 0, z1], [x1, 0, z0], [x1, H - BEVEL, z0], 1);
      }
      if (roadZm) {
        g.quad([x1, H, z0 + BEVEL], [x1, H - BEVEL, z0], [x0, H - BEVEL, z0], [x0, H, z0 + BEVEL], 1);
        g.quad([x1, H - BEVEL, z0], [x1, 0, z0], [x0, 0, z0], [x0, H - BEVEL, z0], 1);
      }
      if (roadZp) {
        g.quad([x0, H, z1 - BEVEL], [x0, H - BEVEL, z1], [x1, H - BEVEL, z1], [x1, H, z1 - BEVEL], 1);
        g.quad([x0, H - BEVEL, z1], [x0, 0, z1], [x1, 0, z1], [x1, H - BEVEL, z1], 1);
      }
    }
  }

  return g.build();
}

// ---------------------------------------------------------------------------
// Manholes + storm drains (deterministic per chunk)
// ---------------------------------------------------------------------------

/** Tiny deterministic RNG seeded from chunk coords (mulberry32 mix). */
function chunkRng(cx: number, cz: number): () => number {
  let s = (Math.imul(cx, 374761393) ^ Math.imul(cz, 668265263) ^ 0x9e3779b9) >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const manholeCover = new THREE.MeshStandardMaterial({
  color: "#191b1e",
  roughness: 0.4,
  metalness: 0.55,
});
const manholeRim = new THREE.MeshStandardMaterial({
  color: "#0d0e10",
  roughness: 0.5,
  metalness: 0.4,
});
const drainGrate = new THREE.MeshStandardMaterial({
  color: "#0b0c0e",
  roughness: 0.6,
  metalness: 0.5,
});
const manholeGeo = new THREE.CircleGeometry(0.28, 20).rotateX(-Math.PI / 2);
const manholeRimGeo = new THREE.RingGeometry(0.28, 0.35, 20).rotateX(-Math.PI / 2);
const drainGeo = new THREE.BoxGeometry(0.9, 0.03, 0.4);

interface Detail {
  kind: "manhole" | "drain";
  x: number;
  z: number;
  rot: number;
}

function chunkDetails(chunk: ChunkData): Detail[] {
  const cx = chunk.coord.x;
  const cz = chunk.coord.z;
  const rng = chunkRng(cx, cz);
  const size = TILES_PER_CHUNK * TILE_SIZE;
  const hRoad = rem(cz, 2) === 0;
  const vRoad = rem(cx, 2) === 0;
  const hW = (rem(cz, 4) === 0 ? 6 : 3) * TILE_SIZE;
  const vW = (rem(cx, 4) === 0 ? 6 : 3) * TILE_SIZE;
  const out: Detail[] = [];

  if (hRoad) {
    const count = 1 + (rng() < 0.5 ? 1 : 0);
    for (let i = 0; i < count; i++) {
      // In a driving lane beside the center line, clear of the intersection.
      const x = (vRoad ? vW + 2 : 1.5) + rng() * (size - (vRoad ? vW : 0) - 4);
      out.push({ kind: "manhole", x, z: hW / 2 + (rng() < 0.5 ? -1.4 : 1.4), rot: rng() * Math.PI });
    }
    // Storm drain against the far curb, just past the intersection corner.
    out.push({ kind: "drain", x: (vRoad ? vW : 0) + 1.4 + rng() * 2, z: hW - 0.28, rot: 0 });
  }
  if (vRoad) {
    if (rng() < 0.7) {
      const z = (hRoad ? hW + 2 : 1.5) + rng() * (size - (hRoad ? hW : 0) - 4);
      out.push({ kind: "manhole", x: vW / 2 + (rng() < 0.5 ? -1.4 : 1.4), z, rot: rng() * Math.PI });
    }
    out.push({ kind: "drain", x: vW - 0.28, z: (hRoad ? hW : 0) + 1.4 + rng() * 2, rot: Math.PI / 2 });
  }
  return out;
}

function RoadDetails({ chunk }: { chunk: ChunkData }) {
  const details = useMemo(() => chunkDetails(chunk), [chunk]);
  return (
    <>
      {details.map((d, i) =>
        d.kind === "manhole" ? (
          <group key={i} position={[d.x, 0, d.z]} rotation={[0, d.rot, 0]}>
            <mesh geometry={manholeGeo} material={manholeCover} position={[0, 0.006, 0]} />
            <mesh geometry={manholeRimGeo} material={manholeRim} position={[0, 0.005, 0]} />
          </group>
        ) : (
          <mesh
            key={i}
            geometry={drainGeo}
            material={drainGrate}
            position={[d.x, 0.008, d.z]}
            rotation={[0, d.rot, 0]}
          />
        ),
      )}
    </>
  );
}

export function ChunkGround({ chunk }: { chunk: ChunkData }) {
  const geometry = useMemo(() => buildGroundGeometry(chunk), [chunk]);
  return (
    <>
      <mesh geometry={geometry} material={groundMaterial} receiveShadow />
      <RoadDetails chunk={chunk} />
    </>
  );
}
