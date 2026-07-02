// Client copy of the baked city tile grid (tools/citymap/bake.mjs). Mirrors
// the server's wilder-terrain CityMap so ground geometry, curb heights, and
// shader detail can query any world tile, including unloaded neighbors.

export const CITY_ROAD = 0;
export const CITY_ROAD_LINE = 1;
export const CITY_SIDEWALK = 2;
export const CITY_PLAZA = 3;
export const CITY_BUILDING = 4;
export const CITY_PARK = 5;
export const CITY_WATER = 6;

interface CityGrid {
  tileMinX: number;
  tileMinZ: number;
  width: number;
  height: number;
  tiles: Uint8Array;
}

export interface CityMapManifest {
  tileSize: number;
  tileMinX: number;
  tileMinZ: number;
  width: number;
  height: number;
  pxPerTile: number;
  spawn: [number, number];
  districts: { name: string; x: number; z: number }[];
}

let grid: CityGrid | null = null;
const readyCallbacks: (() => void)[] = [];

export function cityMapReady(): boolean {
  return grid !== null;
}

/** Register a callback for when the tile grid finishes loading (or fire now). */
export function onCityMapReady(cb: () => void): void {
  if (grid) cb();
  else readyCallbacks.push(cb);
}

/** Tile kind at a global world tile coordinate; Water outside / before load. */
export function cityTileAt(wtx: number, wtz: number): number {
  if (!grid) return CITY_WATER;
  const gx = wtx - grid.tileMinX;
  const gz = wtz - grid.tileMinZ;
  if (gx < 0 || gz < 0 || gx >= grid.width || gz >= grid.height) return CITY_WATER;
  return grid.tiles[gz * grid.width + gx];
}

async function load(): Promise<void> {
  const res = await fetch("/citymap/tiles.bin");
  const buf = new DataView(await res.arrayBuffer());
  const magic = String.fromCharCode(
    buf.getUint8(0),
    buf.getUint8(1),
    buf.getUint8(2),
    buf.getUint8(3),
  );
  if (magic !== "WCT1") throw new Error(`bad tiles.bin magic: ${magic}`);
  const tileMinX = buf.getInt32(4, true);
  const tileMinZ = buf.getInt32(8, true);
  const width = buf.getUint32(12, true);
  const height = buf.getUint32(16, true);
  const runCount = buf.getUint32(20, true);
  const tiles = new Uint8Array(width * height);
  let o = 24;
  let i = 0;
  for (let r = 0; r < runCount; r++) {
    const len = buf.getUint16(o, true);
    const kind = buf.getUint8(o + 2);
    o += 3;
    tiles.fill(kind, i, i + len);
    i += len;
  }
  grid = { tileMinX, tileMinZ, width, height, tiles };
  for (const cb of readyCallbacks.splice(0)) cb();
}

let manifestPromise: Promise<CityMapManifest> | null = null;
export function getCityMapManifest(): Promise<CityMapManifest> {
  manifestPromise ??= fetch("/citymap/manifest.json").then((r) => r.json());
  return manifestPromise;
}

void load().catch((e) => console.error("citymap load failed", e));
