// Scale regression check for the baked city map. Measures ground truth
// straight from the source GLBs (tools/citymap/cache/) and compares it to the
// baked client grid (apps/web/public/citymap/tiles.bin):
//
//   1. Island extents vs the official Wiami spec (~27 km long, 3-5 km wide).
//   2. Street curb-to-curb width distribution, sampled from GLB triangles at
//      1 m, vs the same measurement over the baked 2 m tiles. Catches unit
//      errors and rasterization dilation (streets eating sidewalk tiles).
//   3. Building blockout footprints vs the plot areas in BuildingMetadata.csv
//      (plots are the authored ground truth for "1 unit = 1 meter").
//
// Usage: node tools/citymap/verify-scale.mjs   (exits non-zero on failure)
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(DIR, "..", "..");
const CACHE = path.join(DIR, "cache");
const TILE = 2;

let failures = 0;
function check(ok, label, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures++;
}

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

/** World-space triangles (XY = ground plane in glb space) under `node`. */
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
        const tri = new Float64Array(6);
        for (let k = 0; k < 3; k++) {
          const vi = (idx ? idx[i + k] : i + k) * 3;
          const x = arr[vi], y = arr[vi + 1], z = arr[vi + 2];
          tri[k * 2] = m[0] * x + m[4] * y + m[8] * z + m[12];
          tri[k * 2 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
        }
        out.push(tri);
      }
    }
  }
  for (const child of node.listChildren()) collectTriangles(child, out);
}

// ---------------------------------------------------------------------------
// 1. Island extents from the street layer
// ---------------------------------------------------------------------------

console.log("Loading Map.glb ...");
const mapDoc = await io.read(path.join(CACHE, "Map.glb"));
const streets = [];
for (const scene of mapDoc.getRoot().listScenes()) {
  for (const group of scene.listChildren()) {
    if ((group.getName() ?? "").endsWith("Street")) collectTriangles(group, streets);
  }
}
let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
for (const t of streets) {
  for (let k = 0; k < 3; k++) {
    minX = Math.min(minX, t[k * 2]); maxX = Math.max(maxX, t[k * 2]);
    minY = Math.min(minY, t[k * 2 + 1]); maxY = Math.max(maxY, t[k * 2 + 1]);
  }
}
const extentX = (maxX - minX) / 1000;
const extentY = (maxY - minY) / 1000;
const long = Math.max(extentX, extentY);
const wide = Math.min(extentX, extentY);
check(
  long > 24 && long < 29 && wide > 3 && wide < 8,
  "island extents ~27 x 3-5 km",
  `street network ${long.toFixed(1)} x ${wide.toFixed(1)} km`,
);

// ---------------------------------------------------------------------------
// 2. Street width distribution: GLB (1 m sampling) vs baked tiles (2 m)
// ---------------------------------------------------------------------------

/**
 * Width histogram of a road occupancy grid: at each occupied sample, the
 * narrowest span through it over 4 directions (axis + diagonal). Returns a
 * Map of rounded meters -> sample count, ignoring open pavement > 80 m.
 */
function widthHistogram(occ, W, H, res, stride) {
  const at = (x, y) => x >= 0 && y >= 0 && x < W && y < H && occ[y * W + x] !== 0;
  const cap = Math.round(90 / res);
  const span = (x, y, dx, dy) => {
    let n = 1;
    for (let a = 1; a <= cap && at(x - dx * a, y - dy * a); a++) n++;
    for (let a = 1; a <= cap && at(x + dx * a, y + dy * a); a++) n++;
    return n;
  };
  const hist = new Map();
  for (let y = 0; y < H; y += stride) {
    for (let x = 0; x < W; x += stride) {
      if (!occ[y * W + x]) continue;
      const w =
        Math.min(
          Math.min(span(x, y, 1, 0), span(x, y, 0, 1)),
          Math.min(span(x, y, 1, 1), span(x, y, 1, -1)) * Math.SQRT2,
        ) * res;
      if (w > 80) continue;
      const key = Math.round(w);
      hist.set(key, (hist.get(key) ?? 0) + 1);
    }
  }
  return hist;
}

function median(hist) {
  const total = [...hist.values()].reduce((a, b) => a + b, 0);
  let acc = 0;
  for (const k of [...hist.keys()].sort((a, b) => a - b)) {
    acc += hist.get(k);
    if (acc >= total / 2) return k;
  }
  return 0;
}

console.log("Rasterizing GLB streets at 1 m ...");
{
  const RES = 1;
  const W = Math.ceil((maxX - minX) / RES) + 1;
  const H = Math.ceil((maxY - minY) / RES) + 1;
  const occ = new Uint8Array(W * H);
  for (const t of streets) {
    const ax = t[0], ay = t[1], bx = t[2], by = t[3], cx = t[4], cy = t[5];
    const x0 = Math.max(0, Math.floor((Math.min(ax, bx, cx) - minX) / RES));
    const x1 = Math.min(W - 1, Math.floor((Math.max(ax, bx, cx) - minX) / RES));
    const y0 = Math.max(0, Math.floor((Math.min(ay, by, cy) - minY) / RES));
    const y1 = Math.min(H - 1, Math.floor((Math.max(ay, by, cy) - minY) / RES));
    const d = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (d === 0) continue;
    for (let gy = y0; gy <= y1; gy++) {
      for (let gx = x0; gx <= x1; gx++) {
        const px = minX + (gx + 0.5) * RES;
        const py = minY + (gy + 0.5) * RES;
        const w0 = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
        const w1 = (cx - bx) * (py - by) - (cy - by) * (px - bx);
        const w2 = (ax - cx) * (py - cy) - (ay - cy) * (px - cx);
        if (d > 0 ? w0 >= 0 && w1 >= 0 && w2 >= 0 : w0 <= 0 && w1 <= 0 && w2 <= 0) {
          occ[gy * W + gx] = 1;
        }
      }
    }
  }
  let glbArea = 0;
  for (let i = 0; i < occ.length; i++) glbArea += occ[i];
  const glbHist = widthHistogram(occ, W, H, RES, 4);
  const glbMedian = median(glbHist);

  console.log("Measuring baked tiles.bin ...");
  const buf = readFileSync(path.join(REPO, "apps", "web", "public", "citymap", "tiles.bin"));
  const magic = buf.toString("utf8", 0, 4);
  if (magic !== "WCT1") throw new Error(`bad tiles.bin magic: ${magic}`);
  const TW = buf.readUInt32LE(12);
  const TH = buf.readUInt32LE(16);
  const runCount = buf.readUInt32LE(20);
  const tiles = new Uint8Array(TW * TH);
  let o = 24, i = 0;
  for (let r = 0; r < runCount; r++) {
    const len = buf.readUInt16LE(o);
    const kind = buf.readUInt8(o + 2);
    o += 3;
    tiles.fill(kind, i, i + len);
    i += len;
  }
  const roadOcc = new Uint8Array(TW * TH);
  let tileArea = 0;
  for (let j = 0; j < tiles.length; j++) {
    if (tiles[j] === 0 || tiles[j] === 1) {
      roadOcc[j] = 1;
      tileArea += TILE * TILE;
    }
  }
  const tileHist = widthHistogram(roadOcc, TW, TH, TILE, 2);
  const tileMedian = median(tileHist);

  const areaRatio = tileArea / glbArea;
  console.log(
    `  GLB road area ${(glbArea / 1e6).toFixed(2)} km2, baked ${(tileArea / 1e6).toFixed(2)} km2, ` +
      `median width GLB ${glbMedian} m vs baked ${tileMedian} m`,
  );
  check(Math.abs(tileMedian - glbMedian) <= TILE, "median street width within 1 tile of GLB");
  check(areaRatio > 0.9 && areaRatio < 1.25, "baked road area within +25%/-10% of GLB", `ratio ${areaRatio.toFixed(3)}`);
}

// ---------------------------------------------------------------------------
// 3. Building footprints vs authored plot areas (meter-unit ground truth)
// ---------------------------------------------------------------------------

console.log("Cross-checking Buildings.glb against BuildingMetadata.csv ...");
{
  const csv = readFileSync(path.join(CACHE, "BuildingMetadata.csv"), "utf8").split(/\r?\n/);
  const header = csv[0].split(",");
  const areaCol = header.indexOf("Plot Area (m2)");
  const plotArea = new Map();
  for (const line of csv.slice(1)) {
    const cols = line.split(",");
    if (cols.length > areaCol && cols[0]) plotArea.set(cols[0], Number(cols[areaCol]));
  }

  const bldDoc = await io.read(path.join(CACHE, "Buildings.glb"));
  const ratios = [];
  for (const node of bldDoc.getRoot().listNodes()) {
    const area = plotArea.get(node.getName());
    if (!area || area <= 0) continue;
    const tris = [];
    collectTriangles(node, tris);
    if (tris.length === 0) continue;
    let bMinX = Infinity, bMinY = Infinity, bMaxX = -Infinity, bMaxY = -Infinity;
    for (const t of tris) {
      for (let k = 0; k < 3; k++) {
        bMinX = Math.min(bMinX, t[k * 2]); bMaxX = Math.max(bMaxX, t[k * 2]);
        bMinY = Math.min(bMinY, t[k * 2 + 1]); bMaxY = Math.max(bMaxY, t[k * 2 + 1]);
      }
    }
    ratios.push(((bMaxX - bMinX) * (bMaxY - bMinY)) / area);
    if (ratios.length >= 500) break;
  }
  ratios.sort((a, b) => a - b);
  const med = ratios[ratios.length >> 1] ?? 0;
  // Blockout bbox vs plot polygon area: same units means the ratio sits near
  // 1 (bbox overshoots concave plots; buildings undershoot plot edges). A
  // unit error (feet, cm) would land at 0.09x / 10.8x instead.
  check(
    ratios.length > 100 && med > 0.5 && med < 2.0,
    "building footprint / plot area ratio ~1",
    `median ${med.toFixed(2)} over ${ratios.length} plots`,
  );
}

console.log(failures === 0 ? "SCALE VERIFY OK" : `SCALE VERIFY: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
