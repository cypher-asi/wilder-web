// Item catalog metadata + grayscale SVG icons for the inventory UI.
//
// Icons are simple monochrome silhouettes (reference style: light-gray gear
// renders on near-black slot cards). Every ItemKind gets a label, a category
// (drives the little color tick in a slot's corner) and an icon.

import { JSX } from "react";
import { ItemKind } from "../net/protocol";

export type ItemCategory =
  | "weapon"
  | "armor"
  | "consumable"
  | "ammo"
  | "resource"
  | "material"
  | "currency"
  | "gadget";

/** Corner-tick color per category (mirrors rarity bars in the reference UI). */
export const CATEGORY_TICK: Record<ItemCategory, string> = {
  weapon: "#3fd9c2",
  armor: "#7ed07e",
  consumable: "#ffd75e",
  ammo: "#f0a848",
  resource: "#6aa7e8",
  material: "#9b7fe8",
  currency: "#8fe06a",
  gadget: "#e8879b",
};

export const ITEM_INFO: Record<ItemKind, { label: string; category: ItemCategory }> = {
  Medkit: { label: "Medkit", category: "consumable" },
  Flashlight: { label: "Flashlight", category: "gadget" },
  Pipe: { label: "Steel Pipe", category: "weapon" },
  Knife: { label: "Combat Knife", category: "weapon" },
  Pistol: { label: "P9 Pistol", category: "weapon" },
  Smg: { label: "K-11 SMG", category: "weapon" },
  JacketArmor: { label: "Padded Jacket", category: "armor" },
  PlateArmor: { label: "Plate Carrier", category: "armor" },
  Ammo9mm: { label: "9mm Ammo", category: "ammo" },
  Iron: { label: "Iron", category: "resource" },
  Copper: { label: "Copper", category: "resource" },
  Chemicals: { label: "Chemicals", category: "resource" },
  Electronics: { label: "Electronics", category: "resource" },
  Biomass: { label: "Biomass", category: "resource" },
  SteelPlate: { label: "Steel Plate", category: "material" },
  CopperWire: { label: "Copper Wire", category: "material" },
  Polymer: { label: "Polymer", category: "material" },
  CircuitBoard: { label: "Circuit Board", category: "material" },
  BioGel: { label: "Bio-Gel", category: "material" },
  BlueprintFragment: { label: "Blueprint Fragment", category: "material" },
  PowerCell: { label: "Power Cell", category: "material" },
  Cash: { label: "Cash", category: "currency" },
};

export function itemLabel(kind: ItemKind): string {
  return ITEM_INFO[kind]?.label ?? kind;
}

/**
 * Backpack/stash volume one stack entry occupies (mirror of the server's
 * `ItemKind::slot_cost`). Bulky gear takes multiple grid cells.
 */
export function slotCost(kind: ItemKind): number {
  switch (kind) {
    case "Pistol":
    case "Smg":
      return 4;
    case "PlateArmor":
      return 3;
    case "JacketArmor":
    case "Pipe":
    case "Knife":
    case "PowerCell":
      return 2;
    default:
      return 1;
  }
}

/** Total volume used by a container's occupied entries. */
export function usedVolume(slots: (import("../net/protocol").ItemStack | null)[]): number {
  return slots.reduce((n, s) => n + (s ? slotCost(s.kind) : 0), 0);
}

// Shared silhouette colors (cool steel, matching the HUD palette).
const FILL = "#c9d8e6";
const DIM = "#8aa0b4";

/** Inner SVG content per item kind (48x48 viewBox). Shared with the in-world
 * loot sprites (render/itemSprite.tsx), which rasterize these to textures. */
export const GLYPHS: Record<ItemKind, JSX.Element> = {
  Medkit: (
    <>
      <rect x="7" y="14" width="34" height="24" rx="3" fill={FILL} />
      <rect x="19" y="10" width="10" height="5" rx="2" fill={DIM} />
      <rect x="21" y="20" width="6" height="12" fill="#22303c" />
      <rect x="18" y="23" width="12" height="6" fill="#22303c" />
    </>
  ),
  Flashlight: (
    <>
      <rect x="6" y="20" width="12" height="9" rx="2" fill={FILL} />
      <rect x="18" y="21.5" width="20" height="6" rx="2" fill={DIM} />
      <rect x="38" y="19" width="4" height="11" rx="1" fill={FILL} />
    </>
  ),
  Pipe: (
    <>
      <rect x="5" y="26" width="36" height="6" rx="2" fill={FILL} transform="rotate(-18 23 29)" />
      <rect x="33" y="14" width="9" height="9" rx="2" fill={DIM} />
    </>
  ),
  Knife: (
    <>
      <path d="M8 34 L28 14 L33 14 L31 22 L14 38 Z" fill={FILL} />
      <rect x="29" y="27" width="12" height="5" rx="2" fill={DIM} transform="rotate(-45 35 30)" />
    </>
  ),
  Pistol: (
    <>
      <path d="M7 17 h32 v7 h-3 v3 h-14 v-3 h-6 l-4 12 h-9 l5 -15 v-4 z" fill={FILL} />
      <rect x="34" y="15" width="6" height="3" fill={DIM} />
    </>
  ),
  Smg: (
    <>
      <path d="M4 20 h37 v6 h-9 v3 h-6 v-3 h-8 l-3 10 h-7 l3 -10 h-7 z" fill={FILL} />
      <rect x="41" y="21" width="4" height="4" fill={DIM} />
      <rect x="8" y="15" width="10" height="4" fill={DIM} />
    </>
  ),
  JacketArmor: (
    <>
      <path d="M16 10 h16 l8 6 v22 h-8 v-16 h-16 v16 h-8 v-22 z" fill={FILL} />
      <rect x="18" y="24" width="12" height="14" fill={DIM} />
    </>
  ),
  PlateArmor: (
    <>
      <path d="M14 9 h20 l6 7 v14 l-16 10 -16 -10 v-14 z" fill={FILL} />
      <rect x="19" y="16" width="10" height="12" rx="2" fill="#22303c" />
    </>
  ),
  Ammo9mm: (
    <>
      <path d="M13 12 a4 4 0 0 1 8 0 v24 h-8 z" fill={FILL} />
      <path d="M27 12 a4 4 0 0 1 8 0 v24 h-8 z" fill={DIM} />
    </>
  ),
  Iron: (
    <>
      <path d="M10 30 l6 -10 h16 l6 10 v6 h-28 z" fill={FILL} />
      <path d="M16 20 h16 l-3 -6 h-10 z" fill={DIM} />
    </>
  ),
  Copper: (
    <>
      <path d="M8 34 l8 -8 h16 l8 8 z" fill={DIM} />
      <path d="M12 26 l8 -8 h8 l8 8 z" fill={FILL} />
    </>
  ),
  Chemicals: (
    <>
      <path d="M20 8 h8 v10 l9 16 a3 3 0 0 1 -3 4 h-20 a3 3 0 0 1 -3 -4 l9 -16 z" fill={FILL} />
      <path d="M16 30 h16 l4 7 a2 2 0 0 1 -2 3 h-20 a2 2 0 0 1 -2 -3 z" fill={DIM} />
    </>
  ),
  Electronics: (
    <>
      <rect x="14" y="14" width="20" height="20" rx="2" fill={FILL} />
      <rect x="20" y="20" width="8" height="8" fill="#22303c" />
      {[18, 24, 30].map((p) => (
        <g key={p} fill={DIM}>
          <rect x={p} y="9" width="3" height="5" />
          <rect x={p} y="34" width="3" height="5" />
          <rect x="9" y={p} width="5" height="3" />
          <rect x="34" y={p} width="5" height="3" />
        </g>
      ))}
    </>
  ),
  Biomass: (
    <>
      <path d="M24 8 c10 8 14 16 8 24 a10 10 0 0 1 -16 0 c-6 -8 -2 -16 8 -24 z" fill={FILL} />
      <path d="M24 16 v22" stroke={DIM} strokeWidth="2.5" fill="none" />
    </>
  ),
  SteelPlate: (
    <>
      <rect x="8" y="16" width="32" height="16" rx="2" fill={FILL} />
      <circle cx="13" cy="21" r="1.6" fill="#22303c" />
      <circle cx="35" cy="21" r="1.6" fill="#22303c" />
      <circle cx="13" cy="27" r="1.6" fill="#22303c" />
      <circle cx="35" cy="27" r="1.6" fill="#22303c" />
    </>
  ),
  CopperWire: (
    <>
      <rect x="16" y="12" width="16" height="24" rx="3" fill={DIM} />
      {[16, 20, 24, 28, 32].map((y) => (
        <rect key={y} x="14" y={y} width="20" height="2.2" rx="1" fill={FILL} />
      ))}
    </>
  ),
  Polymer: (
    <>
      <rect x="10" y="18" width="13" height="13" rx="2" fill={FILL} />
      <rect x="25" y="14" width="13" height="13" rx="2" fill={DIM} />
      <rect x="18" y="28" width="13" height="10" rx="2" fill={DIM} />
    </>
  ),
  CircuitBoard: (
    <>
      <rect x="9" y="11" width="30" height="26" rx="2" fill={FILL} />
      <path d="M14 18 h8 v6 h10 M14 30 h12 M32 18 v14" stroke="#22303c" strokeWidth="2" fill="none" />
      <circle cx="14" cy="18" r="2" fill="#22303c" />
      <circle cx="32" cy="32" r="2" fill="#22303c" />
    </>
  ),
  BioGel: (
    <>
      <rect x="17" y="10" width="14" height="30" rx="4" fill={DIM} />
      <path d="M24 18 c4 4 6 7 3.5 10.5 a4.5 4.5 0 0 1 -7 0 c-2.5 -3.5 -0.5 -6.5 3.5 -10.5 z" fill={FILL} />
    </>
  ),
  BlueprintFragment: (
    <>
      <path d="M12 8 h18 l6 6 v26 h-24 z" fill={FILL} />
      <path d="M30 8 v6 h6 z" fill={DIM} />
      <path d="M17 20 h14 M17 25 h14 M17 30 h9" stroke="#22303c" strokeWidth="2" fill="none" />
    </>
  ),
  PowerCell: (
    <>
      <rect x="15" y="12" width="18" height="28" rx="3" fill={FILL} />
      <rect x="20" y="8" width="8" height="4" rx="1" fill={DIM} />
      <path d="M26 17 l-7 10 h5 l-2 8 7 -10 h-5 z" fill="#22303c" />
    </>
  ),
  Cash: (
    <>
      <rect x="8" y="14" width="30" height="17" rx="2" fill={DIM} />
      <rect x="11" y="18" width="30" height="17" rx="2" fill={FILL} />
      <circle cx="26" cy="26.5" r="5.5" fill="#22303c" />
    </>
  ),
};

/** Monochrome item silhouette, sized to fit an inventory slot card. */
export function ItemIcon({ kind, size = 34 }: { kind: ItemKind; size?: number }) {
  return (
    <svg
      viewBox="0 0 48 48"
      width={size}
      height={size}
      className="item-icon"
      aria-label={itemLabel(kind)}
    >
      {GLYPHS[kind] ?? <rect x="12" y="12" width="24" height="24" rx="3" fill={FILL} />}
    </svg>
  );
}
