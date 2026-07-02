// Game-ready pipeline for a single asset (run manually per item):
//   imported preview.glb
//     -> Blender deterministic processing (weld, decimate, normals, pivot)
//     -> glTF Transform (prune, dedup, texture resize + WebP, meshopt compression)
//     -> validation gates -> content/gameready/<kit>/<id>/<id>.glb + report.json
//
// CLI: node tools/asset-lab/optimize.mjs <assetId> [--category prop] [--decimate 0.5]
import { NodeIO, getBounds } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { dedup, flatten, join, meshopt, prune, textureCompress } from "@gltf-transform/functions";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MeshoptDecoder, MeshoptEncoder } from "meshoptimizer";
import sharp from "sharp";
import { importAsset, runBlender } from "./import.mjs";
import { GAMEREADY_DIR, IMPORTED_DIR } from "./paths.mjs";
import { resolveRecipe } from "./recipes.mjs";
import { loadRegistry, updateAsset } from "./registry.mjs";

async function createIO() {
  await MeshoptEncoder.ready;
  await MeshoptDecoder.ready;
  return new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ "meshopt.encoder": MeshoptEncoder, "meshopt.decoder": MeshoptDecoder });
}

function documentStats(doc) {
  const root = doc.getRoot();
  let triangles = 0;
  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const indices = prim.getIndices();
      const position = prim.getAttribute("POSITION");
      const count = indices ? indices.getCount() : position ? position.getCount() : 0;
      if (prim.getMode() === 4) triangles += Math.floor(count / 3);
    }
  }
  let maxTextureSize = 0;
  for (const tex of root.listTextures()) {
    const size = tex.getSize();
    if (size) maxTextureSize = Math.max(maxTextureSize, size[0], size[1]);
  }
  const scene = root.getDefaultScene() ?? root.listScenes()[0];
  const bounds = scene ? getBounds(scene) : { min: [0, 0, 0], max: [0, 0, 0] };
  return {
    triangles,
    materials: root.listMaterials().length,
    meshes: root.listMeshes().length,
    textures: root.listTextures().length,
    maxTextureSize,
    dimensions: bounds.max.map((v, i) => +(v - bounds.min[i]).toFixed(3)),
  };
}

export async function optimizeAsset(assetId, recipeOverrides = {}, { log = console.log } = {}) {
  const registry = loadRegistry();
  const asset = registry.assets[assetId];
  if (!asset) throw new Error(`Unknown asset: ${assetId}`);
  if (!["imported", "gameready", "promoted"].includes(asset.status)) {
    throw new Error(`Asset ${assetId} must be imported first (status: ${asset.status})`);
  }

  const recipe = resolveRecipe({ category: asset.category, ...recipeOverrides });
  const previewGlb = path.join(IMPORTED_DIR, asset.kit, assetId, "preview.glb");
  const outDir = path.join(GAMEREADY_DIR, asset.kit, assetId);
  const outGlb = path.join(outDir, `${assetId}.glb`);
  mkdirSync(outDir, { recursive: true });

  const work = path.join(tmpdir(), `assetlab_${assetId}_${Date.now()}`);
  mkdirSync(work, { recursive: true });
  const recipePath = path.join(work, "recipe.json");
  const blenderOut = path.join(work, "blender.glb");
  writeFileSync(recipePath, JSON.stringify(recipe, null, 2));

  updateAsset(assetId, { status: "optimizing", error: null });
  const startedAt = new Date().toISOString();
  try {
    // Stage 1: deterministic Blender processing.
    await runBlender(
      "optimize_asset.py",
      ["--in", previewGlb, "--out", blenderOut, "--recipe", recipePath, "--name", assetId],
      { log: () => {} },
    );

    // Stage 2: glTF Transform.
    const io = await createIO();
    const doc = await io.read(blenderOut);
    const beforeStats = documentStats(await io.read(previewGlb));

    await doc.transform(
      dedup(),
      flatten(),
      join(),
      prune(),
      textureCompress({
        encoder: sharp,
        targetFormat: "webp",
        resize: [recipe.texture_max_size, recipe.texture_max_size],
      }),
      meshopt({ encoder: MeshoptEncoder, level: "medium" }),
    );
    await io.write(outGlb, doc);

    // Stage 3: validation gates.
    const afterStats = documentStats(await io.read(outGlb));
    const checks = [];
    const check = (name, pass, detail) => checks.push({ name, pass, detail });

    check(
      "loads",
      afterStats.meshes > 0 && afterStats.triangles > 0,
      `${afterStats.meshes} meshes, ${afterStats.triangles} tris`,
    );
    check(
      "triangle_budget",
      afterStats.triangles <= recipe.max_triangles,
      `${afterStats.triangles} <= ${recipe.max_triangles}`,
    );
    check(
      "texture_budget",
      afterStats.maxTextureSize <= recipe.texture_max_size,
      `${afterStats.maxTextureSize}px <= ${recipe.texture_max_size}px`,
    );
    // Bounding box must match the source within 10% per axis (pivot moves are fine).
    const bboxOk = afterStats.dimensions.every((d, i) => {
      const src = beforeStats.dimensions[i];
      return src < 0.01 || Math.abs(d - src) / src < 0.1;
    });
    check(
      "bbox_tolerance",
      bboxOk,
      `${afterStats.dimensions.join("x")} vs source ${beforeStats.dimensions.join("x")}`,
    );

    const passed = checks.every((c) => c.pass);
    const report = {
      assetId,
      recipe,
      startedAt,
      finishedAt: new Date().toISOString(),
      passed,
      checks,
      before: { ...beforeStats, fileBytes: statSync(previewGlb).size },
      after: { ...afterStats, fileBytes: statSync(outGlb).size },
    };
    writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));

    updateAsset(assetId, {
      status: passed ? "gameready" : "imported",
      optimizedAt: report.finishedAt,
      recipe,
      report: {
        passed,
        before: report.before,
        after: report.after,
        checks,
      },
      error: passed ? null : "Validation failed: " + checks.filter((c) => !c.pass).map((c) => c.name).join(", "),
    });
    log(
      `${assetId}: ${passed ? "PASSED" : "FAILED"} ` +
        `(${report.before.triangles} -> ${report.after.triangles} tris, ` +
        `${(report.before.fileBytes / 1e6).toFixed(2)} -> ${(report.after.fileBytes / 1e6).toFixed(2)} MB)`,
    );
    return report;
  } catch (err) {
    updateAsset(assetId, { status: "imported", error: String(err.message ?? err) });
    throw err;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export { importAsset };

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const id = args.find((a) => !a.startsWith("--"));
  if (!id) {
    console.error("Usage: node optimize.mjs <assetId> [--category cat] [--decimate 0.5] [--texsize 1024]");
    process.exit(1);
  }
  const overrides = {};
  const flag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  if (flag("--category")) overrides.category = flag("--category");
  if (flag("--decimate")) overrides.decimate_ratio = Number(flag("--decimate"));
  if (flag("--texsize")) overrides.texture_max_size = Number(flag("--texsize"));
  optimizeAsset(id, overrides).catch((err) => {
    console.error(String(err.message ?? err));
    process.exit(1);
  });
}
