// Procedural building generator. Produces merged geometry per material key
// (see facade.ts getBuildingMaterial) for a Precinct-style building: storefront
// base with bays/awnings/signage, textured upper mass, and a dressed roof.
// Everything is deterministic from BuildingInstance.style.

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { BuildingInstance, CHUNK_SIZE, ChunkData, TILE_SIZE } from "../net/protocol";
import { mulberry, NEON_COLORS } from "./facade";
import { getImportedBuilding } from "./importedBuilding";
import { KitEntry } from "./InstancedKit";

/** Sidewalk/building tiles are raised; buildings sit on top of them. */
export const GROUND_Y = 0.14;

export interface WaterTowerPlacement {
  x: number;
  z: number;
  baseY: number;
  ry: number;
}

/** A kit asset placed in building-local space (y=0 at the building base). */
export interface KitLocalPlacement {
  assetId: string;
  x: number;
  y: number;
  z: number;
  ry: number;
  scale?: number | [number, number, number];
}

export interface BuildingModel {
  /** material key -> merged geometry, in building-local space (y=0 at base). */
  geoms: [string, THREE.BufferGeometry][];
  waterTower: WaterTowerPlacement | null;
  /** Kit dressing (AC units, billboards) rendered through InstancedKit. */
  kit: KitLocalPlacement[];
  /** Building center in chunk-local coordinates. */
  x: number;
  z: number;
  width: number;
  depth: number;
  height: number;
}

// Materials whose meshes are merged via vertex colors (see facade.ts).
const COLOR_MATS = new Set(["neon", "fabric"]);
const WHITE = new THREE.Color(1, 1, 1);

const NEON = NEON_COLORS.map((c) => new THREE.Color(c));
const INTERIOR_GLOW = ["#ffd9a0", "#ffe9c9", "#c9f0ff", "#ffd2e1", "#d6ffe3"].map(
  (c) => new THREE.Color(c),
);
const AWNING_COLORS = ["#7a2230", "#1f4a38", "#22335c", "#5c3a22", "#3a2f4f"].map(
  (c) => new THREE.Color(c),
);
const DIM_GLASS = new THREE.Color(0.015, 0.018, 0.024);

class Parts {
  private lists = new Map<string, THREE.BufferGeometry[]>();
  private euler = new THREE.Euler();
  private m = new THREE.Matrix4();

  add(
    mat: string,
    geom: THREE.BufferGeometry,
    x: number,
    y: number,
    z: number,
    rx = 0,
    ry = 0,
    rz = 0,
    color?: THREE.Color,
  ): void {
    this.m.makeRotationFromEuler(this.euler.set(rx, ry, rz));
    this.m.setPosition(x, y, z);
    geom.applyMatrix4(this.m);
    if (COLOR_MATS.has(mat)) {
      const c = color ?? WHITE;
      const count = geom.getAttribute("position").count;
      const arr = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        arr[i * 3] = c.r;
        arr[i * 3 + 1] = c.g;
        arr[i * 3 + 2] = c.b;
      }
      geom.setAttribute("color", new THREE.BufferAttribute(arr, 3));
    }
    let list = this.lists.get(mat);
    if (!list) {
      list = [];
      this.lists.set(mat, list);
    }
    list.push(geom);
  }

  box(
    mat: string,
    sx: number,
    sy: number,
    sz: number,
    x: number,
    y: number,
    z: number,
    rx = 0,
    ry = 0,
    rz = 0,
    color?: THREE.Color,
  ): void {
    this.add(mat, new THREE.BoxGeometry(sx, sy, sz), x, y, z, rx, ry, rz, color);
  }

  cyl(
    mat: string,
    r: number,
    h: number,
    x: number,
    y: number,
    z: number,
    rx = 0,
    ry = 0,
    rz = 0,
    rTop?: number,
  ): void {
    this.add(
      mat,
      new THREE.CylinderGeometry(rTop ?? r, r, h, 10),
      x,
      y,
      z,
      rx,
      ry,
      rz,
    );
  }

  plane(
    mat: string,
    w: number,
    h: number,
    x: number,
    y: number,
    z: number,
    rx = 0,
    ry = 0,
    rz = 0,
    color?: THREE.Color,
  ): void {
    this.add(mat, new THREE.PlaneGeometry(w, h), x, y, z, rx, ry, rz, color);
  }

  build(): [string, THREE.BufferGeometry][] {
    const out: [string, THREE.BufferGeometry][] = [];
    for (const [key, list] of this.lists) {
      const merged = mergeGeometries(list, false);
      if (merged) out.push([key, merged]);
    }
    return out;
  }
}

/** A vertical facade plane of the building, with a local (along, y, out) frame. */
interface Face {
  axis: "x" | "z";
  /** Wall plane coordinate on the face axis (e.g. -depth/2). */
  wall: number;
  /** Outward direction along the face axis: -1 or +1. */
  sign: number;
  /** Facade length along the face. */
  len: number;
  /** Center of the facade along its tangent axis (building-local). */
  center: number;
}

function faceBox(
  p: Parts,
  f: Face,
  mat: string,
  alongSize: number,
  ySize: number,
  outSize: number,
  along: number,
  y: number,
  out: number,
  tiltOut = 0,
  color?: THREE.Color,
): void {
  if (f.axis === "z") {
    const rx = tiltOut * f.sign;
    p.box(mat, alongSize, ySize, outSize, f.center + along, y, f.wall + f.sign * out, rx, 0, 0, color);
  } else {
    const rz = -tiltOut * f.sign;
    p.box(mat, outSize, ySize, alongSize, f.wall + f.sign * out, y, f.center + along, 0, 0, rz, color);
  }
}

/** Plane on a face, normal pointing outward. */
function facePlane(
  p: Parts,
  f: Face,
  mat: string,
  alongSize: number,
  ySize: number,
  along: number,
  y: number,
  out: number,
  color?: THREE.Color,
): void {
  if (f.axis === "z") {
    const ry = f.sign < 0 ? Math.PI : 0;
    p.plane(mat, alongSize, ySize, f.center + along, y, f.wall + f.sign * out, 0, ry, 0, color);
  } else {
    const ry = f.sign < 0 ? -Math.PI / 2 : Math.PI / 2;
    p.plane(mat, alongSize, ySize, f.wall + f.sign * out, y, f.center + along, 0, ry, 0, color);
  }
}

/**
 * Kit asset mounted on a face, front facing outward (kit models front +Z).
 * `along` is the tangent offset, `y` the model bottom, `out` the distance
 * from the wall plane.
 */
function facePlacement(
  f: Face,
  assetId: string,
  along: number,
  y: number,
  out: number,
  scale?: number,
): KitLocalPlacement {
  if (f.axis === "z") {
    return {
      assetId,
      x: f.center + along,
      y,
      z: f.wall + f.sign * out,
      ry: f.sign > 0 ? 0 : Math.PI,
      scale,
    };
  }
  return {
    assetId,
    x: f.wall + f.sign * out,
    y,
    z: f.center + along,
    ry: f.sign > 0 ? Math.PI / 2 : -Math.PI / 2,
    scale,
  };
}

/** Vertical cylinder on a face. */
function faceCyl(
  p: Parts,
  f: Face,
  mat: string,
  r: number,
  h: number,
  along: number,
  y: number,
  out: number,
): void {
  if (f.axis === "z") p.cyl(mat, r, h, f.center + along, y, f.wall + f.sign * out);
  else p.cyl(mat, r, h, f.wall + f.sign * out, y, f.center + along);
}

// ---------------------------------------------------------------------------
// Storefront (street-facing ground floor)
// ---------------------------------------------------------------------------

type BayKind = "window" | "door" | "shutter" | "service";

function buildStorefront(
  p: Parts,
  f: Face,
  rng: () => number,
  trimKey: string,
  isFront: boolean,
): void {
  const len = f.len;
  const pier = 0.35;
  const n = Math.max(1, Math.round(len / 4));
  const bw = (len - pier * (n + 1)) / n;

  // Piers between/around bays (proud 0.32 of the wall).
  for (let i = 0; i <= n; i++) {
    const a = -len / 2 + pier / 2 + i * (bw + pier);
    faceBox(p, f, trimKey, pier, 3.45, 0.32, a, 1.725, 0.16);
  }
  // Fascia band (sign zone) below the storefront cornice.
  faceBox(p, f, trimKey, len, 1.0, 0.34, 0, 3.95, 0.17);

  // Bay contents.
  const kinds: BayKind[] = [];
  for (let i = 0; i < n; i++) {
    const r = rng();
    kinds.push(r < 0.48 ? "window" : r < 0.66 ? "door" : r < 0.87 ? "shutter" : "service");
  }
  if (isFront && !kinds.includes("door") && n >= 2) {
    kinds[Math.floor(rng() * n)] = "door";
  }

  for (let i = 0; i < n; i++) {
    const a = -len / 2 + pier + bw / 2 + i * (bw + pier);
    const kind = kinds[i];

    if (kind === "window") {
      // Bulkhead base wall, glass, mullions, interior glow.
      faceBox(p, f, trimKey, bw + 0.04, 0.5, 0.26, a, 0.25, 0.13);
      facePlane(p, f, "glass", bw - 0.12, 2.8, a, 1.9, 0.115);
      const lit = rng() < 0.62;
      const glow = INTERIOR_GLOW[Math.floor(rng() * INTERIOR_GLOW.length)]
        .clone()
        .multiplyScalar(lit ? 1.0 + rng() * 0.55 : 1);
      facePlane(p, f, "neon", bw - 0.3, 2.55, a, 1.83, 0.05, lit ? glow : DIM_GLASS);
      if (lit) {
        // Light spill onto the sidewalk in front of the window.
        const spill = glow.clone().multiplyScalar(0.12);
        if (f.axis === "z") {
          p.plane("neon", bw - 0.2, 1.1, f.center + a, 0.012, f.wall + f.sign * 0.72, -Math.PI / 2, 0, 0, spill);
        } else {
          p.plane("neon", 1.1, bw - 0.2, f.wall + f.sign * 0.72, 0.012, f.center + a, -Math.PI / 2, 0, 0, spill);
        }
      }
      // Mullion frame: verticals + top/bottom rails.
      const panes = Math.max(2, Math.round(bw / 1.2));
      for (let k = 1; k < panes; k++) {
        const mx = a - (bw - 0.12) / 2 + (k * (bw - 0.12)) / panes;
        faceBox(p, f, "metalDark", 0.06, 2.8, 0.07, mx, 1.9, 0.13);
      }
      faceBox(p, f, "metalDark", bw - 0.06, 0.08, 0.08, a, 0.52, 0.13);
      faceBox(p, f, "metalDark", bw - 0.06, 0.08, 0.08, a, 3.3, 0.13);
      if (rng() < 0.55) addAwning(p, f, rng, a, bw);
    } else if (kind === "door") {
      // Recessed doorway with side panels, jambs, transom light, step.
      const panelW = (bw - 1.3) / 2;
      if (panelW > 0.05) {
        faceBox(p, f, trimKey, panelW, 3.45, 0.2, a - 0.65 - panelW / 2, 1.725, 0.1);
        faceBox(p, f, trimKey, panelW, 3.45, 0.2, a + 0.65 + panelW / 2, 1.725, 0.1);
      }
      faceBox(p, f, trimKey, 1.3, 0.85, 0.2, a, 3.02, 0.1); // header
      faceBox(p, f, "metalDark", 0.09, 2.45, 0.3, a - 0.62, 1.22, 0.15);
      faceBox(p, f, "metalDark", 0.09, 2.45, 0.3, a + 0.62, 1.22, 0.15);
      facePlane(p, f, "metalDark", 1.16, 2.15, a, 1.08, 0.035); // door, recessed
      facePlane(p, f, "neon", 1.05, 0.16, a, 2.36, 0.16, new THREE.Color("#ffd9a0").multiplyScalar(1.8));
      faceBox(p, f, "trim", 1.6, 0.09, 0.55, a, 0.045, 0.27); // step
      if (rng() < 0.4) addAwning(p, f, rng, a, bw);
    } else if (kind === "shutter") {
      // Roll-up corrugated shutter + housing box.
      faceBox(p, f, "corrugated", bw - 0.08, 3.1, 0.1, a, 1.55, 0.1);
      faceBox(p, f, "metalDark", bw + 0.02, 0.32, 0.26, a, 3.28, 0.13);
    } else {
      // Service: plain dark door + vent, wall left bare.
      faceBox(p, f, "metalDark", 1.0, 2.1, 0.09, a - bw * 0.18, 1.05, 0.05);
      faceBox(p, f, "grill", 0.6, 0.42, 0.07, a + bw * 0.24, 2.5, 0.045);
      faceCyl(p, f, "metalDark", 0.04, 3.2, a + bw * 0.42, 1.7, 0.1);
    }

    // Shop sign board on the fascia (~60% of bays).
    if (rng() < 0.6) {
      const sw = bw * (0.55 + rng() * 0.35);
      const sh = 0.55 + rng() * 0.25;
      const color = NEON[Math.floor(rng() * NEON.length)]
        .clone()
        .multiplyScalar(1.5 + rng() * 0.7);
      faceBox(p, f, "metalDark", sw + 0.1, sh + 0.1, 0.14, a, 3.95, 0.44);
      facePlane(p, f, "neon", sw, sh, a, 3.95, 0.525, color);
    } else {
      rng();
      rng();
      rng();
    }
  }
}

function addAwning(p: Parts, f: Face, rng: () => number, a: number, bw: number): void {
  if (rng() < 0.75) {
    // Sloped fabric awning.
    const color = AWNING_COLORS[Math.floor(rng() * AWNING_COLORS.length)];
    faceBox(p, f, "fabric", bw * 0.96, 0.05, 0.95, a, 3.38, 0.62, 0.38, color);
    // Valance strip hanging at the outer edge.
    faceBox(p, f, "fabric", bw * 0.96, 0.18, 0.04, a, 3.12, 1.02, 0, color);
  } else {
    // Flat metal canopy with an emissive under-strip along its front edge.
    rng();
    faceBox(p, f, "metal", bw * 0.96, 0.07, 0.9, a, 3.42, 0.58);
    facePlane(
      p,
      f,
      "neon",
      bw * 0.9,
      0.055,
      a,
      3.37,
      1.015,
      new THREE.Color("#cfe8ff").multiplyScalar(1.9),
    );
  }
}

// ---------------------------------------------------------------------------
// Service faces (alley sides): shutters/doors, AC units, conduit
// ---------------------------------------------------------------------------

function buildServiceFace(
  p: Parts,
  kit: KitLocalPlacement[],
  f: Face,
  rng: () => number,
  height: number,
): void {
  const len = f.len;
  // Ground level: a service door and sometimes a shutter.
  const doorA = (rng() - 0.5) * (len - 2.5);
  faceBox(p, f, "metalDark", 1.05, 2.15, 0.1, doorA, 1.07, 0.06);
  faceBox(p, f, "trim", 1.25, 0.12, 0.16, doorA, 2.28, 0.08); // lintel
  if (rng() < 0.45) {
    let a = (rng() - 0.5) * (len - 4);
    if (Math.abs(a - doorA) < 2.2) a = doorA + (a > doorA ? 2.4 : -2.4);
    faceBox(p, f, "corrugated", 2.4, 2.5, 0.1, a, 1.25, 0.06);
    faceBox(p, f, "metalDark", 2.5, 0.28, 0.2, a, 2.62, 0.1);
  } else {
    rng();
  }

  // Wall AC units on the upper facade: kit models, wall-mounted on a small
  // bracket shelf, scaled down from the floor-standing source (~0.9 m tall).
  // Skipped when the wall is too short (kit towers dress upper faces with
  // facade panels instead).
  if (height >= 6.6) {
    const acCount = 1 + Math.floor(rng() * 3);
    for (let i = 0; i < acCount; i++) {
      const a = (rng() - 0.5) * (len - 1.6);
      const y = 5.2 + rng() * Math.max(0.5, height - 6.6);
      const scale = 0.55 + rng() * 0.15;
      kit.push(facePlacement(f, KIT_AC[i % KIT_AC.length], a, y - 0.25, 0.02 + 0.25 * scale, scale));
      faceBox(p, f, "metalDark", 0.75 * scale + 0.1, 0.05, 0.5, a, y - 0.27, 0.25);
    }
  }

  // Vertical conduit / drain pipes.
  const pipeCount = 1 + Math.floor(rng() * 2);
  for (let i = 0; i < pipeCount; i++) {
    const a = (rng() < 0.5 ? -1 : 1) * (len / 2 - 0.5 - rng() * 1.2);
    faceCyl(p, f, "metalDark", 0.045, height - 0.5, a, (height - 0.5) / 2, 0.1);
  }
}

// ---------------------------------------------------------------------------
// Fire escapes (street faces of brick walk-ups)
// ---------------------------------------------------------------------------

/**
 * Zig-zag fire escape: a landing with railings at every floor, connected by
 * angled stair runs, with a drop ladder below the lowest landing. Coarse
 * merged boxes — the silhouette is what reads at the game camera.
 */
function buildFireEscape(
  p: Parts,
  f: Face,
  rng: () => number,
  height: number,
  stories: number,
): void {
  const FW = 2.5; // landing width along the face
  const PD = 0.72; // landing depth off the wall
  const along = (rng() - 0.5) * Math.max(0, f.len - FW - 2.4);

  // Box on the face frame with an optional tilt about the outward axis
  // (stair runs rise along the face).
  const fbox = (
    alongSize: number,
    ySize: number,
    outSize: number,
    a: number,
    y: number,
    out: number,
    tilt = 0,
  ) => {
    if (f.axis === "z") {
      p.box("metalDark", alongSize, ySize, outSize, f.center + a, y, f.wall + f.sign * out, 0, 0, tilt);
    } else {
      p.box("metalDark", outSize, ySize, alongSize, f.wall + f.sign * out, y, f.center + a, -tilt, 0, 0);
    }
  };

  let lowestY = 0;
  for (let i = 1; i < stories; i++) {
    const y = 4.5 + (i - 1) * 3;
    if (y > height - 1.2) break;
    lowestY = lowestY || y;
    // Landing platform + open-grate lip.
    fbox(FW, 0.07, PD, along, y, 0.2 + PD / 2);
    // Railings: top rail, mid rail, corner + mid posts, and side rails.
    const railY = y + 0.95;
    fbox(FW, 0.05, 0.05, along, railY, 0.2 + PD - 0.04);
    fbox(FW, 0.04, 0.04, along, y + 0.5, 0.2 + PD - 0.04);
    for (const pa of [-FW / 2 + 0.04, 0, FW / 2 - 0.04]) {
      fbox(0.05, 1.0, 0.05, along + pa, y + 0.5, 0.2 + PD - 0.04);
    }
    fbox(0.05, 0.05, PD, along - FW / 2 + 0.04, railY, 0.2 + PD / 2);
    fbox(0.05, 0.05, PD, along + FW / 2 - 0.04, railY, 0.2 + PD / 2);
    // Stair run up to the next landing (alternating direction), while a
    // floor above exists.
    const yn = y + 3;
    if (yn <= height - 1.2 && i + 1 < stories) {
      const dir = i % 2 === 0 ? 1 : -1;
      const run = FW - 0.7;
      const tilt = Math.atan2(run, 3) * dir;
      const len = Math.hypot(run, 3);
      fbox(0.6, len, 0.06, along + (dir * run) / 2 - (dir * 0.35) / 2, (y + yn) / 2 + 0.04, 0.44, tilt);
      // Stair rail following the run.
      fbox(0.05, len, 0.05, along + (dir * run) / 2 - (dir * 0.35) / 2, (y + yn) / 2 + 0.95, 0.66, tilt);
    }
    // Wall brackets under the landing.
    fbox(0.07, 0.07, PD, along - FW / 2 + 0.2, y - 0.05, 0.2 + PD / 2);
    fbox(0.07, 0.07, PD, along + FW / 2 - 0.2, y - 0.05, 0.2 + PD / 2);
  }

  // Drop ladder hanging from the lowest landing (stops ~2.2 m above ground).
  if (lowestY > 0) {
    const ladderLen = Math.min(2.2, lowestY - 2.2);
    if (ladderLen > 0.6) {
      const ly = lowestY - ladderLen / 2 - 0.05;
      fbox(0.05, ladderLen, 0.05, along - 0.25, ly, 0.5);
      fbox(0.05, ladderLen, 0.05, along + 0.25, ly, 0.5);
      const rungs = Math.floor(ladderLen / 0.33);
      for (let r = 0; r < rungs; r++) {
        fbox(0.5, 0.035, 0.035, along, lowestY - 0.25 - r * 0.33, 0.5);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Roof dressing
// ---------------------------------------------------------------------------

/** Kit AC units used for rooftop HVAC and wall-mounted units. */
const KIT_AC = ["lab_sm_ac01", "lab_sm_ac02", "lab_sm_aircon"];

/**
 * Facade signage: 3D neon lettering signs mounted flat on the upper wall
 * (kit dims width/height/thickness; the flat billboard frames in the kit have
 * no screens, so only the lettering pieces are used).
 */
const KIT_BILLBOARDS = [
  { assetId: "lab_sm_3dbillboard03", w: 2.9, h: 1.3, t: 0.1, ryOffset: 0 },
  { assetId: "lab_sm_3dbillboard01", w: 6.3, h: 2.5, t: 0.25, ryOffset: 0 },
];

function buildRoof(
  p: Parts,
  kit: KitLocalPlacement[],
  rng: () => number,
  w: number,
  d: number,
  height: number,
  stories: number,
): WaterTowerPlacement | null {
  const deckTop = height + 0.08;
  const hx = Math.max(1.2, w / 2 - 0.95);
  const hz = Math.max(1.2, d / 2 - 0.95);

  // Shuffled 3x3 anchor grid keeps items inside the parapet and non-stacked.
  const anchors: [number, number][] = [];
  for (const ix of [-0.62, 0, 0.62]) {
    for (const iz of [-0.62, 0, 0.62]) {
      anchors.push([ix * hx + (rng() - 0.5) * 0.5, iz * hz + (rng() - 0.5) * 0.5]);
    }
  }
  for (let i = anchors.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [anchors[i], anchors[j]] = [anchors[j], anchors[i]];
  }
  let next = 0;
  const anchor = (): [number, number] => anchors[next++ % anchors.length];

  // Roof access bulkhead (always).
  {
    const [ax, az] = anchor();
    const bx = THREE.MathUtils.clamp(ax, -(hx - 0.9), hx - 0.9);
    const bz = THREE.MathUtils.clamp(az, -(hz - 0.9), hz - 0.9);
    p.box("trim", 2.2, 2.6, 2.5, bx, deckTop + 1.3, bz);
    p.box("metal", 2.38, 0.1, 2.68, bx, deckTop + 2.66, bz, 0.05);
    p.plane("metalDark", 0.92, 2.0, bx, deckTop + 1.0, bz - 1.26, 0, Math.PI);
  }

  // Water tower spot (rendered separately in Buildings.tsx; KayKit or fallback).
  let waterTower: WaterTowerPlacement | null = null;
  if (stories >= 5 && rng() < 0.5) {
    const [ax, az] = anchor();
    waterTower = {
      x: THREE.MathUtils.clamp(ax, -(hx - 1.1), hx - 1.1),
      z: THREE.MathUtils.clamp(az, -(hz - 1.1), hz - 1.1),
      baseY: deckTop,
      ry: rng() * Math.PI * 2,
    };
  }

  // HVAC: kit AC units instead of procedural boxes-with-fan-circles.
  const hvacCount = 1 + Math.floor(rng() * 4);
  for (let i = 0; i < hvacCount; i++) {
    const [ax, az] = anchor();
    const assetId = KIT_AC[Math.floor(rng() * KIT_AC.length)];
    const scale = 1.6 + rng() * 1.2;
    const bx = THREE.MathUtils.clamp(ax, -(hx - 1.2), hx - 1.2);
    const bz = THREE.MathUtils.clamp(az, -(hz - 1.2), hz - 1.2);
    kit.push({ assetId, x: bx, y: deckTop, z: bz, ry: rng() * Math.PI * 2, scale });
  }

  // Small vents.
  const ventCount = 2 + Math.floor(rng() * 3);
  for (let i = 0; i < ventCount; i++) {
    const [ax, az] = anchor();
    if (rng() < 0.6) {
      const vh = 0.4 + rng() * 0.5;
      p.cyl("trim", 0.1 + rng() * 0.07, vh, ax, deckTop + vh / 2, az);
      p.cyl("metalDark", 0.16, 0.07, ax, deckTop + vh + 0.03, az);
    } else {
      p.box("metal", 0.5, 0.35 + rng() * 0.25, 0.4, ax, deckTop + 0.2, az, 0, rng());
    }
  }

  // Pipe runs across the roof.
  const pipeCount = 1 + Math.floor(rng() * 2);
  for (let i = 0; i < pipeCount; i++) {
    const alongX = rng() < 0.5;
    const length = (alongX ? hx : hz) * (1.1 + rng() * 0.7);
    const off = (rng() - 0.5) * 1.4 * (alongX ? hz : hx);
    if (alongX) p.cyl("metalDark", 0.05, length, (rng() - 0.5) * 0.6, deckTop + 0.1, off, 0, 0, Math.PI / 2);
    else p.cyl("metalDark", 0.05, length, off, deckTop + 0.1, (rng() - 0.5) * 0.6, Math.PI / 2);
  }

  // Rooftop billboard facing the -z street (~25%).
  if (rng() < 0.25) {
    const bwid = Math.min(w - 2.4, 3.6 + rng() * 3);
    const bh = 1.3 + rng() * 0.8;
    const bz = hz * 0.55;
    const by = deckTop + 1.6 + bh / 2;
    const color = NEON[Math.floor(rng() * NEON.length)].clone().multiplyScalar(1.5 + rng() * 0.6);
    p.cyl("metalDark", 0.06, by - deckTop, -bwid * 0.38, deckTop + (by - deckTop) / 2, bz + 0.12);
    p.cyl("metalDark", 0.06, by - deckTop, bwid * 0.38, deckTop + (by - deckTop) / 2, bz + 0.12);
    p.box("metalDark", bwid, bh, 0.1, 0, by, bz, -0.09);
    p.plane("neon", bwid - 0.12, bh - 0.12, 0, by + 0.006, bz - 0.062, -0.09, Math.PI, 0, color);
  } else {
    rng();
    rng();
    rng();
  }

  // Antenna cluster (~45%).
  if (rng() < 0.45) {
    const [ax, az] = anchor();
    const count = 2 + Math.floor(rng() * 2);
    for (let i = 0; i < count; i++) {
      const ah = 1.4 + rng() * 2.4;
      const ox = ax + (rng() - 0.5) * 0.9;
      const oz = az + (rng() - 0.5) * 0.9;
      p.cyl("metalDark", 0.025, ah, ox, deckTop + ah / 2, oz);
      p.box(
        "neon",
        0.07,
        0.07,
        0.07,
        ox,
        deckTop + ah + 0.04,
        oz,
        0,
        0,
        0,
        new THREE.Color("#ff2222").multiplyScalar(2.6),
      );
    }
  }

  return waterTower;
}

// ---------------------------------------------------------------------------
// Kit-bashed tower (archetype 3): stacked cyberpunk skyscraper modules
// ---------------------------------------------------------------------------

/**
 * Facade wall tile from the skyscraper kit. The kit builds a skyscraper from
 * three tile kinds (verified by probing the authored FBX geometry):
 *  - flat tiles (~1 m relief window/slat panels) — safe anywhere, including
 *    face ends where two faces meet at a building corner;
 *  - relief tiles (balcony/greeble modules protruding 4-6.6 m) — mid-face
 *    only; at a corner their side trusses stab through the adjacent face;
 *  - corner/crown pieces (L-shaped plans, setback tops) — not tileable on a
 *    flat wall grid at all, so they never enter this pool.
 */
export interface KitTowerPanel {
  assetId: string;
  /** Authored module height in meters (from Asset Lab meta dimensions). */
  h: number;
  /** Authored grid pitch (width). Falls back to KitTowerConfig.moduleWidth. */
  w?: number;
  /** Authored depth (wall relief) in meters; classifies flat vs relief. */
  d?: number;
  /**
   * Model-space distance from the pivot back to the authored wall plane
   * (from Asset Lab meta bbox). Falls back to KitTowerConfig.wallZ.
   */
  wallZ?: number;
  /**
   * Rotate 180° when placing: some kit tiles (most slum storefronts) are
   * authored facing the opposite direction from the skyscraper modules.
   */
  flip?: boolean;
  /**
   * L-shaped corner module: one 12 m facade leg along each adjacent face,
   * authored with wall planes on the kit's x=0 / y=12 grid lines. Placed
   * only at building corners, never as a wall tile; wallZ is the
   * pivot-to-wall-plane distance (same on both axes).
   */
  corner?: boolean;
}

/** Tiles with no more relief than this are safe at face ends/corners. */
const FLAT_TILE_DEPTH = 1.6;

/**
 * Kits stack tiles on a fixed vertical grid (6 m for the skyscraper kit,
 * 3 m for the mid-rise kits); authored heights run a few tenths over
 * (12.145, 12.358, ...) because tiles carry a trim lip that overlaps the
 * seam of the row above. Stack by grid height, not bbox height.
 */
function gridHeight(p: KitTowerPanel, row: number): number {
  return Math.max(row, Math.round(p.h / row) * row);
}

/**
 * Tunable kit-tower facade parameters. The game always uses
 * DEFAULT_KIT_TOWER_CONFIG; the Building Stage dev tool passes live-edited
 * configs through buildBuildingModel to preview panel setups.
 */
export interface KitTowerConfig {
  /** Upper-band module pool; one is picked per row (seeded by style). */
  panels: KitTowerPanel[];
  /**
   * L-corner modules for the upper bands (one picked per building). Placed
   * at building corners on grid-multiple footprints; wall tiles then only
   * fill the slots between the corner legs.
   */
  cornerPanels?: KitTowerPanel[];
  /**
   * Street-level storefront tiles forming the ground band. When present and
   * the footprint fits the grid, the whole building is kit meshes and no
   * procedural storefront is generated. Entries with corner:true are the
   * band's L-corner pieces.
   */
  groundPanels?: KitTowerPanel[];
  /** Authored module width in meters (grid pitch along each face). */
  moduleWidth: number;
  /**
   * Vertical grid pitch in meters (row stacking height). Defaults to 6, the
   * skyscraper kit's grid; the mid-rise kits stack on 3 m rows.
   */
  rowHeight?: number;
  /** Fallback wall-plane offset for panels without their own wallZ. */
  wallZ: number;
  /** Procedural storefront height used when groundPanels cannot be placed. */
  baseHeight: number;
  /** Render facade panels only (no procedural geometry). */
  panelsOnly?: boolean;
  /** Treat any building as a kit tower regardless of archetype/stories. */
  forceKitTower?: boolean;
  /**
   * Stacked-slice kit (CB01): each panel is a complete floor slice of the
   * whole building plan (U-shaped 12x4 m band), not a per-face wall tile.
   * Rows place one slice centered on the footprint instead of tiling faces.
   */
  stacked?: boolean;
}

// The upper-story wall classes of the skyscraper kit: 12x12 m balcony
// modules (01-04, relief) and the flat window panel (18), plus the 6x6 m
// flat cladding filler (17) that tops off bands whole 12 m rows cannot
// fill. Module10 is the L-corner piece pairing with them (facade planes
// authored on the x=0 / y=12 grid lines, ~6.07 m from the pivot).
// h/w/d/wallZ come from the Asset Lab authored metadata.
export const DEFAULT_KIT_TOWER_CONFIG: KitTowerConfig = {
  panels: [
    { assetId: "lab_sm_skyscraper_module01", h: 12.145, d: 4.203, wallZ: 1.813 },
    { assetId: "lab_sm_skyscraper_module02", h: 12.081, d: 4.101, wallZ: 1.843 },
    { assetId: "lab_sm_skyscraper_module03", h: 12.358, d: 4.189, wallZ: 1.8 },
    { assetId: "lab_sm_skyscraper_module04", h: 12.103, d: 6.614, wallZ: 3.012 },
    { assetId: "lab_sm_skyscraper_module18", h: 12, d: 1.005, wallZ: 0.294 },
    { assetId: "lab_sm_skyscraper_module17", h: 6, w: 6, d: 0.426, wallZ: 0.213 },
  ],
  cornerPanels: [
    { assetId: "lab_sm_skyscraper_module10", h: 12.224, w: 12, wallZ: 6.07, corner: true },
  ],
  // Street-level tiles, in two coherent styles (grouped by authored height):
  // - the 12 m corporate storefront chunk (skyscraper module16) plus its
  //   L-corner variant (module15);
  // - the 4 m slum shop strip (mixed 3/5/6 m fronts: shops, shutters, bars).
  // Most slum fronts are authored facing +y (opposite the skyscraper
  // modules), hence flip; 04 is a shuttered service wall authored like the
  // skyscraper tiles.
  groundPanels: [
    { assetId: "lab_sm_skyscraper_module16", h: 12.179, w: 12, d: 1.485, wallZ: 0.743 },
    { assetId: "lab_sm_skyscraper_module15", h: 12.291, w: 12, wallZ: 6.02, corner: true },
    { assetId: "lab_sm_slum_storefront01", h: 4, w: 3, d: 0.614, wallZ: 0.258, flip: true },
    { assetId: "lab_sm_slum_storefront02", h: 4, w: 3, d: 0.416, wallZ: 0.108, flip: true },
    { assetId: "lab_sm_slum_storefront03", h: 4, w: 3, d: 0.455, wallZ: 0.093, flip: true },
    { assetId: "lab_sm_slum_storefront04", h: 4, w: 6, d: 0.336, wallZ: 0.154 },
    { assetId: "lab_sm_slum_storefront05", h: 4, w: 6, d: 0.522, wallZ: 0.176, flip: true },
    { assetId: "lab_sm_slum_storefront06", h: 4, w: 6, d: 0.577, wallZ: 0.189, flip: true },
    { assetId: "lab_sm_slum_storefront07", h: 4, w: 6, d: 0.44, wallZ: 0.21, flip: true },
    { assetId: "lab_sm_storefront_closed", h: 4, w: 5, d: 0.406, wallZ: 0.125, flip: true },
  ],
  moduleWidth: 12,
  wallZ: 1.81,
  baseHeight: 4.8,
  panelsOnly: false,
};

/**
 * Taller archetype-3 towers keep their procedural storefront base but wrap
 * the upper mass in kit facade panels (needs >= ~11 m of upper facade for
 * the panels to keep sane proportions).
 */
export function isKitTower(b: BuildingInstance): boolean {
  return b.archetype === 3 && b.stories >= 5;
}

/**
 * Corner slots for L-corner modules: [sx, sz, ry]. The modules' facades
 * face local +x/+z (post at that corner), so ry=0 fits the (+,+) building
 * corner and each further corner is a 90° step.
 */
const CORNER_SLOTS: [number, number, number][] = [
  [1, 1, 0],
  [1, -1, Math.PI / 2],
  [-1, -1, Math.PI],
  [-1, 1, (3 * Math.PI) / 2],
];

/**
 * Pick the building corners that take an L-corner module. Each L covers
 * 12 m along both adjacent faces, so a 12 m face can only take one L
 * (two would overlap); longer faces take one per corner. Greedy over the
 * fixed slot order; on a 12x12 footprint this yields the two diagonal
 * corners (the vendor's own thin-tower pattern).
 */
function selectCorners(w: number, d: number): [number, number, number][] {
  const placed: [number, number, number][] = [];
  const legs = new Map<string, number>();
  for (const c of CORNER_SLOTS) {
    const faces: [string, number][] = [
      [c[1] > 0 ? "back" : "front", w],
      [c[0] > 0 ? "right" : "left", d],
    ];
    if (faces.some(([f, len]) => (legs.get(f) ?? 0) > 0 && len < 24)) continue;
    for (const [f] of faces) legs.set(f, (legs.get(f) ?? 0) + 1);
    placed.push(c);
  }
  return placed;
}

/** Corner key ("sx,sz") for one end of a face (slot k=0 or k=n-1). */
function faceEndCorner(f: Face, atStart: boolean): string {
  return f.axis === "z" ? `${atStart ? -1 : 1},${f.sign}` : `${f.sign},${atStart ? -1 : 1}`;
}

/** Place one L-corner module at each selected corner of a band. */
function placeCorners(
  kit: KitLocalPlacement[],
  mod: KitTowerPanel,
  corners: [number, number, number][],
  w: number,
  d: number,
  y: number,
  cfg: KitTowerConfig,
): void {
  // Corner wall planes sit on the facade side of the pivot (unlike straight
  // tiles, whose pivot is outside the wall), so the pivot goes wallZ inside
  // the building wall, plus the same 0.1 m embed as the straight tiles.
  const dist = (mod.wallZ ?? cfg.wallZ) + 0.1;
  for (const [sx, sz, ry] of corners) {
    kit.push({ assetId: mod.assetId, x: sx * (w / 2 - dist), y, z: sz * (d / 2 - dist), ry });
  }
}

/**
 * Randomized exact fill of a face length with the group's tile widths
 * (recursive subset-sum). Returns the width sequence, or null when the
 * widths cannot compose the length exactly.
 */
function fillWidths(len: number, widths: number[], rng: () => number): number[] | null {
  if (len < 1e-6) return [];
  const order = [...widths].sort(() => rng() - 0.5);
  for (const tw of order) {
    if (tw > len + 1e-6) continue;
    const rest = fillWidths(len - tw, widths, rng);
    if (rest) return [tw, ...rest];
  }
  return null;
}

/**
 * Street-level band of storefront tiles around all four faces. The ground
 * pool splits into coherent style groups by band height (the 12 m corporate
 * storefront chunk vs the 4 m slum shop strip); one group is picked per
 * building among those whose tile widths exactly fill every face, so the
 * ground floor has no bare gaps. Returns the band height (the upper bands'
 * baseY), or null when nothing fits and the caller keeps the procedural
 * storefront.
 */
function buildKitTowerGround(
  b: BuildingInstance,
  kit: KitLocalPlacement[],
  w: number,
  d: number,
  cfg: KitTowerConfig,
): number | null {
  const pool = cfg.groundPanels ?? [];
  if (pool.length === 0) return null;
  const rng = mulberry(b.style ^ 0x3d0f8b21);

  const groups = new Map<number, KitTowerPanel[]>();
  for (const p of pool) {
    const key = Math.round(p.h);
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  const candidates = [...groups.entries()].filter(([, tiles]) => {
    const widths = [...new Set(tiles.filter((t) => !t.corner).map((t) => t.w ?? cfg.moduleWidth))];
    return fillWidths(w, widths, rng) !== null && fillWidths(d, widths, rng) !== null;
  });
  if (candidates.length === 0) return null;
  const [bandH, group] = candidates[Math.floor(rng() * candidates.length)];
  const tiles = group.filter((t) => !t.corner);
  const cornerTiles = group.filter((t) => t.corner);
  const widths = [...new Set(tiles.map((t) => t.w ?? cfg.moduleWidth))];

  // L-corner pieces (12 m legs) need every face to sit on the 12 m grid.
  const legW = cfg.moduleWidth;
  const corners =
    cornerTiles.length > 0 && w % legW === 0 && d % legW === 0 ? selectCorners(w, d) : [];
  if (corners.length > 0) {
    placeCorners(kit, cornerTiles[Math.floor(rng() * cornerTiles.length)], corners, w, d, 0, cfg);
  }
  const covered = new Set(corners.map(([sx, sz]) => `${sx},${sz}`));

  const faces: Face[] = [
    { axis: "z", wall: -d / 2, sign: -1, len: w, center: 0 },
    { axis: "z", wall: d / 2, sign: 1, len: w, center: 0 },
    { axis: "x", wall: -w / 2, sign: -1, len: d, center: 0 },
    { axis: "x", wall: w / 2, sign: 1, len: d, center: 0 },
  ];
  for (const f of faces) {
    const startLeg = covered.has(faceEndCorner(f, true)) ? legW : 0;
    const endLeg = covered.has(faceEndCorner(f, false)) ? legW : 0;
    const span = f.len - startLeg - endLeg;
    if (span <= 0) continue;
    const run = fillWidths(span, widths, rng);
    if (!run) continue; // leftover span the widths cannot compose stays bare
    let along = -f.len / 2 + startLeg;
    for (const tw of run) {
      const options = tiles.filter((t) => (t.w ?? cfg.moduleWidth) === tw);
      const mod = options[Math.floor(rng() * options.length)];
      const out = (mod.wallZ ?? cfg.wallZ) - 0.1;
      const pl = facePlacement(f, mod.assetId, along + tw / 2, 0, out);
      if (mod.flip) pl.ry += Math.PI;
      kit.push(pl);
      along += tw;
    }
  }
  return bandH;
}

/**
 * Stacked-slice facade (CB01 mid-rise kit): each module is a floor slice of
 * the whole 12 m building plan — a facade band with ~4 m side returns (U
 * shape), or a full-plan ring — with the pivot at the plan center, not a
 * per-face wall tile. U slices go on the front and back of the footprint
 * with the same module per row so their side returns meet mid-face; ring
 * slices sit once, centered. Footprints should be one module wide and about
 * two U-slice depths deep (e.g. 12 x 8 m). Returns the stack top y.
 */
function buildStackedFacade(
  b: BuildingInstance,
  kit: KitLocalPlacement[],
  w: number,
  d: number,
  baseY: number,
  height: number,
  cfg: KitTowerConfig,
): number {
  if (cfg.panels.length === 0) return baseY;
  const rng = mulberry(b.style ^ 0x8c17f2ad);
  // Slices only join cleanly with slices of the same authored footprint:
  // mixing the 12.2 x 4.152 walkway with the 12 x 4.072 window bands leaves
  // 0.1 m ledges and pokes interior floor slabs through the rows around it.
  // Commit to one footprint group per building; rows vary within the group.
  // Footprints are quantized to 0.25 m so trim-lip variants (12 x 4 vs
  // 12 x 4.072) still stack together.
  const groups = new Map<string, KitTowerPanel[]>();
  const q = (v: number) => Math.round(v * 4) / 4;
  for (const p of cfg.panels) {
    const key = `${q(p.w ?? cfg.moduleWidth)}x${q(p.d ?? 4)}`;
    const list = groups.get(key);
    if (list) list.push(p);
    else groups.set(key, [p]);
  }
  const pool = [...groups.values()][Math.floor(rng() * groups.size)];
  const front: Face = { axis: "z", wall: -d / 2, sign: -1, len: w, center: 0 };
  const back: Face = { axis: "z", wall: d / 2, sign: 1, len: w, center: 0 };
  let y = baseY;
  for (;;) {
    const fits = pool.filter((p) => y + p.h <= height + 0.6);
    if (fits.length === 0) break;
    const mod = fits[Math.floor(rng() * fits.length)];
    const sliceD = mod.d ?? 4;
    if (sliceD >= d - 1) {
      // Full-plan ring slice: one per row, centered, facing the street.
      kit.push({ assetId: mod.assetId, x: 0, y, z: 0, ry: Math.PI });
    } else {
      // U slices front + back, placed so their open ends butt exactly at
      // the footprint midline (coplanar side-wall overlap z-fights); any
      // slice overrun past d/2 pokes outward past the wall plane instead.
      for (const f of [front, back]) {
        kit.push(facePlacement(f, mod.assetId, 0, y, (sliceD - d) / 2));
      }
    }
    // Advance by the authored height, not the rounded grid pitch: the
    // 3.002 m window bands stacked on a rounded 3 m step would overlap the
    // row above by 2 mm and z-fight along every floor line.
    y += mod.h;
  }
  return y;
}

/** One horizontal band of facade tiles, following the kit's assembly rules. */
interface KitTowerRow {
  /** Mid-face tile for this band (balcony/relief module). */
  relief: KitTowerPanel;
  /** Corner-safe tile used at face ends (flat panel). */
  flat: KitTowerPanel;
  /** Grid pitch shared by both tiles of the band. */
  pitch: number;
  y: number;
  h: number;
}

/**
 * Wrap the upper mass (above the storefront base) with facade tiles exactly
 * as the kit assembles them: whole modules at authored 1:1 scale on the kit's
 * 6 m grid, wall plane embedded 0.1 m into the mass. Face ends (building
 * corners) always take flat tiles; relief balcony tiles only fill interior
 * slots, so adjacent faces butt cleanly at corners.
 *
 * One flat + one relief module is chosen per building and repeated on every
 * full row: authored heights overrun the 12 m grid by a trim lip
 * (12.145, 12.358, ...) that is designed to mesh with a copy of the same
 * module stacked above — mixing modules per row makes those lips interpenetrate
 * the band above. Part-height leftovers get the small filler class (6 m);
 * anything below that stays bare and reads as the dark core.
 */
function buildKitTowerFacade(
  b: BuildingInstance,
  kit: KitLocalPlacement[],
  w: number,
  d: number,
  baseY: number,
  height: number,
  cfg: KitTowerConfig,
): void {
  if (cfg.panels.length === 0) return;
  const flats = cfg.panels.filter((p) => (p.d ?? 0) <= FLAT_TILE_DEPTH);
  const reliefs = cfg.panels.filter((p) => (p.d ?? 0) > FLAT_TILE_DEPTH);

  // Building-wide picks, seeded per building for variety across the block.
  const rng = mulberry(b.style ^ 0x8c17f2ad);
  const pick = (pool: KitTowerPanel[]) => pool[Math.floor(rng() * pool.length)];
  const rowH = cfg.rowHeight ?? 6;
  const mainPitch = cfg.moduleWidth;
  const mainFlats = flats.filter((p) => (p.w ?? mainPitch) === mainPitch);
  const fillers = flats.filter((p) => (p.w ?? mainPitch) < mainPitch);
  if (mainFlats.length === 0) return;
  const flat = pick(mainFlats);
  const relief = reliefs.length > 0 ? pick(reliefs) : flat;
  const filler = fillers.length > 0 ? pick(fillers) : undefined;

  // L-corner module: takes the corner slots of every full-height row when
  // the footprint sits on the kit's 12 m grid (its legs are 12 m long).
  const cornerPool = (cfg.cornerPanels ?? []).filter((p) => p.corner);
  const useCorners = cornerPool.length > 0 && w % mainPitch === 0 && d % mainPitch === 0;
  const cornerMod = useCorners ? pick(cornerPool) : undefined;
  const corners = cornerMod ? selectCorners(w, d) : [];
  const covered = new Set(corners.map(([sx, sz]) => `${sx},${sz}`));

  const rows: KitTowerRow[] = [];
  // Tolerance covers the authored trim lip that overhangs the grid height.
  for (let y = baseY; ; ) {
    const fits = (p: KitTowerPanel) => y + gridHeight(p, rowH) <= height + 0.6;
    let band: KitTowerRow | undefined;
    if (fits(flat)) {
      band = {
        relief: fits(relief) ? relief : flat,
        flat,
        pitch: mainPitch,
        y,
        h: gridHeight(flat, rowH),
      };
    } else if (filler && fits(filler)) {
      band = {
        relief: filler,
        flat: filler,
        pitch: filler.w ?? mainPitch,
        y,
        h: gridHeight(filler, rowH),
      };
    }
    if (!band) break;
    rows.push(band);
    y += band.h;
  }

  for (const row of rows) {
    // Corner legs only mesh with full-pitch rows of matching grid height.
    if (cornerMod && row.pitch === mainPitch && row.h === gridHeight(cornerMod, rowH)) {
      placeCorners(kit, cornerMod, corners, w, d, row.y, cfg);
    }
  }

  const faces: Face[] = [
    { axis: "z", wall: -d / 2, sign: -1, len: w, center: 0 },
    { axis: "z", wall: d / 2, sign: 1, len: w, center: 0 },
    { axis: "x", wall: -w / 2, sign: -1, len: d, center: 0 },
    { axis: "x", wall: w / 2, sign: 1, len: d, center: 0 },
  ];
  for (const f of faces) {
    for (const row of rows) {
      const rowHasCorners =
        cornerMod !== undefined &&
        row.pitch === mainPitch &&
        row.h === gridHeight(cornerMod, rowH);
      const n = Math.floor(f.len / row.pitch);
      if (n < 1) continue;
      const rowW = n * row.pitch;
      for (let k = 0; k < n; k++) {
        const atStart = k === 0;
        const atEnd = k === n - 1;
        // Slots occupied by an L-corner leg on this face.
        if (rowHasCorners) {
          if (atStart && covered.has(faceEndCorner(f, true))) continue;
          if (atEnd && covered.has(faceEndCorner(f, false))) continue;
        }
        const mod = atStart || atEnd ? row.flat : row.relief;
        const out = (mod.wallZ ?? cfg.wallZ) - 0.1;
        const along = -rowW / 2 + (k + 0.5) * row.pitch;
        const pl = facePlacement(f, mod.assetId, along, row.y, out);
        if (mod.flip) pl.ry += Math.PI;
        kit.push(pl);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

const STORE_TRIMS = ["storeTrim0", "storeTrim1", "storeTrim2", "storeTrim3"];

export function buildBuildingModel(
  b: BuildingInstance,
  cfg: KitTowerConfig = DEFAULT_KIT_TOWER_CONFIG,
): BuildingModel {
  const w = (b.tx1 - b.tx0) * TILE_SIZE;
  const d = (b.tz1 - b.tz0) * TILE_SIZE;
  const height = 4.5 + (b.stories - 1) * 3;
  const x = b.tx0 * TILE_SIZE + w / 2;
  const z = b.tz0 * TILE_SIZE + d / 2;

  const p = new Parts();
  const kit: KitLocalPlacement[] = [];
  const kitTower = cfg.forceKitTower || isKitTower(b);

  // Kit towers with a grid-fitting footprint get a full storefront band of
  // kit tiles; every visible wall is then an authored mesh and all the
  // procedural street-level dressing is skipped.
  const kitGroundH = kitTower ? buildKitTowerGround(b, kit, w, d, cfg) : null;
  const baseY = kitGroundH ?? cfg.baseHeight;

  // Debug isolation: only the imported panel shell, no procedural geometry.
  if (kitTower && cfg.panelsOnly) {
    if (cfg.stacked) {
      // Slices are complete authored floors (walls + recessed interiors);
      // the only procedural geometry is a roof deck capping the open top.
      const top = buildStackedFacade(b, kit, w, d, baseY, height, cfg);
      if (top > baseY) p.box("roof", w - 0.3, 0.12, d - 0.3, 0, top - 0.06, 0);
    } else {
      buildKitTowerFacade(b, kit, w, d, baseY, height, cfg);
    }
    return { geoms: p.build(), waterTower: null, kit, x, z, width: w, depth: d, height };
  }

  const styleRng = mulberry(b.style ^ 0xa511e9b3);
  const trimKey = STORE_TRIMS[Math.floor(styleRng() * STORE_TRIMS.length)];
  const sideStorefront = !kitGroundH && styleRng() < 0.5;
  const proud = 0.3;

  // --- Massing -------------------------------------------------------------
  // Ground-floor block sits proud of the upper mass on street-facing sides
  // (-z always; -x when it also has a storefront). Both share the facade
  // material (world-space tiling hides the seam).
  const baseD = d + proud;
  const baseW = sideStorefront ? w + proud : w;
  const baseCx = sideStorefront ? -proud / 2 : 0;
  if (kitGroundH) {
    // Fully tiled walls; the slightly inset dark core just seals the thin
    // corner slivers between the tiles' authored wall slabs.
    p.box("metalDark", w - 0.5, height, d - 0.5, 0, height / 2, 0);
  } else {
    p.box("facade", baseW, 4.5, baseD, baseCx, 2.25, -proud / 2);
    // Cornice lip capping the storefront base.
    p.box("trim", baseW + 0.3, 0.3, baseD + 0.3, baseCx, 4.65, -proud / 2);
    if (kitTower) {
      // Kit towers wrap this mass in facade panels; a slightly inset dark
      // core seals panel gaps and the bare face-end strips (the panels'
      // back slabs sit ~0.2 m inside the wall plane, the core at 0.25 m).
      p.box("metalDark", w - 0.5, height - baseY, d - 0.5, 0, (baseY + height) / 2, 0);
    } else {
      p.box("facade", w, height - 4.8, d, 0, (4.8 + height) / 2, 0);
    }
  }

  // Parapet ring (slightly proud, 0.9m above the roof plane) + trim caps.
  const pt = 0.28;
  p.box("facade", w + 0.16, 0.95, pt, 0, height + 0.375, -(d / 2 - 0.06));
  p.box("facade", w + 0.16, 0.95, pt, 0, height + 0.375, d / 2 - 0.06);
  p.box("facade", pt, 0.95, d + 0.16, -(w / 2 - 0.06), height + 0.375, 0);
  p.box("facade", pt, 0.95, d + 0.16, w / 2 - 0.06, height + 0.375, 0);
  p.box("trim", w + 0.3, 0.08, pt + 0.14, 0, height + 0.89, -(d / 2 - 0.06));
  p.box("trim", w + 0.3, 0.08, pt + 0.14, 0, height + 0.89, d / 2 - 0.06);
  p.box("trim", pt + 0.14, 0.08, d + 0.3, -(w / 2 - 0.06), height + 0.89, 0);
  p.box("trim", pt + 0.14, 0.08, d + 0.3, w / 2 - 0.06, height + 0.89, 0);

  // Roof deck (rolled asphalt).
  p.box("roof", w - 0.44, 0.08, d - 0.44, 0, height + 0.04, 0);

  // --- Faces ---------------------------------------------------------------
  // Street faces reference the extruded base wall; service faces are flush.
  const front: Face = { axis: "z", wall: -d / 2 - proud, sign: -1, len: baseW, center: baseCx };
  const leftWall = sideStorefront ? -w / 2 - proud : -w / 2;
  const left: Face = {
    axis: "x",
    wall: leftWall,
    sign: -1,
    len: sideStorefront ? baseD : d,
    center: sideStorefront ? -proud / 2 : 0,
  };
  const right: Face = { axis: "x", wall: w / 2, sign: 1, len: d, center: 0 };
  const back: Face = { axis: "z", wall: d / 2, sign: 1, len: w, center: 0 };

  // Kit towers wrap everything above the storefront base in facade panels,
  // so their service faces keep only ground-level detail. A kit ground band
  // replaces all procedural street-level dressing entirely.
  if (!kitGroundH) {
    const wallTop = kitTower ? baseY : height;
    buildStorefront(p, front, mulberry(b.style ^ 0x1f123bb5), trimKey, true);
    if (sideStorefront) buildStorefront(p, left, mulberry(b.style ^ 0x27220a95), trimKey, false);
    else buildServiceFace(p, kit, left, mulberry(b.style ^ 0x27220a95), wallTop);
    buildServiceFace(p, kit, right, mulberry(b.style ^ 0x33355691), wallTop);
    buildServiceFace(p, kit, back, mulberry(b.style ^ 0x45d9f3b1), wallTop);
  }
  if (kitTower) {
    if (cfg.stacked) buildStackedFacade(b, kit, w, d, baseY, height, cfg);
    else buildKitTowerFacade(b, kit, w, d, baseY, height, cfg);
  }

  // --- Fire escape + window AC units on the front face ----------------------
  if (!kitTower && b.stories >= 3 && (b.archetype & 3) < 2) {
    const rng = mulberry(b.style ^ 0x6b43a9b5);
    if (rng() < 0.65) buildFireEscape(p, front, rng, height, b.stories);
    // Window AC units poking from a hashed subset of upper window cells.
    // The facade shader grids windows in world space (1.4 m / 3.0 m cells),
    // so placements snap to the same world grid to land inside a window.
    const worldOff = front.axis === "z" ? x + front.center : z + front.center;
    const u0 = worldOff - front.len / 2 + 0.9;
    const u1 = worldOff + front.len / 2 - 0.9;
    let placed = 0;
    for (let k = Math.ceil(u0 / 1.4); (k + 0.5) * 1.4 < u1 && placed < 4; k++) {
      for (let s = 1; s < b.stories - 1 && placed < 4; s++) {
        if (rng() >= 0.06) continue;
        const uc = (k + 0.5) * 1.4;
        const yc = 4.5 + (s - 1) * 3 + 0.25 * 3 + 0.28; // window sill + half unit
        if (yc > height - 1.5) continue;
        const a = uc - worldOff;
        kit.push(facePlacement(front, KIT_AC[(k + s) % KIT_AC.length], a, yc, 0.16, 0.5));
        faceBox(p, front, "metalDark", 0.55, 0.05, 0.42, a, yc - 0.26, 0.2);
        placed++;
      }
    }
  }

  // --- Hanging neon signs on the front face --------------------------------
  // Kit-tower panels own the upper front face, so signs would clip them.
  if (!kitTower) {
    const rng = mulberry(b.style ^ 0x5851f42d);
    const count = 1 + (rng() < 0.45 ? 1 : 0);
    for (let i = 0; i < count; i++) {
      const a = (rng() - 0.5) * (w - 2.2);
      const sh = 1.3 + rng() * 1.5;
      const yMax = Math.min(height - 1.2, 8.5);
      const y = Math.min(3.6 + rng() * 4, yMax) ;
      const color = NEON[Math.floor(rng() * NEON.length)].clone().multiplyScalar(1.8 + rng() * 0.8);
      const zc = -d / 2 - 0.55;
      p.box("metalDark", 0.1, sh, 0.72, a, y, zc);
      p.plane("neon", 0.62, sh - 0.14, a - 0.058, y, zc, 0, -Math.PI / 2, 0, color);
      p.plane("neon", 0.62, sh - 0.14, a + 0.058, y, zc, 0, Math.PI / 2, 0, color);
      // Mounting arm back to the wall (upper mass, above the base extrusion).
      p.cyl("metalDark", 0.03, 0.5, a, y + sh / 2 + 0.1, -d / 2 - 0.28, Math.PI / 2);
      if (y - sh / 2 < 5.0) {
        // Sign hangs beside the storefront base: arm from the base wall too.
        p.cyl("metalDark", 0.03, 0.4, a, y - sh / 2 + 0.1, -d / 2 - 0.33, Math.PI / 2);
      }
    }
  }

  // --- Kit facade billboard on the upper front face (taller buildings) ------
  {
    const rng = mulberry(b.style ^ 0x77aa11d3);
    if (!kitTower && b.stories >= 3 && rng() < 0.55) {
      const bb = KIT_BILLBOARDS[Math.floor(rng() * KIT_BILLBOARDS.length)];
      const scale = Math.min(1.25, Math.max(0.6, (w - 1.6) / bb.w));
      const bbH = bb.h * scale;
      const yMax = height - bbH - 0.5;
      if (yMax > 5.2) {
        const a = (rng() - 0.5) * Math.max(0, w - bb.w * scale - 1.2);
        const y = 5.2 + rng() * (yMax - 5.2);
        const pl = facePlacement(front, bb.assetId, a, y, (bb.t * scale) / 2 + 0.08, scale);
        pl.ry += bb.ryOffset;
        kit.push(pl);
      }
    }
  }

  // --- Roof dressing ---------------------------------------------------------
  const waterTower = buildRoof(p, kit, mulberry(b.style ^ 0x9e3779b9), w, d, height, b.stories);

  return { geoms: p.build(), waterTower, kit, x, z, width: w, depth: d, height };
}

// Deterministic models cached per streamed BuildingInstance so the renderer
// and the world-level kit-instancing collector share one build per building.
const modelCache = new WeakMap<BuildingInstance, BuildingModel>();

export function getBuildingModel(b: BuildingInstance): BuildingModel {
  let model = modelCache.get(b);
  if (!model) {
    model = buildBuildingModel(b);
    modelCache.set(b, model);
  }
  return model;
}

/** World-space kit dressing entries for every building in the given chunks. */
export function collectBuildingKit(chunks: ChunkData[]): KitEntry[] {
  const out: KitEntry[] = [];
  for (const chunk of chunks) {
    const ox = chunk.coord.x * CHUNK_SIZE;
    const oz = chunk.coord.z * CHUNK_SIZE;
    for (const b of chunk.buildings) {
      // Imported buildings are complete authored models; no AC/billboard
      // dressing (and no procedural geometry) belongs on them.
      if (getImportedBuilding(b)) continue;
      const model = getBuildingModel(b);
      for (const pl of model.kit) {
        out.push({
          assetId: pl.assetId,
          x: ox + model.x + pl.x,
          y: GROUND_Y + pl.y,
          z: oz + model.z + pl.z,
          rotationY: pl.ry,
          scale: pl.scale,
        });
      }
    }
  }
  return out;
}
