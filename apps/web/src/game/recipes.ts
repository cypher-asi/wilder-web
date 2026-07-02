// TS mirror of crates/wilder-crafting RECIPES. Keep in sync.

import { ItemKind } from "../net/protocol";

export type StationKind = "Refinery" | "Factory" | "Laboratory";

export interface Recipe {
  id: string;
  station: StationKind;
  inputs: [ItemKind, number][];
  output: [ItemKind, number];
  seconds: number;
}

export const RECIPES: Recipe[] = [
  // Refinery: resources -> materials
  { id: "steel_plate", station: "Refinery", inputs: [["Iron", 4]], output: ["SteelPlate", 1], seconds: 4 },
  { id: "copper_wire", station: "Refinery", inputs: [["Copper", 3]], output: ["CopperWire", 2], seconds: 3 },
  { id: "polymer", station: "Refinery", inputs: [["Chemicals", 3], ["Biomass", 2]], output: ["Polymer", 1], seconds: 5 },
  { id: "circuit_board", station: "Refinery", inputs: [["Electronics", 2], ["CopperWire", 2]], output: ["CircuitBoard", 1], seconds: 6 },
  { id: "bio_gel", station: "Refinery", inputs: [["Biomass", 4], ["Chemicals", 1]], output: ["BioGel", 1], seconds: 4 },
  // Factory: materials -> gear
  { id: "pipe", station: "Factory", inputs: [["SteelPlate", 2]], output: ["Pipe", 1], seconds: 6 },
  { id: "knife", station: "Factory", inputs: [["SteelPlate", 1], ["Polymer", 1]], output: ["Knife", 1], seconds: 8 },
  { id: "pistol", station: "Factory", inputs: [["SteelPlate", 3], ["Polymer", 2], ["CircuitBoard", 1]], output: ["Pistol", 1], seconds: 15 },
  { id: "smg", station: "Factory", inputs: [["SteelPlate", 5], ["Polymer", 3], ["CircuitBoard", 2]], output: ["Smg", 1], seconds: 25 },
  { id: "ammo_9mm", station: "Factory", inputs: [["SteelPlate", 1], ["Chemicals", 2]], output: ["Ammo9mm", 30], seconds: 3 },
  { id: "jacket_armor", station: "Factory", inputs: [["Polymer", 4], ["BioGel", 1]], output: ["JacketArmor", 1], seconds: 10 },
  { id: "plate_armor", station: "Factory", inputs: [["SteelPlate", 6], ["Polymer", 2], ["BioGel", 2]], output: ["PlateArmor", 1], seconds: 20 },
  { id: "medkit", station: "Factory", inputs: [["BioGel", 2], ["Polymer", 1]], output: ["Medkit", 1], seconds: 6 },
];

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
