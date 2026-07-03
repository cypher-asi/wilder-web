// Debug utility: list each primitive of an imported preview GLB with its
// material name and bounds, to locate z-fighting / stray planes.
//   node tools/asset-lab/probe-submeshes.mjs <assetId> [...]
import { NodeIO } from "@gltf-transform/core";
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
  const file = path.join(ROOT, "content", "imported", "cyberpunk", id, "preview.glb");
  const doc = await io.read(file);
  console.log(id);
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute("POSITION");
      if (!pos) continue;
      const min = [Infinity, Infinity, Infinity];
      const max = [-Infinity, -Infinity, -Infinity];
      const arr = pos.getArray();
      for (let i = 0; i < pos.getCount(); i++) {
        for (let a = 0; a < 3; a++) {
          const v = arr[i * 3 + a];
          if (v < min[a]) min[a] = v;
          if (v > max[a]) max[a] = v;
        }
      }
      const f = (v) => v.map((n) => n.toFixed(2)).join(",");
      const mat = prim.getMaterial();
      console.log(
        `  ${mesh.getName()} · ${mat?.getName() ?? "?"} · ${pos.getCount()} verts · min[${f(min)}] max[${f(max)}] alpha=${mat?.getAlphaMode()}`,
      );
    }
  }
}
