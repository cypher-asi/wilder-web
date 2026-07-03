// One-off probe: area-weighted triangle-normal distribution of an imported
// GLB in its own (glTF) frame, bucketed by which half of the plan the
// triangle sits in. Definitive check of which way L-corner facades face.
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { MeshoptDecoder } from "meshoptimizer";

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  "meshopt.decoder": MeshoptDecoder,
});

function axisOf(n) {
  const [ax, ay, az] = n.map(Math.abs);
  if (ay >= ax && ay >= az) return n[1] > 0 ? "+y" : "-y";
  if (ax >= az) return n[0] > 0 ? "+x" : "-x";
  return n[2] > 0 ? "+z" : "-z";
}

for (const id of process.argv.slice(2)) {
  const doc = await io.read(`assets/models/imported/${id}.glb`);
  const stats = new Map();
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute("POSITION");
      const idx = prim.getIndices();
      const count = idx ? idx.getCount() : pos.getCount();
      const get = (k) => pos.getElement(idx ? idx.getScalar(k) : k, []);
      for (let t = 0; t + 2 < count; t += 3) {
        const a = get(t), b = get(t + 1), c = get(t + 2);
        const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        const n = [
          u[1] * v[2] - u[2] * v[1],
          u[2] * v[0] - u[0] * v[2],
          u[0] * v[1] - u[1] * v[0],
        ];
        const area = Math.hypot(...n) / 2;
        if (area < 1e-6) continue;
        const cx = (a[0] + b[0] + c[0]) / 3;
        const cz = (a[2] + b[2] + c[2]) / 3;
        const region = `${cx > 0 ? "x+" : "x-"}${cz > 0 ? "z+" : "z-"}`;
        const key = `${region} ${axisOf(n)}`;
        stats.set(key, (stats.get(key) ?? 0) + area);
      }
    }
  }
  console.log(`== ${id}`);
  for (const [key, area] of [...stats.entries()].sort((p, q) => q[1] - p[1])) {
    console.log(`  ${key}: ${area.toFixed(2)} m2`);
  }
}
