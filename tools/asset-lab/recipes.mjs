// Recipe presets per asset category. A recipe is a constrained set of knobs;
// the pipeline only ever executes these fixed operations (no free-form edits).
// Schema is designed so an AI classifier can emit the same shape later.

export const CATEGORY_PRESETS = {
  prop: {
    category: "prop",
    decimate_ratio: 0.6,
    weld_distance: 0.0005,
    texture_max_size: 512,
    normalize_pivot: "bottom_center",
    max_triangles: 20000,
  },
  building_hero: {
    category: "building_hero",
    decimate_ratio: 0.9,
    weld_distance: 0.0005,
    texture_max_size: 2048,
    normalize_pivot: "bottom_center",
    max_triangles: 150000,
  },
  building_background: {
    category: "building_background",
    decimate_ratio: 0.35,
    weld_distance: 0.001,
    texture_max_size: 1024,
    normalize_pivot: "bottom_center",
    max_triangles: 60000,
  },
  vehicle: {
    category: "vehicle",
    decimate_ratio: 0.75,
    weld_distance: 0.0003,
    texture_max_size: 1024,
    normalize_pivot: "bottom_center",
    max_triangles: 40000,
  },
  sign_emissive: {
    category: "sign_emissive",
    // Signs/neon keep geometry: decimation destroys thin frames and tubes.
    decimate_ratio: 1.0,
    weld_distance: 0.0003,
    texture_max_size: 1024,
    normalize_pivot: "bottom_center",
    max_triangles: 30000,
  },
  road_module: {
    category: "road_module",
    decimate_ratio: 0.8,
    weld_distance: 0.001,
    texture_max_size: 1024,
    normalize_pivot: "bottom_center",
    max_triangles: 30000,
  },
};

/** Merge a partial recipe from the UI over the preset for its category. */
export function resolveRecipe(partial = {}) {
  const preset = CATEGORY_PRESETS[partial.category] ?? CATEGORY_PRESETS.prop;
  const recipe = { ...preset, ...partial };
  recipe.decimate_ratio = clamp(Number(recipe.decimate_ratio) || 1.0, 0.02, 1.0);
  recipe.weld_distance = clamp(Number(recipe.weld_distance) || 0, 0, 0.01);
  recipe.texture_max_size = clamp(Math.round(Number(recipe.texture_max_size) || 1024), 64, 4096);
  recipe.max_triangles = clamp(Math.round(Number(recipe.max_triangles) || 50000), 100, 1000000);
  return recipe;
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}
