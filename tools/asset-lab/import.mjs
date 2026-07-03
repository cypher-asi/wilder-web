// Import worker: runs Blender headless on one raw FBX, producing
// content/imported/<kit>/<id>/{preview.glb, thumbs/, meta.json} and updating
// the registry. Exported for the lab server; runnable from the CLI:
//
//   node tools/asset-lab/import.mjs <assetId> [<assetId> ...]
//   node tools/asset-lab/import.mjs --count 25   (first N raw assets)
//   node tools/asset-lab/import.mjs --all [--parallel 8]   (every raw asset)
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BLENDER_SCRIPTS_DIR, IMPORTED_DIR, RAW_DIR, findBlender } from "./paths.mjs";
import { loadRegistry, updateAsset } from "./registry.mjs";

function runBlender(scriptName, scriptArgs, { log = () => {} } = {}) {
  const blender = findBlender();
  const args = [
    "-b",
    "--factory-startup",
    "-P",
    path.join(BLENDER_SCRIPTS_DIR, scriptName),
    "--",
    ...scriptArgs,
  ];
  return new Promise((resolve, reject) => {
    const proc = spawn(blender, args, { windowsHide: true });
    let out = "";
    const onData = (chunk) => {
      const text = chunk.toString();
      out += text;
      log(text);
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0 && out.includes("ASSETLAB_OK")) resolve(out);
      else reject(new Error(`Blender ${scriptName} failed (exit ${code}):\n${out.slice(-2000)}`));
    });
  });
}

export { runBlender };

export async function importAsset(assetId, { log = console.log } = {}) {
  const registry = loadRegistry();
  const asset = registry.assets[assetId];
  if (!asset) throw new Error(`Unknown asset: ${assetId}`);

  const kitDir = path.join(RAW_DIR, asset.kit);
  const fbxPath = path.join(kitDir, asset.sourcePath);
  if (!existsSync(fbxPath)) throw new Error(`Source FBX missing: ${fbxPath}`);

  // Kit textures live in a sibling Textures/ dir next to the Meshes/ dir.
  const texturesDir = path.join(path.dirname(fbxPath), "..", "Textures");
  const outDir = path.join(IMPORTED_DIR, asset.kit, assetId);
  mkdirSync(outDir, { recursive: true });

  updateAsset(assetId, { status: "importing", error: null });
  try {
    await runBlender(
      "import_asset.py",
      [
        "--fbx", fbxPath,
        "--textures-dir", texturesDir,
        "--out-dir", outDir,
        "--name", asset.name,
      ],
      { log },
    );
    const meta = JSON.parse(readFileSync(path.join(outDir, "meta.json"), "utf8"));
    // Re-imports must not demote assets that already have derivatives.
    const current = loadRegistry().assets[assetId];
    const status =
      current.status === "promoted"
        ? "promoted"
        : (current.variants ?? []).some((v) => v.passed)
          ? "gameready"
          : "imported";
    return updateAsset(assetId, {
      status,
      importedAt: new Date().toISOString(),
      meta,
      error: null,
    });
  } catch (err) {
    const current = loadRegistry().assets[assetId];
    updateAsset(assetId, {
      status: current.meta ? "imported" : "raw",
      error: String(err.message ?? err),
    });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  let ids = [];
  const countIdx = args.indexOf("--count");
  if (args.includes("--all")) {
    const registry = loadRegistry();
    ids = Object.values(registry.assets)
      .filter((a) => a.status === "raw")
      .map((a) => a.id);
  } else if (countIdx >= 0) {
    const n = Number(args[countIdx + 1] ?? 10);
    const registry = loadRegistry();
    ids = Object.values(registry.assets)
      .filter((a) => a.status === "raw")
      .slice(0, n)
      .map((a) => a.id);
  } else {
    ids = args.filter((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--parallel");
  }
  if (ids.length === 0) {
    console.error("Usage: node import.mjs <assetId>... | --count N | --all [--parallel N]");
    process.exit(1);
  }

  const parallelIdx = args.indexOf("--parallel");
  const parallel = Math.max(1, Number(parallelIdx >= 0 ? args[parallelIdx + 1] : 1) || 1);

  let done = 0;
  let failed = 0;
  const total = ids.length;
  const queue = [...ids];

  async function worker() {
    for (;;) {
      const id = queue.shift();
      if (!id) return;
      try {
        const asset = await importAsset(id, { log: () => {} });
        done++;
        console.log(
          `[${done + failed}/${total}] ok ${id}: ${asset.meta.triangles} tris, ` +
            `${asset.meta.material_count} materials, ${asset.meta.dimensions_m.join(" x ")} m`,
        );
        const untextured = asset.meta.untextured_materials ?? [];
        if (untextured.length > 0) {
          console.warn(`  WARN ${id}: untextured materials: ${untextured.join(", ")}`);
        }
      } catch (err) {
        failed++;
        console.error(
          `[${done + failed}/${total}] FAILED ${id}: ${String(err.message ?? err).split("\n")[0]}`,
        );
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(parallel, total) }, worker));
  console.log(`\nDone: ${done}/${total} imported, ${failed} failed.`);
  process.exit(failed > 0 ? 1 : 0);
}
