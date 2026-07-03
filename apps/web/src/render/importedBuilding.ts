// Fully imported (Asset Lab) buildings: selected footprints render an
// authored GLB instead of procedural geometry. Selection is deterministic
// from the streamed BuildingInstance so the renderer and the kit-dressing
// collector agree without extra state.

import { BuildingInstance, TILE_SIZE } from "../net/protocol";

export interface ImportedBuildingSpec {
  assetId: string;
  /** Authored footprint in meters (glTF x/z, before any rotation). */
  width: number;
  depth: number;
  /** Authored height in meters (glTF y). */
  height: number;
  /**
   * Yaw that turns the authored front toward -z, the street-facing side in
   * the procedural building convention.
   */
  frontRy: number;
  /** Max stories of a footprint this model may replace (height match). */
  maxStories: number;
}

// One hero building for now; the selection below generalizes to more specs.
const SPECS: ImportedBuildingSpec[] = [
  {
    assetId: "lab_sm_restaurantsf01",
    width: 6.755,
    depth: 12.543,
    height: 6.608,
    frontRy: 0,
    // The authored model is ~2 stories; allowing taller lots keeps enough
    // candidates and a low shop between towers reads fine in this city.
    maxStories: 8,
  },
];

/** Per-axis footprint stretch we allow before the model looks distorted. */
const MAX_STRETCH = 1.35;
const MIN_STRETCH = 0.7;

export interface ImportedBuildingPlacement {
  spec: ImportedBuildingSpec;
  /** Building center in chunk-local coordinates. */
  x: number;
  z: number;
  /** Yaw applied to the model (frontRy plus optional 90-degree lot fit). */
  ry: number;
  /** Model-space scale factors. */
  sx: number;
  sy: number;
  sz: number;
}

function fit(spec: ImportedBuildingSpec, w: number, d: number): { sx: number; sz: number } | null {
  const sx = w / spec.width;
  const sz = d / spec.depth;
  if (sx < MIN_STRETCH || sx > MAX_STRETCH) return null;
  if (sz < MIN_STRETCH || sz > MAX_STRETCH) return null;
  // Keep the two stretches close so the model doesn't visibly shear.
  if (Math.max(sx, sz) / Math.min(sx, sz) > 1.3) return null;
  return { sx, sz };
}

const placementCache = new WeakMap<BuildingInstance, ImportedBuildingPlacement | null>();

/**
 * Deterministically decide whether this footprint renders an imported
 * building (and how). Returns null for procedural buildings.
 */
export function getImportedBuilding(b: BuildingInstance): ImportedBuildingPlacement | null {
  if (placementCache.has(b)) return placementCache.get(b) ?? null;
  const placement = computePlacement(b);
  placementCache.set(b, placement);
  return placement;
}

function computePlacement(b: BuildingInstance): ImportedBuildingPlacement | null {
  const w = (b.tx1 - b.tx0) * TILE_SIZE;
  const d = (b.tz1 - b.tz0) * TILE_SIZE;

  for (const spec of SPECS) {
    if (b.stories > spec.maxStories) continue;
    // Distinctive authored buildings repeat badly; a style-hash gate keeps
    // them occasional even when many lots would fit.
    if ((b.style & 1) !== 0) continue;
    // Front stays on -z (the street side), so only the 180-degree flip is a
    // free variant; the 90-degree fit is reserved for square-ish models.
    const direct = fit(spec, w, d);
    if (!direct) continue;
    const sy = Math.min(direct.sx, direct.sz);
    return {
      spec,
      x: b.tx0 * TILE_SIZE + w / 2,
      z: b.tz0 * TILE_SIZE + d / 2,
      ry: spec.frontRy,
      sx: direct.sx,
      sy,
      sz: direct.sz,
    };
  }
  return null;
}
