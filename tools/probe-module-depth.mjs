// One-off probe: histogram of vertex depth (z) for skyscraper facade modules
// to find where the wall slab sits vs how far greebles protrude.
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { MeshoptDecoder } from "meshoptimizer";

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  "meshopt.decoder": MeshoptDecoder,
});

for (const id of process.argv.slice(2)) {
  const doc = await io.read(`assets/models/imported/${id}.glb`);
  const root = doc.getRoot();
  let min = [1e9, 1e9, 1e9];
  let max = [-1e9, -1e9, -1e9];
  const zs = [];
  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute("POSITION");
      const arr = pos.getArray();
      const matName = prim.getMaterial()?.getName() ?? "?";
      let pmin = [1e9, 1e9, 1e9];
      let pmax = [-1e9, -1e9, -1e9];
      for (let i = 0; i < arr.length; i += 3) {
        for (let a = 0; a < 3; a++) {
          const v = arr[i + a];
          if (v < min[a]) min[a] = v;
          if (v > max[a]) max[a] = v;
          if (v < pmin[a]) pmin[a] = v;
          if (v > pmax[a]) pmax[a] = v;
        }
        zs.push(arr[i + 2]);
      }
      console.log(
        `${id} prim mat=${matName} x[${pmin[0].toFixed(2)},${pmax[0].toFixed(2)}] y[${pmin[1].toFixed(2)},${pmax[1].toFixed(2)}] z[${pmin[2].toFixed(2)},${pmax[2].toFixed(2)}]`,
      );
    }
  }
  console.log(`${id} bbox x[${min[0].toFixed(2)},${max[0].toFixed(2)}] y[${min[1].toFixed(2)},${max[1].toFixed(2)}] z[${min[2].toFixed(2)},${max[2].toFixed(2)}]`);
  // z histogram in 0.25m buckets
  const lo = min[2];
  const buckets = new Map();
  for (const z of zs) {
    const b = Math.floor((z - lo) / 0.25);
    buckets.set(b, (buckets.get(b) ?? 0) + 1);
  }
  const keys = [...buckets.keys()].sort((a, b) => a - b);
  for (const k of keys) {
    const from = (lo + k * 0.25).toFixed(2);
    console.log(`  z ${from}: ${"#".repeat(Math.min(80, Math.ceil(buckets.get(k) / 20)))} (${buckets.get(k)})`);
  }
}
