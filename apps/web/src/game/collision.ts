// Client-side mirror of the server's movement + collision rules
// (crates/wilder-physics). Used for local player prediction.

import {
  CHUNK_SIZE,
  ChunkData,
  TILE_SIZE,
  TILES_PER_CHUNK,
} from "../net/protocol";

export const WALK_SPEED = 3.0;
export const RUN_SPEED = 6.0;
export const PLAYER_RADIUS = 0.4;

export function chunkKey(x: number, z: number): string {
  return `${x},${z}`;
}

export class ChunkStore {
  chunks = new Map<string, ChunkData>();
  walkableCache = new Map<string, boolean[]>();
  /** bumped on chunk add/remove so React can resync */
  version = 0;

  add(chunk: ChunkData) {
    const key = chunkKey(chunk.coord.x, chunk.coord.z);
    this.chunks.set(key, chunk);
    this.walkableCache.set(
      key,
      chunk.tiles.map((t) => t !== "Building" && t !== "Water"),
    );
    this.version++;
  }

  remove(x: number, z: number) {
    const key = chunkKey(x, z);
    this.chunks.delete(key);
    this.walkableCache.delete(key);
    this.version++;
  }

  clear() {
    this.chunks.clear();
    this.walkableCache.clear();
    this.version++;
  }

  walkable(x: number, z: number): boolean {
    const cx = Math.floor(x / CHUNK_SIZE);
    const cz = Math.floor(z / CHUNK_SIZE);
    const grid = this.walkableCache.get(chunkKey(cx, cz));
    // Unloaded chunk: treat as solid, same as the server.
    if (!grid) return false;
    const lx = x - cx * CHUNK_SIZE;
    const lz = z - cz * CHUNK_SIZE;
    const tx = Math.min(Math.floor(lx / TILE_SIZE), TILES_PER_CHUNK - 1);
    const tz = Math.min(Math.floor(lz / TILE_SIZE), TILES_PER_CHUNK - 1);
    return grid[tz * TILES_PER_CHUNK + tx];
  }

  positionClear(x: number, z: number): boolean {
    return (
      this.walkable(x + PLAYER_RADIUS, z) &&
      this.walkable(x - PLAYER_RADIUS, z) &&
      this.walkable(x, z + PLAYER_RADIUS) &&
      this.walkable(x, z - PLAYER_RADIUS)
    );
  }
}

/** Mirror of wilder_physics::step_move (axis-separated slide). */
export function stepMove(
  store: ChunkStore,
  px: number,
  pz: number,
  dx: number,
  dz: number,
  run: boolean,
  dt: number,
): [number, number] {
  const len = Math.hypot(dx, dz);
  if (len < 1e-5 || dt <= 0) return [px, pz];
  const speed = run ? RUN_SPEED : WALK_SPEED;
  const clamped = Math.min(dt, 0.25);
  const step = (speed * clamped) / len;
  const mx = dx * step;
  const mz = dz * step;

  let x = px;
  let z = pz;
  if (store.positionClear(x + mx, z)) x += mx;
  if (store.positionClear(x, z + mz)) z += mz;
  return [x, z];
}
