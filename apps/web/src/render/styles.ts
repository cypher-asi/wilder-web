// Visual style system: named presets that swap the whole game look at
// runtime. "golden" is the physical golden-hour stack (takram atmosphere +
// volumetric clouds); the anime styles are painterly hand-painted skies with
// a much cheaper post stack (no AO, no volumetric clouds).
//
// Switching is uniform-driven for the ground/facade shaders (no recompile)
// plus a React remount of the lighting/sky/post components in Atmosphere.tsx.

import * as THREE from "three";
import { CHUNK_SIZE, REGION_CHUNKS } from "../net/protocol";

/** Max enemy regions the ground shader tints red at once. */
export const TERR_MAX = 48;

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
  "tron",
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
    fogColor: "#031014",
    fogDensity: 0.0026,
    envIntensity: 0.4,
    toon: 0,
    ground: { detail: 0, puddle: 0, wet: 0, sat: 0, tint: [1, 1, 1] },
    facade: { litBoost: 3.0, glowGain: 1.5, warmth: 0, tint: [1, 1, 1] },
    sky: {
      zenith: "#000406",
      mid: "#031418",
      horizon: "#0a4652",
      sunDir: dir(-0.5, 0.06, 0.3),
      sunColor: "#4fd0e0",
      sunHalo: 0.22,
      sunDisc: 0,
      moonDir: dir(0.45, 0.6, -0.4),
      moonColor: "#c9f3f8",
      moonAmt: 0,
      stars: 0.3,
      cloudCover: 0,
      cloudLit: "#0a3640",
      cloudShade: "#020a0d",
      cloudSharp: 0.3,
      envGround: "#020e11",
    },
    lights: {
      // Angled teal key strong enough to cast readable shadows on the
      // lifted slab albedo; the emissive lines still carry the frame.
      sunDir: dir(0.35, 0.75, -0.45),
      sunColor: "#63c2d4",
      sunIntensity: 1.3,
      hemiSky: "#0d353f",
      hemiGround: "#020c0e",
      hemiIntensity: 1.3,
      ambient: "#0e3e48",
      ambientIntensity: 0.4,
    },
    post: {
      // Low threshold + hot intensity: emissive lines bloom bright. Line
      // *width* is kept thin in the shader, so this glow reads as crisp
      // neon rather than fat lines.
      bloom: 2.1,
      bloomThreshold: 0.24,
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
  /** Shared clock driving the tron code-rain scroll (set by tickFacades). */
  uTronTime: { value: 0 },
  /** Camera-distance band (world m) over which tron rain buildings fade to
   * black. On a receding side-wall the iso-distance line reads as a vertical
   * seam sweeping horizontally, so the rain melts to solid black across the
   * building's own depth (front = rain, back = black) before the massing
   * hands off to the distant CityProxy skyline. Full rain at uTronFadeNear,
   * full black by uTronFadeFar. */
  uTronFadeNear: { value: 65 },
  uTronFadeFar: { value: 175 },
  /** Player world XZ, updated per-frame; fades the tron floor grid to black
   * away from the character (blue lines only; enemy-red lines stay full). */
  uPlayerPos: { value: new THREE.Vector2() },
  uGDetail: { value: 1 },
  uGPuddle: { value: 0 },
  uGWet: { value: 1 },
  uGSat: { value: 1 },
  uGTint: { value: new THREE.Color(1, 1, 1) },
  uFLitBoost: { value: 1 },
  uFGlowGain: { value: 1 },
  uFWarmth: { value: 0 },
  uFTint: { value: new THREE.Color(1, 1, 1) },
  // Territory control: enemy-held regions the ground grid tints red. Each
  // cell is (rx, rz, factionId, captureStartSeconds); the .w start time drives
  // the blue->faction crossfade when a cell newly flips (0 = already settled).
  uTerrCells: {
    value: Array.from({ length: TERR_MAX }, () => new THREE.Vector4()),
  },
  uTerrCount: { value: 0 },
  uRegionSize: { value: CHUNK_SIZE * REGION_CHUNKS },
  /** Seconds clock (performance.now/1000) for the territory capture crossfade. */
  uTerrTime: { value: 0 },
};

// ---------------------------------------------------------------------------
// Tron palette: shared by the shader branches (GLSL constants below) and the
// JS-side restyles (characters, props, ocean, city proxy).
// ---------------------------------------------------------------------------

/** Near-black blue slab color every tron surface collapses to. */
export const TRON_BASE = new THREE.Color("#020a0d");
/** Primary neon line color (display-referred; >1 values bloom). Sampled
 * from the reference wireframe-tunnel plate: teal-cyan line body #42a4b6
 * with #87e9f8 hot cores. */
export const TRON_BLUE = new THREE.Color("#4fd0e0");
/** White-hot core for the brightest accents. */
export const TRON_WHITE = new THREE.Color("#d6fbff");
/** Hostile neon: grid lines in enemy-controlled territory. */
export const TRON_RED = new THREE.Color("#ff2d5e");

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
 * Tron code-rain glyph field, shared by the procedural facade shader and the
 * GLB building-module materials: hash-only math (no texture fetches), glyph
 * columns scrolling down at per-column speeds, paragraph gating so faces
 * read as pages of code, and an fwidth LOD that collapses to a dim wash
 * before the lattice can shimmer. Expects `tU` (wall-tangent coordinate),
 * `tVw` (scrolled row coordinate) and `tFc` (face id) in scope; emits
 * `tCodeGlow`.
 */
export const TRON_CODE_GLSL = /* glsl */ `
float tCol = floor(tU / 0.22);
float tRow = floor(tVw);
float tBlk = floor(tU / 2.0);
float tOn = step(0.3, thash(vec2(tBlk * 3.1 + tFc, floor(tVw / 14.0))));
tOn *= step(fract(tU / 2.0), 0.15 + 0.85 * thash(vec2(tBlk + tFc, tRow * 0.37)));
// Kill ~half the columns outright (random per-column) so empty vertical
// lanes and larger dark voids open up instead of a full sheet of code.
tOn *= step(0.5, thash(vec2(tCol * 4.19 + tFc, 9.7)));
// More off-glyphs (was 0.42) → more dark gaps punched down each column.
float tGl = step(0.55, thash(vec2(tCol * 1.31 + tFc, tRow)));
vec2 tFr = vec2(fract(tU / 0.22), fract(tVw));
float tCellIn = step(0.14, tFr.x) * step(tFr.x, 0.86) * step(0.22, tFr.y) * step(tFr.y, 0.86);
float tLod = 1.0 - smoothstep(0.35, 1.0, fwidth(tU) / 0.22);
float tCode = mix(0.2 * tOn, tOn * tGl * tCellIn, tLod);
// Per-column base brightness: a wide, dark-skewed spread so whole columns
// read dim or bright rather than a uniform sheet.
float tColBr = 0.08 + 1.05 * pow(thash(vec2(tCol * 0.73 + tFc, 5.3)), 1.7);
// Per-cell brightness with a low floor for more dark speckle, scaled by the
// column so lit glyphs range from near-dark to hot.
float tBr = tColBr * (0.15 + 1.1 * thash(vec2(tCol, tRow) + tFc));
vec3 tCodeGlow = mix(TRON_BLUE, TRON_WHITE,
  step(0.94, thash(vec2(tCol * 2.17 + tFc, tRow * 0.91)))) * (tCode * tBr);
`;

/** Seedless hash used by the shared tron code field. */
export const TRON_HASH_GLSL = /* glsl */ `
float thash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
`;

export interface TronifyOptions {
  /**
   * Building-module GLBs: wall faces additionally run the scrolling code
   * field so imported towers match the procedural facade look.
   */
  codeRain?: boolean;
  /**
   * Emissive multiplier for the code field (default 1). The distant city
   * proxy uses a low gain so background massing reads as faint code ghosts
   * behind the bright streamed towers.
   */
  codeRainGain?: number;
}

/**
 * Wire a stock three.js material (Standard/Lambert/Basic — anything built on
 * the common shader chunks) into tron mode: albedo collapses to the flat
 * blue-black slab (no texture or vertex color reads through; only lighting
 * models the shape), and any authored emissive is remapped to the tron blue,
 * brightening toward white. A live uniform branch: visual no-op in every
 * other style.
 *
 * `cacheKey` must be unique per distinct pre-existing onBeforeCompile so
 * materials with different custom shader code never share a program.
 */
export function tronifyMaterial(
  mat: THREE.Material,
  cacheKey = "tron-std",
  opts: TronifyOptions = {},
): void {
  if (mat.userData.tronified) return;
  mat.userData.tronified = true;
  const codeRain = opts.codeRain === true;
  const codeGain = opts.codeRainGain ?? 1;
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    prev?.call(mat, shader, renderer);
    shader.uniforms.uTron = styleUniforms.uTron;
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\n" + TRON_DECLS)
      .replace(
        "#include <color_fragment>",
        /* glsl */ `#include <color_fragment>
if (uTron > 0.5) diffuseColor.rgb = TRON_BASE * 2.4;`,
      )
      .replace(
        "#include <emissivemap_fragment>",
        /* glsl */ `#include <emissivemap_fragment>
if (uTron > 0.5) {
  float tEl = dot(totalEmissiveRadiance, vec3(0.2126, 0.7152, 0.0722));
  totalEmissiveRadiance = mix(TRON_BLUE, TRON_WHITE, clamp(tEl - 1.0, 0.0, 1.0)) * tEl;
}`,
      );
    if (!codeRain) return;
    shader.uniforms.uTronTime = styleUniforms.uTronTime;
    shader.uniforms.uTronFadeNear = styleUniforms.uTronFadeNear;
    shader.uniforms.uTronFadeFar = styleUniforms.uTronFadeFar;
    // Instancing-aware world position varying (kit modules render through
    // InstancedMesh, so instanceMatrix must fold in). The wall normal is
    // derived per-fragment from position derivatives instead of a varying:
    // the city-proxy geometry ships no normal attribute at all.
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vTronW;")
      .replace(
        "#include <worldpos_vertex>",
        /* glsl */ `#include <worldpos_vertex>
{
  vec4 tW = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
    tW = instanceMatrix * tW;
  #endif
  vTronW = (modelMatrix * tW).xyz;
}`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        /* glsl */ `#include <common>
varying vec3 vTronW;
uniform float uTronTime;
uniform float uTronFadeNear;
uniform float uTronFadeFar;
${TRON_HASH_GLSL}`,
      )
      .replace(
        "if (uTron > 0.5) diffuseColor.rgb = TRON_BASE * 2.4;",
        /* glsl */ `if (uTron > 0.5) diffuseColor.rgb = TRON_BASE * 2.4
  * (1.0 - smoothstep(uTronFadeNear, uTronFadeFar, distance(vTronW, cameraPosition)));`,
      )
      .replace(
        "if (uTron > 0.5) {\n  float tEl",
        /* glsl */ `if (uTron > 0.5) {
  vec3 tWn = normalize(cross(dFdx(vTronW), dFdy(vTronW)));
  if (abs(tWn.y) < 0.5 && vTronW.y > 0.3) {
    float tU = (abs(tWn.x) > abs(tWn.z)) ? vTronW.z : vTronW.x;
    float tFc = (abs(tWn.x) > abs(tWn.z)) ? (2.0 + step(0.0, tWn.x)) : (7.0 + step(0.0, tWn.z));
    float tSpd = 1.5 + 3.5 * thash(vec2(floor(tU / 0.22), tFc));
    float tVw = -vTronW.y / 0.12 - uTronTime * tSpd;
    ${TRON_CODE_GLSL}
    float tFade = 1.0 - smoothstep(uTronFadeNear, uTronFadeFar, distance(vTronW, cameraPosition));
    totalEmissiveRadiance += (tCodeGlow * 1.5 + TRON_BLUE * 0.04) * ${codeGain.toFixed(3)} * tFade;
  }
  float tEl`,
      );
  };
  mat.customProgramCacheKey = () => cacheKey + (codeRain ? `-code${codeGain}` : "");
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
