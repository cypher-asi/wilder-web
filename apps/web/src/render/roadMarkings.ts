// Painted road markings generated from the baked city tile grid. Wiami's
// streets are real boulevards (17-37 m curb to curb, 2 m tile quantized), so
// each road cross-section is classified from the global grid and painted with
// a fixed 3.5 m lane module: curbside parking lanes, dashed white dividers,
// a double-yellow center (or a painted median on the widest avenues), plus
// stop lines and zebra crosswalks at intersection approaches. Everything is
// a pure function of the global grid and gets clipped to the chunk, so
// markings seam exactly across chunk borders.

import * as THREE from "three";
import { CITY_ROAD, CITY_ROAD_LINE, cityTileAt } from "../game/citymap";
import { groundTextureUniforms } from "./groundShader";
import { styleUniforms, TRON_DECLS } from "./styles";
import { LANE_WIDTH, MARKING_WIDTH, PARKING_LANE_WIDTH } from "../game/scale";
import { CHUNK_SIZE, ChunkData, TILE_SIZE, TILES_PER_CHUNK } from "../net/protocol";

/** Cross-sections wider than this many tiles are open pavement (intersection
 * interiors, plazas) and get no longitudinal lines. Widest streets ~38 m. */
const WIDE = 26;
/** Dashed divider: painted length and repeat period (meters, world-phased). */
const DASH_ON = 3;
const DASH_PERIOD = 6;
/** Crosswalk zebra: bar size/pitch and depth of the crossing band. */
const ZEBRA_BAR = 0.6;
const ZEBRA_PITCH = 1.2;
const ZEBRA_DEPTH = 3.0;
/** Longitudinal lines stop this far short of an intersection boundary so the
 * stop line + crosswalk band stays clean. */
const APPROACH_DEPTH = 4.5;
/** Painted medians narrower than this collapse to a plain double yellow. */
const MEDIAN_MIN = 1.2;

const WHITE = 0;
const YELLOW = 1;

const COLORS: THREE.Color[] = [
  new THREE.Color("#cfcfc6").convertSRGBToLinear(),
  new THREE.Color("#c69c33").convertSRGBToLinear(),
];

/** Height of paint above road grade (manholes render above this). */
const PAINT_Y = 0.006;

interface Run {
  /** Inclusive tile extents of the contiguous road run. */
  u0: number;
  u1: number;
  /** Run length in tiles; WIDE + 1 means "wider than WIDE" (capped scan). */
  len: number;
}

export interface LaneLayout {
  lanesPerDir: number;
  /** Marked curbside parking lane width (0 = unmarked gutter only). */
  parking: number;
  /** Total painted median width; 0.3 means plain double yellow. */
  medianW: number;
  /** Unmarked strip between curb and the outermost line. */
  gutter: number;
}

/**
 * Split a curb-to-curb width into travel lanes at a fixed LANE_WIDTH, with
 * the remainder becoming parking lanes and (on the widest avenues) a painted
 * median. Lane size never changes; road width changes the lane count.
 */
export function laneLayout(widthTiles: number): LaneLayout {
  const w = widthTiles * TILE_SIZE;
  let lanesPerDir = Math.max(1, Math.floor((w - 1) / (2 * LANE_WIDTH)));
  let leftover = w - lanesPerDir * 2 * LANE_WIDTH;
  // On multi-lane avenues, trade one lane pair for parking + median rather
  // than painting wall-to-wall travel lanes.
  if (leftover < 3.4 && lanesPerDir >= 3) {
    lanesPerDir -= 1;
    leftover += 2 * LANE_WIDTH;
  }
  let parking = 0;
  let medianW = 0.3;
  if (leftover >= 5.5) {
    const rest = leftover - 2 * PARKING_LANE_WIDTH;
    if (rest >= MEDIAN_MIN) {
      parking = PARKING_LANE_WIDTH;
      medianW = rest;
    } else {
      parking = (leftover - medianW) / 2;
    }
  } else if (leftover >= 3.4) {
    parking = (leftover - medianW) / 2;
  }
  const gutter = (w - 2 * parking - lanesPerDir * 2 * LANE_WIDTH - medianW) / 2;
  return { lanesPerDir, parking, medianW, gutter };
}

interface Rect {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  color: number;
}

class MarkingPass {
  private runCache = new Map<number, Run>();
  constructor(
    private axisZ: boolean,
    private rects: Rect[],
    private chunkX0: number,
    private chunkZ0: number,
  ) {}

  private isRoad(u: number, v: number): boolean {
    const k = this.axisZ ? cityTileAt(u, v) : cityTileAt(v, u);
    return k === CITY_ROAD || k === CITY_ROAD_LINE;
  }

  /** Contiguous road run along u through (u, v), scan capped at WIDE + 1. */
  private runU(u: number, v: number): Run {
    const key = v * 100000 + u;
    const hit = this.runCache.get(key);
    if (hit) return hit;
    let u0 = u;
    let u1 = u;
    while (u - u0 < WIDE + 1 && this.isRoad(u0 - 1, v)) u0--;
    while (u1 - u < WIDE + 1 && this.isRoad(u1 + 1, v)) u1++;
    const run = { u0, u1, len: Math.min(u1 - u0 + 1, WIDE + 1) };
    for (let i = u0; i <= u1; i++) this.runCache.set(v * 100000 + i, run);
    return run;
  }

  /** Length (tiles, capped) of the road run along v through (u, v). */
  private runVLen(u: number, v: number): number {
    let n = 1;
    for (let k = 1; k <= WIDE + 1 && this.isRoad(u, v - k); k++) n++;
    for (let k = 1; k <= WIDE + 1 && this.isRoad(u, v + k); k++) n++;
    return Math.min(n, WIDE + 2);
  }

  /** Emit an axis-space rect (meters), mapped to world and chunk-clipped. */
  private rect(ua: number, ub: number, va: number, vb: number, color: number) {
    let x0 = this.axisZ ? ua : va;
    let x1 = this.axisZ ? ub : vb;
    let z0 = this.axisZ ? va : ua;
    let z1 = this.axisZ ? vb : ub;
    x0 = Math.max(x0 - this.chunkX0, 0);
    x1 = Math.min(x1 - this.chunkX0, CHUNK_SIZE);
    z0 = Math.max(z0 - this.chunkZ0, 0);
    z1 = Math.min(z1 - this.chunkZ0, CHUNK_SIZE);
    if (x1 - x0 < 1e-4 || z1 - z0 < 1e-4) return;
    this.rects.push({ x0, x1, z0, z1, color });
  }

  /** Solid line centered at u = pos, spanning v in [v0, v1]. */
  private solid(pos: number, v0: number, v1: number, color: number) {
    if (v1 <= v0) return;
    this.rect(pos - MARKING_WIDTH / 2, pos + MARKING_WIDTH / 2, v0, v1, color);
  }

  /** Dashed line, world-phased along v so chunks and rows seam. */
  private dashed(pos: number, v0: number, v1: number, color: number) {
    let p = Math.floor(v0 / DASH_PERIOD) * DASH_PERIOD;
    for (; p < v1; p += DASH_PERIOD) {
      const a = Math.max(v0, p);
      const b = Math.min(v1, p + DASH_ON);
      if (b > a) this.rect(pos - MARKING_WIDTH / 2, pos + MARKING_WIDTH / 2, a, b, color);
    }
  }

  /**
   * Stop line + zebra crosswalk for an approach. boundary = v (meters) where
   * the intersection pavement starts; dir = +1 when the intersection is at
   * +v (traffic moving +v stops here), -1 when at -v.
   */
  private approach(run: Run, boundary: number, dir: number) {
    const u0m = run.u0 * TILE_SIZE;
    const u1m = (run.u1 + 1) * TILE_SIZE;
    const inset = 0.4;
    const zebraNear = boundary - dir * 0.3;
    const zebraFar = boundary - dir * (0.3 + ZEBRA_DEPTH);
    const za = Math.min(zebraNear, zebraFar);
    const zb = Math.max(zebraNear, zebraFar);
    let bu = Math.ceil((u0m + inset) / ZEBRA_PITCH) * ZEBRA_PITCH;
    for (; bu + ZEBRA_BAR <= u1m - inset; bu += ZEBRA_PITCH) {
      this.rect(bu, bu + ZEBRA_BAR, za, zb, WHITE);
    }
    // Stop line on the approaching half (right-hand traffic). In axis space,
    // traffic moving +v keeps to -u for Z-roads and +u for X-roads.
    const rightSign = (this.axisZ ? -1 : 1) * dir;
    const center = (u0m + u1m) / 2;
    const sa = boundary - dir * (0.3 + ZEBRA_DEPTH + 0.5);
    const sb = boundary - dir * (0.3 + ZEBRA_DEPTH + 1.0);
    const ha = rightSign < 0 ? u0m + inset : center;
    const hb = rightSign < 0 ? center : u1m - inset;
    this.rect(ha, hb, Math.min(sa, sb), Math.max(sa, sb), WHITE);
  }

  /** Process one grid row (v, in tiles) of this axis across the given u range. */
  row(v: number, uStart: number, uEnd: number) {
    const v0m = v * TILE_SIZE;
    const v1m = v0m + TILE_SIZE;
    for (let u = uStart; u < uEnd; ) {
      if (!this.isRoad(u, v)) {
        u++;
        continue;
      }
      const run = this.runU(u, v);
      u = run.u1 + 1;
      if (run.len > WIDE) continue;
      const uc = (run.u0 + run.u1) >> 1;
      // Along-v road only: the perpendicular pass handles the other axis, and
      // square-ish patches (diagonals, plazas) get no longitudinal paint.
      if (this.runVLen(uc, v) <= run.len) continue;

      // Look along +/-v for intersection pavement; clamp longitudinal lines
      // out of the approach band and emit crosswalk + stop line at the edge.
      let allowedMin = -Infinity;
      let allowedMax = Infinity;
      for (let k = 1; k <= 3; k++) {
        if (!this.isRoad(uc, v + k)) break;
        if (this.runU(uc, v + k).len > WIDE) {
          allowedMax = (v + k) * TILE_SIZE - APPROACH_DEPTH;
          if (k === 1) this.approach(run, (v + 1) * TILE_SIZE, 1);
          break;
        }
      }
      for (let k = 1; k <= 3; k++) {
        if (!this.isRoad(uc, v - k)) break;
        if (this.runU(uc, v - k).len > WIDE) {
          allowedMin = (v - k + 1) * TILE_SIZE + APPROACH_DEPTH;
          if (k === 1) this.approach(run, v * TILE_SIZE, -1);
          break;
        }
      }
      const za = Math.max(v0m, allowedMin);
      const zb = Math.min(v1m, allowedMax);
      if (zb <= za) continue;

      // Stable straight section: neighbors share the exact cross-section.
      const up = this.isRoad(uc, v + 1) ? this.runU(uc, v + 1) : null;
      const down = this.isRoad(uc, v - 1) ? this.runU(uc, v - 1) : null;
      const same = (o: Run | null) => o !== null && o.u0 === run.u0 && o.u1 === run.u1;
      const stable = same(up) && same(down);

      const centerU = ((run.u0 + run.u1 + 1) / 2) * TILE_SIZE;
      if (!stable) {
        // Curved / jogging section (ring roads): only curb-following edge
        // lines, which staircase in step with the tile-quantized curbs.
        if (run.len >= 3) {
          this.solid(run.u0 * TILE_SIZE + 0.5, za, zb, WHITE);
          this.solid((run.u1 + 1) * TILE_SIZE - 0.5, za, zb, WHITE);
        }
        continue;
      }

      const lay = laneLayout(run.len);
      const coreHalf = lay.medianW / 2 + lay.lanesPerDir * LANE_WIDTH;
      // Center: painted median with hatching, or plain double yellow.
      if (lay.medianW >= MEDIAN_MIN) {
        this.solid(centerU - lay.medianW / 2, za, zb, YELLOW);
        this.solid(centerU + lay.medianW / 2, za, zb, YELLOW);
        if (lay.medianW >= 1.8) {
          let p = Math.ceil(za / 3) * 3;
          for (; p < zb; p += 3) {
            const a = Math.max(za, p - 0.15);
            const b = Math.min(zb, p + 0.15);
            if (b > a) {
              this.rect(
                centerU - lay.medianW / 2 + 0.25,
                centerU + lay.medianW / 2 - 0.25,
                a,
                b,
                YELLOW,
              );
            }
          }
        }
      } else {
        this.solid(centerU - 0.15, za, zb, YELLOW);
        this.solid(centerU + 0.15, za, zb, YELLOW);
      }
      // Dashed dividers between same-direction lanes.
      for (let k = 1; k < lay.lanesPerDir; k++) {
        const off = lay.medianW / 2 + k * LANE_WIDTH;
        this.dashed(centerU - off, za, zb, WHITE);
        this.dashed(centerU + off, za, zb, WHITE);
      }
      // Outermost line: parking-lane edge, or plain edge line by the gutter.
      if (lay.parking > 0 || lay.gutter >= 0.5) {
        this.solid(centerU - coreHalf, za, zb, WHITE);
        this.solid(centerU + coreHalf, za, zb, WHITE);
      }
    }
  }
}

/**
 * Build the painted-markings overlay geometry for one chunk (local coords,
 * y = PAINT_Y). Returns null when the chunk has no markings.
 */
export function buildRoadMarkings(chunk: ChunkData): THREE.BufferGeometry | null {
  const n = TILES_PER_CHUNK;
  const baseTx = chunk.coord.x * n;
  const baseTz = chunk.coord.z * n;
  const chunkX0 = baseTx * TILE_SIZE;
  const chunkZ0 = baseTz * TILE_SIZE;
  const margin = WIDE + 2;
  const rects: Rect[] = [];

  // Z-running roads: rows are z, run axis is x.
  const zPass = new MarkingPass(true, rects, chunkX0, chunkZ0);
  for (let v = baseTz - 3; v < baseTz + n + 3; v++) {
    zPass.row(v, baseTx - margin, baseTx + n + margin);
  }
  // X-running roads: rows are x, run axis is z.
  const xPass = new MarkingPass(false, rects, chunkX0, chunkZ0);
  for (let v = baseTx - 3; v < baseTx + n + 3; v++) {
    xPass.row(v, baseTz - margin, baseTz + n + margin);
  }
  if (rects.length === 0) return null;

  const positions = new Float32Array(rects.length * 18);
  const normals = new Float32Array(rects.length * 18);
  const colors = new Float32Array(rects.length * 18);
  let o = 0;
  for (const r of rects) {
    const c = COLORS[r.color];
    const quad = [
      [r.x0, r.z0], [r.x0, r.z1], [r.x1, r.z1],
      [r.x0, r.z0], [r.x1, r.z1], [r.x1, r.z0],
    ];
    for (const [x, z] of quad) {
      positions[o] = x;
      positions[o + 1] = PAINT_Y;
      positions[o + 2] = z;
      normals[o + 1] = 1;
      colors[o] = c.r;
      colors[o + 1] = c.g;
      colors[o + 2] = c.b;
      o += 3;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return geometry;
}

/** Worn thermoplastic paint; vertex colors carry white vs yellow. */
export const markingsMaterial = new THREE.MeshStandardMaterial({
  vertexColors: true,
  roughness: 0.85,
  metalness: 0,
  polygonOffset: true,
  polygonOffsetFactor: -2,
  polygonOffsetUnits: -2,
});

// Wear shader: chip the paint away (discard shows the asphalt underneath),
// modulate the paint by the asphalt PBR maps so the aggregate texture reads
// through the thin thermoplastic layer, vary the tint per stretch, and match
// the road's damp sheen so paint doesn't float bright and dry on a wet street.
markingsMaterial.onBeforeCompile = (shader) => {
  Object.assign(shader.uniforms, groundTextureUniforms);
  shader.uniforms.uTron = styleUniforms.uTron;
  shader.vertexShader = shader.vertexShader
    .replace("#include <common>", "#include <common>\nvarying vec3 vMWPos;")
    .replace(
      "#include <fog_vertex>",
      "#include <fog_vertex>\nvMWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;",
    );
  shader.fragmentShader = shader.fragmentShader
    .replace(
      "#include <common>",
      /* glsl */ `
#include <common>
${TRON_DECLS}
varying vec3 vMWPos;
uniform sampler2D uAsphaltMap;
uniform sampler2D uAsphaltNormal;
uniform sampler2D uAsphaltRough;
float mHash12(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}
float mNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mHash12(i), mHash12(i + vec2(1.0, 0.0)), u.x),
    mix(mHash12(i + vec2(0.0, 1.0)), mHash12(i + vec2(1.0, 1.0)), u.x),
    u.y);
}
float mFbm(vec2 p) {
  float a = 0.5;
  float s = 0.0;
  for (int i = 0; i < 3; i++) { s += a * mNoise(p); p *= 2.03; a *= 0.5; }
  return s;
}
`,
    )
    .replace(
      "#include <map_fragment>",
      /* glsl */ `
#include <map_fragment>
vec2 mwp = vMWPos.xz;
vec3 mEmissive = vec3(0.0);
if (uTron > 0.5) {
  // TRON: no painted lane lines at all — the grid world has no
  // thermoplastic. Discard keeps the overlay geometry shared with the
  // other styles without a rebuild on style switch.
  discard;
} else {
// Wear zones: medium-scale patches where the paint has mostly ground off,
// plus fine chipping everywhere. Chipped fragments discard to show asphalt.
float mZone = mFbm(mwp * 0.07 + 310.0);            // 0..1 wear region
float mChip = mNoise(mwp * 9.0);                    // fine chip texture
float mWear = smoothstep(0.35, 0.75, mZone);
if (mChip < mWear * 0.85) discard;
// Asphalt aggregate shows through the thin paint layer: modulate the paint
// by the same asphalt albedo the road samples (matched 3.6 m world repeat),
// normalized around its mean so the paint keeps its authored brightness.
vec3 mAsph = texture2D(uAsphaltMap, mwp / 3.6).rgb;
float mAsphLum = dot(mAsph, vec3(0.299, 0.587, 0.114));
diffuseColor.rgb *= clamp(0.35 + mAsphLum * 2.4, 0.5, 1.35);
// Surviving paint near worn zones is thinner: darker, dirtier.
float mThin = smoothstep(0.2, 0.75, mWear - 0.25 * (mChip - mWear));
diffuseColor.rgb *= 1.0 - 0.3 * mThin;
// Per-stretch tint drift so repaint batches don't match exactly.
diffuseColor.rgb *= 0.9 + 0.2 * mHash12(floor(mwp / 7.0) + 5.0);
// Grime speckle dulls the paint like the surrounding road.
diffuseColor.rgb *= 1.0 - 0.12 * smoothstep(0.55, 0.8, mFbm(mwp * 0.4 + 90.0));
}
`,
    )
    .replace(
      "#include <emissivemap_fragment>",
      /* glsl */ `
#include <emissivemap_fragment>
totalEmissiveRadiance += mEmissive;
`,
    )
    .replace(
      "#include <roughnessmap_fragment>",
      /* glsl */ `
#include <roughnessmap_fragment>
// Asphalt micro-roughness carries into the paint film.
roughnessFactor *= 0.7 + 0.6 * texture2D(uAsphaltRough, mwp / 3.6).r;
// Same damp field as the road shader so wet gloss lines up.
float mDamp = clamp(0.35 + 0.55 * mFbm(mwp * 0.03 + 200.0), 0.0, 1.0);
roughnessFactor = mix(roughnessFactor, roughnessFactor * 0.45 + 0.02, mDamp);
diffuseColor.rgb *= 1.0 - 0.15 * mDamp;
`,
    )
    .replace(
      "#include <normal_fragment_begin>",
      /* glsl */ `
#include <normal_fragment_begin>
// Bend the flat quad normal with the asphalt normal map so paint follows
// the bumps of the pavement instead of reading as a decal-flat sticker.
{
  vec2 mN2 = texture2D(uAsphaltNormal, vMWPos.xz / 3.6).rg * 2.0 - 1.0;
  vec3 mWN = normalize(vec3(mN2.x * 0.45, 1.0, mN2.y * 0.45));
  normal = normalize(mat3(viewMatrix) * mWN);
}
`,
    );
};
