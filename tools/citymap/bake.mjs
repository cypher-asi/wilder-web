// Bake the Wilder World city layout (map.wilderworld.com blockout GLBs) into
// the game's 2 m tile grid.
//
// Inputs (tools/citymap/cache/, downloaded from
// github.com/jeanclawdvd-bot/map-wilderworld-com):
//   Map.glb        - per-district Street / Sidewalk / Plot / Land / Overpass meshes
//   Buildings.glb  - one blockout mesh per plot (named e.g. "NS-19" or "GAME")
//
// The source is Z-up with units in meters (verified against the plot areas in
// BuildingMetadata.csv). Game mapping: worldX = glbX - OX, worldZ = OZ - glbY
// (Y flip preserves the orientation seen in the official viewer).
//
// Outputs:
//   crates/wilder-terrain/assets/citymap.bin  - RLE tile grid + building rects (server)
//   apps/web/public/citymap/minimap.png       - 4 m/px overview for the M map
//   apps/web/public/citymap/manifest.json     - bounds, spawn, district label spots
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(DIR, "..", "..");
const CACHE = path.join(DIR, "cache");

const TILE = 2; // meters per tile
const CHUNK_TILES = 16;

// TileKind discriminants (must match shared/wilder-types and the client).
const ROAD = 0;
const SIDEWALK = 2;
const PLAZA = 3;
const BUILDING = 4;
const PARK = 5;
const WATER = 6;

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

// ---------------------------------------------------------------------------
// Triangle extraction
// ---------------------------------------------------------------------------

/** Collect world-space triangles of every mesh under `node` (inclusive). */
function collectTriangles(node, out) {
  const mesh = node.getMesh();
  if (mesh) {
    const m = node.getWorldMatrix();
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute("POSITION");
      if (!pos) continue;
      const arr = pos.getArray();
      const idx = prim.getIndices()?.getArray();
      const count = idx ? idx.length : pos.getCount();
      for (let i = 0; i + 2 < count; i += 3) {
        const tri = new Float64Array(9);
        for (let k = 0; k < 3; k++) {
          const vi = (idx ? idx[i + k] : i + k) * 3;
          const x = arr[vi];
          const y = arr[vi + 1];
          const z = arr[vi + 2];
          tri[k * 3] = m[0] * x + m[4] * y + m[8] * z + m[12];
          tri[k * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
          tri[k * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
        }
        out.push(tri);
      }
    }
  }
  for (const child of node.listChildren()) collectTriangles(child, out);
}

function fnv32(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// Load Map.glb layers
// ---------------------------------------------------------------------------

console.log("Loading Map.glb ...");
const mapDoc = await io.read(path.join(CACHE, "Map.glb"));
/** category -> array of tris (glb space); districts -> street tris. */
const layers = { Street: [], Sidewalk: [], Plot: [], Land: [] };
const districtStreets = new Map();
for (const scene of mapDoc.getRoot().listScenes()) {
  for (const group of scene.listChildren()) {
    const name = group.getName() ?? "";
    const dash = name.lastIndexOf("-");
    if (dash < 0) continue;
    const district = name.slice(0, dash).trim();
    const layer = name.slice(dash + 1).trim();
    if (!(layer in layers)) continue; // Overpass skipped: elevated decoration only
    const tris = [];
    collectTriangles(group, tris);
    layers[layer].push(...tris);
    if (layer === "Street") {
      const list = districtStreets.get(district) ?? [];
      list.push(...tris);
      districtStreets.set(district, list);
    }
  }
}
for (const [k, v] of Object.entries(layers)) console.log(`  ${k}: ${v.length} tris`);

// ---------------------------------------------------------------------------
// Bounds (in glb XY space) from the walkable city fabric + margin
// ---------------------------------------------------------------------------

let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
for (const layer of ["Street", "Sidewalk", "Plot"]) {
  for (const t of layers[layer]) {
    for (let k = 0; k < 3; k++) {
      minX = Math.min(minX, t[k * 3]);
      maxX = Math.max(maxX, t[k * 3]);
      minY = Math.min(minY, t[k * 3 + 1]);
      maxY = Math.max(maxY, t[k * 3 + 1]);
    }
  }
}
const MARGIN = 256; // meters of shoreline/water beyond the city fabric
minX -= MARGIN; minY -= MARGIN; maxX += MARGIN; maxY += MARGIN;

// Grid in glb tile space: gx along +glbX, gy along +glbY.
const gminX = Math.floor(minX / TILE);
const gminY = Math.floor(minY / TILE);
const W = Math.ceil(maxX / TILE) - gminX;
const H = Math.ceil(maxY / TILE) - gminY;
console.log(`Grid ${W} x ${H} tiles (${((W * TILE) / 1000).toFixed(1)} x ${((H * TILE) / 1000).toFixed(1)} km)`);

const grid = new Uint8Array(W * H).fill(WATER);

// ---------------------------------------------------------------------------
// Rasterization
// ---------------------------------------------------------------------------

const SUBSAMPLES = [[0.27, 0.27], [0.73, 0.27], [0.27, 0.73], [0.73, 0.73]];

/**
 * Rasterize triangles into `grid` with kind `kind`.
 * mode "any": tile is hit if any of 4 subsamples falls inside a triangle.
 * mode "center": only the tile center is sampled (conservative).
 * filter(tri): optional predicate (e.g. land above sea level).
 * hits: optional Set collecting hit tile indices (for building footprints).
 */
function rasterize(tris, kind, mode = "any", filter = null, hits = null) {
  const offs = mode === "center" ? [[0.5, 0.5]] : SUBSAMPLES;
  for (const t of tris) {
    if (filter && !filter(t)) continue;
    const ax = t[0], ay = t[1], bx = t[3], by = t[4], cx = t[6], cy = t[7];
    const tminX = Math.min(ax, bx, cx), tmaxX = Math.max(ax, bx, cx);
    const tminY = Math.min(ay, by, cy), tmaxY = Math.max(ay, by, cy);
    const gx0 = Math.max(0, Math.floor(tminX / TILE) - gminX);
    const gx1 = Math.min(W - 1, Math.floor(tmaxX / TILE) - gminX);
    const gy0 = Math.max(0, Math.floor(tminY / TILE) - gminY);
    const gy1 = Math.min(H - 1, Math.floor(tmaxY / TILE) - gminY);
    if (gx1 < gx0 || gy1 < gy0) continue;
    // Edge functions (signed areas); handle either winding.
    const d = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (d === 0) continue;
    for (let gy = gy0; gy <= gy1; gy++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        let inside = false;
        for (const [ox, oy] of offs) {
          const px = (gminX + gx + ox) * TILE;
          const py = (gminY + gy + oy) * TILE;
          const w0 = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
          const w1 = (cx - bx) * (py - by) - (cy - by) * (px - bx);
          const w2 = (ax - cx) * (py - cy) - (ay - cy) * (px - cx);
          if (d > 0 ? w0 >= 0 && w1 >= 0 && w2 >= 0 : w0 <= 0 && w1 <= 0 && w2 <= 0) {
            inside = true;
            break;
          }
        }
        if (inside) {
          const i = gy * W + gx;
          grid[i] = kind;
          if (hits) hits.add(i);
        }
      }
    }
  }
}

/**
 * Per-subsample coverage mask (bit s set = subsample s inside some triangle).
 * Used for the ground-fabric layers so each tile can be assigned by majority
 * coverage instead of "last rasterized layer that touches the tile wins",
 * which dilated streets by up to a tile per side into sidewalks.
 */
function rasterizeMask(tris, mask, filter = null) {
  for (const t of tris) {
    if (filter && !filter(t)) continue;
    const ax = t[0], ay = t[1], bx = t[3], by = t[4], cx = t[6], cy = t[7];
    const tminX = Math.min(ax, bx, cx), tmaxX = Math.max(ax, bx, cx);
    const tminY = Math.min(ay, by, cy), tmaxY = Math.max(ay, by, cy);
    const gx0 = Math.max(0, Math.floor(tminX / TILE) - gminX);
    const gx1 = Math.min(W - 1, Math.floor(tmaxX / TILE) - gminX);
    const gy0 = Math.max(0, Math.floor(tminY / TILE) - gminY);
    const gy1 = Math.min(H - 1, Math.floor(tmaxY / TILE) - gminY);
    if (gx1 < gx0 || gy1 < gy0) continue;
    const d = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (d === 0) continue;
    for (let gy = gy0; gy <= gy1; gy++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const i = gy * W + gx;
        let m = mask[i];
        if (m === 0b1111) continue;
        for (let s = 0; s < 4; s++) {
          if (m & (1 << s)) continue;
          const px = (gminX + gx + SUBSAMPLES[s][0]) * TILE;
          const py = (gminY + gy + SUBSAMPLES[s][1]) * TILE;
          const w0 = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
          const w1 = (cx - bx) * (py - by) - (cy - by) * (px - bx);
          const w2 = (ax - cx) * (py - cy) - (ay - cy) * (px - cx);
          if (d > 0 ? w0 >= 0 && w1 >= 0 && w2 >= 0 : w0 <= 0 && w1 <= 0 && w2 <= 0) {
            m |= 1 << s;
          }
        }
        mask[i] = m;
      }
    }
  }
}

const POPCOUNT4 = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];

// Land above sea level becomes park; underwater terrain stays water.
const aboveSea = (t) => (t[2] + t[5] + t[8]) / 3 > -0.5;

// Coverage masks per ground-fabric layer, then majority vote per tile. Ties
// favor the most specific/walkable kind: street > sidewalk > plaza > park.
const streetMask = new Uint8Array(W * H);
const sidewalkMask = new Uint8Array(W * H);
const plazaMask = new Uint8Array(W * H);
const parkMask = new Uint8Array(W * H);
console.log("Rasterizing land ...");
rasterizeMask(layers.Land, parkMask, aboveSea);
console.log("Rasterizing plots ...");
rasterizeMask(layers.Plot, plazaMask);
console.log("Rasterizing sidewalks ...");
rasterizeMask(layers.Sidewalk, sidewalkMask);
console.log("Rasterizing streets ...");
rasterizeMask(layers.Street, streetMask);
console.log("Assigning tiles by majority coverage ...");
for (let i = 0; i < grid.length; i++) {
  // Priority order breaks ties (>=), so equal coverage goes to the street.
  let kind = WATER;
  let best = 0;
  const park = POPCOUNT4[parkMask[i]];
  if (park > best) { best = park; kind = PARK; }
  const plaza = POPCOUNT4[plazaMask[i]];
  if (plaza >= best && plaza > 0) { best = plaza; kind = PLAZA; }
  const sidewalk = POPCOUNT4[sidewalkMask[i]];
  if (sidewalk >= best && sidewalk > 0) { best = sidewalk; kind = SIDEWALK; }
  const street = POPCOUNT4[streetMask[i]];
  if (street >= best && street > 0) { kind = ROAD; }
  grid[i] = kind;
}

// ---------------------------------------------------------------------------
// Buildings
// ---------------------------------------------------------------------------

console.log("Loading Buildings.glb ...");
const bldDoc = await io.read(path.join(CACHE, "Buildings.glb"));

/** World-space triangles of one node's own mesh only (no child recursion). */
function ownTriangles(node) {
  const mesh = node.getMesh();
  const out = [];
  if (!mesh) return out;
  const m = node.getWorldMatrix();
  for (const prim of mesh.listPrimitives()) {
    const pos = prim.getAttribute("POSITION");
    if (!pos) continue;
    const arr = pos.getArray();
    const idx = prim.getIndices()?.getArray();
    const count = idx ? idx.length : pos.getCount();
    for (let i = 0; i + 2 < count; i += 3) {
      const tri = new Float64Array(9);
      for (let k = 0; k < 3; k++) {
        const vi = (idx ? idx[i + k] : i + k) * 3;
        const x = arr[vi];
        const y = arr[vi + 1];
        const z = arr[vi + 2];
        tri[k * 3] = m[0] * x + m[4] * y + m[8] * z + m[12];
        tri[k * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
        tri[k * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
      }
      out.push(tri);
    }
  }
  return out;
}

/** { name, hits:Set<gridIdx>, stories } */
const buildingMeshes = [];
for (const node of bldDoc.getRoot().listNodes()) {
  const tris = ownTriangles(node);
  if (tris.length === 0) continue;
  let z0 = Infinity, z1 = -Infinity;
  for (const t of tris) {
    z0 = Math.min(z0, t[2], t[5], t[8]);
    z1 = Math.max(z1, t[2], t[5], t[8]);
  }
  const height = z1 - Math.max(z0, 0); // ignore basements below sea plane
  const stories = Math.max(1, Math.min(40, Math.round((height - 4.5) / 3) + 1));
  const hits = new Set();
  rasterize(tris, BUILDING, "center", null, hits);
  if (hits.size >= 1) {
    buildingMeshes.push({ name: node.getName() || "GAME", hits, stories });
  }
}
console.log(`  ${buildingMeshes.length} building meshes rasterized`);

// ---------------------------------------------------------------------------
// Spawn selection: center of the densest road neighborhood, then the nearest
// road tile whose 5x5 neighborhood is fully walkable.
// ---------------------------------------------------------------------------

const CELL = 128; // coarse density cell in tiles (256 m)
const cw = Math.ceil(W / CELL), ch = Math.ceil(H / CELL);
const density = new Uint32Array(cw * ch);
for (let gy = 0; gy < H; gy++) {
  for (let gx = 0; gx < W; gx++) {
    if (grid[gy * W + gx] === ROAD) density[Math.floor(gy / CELL) * cw + Math.floor(gx / CELL)]++;
  }
}
let best = 0, bestI = 0;
for (let i = 0; i < density.length; i++) if (density[i] > best) { best = density[i]; bestI = i; }
const scx = (bestI % cw) * CELL + CELL / 2;
const scy = Math.floor(bestI / cw) * CELL + CELL / 2;

const walkable = (gx, gy) => {
  if (gx < 0 || gy < 0 || gx >= W || gy >= H) return false;
  const k = grid[gy * W + gx];
  return k !== BUILDING && k !== WATER;
};
let spawnG = null;
outer: for (let r = 0; r < 400; r++) {
  for (let gy = scy - r; gy <= scy + r; gy++) {
    for (let gx = scx - r; gx <= scx + r; gx++) {
      if (Math.max(Math.abs(gx - scx), Math.abs(gy - scy)) !== r) continue;
      if (gx < 2 || gy < 2 || gx >= W - 2 || gy >= H - 2) continue;
      if (grid[gy * W + gx] !== ROAD) continue;
      let ok = true;
      for (let dy = -2; dy <= 2 && ok; dy++)
        for (let dx = -2; dx <= 2 && ok; dx++) if (!walkable(gx + dx, gy + dy)) ok = false;
      if (ok) { spawnG = [gx, gy]; break outer; }
    }
  }
}
if (!spawnG) throw new Error("no spawnable road tile found");
console.log(`Spawn grid tile: ${spawnG} (density cell ${best} road tiles)`);

// ---------------------------------------------------------------------------
// World mapping. World tile coords: wtx = gx + tileMinX, wtz derived from gy
// with a Y flip (worldZ = -glbY). Choose offsets so the spawn tile lands at
// world tile (1,1) -> spawn point (3, 3) in chunk (0,0), matching SPAWN.
// ---------------------------------------------------------------------------

// gy indexes +glbY; world tile z must grow with -glbY, so flip: gz = H-1-gy.
const [sgx, sgy] = spawnG;
const sgz = H - 1 - sgy;
const tileMinX = 1 - sgx;
const tileMinZ = 1 - sgz;

// Re-pack the grid flipped in Z so rows are world-row-major.
const world = new Uint8Array(W * H);
for (let gz = 0; gz < H; gz++) {
  const gy = H - 1 - gz;
  world.set(grid.subarray(gy * W, gy * W + W), gz * W);
}

// Building rects per chunk (world tile space).
const buildings = [];
for (const bm of buildingMeshes) {
  // Per-chunk boolean grids of this mesh's tiles.
  const perChunk = new Map();
  for (const i of bm.hits) {
    const gx = i % W, gy = Math.floor(i / W);
    const wtx = gx + tileMinX;
    const wtz = H - 1 - gy + tileMinZ;
    const cx = Math.floor(wtx / CHUNK_TILES), cz = Math.floor(wtz / CHUNK_TILES);
    const key = `${cx},${cz}`;
    let g = perChunk.get(key);
    if (!g) { g = new Uint8Array(CHUNK_TILES * CHUNK_TILES); perChunk.set(key, g); }
    g[(wtz - cz * CHUNK_TILES) * CHUNK_TILES + (wtx - cx * CHUNK_TILES)] = 1;
  }
  const style = fnv32(bm.name) ^ Math.imul(bm.hits.size, 0x9e3779b9);
  const archetype = fnv32(bm.name + "#a") % 4;
  for (const [key, g] of perChunk) {
    const [cx, cz] = key.split(",").map(Number);
    // Greedy rect cover.
    for (let tz = 0; tz < CHUNK_TILES; tz++) {
      for (let tx = 0; tx < CHUNK_TILES; tx++) {
        if (!g[tz * CHUNK_TILES + tx]) continue;
        let tx1 = tx;
        while (tx1 + 1 < CHUNK_TILES && g[tz * CHUNK_TILES + tx1 + 1]) tx1++;
        let tz1 = tz;
        rows: while (tz1 + 1 < CHUNK_TILES) {
          for (let x = tx; x <= tx1; x++) if (!g[(tz1 + 1) * CHUNK_TILES + x]) break rows;
          tz1++;
        }
        for (let z = tz; z <= tz1; z++) for (let x = tx; x <= tx1; x++) g[z * CHUNK_TILES + x] = 0;
        buildings.push({ cx, cz, tx0: tx, tz0: tz, tx1: tx1 + 1, tz1: tz1 + 1, stories: bm.stories, archetype, style: style >>> 0 });
      }
    }
  }
}
console.log(`  ${buildings.length} building rects after chunk split`);

// ---------------------------------------------------------------------------
// citymap.bin (consumed by wilder-terrain via include_bytes!)
// ---------------------------------------------------------------------------

{
  // RLE across world-row-major grid (u16 run, u8 kind).
  const runs = [];
  let cur = world[0], run = 0;
  for (let i = 0; i < world.length; i++) {
    if (world[i] === cur && run < 0xffff) run++;
    else { runs.push([run, cur]); cur = world[i]; run = 1; }
  }
  runs.push([run, cur]);

  const headerSize = 4 + 4 * 4 + 8 + 4;
  const bldSize = 4 + buildings.length * 18;
  const rleSize = 4 + runs.length * 3;
  const buf = Buffer.alloc(headerSize + bldSize + rleSize);
  let o = 0;
  buf.write("WCM1", o); o += 4;
  buf.writeInt32LE(tileMinX, o); o += 4;
  buf.writeInt32LE(tileMinZ, o); o += 4;
  buf.writeUInt32LE(W, o); o += 4;
  buf.writeUInt32LE(H, o); o += 4;
  buf.writeFloatLE(3.0, o); o += 4; // spawn world x
  buf.writeFloatLE(3.0, o); o += 4; // spawn world z
  buf.writeUInt32LE(buildings.length, o); o += 4;
  for (const b of buildings) {
    buf.writeInt32LE(b.cx, o); o += 4;
    buf.writeInt32LE(b.cz, o); o += 4;
    buf.writeUInt8(b.tx0, o++); buf.writeUInt8(b.tz0, o++);
    buf.writeUInt8(b.tx1, o++); buf.writeUInt8(b.tz1, o++);
    buf.writeUInt8(b.stories, o++); buf.writeUInt8(b.archetype, o++);
    buf.writeUInt32LE(b.style, o); o += 4;
  }
  buf.writeUInt32LE(runs.length, o); o += 4;
  for (const [r, k] of runs) {
    buf.writeUInt16LE(r, o); o += 2;
    buf.writeUInt8(k, o++);
  }
  const outPath = path.join(REPO, "crates", "wilder-terrain", "assets", "citymap.bin");
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, buf);
  console.log(`citymap.bin: ${(buf.length / 1e6).toFixed(2)} MB (${runs.length} runs)`);
}

// ---------------------------------------------------------------------------
// Client tile grid (same RLE, no buildings) for ground curbs + heights
// ---------------------------------------------------------------------------

{
  const runs = [];
  let cur = world[0], run = 0;
  for (let i = 0; i < world.length; i++) {
    if (world[i] === cur && run < 0xffff) run++;
    else { runs.push([run, cur]); cur = world[i]; run = 1; }
  }
  runs.push([run, cur]);
  const buf = Buffer.alloc(4 + 4 * 4 + 4 + runs.length * 3);
  let o = 0;
  buf.write("WCT1", o); o += 4;
  buf.writeInt32LE(tileMinX, o); o += 4;
  buf.writeInt32LE(tileMinZ, o); o += 4;
  buf.writeUInt32LE(W, o); o += 4;
  buf.writeUInt32LE(H, o); o += 4;
  buf.writeUInt32LE(runs.length, o); o += 4;
  for (const [r, k] of runs) {
    buf.writeUInt16LE(r, o); o += 2;
    buf.writeUInt8(k, o++);
  }
  const outDir = path.join(REPO, "apps", "web", "public", "citymap");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, "tiles.bin"), buf);
  console.log(`tiles.bin: ${(buf.length / 1e6).toFixed(2)} MB`);
}

// ---------------------------------------------------------------------------
// Client minimap + manifest
// ---------------------------------------------------------------------------

const PX_PER_TILE = 0.5; // 4 m per pixel
{
  const pw = Math.ceil(W * PX_PER_TILE);
  const ph = Math.ceil(H * PX_PER_TILE);
  const colors = {
    [ROAD]: [24, 26, 32],
    [SIDEWALK]: [58, 61, 70],
    [PLAZA]: [44, 47, 54],
    [BUILDING]: [86, 94, 118],
    [PARK]: [26, 58, 40],
    [WATER]: [10, 20, 34],
  };
  const raw = Buffer.alloc(pw * ph * 4);
  for (let py = 0; py < ph; py++) {
    for (let px = 0; px < pw; px++) {
      // Majority-ish: sample the 2x2 tile block, prefer the "most built" kind.
      const gx = Math.min(W - 1, Math.floor(px / PX_PER_TILE));
      const gz = Math.min(H - 1, Math.floor(py / PX_PER_TILE));
      let kind = world[gz * W + gx];
      for (const [dx, dz] of [[1, 0], [0, 1], [1, 1]]) {
        const x = Math.min(W - 1, gx + dx), z = Math.min(H - 1, gz + dz);
        const k = world[z * W + x];
        // Roads and buildings win over background kinds for readability.
        if (k === ROAD || (k === BUILDING && kind !== ROAD)) kind = k;
      }
      const [r, g, b] = colors[kind] ?? [255, 0, 255];
      const i = (py * pw + px) * 4;
      raw[i] = r; raw[i + 1] = g; raw[i + 2] = b; raw[i + 3] = 255;
    }
  }
  const outDir = path.join(REPO, "apps", "web", "public", "citymap");
  mkdirSync(outDir, { recursive: true });
  await sharp(raw, { raw: { width: pw, height: ph, channels: 4 } })
    .png({ compressionLevel: 9, palette: true })
    .toFile(path.join(outDir, "minimap.png"));

  // District label anchors: area-weighted centroid of each district's streets.
  const districts = [];
  for (const [name, tris] of districtStreets) {
    let ax = 0, ay = 0, area = 0;
    for (const t of tris) {
      const a = Math.abs((t[3] - t[0]) * (t[7] - t[1]) - (t[4] - t[1]) * (t[6] - t[0])) / 2;
      ax += a * (t[0] + t[3] + t[6]) / 3;
      ay += a * (t[1] + t[4] + t[7]) / 3;
      area += a;
    }
    if (area === 0) continue;
    const glbX = ax / area, glbY = ay / area;
    // glb -> world: worldTile = glbTile - gmin, flipped in z, + tileMin.
    const wx = (glbX / TILE - gminX + tileMinX) * TILE;
    const wz = (H - 1 - (glbY / TILE - gminY) + tileMinZ) * TILE;
    districts.push({ name, x: Math.round(wx), z: Math.round(wz) });
  }

  const manifest = {
    tileSize: TILE,
    tileMinX,
    tileMinZ,
    width: W,
    height: H,
    pxPerTile: PX_PER_TILE,
    spawn: [3, 3],
    districts,
  };
  writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(`minimap.png: ${pw} x ${ph}px, manifest with ${districts.length} districts`);
}

// Stats
{
  const counts = new Array(8).fill(0);
  for (let i = 0; i < world.length; i++) counts[world[i]]++;
  const pct = (n) => ((100 * n) / world.length).toFixed(1) + "%";
  console.log(
    `Tiles: road ${pct(counts[ROAD])}, sidewalk ${pct(counts[SIDEWALK])}, plaza ${pct(counts[PLAZA])}, building ${pct(counts[BUILDING])}, park ${pct(counts[PARK])}, water ${pct(counts[WATER])}`,
  );
}
console.log("BAKE DONE");
