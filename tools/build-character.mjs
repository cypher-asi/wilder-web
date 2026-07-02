// Builds assets/models/character.glb from the Quaternius Universal Animation
// Library (CC0). Downloads the free Standard zip (Godot GLB flavor, which is
// plain glTF and loads directly in three.js), strips the animation clips we
// don't ship, and writes the pruned GLB into the game asset tree.
//
// Usage: node tools/build-character.mjs [path-to-AnimationLibrary_Godot_Standard.glb]
// Without an argument the script downloads + extracts the zip into
// content/raw/ual/ (gitignored) and uses the GLB from there.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { prune } from "@gltf-transform/functions";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ZIP_URL =
  "https://opengameart.org/sites/default/files/universal_animation_librarystandard.zip";
const RAW_DIR = path.join(ROOT, "content", "raw", "ual");
const GLB_IN_ZIP = path.join(
  "Animation Library[Standard]",
  "Godot",
  "AnimationLibrary_Godot_Standard.glb",
);
const OUT_PATH = path.join(ROOT, "assets", "models", "character.glb");

/** Clips the game uses (see apps/web/src/render/Entities.tsx). */
const KEEP_CLIPS = new Set([
  "Idle_Loop",
  "Walk_Loop",
  "Jog_Fwd_Loop",
  "Sprint_Loop",
  "Pistol_Idle_Loop",
  "Pistol_Aim_Neutral",
  "Pistol_Shoot",
  "Pistol_Reload",
  "Roll",
  "Crouch_Idle_Loop",
  "Crouch_Fwd_Loop",
  "Punch_Jab",
  "Punch_Cross",
  "Hit_Chest",
  "Death01",
  "Interact",
]);

async function resolveSourceGlb() {
  const arg = process.argv[2];
  if (arg) return path.resolve(arg);

  const cached = path.join(RAW_DIR, GLB_IN_ZIP);
  if (fs.existsSync(cached)) return cached;

  fs.mkdirSync(RAW_DIR, { recursive: true });
  const zipPath = path.join(RAW_DIR, "ual_standard.zip");
  if (!fs.existsSync(zipPath)) {
    console.log(`downloading ${ZIP_URL}`);
    const res = await fetch(ZIP_URL, { headers: { "user-agent": "Mozilla/5.0" } });
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    fs.writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()));
  }
  console.log("extracting zip");
  if (process.platform === "win32") {
    execFileSync("powershell", [
      "-NoProfile",
      "-Command",
      `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${RAW_DIR}' -Force`,
    ]);
  } else {
    execFileSync("unzip", ["-o", zipPath, "-d", RAW_DIR]);
  }
  return cached;
}

const srcPath = await resolveSourceGlb();
console.log(`source: ${srcPath}`);

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(srcPath);
const root = doc.getRoot();

const all = root.listAnimations();
let kept = 0;
for (const anim of all) {
  if (KEEP_CLIPS.has(anim.getName())) {
    kept++;
  } else {
    // Channels/samplers are not disposed with the clip; drop them explicitly
    // so prune() can reclaim their (large) keyframe accessors.
    for (const channel of anim.listChannels()) channel.dispose();
    for (const sampler of anim.listSamplers()) sampler.dispose();
    anim.dispose();
  }
}
console.log(`animations: kept ${kept}/${all.length}`);

const missing = [...KEEP_CLIPS].filter(
  (name) => !root.listAnimations().some((a) => a.getName() === name),
);
if (missing.length > 0) {
  throw new Error(`missing expected clips: ${missing.join(", ")}`);
}

await doc.transform(prune());

fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
await io.write(OUT_PATH, doc);
const size = fs.statSync(OUT_PATH).size;
console.log(`wrote ${OUT_PATH} (${(size / 1024 / 1024).toFixed(2)} MB)`);
