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
const BEVEL = 0.045;
/** Width of the curbstone band on top of the slab edge (visible thickness). */
const CURB_W = 0.32;
/** aKind for curbstone bands: 6 runs along Z (x-facing edges), 7 along X. */
const KIND_CURB_Z = 6;
const KIND_CURB_X = 7;

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

      // Curb-cut ramp only at true intersection corners: both road edges
      // must continue straight past this tile. (Staircase steps on curved
      // streets also have roads on two orthogonal sides; cutting a ramp at
      // every step used to read as a sawtooth of sunken notches.)
      const rampCorner =
        tileKind === "Sidewalk" && (roadXm || roadXp) && (roadZm || roadZp);
      const rx = roadXm ? tx - 1 : tx + 1;
      const rz = roadZm ? tz - 1 : tz + 1;
      const ramp =
        rampCorner &&
        lowAt(rx, tz - 1) &&
        lowAt(rx, tz + 1) &&
        lowAt(tx - 1, rz) &&
        lowAt(tx + 1, rz);
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
        // it slopes cleanly; curb faces (kind = curbstone) follow the corner
        // heights. No curbstone band on top: this is a poured curb cut.
        const sunk00or11 = h[0][0] < CURB_H || h[1][1] < CURB_H;
        if (sunk00or11) {
          g.tri(c00, c01, c11, kind);
          g.tri(c00, c11, c10, kind);
        } else {
          g.tri(c00, c01, c10, kind);
          g.tri(c10, c01, c11, kind);
        }
        if (roadXm) g.quad([x0, h[0][0], z0], [x0, 0, z0], [x0, 0, z1], [x0, h[0][1], z1], KIND_CURB_Z);
        if (roadXp) g.quad([x1, h[1][1], z1], [x1, 0, z1], [x1, 0, z0], [x1, h[1][0], z0], KIND_CURB_Z);
        if (roadZm) g.quad([x1, h[1][0], z0], [x1, 0, z0], [x0, 0, z0], [x0, h[0][0], z0], KIND_CURB_X);
        if (roadZp) g.quad([x0, h[0][1], z1], [x0, 0, z1], [x1, 0, z1], [x1, h[1][1], z1], KIND_CURB_X);
        continue;
      }

      // Regular raised tile: the walking surface is inset by a visible
      // curbstone band (CURB_W) on road-facing edges. Each such edge gets a
      // curbstone strip: flat band top, 45-degree bevel on the street lip,
      // and the vertical curb face down to road grade.
      const H = CURB_H;
      const xi0 = x0 + (roadXm ? CURB_W : 0);
      const xi1 = x1 - (roadXp ? CURB_W : 0);
      const zi0 = z0 + (roadZm ? CURB_W : 0);
      const zi1 = z1 - (roadZp ? CURB_W : 0);
      g.quad([xi0, H, zi0], [xi0, H, zi1], [xi1, H, zi1], [xi1, H, zi0], kind);

      // Band tops: X-edge bands run the full tile depth (minus the bevel
      // lip) and own the corner square; Z-edge bands span the remaining x
      // so corners tile without overlap or holes.
      const zbA = z0 + (roadZm ? BEVEL : 0);
      const zbB = z1 - (roadZp ? BEVEL : 0);
      if (roadXm) {
        g.quad([x0 + BEVEL, H, zbA], [x0 + BEVEL, H, zbB], [x0 + CURB_W, H, zbB], [x0 + CURB_W, H, zbA], KIND_CURB_Z);
      }
      if (roadXp) {
        g.quad([x1 - CURB_W, H, zbA], [x1 - CURB_W, H, zbB], [x1 - BEVEL, H, zbB], [x1 - BEVEL, H, zbA], KIND_CURB_Z);
      }
      if (roadZm) {
        g.quad([xi0, H, z0 + BEVEL], [xi0, H, z0 + CURB_W], [xi1, H, z0 + CURB_W], [xi1, H, z0 + BEVEL], KIND_CURB_X);
      }
      if (roadZp) {
        g.quad([xi0, H, z1 - CURB_W], [xi0, H, z1 - BEVEL], [xi1, H, z1 - BEVEL], [xi1, H, z1 - CURB_W], KIND_CURB_X);
      }

      // Bevel lips + vertical curb faces along each road edge.
      if (roadXm) {
        g.quad([x0 + BEVEL, H, z0], [x0, H - BEVEL, z0], [x0, H - BEVEL, z1], [x0 + BEVEL, H, z1], KIND_CURB_Z);
        g.quad([x0, H - BEVEL, z0], [x0, 0, z0], [x0, 0, z1], [x0, H - BEVEL, z1], KIND_CURB_Z);
      }
      if (roadXp) {
        g.quad([x1 - BEVEL, H, z1], [x1, H - BEVEL, z1], [x1, H - BEVEL, z0], [x1 - BEVEL, H, z0], KIND_CURB_Z);
        g.quad([x1, H - BEVEL, z1], [x1, 0, z1], [x1, 0, z0], [x1, H - BEVEL, z0], KIND_CURB_Z);
      }
      if (roadZm) {
        g.quad([x1, H, z0 + BEVEL], [x1, H - BEVEL, z0], [x0, H - BEVEL, z0], [x0, H, z0 + BEVEL], KIND_CURB_X);
        g.quad([x1, H - BEVEL, z0], [x1, 0, z0], [x0, 0, z0], [x0, H - BEVEL, z0], KIND_CURB_X);
      }
      if (roadZp) {
        g.quad([x0, H, z1 - BEVEL], [x0, H - BEVEL, z1], [x1, H - BEVEL, z1], [x1, H, z1 - BEVEL], KIND_CURB_X);
        g.quad([x0, H - BEVEL, z1], [x0, 0, z1], [x1, 0, z1], [x1, H - BEVEL, z1], KIND_CURB_X);
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

/** Cast-iron cover pattern (concentric rings + stud grid) drawn once. */
function makeCoverTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#404448";
  ctx.fillRect(0, 0, 128, 128);
  ctx.strokeStyle = "#22252a";
  ctx.lineWidth = 3;
  for (const r of [18, 34, 50]) {
    ctx.beginPath();
    ctx.arc(64, 64, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.fillStyle = "#2a2d31";
  for (let a = 0; a < 24; a++) {
    const ang = (a / 24) * Math.PI * 2;
    for (const r of [26, 42, 58]) {
      ctx.beginPath();
      ctx.arc(64 + Math.cos(ang) * r, 64 + Math.sin(ang) * r, 2.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Soft radial stain: dark center fading out (street-steel grime halo). */
function makeStainTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d")!;
  const grad = ctx.createRadialGradient(32, 32, 4, 32, 32, 32);
  grad.addColorStop(0, "rgba(8, 8, 9, 0.5)");
  grad.addColorStop(0.55, "rgba(10, 10, 11, 0.28)");
  grad.addColorStop(1, "rgba(12, 12, 12, 0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

const coverTex = makeCoverTexture();
const manholeCover = new THREE.MeshStandardMaterial({
  map: coverTex,
  bumpMap: coverTex,
  bumpScale: 4,
  color: "#5b6066",
  roughness: 0.42,
  metalness: 0.75,
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
const utilityCover = new THREE.MeshStandardMaterial({
  map: coverTex,
  bumpMap: coverTex,
  bumpScale: 3,
  color: "#4a4e53",
  roughness: 0.5,
  metalness: 0.65,
});
// Lit dark overlay: must participate in scene lighting or the "stain" reads
// as a bright unlit blob at the scene's high exposure.
const stainMat = new THREE.MeshStandardMaterial({
  color: "#0a0a0b",
  map: makeStainTexture(),
  transparent: true,
  depthWrite: false,
  roughness: 0.75,
  polygonOffset: true,
  polygonOffsetFactor: -1,
  polygonOffsetUnits: -1,
});
const manholeGeo = new THREE.CircleGeometry(0.28, 20).rotateX(-Math.PI / 2);
const manholeRimGeo = new THREE.RingGeometry(0.28, 0.35, 20).rotateX(-Math.PI / 2);
const drainGeo = new THREE.BoxGeometry(0.9, 0.03, 0.4);
const utilityGeo = new THREE.BoxGeometry(0.72, 0.014, 0.52);
const stainGeo = new THREE.PlaneGeometry(1.9, 1.9).rotateX(-Math.PI / 2);

interface Detail {
  kind: "manhole" | "drain" | "utility";
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
  // sidewalk, snapped against that curb; rectangular utility covers on
  // sidewalk tiles. Sparse via rng, capped per chunk.
  let manholes = 0;
  let drains = 0;
  let utilities = 0;
  for (let tz = 0; tz < n && (manholes < 4 || drains < 3 || utilities < 4); tz++) {
    for (let tx = 0; tx < n; tx++) {
      const k = tile(tx, tz);
      const x = (tx + 0.5) * TILE_SIZE;
      const z = (tz + 0.5) * TILE_SIZE;
      if (k === "Sidewalk") {
        if (utilities < 4 && rng() < 0.02) {
          out.push({
            kind: "utility",
            x: x + (rng() - 0.5) * 0.6,
            z: z + (rng() - 0.5) * 0.6,
            rot: rng() < 0.5 ? 0 : Math.PI / 2,
          });
          utilities++;
        }
        continue;
      }
      if (k !== "Road" && k !== "RoadLine") continue;
      const cxm = tile(tx - 1, tz) === "Sidewalk";
      const cxp = tile(tx + 1, tz) === "Sidewalk";
      const czm = tile(tx, tz - 1) === "Sidewalk";
      const czp = tile(tx, tz + 1) === "Sidewalk";
      const curb = cxm || cxp || czm || czp;
      if (curb && drains < 3) {
        if (rng() < 0.05) {
          if (czm) out.push({ kind: "drain", x, z: tz * TILE_SIZE + 0.28, rot: 0 });
          else if (czp) out.push({ kind: "drain", x, z: (tz + 1) * TILE_SIZE - 0.28, rot: 0 });
          else if (cxm) out.push({ kind: "drain", x: tx * TILE_SIZE + 0.28, z, rot: Math.PI / 2 });
          else out.push({ kind: "drain", x: (tx + 1) * TILE_SIZE - 0.28, z, rot: Math.PI / 2 });
          drains++;
        }
      } else if (!curb && manholes < 4 && rng() < 0.045) {
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
            <mesh geometry={stainGeo} material={stainMat} position={[0, 0.014, 0]} />
            <mesh geometry={manholeGeo} material={manholeCover} position={[0, 0.016, 0]} />
            <mesh geometry={manholeRimGeo} material={manholeRim} position={[0, 0.015, 0]} />
          </group>
        ) : d.kind === "drain" ? (
          <group key={i} position={[d.x, 0, d.z]} rotation={[0, d.rot, 0]}>
            <mesh geometry={stainGeo} material={stainMat} position={[0, 0.014, 0]} scale={[0.9, 1, 0.7]} />
            <mesh geometry={drainGeo} material={drainGrate} position={[0, 0.018, 0]} />
          </group>
        ) : (
          <mesh
            key={i}
            geometry={utilityGeo}
            material={utilityCover}
            position={[d.x, 0.147, d.z]}
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
