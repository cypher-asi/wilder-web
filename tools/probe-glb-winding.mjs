// One-off probe: agreement between authored vertex normals and geometric
// (winding) normals per GLB. Disagreement means flipped winding or inverted
// normals from a mirrored FBX export.
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { MeshoptDecoder } from "meshoptimizer";

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  "meshopt.decoder": MeshoptDecoder,
});

for (const id of process.argv.slice(2)) {
  const doc = await io.read(`assets/models/imported/${id}.glb`);
  let agree = 0;
  let disagree = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute("POSITION");
      const nrm = prim.getAttribute("NORMAL");
      if (!nrm) continue;
      const idx = prim.getIndices();
      const count = idx ? idx.getCount() : pos.getCount();
      const gi = (k) => (idx ? idx.getScalar(k) : k);
      for (let t = 0; t + 2 < count; t += 3) {
        const ia = gi(t), ib = gi(t + 1), ic = gi(t + 2);
        const a = pos.getElement(ia, []), b = pos.getElement(ib, []), c = pos.getElement(ic, []);
        const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        const g = [
          u[1] * v[2] - u[2] * v[1],
          u[2] * v[0] - u[0] * v[2],
          u[0] * v[1] - u[1] * v[0],
        ];
        const n = nrm.getElement(ia, []);
        const dot = g[0] * n[0] + g[1] * n[1] + g[2] * n[2];
        if (dot > 0) agree++;
        else if (dot < 0) disagree++;
      }
    }
  }
  console.log(`${id}: winding agrees ${agree}, disagrees ${disagree}`);
}
