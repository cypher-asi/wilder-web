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

export interface ItemInfo {
  label: string;
  category: ItemCategory;
  /** Short market ticker (economy dashboard drill-in header). */
  ticker: string;
  /** One-line flavor/utility description for the item market page. */
  desc: string;
}

export const ITEM_INFO: Record<ItemKind, ItemInfo> = {
  Medkit: {
    label: "Medkit",
    category: "consumable",
    ticker: "MEDK",
    desc: "Field trauma kit. Restores health on use; the only thing standing between a runner and the respawn queue.",
  },
  Flashlight: {
    label: "Flashlight",
    category: "gadget",
    ticker: "LITE",
    desc: "Cheap handheld torch. Low value, but somebody always needs one.",
  },
  Pipe: {
    label: "Steel Pipe",
    category: "weapon",
    ticker: "PIPE",
    desc: "Salvaged length of pipe. Entry-level melee; swings hard, sells cheap.",
  },
  Knife: {
    label: "Combat Knife",
    category: "weapon",
    ticker: "KNFE",
    desc: "Quick melee blade. Faster than a pipe, favored by scavengers who travel light.",
  },
  Pistol: {
    label: "P9 Pistol",
    category: "weapon",
    ticker: "P9",
    desc: "Standard 9mm sidearm. The city's workhorse firearm — steady demand keeps its market liquid.",
  },
  Smg: {
    label: "K-11 SMG",
    category: "weapon",
    ticker: "K11",
    desc: "Full-auto 9mm bullet hose. Top-shelf street hardware; scarce and priced like it.",
  },
  JacketArmor: {
    label: "Padded Jacket",
    category: "armor",
    ticker: "JCKT",
    desc: "Padded street jacket with a light energy shield weave.",
  },
  PlateArmor: {
    label: "Plate Carrier",
    category: "armor",
    ticker: "PLTE",
    desc: "Ballistic plate carrier with a heavy shield cell. Serious protection for serious MILD.",
  },
  Ammo9mm: {
    label: "9mm Ammo",
    category: "ammo",
    ticker: "9MM",
    desc: "Universal 9mm rounds. Burned constantly by every gun in the city — the closest thing to a consumable currency.",
  },
  Iron: {
    label: "Iron",
    category: "resource",
    ticker: "IRON",
    desc: "Raw scrap iron pulled from mining zones and scrapyards. Feedstock for steel plate.",
  },
  Copper: {
    label: "Copper",
    category: "resource",
    ticker: "CU",
    desc: "Stripped copper salvage. Refines into wire for everything electronic.",
  },
  Chemicals: {
    label: "Chemicals",
    category: "resource",
    ticker: "CHEM",
    desc: "Unstable industrial chemicals from plants and blown-up blocks. Polymer and bio-gel precursor.",
  },
  Electronics: {
    label: "Electronics",
    category: "resource",
    ticker: "ELEC",
    desc: "Scavenged boards and components from the tech ruins. Circuit board feedstock.",
  },
  Biomass: {
    label: "Biomass",
    category: "resource",
    ticker: "BIO",
    desc: "Organic sludge harvested from the overgrowth. Cheap, plentiful, and quietly essential to bio-gel.",
  },
  SteelPlate: {
    label: "Steel Plate",
    category: "material",
    ticker: "STL",
    desc: "Refined structural steel. The backbone of weapons and plate armor manufacturing.",
  },
  CopperWire: {
    label: "Copper Wire",
    category: "material",
    ticker: "WIRE",
    desc: "Drawn copper wiring. Every powered recipe in the city runs through it.",
  },
  Polymer: {
    label: "Polymer",
    category: "material",
    ticker: "PLMR",
    desc: "Synthesized polymer stock. Molds into grips, casings and armor backing.",
  },
  CircuitBoard: {
    label: "Circuit Board",
    category: "material",
    ticker: "CRCT",
    desc: "Assembled logic board. High-value refined component for top-tier gear.",
  },
  BioGel: {
    label: "Bio-Gel",
    category: "material",
    ticker: "BGEL",
    desc: "Medical-grade regenerative gel. The active ingredient in every medkit.",
  },
  BlueprintFragment: {
    label: "Blueprint Fragment",
    category: "material",
    ticker: "BPF",
    desc: "Corrupted schematic shard. Enough of them unlock lost crafting knowledge at a lab.",
  },
  PowerCell: {
    label: "Power Cell",
    category: "material",
    ticker: "PWR",
    desc: "Charged industrial power cell. Keeps production lines running when the grid can't.",
  },
  Cash: {
    label: "Cash",
    category: "currency",
    ticker: "CASH",
    desc: "Looted street currency. Worthless paper until a Bank converts it to MILD (minus their cut).",
  },
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

/**
 * Non-item notification glyphs for the left pickup feed (currency gains, zone
 * flips, denials). Item pickups use {@link ItemIcon}; these cover the lines
 * that carry no ItemKind so every feed entry still gets a consistent icon.
 */
export type FeedIconKind = "wild" | "shards" | "energy" | "zone" | "alert";

/** Inner SVG per feed icon (20x20 viewBox, currentColor so it inherits the
 * line color — including red for alert lines). MILD/SHARDS/ENERGY mirror the
 * HUD currency chips (Hud.tsx CurrencyPanel) for visual consistency. */
const FEED_GLYPHS: Record<FeedIconKind, JSX.Element> = {
  wild: (
    <>
      <path
        d="M10 1.5 L17.5 6 v8 L10 18.5 L2.5 14 v-8 Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <path
        d="M6 7 l1.5 6 L10 9.5 L12.5 13 L14 7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
  shards: (
    <>
      <path d="M10 1.5 L14.5 8 L10 18.5 L5.5 8 Z" fill="currentColor" opacity="0.85" />
      <path d="M10 1.5 L14.5 8 L10 10.5 L5.5 8 Z" fill="currentColor" />
    </>
  ),
  energy: (
    <path d="M11.5 1.5 L4.5 11.5 h4 L8 18.5 L15.5 8.5 h-4 Z" fill="currentColor" />
  ),
  zone: (
    <>
      <path
        d="M10 1.5 L16.5 4 v6 c0 4 -3 6.5 -6.5 8 C6 16.5 3.5 14 3.5 10 V4 Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path
        d="M7 9.5 L9 11.5 L13 6.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
  alert: (
    <>
      <path
        d="M10 2 L18.5 17 H1.5 Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <rect x="9.1" y="7" width="1.8" height="5" rx="0.9" fill="currentColor" />
      <circle cx="10" cy="14.4" r="1" fill="currentColor" />
    </>
  ),
};

/** Feed notification glyph, sized to match the item glyph in a pickup line. */
export function FeedIcon({ kind, size = 22 }: { kind: FeedIconKind; size?: number }) {
  return (
    <svg
      viewBox="0 0 20 20"
      width={size}
      height={size}
      className="item-icon feed-glyph"
      aria-hidden="true"
    >
      {FEED_GLYPHS[kind]}
    </svg>
  );
}
