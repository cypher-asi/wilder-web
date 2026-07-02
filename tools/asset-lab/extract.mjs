// One-shot: extract the purchased RAR into content/raw/<kit> (if not already
// extracted) and seed the registry with every discovered FBX as status "raw".
//
// Usage: node tools/asset-lab/extract.mjs [--rar <path>] [--kit cyberpunk]
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { RAW_DIR, REPO_ROOT, findSevenZip } from "./paths.mjs";
import { assetIdFromFile, guessCategory, loadRegistry, saveRegistry } from "./registry.mjs";

const args = process.argv.slice(2);
function argValue(flag, fallback) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : fallback;
}

const kit = argValue("--kit", "cyberpunk");
const rarPath = argValue(
  "--rar",
  path.join(REPO_ROOT, "assets", "purchased", "uploads_files_2717631_Cyberpunk_All_Meshes.rar"),
);
const kitDir = path.join(RAW_DIR, kit);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const alreadyExtracted =
  existsSync(kitDir) && walk(kitDir).some((f) => f.toLowerCase().endsWith(".fbx"));

if (!alreadyExtracted) {
  if (!existsSync(rarPath)) {
    console.error(`Archive not found: ${rarPath}`);
    process.exit(1);
  }
  mkdirSync(kitDir, { recursive: true });
  console.log(`Extracting ${path.basename(rarPath)} -> ${kitDir} ...`);
  const res = spawnSync(findSevenZip(), ["x", rarPath, `-o${kitDir}`, "-y"], { stdio: "inherit" });
  if (res.status !== 0) {
    console.error("Extraction failed.");
    process.exit(1);
  }
} else {
  console.log(`Already extracted: ${kitDir}`);
}

// Seed the registry from every FBX under the kit dir.
const registry = loadRegistry();
let added = 0;
for (const file of walk(kitDir)) {
  if (!file.toLowerCase().endsWith(".fbx")) continue;
  const id = assetIdFromFile(file);
  if (registry.assets[id]) continue;
  const rel = path.relative(kitDir, file).replaceAll("\\", "/");
  registry.assets[id] = {
    id,
    name: path.basename(file).replace(/\.[^.]+$/, ""),
    kit,
    sourcePath: rel,
    sourceSizeBytes: statSync(file).size,
    category: guessCategory(path.basename(file)),
    status: "raw",
    discoveredAt: new Date().toISOString(),
  };
  added++;
}
saveRegistry(registry);
console.log(`Registry: ${Object.keys(registry.assets).length} assets (${added} newly added).`);
