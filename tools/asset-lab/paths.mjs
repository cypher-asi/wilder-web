// Shared paths + tool discovery for the Asset Lab pipeline.
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const CONTENT_DIR = path.join(REPO_ROOT, "content");
export const RAW_DIR = path.join(CONTENT_DIR, "raw");
export const IMPORTED_DIR = path.join(CONTENT_DIR, "imported");
export const GAMEREADY_DIR = path.join(CONTENT_DIR, "gameready");
export const REGISTRY_PATH = path.join(CONTENT_DIR, "registry.json");

export const GAME_ASSETS_DIR = path.join(REPO_ROOT, "assets");
export const GAME_MANIFEST_PATH = path.join(GAME_ASSETS_DIR, "manifest.json");
export const GAME_IMPORTED_MODELS_DIR = path.join(GAME_ASSETS_DIR, "models", "imported");

export const BLENDER_SCRIPTS_DIR = path.join(REPO_ROOT, "tools", "asset-lab", "blender");

/** Locate blender.exe: BLENDER env var, PATH, or the default winget install dir. */
export function findBlender() {
  if (process.env.BLENDER && existsSync(process.env.BLENDER)) return process.env.BLENDER;
  const roots = [
    "C:\\Program Files\\Blender Foundation",
    `${process.env.LOCALAPPDATA}\\Programs\\Blender Foundation`,
  ];
  const candidates = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const dir of readdirSync(root)) {
      const exe = path.join(root, dir, "blender.exe");
      if (existsSync(exe)) candidates.push(exe);
    }
  }
  // Prefer the highest version (directory names sort like "Blender 4.5").
  candidates.sort().reverse();
  if (candidates.length > 0) return candidates[0];
  throw new Error("blender.exe not found. Install Blender or set the BLENDER env var.");
}

export function findSevenZip() {
  const candidates = [
    process.env.SEVENZIP,
    "C:\\Program Files\\7-Zip\\7z.exe",
    "C:\\Program Files (x86)\\7-Zip\\7z.exe",
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error("7z.exe not found. Install 7-Zip or set the SEVENZIP env var.");
}
