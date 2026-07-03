// Lists every animation clip name in the Quaternius UAL source GLB.
// Downloads/caches the pack the same way build-character.mjs does.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ZIP_URL =
  "https://opengameart.org/sites/default/files/universal_animation_librarystandard.zip";
const RAW_DIR = path.join(ROOT, "content", "raw", "ual");
const GLB_IN_ZIP = path.join(
  "Animation Library[Standard]",
  "Godot",
  "AnimationLibrary_Godot_Standard.glb",
);

const cached = path.join(RAW_DIR, GLB_IN_ZIP);
if (!fs.existsSync(cached)) {
  fs.mkdirSync(RAW_DIR, { recursive: true });
  const zipPath = path.join(RAW_DIR, "ual_standard.zip");
  if (!fs.existsSync(zipPath)) {
    console.log(`downloading ${ZIP_URL}`);
    const res = await fetch(ZIP_URL, { headers: { "user-agent": "Mozilla/5.0" } });
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    fs.writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()));
  }
  console.log("extracting zip");
  execFileSync("powershell", [
    "-NoProfile",
    "-Command",
    `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${RAW_DIR}' -Force`,
  ]);
}

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(cached);
for (const anim of doc.getRoot().listAnimations()) {
  console.log(anim.getName());
}
