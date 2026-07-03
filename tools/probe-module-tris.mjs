// One-off probe: triangles per material in promoted GLBs.
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { MeshoptDecoder } from "meshoptimizer";

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  "meshopt.decoder": MeshoptDecoder,
});

for (const id of process.argv.slice(2)) {
  const doc = await io.read(`assets/models/imported/${id}.glb`);
  let total = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const idx = prim.getIndices();
      const tris = (idx ? idx.getCount() : prim.getAttribute("POSITION").getCount()) / 3;
      total += tris;
      const mat = prim.getMaterial();
      console.log(
        `${id} mat=${mat?.getName()} tris=${tris} textured=${!!mat?.getBaseColorTexture()}`,
      );
    }
  }
  console.log(`${id} total=${total}`);
}
