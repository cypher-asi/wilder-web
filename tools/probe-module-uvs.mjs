// One-off probe: UV bounds per material of imported GLBs, to see whether
// untextured material regions carry usable UVs for texture wiring.
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
      const mat = prim.getMaterial();
      const uv = prim.getAttribute("TEXCOORD_0");
      if (!uv) {
        console.log(`${id} ${mat?.getName()} NO UVS`);
        continue;
      }
      const arr = uv.getArray();
      let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
      for (let i = 0; i < arr.length; i += 2) {
        minU = Math.min(minU, arr[i]); maxU = Math.max(maxU, arr[i]);
        minV = Math.min(minV, arr[i + 1]); maxV = Math.max(maxV, arr[i + 1]);
      }
      console.log(
        `${id} ${mat?.getName()} verts=${uv.getCount()} u[${minU.toFixed(2)},${maxU.toFixed(2)}] v[${minV.toFixed(2)},${maxV.toFixed(2)}]`,
      );
    }
  }
}
