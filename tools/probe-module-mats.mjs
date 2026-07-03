// One-off probe: material properties of promoted GLBs.
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { MeshoptDecoder } from "meshoptimizer";

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  "meshopt.decoder": MeshoptDecoder,
});

for (const id of process.argv.slice(2)) {
  const doc = await io.read(`assets/models/imported/${id}.glb`);
  for (const mat of doc.getRoot().listMaterials()) {
    const bc = mat.getBaseColorFactor();
    console.log(
      `${id} ${mat.getName()} baseColor=[${bc.map((v) => v.toFixed(3)).join(",")}] metal=${mat.getMetallicFactor()} rough=${mat.getRoughnessFactor()} baseTex=${!!mat.getBaseColorTexture()} normTex=${!!mat.getNormalTexture()} mrTex=${!!mat.getMetallicRoughnessTexture()}`,
    );
  }
}
