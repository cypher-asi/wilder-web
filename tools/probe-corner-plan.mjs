// One-off probe: dequantized plan-view (x/z) occupancy map + axis histograms
// of an imported GLB, to recover the L-corner module's leg layout and wall
// planes in the coordinate frame the game places it in.
//   node tools/probe-corner-plan.mjs sm_skyscraper_module15 [cells]
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { dequantize } from "@gltf-transform/functions";
import { MeshoptDecoder } from "meshoptimizer";

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  "meshopt.decoder": MeshoptDecoder,
});

const id = process.argv[2];
const cells = Number(process.argv[3] ?? 24);
const doc = await io.read(`assets/models/imported/${id}.glb`);
await doc.transform(dequantize());

// Gather world-space positions (apply node transforms) and triangles.
const pts = [];
const tris = [];
const root = doc.getRoot();
for (const scene of root.listScenes()) {
  const walk = (node, parent) => {
    const m = multiply(parent, node.getMatrix());
    const mesh = node.getMesh();
    if (mesh) {
      for (const prim of mesh.listPrimitives()) {
        const arr = prim.getAttribute("POSITION").getArray();
        const base = pts.length;
        for (let i = 0; i < arr.length; i += 3) {
          pts.push(apply(m, arr[i], arr[i + 1], arr[i + 2]));
        }
        const idx = prim.getIndices()?.getArray();
        const count = idx ? idx.length : arr.length / 3;
        for (let i = 0; i < count; i += 3) {
          const a = base + (idx ? idx[i] : i);
          const b = base + (idx ? idx[i + 1] : i + 1);
          const c = base + (idx ? idx[i + 2] : i + 2);
          tris.push([a, b, c]);
        }
      }
    }
    for (const child of node.listChildren()) walk(child, m);
  };
  for (const node of scene.listChildren()) walk(node, ident());
}

function ident() {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}
function multiply(a, b) {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++)
      for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}
function apply(m, x, y, z) {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

const lo = [1e9, 1e9, 1e9];
const hi = [-1e9, -1e9, -1e9];
for (const p of pts)
  for (let a = 0; a < 3; a++) {
    if (p[a] < lo[a]) lo[a] = p[a];
    if (p[a] > hi[a]) hi[a] = p[a];
  }
console.log(
  `${id} verts=${pts.length} bbox x[${lo[0].toFixed(3)},${hi[0].toFixed(3)}] y[${lo[1].toFixed(3)},${hi[1].toFixed(3)}] z[${lo[2].toFixed(3)},${hi[2].toFixed(3)}]`,
);

// Plan view: x (cols) vs z (rows), rasterized by sampling triangle surfaces
// so coverage reflects area, not vertex density.
const sx = hi[0] - lo[0] || 1;
const sz = hi[2] - lo[2] || 1;
const grid = Array.from({ length: cells }, () => new Array(cells).fill(0));
const mark = (x, z, wgt) => {
  const ix = Math.min(cells - 1, Math.floor(((x - lo[0]) / sx) * cells));
  const iz = Math.min(cells - 1, Math.floor(((z - lo[2]) / sz) * cells));
  grid[iz][ix] += wgt;
};
for (const [a, b, c] of tris) {
  const A = pts[a], B = pts[b], C = pts[c];
  const ab = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
  const ac = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
  const cx = ab[1] * ac[2] - ab[2] * ac[1];
  const cy = ab[2] * ac[0] - ab[0] * ac[2];
  const cz = ab[0] * ac[1] - ab[1] * ac[0];
  const area = Math.hypot(cx, cy, cz) / 2;
  const n = Math.max(1, Math.min(64, Math.ceil(area * 8)));
  for (let s = 0; s < n; s++) {
    let u = Math.random(), v = Math.random();
    if (u + v > 1) { u = 1 - u; v = 1 - v; }
    mark(A[0] + ab[0] * u + ac[0] * v, A[2] + ab[2] * u + ac[2] * v, area / n);
  }
}
const peak = Math.max(...grid.flat()) || 1;
console.log(`PLAN rows=+z..-z cols=-x..+x  peak=${peak}`);
for (let iz = cells - 1; iz >= 0; iz--) {
  let line = "";
  for (let ix = 0; ix < cells; ix++) {
    const d = grid[iz][ix] / peak;
    line += d > 0.25 ? "#" : d > 0.08 ? "+" : d > 0 ? "." : " ";
  }
  console.log(`|${line}|  z=${(lo[2] + ((iz + 0.5) / cells) * sz).toFixed(2)}`);
}

// Fine histograms (5 cm bins) inside strips, to nail wall planes and spans:
//  - leg A (wall along x): strip x in [-5, 0] -> z histogram
//  - leg B (wall along z): strip z in [-5, 0] -> x histogram
//  - wall A span: strip z in [2.5, 3.4] -> x histogram
//  - wall B span: strip x in [2.5, 3.4] -> z histogram
function strip(name, selAxis, selLo, selHi, axis) {
  const buckets = new Map();
  let n = 0;
  for (const p of pts) {
    if (p[selAxis] < selLo || p[selAxis] > selHi) continue;
    n++;
    const b = Math.round(p[axis] / 0.05);
    buckets.set(b, (buckets.get(b) ?? 0) + 1);
  }
  console.log(`STRIP ${name} (${n} verts)`);
  for (const k of [...buckets.keys()].sort((a, b) => a - b)) {
    const v = buckets.get(k);
    if (v < Math.max(8, n / 100)) continue;
    console.log(
      `  ${axis === 0 ? "x" : "z"}=${(k * 0.05).toFixed(2)}: ${"#".repeat(Math.min(60, Math.ceil(v / 10)))} (${v})`,
    );
  }
}
strip("legA wall plane (x -5..0)", 0, -5, 0, 2);
strip("legB wall plane (z -5..0)", 2, -5, 0, 0);
strip("wallA span (z 2.5..3.4)", 2, 2.5, 3.4, 0);
strip("wallB span (x 2.5..3.4)", 0, 2.5, 3.4, 2);

// Facing check: area-weighted geometric normals of large near-vertical faces,
// bucketed by which wall strip their centroid falls in. Tells which way each
// leg's facade faces (+ = toward +axis).
const facing = { legA: { pos: 0, neg: 0 }, legB: { pos: 0, neg: 0 }, stubA: { pos: 0, neg: 0 }, stubB: { pos: 0, neg: 0 } };
for (const [a, b, c] of tris) {
  const A = pts[a], B = pts[b], C = pts[c];
  const ab = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
  const ac = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
  const n = [
    ab[1] * ac[2] - ab[2] * ac[1],
    ab[2] * ac[0] - ab[0] * ac[2],
    ab[0] * ac[1] - ab[1] * ac[0],
  ];
  const area2 = Math.hypot(...n);
  if (area2 < 1e-6) continue;
  const cx = (A[0] + B[0] + C[0]) / 3;
  const cz = (A[2] + B[2] + C[2]) / 3;
  const w = area2 / 2;
  // legA: wall band along x (z near 2..3.5, x in [-5.5, 2.5])
  if (cz > 2 && cz < 3.6 && cx > -5.5 && cx < 2.5 && Math.abs(n[2]) > 0.7 * area2) {
    facing.legA[n[2] > 0 ? "pos" : "neg"] += w;
  }
  // legB: wall band along z (x near 2..3.5, z in [-5.5, 2.5])
  if (cx > 2 && cx < 3.6 && cz > -5.5 && cz < 2.5 && Math.abs(n[0]) > 0.7 * area2) {
    facing.legB[n[0] > 0 ? "pos" : "neg"] += w;
  }
  // stubA: far-end return at x < -5.5, z > 3
  if (cx < -5.5 && cz > 3 && Math.abs(n[0]) > 0.7 * area2) {
    facing.stubA[n[0] > 0 ? "pos" : "neg"] += w;
  }
  // stubB: far-end return at z < -5.5, x > 3
  if (cz < -5.5 && cx > 3 && Math.abs(n[2]) > 0.7 * area2) {
    facing.stubB[n[2] > 0 ? "pos" : "neg"] += w;
  }
}
for (const [k, v] of Object.entries(facing)) {
  console.log(
    `FACING ${k}: toward+ ${v.pos.toFixed(1)} m^2, toward- ${v.neg.toFixed(1)} m^2`,
  );
}

// Wall-surface planes: for triangles whose normal is dominantly +/-x or +/-z,
// an area-weighted histogram (5 cm) of centroid position along that axis,
// with the tangent span of the dominant plane. Finds facade surfaces exactly.
for (const [axis, name] of [
  [0, "x"],
  [2, "z"],
]) {
  for (const dir of [1, -1]) {
    const hist = new Map();
    for (const [a, b, c] of tris) {
      const A = pts[a], B = pts[b], C = pts[c];
      const ab = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
      const ac = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
      const n = [
        ab[1] * ac[2] - ab[2] * ac[1],
        ab[2] * ac[0] - ab[0] * ac[2],
        ab[0] * ac[1] - ab[1] * ac[0],
      ];
      const area2 = Math.hypot(...n);
      if (area2 < 1e-6 || n[axis] * dir < 0.9 * area2) continue;
      const pos = (A[axis] + B[axis] + C[axis]) / 3;
      const k = Math.round(pos / 0.05);
      const t = axis === 0 ? 2 : 0;
      const e = hist.get(k) ?? { area: 0, lo: 1e9, hi: -1e9 };
      e.area += area2 / 2;
      for (const P of [A, B, C]) {
        if (P[t] < e.lo) e.lo = P[t];
        if (P[t] > e.hi) e.hi = P[t];
      }
      hist.set(k, e);
    }
    const entries = [...hist.entries()].sort((p, q) => q[1].area - p[1].area).slice(0, 5);
    console.log(`WALLS facing ${dir > 0 ? "+" : "-"}${name}:`);
    for (const [k, e] of entries.sort((p, q) => p[0] - q[0])) {
      console.log(
        `  ${name}=${(k * 0.05).toFixed(2)}  area=${e.area.toFixed(1)} m^2  span[${e.lo.toFixed(2)}, ${e.hi.toFixed(2)}]`,
      );
    }
  }
}
