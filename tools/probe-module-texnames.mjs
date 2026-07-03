// One-off probe: per-material texture image names/sizes in a promoted GLB.
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { MeshoptDecoder } from "meshoptimizer";

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  "meshopt.decoder": MeshoptDecoder,
});

for (const id of process.argv.slice(2)) {
  const doc = await io.read(`assets/models/imported/${id}.glb`);
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const idx = prim.getIndices();
      const tris = (idx ? idx.getCount() : prim.getAttribute("POSITION").getCount()) / 3;
      const mat = prim.getMaterial();
      const tex = mat?.getBaseColorTexture();
      const size = tex?.getSize();
      console.log(
        `${id} ${mat?.getName()} tris=${tris} baseTex=${tex?.getName() || tex?.getURI() || (tex ? "unnamed" : "none")} size=${size ? size.join("x") : "-"}`,
      );
    }
  }
}
