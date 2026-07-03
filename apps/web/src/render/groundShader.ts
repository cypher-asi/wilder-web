// Ground shader: extends MeshStandardMaterial (so lights/shadows/fog keep
// working) with per-tile-kind PBR texturing and world-space procedural detail:
// cracks, oil stains, asphalt patches, puddles, sidewalk expansion joints, and
// grime. Road proximity comes from the aRoadD vertex attribute (signed meters
// to the road network, baked from the city tile grid in Ground.tsx).

import * as THREE from "three";
import { getPbrTextureSet } from "../assets/catalog";

function solidTex(r: number, g: number, b: number, srgb = false): THREE.DataTexture {
  const tex = new THREE.DataTexture(new Uint8Array([r, g, b, 255]), 1, 1);
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

// Note: the "sidewalk" folder (small-format pavers) aliases badly at sidewalk
// scale, so concrete drives sidewalks and the pavers dress plaza tiles at a
// larger repeat where they stay readable.
const TEXTURE_SETS = [
  ["asphalt", "Asphalt"],
  ["sidewalk", "Pavers"],
  ["concrete", "Concrete"],
  ["grass", "Grass"],
] as const;

const uniforms: Record<string, THREE.IUniform> = {};
for (const [, p] of TEXTURE_SETS) {
  uniforms[`u${p}Map`] = { value: solidTex(90, 90, 96, true) };
  uniforms[`u${p}Normal`] = { value: solidTex(128, 128, 255) };
  uniforms[`u${p}Rough`] = { value: solidTex(170, 170, 170) };
}
for (const [name, p] of TEXTURE_SETS) {
  void getPbrTextureSet(name).then((set) => {
    if (!set) return;
    // Max anisotropy: these tile at grazing isometric angles and shimmer at 8.
    for (const tex of [set.map, set.normalMap, set.roughnessMap]) {
      tex.anisotropy = 16;
      tex.needsUpdate = true;
    }
    uniforms[`u${p}Map`].value = set.map;
    uniforms[`u${p}Normal`].value = set.normalMap;
    uniforms[`u${p}Rough`].value = set.roughnessMap;
  });
}

const VERT_DECLS = /* glsl */ `
#include <common>
attribute float aKind;
attribute float aRoadD;
varying float vKind;
varying float vRoadD;
varying vec3 vWPos;
varying vec3 vWNormal;
`;

const VERT_MAIN = /* glsl */ `
#include <fog_vertex>
vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
vWNormal = normalize(mat3(modelMatrix) * objectNormal);
vKind = aKind;
vRoadD = aRoadD;
`;

const FRAG_DECLS = /* glsl */ `
#include <common>
varying float vKind;
varying float vRoadD;
varying vec3 vWPos;
varying vec3 vWNormal;
uniform sampler2D uAsphaltMap;
uniform sampler2D uAsphaltNormal;
uniform sampler2D uAsphaltRough;
uniform sampler2D uPaversMap;
uniform sampler2D uPaversNormal;
uniform sampler2D uPaversRough;
uniform sampler2D uConcreteMap;
uniform sampler2D uConcreteNormal;
uniform sampler2D uConcreteRough;
uniform sampler2D uGrassMap;
uniform sampler2D uGrassNormal;
uniform sampler2D uGrassRough;

float gHash12(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}
vec2 gHash22(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yzx + 33.33);
  return fract((q.xx + q.yz) * q.zy);
}
float gNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(gHash12(i), gHash12(i + vec2(1.0, 0.0)), u.x),
    mix(gHash12(i + vec2(0.0, 1.0)), gHash12(i + vec2(1.0, 1.0)), u.x),
    u.y);
}
float gFbm(vec2 p) {
  float a = 0.5;
  float s = 0.0;
  for (int i = 0; i < 3; i++) { s += a * gNoise(p); p *= 2.03; a *= 0.5; }
  return s;
}
// Distance between the two nearest voronoi features: thin near cell edges.
float gVoroEdge(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float f1 = 8.0;
  float f2 = 8.0;
  for (int y = -1; y <= 1; y++)
  for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(float(x), float(y));
    float d = length(g + gHash22(i + g) - f);
    if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) { f2 = d; }
  }
  return f2 - f1;
}
// Triplanar sampling: top projection at sTop meters, vertical faces at sSide
// (curb faces are only 0.14 m tall, so they need a much finer repeat).
// Weights come from the sharpened geometric normal, so bevels blend smoothly
// instead of flipping projection at a threshold.
vec3 gTriRGB(sampler2D t, vec3 wp, vec3 w, float sTop, float sSide) {
  return texture2D(t, vec2(wp.z, -wp.y) / sSide).rgb * w.x
       + texture2D(t, wp.xz / sTop).rgb * w.y
       + texture2D(t, vec2(wp.x, -wp.y) / sSide).rgb * w.z;
}
float gTriR(sampler2D t, vec3 wp, vec3 w, float sTop, float sSide) {
  return texture2D(t, vec2(wp.z, -wp.y) / sSide).r * w.x
       + texture2D(t, wp.xz / sTop).r * w.y
       + texture2D(t, vec2(wp.x, -wp.y) / sSide).r * w.z;
}
vec2 gTriRG(sampler2D t, vec3 wp, vec3 w, float sTop, float sSide) {
  return texture2D(t, vec2(wp.z, -wp.y) / sSide).rg * w.x
       + texture2D(t, wp.xz / sTop).rg * w.y
       + texture2D(t, vec2(wp.x, -wp.y) / sSide).rg * w.z;
}
// Sparse round spots (drips, gum): 1 inside a spot, 0 outside. cellW meters
// per cell, chance of a spot per cell, radius as a fraction of the cell.
float gSpots(vec2 wp, float cellW, float chance, float radius) {
  vec2 cell = floor(wp / cellW);
  vec2 h = gHash22(cell + 3.1);
  if (h.x > chance) return 0.0;
  vec2 center = (cell + 0.25 + 0.5 * gHash22(cell + 7.9)) * cellW;
  float r = radius * cellW * (0.6 + 0.8 * h.y);
  return 1.0 - smoothstep(r * 0.6, r, length(wp - center));
}
`;

// Main surface computation. Declares gRgh / gWN at main() scope so the
// roughness and normal injection points below can consume them.
const FRAG_GROUND = /* glsl */ `
vec3 wp = vWPos;
int gKind = int(vKind + 0.5);
vec3 gGeoN = normalize(vWNormal);
float gUp = clamp(gGeoN.y, 0.0, 1.0);
// Triplanar weights, sharpened so flat areas stay a clean top projection but
// the 45-degree curb bevels blend continuously (no seam or projection flip).
vec3 gW = pow(abs(gGeoN), vec3(4.0));
gW /= gW.x + gW.y + gW.z;
// Curb-face factor: vertical, road-adjacent faces are emitted as kind 1.
float gVert = 1.0 - gW.y;

// Distance to the nearest road surface (0 on roads) -> grime deep in blocks.
float gDistRoad = max(vRoadD, 0.0);

// Distance to the road edge, for fragments on the road (gutter zone).
float gNearC = 1.0 - smoothstep(0.2, 2.6, max(-vRoadD, 0.0));

vec3 gAlb;
float gRgh;
vec2 gNrm2 = vec2(0.0);
float gNStr = 0.0;
if (gKind == 0) {
  gAlb = gTriRGB(uAsphaltMap, wp, gW, 3.6, 3.6) * 1.2;
  gRgh = clamp(gTriR(uAsphaltRough, wp, gW, 3.6, 3.6) * 0.5 + 0.03, 0.1, 0.6);
  gNrm2 = gTriRG(uAsphaltNormal, wp, gW, 3.6, 3.6) * 2.0 - 1.0;
  gNStr = 0.45;
} else if (gKind == 1) {
  // Sidewalk: smooth concrete slabs (pavers alias into speckle at this
  // scale). Curb faces sample at a ~0.9 m repeat: they are 0.14 m tall and
  // the slab-scale repeat smears into an untextured band.
  gAlb = gTriRGB(uConcreteMap, wp, gW, 3.5, 0.9) * 1.25;
  // Per-slab value variation on the 2 m joint grid so slabs read individually.
  gAlb *= 0.92 + 0.16 * gHash12(floor(wp.xz / 2.0));
  gRgh = clamp(gTriR(uConcreteRough, wp, gW, 3.5, 0.9) * 0.6 + 0.12, 0.25, 0.85);
  gNrm2 = gTriRG(uConcreteNormal, wp, gW, 3.5, 0.9) * 2.0 - 1.0;
  gNStr = 0.25;
  // Poured-curb segment joints every 3 m along the street on curb faces.
  if (gVert > 0.25) {
    float along = gW.x > gW.z ? wp.z : wp.x;
    float distJoint = (0.5 - abs(fract(along / 3.0) - 0.5)) * 3.0;
    float joint = 1.0 - smoothstep(0.015, 0.05, distJoint);
    gAlb *= 1.0 - 0.45 * joint * gVert;
    gRgh = mix(gRgh, min(gRgh + 0.2, 1.0), joint * gVert);
  }
} else if (gKind == 2) {
  // Plaza: large concrete slabs on the 4 m joint grid, a shade darker than
  // sidewalks. (Photo pavers alias into pixel speckle at this camera.)
  gAlb = gTriRGB(uConcreteMap, wp, gW, 4.2, 0.9) * 0.95;
  gAlb *= 0.9 + 0.2 * gHash12(floor(wp.xz / 4.0) + 11.0);
  gRgh = clamp(gTriR(uConcreteRough, wp, gW, 4.2, 0.9) * 0.6 + 0.12, 0.25, 0.85);
  gNrm2 = gTriRG(uConcreteNormal, wp, gW, 4.2, 0.9) * 2.0 - 1.0;
  gNStr = 0.25;
} else if (gKind == 3) {
  gAlb = gTriRGB(uConcreteMap, wp, gW, 3.0, 0.9) * 0.55;
  gRgh = clamp(gTriR(uConcreteRough, wp, gW, 3.0, 0.9) * 0.55 + 0.12, 0.2, 0.8);
  gNrm2 = gTriRG(uConcreteNormal, wp, gW, 3.0, 0.9) * 2.0 - 1.0;
  gNStr = 0.4;
} else if (gKind == 4) {
  gAlb = gTriRGB(uGrassMap, wp, gW, 2.6, 2.6) * 0.8;
  gRgh = 0.9;
  gNrm2 = gTriRG(uGrassNormal, wp, gW, 2.6, 2.6) * 2.0 - 1.0;
  gNStr = 0.6;
} else {
  gAlb = vec3(0.012, 0.028, 0.042);
  gRgh = 0.05;
}

// Large-scale mottle so big surfaces don't read flat in low sun.
gAlb *= 0.85 + 0.35 * gFbm(wp.xz * 0.06 + 7.7);

// Dirt blotches on walkable concrete (boot traffic, weathering).
if (gKind == 1 || gKind == 2 || gKind == 3) {
  float dirt = smoothstep(0.45, 0.75, gFbm(wp.xz * 0.22 + 61.3));
  gAlb *= 1.0 - 0.3 * dirt;
}

// Sidewalk expansion joints on the 2 m tile grid; plaza slabs every 4 m.
if (gUp > 0.5 && (gKind == 1 || gKind == 2)) {
  float pitch = gKind == 1 ? 2.0 : 4.0;
  vec2 cell = abs(fract(wp.xz / pitch) - 0.5) * 2.0;
  float lineD = (1.0 - max(cell.x, cell.y)) * pitch * 0.5; // meters to joint
  float joint = 1.0 - smoothstep(0.015, 0.05, lineD);
  gAlb *= 1.0 - 0.5 * joint;
  gRgh = mix(gRgh, min(gRgh + 0.25, 1.0), joint);
}

// Cracks: voronoi edges gated by a sparse density mask, denser near curbs.
float gCrackLine = 1.0 - smoothstep(0.015, 0.045, gVoroEdge(wp.xz * 0.45));
float gCrackDen = smoothstep(0.58, 0.85, gFbm(wp.xz * 0.09 + 17.0));
float gCrack = 0.0;
if (gKind == 0) {
  gCrack = gCrackLine * clamp(gCrackDen + gNearC * 0.3, 0.0, 1.0);
} else if (gKind <= 2) {
  gCrack = gCrackLine * clamp(gCrackDen * 0.6 + (1.0 - smoothstep(0.1, 1.0, gDistRoad)) * 0.25, 0.0, 1.0) * 0.7;
}
gAlb *= 1.0 - 0.4 * gCrack;
gRgh = mix(gRgh, min(gRgh + 0.15, 1.0), gCrack);

// Road surface life: tire wear, tar seams, stains, patches, damp sheen.
if (gKind == 0) {
  float dCurb = max(-vRoadD, 0.0);

  // Tire-wear tracks: two polished strips per 3.5 m lane, measured from the
  // curb (approximates the lane module without knowing the road layout).
  float lf = fract((dCurb - 0.9) / 3.5);
  float track = max(
    1.0 - smoothstep(0.05, 0.17, abs(lf - 0.27)),
    1.0 - smoothstep(0.05, 0.17, abs(lf - 0.73)));
  track *= smoothstep(0.5, 1.4, dCurb);
  track *= 0.55 + 0.45 * gFbm(wp.xz * 0.11 + 41.0);
  gAlb *= 1.0 - 0.32 * track;
  gRgh = mix(gRgh, gRgh * 0.55, track);

  // Tar crack-seal: dark glossy snaking lines, sparser than the crack field.
  float tarLine = 1.0 - smoothstep(0.05, 0.15, gVoroEdge(wp.xz * 0.17 + 5.0));
  float tar = tarLine * smoothstep(0.52, 0.72, gFbm(wp.xz * 0.05 + 130.0));
  gAlb = mix(gAlb, vec3(0.016, 0.016, 0.018), 0.7 * tar);
  gRgh = mix(gRgh, 0.28, tar);

  // Oil stains: dark, glossier, biased toward lane centers and the gutter.
  float oil = smoothstep(0.56, 0.78, gFbm(wp.xz * 0.14 + 31.7) + gNearC * 0.05);
  gAlb *= 1.0 - 0.28 * oil;
  gRgh = mix(gRgh, gRgh * 0.5, oil);

  // Drip spots (engine drips, gum, rust runoff) scattered mid-lane.
  float drip = gSpots(wp.xz, 1.7, 0.1, 0.28);
  gAlb *= 1.0 - 0.22 * drip;
  gRgh = mix(gRgh, gRgh * 0.75, drip);

  // Drainage fans: broad wet-dirt stains spreading from the curb line.
  float fan = gNearC * smoothstep(0.42, 0.72, gFbm(wp.xz * 0.3 + 77.0));
  gAlb *= 1.0 - 0.18 * fan;

  // Repair patches: lighter fresh asphalt with a dark sealed rim.
  float repairN = gFbm(wp.xz * 0.075 + 91.2);
  float repair = smoothstep(0.62, 0.8, repairN);
  float rim = smoothstep(0.575, 0.62, repairN) * (1.0 - smoothstep(0.63, 0.7, repairN));
  gAlb = mix(gAlb, gAlb * vec3(1.3, 1.27, 1.2), repair);
  gRgh = mix(gRgh, min(gRgh + 0.3, 0.9), repair);
  gNStr *= 1.0 - 0.5 * repair; // fresh asphalt reads smoother
  gAlb *= 1.0 - 0.3 * rim;
  gRgh = mix(gRgh, 0.3, rim);

  // Uniform damp sheen: the whole street reads recently rained-on, with
  // large-scale variation so some stretches dried out more than others.
  float damp = clamp(0.35 + 0.55 * gFbm(wp.xz * 0.03 + 200.0), 0.0, 1.0);
  gAlb *= 1.0 - 0.2 * damp;
  gRgh = mix(gRgh, gRgh * 0.55 + 0.02, damp);
}

// Puddles: pooled in gutters and low spots; mirror-smooth, slightly dark.
float gPud = 0.0;
{
  float pn = gFbm(wp.xz * 0.16 + 55.0);
  if (gKind == 0) gPud = smoothstep(0.56, 0.68, pn + gNearC * 0.06);
  else if (gKind == 1 || gKind == 2) gPud = 0.6 * smoothstep(0.64, 0.74, pn);
  gPud *= gUp;
  gAlb *= 1.0 - 0.35 * gPud;
  gRgh = mix(gRgh, 0.045, gPud);
}

// Grime: alleys and block interiors far from any road get dirtier.
if (gKind >= 1 && gKind <= 4 && gUp > 0.5) {
  float grime = smoothstep(2.5, 9.0, gDistRoad) * (0.65 + 0.35 * gFbm(wp.xz * 0.45 + 9.0));
  gAlb *= 1.0 - 0.3 * grime;
  gRgh = mix(gRgh, min(gRgh + 0.15, 1.0), grime * 0.5);
}

// Normal: perturb up-facing surfaces with the per-kind normal map; puddles flatten.
vec3 gWN = gGeoN;
if (gNStr > 0.0) {
  vec3 pert = normalize(vec3(gNrm2.x * gNStr, 1.0, gNrm2.y * gNStr));
  gWN = normalize(mix(gGeoN, pert, gUp * (1.0 - gPud)));
}
diffuseColor.rgb = gAlb;
`;

export const groundMaterial = new THREE.MeshStandardMaterial({
  roughness: 1.0,
  metalness: 0.08,
});

groundMaterial.onBeforeCompile = (shader) => {
  Object.assign(shader.uniforms, uniforms);
  shader.vertexShader = shader.vertexShader
    .replace("#include <common>", VERT_DECLS)
    .replace("#include <fog_vertex>", VERT_MAIN);
  shader.fragmentShader = shader.fragmentShader
    .replace("#include <common>", FRAG_DECLS)
    .replace("#include <map_fragment>", "#include <map_fragment>\n" + FRAG_GROUND)
    .replace(
      "#include <roughnessmap_fragment>",
      "#include <roughnessmap_fragment>\n  roughnessFactor = gRgh;",
    )
    // Puddles pick up a metalness kick so the env map reads as a real water
    // reflection (diffuse dies, specular tint from the darkened albedo).
    .replace(
      "#include <metalnessmap_fragment>",
      "#include <metalnessmap_fragment>\n  metalnessFactor = mix(metalnessFactor, 0.4, gPud);",
    )
    .replace(
      "#include <normal_fragment_begin>",
      "#include <normal_fragment_begin>\n  normal = normalize(mat3(viewMatrix) * gWN);",
    );
};
