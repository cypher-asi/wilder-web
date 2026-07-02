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
`;

// Main surface computation. Declares gRgh / gWN at main() scope so the
// roughness and normal injection points below can consume them.
const FRAG_GROUND = /* glsl */ `
vec3 wp = vWPos;
int gKind = int(vKind + 0.5);
vec3 gGeoN = normalize(vWNormal);
float gUp = clamp(gGeoN.y, 0.0, 1.0);
// Planar UVs: XZ on tops, axis-aligned vertical planes on curb faces.
vec2 gUV = abs(gGeoN.y) > 0.5
  ? wp.xz
  : (abs(gGeoN.x) > abs(gGeoN.z) ? vec2(wp.z, -wp.y) : vec2(wp.x, -wp.y));

// Distance to the nearest road surface (0 on roads) -> grime deep in blocks.
float gDistRoad = max(vRoadD, 0.0);

// Distance to the road edge, for fragments on the road (gutter zone).
float gNearC = 1.0 - smoothstep(0.2, 2.6, max(-vRoadD, 0.0));

vec3 gAlb;
float gRgh;
vec2 gNrm2 = vec2(0.0);
float gNStr = 0.0;
if (gKind == 0) {
  vec2 uv = gUV / 3.6;
  gAlb = texture2D(uAsphaltMap, uv).rgb * 0.85;
  gRgh = clamp(texture2D(uAsphaltRough, uv).r * 0.5 + 0.03, 0.1, 0.6);
  gNrm2 = texture2D(uAsphaltNormal, uv).rg * 2.0 - 1.0;
  gNStr = 0.45;
} else if (gKind == 1) {
  // Sidewalk: smooth concrete slabs (pavers alias into speckle at this scale).
  vec2 uv = gUV / 3.5;
  gAlb = texture2D(uConcreteMap, uv).rgb * 1.25;
  // Per-slab value variation on the 2 m joint grid so slabs read individually.
  gAlb *= 0.92 + 0.16 * gHash12(floor(wp.xz / 2.0));
  gRgh = clamp(texture2D(uConcreteRough, uv).r * 0.6 + 0.12, 0.25, 0.85);
  gNrm2 = texture2D(uConcreteNormal, uv).rg * 2.0 - 1.0;
  gNStr = 0.25;
} else if (gKind == 2) {
  // Plaza: large concrete slabs on the 4 m joint grid, a shade darker than
  // sidewalks. (Photo pavers alias into pixel speckle at this camera.)
  vec2 uv = gUV / 4.2;
  gAlb = texture2D(uConcreteMap, uv).rgb * 0.95;
  gAlb *= 0.9 + 0.2 * gHash12(floor(wp.xz / 4.0) + 11.0);
  gRgh = clamp(texture2D(uConcreteRough, uv).r * 0.6 + 0.12, 0.25, 0.85);
  gNrm2 = texture2D(uConcreteNormal, uv).rg * 2.0 - 1.0;
  gNStr = 0.25;
} else if (gKind == 3) {
  vec2 uv = gUV / 3.0;
  gAlb = texture2D(uConcreteMap, uv).rgb * 0.42;
  gRgh = clamp(texture2D(uConcreteRough, uv).r * 0.55 + 0.12, 0.2, 0.8);
  gNrm2 = texture2D(uConcreteNormal, uv).rg * 2.0 - 1.0;
  gNStr = 0.4;
} else if (gKind == 4) {
  vec2 uv = gUV / 2.6;
  gAlb = texture2D(uGrassMap, uv).rgb * 0.8;
  gRgh = 0.9;
  gNrm2 = texture2D(uGrassNormal, uv).rg * 2.0 - 1.0;
  gNStr = 0.6;
} else {
  gAlb = vec3(0.012, 0.028, 0.042);
  gRgh = 0.05;
}

// Large-scale mottle so big surfaces don't read flat under moonlight.
gAlb *= 0.65 + 0.65 * gFbm(wp.xz * 0.06 + 7.7);

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

// Oil stains (dark, glossier) and repair patches (lighter, drier) on roads.
if (gKind == 0) {
  float oil = smoothstep(0.56, 0.78, gFbm(wp.xz * 0.14 + 31.7));
  gAlb *= 1.0 - 0.4 * oil;
  gRgh = mix(gRgh, gRgh * 0.5, oil);
  float repair = smoothstep(0.62, 0.8, gFbm(wp.xz * 0.075 + 91.2));
  gAlb = mix(gAlb, gAlb * vec3(1.3, 1.27, 1.2), repair);
  gRgh = mix(gRgh, min(gRgh + 0.3, 0.9), repair);
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
  gAlb *= 1.0 - 0.38 * grime;
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
    .replace(
      "#include <normal_fragment_begin>",
      "#include <normal_fragment_begin>\n  normal = normalize(mat3(viewMatrix) * gWN);",
    );
};
