// Debug utility: dump game-space bounding boxes of promoted GLBs, so facade
// wall planes / pivot offsets can be derived without opening a DCC.
//   node tools/asset-lab/probe-bounds.mjs <assetId> [...]
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
  const f = (v) => v.map((n) => n.toFixed(3)).join(", ");
  console.log(`${id}\n  min: [${f(b.min)}]\n  max: [${f(b.max)}]`);
}
