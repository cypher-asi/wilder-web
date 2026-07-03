// Building Stage helpers: discover promoted facade modules from the lab
// registry and generate default prefab configurations from their authored
// dimensions, so standard building structures exist before any hand-tuning.

import { DEFAULT_KIT_TOWER_CONFIG, KitTowerPanel } from "../render/building";
import { BuildingInstance } from "../net/protocol";
import { BuildingPrefab, LabAsset, Registry } from "./labApi";

/** A promoted kit asset considered for facade tiling. */
export interface StageModule {
  asset: LabAsset;
  manifestId: string;
  /**
   * Kit family key derived from the asset id (cb01, cb02, floor,
   * skyscraper, ...). Panels only assemble with siblings of the same
   * family: each family shares texture sets and an authored grid.
   */
  family: string;
  /** Authored width in meters (grid pitch along a face). */
  width: number;
  /** Authored height in meters (one stacked row). */
  height: number;
  /** Authored depth in meters (wall relief, forward of the wall plane). */
  depth: number;
  /**
   * Model-space distance from the pivot back to the authored wall plane.
   * Kit facade tiles are authored with the wall surface on the pivot plane,
   * so this is derivable from the bbox: depth/2 minus the extent behind the
   * facade (the back extent, or the front extent for flipped tiles).
   */
  wallZ: number;
  /**
   * Tile is authored facing away from the skyscraper-module convention
   * (most relief behind the pivot plane); rotate 180° when placing.
   */
  flip: boolean;
  /** True when the authored geometry reads as a wall-anchored facade tile. */
  wallTile: boolean;
  triangles: number;
}

// Facade tiles keep their wall slab just behind the authored pivot plane;
// anything reaching further back is a freestanding chunk, not a tile.
const SLAB_MAX_BACK = 0.35;
// A tile is wall relief: its depth stays well under its facade width.
// Freestanding tower chunks are as deep as they are wide.
const MAX_DEPTH_RATIO = 0.6;
// Modules tile together when width (grid pitch) and row height agree.
const CLASS_TOLERANCE = 0.05;

// Candidate facade tiles by id. Families organize the kit by building type
// (CB01, CB02, floor kit, skyscraper); the geometry heuristics below still
// reject non-tile members (roof parts, freestanding chunks).
const MODULE_ID = /module|facade|panel|floor_|groundfloor|wall|window/i;

/**
 * Kit family from the asset id: the vendor prefixes every building type
 * (sm_cb01_*, sm_cb02_*, sm_skyscraper_*, and the floor kit's
 * sm_floor_/sm_groundfloor_ pieces).
 */
export function moduleFamily(assetId: string): string {
  const m = assetId.match(/^sm_(cb\d+|skyscraper|slum|floor|groundfloor)/i);
  if (!m) return "misc";
  const key = m[1].toLowerCase();
  return key === "groundfloor" ? "floor" : key;
}

/**
 * Candidate facade modules from the promoted registry, classified by their
 * authored geometry. meta.dimensions_m is Blender-space [width, depth,
 * height]; meta.bbox_max[1] is the wall-slab extent behind the pivot plane.
 */
export function findStageModules(registry: Registry | null): StageModule[] {
  const out: StageModule[] = [];
  for (const a of Object.values(registry?.assets ?? {})) {
    if (a.status !== "promoted" || !a.manifestId || !a.meta) continue;
    if (!MODULE_ID.test(a.id)) continue;
    const [width, depth, height] = a.meta.dimensions_m;
    const backExtent = a.meta.bbox_max[1];
    // Tiles with most of their relief behind the authored pivot plane are
    // authored facing the other way (like the slum storefronts): mark them
    // flipped and measure the wall plane from the opposite side. This rule
    // reproduces the hand-curated flip/wallZ pairs in building.ts exactly.
    const flip = backExtent > depth / 2;
    const wallZ = flip ? backExtent - depth / 2 : depth / 2 - backExtent;
    const frontExtent = depth - backExtent;
    out.push({
      asset: a,
      manifestId: a.manifestId,
      family: moduleFamily(a.id),
      width,
      height,
      depth,
      wallZ,
      flip,
      wallTile:
        Math.min(backExtent, frontExtent) <= SLAB_MAX_BACK &&
        depth <= width * MAX_DEPTH_RATIO,
      triangles: a.meta.triangles,
    });
  }
  return out.sort(
    (a, b) => a.family.localeCompare(b.family) || a.manifestId.localeCompare(b.manifestId),
  );
}

/**
 * Group wall tiles into interchangeable classes: modules tile together only
 * when they come from the same kit family and their authored grid pitch
 * (width) and row height match. Returns classes sorted largest-first, so [0]
 * is the biggest facade system.
 */
export function groupModuleClasses(modules: StageModule[]): StageModule[][] {
  const classes: StageModule[][] = [];
  for (const m of modules) {
    if (!m.wallTile) continue;
    const cls = classes.find(
      (c) =>
        m.family === c[0].family &&
        Math.abs(m.width - c[0].width) <= c[0].width * CLASS_TOLERANCE &&
        Math.abs(m.height - c[0].height) <= c[0].height * CLASS_TOLERANCE,
    );
    if (cls) cls.push(m);
    else classes.push([m]);
  }
  return classes.sort((a, b) => b.length - a.length);
}

export function moduleToPanel(m: StageModule): KitTowerPanel {
  return {
    assetId: m.manifestId,
    h: m.height,
    w: m.width,
    d: m.depth,
    wallZ: m.wallZ,
    ...(m.flip ? { flip: true } : {}),
  };
}

/** Footprint/stories archetypes for the skyscraper-kit starting points. */
const DEFAULT_SHAPES = [
  { name: "Tower 6x6 · 12 stories", tilesX: 6, tilesZ: 6, stories: 12, style: 0x1a2b3c4d },
  { name: "Tower 6x6 · 8 stories", tilesX: 6, tilesZ: 6, stories: 8, style: 0x51f0aa17 },
  { name: "Slab 12x6 · 10 stories", tilesX: 12, tilesZ: 6, stories: 10, style: 0x77e1b2c3 },
  { name: "Mid-rise 8x6 · 6 stories", tilesX: 8, tilesZ: 6, stories: 6, style: 0x0badcafe },
  { name: "Wide 18x8 · 9 stories", tilesX: 18, tilesZ: 8, stories: 9, style: 0x2fee6001 },
];

const PREFAB_DEFAULTS = {
  archetype: 3,
  kitBase: {
    cornerPanels: [] as KitTowerPanel[],
    groundPanels: [] as KitTowerPanel[],
    baseHeight: 4.8,
    panelsOnly: false,
    forceKitTower: true,
  },
};

/**
 * CB01 mid-rise walk-ups: the modules are U-shaped floor slices of a whole
 * 12 m building plan (facade band on +z, ~4 m side returns, pivot at the
 * plan center), stacked on a 3 m grid from the ground up. Panels only —
 * the slices are complete floors, so no procedural massing/roof belongs
 * here. Narrow fills and freestanding chunks stay out of the default pool.
 */
// module11/12 are L-shaped half-plan slices (they only close the plan as a
// mirrored pair) and module17/18/19 are sloped roof-crown wedges, so they
// stay out of the default whole-slice pool.
const CB01_SLICES = [
  "lab_sm_cb01_module01",
  "lab_sm_cb01_module02",
  "lab_sm_cb01_module08",
];

function cb01Prefabs(modules: StageModule[]): BuildingPrefab[] {
  const slices = modules.filter(
    (m) => m.family === "cb01" && CB01_SLICES.includes(m.manifestId),
  );
  if (slices.length === 0) return [];
  const panels = slices.map((m) => ({
    assetId: m.manifestId,
    h: m.height,
    w: m.width,
    d: m.depth,
  }));
  const shapes = [
    { name: "CB01 walk-up 6x4 · 4 stories", tilesX: 6, tilesZ: 4, stories: 4, style: 0x11aa22bb },
    { name: "CB01 mid-rise 6x4 · 7 stories", tilesX: 6, tilesZ: 4, stories: 7, style: 0x33cc44dd },
  ];
  return shapes.map((s) => ({
    id: `default_${s.name.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}`,
    name: s.name,
    tilesX: s.tilesX,
    tilesZ: s.tilesZ,
    stories: s.stories,
    archetype: PREFAB_DEFAULTS.archetype,
    style: s.style,
    kit: {
      ...PREFAB_DEFAULTS.kitBase,
      panels,
      moduleWidth: 12,
      rowHeight: 3,
      wallZ: 0,
      baseHeight: 0,
      panelsOnly: true,
      stacked: true,
    },
  }));
}

/**
 * Floor-kit walk-ups: ~5 m x ~3 m grimy concrete wall tiles (window strips)
 * over a 4 m poster-covered ground band. L/R tiles are mirrored pairs of the
 * same wall, so both fill the same 5 m slots.
 */
function floorKitPrefabs(modules: StageModule[]): BuildingPrefab[] {
  const walls = modules.filter(
    (m) => m.family === "floor" && m.wallTile && /floor_(one|two|three)/.test(m.asset.id),
  );
  if (walls.length === 0) return [];
  // Authored 5.093 m widths overhang their 5 m slot by a seam lip; place on
  // the 5 m grid. Row heights vary slightly (2.727 / 3.0): both round to the
  // 3 m grid and the lip overlap is authored.
  const panels = walls.map((m) => ({ ...moduleToPanel(m), w: 5, h: 3 }));
  const ground = modules
    .filter((m) => /groundfloor_(wall|door)/.test(m.asset.id))
    .map((m) => ({ ...moduleToPanel(m), w: 5, h: 4 }));
  const shapes = [
    { name: "Walk-up 5x5 · 3 stories", tilesX: 5, tilesZ: 5, stories: 3, style: 0x55ee66f1 },
    { name: "Walk-up 10x5 · 4 stories", tilesX: 10, tilesZ: 5, stories: 4, style: 0x77008899 },
  ];
  return shapes.map((s) => ({
    id: `default_${s.name.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}`,
    name: s.name,
    tilesX: s.tilesX,
    tilesZ: s.tilesZ,
    stories: s.stories,
    archetype: PREFAB_DEFAULTS.archetype,
    style: s.style,
    kit: {
      ...PREFAB_DEFAULTS.kitBase,
      panels,
      groundPanels: ground,
      moduleWidth: 5,
      rowHeight: 3,
      wallZ: 0.1,
      baseHeight: 4,
    },
  }));
}

/**
 * Standard building structures derived from the kit information: skyscraper
 * towers from the largest interchangeable wall-tile class (matching grid
 * pitch and row height, plus nesting flat fillers), and the simpler CB01 /
 * floor-kit walk-ups from their curated family pools.
 */
export function makeDefaultPrefabs(modules: StageModule[]): BuildingPrefab[] {
  const classes = groupModuleClasses(modules.filter((m) => m.family === "skyscraper"));
  const primary = classes[0] ?? [];
  const fillers = classes
    .slice(1)
    .filter(
      (c) =>
        primary.length > 0 &&
        c[0].width < primary[0].width &&
        primary[0].width % c[0].width === 0,
    )
    .flat();
  // Ground-band storefront tiles and L-corner modules are curated (they
  // read wrong as plain wall tiles); keep them out of the upper pool.
  const groundIds = new Set(
    [
      ...(DEFAULT_KIT_TOWER_CONFIG.groundPanels ?? []),
      ...(DEFAULT_KIT_TOWER_CONFIG.cornerPanels ?? []),
    ].map((g) => g.assetId),
  );
  const pool = [...primary, ...fillers].filter((m) => !groundIds.has(m.manifestId));
  const panels =
    pool.length > 0 ? pool.map(moduleToPanel) : DEFAULT_KIT_TOWER_CONFIG.panels;
  const moduleWidth =
    primary.length > 0 ? primary[0].width : DEFAULT_KIT_TOWER_CONFIG.moduleWidth;
  const towers = DEFAULT_SHAPES.map((s) => ({
    id: `default_${s.name.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}`,
    name: s.name,
    tilesX: s.tilesX,
    tilesZ: s.tilesZ,
    stories: s.stories,
    archetype: 3,
    style: s.style,
    kit: {
      ...DEFAULT_KIT_TOWER_CONFIG,
      panels: [...panels],
      moduleWidth,
      forceKitTower: true,
    },
  }));
  return [...cb01Prefabs(modules), ...floorKitPrefabs(modules), ...towers];
}

/**
 * BuildingInstance for a prefab, footprint anchored at tile (0,0). The stage
 * viewport recenters using the model's reported center.
 */
export function prefabInstance(p: BuildingPrefab): BuildingInstance {
  return {
    archetype: p.archetype,
    tx0: 0,
    tz0: 0,
    tx1: Math.max(1, p.tilesX),
    tz1: Math.max(1, p.tilesZ),
    stories: Math.max(1, p.stories),
    style: p.style >>> 0,
  };
}

/** Ready-to-paste building.ts snippet + raw JSON for the current prefab. */
export function prefabToCode(p: BuildingPrefab): string {
  const panels = p.kit.panels
    .map((m) => {
      const opt = [
        m.w !== undefined ? `w: ${m.w}` : "",
        m.d !== undefined ? `d: ${m.d}` : "",
        m.wallZ !== undefined ? `wallZ: ${m.wallZ}` : "",
      ]
        .filter(Boolean)
        .join(", ");
      return `  { assetId: ${JSON.stringify(m.assetId)}, h: ${m.h}${opt ? `, ${opt}` : ""} },`;
    })
    .join("\n");
  return [
    `// ${p.name} — ${p.tilesX}x${p.tilesZ} tiles, ${p.stories} stories, archetype ${p.archetype}, style 0x${(p.style >>> 0).toString(16)}`,
    `const KIT_TOWER_PANELS = [`,
    panels,
    `];`,
    `const MODULE_W = ${p.kit.moduleWidth};`,
    `const ROW_H = ${p.kit.rowHeight ?? 6};`,
    `const MODULE_WALL_Z = ${p.kit.wallZ};`,
    `const KIT_TOWER_BASE_HEIGHT = ${p.kit.baseHeight};`,
    `const STACKED = ${p.kit.stacked ?? false};`,
    ``,
    `// Full prefab JSON:`,
    `// ${JSON.stringify(p)}`,
  ].join("\n");
}
