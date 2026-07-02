// Ground shader: extends MeshStandardMaterial (so lights/shadows/fog keep
// working) with per-tile-kind PBR texturing and world-space procedural detail:
// cracks, oil stains, asphalt patches, puddles, sidewalk expansion joints,
// grime, and painted road markings mirrored from the deterministic road grid
// (roads on even chunk rows/cols, 12 m avenues every 4th chunk, 6 m streets).

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
varying float vKind;
varying vec3 vWPos;
varying vec3 vWNormal;
`;

const VERT_MAIN = /* glsl */ `
#include <fog_vertex>
vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
vWNormal = normalize(mat3(modelMatrix) * objectNormal);
vKind = aKind;
`;

const FRAG_DECLS = /* glsl */ `
#include <common>
varying float vKind;
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
float gRmod(float a, float m) { return a - m * floor(a / m); }
// Crossing roads repeat every 64 m; every other one (128 m) is a 12 m avenue.
float gBandW(float j) { return gRmod(j, 2.0) < 0.5 ? 12.0 : 6.0; }
// Distance along a road axis to the nearest crossing road band (0 inside it).
float gCrossDist(float p) {
  float j = floor(p / 64.0);
  float dPrev = p - (64.0 * j + gBandW(j));
  float dNext = 64.0 * (j + 1.0) - p;
  if (dPrev < 0.0) return 0.0;
  return min(dPrev, dNext);
}
// Painted markings for one road orientation: returns (white, yellow) masks.
// along = world coord down the road, across = 0..w within the band.
vec2 gRoadPaint(float along, float across, float w) {
  float aa = fwidth(across) + 0.01;
  float interD = gCrossDist(along);
  // Dashed double yellow center line (2 m on / 1.5 m off), gap at intersections.
  float c = w * 0.5;
  float dash = step(gRmod(along, 3.5), 2.0) * step(4.0, interD);
  float y1 = 1.0 - smoothstep(0.06, 0.06 + aa, abs(across - (c - 0.16)));
  float y2 = 1.0 - smoothstep(0.06, 0.06 + aa, abs(across - (c + 0.16)));
  float yellow = max(y1, y2) * dash;
  // Solid white edge lines 0.25 m off each curb.
  float e1 = 1.0 - smoothstep(0.075, 0.075 + aa, abs(across - 0.25));
  float e2 = 1.0 - smoothstep(0.075, 0.075 + aa, abs(across - (w - 0.25)));
  float white = max(e1, e2);
  // Avenues: parking lane separator 2 m off each curb.
  if (w > 9.0) {
    float p1 = 1.0 - smoothstep(0.075, 0.075 + aa, abs(across - 2.0));
    float p2 = 1.0 - smoothstep(0.075, 0.075 + aa, abs(across - (w - 2.0)));
    white = max(white, max(p1, p2));
  }
  white *= step(0.4, interD);
  float inSpan = step(0.3, across) * step(across, w - 0.3);
  // Zebra crosswalk: 0.5 m stripes across the road, 0.6-3.0 m out from the box.
  float cw = step(0.6, interD) * step(interD, 3.2) * step(gRmod(interD - 0.6, 1.0), 0.6);
  white = max(white, cw * inSpan);
  // Stop line just behind the crosswalk.
  float sl = step(3.4, interD) * step(interD, 3.8);
  white = max(white, sl * inSpan);
  return vec2(white, yellow);
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

// Road-grid frame (mirrors wilder-terrain, rem_euclid semantics).
float gcz = floor(wp.z / 32.0);
float gcx = floor(wp.x / 32.0);
bool gHRoad = gRmod(gcz, 2.0) < 0.5;
bool gVRoad = gRmod(gcx, 2.0) < 0.5;
float gHW = gRmod(gcz, 4.0) < 0.5 ? 12.0 : 6.0;
float gVW = gRmod(gcx, 4.0) < 0.5 ? 12.0 : 6.0;
float gZin = wp.z - gcz * 32.0;
float gXin = wp.x - gcx * 32.0;
bool gInH = gHRoad && gZin < gHW;
bool gInV = gVRoad && gXin < gVW;

// Distance to the nearest road surface (0 on roads) -> grime deep in blocks.
float gDistRoad = min(
  min(gHRoad ? max(gZin - gHW, 0.0) : 1e5,
      gRmod(gcz + 1.0, 2.0) < 0.5 ? 32.0 - gZin : 1e5),
  min(gVRoad ? max(gXin - gVW, 0.0) : 1e5,
      gRmod(gcx + 1.0, 2.0) < 0.5 ? 32.0 - gXin : 1e5));
if (gInH || gInV) gDistRoad = 0.0;

// Distance to the road edge, for fragments on the road (gutter zone).
float gEdgeD = 1e5;
if (gInH) gEdgeD = min(gEdgeD, min(gZin, gHW - gZin));
if (gInV) gEdgeD = min(gEdgeD, min(gXin, gVW - gXin));
float gNearC = 1.0 - smoothstep(0.2, 1.5, gEdgeD);

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

// Painted markings, worn by noise, clamped so bloom stays tame.
if (gKind == 0) {
  vec2 pH = gRoadPaint(wp.x, gZin, gHW);
  vec2 pV = gRoadPaint(wp.z, gXin, gVW);
  float mH = (gInH && !gInV) ? 1.0 : 0.0;
  float mV = (gInV && !gInH) ? 1.0 : 0.0;
  float white = max(pH.x * mH, pV.x * mV);
  float yellow = max(pH.y * mH, pV.y * mV);
  float erode = smoothstep(0.2, 0.42, gFbm(wp.xz * 1.3 + 43.0));
  float wear = mix(0.5, 1.0, smoothstep(0.25, 0.75, gFbm(wp.xz * 0.8 + 5.0)));
  white *= erode;
  yellow *= erode;
  float paintM = max(white, yellow);
  if (paintM > 0.001) {
    vec3 paintCol = (vec3(0.45, 0.45, 0.42) * white + vec3(0.45, 0.35, 0.1) * yellow) / paintM;
    gAlb = mix(gAlb, paintCol * wear, paintM);
    gRgh = mix(gRgh, gRgh * 0.6 + 0.02, paintM);
  }
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
