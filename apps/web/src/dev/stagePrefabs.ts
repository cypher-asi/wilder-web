// Building Stage helpers: discover promoted facade modules from the lab
// registry and generate default prefab configurations from their authored
// dimensions, so standard building structures exist before any hand-tuning.

import { DEFAULT_KIT_TOWER_CONFIG, KitTowerPanel } from "../render/building";
import { BuildingInstance } from "../net/protocol";
import { BuildingPrefab, LabAsset, Registry } from "./labApi";

/** A promoted kit asset usable as a facade tile module. */
export interface StageModule {
  asset: LabAsset;
  manifestId: string;
  /** Authored width in meters (grid pitch along a face). */
  width: number;
  /** Authored height in meters (one stacked row). */
  height: number;
  triangles: number;
}

/**
 * Facade tile modules = promoted assets whose name reads as a wall
 * module/panel. dimensions_m is Blender-space [width, depth, height].
 */
export function findStageModules(registry: Registry | null): StageModule[] {
  const out: StageModule[] = [];
  for (const a of Object.values(registry?.assets ?? {})) {
    if (a.status !== "promoted" || !a.manifestId || !a.meta) continue;
    if (!/module|facade|panel/i.test(a.id)) continue;
    out.push({
      asset: a,
      manifestId: a.manifestId,
      width: a.meta.dimensions_m[0],
      height: a.meta.dimensions_m[2],
      triangles: a.meta.triangles,
    });
  }
  return out.sort((a, b) => a.manifestId.localeCompare(b.manifestId));
}

export function moduleToPanel(m: StageModule): KitTowerPanel {
  return { assetId: m.manifestId, h: m.height };
}

/** Footprint/stories archetypes for the generated starting points. */
const DEFAULT_SHAPES = [
  { name: "Tower 6x6 · 12 stories", tilesX: 6, tilesZ: 6, stories: 12, style: 0x1a2b3c4d },
  { name: "Tower 6x6 · 8 stories", tilesX: 6, tilesZ: 6, stories: 8, style: 0x51f0aa17 },
  { name: "Slab 12x6 · 10 stories", tilesX: 12, tilesZ: 6, stories: 10, style: 0x77e1b2c3 },
  { name: "Mid-rise 8x6 · 6 stories", tilesX: 8, tilesZ: 6, stories: 6, style: 0x0badcafe },
  { name: "Wide 18x8 · 9 stories", tilesX: 18, tilesZ: 8, stories: 9, style: 0x2fee6001 },
];

/**
 * Standard building structures derived from the kit information: the panel
 * pool is every discovered module, the grid pitch comes from the authored
 * module width, and remaining tuning matches the current in-game defaults.
 */
export function makeDefaultPrefabs(modules: StageModule[]): BuildingPrefab[] {
  const panels =
    modules.length > 0 ? modules.map(moduleToPanel) : DEFAULT_KIT_TOWER_CONFIG.panels;
  const moduleWidth =
    modules.length > 0 ? modules[0].width : DEFAULT_KIT_TOWER_CONFIG.moduleWidth;
  return DEFAULT_SHAPES.map((s) => ({
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
    .map((m) => `  { assetId: ${JSON.stringify(m.assetId)}, h: ${m.h} },`)
    .join("\n");
  return [
    `// ${p.name} — ${p.tilesX}x${p.tilesZ} tiles, ${p.stories} stories, archetype ${p.archetype}, style 0x${(p.style >>> 0).toString(16)}`,
    `const KIT_TOWER_PANELS = [`,
    panels,
    `];`,
    `const MODULE_W = ${p.kit.moduleWidth};`,
    `const MODULE_WALL_Z = ${p.kit.wallZ};`,
    `const PANEL_DEPTH_SCALE = ${p.kit.depthScale};`,
    `const KIT_TOWER_BASE_HEIGHT = ${p.kit.baseHeight};`,
    ``,
    `// Full prefab JSON:`,
    `// ${JSON.stringify(p)}`,
  ].join("\n");
}
