// Ground shader: extends MeshStandardMaterial (so lights/shadows/fog keep
// working) with per-tile-kind PBR texturing and world-space procedural detail:
// cracks, oil stains, asphalt patches, puddles, sidewalk expansion joints, and
// grime. Road proximity comes from the aRoadD vertex attribute (signed meters
// to the road network, baked from the city tile grid in Ground.tsx).

import * as THREE from "three";
import { getPbrTextureSet } from "../assets/catalog";
import {
  STYLE_TOON_APPLY,
  STYLE_TOON_DECLS,
  styleUniforms,
  TERR_MAX,
  TRON_RED,
} from "./styles";

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

// Shared with roadMarkings.ts so paint samples the same asphalt PBR maps.
export const groundTextureUniforms: Record<string, THREE.IUniform> = {};
const uniforms = groundTextureUniforms;
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
uniform float uGDetail;
uniform float uGPuddle;
uniform float uGWet;
uniform float uGSat;
uniform vec3 uGTint;
// Player world XZ: fades the tron floor grid to black away from the character.
uniform vec2 uPlayerPos;
${STYLE_TOON_DECLS}
// Territory: enemy-held regions tint the tron grid red.
const vec3 TRON_RED = vec3(${TRON_RED.r.toFixed(5)}, ${TRON_RED.g.toFixed(5)}, ${TRON_RED.b.toFixed(5)});
uniform vec3 uTerrCells[${TERR_MAX}];
uniform int uTerrCount;
uniform float uRegionSize;
// 1.0 when the world-xz position lies in an enemy-controlled region.
float gTerrEnemy(vec2 wxz) {
  vec2 rg = floor(wxz / uRegionSize);
  for (int i = 0; i < ${TERR_MAX}; i++) {
    if (i >= uTerrCount) break;
    vec3 c = uTerrCells[i];
    if (abs(c.x - rg.x) < 0.5 && abs(c.y - rg.y) < 0.5) return 1.0;
  }
  return 0.0;
}
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
// Slab field for concrete paving: slab pitch varies per 8 m zone (double,
// base, or half the base pitch), and each slab gets its own texture offset
// and tone so no two slabs read identical. joint = recessed groove mask
// (slab borders + zone borders where the pour pattern changes).
void gSlabField(vec2 p, float basePitch,
                out float pitch, out vec2 jitter, out float tone, out float joint) {
  vec2 zone = floor(p / 8.0);
  float zr = gHash12(zone + 21.0);
  pitch = zr < 0.3 ? basePitch * 2.0 : (zr < 0.78 ? basePitch : basePitch * 0.5);
  vec2 slab = floor(p / pitch);
  jitter = (gHash22(slab + 13.0) - 0.5) * 2.6;
  tone = 0.72 + 0.52 * gHash12(slab + 3.3);
  vec2 cell = abs(fract(p / pitch) - 0.5) * 2.0;
  float lineD = (1.0 - max(cell.x, cell.y)) * pitch * 0.5;
  vec2 zcell = abs(fract(p / 8.0) - 0.5) * 2.0;
  float zoneD = (1.0 - max(zcell.x, zcell.y)) * 4.0;
  joint = 1.0 - smoothstep(0.015, 0.055, min(lineD, zoneD));
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
vec3 gEmissive = vec3(0.0);
float gPud = 0.0;
if (uTron > 0.5) {
  // TRON: blue-black slab lifted just enough that the sun/hemi rig shades
  // it (lit faces vs shadow read as teal gradients like the reference).
  // This path does zero texture fetches and skips every grunge field below.
  gAlb = TRON_BASE * (gKind == 0 ? 1.6 : 3.0);
  gRgh = gKind == 0 ? 0.3 : 0.45;
  if (gKind > 4 && gKind < 6) { gAlb = TRON_BASE * 1.2; gRgh = 0.08; }
  // Enemy-held ground swaps the neon line color from blue to red.
  float tEnemy = gTerrEnemy(wp.xz);
  vec3 tGrid = mix(TRON_BLUE, TRON_RED, tEnemy);
  // Grid lines on street surfaces only (sidewalks/plazas stay clean dark
  // slabs); fades with camera distance so far chunks don't shimmer.
  if (gKind == 0) {
    float tCamD = distance(wp.xz, cameraPosition.xz);
    float tFade = 1.0 - smoothstep(60.0, 170.0, tCamD);
    if (tFade > 0.001) {
      // Minor line every 4 m, brighter major line every 16 m, AA via fwidth.
      vec2 tD4 = (0.5 - abs(fract(wp.xz / 4.0) - 0.5)) * 4.0;
      float tMinor = min(tD4.x, tD4.y);
      vec2 tD16 = (0.5 - abs(fract(wp.xz / 16.0) - 0.5)) * 16.0;
      float tMajor = min(tD16.x, tD16.y);
      float tAA = fwidth(tMinor);
      // Thin hairline cores: the AA term carries the width at distance so
      // up close the lines stay crisp. Kept deliberately narrow (~half the
      // previous width) so the grid doesn't read as thick.
      float tLine = (1.0 - smoothstep(0.004, 0.011 + tAA, tMinor)) * 0.5
                  + (1.0 - smoothstep(0.008, 0.02 + tAA, tMajor)) * 0.9;
      // Tight halo hugging each thin core: full-strength bleed for the bright
      // neon look, but narrow so the brightness comes from bloom, not girth.
      float tHalo = (1.0 - smoothstep(0.0, 0.45, tMajor)) * 0.06
                  + (1.0 - smoothstep(0.0, 0.16, tMinor)) * 0.03;
      // Tight spotlight around the character: blue lines are full within ~4 m
      // and fade to black by ~12 m. Enemy-held (red) lines ignore the fade.
      float tNearPlayer = 1.0 - smoothstep(4.0, 12.0, distance(wp.xz, uPlayerPos));
      float tGridFade = mix(tNearPlayer, 1.0, tEnemy);
      gEmissive += tGrid * (tLine * 1.4 + tHalo) * (gW.y * tFade * tGridFade);
    }
  }
  // Curb circuit: a hot hairline tracing every road edge, with its own bleed.
  float tEdge = 1.0 - smoothstep(0.03, 0.1 + fwidth(vRoadD), abs(vRoadD));
  float tEdgeHalo = (1.0 - smoothstep(0.0, 1.5, abs(vRoadD))) * 0.3;
  gEmissive += mix(tGrid, TRON_WHITE, 0.3) * (tEdge * 2.8 + tEdgeHalo);
} else if (gKind == 0) {
  // Base kept dark so roads sit low in value and glowing signage carries the
  // frame; the per-batch drift below provides the mid-grey variation.
  gAlb = gTriRGB(uAsphaltMap, wp, gW, 3.6, 3.6) * 1.05;
  // Per-block tint drift: paving batches age brown-gray or blue-black, on a
  // ~30 m scale plus a soft fbm blend so streets don't read as one material.
  float batch = gHash12(floor(wp.xz / 30.0) + 77.0);
  float batchMix = clamp(batch + 0.5 * (gFbm(wp.xz * 0.02 + 640.0) - 0.5), 0.0, 1.0);
  gAlb *= mix(vec3(1.05, 1.0, 0.93), vec3(0.93, 0.97, 1.06), batchMix);
  gAlb *= 0.9 + 0.25 * gHash12(floor(wp.xz / 30.0) + 12.0);
  // Roughness floor keeps the sun-glint path on the road from going
  // near-mirror (a hot specular column straight toward the low sun).
  gRgh = clamp(gTriR(uAsphaltRough, wp, gW, 3.6, 3.6) * 0.5 + 0.12, 0.28, 0.7);
  gNrm2 = gTriRG(uAsphaltNormal, wp, gW, 3.6, 3.6) * 2.0 - 1.0;
  gNStr = 0.5;
} else if (gKind == 1) {
  // Sidewalk: dark-gray concrete slabs with varied pour sizes (big 4 m
  // pours, standard 2 m slabs, or 1 m tile strips per zone) and per-slab
  // texture offset + tone so no two slabs read identical.
  float pitch; vec2 jit; float tone; float joint;
  gSlabField(wp.xz, 2.0, pitch, jit, tone, joint);
  vec3 wps = wp + vec3(jit.x, 0.0, jit.y);
  gAlb = gTriRGB(uConcreteMap, wps, gW, 3.5, 0.9) * 0.44 * vec3(0.97, 0.95, 0.92);
  // Bias tone downward (bright outlier slabs read as "white") with a wide
  // per-slab contrast so neighboring pours clearly differ, like the ref.
  gAlb *= 0.52 + 0.72 * (tone - 0.72);
  // Per-slab hue drift: pours cure warm (tan) or cool (blue-gray).
  vec2 slabId = floor(wp.xz / pitch);
  gAlb *= mix(vec3(1.05, 0.99, 0.91), vec3(0.91, 0.96, 1.05), gHash12(slabId + 47.1));
  // High roughness floor: dry concrete must not pick up a grazing-angle
  // sky sheen (it washes the whole walk out to cream facing the low sun).
  gRgh = clamp(gTriR(uConcreteRough, wps, gW, 3.5, 0.9) * 0.6 + 0.32, 0.55, 0.97);
  gRgh += 0.2 * (gHash12(floor(wp.xz / pitch) + 7.7) - 0.5);
  gNrm2 = gTriRG(uConcreteNormal, wps, gW, 3.5, 0.9) * 2.0 - 1.0;
  gNStr = 0.35;
  // Recessed joint grooves between slabs: darker core plus a V-groove
  // normal tilt so each joint catches light like a saw cut, not a stripe.
  gAlb *= 1.0 - 0.62 * joint;
  gRgh = mix(gRgh, min(gRgh + 0.25, 1.0), joint);
  vec2 jf = fract(wp.xz / pitch + 0.5) - 0.5;
  vec2 jTilt = -sign(jf) * (1.0 - smoothstep(0.005, 0.08, abs(jf) * pitch));
  gNrm2 += jTilt * 2.2;
} else if (gKind == 6 || gKind == 7) {
  // Curbstone band (kind 6 runs along Z, 7 along X): granite-toned concrete
  // at a fine repeat so the curb reads as its own element, a touch lighter
  // than the dark sidewalk, with per-segment shifts and joints every 1.8 m.
  gAlb = gTriRGB(uConcreteMap, wp, gW, 1.2, 0.9) * 0.56 * vec3(0.95, 0.95, 0.97);
  gRgh = clamp(gTriR(uConcreteRough, wp, gW, 1.2, 0.9) * 0.55 + 0.3, 0.5, 0.95);
  gNrm2 = gTriRG(uConcreteNormal, wp, gW, 1.2, 0.9) * 2.0 - 1.0;
  gNStr = 0.4;
  float along = gKind == 6 ? wp.z : wp.x;
  gAlb *= 0.88 + 0.24 * gHash12(vec2(floor(along / 1.8), 4.2));
  float distJoint = (0.5 - abs(fract(along / 1.8) - 0.5)) * 1.8;
  float joint = 1.0 - smoothstep(0.012, 0.045, distJoint);
  gAlb *= 1.0 - 0.6 * joint;
  gRgh = mix(gRgh, min(gRgh + 0.2, 1.0), joint);
  // V-groove normal tilt across each curbstone joint.
  float jsC = fract(along / 1.8 + 0.5) - 0.5;
  float jtC = -sign(jsC) * (1.0 - smoothstep(0.005, 0.06, abs(jsC) * 1.8));
  if (gKind == 6) { gNrm2.y += jtC * 2.4; } else { gNrm2.x += jtC * 2.4; }
} else if (gKind == 8) {
  // Seam groove between curbstone and sidewalk: packed wet dirt, near black.
  float dn = gFbm(wp.xz * 2.6 + 12.0);
  gAlb = vec3(0.030, 0.028, 0.025) * (0.6 + 0.8 * dn);
  gRgh = 0.92;
} else if (gKind >= 9) {
  // Gutter pan (kind 9 runs along Z, 10 along X): a lower curb apron poured
  // at street grade; concrete like the curb but heavily stained by runoff.
  gAlb = gTriRGB(uConcreteMap, wp, gW, 1.2, 0.9) * 0.5 * vec3(0.94, 0.93, 0.9);
  gRgh = clamp(gTriR(uConcreteRough, wp, gW, 1.2, 0.9) * 0.55 + 0.3, 0.5, 0.95);
  gNrm2 = gTriRG(uConcreteNormal, wp, gW, 1.2, 0.9) * 2.0 - 1.0;
  gNStr = 0.35;
  float alongP = gKind == 9 ? wp.z : wp.x;
  gAlb *= 0.86 + 0.22 * gHash12(vec2(floor(alongP / 1.8), 6.6));
  // Joints line up with the curbstones above, with the same V-groove tilt.
  float distJp = (0.5 - abs(fract(alongP / 1.8) - 0.5)) * 1.8;
  float jointP = 1.0 - smoothstep(0.012, 0.045, distJp);
  gAlb *= 1.0 - 0.55 * jointP;
  float jsP = fract(alongP / 1.8 + 0.5) - 0.5;
  float jtP = -sign(jsP) * (1.0 - smoothstep(0.005, 0.06, abs(jsP) * 1.8));
  if (gKind == 9) { gNrm2.y += jtP * 2.4; } else { gNrm2.x += jtP * 2.4; }
  // Runoff staining: dark water-borne grime pooled along the pan.
  float runoff = smoothstep(0.3, 0.75, gFbm(wp.xz * 0.7 + 88.0));
  gAlb *= 1.0 - 0.35 * runoff;
  gRgh = mix(gRgh, gRgh * 0.7, runoff);
  // Contact AO against the curb face: pan height encodes position across the
  // pan (lip 0.004 -> curb side 0.02), so darken toward the high edge.
  float panAO = smoothstep(0.008, 0.019, wp.y);
  gAlb *= 1.0 - 0.3 * panAO;
} else if (gKind == 2) {
  // Plaza: big dark stone slabs (8/4/2 m per zone) with per-slab texture
  // offset and tone; darker and cooler than sidewalks like the reference.
  float pitch; vec2 jit; float tone; float joint;
  gSlabField(wp.xz + 37.0, 4.0, pitch, jit, tone, joint);
  vec3 wps = wp + vec3(jit.x, 0.0, jit.y);
  gAlb = gTriRGB(uConcreteMap, wps, gW, 4.2, 0.9) * 0.46 * vec3(0.94, 0.96, 1.0);
  // Same downward tone bias as sidewalks, with the same widened contrast.
  gAlb *= 0.52 + 0.72 * (tone - 0.72);
  gRgh = clamp(gTriR(uConcreteRough, wps, gW, 4.2, 0.9) * 0.6 + 0.3, 0.55, 0.97);
  gRgh += 0.2 * (gHash12(floor(wp.xz / pitch) + 9.1) - 0.5);
  gNrm2 = gTriRG(uConcreteNormal, wps, gW, 4.2, 0.9) * 2.0 - 1.0;
  gNStr = 0.3;
  gAlb *= 1.0 - 0.6 * joint;
  gRgh = mix(gRgh, min(gRgh + 0.25, 1.0), joint);
  vec2 jfP = fract((wp.xz + 37.0) / pitch + 0.5) - 0.5;
  vec2 jTiltP = -sign(jfP) * (1.0 - smoothstep(0.005, 0.08, abs(jfP) * pitch));
  gNrm2 += jTiltP * 2.0;
} else if (gKind == 3) {
  gAlb = gTriRGB(uConcreteMap, wp, gW, 3.0, 0.9) * 0.42;
  gRgh = clamp(gTriR(uConcreteRough, wp, gW, 3.0, 0.9) * 0.55 + 0.28, 0.5, 0.95);
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

// Everything below (mottle, grunge detail, wetness, puddles, grading) is
// the textured-style pipeline; the tron path is already final.
if (uTron < 0.5) {

// Large-scale mottle so big surfaces don't read flat in low sun.
gAlb *= 0.8 + 0.3 * gFbm(wp.xz * 0.06 + 7.7);

// Style detail gate: anime presets skip the grunge detail below (cracks,
// stains, wear) for a cleaner painterly read and fewer fbm/voronoi evals.
if (uGDetail > 0.5) {

// Dirt blotches + broad weathering patches on walkable concrete: small-scale
// boot-traffic grime plus large irregular darkened regions like the
// reference plaza (water staining, sun-bleached vs shaded pours).
if (gKind == 1 || gKind == 2 || gKind == 3) {
  float dirt = smoothstep(0.45, 0.75, gFbm(wp.xz * 0.22 + 61.3));
  float wea = smoothstep(0.44, 0.82, gFbm(wp.xz * 0.045 + 151.0));
  gAlb *= (1.0 - 0.38 * dirt) * (1.0 - 0.38 * wea);
  gRgh = min(gRgh + 0.12 * wea, 1.0);
  // Sun-bleached pours: sparse zones that dried lighter and chalkier.
  float bleach = smoothstep(0.66, 0.84, gFbm(wp.xz * 0.035 + 401.0));
  gAlb *= 1.0 + 0.14 * bleach;
  gRgh = min(gRgh + 0.1 * bleach, 1.0);
  // Trodden-in gum and grease dots on walking surfaces.
  float gum = gSpots(wp.xz + 17.0, 0.9, 0.16, 0.1);
  gAlb *= 1.0 - 0.5 * gum;
  gRgh = mix(gRgh, gRgh * 0.6, gum);
  // Rust runoff streak spots (railings, signposts, fire escapes above).
  float rustW = gSpots(wp.xz + 71.0, 5.5, 0.1, 0.16);
  gAlb = mix(gAlb, vec3(0.20, 0.10, 0.05) * (0.6 + 0.8 * gFbm(wp.xz * 1.1)), 0.4 * rustW);
}

// Cracks: voronoi edges gated by a density mask, denser near curbs, plus a
// finer secondary crack web and sparse "alligator" fatigue zones on asphalt.
float gCrackLine = 1.0 - smoothstep(0.015, 0.045, gVoroEdge(wp.xz * 0.45));
float gCrackDen = smoothstep(0.58, 0.85, gFbm(wp.xz * 0.09 + 17.0));
float gCrackFine = 1.0 - smoothstep(0.015, 0.04, gVoroEdge(wp.xz * 1.1 + 9.0));
float gFineDen = smoothstep(0.72, 0.9, gFbm(wp.xz * 0.13 + 71.0));
float gCrack = 0.0;
if (gKind == 0) {
  gCrack = gCrackLine * clamp(gCrackDen + gNearC * 0.3, 0.0, 1.0);
  // Alligator cracking: sparse fatigue zones where a fine crack web runs
  // dense with a crumbled, slightly darker fill between the cracks.
  float alli = smoothstep(0.74, 0.85, gFbm(wp.xz * 0.045 + 301.0));
  gCrack = max(gCrack, gCrackFine * alli * 0.8);
  gAlb *= 1.0 - 0.1 * alli;
  gRgh = min(gRgh + 0.08 * alli, 1.0);
  gCrack = max(gCrack, gCrackFine * gFineDen * 0.5);
} else if (gKind <= 2) {
  gCrack = gCrackLine * clamp(gCrackDen * 0.65 + (1.0 - smoothstep(0.1, 1.0, gDistRoad)) * 0.25, 0.0, 1.0) * 0.7;
  gCrack = max(gCrack, gCrackFine * gFineDen * 0.4);
}
// Crack shading: darker core plus a roughness lift; no normal kink (a lit
// kink turns the crack web into bright specular veins under low sun).
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

  // Tar crack-seal: dark snaking lines, sparser than the crack field. Kept
  // matte enough that grazing light doesn't turn the web into bright veins.
  float tarLine = 1.0 - smoothstep(0.04, 0.12, gVoroEdge(wp.xz * 0.17 + 5.0));
  float tar = tarLine * smoothstep(0.6, 0.78, gFbm(wp.xz * 0.05 + 130.0));
  gAlb = mix(gAlb, vec3(0.016, 0.016, 0.018), 0.7 * tar);
  gRgh = mix(gRgh, 0.45, tar);

  // Oil stains: dark, glossier, biased toward lane centers and the gutter.
  float oil = smoothstep(0.56, 0.78, gFbm(wp.xz * 0.14 + 31.7) + gNearC * 0.05);
  gAlb *= 1.0 - 0.28 * oil;
  gRgh = mix(gRgh, gRgh * 0.5, oil);

  // Drip spots (engine drips, gum, rust runoff) scattered mid-lane.
  float drip = gSpots(wp.xz, 1.7, 0.1, 0.28);
  gAlb *= 1.0 - 0.22 * drip;
  gRgh = mix(gRgh, gRgh * 0.75, drip);

  // Rust stains: iron-brown blooms around street steel and runoff paths.
  float rust = gSpots(wp.xz + 53.0, 4.5, 0.12, 0.22);
  gAlb = mix(gAlb, vec3(0.21, 0.11, 0.05) * (0.6 + 0.8 * gFbm(wp.xz * 1.3)), 0.45 * rust);
  gRgh = mix(gRgh, min(gRgh + 0.2, 1.0), rust * 0.5);

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
}

// Curb weathering and gutters: grime, painted sections, contact shadows.
float dCurbG = max(-vRoadD, 0.0);
if (gKind == 6 || gKind == 7) {
  float alongC = gKind == 6 ? wp.z : wp.x;
  float acrossC = gKind == 6 ? wp.x : wp.z;
  // Grime streaks down the vertical face, heavier near the base where
  // street water splashes back; band top picks up boot/tire scuff instead.
  float streak = 0.5 + 0.5 * gNoise(vec2(alongC * 5.0, 2.3));
  float baseG = 1.0 - smoothstep(0.02, 0.14, wp.y);
  float faceGrime = gVert * (0.28 * streak + 0.3 * baseG);
  float topScuff = gW.y * 0.14 * smoothstep(0.4, 0.75, gFbm(wp.xz * 0.7 + 47.0));
  gAlb *= 1.0 - clamp(faceGrime + topScuff, 0.0, 0.7);
  gRgh = min(gRgh + 0.12 * gVert, 1.0);
  // Chipped painted curb sections (mostly worn safety yellow, some fire-lane
  // red), hashed per 16 m stretch; paint covers the whole curbstone and
  // flakes off with fine noise.
  float sect = gHash12(vec2(floor(alongC / 16.0), 8.5));
  if (sect < 0.32) {
    vec3 paint = sect < 0.07 ? vec3(0.40, 0.07, 0.05) : vec3(0.62, 0.47, 0.10);
    // Thin paint over rough concrete: modulate by the underlying albedo
    // luminance so grime, joints and texture grain read through the coat.
    float underLum = dot(gAlb, vec3(0.299, 0.587, 0.114));
    paint *= clamp(0.45 + underLum * 3.2, 0.5, 1.25);
    float chip = smoothstep(0.45, 0.68,
      gNoise(vec2(alongC * 7.0, wp.y * 30.0 + acrossC * 11.0)));
    float pMask = (1.0 - chip) * 0.85;
    gAlb = mix(gAlb, paint, pMask);
    gRgh = mix(gRgh, 0.55, pMask);
  }
}
if (gKind == 0) {
  // Gutter: dark debris band hugging the curb line, dirtiest at the seam.
  float gut = 1.0 - smoothstep(0.1, 1.3, dCurbG);
  gut *= 0.7 + 0.3 * gFbm(wp.xz * 0.5 + 23.0);
  gAlb = mix(gAlb, gAlb * vec3(0.5, 0.48, 0.45), gut);
  // Contact-shadow band where asphalt meets the gutter pan (cheap AO).
  float contact = 1.0 - smoothstep(0.05, 0.55, dCurbG);
  gAlb *= 1.0 - 0.38 * contact;
}
if (gKind == 1) {
  // Contact AO where the walking surface meets the curb band groove.
  float seamAO = 1.0 - smoothstep(0.1, 0.6, gDistRoad);
  gAlb *= 1.0 - 0.14 * seamAO;
}

} // end detail gate

// Wetness (uGWet, runs in every style): the street reads recently rained-on,
// with large-scale fbm variation so some stretches dried out more. At 1 this
// matches the old golden damp sheen (soft, well above mirror); above 1 the
// asphalt darkens further and polishes toward a slick wet-road reflection,
// and damp sheen bleeds onto sidewalk/plaza stone.
if (uGWet > 0.001) {
  float dampN = clamp(0.35 + 0.55 * gFbm(wp.xz * 0.03 + 200.0), 0.0, 1.0);
  if (gKind == 0 || gKind >= 9) {
    float damp = dampN * min(uGWet, 1.0);
    gAlb *= 1.0 - 0.2 * damp;
    gRgh = mix(gRgh, gRgh * 0.75 + 0.08, damp);
    float soak = dampN * clamp(uGWet - 1.0, 0.0, 1.0);
    gAlb *= 1.0 - 0.25 * soak;
    gRgh = mix(gRgh, 0.12, soak * gUp);
  } else if (gKind == 1 || gKind == 2) {
    // Damp stone: subtle darkening + grazing-angle sheen, never mirror.
    float soakS = dampN * clamp(uGWet - 0.8, 0.0, 1.0);
    gAlb *= 1.0 - 0.18 * soakS;
    gRgh = mix(gRgh, 0.38, soakS * gUp * 0.8);
  }
}

// Puddles: pooled in gutters and low spots; mirror-smooth, slightly dark.
// uGPuddle widens coverage for the anime styles (rain-mirrored streets).
{
  float pn = gFbm(wp.xz * 0.16 + 55.0) + uGPuddle;
  if (gKind == 0) gPud = smoothstep(0.56, 0.68, pn + gNearC * 0.06);
  else if (gKind == 1 || gKind == 2) gPud = 0.45 * smoothstep(0.66, 0.76, pn);
  gPud *= gUp;
  gAlb *= 1.0 - 0.35 * gPud;
  gRgh = mix(gRgh, 0.045, gPud);
}

// Grime: alleys and block interiors far from any road get dirtier.
if (uGDetail > 0.5 && gKind >= 1 && gKind <= 4 && gUp > 0.5) {
  float grime = smoothstep(2.5, 9.0, gDistRoad) * (0.65 + 0.35 * gFbm(wp.xz * 0.45 + 9.0));
  gAlb *= 1.0 - 0.3 * grime;
  gRgh = mix(gRgh, min(gRgh + 0.15, 1.0), grime * 0.5);
}

// Style grade: saturation + tint on the final albedo.
{
  float gLum = dot(gAlb, vec3(0.2126, 0.7152, 0.0722));
  gAlb = max(mix(vec3(gLum), gAlb, uGSat) * uGTint, 0.0);
}

} // end textured-style pipeline (uTron < 0.5)

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
  Object.assign(shader.uniforms, uniforms, styleUniforms);
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
    // Tron grid / road-edge circuit lines (zero vector in every other style).
    .replace(
      "#include <emissivemap_fragment>",
      "#include <emissivemap_fragment>\n  totalEmissiveRadiance += gEmissive;",
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
    )
    // Painterly luminance banding for the anime styles (no-op when 0).
    .replace("#include <opaque_fragment>", STYLE_TOON_APPLY);
};
