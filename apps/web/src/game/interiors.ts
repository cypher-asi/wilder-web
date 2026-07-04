// Client mirror of the server's walk-in store interiors
// (crates/wilder-world/src/interiors.rs). Rooms are pure derived data:
// computed from streamed chunk geometry + replicated service entity
// positions, so client prediction and the server always agree without any
// protocol changes. Keep the layout math in lockstep with the Rust side.

import {
  BUILDING_FRONT_PROUD,
  CHUNK_SIZE,
  ChunkData,
  EntityKind,
  EntitySpawnData,
  TILE_SIZE,
} from "../net/protocol";
import { game } from "../state/game";
import { chunkKey } from "./collision";

export const INTERIOR_WALL = 0.3;
export const DOOR_HALF_WIDTH = 1.0;
const ROOM_MAX_DEPTH_TILES = 5;
const ROOM_SIDE_TILES = 3;

/** World-space axis-aligned box: [minx, minz, maxx, maxz]. */
export type Aabb = [number, number, number, number];

export interface InteriorDoor {
  entity: number;
  kind: EntityKind;
  /** World-space x of the door center on the front wall plane. */
  x: number;
}

/** One walk-in room carved out of a host building's ground floor. */
export interface InteriorSpec {
  /** Stable identity for React keys: `chunkKey:buildingIndex:groupIndex`. */
  key: string;
  coord: { x: number; z: number };
  /** Index of the host building in `ChunkData.buildings`. */
  building: number;
  /** World-space room rect (front wall plane at minz = the lot line). */
  bounds: Aabb;
  /** Chunk-local room tile rect [tx0, tz0, tx1, tz1) — walkable overrides. */
  tiles: [number, number, number, number];
  doors: InteriorDoor[];
  /** One counter box per door (degenerate [0,0,0,0] if the room is tiny). */
  counters: Aabb[];
  /** Wall + furniture colliders (includes the counters). */
  colliders: Aabb[];
  /** Furniture with render semantics (same boxes as in `colliders`). */
  deco: InteriorDeco[];
}

export interface ChunkInteriors {
  specs: InteriorSpec[];
  /** [building index, replacement front bands (door gaps carved)]. */
  frontBands: [number, Aabb[]][];
}

/** Furniture piece with render semantics (client-only; boxes mirror Rust). */
export interface InteriorDeco {
  box: Aabb;
  type: "shelf" | "machine" | "bench" | "pedestal";
}

/** Service kinds that get a walk-in interior. */
export function isServiceKind(kind: EntityKind): boolean {
  switch (kind) {
    case "Building":
    case "MarketTerminal":
    case "Refinery":
    case "Factory":
    case "Laboratory":
    case "Armory":
    case "Bank":
    case "Bodega":
    case "Dealership":
    case "Safehouse":
      return true;
    default:
      return false;
  }
}

/** Deterministic 32-bit mix (mirror of interiors.rs `mix`). */
function mix(a: number, b: number): number {
  let h = ((a ^ Math.imul(b, 0x9e3779b9)) >>> 0) as number;
  h = (h ^ (h >>> 15)) >>> 0;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  return h;
}

function boxesOverlap(a: Aabb, b: Aabb): boolean {
  return a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
}

export interface ServiceEntity {
  entity: number;
  kind: EntityKind;
  x: number;
  z: number;
}

/** Host building index for a service entity (mirror of `host_building`). */
function hostBuilding(chunk: ChunkData, ex: number, ez: number): number | null {
  const ox = chunk.coord.x * CHUNK_SIZE;
  const oz = chunk.coord.z * CHUNK_SIZE;
  let best: number | null = null;
  let bestD = Infinity;
  for (let i = 0; i < chunk.buildings.length; i++) {
    const b = chunk.buildings[i];
    if (b.tx1 - b.tx0 < 2 || b.tz1 - b.tz0 < 2) continue;
    const x0 = ox + b.tx0 * TILE_SIZE;
    const x1 = ox + b.tx1 * TILE_SIZE;
    const wallZ = oz + b.tz0 * TILE_SIZE;
    if (ex < x0 - 0.5 || ex > x1 + 0.5) continue;
    const dz = wallZ - ez;
    if (dz < 0 || dz > TILE_SIZE * 1.5) continue;
    if (dz < bestD) {
      bestD = dz;
      best = i;
    }
  }
  return best;
}

/**
 * Try to add `bx` if it fits inside `open` and avoids every box in `avoid`
 * (mirror of `push_if_clear`).
 */
function pushIfClear(out: Aabb[], avoid: Aabb[], open: Aabb, bx: Aabb): boolean {
  if (bx[0] < open[0] || bx[1] < open[1] || bx[2] > open[2] || bx[3] > open[3]) return false;
  if (bx[2] - bx[0] < 0.05 || bx[3] - bx[1] < 0.05) return false;
  if (avoid.some((a) => boxesOverlap(a, bx))) return false;
  avoid.push(bx);
  out.push(bx);
  return true;
}

/** Per-kind furniture blockers (mirror of `furniture`). */
function furniture(
  kind: EntityKind,
  open: Aabb,
  style: number,
  avoidIn: Aabb[],
  out: Aabb[],
  deco: InteriorDeco[],
) {
  const avoid = avoidIn.slice();
  const [ax0, az0, ax1, az1] = open;
  const w = ax1 - ax0;
  const d = az1 - az0;
  if (w < 4.0 || d < 2.0) return;
  const put = (bx: Aabb, type: InteriorDeco["type"]) => {
    if (pushIfClear(out, avoid, open, bx)) deco.push({ box: bx, type });
  };
  switch (kind) {
    case "Armory":
    case "Bodega":
    case "Building": {
      const len = Math.min(2.0, d - 1.0);
      const span = Math.max(d - len - 0.4, 0);
      const zl = az0 + 0.2 + (mix(style, 11) % 8) * (span / 8.0);
      const zr = az0 + 0.2 + (mix(style, 23) % 8) * (span / 8.0);
      put([ax0, zl, ax0 + 0.5, zl + len], "shelf");
      put([ax1 - 0.5, zr, ax1, zr + len], "shelf");
      break;
    }
    case "Factory":
    case "Refinery": {
      const zl = az0 + 0.4 + (mix(style, 37) % 6) * (Math.max(d - 2.0, 0) / 6.0);
      const zr = az0 + 0.4 + (mix(style, 53) % 6) * (Math.max(d - 2.0, 0) / 6.0);
      put([ax0 + 0.3, zl, ax0 + 1.5, zl + 1.2], "machine");
      put([ax1 - 1.5, zr, ax1 - 0.3, zr + 1.2], "machine");
      break;
    }
    case "Laboratory": {
      const cz = az0 + d * 0.45;
      const cx = (ax0 + ax1) / 2;
      put([cx - 3.1, cz - 0.4, cx - 1.5, cz + 0.4], "bench");
      put([cx + 1.5, cz - 0.4, cx + 3.1, cz + 0.4], "bench");
      break;
    }
    case "Dealership": {
      const cx = ax0 + w * 0.3;
      const cz = az0 + d * 0.5;
      put([cx - 1.0, cz - 1.0, cx + 1.0, cz + 1.0], "pedestal");
      break;
    }
    default:
      break;
  }
}

/**
 * Compute every interior room for a chunk given the service entities placed
 * in it (mirror of `chunk_interiors`).
 */
export function chunkInteriors(chunk: ChunkData, services: ServiceEntity[]): ChunkInteriors {
  const ox = chunk.coord.x * CHUNK_SIZE;
  const oz = chunk.coord.z * CHUNK_SIZE;
  const ckey = chunkKey(chunk.coord.x, chunk.coord.z);

  const sorted = services
    .slice()
    .sort((a, b) => a.x - b.x || a.entity - b.entity);
  const perBuilding: [number, InteriorDoor[]][] = [];
  for (const s of sorted) {
    if (!isServiceKind(s.kind)) continue;
    const bi = hostBuilding(chunk, s.x, s.z);
    if (bi === null) continue;
    const door: InteriorDoor = { entity: s.entity, kind: s.kind, x: s.x };
    const existing = perBuilding.find(([i]) => i === bi);
    if (existing) existing[1].push(door);
    else perBuilding.push([bi, [door]]);
  }
  perBuilding.sort((a, b) => a[0] - b[0]);

  const out: ChunkInteriors = { specs: [], frontBands: [] };
  for (const [bi, doors] of perBuilding) {
    const b = chunk.buildings[bi];
    const frontZ = oz + b.tz0 * TILE_SIZE;

    // Each door claims a tile rect around its door tile; overlapping or
    // touching rects merge into one shared room.
    interface Group {
      tx0: number;
      tx1: number;
      doors: InteriorDoor[];
    }
    const groups: Group[] = [];
    for (const door of doors) {
      const dtx = Math.min(Math.max(Math.floor((door.x - ox) / TILE_SIZE), b.tx0), b.tx1 - 1);
      const tx0 = Math.max(dtx - ROOM_SIDE_TILES, b.tx0);
      const tx1 = Math.min(dtx + 1 + ROOM_SIDE_TILES, b.tx1);
      const last = groups[groups.length - 1];
      if (last && tx0 <= last.tx1) {
        last.tx1 = Math.max(last.tx1, tx1);
        last.doors.push(door);
      } else {
        groups.push({ tx0, tx1, doors: [door] });
      }
    }

    const tz0 = b.tz0;
    const tz1 = Math.min(tz0 + ROOM_MAX_DEPTH_TILES, b.tz1);
    const allDoorXs: number[] = [];

    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi];
      const rx0 = ox + g.tx0 * TILE_SIZE;
      const rx1 = ox + g.tx1 * TILE_SIZE;
      const rz1 = oz + tz1 * TILE_SIZE;
      const roomW = rx1 - rx0;
      const roomD = rz1 - frontZ;

      const doorMin = rx0 + INTERIOR_WALL + DOOR_HALF_WIDTH + 0.2;
      const doorMax = rx1 - INTERIOR_WALL - DOOR_HALF_WIDTH - 0.2;
      for (const d of g.doors) {
        d.x = Math.min(Math.max(d.x, doorMin), doorMax);
        allDoorXs.push(d.x);
      }

      const colliders: Aabb[] = [];
      colliders.push([rx0, frontZ, rx0 + INTERIOR_WALL, rz1]);
      colliders.push([rx1 - INTERIOR_WALL, frontZ, rx1, rz1]);
      colliders.push([rx0, rz1 - INTERIOR_WALL, rx1, rz1]);

      const openX0 = rx0 + INTERIOR_WALL;
      const openX1 = rx1 - INTERIOR_WALL;
      const backGap = roomD >= 5.2 ? 1.2 : 0.4;
      const counterZ1 = rz1 - INTERIOR_WALL - backGap;
      const counterZ0 = counterZ1 - 0.8;
      const counters: Aabb[] = [];
      for (const d of g.doors) {
        const cw = Math.min(roomW - 2.8, 4.6);
        if (cw < 1.2 || counterZ0 <= frontZ + 1.6) {
          counters.push([0, 0, 0, 0]);
          continue;
        }
        const cx = Math.min(Math.max(d.x, openX0 + cw / 2 + 0.6), openX1 - cw / 2 - 0.6);
        const counter: Aabb = [cx - cw / 2, counterZ0, cx + cw / 2, counterZ1];
        counters.push(counter);
        colliders.push(counter);
      }

      const open: Aabb = [openX0, frontZ + 0.4, openX1, Math.max(counterZ0, frontZ + 0.4)];
      const avoid: Aabb[] = counters.filter((c) => c[2] > c[0]).slice();
      for (const d of g.doors) {
        avoid.push([d.x - 1.3, frontZ, d.x + 1.3, Math.max(counterZ0, frontZ)]);
      }
      const deco: InteriorDeco[] = [];
      for (let di = 0; di < g.doors.length; di++) {
        furniture(g.doors[di].kind, open, (b.style + di) >>> 0, avoid, colliders, deco);
      }

      out.specs.push({
        key: `${ckey}:${bi}:${gi}`,
        coord: { x: chunk.coord.x, z: chunk.coord.z },
        building: bi,
        bounds: [rx0, frontZ, rx1, rz1],
        tiles: [g.tx0, tz0, g.tx1, tz1],
        doors: g.doors,
        counters,
        colliders,
        deco,
      });
    }

    // Replacement storefront band: door gaps carved out of the full-width
    // proud band.
    const bx0 = ox + b.tx0 * TILE_SIZE;
    const bx1 = ox + b.tx1 * TILE_SIZE;
    allDoorXs.sort((a, b2) => a - b2);
    const bands: Aabb[] = [];
    let cursor = bx0;
    for (const dx of allDoorXs) {
      const gap0 = dx - DOOR_HALF_WIDTH;
      const gap1 = dx + DOOR_HALF_WIDTH;
      if (gap0 > cursor) bands.push([cursor, frontZ - BUILDING_FRONT_PROUD, gap0, frontZ]);
      cursor = Math.max(cursor, gap1);
    }
    if (cursor < bx1) bands.push([cursor, frontZ - BUILDING_FRONT_PROUD, bx1, frontZ]);
    out.frontBands.push([bi, bands]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Registry: tracks replicated service entities + streamed chunks, recomputes
// each chunk's interiors when either side arrives, and feeds the results to
// the collision store and (via subscribe/version) the interior renderer.
// ---------------------------------------------------------------------------

class InteriorRegistry {
  private services = new Map<number, ServiceEntity>();
  /** Computed interiors for chunks that are currently streamed in. */
  byChunk = new Map<string, ChunkInteriors>();
  version = 0;
  private listeners = new Set<() => void>();

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getVersion = (): number => this.version;

  /** Every currently-computed room, for rendering. */
  allSpecs(): InteriorSpec[] {
    const specs: InteriorSpec[] = [];
    for (const ints of this.byChunk.values()) specs.push(...ints.specs);
    return specs;
  }

  /** The room the given world position is in, if any. */
  roomAt(x: number, z: number, margin = 0): InteriorSpec | null {
    const key = chunkKey(Math.floor(x / CHUNK_SIZE), Math.floor(z / CHUNK_SIZE));
    const ints = this.byChunk.get(key);
    if (!ints) return null;
    for (const spec of ints.specs) {
      const [x0, z0, x1, z1] = spec.bounds;
      if (x >= x0 - margin && x <= x1 + margin && z >= z0 - margin && z <= z1 + margin) {
        return spec;
      }
    }
    return null;
  }

  entitySpawned(d: EntitySpawnData) {
    if (!isServiceKind(d.kind)) return;
    this.services.set(d.id, {
      entity: d.id,
      kind: d.kind,
      x: d.position[0],
      z: d.position[2],
    });
    this.recompute(Math.floor(d.position[0] / CHUNK_SIZE), Math.floor(d.position[2] / CHUNK_SIZE));
  }

  entityDespawned(id: number) {
    const s = this.services.get(id);
    if (!s) return;
    this.services.delete(id);
    this.recompute(Math.floor(s.x / CHUNK_SIZE), Math.floor(s.z / CHUNK_SIZE));
  }

  chunkAdded(chunk: ChunkData) {
    this.recompute(chunk.coord.x, chunk.coord.z);
  }

  chunkRemoved(cx: number, cz: number) {
    const key = chunkKey(cx, cz);
    if (this.byChunk.delete(key)) this.bump();
  }

  clear() {
    this.services.clear();
    this.byChunk.clear();
    this.bump();
  }

  private recompute(cx: number, cz: number) {
    const key = chunkKey(cx, cz);
    const chunk = game.chunks.chunks.get(key);
    if (!chunk) return; // chunkAdded will recompute once it streams in
    const services: ServiceEntity[] = [];
    for (const s of this.services.values()) {
      if (Math.floor(s.x / CHUNK_SIZE) === cx && Math.floor(s.z / CHUNK_SIZE) === cz) {
        services.push(s);
      }
    }
    const ints = chunkInteriors(chunk, services);
    if (ints.specs.length > 0) this.byChunk.set(key, ints);
    else this.byChunk.delete(key);
    game.chunks.setInteriors(key, ints.specs.length > 0 ? ints : null);
    this.bump();
  }

  private bump() {
    this.version++;
    for (const fn of this.listeners) fn();
  }
}

export const interiorRegistry = new InteriorRegistry();
