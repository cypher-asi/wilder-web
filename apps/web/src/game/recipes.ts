// TS mirror of crates/wilder-crafting RECIPES. Keep in sync.

import { ItemKind } from "../net/protocol";

export type StationKind = "Refinery" | "Factory" | "Laboratory";

export interface Recipe {
  id: string;
  station: StationKind;
  inputs: [ItemKind, number][];
  output: [ItemKind, number];
  seconds: number;
  /** Energy (wallet currency) burned per crafted unit, charged when queued. */
  energy: number;
}

export const RECIPES: Recipe[] = [
  // Refinery: resources -> materials
  { id: "steel_plate", station: "Refinery", inputs: [["Iron", 4]], output: ["SteelPlate", 1], seconds: 4, energy: 1 },
  { id: "copper_wire", station: "Refinery", inputs: [["Copper", 3]], output: ["CopperWire", 2], seconds: 3, energy: 1 },
  { id: "polymer", station: "Refinery", inputs: [["Chemicals", 3], ["Biomass", 2]], output: ["Polymer", 1], seconds: 5, energy: 1 },
  { id: "circuit_board", station: "Refinery", inputs: [["Electronics", 2], ["CopperWire", 2]], output: ["CircuitBoard", 1], seconds: 6, energy: 1 },
  { id: "bio_gel", station: "Refinery", inputs: [["Biomass", 4], ["Chemicals", 1]], output: ["BioGel", 1], seconds: 4, energy: 1 },
  // Factory: materials -> gear
  { id: "pipe", station: "Factory", inputs: [["SteelPlate", 2]], output: ["Pipe", 1], seconds: 6, energy: 2 },
  { id: "knife", station: "Factory", inputs: [["SteelPlate", 1], ["Polymer", 1]], output: ["Knife", 1], seconds: 8, energy: 2 },
  { id: "pistol", station: "Factory", inputs: [["SteelPlate", 3], ["Polymer", 2], ["CircuitBoard", 1]], output: ["Pistol", 1], seconds: 15, energy: 2 },
  { id: "smg", station: "Factory", inputs: [["SteelPlate", 5], ["Polymer", 3], ["CircuitBoard", 2]], output: ["Smg", 1], seconds: 25, energy: 2 },
  { id: "ammo_9mm", station: "Factory", inputs: [["SteelPlate", 1], ["Chemicals", 2]], output: ["Ammo9mm", 30], seconds: 3, energy: 2 },
  { id: "jacket_armor", station: "Factory", inputs: [["Polymer", 4], ["BioGel", 1]], output: ["JacketArmor", 1], seconds: 10, energy: 2 },
  { id: "plate_armor", station: "Factory", inputs: [["SteelPlate", 6], ["Polymer", 2], ["BioGel", 2]], output: ["PlateArmor", 1], seconds: 20, energy: 2 },
  { id: "medkit", station: "Factory", inputs: [["BioGel", 2], ["Polymer", 1]], output: ["Medkit", 1], seconds: 6, energy: 2 },
];

/** Recipes every character knows from the start (mirror of wilder-crafting DEFAULT_BLUEPRINTS). */
export const DEFAULT_BLUEPRINTS = [
  "steel_plate",
  "copper_wire",
  "pipe",
  "knife",
  "ammo_9mm",
  "medkit",
];

/** Laboratory research cost (mirror of wilder-world RESEARCH_* constants). */
export const RESEARCH_FRAGMENTS = 2;
export const RESEARCH_RESOURCES: [ItemKind, number][] = [
  ["Electronics", 5],
  ["Chemicals", 5],
];
/** Carried Energy burned per research (mirror of wilder-crafting RESEARCH_ENERGY). */
export const RESEARCH_ENERGY = 5;

/** Resource node variant -> resource (mirror of wilder_economy::RESOURCES order). */
export const NODE_RESOURCES: ItemKind[] = [
  "Iron",
  "Copper",
  "Chemicals",
  "Electronics",
  "Biomass",
];

/** Display colors for resources (nodes + UI accents). */
export const RESOURCE_COLORS: Record<string, string> = {
  Iron: "#c7cedb",
  Copper: "#ff9b45",
  Chemicals: "#b3ff45",
  Electronics: "#45c8ff",
  Biomass: "#7dff6e",
};

/** Per-station energy throughput cap (mirror of wilder-world station_energy_cap). */
export const STATION_ENERGY_CAPS: Record<StationKind, number> = {
  Refinery: 4,
  Factory: 4,
  Laboratory: 5,
};

/** Reference item values in MILD (mirror of wilder-world agents::base_value). */
export const BASE_VALUES: Partial<Record<ItemKind, number>> = {
  Iron: 2,
  Copper: 2,
  Chemicals: 3,
  Electronics: 4,
  Biomass: 1,
  SteelPlate: 13,
  CopperWire: 5,
  Polymer: 17,
  CircuitBoard: 29,
  BioGel: 11,
  Pipe: 26,
  Knife: 38,
  Pistol: 112,
  Smg: 250,
  JacketArmor: 72,
  PlateArmor: 180,
  Ammo9mm: 1,
  Medkit: 20,
  Flashlight: 6,
  Cash: 1,
  BlueprintFragment: 40,
  PowerCell: 30,
};

/**
 * Resource drop weights per named zone, in NODE_RESOURCES order (mirror of
 * wilder_economy::zone_resource_weights keyed by ZoneKind::display_name).
 */
export const ZONE_RESOURCE_WEIGHTS: [zone: string, weights: number[]][] = [
  ["Blast Zone", [1, 1, 5, 2, 1]],
  ["Mining Pits", [5, 4, 1, 0, 0]],
  ["Industrial Belt", [4, 2, 1, 3, 0]],
  ["Tech Ruins", [0, 2, 1, 6, 1]],
  ["Overgrowth", [1, 0, 1, 0, 6]],
  ["Chem Works", [0, 1, 6, 1, 2]],
  ["Scrapyard", [4, 4, 0, 2, 0]],
];

/** Zones where a resource meaningfully drops (weight >= 3), best first. */
export function resourceSourceZones(kind: ItemKind): string[] {
  const i = NODE_RESOURCES.indexOf(kind);
  if (i < 0) return [];
  return ZONE_RESOURCE_WEIGHTS.filter(([, w]) => w[i] >= 3)
    .sort((a, b) => b[1][i] - a[1][i])
    .map(([zone]) => zone);
}

/**
 * NPC vendor price lines (mirror of wilder-economy ARMORY/BODEGA tables):
 * buy = MILD the player pays, sell = MILD the vendor pays; 0 = n/a.
 */
export const VENDOR_PRICES: {
  vendor: "Armory" | "Bodega";
  kind: ItemKind;
  buy: number;
  sell: number;
}[] = [
  { vendor: "Armory", kind: "Pipe", buy: 30, sell: 10 },
  { vendor: "Armory", kind: "Knife", buy: 45, sell: 15 },
  { vendor: "Armory", kind: "Pistol", buy: 140, sell: 45 },
  { vendor: "Armory", kind: "Smg", buy: 320, sell: 100 },
  { vendor: "Armory", kind: "JacketArmor", buy: 90, sell: 30 },
  { vendor: "Armory", kind: "PlateArmor", buy: 220, sell: 70 },
  { vendor: "Armory", kind: "Ammo9mm", buy: 1, sell: 0 },
  { vendor: "Bodega", kind: "Medkit", buy: 25, sell: 8 },
  { vendor: "Bodega", kind: "Flashlight", buy: 10, sell: 3 },
  { vendor: "Bodega", kind: "Ammo9mm", buy: 2, sell: 0 },
  { vendor: "Bodega", kind: "Iron", buy: 0, sell: 2 },
  { vendor: "Bodega", kind: "Copper", buy: 0, sell: 2 },
  { vendor: "Bodega", kind: "Chemicals", buy: 0, sell: 3 },
  { vendor: "Bodega", kind: "Electronics", buy: 0, sell: 4 },
  { vendor: "Bodega", kind: "Biomass", buy: 0, sell: 1 },
];
