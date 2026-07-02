// Asset registry: a single JSON index over content/{raw,imported,gameready}.
// Entries move through a status lifecycle: raw -> imported -> gameready -> promoted.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CONTENT_DIR, REGISTRY_PATH } from "./paths.mjs";

export function loadRegistry() {
  try {
    return JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));
  } catch {
    return { version: 1, updatedAt: null, assets: {} };
  }
}

export function saveRegistry(registry) {
  registry.updatedAt = new Date().toISOString();
  mkdirSync(CONTENT_DIR, { recursive: true });
  // Atomic-ish write so a crashed pipeline run can't corrupt the index.
  const tmp = REGISTRY_PATH + ".tmp";
  writeFileSync(tmp, JSON.stringify(registry, null, 2));
  renameSync(tmp, REGISTRY_PATH);
}

export function updateAsset(id, patch) {
  const registry = loadRegistry();
  const existing = registry.assets[id];
  if (!existing) throw new Error(`Asset not in registry: ${id}`);
  registry.assets[id] = { ...existing, ...patch };
  saveRegistry(registry);
  return registry.assets[id];
}

/** Derive a stable asset id from an FBX filename, e.g. SM_Barrier01.FBX -> sm_barrier01 */
export function assetIdFromFile(file) {
  return path
    .basename(file)
    .replace(/\.[^.]+$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Rough category guess from the mesh name. Only a hint for picking a recipe
 * preset; the human (or later, an AI classifier) can override in the UI.
 */
export function guessCategory(name) {
  const n = name.toLowerCase();
  if (/billboard|sign|neon|adv|holo|banner/.test(n)) return "sign_emissive";
  if (/bld|building|skyscraper|tower|facade|house/.test(n)) return "building_background";
  if (/car|vehicle|truck|van|bike|drone/.test(n)) return "vehicle";
  if (/road|street|sidewalk|curb|ground|floor|tile/.test(n)) return "road_module";
  return "prop";
}
