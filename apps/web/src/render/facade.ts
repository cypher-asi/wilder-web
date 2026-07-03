// Building materials: a PBR facade shader (world-space tiling, procedural lit
// windows, grime) plus a shared cache of simple materials so hundreds of
// building meshes reuse a handful of GPU programs.

import * as THREE from "three";
import { getPbrTextureSet } from "../assets/catalog";
import { BuildingInstance } from "../net/protocol";
import {
  STYLE_TOON_APPLY,
  STYLE_TOON_DECLS,
  styleUniforms,
  TRON_CODE_GLSL,
  TRON_DECLS,
  TRON_HASH_GLSL,
  tronifyMaterial,
} from "./styles";

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
  // Same clock drives the code rain on imported building-module materials.
  styleUniforms.uTronTime.value = elapsed;
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
uniform float uFLitBoost;
uniform float uFGlowGain;
uniform float uFWarmth;
uniform vec3 uFTint;
uniform float uTronFadeNear;
uniform float uTronFadeFar;
${STYLE_TOON_DECLS}
${TRON_HASH_GLSL}
float fhash(vec2 p) {
  return fract(sin(dot(p + uSeed, vec2(127.1, 311.7))) * 43758.5453);
}
float fnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(fhash(i), fhash(i + vec2(1.0, 0.0)), u.x),
    mix(fhash(i + vec2(0.0, 1.0)), fhash(i + vec2(1.0, 1.0)), u.x),
    u.y);
}
`;

// Tint + grime after albedo sampling, and the upper-story window grid:
// 1.4 m x 3.0 m cells starting above the 4.5 m ground floor. Unlit cells read
// as dark glass (albedo swap); lit cells add warm/cool emissive with per-cell
// brightness and rare flicker.
const FACADE_FRAG_MAP = /* glsl */ `
#include <map_fragment>
vec3 fGlow = vec3(0.0);
if (uTron > 0.5) {
  // TRON: glowing data-towers. Every wall face carries columns of "code"
  // glyphs scrolling downward (pure hash math — zero texture fetches, no
  // extra geometry), under a hot roofline outline and a faint volume wash
  // so the massing reads as a glowing glass cube.
  vec3 fWn = normalize(vFWorldNormal);
  float fy = vFWorldPos.y - 0.14;
  // Lifted slab albedo: bright enough for the light rig to shade the faces
  // (sun side vs shadow side), still far below the emissive line work.
  diffuseColor.rgb = TRON_BASE * 2.4;
  if (abs(fWn.y) < 0.5) {
    float fu = (abs(fWn.x) > abs(fWn.z)) ? vFWorldPos.z : vFWorldPos.x;
    float fFace = (abs(fWn.x) > abs(fWn.z)) ? (2.0 + step(0.0, fWn.x)) : (7.0 + step(0.0, fWn.z));
    if (fy > 0.3 && fy < uTopY - 0.25) {
      // Shared code-rain field (see TRON_CODE_GLSL): 0.22 m glyph columns x
      // 0.12 m rows, whole columns scrolling down at per-column speeds,
      // paragraph-gated, with an fwidth LOD to a dim wash on far towers.
      float tU = fu;
      float tFc = fFace + uSeed;
      float tSpd = 1.5 + 3.5 * thash(vec2(floor(tU / 0.22), tFc));
      float tVw = (uTopY - fy) / 0.12 - uFTime * tSpd;
      ${TRON_CODE_GLSL}
      fGlow += tCodeGlow * 1.5 * uFGlowGain;
    }
    // Faint volume wash: the whole face self-glows so towers read as
    // luminous cubes against the black sky, brightening toward the top.
    fGlow += TRON_BLUE * (0.015 + 0.035 * smoothstep(0.0, uTopY, fy));
    // Parapet outline: the glowing roofline that draws the skyline, plus a
    // wide halo washing down the top of the face.
    float fTopD = abs(fy - uTopY);
    fGlow += mix(TRON_BLUE, TRON_WHITE, 0.4)
      * ((1.0 - smoothstep(0.03, 0.14, fTopD)) * 2.4
        + (1.0 - smoothstep(0.0, 1.6, fTopD)) * 0.18);
  }
  // Distance fade: rain towers dim to black toward the far field so the
  // streamed massing melts into the distant CityProxy skyline.
  float fFade = 1.0 - smoothstep(uTronFadeNear, uTronFadeFar, distance(vFWorldPos, cameraPosition));
  fGlow *= fFade;
  diffuseColor.rgb *= fFade;
} else {
  vec3 fWn = normalize(vFWorldNormal);
  float fy = vFWorldPos.y - 0.14; // buildings sit on raised tiles (GROUND_Y)
  diffuseColor.rgb *= uTint * uFTint;
  // Splash-back band at street level + parapet weathering up top.
  float fGrime = mix(0.48, 1.0, smoothstep(0.05, 6.0, fy));
  fGrime *= 1.0 - 0.28 * smoothstep(uTopY - 2.2, uTopY - 0.3, fy);
  if (abs(fWn.y) < 0.5) {
    float fu = (abs(fWn.x) > abs(fWn.z)) ? vFWorldPos.z : vFWorldPos.x;
    fGrime *= 0.86 + 0.14 * fhash(vec2(floor(fu * 1.7), 3.7));
    // Patchy weathering blotches (water staining, repaired mortar) plus
    // pale efflorescence bloom on the lower stories.
    float fBlotch = smoothstep(0.55, 0.82, fnoise(vec2(fu * 0.33, fy * 0.33) + 17.0));
    fGrime *= 1.0 - 0.2 * fBlotch;
    float fEff = smoothstep(0.6, 0.85, fnoise(vec2(fu * 0.5, fy * 0.5) + 43.0))
      * (1.0 - smoothstep(2.5, 8.0, fy));
    diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 1.25 + 0.025, 0.55 * fEff);
    float fFace = (abs(fWn.x) > abs(fWn.z)) ? (2.0 + step(0.0, fWn.x)) : (7.0 + step(0.0, fWn.z));
    float fv = fy - 4.5;
    if (fv > 0.12 && fy < uTopY - 0.5) {
      vec2 fCell = vec2(floor(fu / 1.4), floor(fv / 3.0));
      vec2 fFr = vec2(fract(fu / 1.4), fract(fv / 3.0));
      float fIn = step(0.26, fFr.x) * step(fFr.x, 0.74) * step(0.25, fFr.y) * step(fFr.y, 0.7);
      // Style boost: anime presets light far more windows (warm interiors).
      float fRatio = clamp(uLitRatio * uFLitBoost, 0.0, 0.6);
      float fLit = step(1.0 - fRatio, fhash(fCell * 1.13 + fFace));
      // uFWarmth pulls the whole mix toward amber interiors (blue-hour mood
      // where window light is the main warm source in the frame).
      float fWarmMix = clamp(fhash(fCell + fFace + 3.0) * 0.75 + uFWarmth, 0.0, 1.0);
      vec3 fCol = mix(uWinColor, vec3(1.0, 0.78, 0.48), fWarmMix);
      float fBr = 0.5 + 0.95 * fhash(fCell + fFace + 11.0);
      float fFl = fhash(fCell + fFace + 23.0);
      float fFlick = 1.0;
      if (fFl > 0.93) fFlick = 0.72 + 0.28 * sin(uFTime * (2.0 + 6.0 * fFl) + fFl * 40.0);
      fGlow = fCol * (fIn * fLit * fBr * fFlick * 1.35 * uFGlowGain);
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.012, 0.015, 0.02), fIn);
      // Rain streaks running down from window sills (~45% of windows):
      // strongest right under the sill, fading toward the cell bottom.
      float fSel = step(0.55, fhash(fCell + fFace + 31.0));
      float fInX = step(0.28, fFr.x) * step(fFr.x, 0.72);
      float fColN = 0.5 + 0.5 * fhash(vec2(floor(fFr.x * 9.0), fCell.x * 13.0 + fCell.y));
      float fBelow = step(fFr.y, 0.25) * (fFr.y / 0.25);
      fGrime *= 1.0 - 0.4 * fSel * fInX * fColN * fBelow;
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
  // Per-variant value jitter widens the brick/concrete tone spread so
  // neighbouring buildings with the same texture don't match.
  const jitter = 0.82 + 0.36 * ((variant * 2.6179) % 1);
  const uniforms = {
    uTint: {
      value: FACADE_TINTS[variant % FACADE_TINTS.length].clone().multiplyScalar(jitter),
    },
    uWinColor: { value: WINDOW_COLORS[variant % WINDOW_COLORS.length] },
    // Dusk: a modest scatter of early-evening windows are lit.
    uLitRatio: { value: 0.08 + 0.05 * (variant % 3) },
    uTopY: { value: topY },
    uSeed: { value: (variant * 7.31) % 10 },
    uFTime: timeUniform,
  };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms, styleUniforms);
    shader.vertexShader =
      FACADE_VERT_HEADER +
      shader.vertexShader.replace("#include <worldpos_vertex>", FACADE_VERT_WORLDPOS);
    shader.fragmentShader =
      FACADE_FRAG_HEADER +
      shader.fragmentShader
        .replace("#include <map_fragment>", FACADE_FRAG_MAP)
        .replace("#include <emissivemap_fragment>", FACADE_FRAG_EMISSIVE)
        .replace("#include <opaque_fragment>", STYLE_TOON_APPLY);
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
  // Tron remaps the baked multi-hue palette to blue (white-hot when bright)
  // while preserving each sign's luminance, so no geometry rebuild is needed.
  neon: () => {
    const mat = new THREE.MeshBasicMaterial({
      color: "#ffffff",
      vertexColors: true,
      toneMapped: false,
      side: THREE.DoubleSide,
    });
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTron = styleUniforms.uTron;
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", "#include <common>\n" + TRON_DECLS)
        .replace(
          "#include <color_fragment>",
          /* glsl */ `#include <color_fragment>
if (uTron > 0.5) {
  float nLum = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
  diffuseColor.rgb = mix(TRON_BLUE, TRON_WHITE, smoothstep(1.2, 2.4, nLum)) * nLum * 1.25;
}`,
        );
    };
    mat.customProgramCacheKey = () => "tron-neon";
    return mat;
  },
  // Storefront backdrop fills (ground-floor window interiors, sidewalk light
  // spill, fascia shop-sign faces). Off-tron this is emissive-only and reads
  // exactly like `neon`. In tron the bright cyan fill collapses to a dark
  // glossy reflective slab (real scene.environment reflection) with a thin
  // neon keyline traced around the panel border, so storefronts read as black
  // glass instead of glowing blue while the sign edge/text stays legible.
  glowPanel: () => {
    const mat = new THREE.MeshStandardMaterial({
      color: "#ffffff",
      vertexColors: true,
      toneMapped: false,
      side: THREE.DoubleSide,
      roughness: 0.08,
      metalness: 1.0,
      envMapIntensity: 1.2,
    });
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTron = styleUniforms.uTron;
      shader.vertexShader = shader.vertexShader
        .replace(
          "#include <common>",
          "#include <common>\nattribute vec2 uv;\nvarying vec2 vGpUv;",
        )
        .replace("#include <begin_vertex>", "#include <begin_vertex>\nvGpUv = uv;");
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          "#include <common>\n" + TRON_DECLS + "\nvarying vec2 vGpUv;",
        )
        .replace(
          "#include <metalnessmap_fragment>",
          /* glsl */ `#include <metalnessmap_fragment>
vec3 gpColor = diffuseColor.rgb;
if (uTron > 0.5) {
  diffuseColor.rgb = TRON_BASE;
  roughnessFactor = 0.08;
  metalnessFactor = 1.0;
} else {
  diffuseColor.rgb = vec3(0.0);
  roughnessFactor = 1.0;
  metalnessFactor = 0.0;
}`,
        )
        .replace(
          "#include <emissivemap_fragment>",
          /* glsl */ `#include <emissivemap_fragment>
if (uTron > 0.5) {
  vec2 gpB = min(vGpUv, 1.0 - vGpUv);
  float gpEdge = 1.0 - smoothstep(0.0, 0.05, min(gpB.x, gpB.y));
  totalEmissiveRadiance += mix(TRON_BLUE, TRON_WHITE, 0.25) * gpEdge * 1.6;
} else {
  totalEmissiveRadiance += gpColor;
}`,
        );
    };
    mat.customProgramCacheKey = () => "tron-glowpanel";
    return mat;
  },
  // Sideways-projecting blade/hanging shop signs: emissive neon faces off-tron,
  // fully discarded in tron (the whole sign vanishes) so the wireframe city
  // isn't cluttered with blue blades hanging over the street.
  bladeNeon: () => {
    const mat = new THREE.MeshBasicMaterial({
      color: "#ffffff",
      vertexColors: true,
      toneMapped: false,
      side: THREE.DoubleSide,
    });
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTron = styleUniforms.uTron;
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", "#include <common>\nuniform float uTron;")
        .replace(
          "#include <color_fragment>",
          "if (uTron > 0.5) discard;\n#include <color_fragment>",
        );
    };
    mat.customProgramCacheKey = () => "tron-bladeneon";
    return mat;
  },
  // Metal armature/backing for the blade signs above: reads as dark metal
  // off-tron, discarded alongside the neon faces in tron.
  bladeMetal: () => {
    const mat = new THREE.MeshStandardMaterial({
      color: "#1c1e22",
      roughness: 0.5,
      metalness: 0.75,
    });
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTron = styleUniforms.uTron;
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", "#include <common>\nuniform float uTron;")
        .replace(
          "#include <clipping_planes_fragment>",
          "#include <clipping_planes_fragment>\nif (uTron > 0.5) discard;",
        );
    };
    mat.customProgramCacheKey = () => "tron-blademetal";
    return mat;
  },
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
    // Neon and glowPanel install their own tron branch; glass is already a
    // dark glossy PBR surface that reads as black glass in tron, so it must
    // not be flattened to the slab. Everything else collapses to the flat
    // blue-black slab in tron mode.
    if (
      key !== "neon" &&
      key !== "glowPanel" &&
      key !== "glass" &&
      key !== "bladeNeon" &&
      key !== "bladeMetal"
    ) {
      tronifyMaterial(mat);
    }
    sharedCache.set(key, mat);
  }
  return mat;
}

/** Resolve a building part material key (from building.ts) to a material.
 * A "#hide" suffix marks parts hidden in TRON (see building.ts HIDE); it never
 * changes the material, only whether Buildings.tsx renders the mesh in tron. */
export function getBuildingMaterial(key: string, b: BuildingInstance): THREE.Material {
  const base = key.split("#")[0];
  if (base === "facade") {
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
  return getSharedMaterial(base);
}
