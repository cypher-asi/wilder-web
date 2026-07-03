// Far-field city proxy (HLOD 0): the whole baked city blockout rendered as
// cheap flat-shaded massing beyond the streamed chunk ring, so zooming out or
// tilting toward the horizon shows the city continuing instead of ending at
// the 7x7 streamed area.
//
// Geometry comes from citymap/geo.bin (the same whole-city blockout the
// HoloMap uses), partitioned once into ~256 m cells that share one vertex
// buffer but carry their own index + bounds, so three.js frustum culling and
// a fog-range visibility loop keep the per-frame cost to the handful of
// cells actually in view. A coarse land mesh built from the city tile grid
// sits underneath (outside the streamed ring there is only ocean).
//
// Where full-fidelity chunks are mounted the proxy is cut out per fragment
// via a small occupancy texture (one texel per chunk, window following the
// player). Texel values fade 0..1 over REVEAL_FADE_MS driven by chunk
// readiness (chunkBuilder.ts), and the cutout uses a Bayer dither so the
// upgrade reads as a quick dissolve rather than a pop.

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useState } from "react";
import * as THREE from "three";
import {
  CITY_BUILDING,
  CITY_PARK,
  CITY_PLAZA,
  CITY_ROAD,
  CITY_ROAD_LINE,
  CITY_SIDEWALK,
  CITY_WATER,
  CityGeo,
  getCityGeo,
  getCityGrid,
  onCityMapReady,
} from "../game/citymap";
import { CHUNK_SIZE, TILE_SIZE } from "../net/protocol";
import { game } from "../state/game";
import { proxyCovers, revealedChunks, REVEAL_FADE_MS } from "./chunkBuilder";
import { styleUniforms, TRON_BLUE, tronifyMaterial } from "./styles";

/** Proxy cell size in meters (8x8 chunks): the frustum-culling granularity. */
const CELL = 256;
/** Occupancy window side, in chunks (covers WINDOW*32 m around the player). */
const WINDOW = 32;
/** Distant land sits just above the ocean plane (-0.02) and below real roads. */
const GROUND_PROXY_Y = 0.01;
/** Tiles per distant-ground block (16 tiles = 32 m = one chunk). */
const GROUND_STEP = 16;
/** Triangles per partition slice; slices yield to the event loop. */
const SLICE_TRIS = 100_000;
/** Beyond this fog transmittance the proxy is invisible; cull it. */
const FOG_CUTOFF = Math.sqrt(-Math.log(0.02)); // exp(-(d*dist)^2) < 2%

interface ProxyCell {
  mesh: THREE.Object3D;
  center: THREE.Vector3;
  radius: number;
  /** Only rendered in the tron style (glowing building edge lines). */
  tronOnly?: boolean;
}

// ---------------------------------------------------------------------------
// Occupancy window: one R8 texel per chunk, 255 = proxy visible.
// ---------------------------------------------------------------------------

const occData = new Uint8Array(WINDOW * WINDOW).fill(255);
const occTexture = new THREE.DataTexture(
  occData,
  WINDOW,
  WINDOW,
  THREE.RedFormat,
  THREE.UnsignedByteType,
);
occTexture.minFilter = THREE.NearestFilter;
occTexture.magFilter = THREE.NearestFilter;
occTexture.needsUpdate = true;

const occUniforms = {
  uOcc: { value: occTexture },
  // Chunk coords of the window's min corner; start far away so the proxy is
  // fully visible until the first tick positions the window.
  uOccOrigin: { value: new THREE.Vector2(1e6, 1e6) },
};

/** Per-chunk fade state (1 = proxy visible), keyed by "cx,cz". */
const fades = new Map<string, { cx: number; cz: number; v: number }>();
let winX = 1e6;
let winZ = 1e6;

function occWrite(cx: number, cz: number, v: number): void {
  const x = cx - winX;
  const z = cz - winZ;
  if (x < 0 || z < 0 || x >= WINDOW || z >= WINDOW) return;
  occData[z * WINDOW + x] = Math.round(v * 255);
}

function tickOccupancy(dt: number): void {
  const pcx = Math.floor(game.rendered.x / CHUNK_SIZE);
  const pcz = Math.floor(game.rendered.z / CHUNK_SIZE);

  let dirty = false;
  // Re-center the window when the player drifts from its middle; rewrite the
  // whole 1 KB texture from the fade map (cheap and rare).
  if (Math.abs(pcx - (winX + WINDOW / 2)) > 6 || Math.abs(pcz - (winZ + WINDOW / 2)) > 6) {
    winX = pcx - WINDOW / 2;
    winZ = pcz - WINDOW / 2;
    occUniforms.uOccOrigin.value.set(winX, winZ);
    occData.fill(255);
    for (const f of fades.values()) occWrite(f.cx, f.cz, f.v);
    dirty = true;
  }

  // Every revealed chunk gets a fade entry (starting fully covered by proxy).
  for (const chunk of revealedChunks.values()) {
    const key = `${chunk.coord.x},${chunk.coord.z}`;
    if (!fades.has(key)) fades.set(key, { cx: chunk.coord.x, cz: chunk.coord.z, v: 1 });
  }

  const step = (dt * 1000) / REVEAL_FADE_MS;
  for (const [key, f] of fades) {
    const target = proxyCovers(f.cx, f.cz) ? 1 : 0;
    if (f.v === target) {
      // Fully faded back to proxy-visible and no longer mounted: default
      // state, drop the entry.
      if (target === 1) fades.delete(key);
      continue;
    }
    f.v = target > f.v ? Math.min(1, f.v + step) : Math.max(0, f.v - step);
    occWrite(f.cx, f.cz, f.v);
    dirty = true;
  }

  if (dirty) occTexture.needsUpdate = true;
}

// ---------------------------------------------------------------------------
// Tile palette window: streets stay legible far beyond the streamed chunks.
// A sliding window over the city tile grid is baked into an RGBA texture
// (one texel per 2 m tile, so 1024 texels cover ~2 km around the player) and
// the distant land mesh samples it instead of a flat color -- roads,
// sidewalks, and parks continue to the horizon. Mipmapped linear filtering
// antialiases the distant street grid for free.
// ---------------------------------------------------------------------------

/** Tile window side in texels (1 texel per tile => covers TILE_WIN*2 m). */
const TILE_WIN = 1024;
/** World meters covered by the tile window. */
const TILE_SPAN = TILE_WIN * TILE_SIZE;
/** Re-center when the player drifts this many tiles from the window middle. */
const TILE_RECENTER = 128;

// Distant albedo per tile kind (display-referred, decoded by the sRGB
// sampler): averages of what the full ground shader converges to, so the
// handoff at the streamed ring reads as a continuation, not a material swap.
const TILE_COLORS: [number, number, number][] = [];
TILE_COLORS[CITY_ROAD] = [90, 87, 86];
TILE_COLORS[CITY_ROAD_LINE] = [168, 161, 150];
TILE_COLORS[CITY_SIDEWALK] = [174, 168, 158];
TILE_COLORS[CITY_PLAZA] = [150, 147, 142];
TILE_COLORS[CITY_BUILDING] = [116, 108, 100];
TILE_COLORS[CITY_PARK] = [86, 106, 72];
TILE_COLORS[CITY_WATER] = [30, 44, 54];

const tilePal32 = new Uint32Array(8);
{
  const bytes = new Uint8Array(tilePal32.buffer);
  for (let k = 0; k < 8; k++) {
    const [r, g, b] = TILE_COLORS[k] ?? TILE_COLORS[CITY_WATER];
    bytes[k * 4] = r;
    bytes[k * 4 + 1] = g;
    bytes[k * 4 + 2] = b;
    bytes[k * 4 + 3] = 255;
  }
}

const tileTexData = new Uint8Array(TILE_WIN * TILE_WIN * 4);
const tileTexture = new THREE.DataTexture(tileTexData, TILE_WIN, TILE_WIN);
tileTexture.colorSpace = THREE.SRGBColorSpace;
tileTexture.generateMipmaps = true;
tileTexture.minFilter = THREE.LinearMipmapLinearFilter;
tileTexture.magFilter = THREE.LinearFilter;
tileTexture.anisotropy = 8;

const tileUniforms = {
  uTiles: { value: tileTexture },
  // World meters of the window's min corner; starts far away (flat fallback
  // color everywhere) until the grid loads and the first tick fills it.
  uTilesOrigin: { value: new THREE.Vector2(1e7, 1e7) },
};

let tileWinX = 1e7; // window min corner, world tile coords
let tileWinZ = 1e7;

/** Re-bake the window texture when the player drifts far enough from its
 * middle. The full rewrite is ~1M palette lookups (a few ms) but only fires
 * once per ~256 m of travel. */
function tickTileWindow(): void {
  const grid = getCityGrid();
  if (!grid) return;
  const ptx = Math.floor(game.rendered.x / TILE_SIZE);
  const ptz = Math.floor(game.rendered.z / TILE_SIZE);
  if (
    Math.abs(ptx - (tileWinX + TILE_WIN / 2)) <= TILE_RECENTER &&
    Math.abs(ptz - (tileWinZ + TILE_WIN / 2)) <= TILE_RECENTER
  ) {
    return;
  }
  tileWinX = ptx - TILE_WIN / 2;
  tileWinZ = ptz - TILE_WIN / 2;
  tileUniforms.uTilesOrigin.value.set(tileWinX * TILE_SIZE, tileWinZ * TILE_SIZE);

  const out = new Uint32Array(tileTexData.buffer);
  const waterPx = tilePal32[CITY_WATER];
  for (let z = 0; z < TILE_WIN; z++) {
    const gz = tileWinZ + z - grid.tileMinZ;
    const rowBase = z * TILE_WIN;
    if (gz < 0 || gz >= grid.height) {
      out.fill(waterPx, rowBase, rowBase + TILE_WIN);
      continue;
    }
    const gridRow = gz * grid.width;
    for (let x = 0; x < TILE_WIN; x++) {
      const gx = tileWinX + x - grid.tileMinX;
      out[rowBase + x] =
        gx >= 0 && gx < grid.width ? tilePal32[grid.tiles[gridRow + gx]] : waterPx;
    }
  }
  tileTexture.needsUpdate = true;
}

// ---------------------------------------------------------------------------
// Materials: flat-shaded Lambert (scene fog + tone mapping for free; the
// derivative-based flat normals mean geo.bin needs no normal data) with the
// occupancy cutout injected. Buildings additionally tint by relative height.
// ---------------------------------------------------------------------------

const CUTOUT_FRAG_DECLS = /* glsl */ `
uniform sampler2D uOcc;
uniform vec2 uOccOrigin;
varying vec3 vPxWorld;
float pxBayer2(vec2 a) { a = floor(a); return fract(a.x * 0.5 + a.y * a.y * 0.75); }
float pxBayer4(vec2 a) { return pxBayer2(0.5 * a) * 0.25 + pxBayer2(a); }
`;

const CUTOUT_FRAG = /* glsl */ `
{
  vec2 cuv = (vPxWorld.xz / ${CHUNK_SIZE.toFixed(1)} - uOccOrigin) / ${WINDOW.toFixed(1)};
  float pxCover = 1.0;
  if (cuv.x >= 0.0 && cuv.y >= 0.0 && cuv.x < 1.0 && cuv.y < 1.0) {
    pxCover = texture2D(uOcc, cuv).r;
  }
  if (pxCover < pxBayer4(gl_FragCoord.xy) + 0.001) discard;
}
`;

// Buildings: per-building tone variation, a height gradient (street level
// reads as shadowed massing, tops catch the light), and a window grid on the
// facades with a sparse scatter of warm lit interiors -- distant boxes read
// as buildings, not flat slabs.
const BUILDING_TINT_FRAG = /* glsl */ `
{
  // Flat face normal from derivatives (same math flatShading uses later).
  vec3 pxN = normalize(cross(dFdx(vPxWorld), dFdy(vPxWorld)));
  float pxWall = 1.0 - smoothstep(0.45, 0.75, abs(pxN.y));
  float pxDist = distance(vPxWorld, cameraPosition);
  float pxDetail = clamp(1.0 - (pxDist - 500.0) / 300.0, 0.0, 1.0);

  // Per-building-ish tone: a quantized world hash (36 m cells, about one
  // footprint) shifts neighboring towers between warm and cool concrete.
  vec2 pxBid = floor((vPxWorld.xz + 7.0) / 36.0);
  float pxH = fract(sin(dot(pxBid, vec2(127.1, 311.7))) * 43758.5453);
  float pxH2 = fract(pxH * 7.31 + 0.17);
  diffuseColor.rgb *=
    mix(vec3(1.07, 1.0, 0.9), vec3(0.88, 0.94, 1.06), pxH) * (0.78 + 0.42 * pxH2);

  // Height grade: shadowed street level up to lit tops.
  diffuseColor.rgb *= mix(0.35, 1.0, vRelH * vRelH);

  // Window grid on facades (roofs masked off): dark glass cells with a few
  // warm lit interiors, faded out with distance before it can shimmer.
  vec2 pxWuv = vec2((vPxWorld.x + vPxWorld.z) * 0.36, vPxWorld.y * 0.32);
  vec2 pxWf = fract(pxWuv);
  float pxWin = step(pxWf.x, 0.6) * step(0.28, pxWf.y) * step(pxWf.y, 0.8);
  float pxWinAmt = pxWin * pxWall * pxDetail;
  diffuseColor.rgb *= 1.0 - 0.5 * pxWinAmt;
  float pxLit =
    step(0.92, fract(sin(dot(floor(pxWuv) + pxBid, vec2(53.7, 97.3))) * 24634.63));
  pxWinGlow = vec3(1.0, 0.72, 0.42) * (0.4 * pxLit * pxWinAmt) * (1.0 - uTron);
}
`;

// Ground: inside the tile window, replace the flat land color with the baked
// per-tile street palette so roads continue far beyond the streamed chunks.
// The grazing-angle boost stands in for the view-dependent sheen the real
// ground shader has: without it the proxy reads far darker than the streamed
// road at street-level view angles and the handoff shows as a dark band.
// uTron guard: tron mode's flat black base (injected ahead of this block by
// tronifyMaterial) must win over the palette.
const GROUND_TILES_FRAG = /* glsl */ `
if (uTron < 0.5) {
  vec2 tuv = (vPxWorld.xz - uTilesOrigin) / ${TILE_SPAN.toFixed(1)};
  if (tuv.x >= 0.0 && tuv.y >= 0.0 && tuv.x < 1.0 && tuv.y < 1.0) {
    diffuseColor.rgb = texture2D(uTiles, tuv).rgb;
  }
  vec3 pxV = normalize(cameraPosition - vPxWorld);
  float pxGrz = pow(1.0 - clamp(pxV.y, 0.0, 1.0), 4.0);
  diffuseColor.rgb *= 1.0 + 1.1 * pxGrz;
}
`;

// Tron building outlines: hard edges of the proxy massing drawn as emissive
// blue lines, so the distant skyline reads as dark slabs rimmed with glowing
// borders. Unlit line color bright enough to trip the tron bloom pass; scene
// fog still grades the lines out toward the horizon. Same occupancy cutout
// as the massing. Depth testing stays fully on — hidden edges must not show
// through walls (the slabs are opaque, not wireframe). Lines lie exactly on
// the faces they outline, so each vertex is pulled a fixed 0.4 m toward the
// camera in view space: enough to always win the depth test against its own
// wall, far below any building-to-building spacing, and (unlike a
// slope-scaled polygon offset or an NDC bias) it does not blow up with
// distance and drag occluded lines through the buildings in front of them.
function makeEdgeMaterial(): THREE.LineBasicMaterial {
  const mat = new THREE.LineBasicMaterial({
    color: TRON_BLUE.clone().multiplyScalar(1.4),
  });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uOcc = occUniforms.uOcc;
    shader.uniforms.uOccOrigin = occUniforms.uOccOrigin;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vPxWorld;")
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        vPxWorld = (modelMatrix * vec4(position, 1.0)).xyz;`,
      )
      .replace(
        "#include <project_vertex>",
        `#include <project_vertex>
        mvPosition.xyz -= normalize(mvPosition.xyz) * 0.4;
        gl_Position = projectionMatrix * mvPosition;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${CUTOUT_FRAG_DECLS}`)
      .replace("#include <color_fragment>", `#include <color_fragment>\n${CUTOUT_FRAG}`);
  };
  mat.customProgramCacheKey = () => "tron-proxy-edges";
  return mat;
}

function makeProxyMaterial(color: string, relH: boolean): THREE.MeshLambertMaterial {
  const mat = new THREE.MeshLambertMaterial({ color, flatShading: true });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uOcc = occUniforms.uOcc;
    shader.uniforms.uOccOrigin = occUniforms.uOccOrigin;
    shader.uniforms.uTiles = tileUniforms.uTiles;
    shader.uniforms.uTilesOrigin = tileUniforms.uTilesOrigin;
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
        varying vec3 vPxWorld;
        ${relH ? "attribute float aRelH; varying float vRelH;" : ""}`,
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        vPxWorld = (modelMatrix * vec4(position, 1.0)).xyz;
        ${relH ? "vRelH = aRelH;" : ""}`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
        ${CUTOUT_FRAG_DECLS}
        ${
          relH
            ? "varying float vRelH; vec3 pxWinGlow = vec3(0.0);"
            : "uniform sampler2D uTiles; uniform vec2 uTilesOrigin;"
        }`,
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        ${CUTOUT_FRAG}
        ${relH ? BUILDING_TINT_FRAG : GROUND_TILES_FRAG}`,
      );
    if (relH) {
      // Lit windows: computed in color_fragment, applied on the emissive
      // path (after tron's remap, hence the uTron gate where it's built).
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
        totalEmissiveRadiance += pxWinGlow;`,
      );
    }
  };
  // Distant massing joins the black slab world in tron mode. Distinct cache
  // keys: the two proxy programs differ (aRelH tint) beyond their params.
  // Tron's flat base lands before the relH multiply, so the far skyline
  // keeps its height-graded value variation. No code field on the proxy:
  // background buildings are solid dark slabs (same black as the ground
  // plane) whose only light is the glowing edge outlines.
  tronifyMaterial(mat, relH ? "tron-proxy-bldg" : "tron-proxy-gnd");
  return mat;
}

// ---------------------------------------------------------------------------
// One-time geometry build (module-cached for the session, like the shared
// facade materials). Partitioning yields between slices so it never lands on
// a gameplay frame.
// ---------------------------------------------------------------------------

// Timeout-bounded: under a continuous rAF loop Chrome hands out idle time
// sparingly, and an unbounded requestIdleCallback can stall the whole build.
const idle = (): Promise<void> =>
  new Promise((resolve) => {
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(() => resolve(), { timeout: 100 });
    } else setTimeout(resolve, 0);
  });

const cellKeyOf = (x: number, z: number) => `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;

interface CellBin {
  indices: number[];
  min: THREE.Vector3;
  max: THREE.Vector3;
}

function binOf(bins: Map<string, CellBin>, key: string): CellBin {
  let bin = bins.get(key);
  if (!bin) {
    bin = {
      indices: [],
      min: new THREE.Vector3(Infinity, Infinity, Infinity),
      max: new THREE.Vector3(-Infinity, -Infinity, -Infinity),
    };
    bins.set(key, bin);
  }
  return bin;
}

function cellFromBounds(
  geometry: THREE.BufferGeometry,
  min: THREE.Vector3,
  max: THREE.Vector3,
  material: THREE.Material,
): ProxyCell {
  const center = min.clone().add(max).multiplyScalar(0.5);
  const radius = max.clone().sub(min).length() / 2;
  geometry.boundingBox = new THREE.Box3(min, max);
  geometry.boundingSphere = new THREE.Sphere(center.clone(), radius);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  // Never intercept aiming / click-to-move raycasts (same as the ocean).
  mesh.raycast = () => {};
  // Start hidden: the per-frame range cull reveals only in-range cells, so
  // the first rendered frame never draws (and uploads) the entire city.
  mesh.visible = false;
  return { mesh, center, radius };
}

async function buildBuildingCells(
  geo: CityGeo,
  material: THREE.Material,
): Promise<ProxyCell[]> {
  const pos = geo.buildingPos;
  const idx = geo.buildingIdx;

  const bins = new Map<string, CellBin>();
  const triCount = idx.length / 3;
  for (let t = 0; t < triCount; t += SLICE_TRIS) {
    const end = Math.min(triCount, t + SLICE_TRIS);
    for (let i = t; i < end; i++) {
      const a = idx[i * 3];
      const b = idx[i * 3 + 1];
      const c = idx[i * 3 + 2];
      const cx = (pos[a * 3] + pos[b * 3] + pos[c * 3]) / 3;
      const cz = (pos[a * 3 + 2] + pos[b * 3 + 2] + pos[c * 3 + 2]) / 3;
      const bin = binOf(bins, cellKeyOf(cx, cz));
      bin.indices.push(a, b, c);
      for (let k = 0; k < 3; k++) {
        const v = k === 0 ? a : k === 1 ? b : c;
        const x = pos[v * 3];
        const y = pos[v * 3 + 1];
        const z = pos[v * 3 + 2];
        if (x < bin.min.x) bin.min.x = x;
        if (y < bin.min.y) bin.min.y = y;
        if (z < bin.min.z) bin.min.z = z;
        if (x > bin.max.x) bin.max.x = x;
        if (y > bin.max.y) bin.max.y = y;
        if (z > bin.max.z) bin.max.z = z;
      }
    }
    await idle();
  }

  // Each cell gets its own compact vertex buffers (remapped from the global
  // arrays) rather than sharing one whole-city buffer: GPU uploads then
  // happen per cell as the range cull reveals them, a few KB at a time,
  // instead of one multi-MB upload on the first visible frame.
  const cells: ProxyCell[] = [];
  let sinceYield = 0;
  for (const bin of bins.values()) {
    const remap = new Map<number, number>();
    const local = new Uint32Array(bin.indices.length);
    for (let i = 0; i < bin.indices.length; i++) {
      const g = bin.indices[i];
      let l = remap.get(g);
      if (l === undefined) {
        l = remap.size;
        remap.set(g, l);
      }
      local[i] = l;
    }
    const cellPos = new Float32Array(remap.size * 3);
    const cellRelH = new Uint8Array(remap.size);
    for (const [g, l] of remap) {
      cellPos[l * 3] = pos[g * 3];
      cellPos[l * 3 + 1] = pos[g * 3 + 1];
      cellPos[l * 3 + 2] = pos[g * 3 + 2];
      cellRelH[l] = geo.buildingRelH[g];
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(cellPos, 3));
    geometry.setAttribute("aRelH", new THREE.BufferAttribute(cellRelH, 1, true));
    geometry.setIndex(
      new THREE.BufferAttribute(
        remap.size > 65535 ? local : new Uint16Array(local),
        1,
      ),
    );
    cells.push(cellFromBounds(geometry, bin.min, bin.max, material));
    sinceYield += bin.indices.length;
    if (sinceYield > SLICE_TRIS * 3) {
      sinceYield = 0;
      await idle();
    }
  }
  return cells;
}

/**
 * Coarse land mesh from the client tile grid: one 32 m block per chunk,
 * row-merged into quads (split at cell borders so each cell can be culled).
 * Land detection subsamples 5 tiles per block, plenty for a distant fill.
 */
async function buildGroundCells(material: THREE.Material): Promise<ProxyCell[]> {
  const grid = getCityGrid();
  if (!grid) return [];
  const blocksW = Math.ceil(grid.width / GROUND_STEP);
  const blocksH = Math.ceil(grid.height / GROUND_STEP);
  const blocksPerCell = CELL / (GROUND_STEP * TILE_SIZE);

  const isLand = (bx: number, bz: number): boolean => {
    const x0 = bx * GROUND_STEP;
    const z0 = bz * GROUND_STEP;
    const probe = [
      [x0 + 2, z0 + 2],
      [x0 + GROUND_STEP - 3, z0 + 2],
      [x0 + 2, z0 + GROUND_STEP - 3],
      [x0 + GROUND_STEP - 3, z0 + GROUND_STEP - 3],
      [x0 + GROUND_STEP / 2, z0 + GROUND_STEP / 2],
    ];
    for (const [gx, gz] of probe) {
      if (gx >= grid.width || gz >= grid.height) continue;
      if (grid.tiles[gz * grid.width + gx] !== CITY_WATER) return true;
    }
    return false;
  };

  // World-space quad corners for a block run [bx0, bx1) on row bz.
  const blockMeters = GROUND_STEP * TILE_SIZE;
  const quads = new Map<string, number[]>();
  const emit = (bx0: number, bx1: number, bz: number) => {
    const x0 = (grid.tileMinX + bx0 * GROUND_STEP) * TILE_SIZE;
    const x1 = (grid.tileMinX + bx1 * GROUND_STEP) * TILE_SIZE;
    const z0 = (grid.tileMinZ + bz * GROUND_STEP) * TILE_SIZE;
    const z1 = z0 + blockMeters;
    const key = cellKeyOf((x0 + x1) / 2, (z0 + z1) / 2);
    let list = quads.get(key);
    if (!list) {
      list = [];
      quads.set(key, list);
    }
    const y = GROUND_PROXY_Y;
    list.push(x0, y, z0, x0, y, z1, x1, y, z1, x0, y, z0, x1, y, z1, x1, y, z0);
  };

  for (let bz = 0; bz < blocksH; bz++) {
    let runStart = -1;
    for (let bx = 0; bx <= blocksW; bx++) {
      const land = bx < blocksW && isLand(bx, bz);
      // Cut runs at proxy-cell borders so quads never span two cells.
      const cellBorder = bx % blocksPerCell === 0;
      if (land && runStart < 0) runStart = bx;
      if (runStart >= 0 && (!land || cellBorder)) {
        if (bx > runStart) emit(runStart, bx, bz);
        runStart = land ? bx : -1;
      }
    }
    if (bz % 64 === 63) await idle();
  }

  const cells: ProxyCell[] = [];
  for (const list of quads.values()) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(list), 3));
    const min = new THREE.Vector3(Infinity, Infinity, Infinity);
    const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    for (let i = 0; i < list.length; i += 3) {
      min.x = Math.min(min.x, list[i]);
      min.y = Math.min(min.y, list[i + 1]);
      min.z = Math.min(min.z, list[i + 2]);
      max.x = Math.max(max.x, list[i]);
      max.y = Math.max(max.y, list[i + 1]);
      max.z = Math.max(max.z, list[i + 2]);
    }
    cells.push(cellFromBounds(geometry, min, max, material));
  }
  return cells;
}

/**
 * Glowing edge outlines for every building cell, built lazily the first time
 * the tron style is active (other styles never pay the extraction cost).
 * Shares the massing cells' bounds so the same range cull applies, and the
 * cells are appended to the live assets so the frame loop picks them up.
 */
async function buildEdgeCells(cells: ProxyCell[]): Promise<ProxyCell[]> {
  const material = makeEdgeMaterial();
  const out: ProxyCell[] = [];
  let sinceYield = 0;
  // Snapshot: the caller appends the result to the same array.
  for (const cell of [...cells]) {
    const geo = (cell.mesh as THREE.Mesh).geometry;
    // Building cells only (ground cells carry no aRelH attribute).
    if (!geo.getAttribute("aRelH")) continue;
    // 10 deg threshold: keeps every hard blockout edge, drops the coplanar
    // triangulation seams across flat roofs and walls.
    const edges = new THREE.EdgesGeometry(geo, 10);
    edges.boundingBox = geo.boundingBox;
    edges.boundingSphere = geo.boundingSphere;
    const lines = new THREE.LineSegments(edges, material);
    lines.raycast = () => {};
    lines.visible = false;
    out.push({ mesh: lines, center: cell.center, radius: cell.radius, tronOnly: true });
    sinceYield += (geo.index?.count ?? 0) / 3;
    if (sinceYield > SLICE_TRIS) {
      sinceYield = 0;
      await idle();
    }
  }
  return out;
}

interface ProxyAssets {
  group: THREE.Group;
  cells: ProxyCell[];
}

let assetsPromise: Promise<ProxyAssets> | null = null;
let edgesStarted = false;

function loadProxyAssets(): Promise<ProxyAssets> {
  assetsPromise ??= (async () => {
    const t0 = performance.now();
    const [geo] = await Promise.all([
      getCityGeo(),
      new Promise<void>((resolve) => onCityMapReady(resolve)),
    ]);
    // Mid-dark warm concrete; the height grade in BUILDING_TINT_FRAG darkens
    // street level further and the fog color does the distant grading.
    const buildingMat = makeProxyMaterial("#776c62", true);
    const groundMat = makeProxyMaterial("#4b4649", false);
    const cells = [
      ...(await buildBuildingCells(geo, buildingMat)),
      ...(await buildGroundCells(groundMat)),
    ];
    const group = new THREE.Group();
    for (const cell of cells) group.add(cell.mesh);
    if (import.meta.env.DEV) {
      console.info(
        `city proxy: ${cells.length} cells in ${Math.round(performance.now() - t0)} ms`,
      );
      (window as unknown as Record<string, unknown>).__cityProxy = { group, cells };
    }
    return { group, cells };
  })();
  return assetsPromise;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CityProxy() {
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);
  const scene = useThree((s) => s.scene);
  const [assets, setAssets] = useState<ProxyAssets | null>(null);

  useEffect(() => {
    let alive = true;
    loadProxyAssets()
      .then((a) => {
        if (!alive) return;
        // Compile the two proxy programs before any cell becomes visible.
        void gl
          .compileAsync(a.group, camera, scene)
          .catch(() => undefined)
          .then(() => alive && setAssets(a));
      })
      .catch((e) => console.error("city proxy build failed", e));
    return () => {
      alive = false;
    };
  }, [gl, camera, scene]);

  useFrame((_, dt) => {
    tickOccupancy(Math.min(dt, 0.1));
    tickTileWindow();
    if (!assets) return;

    const tronOn = styleUniforms.uTron.value > 0.5;
    // First frame in tron mode: kick off the one-time edge-line build in the
    // background; the outlines pop in cell by cell as they finish.
    if (tronOn && !edgesStarted) {
      edgesStarted = true;
      void buildEdgeCells(assets.cells).then((edgeCells) => {
        for (const cell of edgeCells) assets.group.add(cell.mesh);
        assets.cells.push(...edgeCells);
      });
    }

    // Range cull: past the distance where fog eats everything (or the far
    // plane) a cell cannot contribute pixels, so skip its draw entirely.
    const density =
      scene.fog instanceof THREE.FogExp2 ? scene.fog.density : 0.0035;
    const cutoff = Math.min(camera.far, FOG_CUTOFF / Math.max(density, 1e-5));
    for (const cell of assets.cells) {
      cell.mesh.visible =
        (!cell.tronOnly || tronOn) &&
        cell.center.distanceTo(camera.position) - cell.radius < cutoff;
    }
  });

  if (!assets) return null;
  return <primitive object={assets.group} />;
}
