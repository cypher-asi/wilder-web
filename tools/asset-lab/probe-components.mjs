// Debug utility: split a promoted GLB's primitives into connected components
// (by shared vertex positions) and print each component's game-space bounds,
// to locate stray pieces inside authored modules.
//   node tools/asset-lab/probe-components.mjs <assetId> [...]
import { NodeIO } from "@gltf-transform/core";
import { dequantize } from "@gltf-transform/functions";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { MeshoptDecoder } from "meshoptimizer";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  "meshopt.decoder": MeshoptDecoder,
});

class DSU {
  constructor(n) {
    this.p = new Int32Array(n);
    for (let i = 0; i < n; i++) this.p[i] = i;
  }
  find(a) {
    while (this.p[a] !== a) {
      this.p[a] = this.p[this.p[a]];
      a = this.p[a];
    }
    return a;
  }
  union(a, b) {
    this.p[this.find(a)] = this.find(b);
  }
}

for (const id of process.argv.slice(2)) {
  const file = path.join(ROOT, "assets", "models", "imported", `${id}.glb`);
  const doc = await io.read(file);
  await doc.transform(dequantize());
  console.log(id);
  // Bake node transforms so bounds are in game space.
  const worldByMesh = new Map();
  for (const node of doc.getRoot().listNodes()) {
    const m = node.getMesh();
    if (m) worldByMesh.set(m, node.getWorldMatrix());
  }
  const apply = (mtx, v) => {
    if (!mtx) return v;
    const [x, y, z] = v;
    return [
      mtx[0] * x + mtx[4] * y + mtx[8] * z + mtx[12],
      mtx[1] * x + mtx[5] * y + mtx[9] * z + mtx[13],
      mtx[2] * x + mtx[6] * y + mtx[10] * z + mtx[14],
    ];
  };
  for (const mesh of doc.getRoot().listMeshes()) {
    const world = worldByMesh.get(mesh);
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute("POSITION");
      const idx = prim.getIndices();
      if (!pos || !idx) continue;
      const n = pos.getCount();
      // Weld by quantized position so split vertices join components.
      const keyOf = new Map();
      const rep = new Int32Array(n);
      for (let i = 0; i < n; i++) {
        const e = pos.getElement(i, []);
        const k = e.map((v) => Math.round(v * 500)).join(",");
        if (keyOf.has(k)) rep[i] = keyOf.get(k);
        else {
          keyOf.set(k, i);
          rep[i] = i;
        }
      }
      const dsu = new DSU(n);
      const ind = idx.getArray();
      for (let t = 0; t < ind.length; t += 3) {
        dsu.union(rep[ind[t]], rep[ind[t + 1]]);
        dsu.union(rep[ind[t + 1]], rep[ind[t + 2]]);
      }
      const comps = new Map();
      for (let i = 0; i < n; i++) {
        const r = dsu.find(rep[i]);
        let c = comps.get(r);
        if (!c) {
          c = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], verts: 0 };
          comps.set(r, c);
        }
        const e = apply(world, pos.getElement(i, []));
        for (let a = 0; a < 3; a++) {
          if (e[a] < c.min[a]) c.min[a] = e[a];
          if (e[a] > c.max[a]) c.max[a] = e[a];
        }
        c.verts++;
      }
      const mat = prim.getMaterial()?.getName() ?? "?";
      const f = (v) => v.map((x) => x.toFixed(2)).join(",");
      console.log(`  prim mat=${mat} comps=${comps.size}`);
      const sorted = [...comps.values()].sort((a, b) => b.verts - a.verts);
      for (const c of sorted.slice(0, 24)) {
        console.log(`    ${c.verts}v min[${f(c.min)}] max[${f(c.max)}]`);
      }
    }
  }
}
