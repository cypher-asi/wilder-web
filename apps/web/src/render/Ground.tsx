// Ground rendering for a chunk: raised sidewalk/plaza slabs with curb faces,
// bevels and wheelchair ramps at intersection corners, roads at grade, and
// deterministic street furniture (manholes, storm drains). Surface detail
// (textures, markings, puddles, cracks) lives in the ground shader (ground.ts).

import { useEffect, useMemo, useState } from "react";
import * as THREE from "three";
import {
  CITY_ROAD,
  CITY_ROAD_LINE,
  CITY_WATER,
  cityMapReady,
  cityTileAt,
  onCityMapReady,
} from "../game/citymap";
import { ChunkData, TileKind, TILE_SIZE, TILES_PER_CHUNK } from "../net/protocol";
import { groundMaterial } from "./groundShader";
import { buildRoadMarkings, markingsMaterial } from "./roadMarkings";

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

/**
 * Classify any world tile (global tile coords) as road-grade or raised using
 * the baked city map (see game/citymap.ts). Water sits at road grade too.
 */
export function tileKindAt(worldTx: number, worldTz: number): "road" | "raised" {
  const kind = cityTileAt(worldTx, worldTz);
  return kind === CITY_ROAD || kind === CITY_ROAD_LINE || kind === CITY_WATER
    ? "road"
    : "raised";
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
  roadDs: number[] = [];
  /** Smooth signed road distance (m) sampled per vertex from local x/z. */
  sampleRoadD: (x: number, z: number) => number = () => 0;

  tri(a: number[], b: number[], c: number[], kind: number) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    this.positions.push(...a, ...b, ...c);
    for (const v of [a, b, c]) {
      this.normals.push(nx, ny, nz);
      this.kinds.push(kind);
      this.roadDs.push(this.sampleRoadD(v[0], v[2]));
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
    geometry.setAttribute("aRoadD", new THREE.Float32BufferAttribute(this.roadDs, 1));
    return geometry;
  }
}

/**
 * Signed distance (meters, tile-quantized) from a tile to the road network:
 * positive = distance to the nearest road tile (grime deep in blocks),
 * negative = -distance to the nearest raised tile for road tiles (gutters).
 */
function signedRoadDistance(
  isRoad: (tx: number, tz: number) => boolean,
  tx: number,
  tz: number,
  maxR = 8,
): number {
  const self = isRoad(tx, tz);
  let best = Infinity;
  for (let r = 1; r <= maxR; r++) {
    if (best <= r * TILE_SIZE) break;
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        if (isRoad(tx + dx, tz + dz) !== self) {
          best = Math.min(best, Math.hypot(dx, dz) * TILE_SIZE);
        }
      }
    }
  }
  if (best === Infinity) best = (maxR + 1) * TILE_SIZE;
  return self ? -best : best;
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
  // Road membership for the distance field (in-chunk exact, neighbors baked).
  const roadAt = (tx: number, tz: number): boolean => {
    if (tx >= 0 && tx < n && tz >= 0 && tz < n) {
      const k = chunk.tiles[tz * n + tx];
      return k === "Road" || k === "RoadLine";
    }
    const k = cityTileAt(baseTx + tx, baseTz + tz);
    return k === CITY_ROAD || k === CITY_ROAD_LINE;
  };

  // Signed road distance sampled at tile centers (1-tile margin), then
  // bilinear-interpolated per vertex so the field is smooth across tiles;
  // the shader's gutter/wear bands would staircase on the 2 m grid otherwise.
  const stride = n + 2;
  const dist = new Float32Array(stride * stride);
  for (let tz = -1; tz <= n; tz++) {
    for (let tx = -1; tx <= n; tx++) {
      dist[(tz + 1) * stride + tx + 1] = signedRoadDistance(roadAt, tx, tz);
    }
  }
  const distAt = (tx: number, tz: number): number => {
    const cx = Math.min(Math.max(tx, -1), n) + 1;
    const cz = Math.min(Math.max(tz, -1), n) + 1;
    return dist[cz * stride + cx];
  };
  g.sampleRoadD = (x, z) => {
    const u = x / TILE_SIZE - 0.5;
    const v = z / TILE_SIZE - 0.5;
    const u0 = Math.floor(u), v0 = Math.floor(v);
    const fu = u - u0, fv = v - v0;
    return (
      (distAt(u0, v0) * (1 - fu) + distAt(u0 + 1, v0) * fu) * (1 - fv) +
      (distAt(u0, v0 + 1) * (1 - fu) + distAt(u0 + 1, v0 + 1) * fu) * fv
    );
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
  const n = TILES_PER_CHUNK;
  const rng = chunkRng(chunk.coord.x, chunk.coord.z);
  const out: Detail[] = [];
  const tile = (tx: number, tz: number): TileKind | null =>
    tx >= 0 && tx < n && tz >= 0 && tz < n ? chunk.tiles[tz * n + tx] : null;

  // Manholes on interior road tiles; storm drains on road tiles that touch a
  // sidewalk, snapped against that curb. Sparse via rng, capped per chunk.
  let manholes = 0;
  let drains = 0;
  for (let tz = 0; tz < n && (manholes < 3 || drains < 3); tz++) {
    for (let tx = 0; tx < n; tx++) {
      const k = tile(tx, tz);
      if (k !== "Road" && k !== "RoadLine") continue;
      const cxm = tile(tx - 1, tz) === "Sidewalk";
      const cxp = tile(tx + 1, tz) === "Sidewalk";
      const czm = tile(tx, tz - 1) === "Sidewalk";
      const czp = tile(tx, tz + 1) === "Sidewalk";
      const curb = cxm || cxp || czm || czp;
      const x = (tx + 0.5) * TILE_SIZE;
      const z = (tz + 0.5) * TILE_SIZE;
      if (curb && drains < 3) {
        if (rng() < 0.05) {
          if (czm) out.push({ kind: "drain", x, z: tz * TILE_SIZE + 0.28, rot: 0 });
          else if (czp) out.push({ kind: "drain", x, z: (tz + 1) * TILE_SIZE - 0.28, rot: 0 });
          else if (cxm) out.push({ kind: "drain", x: tx * TILE_SIZE + 0.28, z, rot: Math.PI / 2 });
          else out.push({ kind: "drain", x: (tx + 1) * TILE_SIZE - 0.28, z, rot: Math.PI / 2 });
          drains++;
        }
      } else if (!curb && manholes < 3 && rng() < 0.03) {
        out.push({
          kind: "manhole",
          x: x + (rng() - 0.5),
          z: z + (rng() - 0.5),
          rot: rng() * Math.PI,
        });
        manholes++;
      }
    }
  }
  return out;
}

function RoadDetails({ chunk }: { chunk: ChunkData }) {
  const details = useMemo(() => chunkDetails(chunk), [chunk]);
  return (
    <>
      {details.map((d, i) =>
        // Kept above the painted road markings layer (y = 0.012).
        d.kind === "manhole" ? (
          <group key={i} position={[d.x, 0, d.z]} rotation={[0, d.rot, 0]}>
            <mesh geometry={manholeGeo} material={manholeCover} position={[0, 0.016, 0]} />
            <mesh geometry={manholeRimGeo} material={manholeRim} position={[0, 0.015, 0]} />
          </group>
        ) : (
          <mesh
            key={i}
            geometry={drainGeo}
            material={drainGrate}
            position={[d.x, 0.018, d.z]}
            rotation={[0, d.rot, 0]}
          />
        ),
      )}
    </>
  );
}

export function ChunkGround({ chunk }: { chunk: ChunkData }) {
  // Curbs and markings query the global city grid for out-of-chunk neighbors;
  // rebuild once it finishes its async load if this chunk mounted first.
  const [mapReady, setMapReady] = useState(cityMapReady());
  useEffect(() => onCityMapReady(() => setMapReady(true)), []);
  const geometry = useMemo(() => buildGroundGeometry(chunk), [chunk, mapReady]);
  const markings = useMemo(
    () => (mapReady ? buildRoadMarkings(chunk) : null),
    [chunk, mapReady],
  );
  return (
    <>
      <mesh geometry={geometry} material={groundMaterial} receiveShadow />
      {markings && <mesh geometry={markings} material={markingsMaterial} receiveShadow />}
      <RoadDetails chunk={chunk} />
    </>
  );
}
