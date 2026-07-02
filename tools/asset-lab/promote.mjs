// Promote a game-ready asset into the live game assets tree:
// copies the optimized GLB to assets/models/imported/ and registers it in
// assets/manifest.json so the game catalog can load it by id.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GAMEREADY_DIR, GAME_IMPORTED_MODELS_DIR, GAME_MANIFEST_PATH } from "./paths.mjs";
import { loadRegistry, updateAsset } from "./registry.mjs";

export function promoteAsset(assetId, variantId = null) {
  const registry = loadRegistry();
  const asset = registry.assets[assetId];
  if (!asset) throw new Error(`Unknown asset: ${assetId}`);

  const variants = asset.variants ?? [];
  const variant = variantId
    ? variants.find((v) => v.id === variantId)
    : [...variants].reverse().find((v) => v.passed);
  if (!variant) {
    throw new Error(
      variantId
        ? `Variant ${variantId} not found for ${assetId}`
        : `No passing derivative for ${assetId} — run the game-ready pipeline first`,
    );
  }
  if (!variant.passed) {
    throw new Error(`Variant ${variant.id} of ${assetId} failed validation; cannot promote`);
  }

  const srcGlb = path.join(GAMEREADY_DIR, asset.kit, assetId, variant.id, `${assetId}.glb`);
  if (!existsSync(srcGlb)) throw new Error(`Optimized GLB missing: ${srcGlb}`);

  mkdirSync(GAME_IMPORTED_MODELS_DIR, { recursive: true });
  copyFileSync(srcGlb, path.join(GAME_IMPORTED_MODELS_DIR, `${assetId}.glb`));

  const manifest = JSON.parse(readFileSync(GAME_MANIFEST_PATH, "utf8"));
  const entryId = `lab_${assetId}`;
  const entry = {
    id: entryId,
    path: `models/imported/${assetId}.glb`,
    type: "model",
    license: `Purchased (${asset.kit} kit)`,
  };
  const existing = manifest.findIndex((e) => e.id === entryId);
  if (existing >= 0) manifest[existing] = entry;
  else manifest.push(entry);
  writeFileSync(GAME_MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n");

  return updateAsset(assetId, {
    status: "promoted",
    promotedAt: new Date().toISOString(),
    promotedVariant: variant.id,
    manifestId: entryId,
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const id = process.argv[2];
  if (!id) {
    console.error("Usage: node promote.mjs <assetId> [variantId]");
    process.exit(1);
  }
  const asset = promoteAsset(id, process.argv[3] ?? null);
  console.log(
    `Promoted ${id} (${asset.promotedVariant}) -> assets/models/imported/${id}.glb (manifest id: ${asset.manifestId})`,
  );
}
