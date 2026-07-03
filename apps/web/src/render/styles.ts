// Visual style system: named presets that swap the whole game look at
// runtime. "golden" is the physical golden-hour stack (takram atmosphere +
// volumetric clouds); the anime styles are painterly hand-painted skies with
// a much cheaper post stack (no AO, no volumetric clouds).
//
// Switching is uniform-driven for the ground/facade shaders (no recompile)
// plus a React remount of the lighting/sky/post components in Atmosphere.tsx.

import * as THREE from "three";

export type VisualStyleId =
  | "golden"
  | "blueHour"
  | "animeDusk"
  | "animeSunset"
  | "tron";

export const VISUAL_STYLE_IDS: VisualStyleId[] = [
  "golden",
  "blueHour",
  "animeDusk",
  "animeSunset",
];

/** Hand-painted sky dome parameters (anime styles only). */
export interface AnimeSkySpec {
  zenith: string;
  mid: string;
  horizon: string;
  /** Unit direction toward the sun (drives halo/disc + cloud underlighting). */
  sunDir: THREE.Vector3;
  sunColor: string;
  /** Wide warm glow around the sun direction. */
  sunHalo: number;
  /** Hot sun disc gain (0 = sun below horizon / hidden). */
  sunDisc: number;
  moonDir: THREE.Vector3;
  moonColor: string;
  moonAmt: number;
  stars: number;
  cloudCover: number;
  cloudLit: string;
  cloudShade: string;
  /** Coverage edge softness: smaller = harder painterly cloud edges. */
  cloudSharp: number;
  /** Ground bounce color for the PMREM environment capture. */
  envGround: string;
}

/** Light rig for anime styles (golden uses the physical SunLight/SkyLight). */
export interface AnimeLightsSpec {
  /** Unit direction from the scene toward the key light. */
  sunDir: THREE.Vector3;
  sunColor: string;
  sunIntensity: number;
  hemiSky: string;
  hemiGround: string;
  hemiIntensity: number;
  ambient: string;
  ambientIntensity: number;
}

export interface AnimePostSpec {
  bloom: number;
  bloomThreshold: number;
  saturation: number;
  brightness: number;
  contrast: number;
  vignette: number;
  /** Mount the N8AO pass (soft contact darkening; costs a bit of GPU). */
  ao?: boolean;
}

export interface VisualStyle {
  id: VisualStyleId;
  label: string;
  /** true = takram physical atmosphere path (golden). */
  physicalSky: boolean;
  /**
   * Tron mode: every material collapses to stark blue-black (no textures)
   * and all light comes from emissive blue/white lines — the ground grid,
   * road edges and markings, window frames, neon remapped to blue, and
   * character trim. Driven by the shared uTron uniform (live switch, and the
   * texture-heavy shader paths are skipped in uniform branches).
   */
  tron?: boolean;
  /**
   * Tone mapping exposure. Scene radiance is authored display-referred and
   * divided by this (see DISPLAY_TO_SCENE usage) so post tone mapping lands
   * colors back at their authored brightness.
   */
  exposure: number;
  fogColor: string;
  fogDensity: number;
  envIntensity: number;
  /** Soft luminance-band quantization amount (painterly light steps). */
  toon: number;
  ground: {
    /** 0 disables the expensive crack/stain/wear detail branches. */
    detail: number;
    /** Extra puddle coverage bias (0 = golden's baseline). */
    puddle: number;
    /** Rained-on wetness: darkens + polishes asphalt, damp sheen on stone. */
    wet: number;
    sat: number;
    tint: [number, number, number];
  };
  facade: {
    /** Multiplier on each building's lit-window ratio. */
    litBoost: number;
    glowGain: number;
    /** 0..1 pull of lit-window color toward warm amber interiors. */
    warmth: number;
    tint: [number, number, number];
  };
  sky?: AnimeSkySpec;
  lights?: AnimeLightsSpec;
  post?: AnimePostSpec;
}

const dir = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z).normalize();

export const STYLES: Record<VisualStyleId, VisualStyle> = {
  golden: {
    id: "golden",
    label: "GOLDEN HOUR",
    physicalSky: true,
    // Takram examples use ~10; lower keeps sun-facing surfaces inside AgX's
    // shoulder so facades/ground don't clip to white near the low sun.
    exposure: 5.0,
    fogColor: "#cfa07e",
    fogDensity: 0.0035,
    envIntensity: 0.6,
    toon: 0,
    ground: { detail: 1, puddle: 0, wet: 1, sat: 1, tint: [1, 1, 1] },
    facade: { litBoost: 1, glowGain: 1, warmth: 0, tint: [1, 1, 1] },
  },

  // Reference: dark blue-hour street photo bash — sun just under the horizon,
  // soft cool skylight only (no hard sun shadows), warm light coming almost
  // entirely from lit windows, storefronts and neon, wet dark asphalt and
  // big grimy stone slabs. Realistic grade: no toon banding, full ground
  // detail, AO on for grounded contact shadows.
  blueHour: {
    id: "blueHour",
    label: "BLUE HOUR",
    physicalSky: false,
    exposure: 1.25,
    fogColor: "#5a6488",
    fogDensity: 0.0032,
    envIntensity: 0.9,
    toon: 0,
    ground: { detail: 1, puddle: 0.14, wet: 1.7, sat: 0.92, tint: [0.97, 0.99, 1.06] },
    facade: { litBoost: 4.5, glowGain: 1.3, warmth: 0.75, tint: [0.96, 0.97, 1.03] },
    sky: {
      zenith: "#1c2438",
      mid: "#4a4f6e",
      horizon: "#e8926a",
      sunDir: dir(-0.7, 0.015, 0.3),
      sunColor: "#ff9e64",
      sunHalo: 0.35,
      sunDisc: 0,
      moonDir: dir(0.45, 0.6, -0.4),
      moonColor: "#ffedb8",
      moonAmt: 0,
      stars: 0.25,
      cloudCover: 0.4,
      cloudLit: "#8a7288",
      cloudShade: "#2c3350",
      cloudSharp: 0.3,
      envGround: "#4a3a34",
    },
    lights: {
      // Weak cool key from high overhead: shadows read as soft occlusion,
      // not sun shadows. Warm hemisphere ground bounce = city glow.
      sunDir: dir(0.15, 0.85, -0.25),
      sunColor: "#9aa8d4",
      sunIntensity: 1.4,
      hemiSky: "#6d7cb0",
      hemiGround: "#7a6252",
      hemiIntensity: 1.7,
      ambient: "#ffcfa0",
      ambientIntensity: 0.3,
    },
    post: {
      bloom: 1.0,
      bloomThreshold: 0.6,
      saturation: -0.05,
      brightness: 0.0,
      contrast: 0.08,
      vignette: 0.5,
      ao: true,
    },
  },

  // Reference 1: lofi dusk — deep blue starry zenith, pink/peach horizon,
  // big pale moon, cool moonlight key with warm window glow everywhere.
  animeDusk: {
    id: "animeDusk",
    label: "ANIME DUSK",
    physicalSky: false,
    exposure: 1.25,
    fogColor: "#7a80c0",
    fogDensity: 0.0026,
    envIntensity: 0.75,
    toon: 0.3,
    ground: { detail: 0, puddle: 0.1, wet: 0.5, sat: 1.05, tint: [0.98, 0.99, 1.04] },
    facade: { litBoost: 4.5, glowGain: 1.0, warmth: 0.3, tint: [0.97, 0.98, 1.05] },
    sky: {
      zenith: "#131f5e",
      mid: "#3f58bd",
      horizon: "#ff9a66",
      sunDir: dir(-0.7, 0.02, 0.3),
      sunColor: "#ffbe8a",
      sunHalo: 0.3,
      sunDisc: 0,
      moonDir: dir(0.45, 0.6, -0.4),
      moonColor: "#ffedb8",
      moonAmt: 1,
      stars: 1,
      cloudCover: 0.32,
      cloudLit: "#f0a0b4",
      cloudShade: "#46589e",
      cloudSharp: 0.2,
      envGround: "#383455",
    },
    lights: {
      sunDir: dir(0.45, 0.6, -0.4),
      sunColor: "#b9c4ff",
      sunIntensity: 2.2,
      hemiSky: "#7a88e0",
      hemiGround: "#b07888",
      hemiIntensity: 1.5,
      ambient: "#ffd0b0",
      ambientIntensity: 0.42,
    },
    post: {
      bloom: 0.9,
      bloomThreshold: 0.72,
      saturation: 0.22,
      brightness: 0.01,
      contrast: 0.1,
      vignette: 0.42,
    },
  },

  // Reference 2: blazing sunset — dense red/orange clouds lit from below
  // against a purple-grey upper sky, hot low sun, mirror-wet streets.
  animeSunset: {
    id: "animeSunset",
    label: "ANIME SUNSET",
    physicalSky: false,
    exposure: 1.25,
    // Muted warm haze: the red belongs in the sky/clouds; saturated red fog
    // drowns the whole street level.
    fogColor: "#8a6058",
    fogDensity: 0.0022,
    envIntensity: 0.8,
    toon: 0.3,
    ground: { detail: 0, puddle: 0.16, wet: 0.6, sat: 1.0, tint: [1.0, 0.98, 0.98] },
    facade: { litBoost: 4.0, glowGain: 1.15, warmth: 0.3, tint: [0.96, 0.94, 1.02] },
    sky: {
      zenith: "#443c66",
      mid: "#75465e",
      horizon: "#ff5e22",
      sunDir: dir(-0.7, 0.06, 0.3),
      sunColor: "#ffb060",
      sunHalo: 0.6,
      sunDisc: 1.4,
      moonDir: dir(0.45, 0.6, -0.4),
      moonColor: "#ffedb8",
      moonAmt: 0,
      stars: 0.12,
      cloudCover: 0.46,
      cloudLit: "#ff8438",
      cloudShade: "#42304e",
      cloudSharp: 0.16,
      envGround: "#4c3230",
    },
    lights: {
      // Warm key stays, but the fill goes purple-grey so facades model like
      // the reference instead of glowing uniformly red.
      sunDir: dir(-0.7, 0.16, 0.3),
      sunColor: "#ffa060",
      sunIntensity: 2.4,
      hemiSky: "#8a7498",
      hemiGround: "#b08068",
      hemiIntensity: 1.5,
      ambient: "#f0c8a8",
      ambientIntensity: 0.45,
    },
    post: {
      bloom: 0.9,
      bloomThreshold: 0.72,
      saturation: 0.12,
      brightness: 0.0,
      contrast: 0.1,
      vignette: 0.42,
    },
  },

  // Reference: Tron-style wireframe city — stark black world, every surface
  // a near-black blue slab, all light coming from emissive cyan/blue lines
  // (ground grid, road edge circuits, window frames, neon) with white-hot
  // cores under heavy bloom. Cheapest style in the game: the tron shader
  // branches skip every texture fetch and grunge computation.
  tron: {
    id: "tron",
    label: "TRON",
    physicalSky: false,
    tron: true,
    exposure: 1.1,
    fogColor: "#020a16",
    fogDensity: 0.0026,
    envIntensity: 0.4,
    toon: 0,
    ground: { detail: 0, puddle: 0, wet: 0, sat: 0, tint: [1, 1, 1] },
    facade: { litBoost: 3.0, glowGain: 1.5, warmth: 0, tint: [1, 1, 1] },
    sky: {
      zenith: "#000307",
      mid: "#020c1c",
      horizon: "#0a3a68",
      sunDir: dir(-0.5, 0.06, 0.3),
      sunColor: "#39c8ff",
      sunHalo: 0.22,
      sunDisc: 0,
      moonDir: dir(0.45, 0.6, -0.4),
      moonColor: "#bfe8ff",
      moonAmt: 0,
      stars: 0.3,
      cloudCover: 0,
      cloudLit: "#0a2a4a",
      cloudShade: "#02060e",
      cloudSharp: 0.3,
      envGround: "#020810",
    },
    lights: {
      // Dim cool overhead key: shadows read as soft occlusion. The emissive
      // line work is the real light source of the frame.
      sunDir: dir(0.2, 0.85, -0.3),
      sunColor: "#4aa8ff",
      sunIntensity: 0.55,
      hemiSky: "#0c2444",
      hemiGround: "#020610",
      hemiIntensity: 0.9,
      ambient: "#0d2a50",
      ambientIntensity: 0.3,
    },
    post: {
      // Low bloom threshold: every emissive line crosses it and halos.
      bloom: 1.35,
      bloomThreshold: 0.32,
      saturation: 0.12,
      brightness: 0.0,
      contrast: 0.12,
      vignette: 0.55,
    },
  },
};

// ---------------------------------------------------------------------------
// Shared shader uniforms (ground + facade), swapped live by applyStyle.
// ---------------------------------------------------------------------------

export const styleUniforms = {
  uStyleToon: { value: 0 },
  uStyleExposure: { value: STYLES.golden.exposure },
  uTron: { value: 0 },
  uGDetail: { value: 1 },
  uGPuddle: { value: 0 },
  uGWet: { value: 1 },
  uGSat: { value: 1 },
  uGTint: { value: new THREE.Color(1, 1, 1) },
  uFLitBoost: { value: 1 },
  uFGlowGain: { value: 1 },
  uFWarmth: { value: 0 },
  uFTint: { value: new THREE.Color(1, 1, 1) },
};

// ---------------------------------------------------------------------------
// Tron palette: shared by the shader branches (GLSL constants below) and the
// JS-side restyles (characters, props, ocean, city proxy).
// ---------------------------------------------------------------------------

/** Near-black blue slab color every tron surface collapses to. */
export const TRON_BASE = new THREE.Color("#02060e");
/** Primary neon line blue (display-referred; >1 values bloom). */
export const TRON_BLUE = new THREE.Color("#2fb8ff");
/** White-hot core for the brightest accents. */
export const TRON_WHITE = new THREE.Color("#dff6ff");

/** True when the given style id renders the tron look. */
export function isTronStyle(id: VisualStyleId): boolean {
  return STYLES[id].tron === true;
}

/** GLSL for the tron uniform + palette constants (linear working space). */
export const TRON_DECLS = /* glsl */ `
uniform float uTron;
const vec3 TRON_BASE = vec3(${TRON_BASE.r.toFixed(5)}, ${TRON_BASE.g.toFixed(5)}, ${TRON_BASE.b.toFixed(5)});
const vec3 TRON_BLUE = vec3(${TRON_BLUE.r.toFixed(5)}, ${TRON_BLUE.g.toFixed(5)}, ${TRON_BLUE.b.toFixed(5)});
const vec3 TRON_WHITE = vec3(${TRON_WHITE.r.toFixed(5)}, ${TRON_WHITE.g.toFixed(5)}, ${TRON_WHITE.b.toFixed(5)});
`;

/**
 * Wire a stock three.js material (Standard/Lambert/Basic — anything built on
 * the common shader chunks) into tron mode: albedo collapses onto the
 * blue-black slab (keeping the texture's luminance so shapes still model),
 * and any authored emissive is remapped to the tron blue, brightening toward
 * white. A live uniform branch: zero-cost visual no-op in every other style.
 *
 * `cacheKey` must be unique per distinct pre-existing onBeforeCompile so
 * materials with different custom shader code never share a program.
 */
export function tronifyMaterial(mat: THREE.Material, cacheKey = "tron-std"): void {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    prev?.call(mat, shader, renderer);
    shader.uniforms.uTron = styleUniforms.uTron;
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\n" + TRON_DECLS)
      .replace(
        "#include <color_fragment>",
        /* glsl */ `#include <color_fragment>
if (uTron > 0.5) {
  float tLum = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
  diffuseColor.rgb = TRON_BASE * (0.35 + 2.4 * tLum);
}`,
      )
      .replace(
        "#include <emissivemap_fragment>",
        /* glsl */ `#include <emissivemap_fragment>
if (uTron > 0.5) {
  float tEl = dot(totalEmissiveRadiance, vec3(0.2126, 0.7152, 0.0722));
  totalEmissiveRadiance = mix(TRON_BLUE, TRON_WHITE, clamp(tEl - 1.0, 0.0, 1.0)) * tEl;
}`,
      );
  };
  mat.customProgramCacheKey = () => cacheKey;
}

/** GLSL declarations for the toon/style uniforms shared by both shaders. */
export const STYLE_TOON_DECLS = /* glsl */ `
uniform float uStyleToon;
uniform float uStyleExposure;
${TRON_DECLS}
`;

/**
 * Soft luminance quantization applied to the lit color just before output:
 * banding the display-space luminance into steps gives the painterly "cel
 * wash" without touching chroma. Injected in front of <opaque_fragment>.
 */
export const STYLE_TOON_APPLY = /* glsl */ `
if (uStyleToon > 0.001) {
  float tLum = dot(outgoingLight, vec3(0.2126, 0.7152, 0.0722)) * uStyleExposure;
  float tBands = 5.0;
  float tQ = (floor(tLum * tBands) + smoothstep(0.3, 0.7, fract(tLum * tBands))) / tBands;
  outgoingLight *= mix(1.0, tQ / max(tLum, 1e-3), uStyleToon);
}
#include <opaque_fragment>
`;

/** Values read per-frame outside React (CameraRig fog thinning). */
export const styleRuntime = {
  fogBaseDensity: STYLES.golden.fogDensity,
};

/** Push a style's values into the shared shader uniforms + runtime knobs. */
export function applyStyle(style: VisualStyle): void {
  const u = styleUniforms;
  u.uStyleToon.value = style.toon;
  u.uStyleExposure.value = style.exposure;
  u.uTron.value = style.tron ? 1 : 0;
  u.uGDetail.value = style.ground.detail;
  u.uGPuddle.value = style.ground.puddle;
  u.uGWet.value = style.ground.wet;
  u.uGSat.value = style.ground.sat;
  u.uGTint.value.setRGB(...style.ground.tint);
  u.uFLitBoost.value = style.facade.litBoost;
  u.uFGlowGain.value = style.facade.glowGain;
  u.uFWarmth.value = style.facade.warmth;
  u.uFTint.value.setRGB(...style.facade.tint);
  styleRuntime.fogBaseDensity = style.fogDensity;
}
