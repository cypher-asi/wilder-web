// Debug utility: report where a facade GLB's geometry is concentrated along
// z, to tell which side the authored front wall is on (slices are U-shaped:
// the closed band holds most vertices).
//   node tools/asset-lab/probe-facing.mjs <assetId> [...]
import { NodeIO, getBounds } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { MeshoptDecoder } from "meshoptimizer";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  "meshopt.decoder": MeshoptDecoder,
});

for (const id of process.argv.slice(2)) {
  const file = path.join(ROOT, "assets", "models", "imported", `${id}.glb`);
  const doc = await io.read(file);
  const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];
  const b = getBounds(scene);
  const xMid = (b.min[0] + b.max[0]) / 2;
  const zMid = (b.min[2] + b.max[2]) / 2;
  let xn = 0;
  let xp = 0;
  let zn = 0;
  let zp = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute("POSITION");
      if (!pos) continue;
      const arr = pos.getArray();
      for (let i = 0; i < pos.getCount(); i++) {
        if (arr[i * 3] < xMid) xn++;
        else xp++;
        if (arr[i * 3 + 2] < zMid) zn++;
        else zp++;
      }
    }
  }
  console.log(
    `${id}  x: [${b.min[0].toFixed(2)}, ${b.max[0].toFixed(2)}] -x:${xn} +x:${xp}  z: [${b.min[2].toFixed(2)}, ${b.max[2].toFixed(2)}] -z:${zn} +z:${zp}`,
  );
}
