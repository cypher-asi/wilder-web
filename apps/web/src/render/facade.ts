// Building materials: a PBR facade shader (world-space tiling, procedural lit
// windows, grime) plus a shared cache of simple materials so hundreds of
// building meshes reuse a handful of GPU programs.

import * as THREE from "three";
import { getPbrTextureSet } from "../assets/catalog";
import { BuildingInstance } from "../net/protocol";

// ---------------------------------------------------------------------------
// Stable exports used by other modules (Props.tsx, Atmosphere.tsx).
// ---------------------------------------------------------------------------

export function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const NEON_COLORS = [
  "#ff2d78",
  "#00e5ff",
  "#b64dff",
  "#ffe14d",
  "#39ff8e",
  "#ff6a00",
];

/** Shared clock uniform for window flicker; driven from Atmosphere. */
const timeUniform = { value: 0 };

export function tickFacades(elapsed: number): void {
  timeUniform.value = elapsed;
}

// ---------------------------------------------------------------------------
// Facade shader (MeshStandardMaterial + onBeforeCompile)
// ---------------------------------------------------------------------------

// World-space planar UVs (2.5 m per texture repeat) so one material tiles
// correctly across every building regardless of footprint.
const FACADE_VERT_HEADER = /* glsl */ `
varying vec3 vFWorldPos;
varying vec3 vFWorldNormal;
`;

const FACADE_VERT_WORLDPOS = /* glsl */ `
#include <worldpos_vertex>
vFWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
vFWorldNormal = normalize(mat3(modelMatrix) * normal);
{
  vec3 fAn = abs(vFWorldNormal);
  vec2 fUv;
  if (fAn.y > 0.6) fUv = vFWorldPos.xz;
  else if (fAn.x > fAn.z) fUv = vec2(vFWorldPos.z, vFWorldPos.y);
  else fUv = vec2(vFWorldPos.x, vFWorldPos.y);
  fUv *= (1.0 / 2.5);
  #ifdef USE_MAP
    vMapUv = fUv;
  #endif
  #ifdef USE_NORMALMAP
    vNormalMapUv = fUv;
  #endif
  #ifdef USE_ROUGHNESSMAP
    vRoughnessMapUv = fUv;
  #endif
}
`;

const FACADE_FRAG_HEADER = /* glsl */ `
varying vec3 vFWorldPos;
varying vec3 vFWorldNormal;
uniform vec3 uTint;
uniform vec3 uWinColor;
uniform float uLitRatio;
uniform float uTopY;
uniform float uSeed;
uniform float uFTime;
float fhash(vec2 p) {
  return fract(sin(dot(p + uSeed, vec2(127.1, 311.7))) * 43758.5453);
}
`;

// Tint + grime after albedo sampling, and the upper-story window grid:
// 1.4 m x 3.0 m cells starting above the 4.5 m ground floor. Unlit cells read
// as dark glass (albedo swap); lit cells add warm/cool emissive with per-cell
// brightness and rare flicker.
const FACADE_FRAG_MAP = /* glsl */ `
#include <map_fragment>
vec3 fGlow = vec3(0.0);
{
  vec3 fWn = normalize(vFWorldNormal);
  float fy = vFWorldPos.y - 0.14; // buildings sit on raised tiles (GROUND_Y)
  diffuseColor.rgb *= uTint;
  float fGrime = mix(0.6, 1.0, smoothstep(0.1, 5.5, fy));
  fGrime *= 1.0 - 0.28 * smoothstep(uTopY - 2.2, uTopY - 0.3, fy);
  if (abs(fWn.y) < 0.5) {
    float fu = (abs(fWn.x) > abs(fWn.z)) ? vFWorldPos.z : vFWorldPos.x;
    fGrime *= 0.86 + 0.14 * fhash(vec2(floor(fu * 1.7), 3.7));
    float fFace = (abs(fWn.x) > abs(fWn.z)) ? (2.0 + step(0.0, fWn.x)) : (7.0 + step(0.0, fWn.z));
    float fv = fy - 4.5;
    if (fv > 0.12 && fy < uTopY - 0.5) {
      vec2 fCell = vec2(floor(fu / 1.4), floor(fv / 3.0));
      vec2 fFr = vec2(fract(fu / 1.4), fract(fv / 3.0));
      float fIn = step(0.26, fFr.x) * step(fFr.x, 0.74) * step(0.25, fFr.y) * step(fFr.y, 0.7);
      float fLit = step(1.0 - uLitRatio, fhash(fCell * 1.13 + fFace));
      vec3 fCol = mix(uWinColor, vec3(1.0, 0.8, 0.52), fhash(fCell + fFace + 3.0) * 0.75);
      float fBr = 0.5 + 0.95 * fhash(fCell + fFace + 11.0);
      float fFl = fhash(fCell + fFace + 23.0);
      float fFlick = 1.0;
      if (fFl > 0.93) fFlick = 0.72 + 0.28 * sin(uFTime * (2.0 + 6.0 * fFl) + fFl * 40.0);
      fGlow = fCol * (fIn * fLit * fBr * fFlick * 1.35);
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.012, 0.015, 0.02), fIn);
    }
  }
  diffuseColor.rgb *= fGrime;
}
`;

const FACADE_FRAG_EMISSIVE = /* glsl */ `
#include <emissivemap_fragment>
totalEmissiveRadiance += fGlow;
`;

const FACADE_TINTS = ["#cfc9c2", "#c2b6ad", "#b9bec7", "#c8c1b0", "#b5b0b8"].map(
  (c) => new THREE.Color(c),
);
const WINDOW_COLORS = ["#ffd9a0", "#bfe3ff", "#ffe9c9", "#d8f6ff"].map(
  (c) => new THREE.Color(c),
);

const facadeCache = new Map<string, THREE.MeshStandardMaterial>();

function makeFacadeMaterial(tex: string, topY: number, variant: number): THREE.MeshStandardMaterial {
  const metal = tex === "metal_panel" || tex === "corrugated";
  const mat = new THREE.MeshStandardMaterial({
    roughness: 0.9,
    metalness: metal ? 0.3 : 0.0,
  });
  getPbrTextureSet(tex).then((set) => {
    if (!set) return;
    mat.map = set.map;
    mat.normalMap = set.normalMap;
    mat.roughnessMap = set.roughnessMap;
    mat.needsUpdate = true;
  });
  const uniforms = {
    uTint: { value: FACADE_TINTS[variant % FACADE_TINTS.length] },
    uWinColor: { value: WINDOW_COLORS[variant % WINDOW_COLORS.length] },
    uLitRatio: { value: 0.16 + 0.08 * (variant % 3) },
    uTopY: { value: topY },
    uSeed: { value: (variant * 7.31) % 10 },
    uFTime: timeUniform,
  };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader =
      FACADE_VERT_HEADER +
      shader.vertexShader.replace("#include <worldpos_vertex>", FACADE_VERT_WORLDPOS);
    shader.fragmentShader =
      FACADE_FRAG_HEADER +
      shader.fragmentShader
        .replace("#include <map_fragment>", FACADE_FRAG_MAP)
        .replace("#include <emissivemap_fragment>", FACADE_FRAG_EMISSIVE);
  };
  mat.customProgramCacheKey = () => "wilder-facade";
  return mat;
}

/** Archetype picks the material family; style adds occasional variation. */
function facadeTexture(archetype: number, r: number): string {
  switch (archetype & 3) {
    case 0:
      return r < 0.2 ? "brick_painted" : "brick_red";
    case 1:
      return r < 0.15 ? "brick_painted" : "brick_dark";
    case 2:
      return r < 0.25 ? "concrete" : "concrete_panel";
    default:
      return r < 0.25 ? "corrugated" : "metal_panel";
  }
}

// ---------------------------------------------------------------------------
// Shared simple materials (one instance each, reused by every building)
// ---------------------------------------------------------------------------

function withClonedPbr(
  mat: THREE.MeshStandardMaterial,
  set: string,
  repeatX: number,
  repeatY: number,
): THREE.MeshStandardMaterial {
  getPbrTextureSet(set).then((tex) => {
    if (!tex) return;
    const clone = (t: THREE.Texture) => {
      const c = t.clone();
      c.repeat.set(repeatX, repeatY);
      c.needsUpdate = true;
      return c;
    };
    mat.map = clone(tex.map);
    mat.normalMap = clone(tex.normalMap);
    mat.roughnessMap = clone(tex.roughnessMap);
    mat.needsUpdate = true;
  });
  return mat;
}

const SHARED_FACTORIES: Record<string, () => THREE.Material> = {
  // Concrete cornice / parapet caps / sills.
  trim: () => new THREE.MeshStandardMaterial({ color: "#6f6a62", roughness: 0.85 }),
  // Painted storefront surrounds (piers, fascia, jambs) — per-building pick.
  storeTrim0: () => new THREE.MeshStandardMaterial({ color: "#3d4f45", roughness: 0.7 }),
  storeTrim1: () => new THREE.MeshStandardMaterial({ color: "#5a3f38", roughness: 0.7 }),
  storeTrim2: () => new THREE.MeshStandardMaterial({ color: "#39405a", roughness: 0.7 }),
  storeTrim3: () => new THREE.MeshStandardMaterial({ color: "#44444a", roughness: 0.7 }),
  metal: () =>
    new THREE.MeshStandardMaterial({ color: "#3a3e45", roughness: 0.55, metalness: 0.7 }),
  metalDark: () =>
    new THREE.MeshStandardMaterial({ color: "#1c1e22", roughness: 0.5, metalness: 0.75 }),
  grill: () =>
    new THREE.MeshStandardMaterial({ color: "#565b62", roughness: 0.6, metalness: 0.6 }),
  corrugated: () =>
    withClonedPbr(
      new THREE.MeshStandardMaterial({ color: "#75797f", roughness: 0.65, metalness: 0.5 }),
      "corrugated",
      2,
      2,
    ),
  glass: () =>
    new THREE.MeshStandardMaterial({
      color: "#101820",
      roughness: 0.05,
      metalness: 0.6,
      envMapIntensity: 2.0,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
    }),
  // Awning fabric: color comes from vertex colors so all awnings merge.
  fabric: () =>
    new THREE.MeshStandardMaterial({ color: "#ffffff", vertexColors: true, roughness: 0.92 }),
  // All emissive planes (signs, window glow, tips). Intensity is baked into
  // vertex colors (>1 values bloom); toneMapped=false keeps them punchy.
  neon: () =>
    new THREE.MeshBasicMaterial({
      color: "#ffffff",
      vertexColors: true,
      toneMapped: false,
      side: THREE.DoubleSide,
    }),
  // Rolled-asphalt roof cap.
  roof: () =>
    withClonedPbr(
      new THREE.MeshStandardMaterial({ color: "#74767e", roughness: 0.96 }),
      "asphalt",
      3,
      3,
    ),
  wood: () => new THREE.MeshStandardMaterial({ color: "#4d3b2a", roughness: 0.85 }),
};

const sharedCache = new Map<string, THREE.Material>();

export function getSharedMaterial(key: string): THREE.Material {
  let mat = sharedCache.get(key);
  if (!mat) {
    const factory = SHARED_FACTORIES[key] ?? SHARED_FACTORIES.metalDark;
    mat = factory();
    sharedCache.set(key, mat);
  }
  return mat;
}

/** Resolve a building part material key (from building.ts) to a material. */
export function getBuildingMaterial(key: string, b: BuildingInstance): THREE.Material {
  if (key === "facade") {
    const rng = mulberry(b.style ^ 0x51ed270b);
    const tex = facadeTexture(b.archetype, rng());
    const variant = Math.floor(rng() * 8);
    const topY = 4.5 + (b.stories - 1) * 3;
    const cacheKey = `${tex}|${topY}|${variant}`;
    let mat = facadeCache.get(cacheKey);
    if (!mat) {
      mat = makeFacadeMaterial(tex, topY, variant);
      facadeCache.set(cacheKey, mat);
    }
    return mat;
  }
  return getSharedMaterial(key);
}
