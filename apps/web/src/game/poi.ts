// Point-of-interest taxonomy: what each service building is, what happens
// there, and how it's drawn. Single source of truth for colors/glyphs so the
// HUD, minimap, holo map and in-world signage all agree.

import { EntityKind } from "../net/protocol";

/** Function-based grouping. Markers share one color per category rather than
 *  a unique color each, so the map reads as a handful of families. */
export type LegendCategory =
  | "TRADE"
  | "PRODUCTION"
  | "COMBAT"
  | "LOGISTICS"
  | "SAFE"
  | "DANGER";

/** Ordered category list: label + shared color. Drives the grouped legend and
 *  is the single source of truth for every marker's color. */
export const LEGEND_CATEGORIES: { id: LegendCategory; label: string; color: string }[] = [
  { id: "TRADE", label: "TRADE", color: "#ffd700" },
  { id: "PRODUCTION", label: "PRODUCTION", color: "#8f7bff" },
  { id: "COMBAT", label: "COMBAT", color: "#ff8c1a" },
  { id: "LOGISTICS", label: "LOGISTICS", color: "#4fc3ff" },
  { id: "SAFE", label: "SAFE", color: "#29d98c" },
  { id: "DANGER", label: "DANGER", color: "#ff4d5e" },
];

export const CATEGORY_COLOR: Record<LegendCategory, string> = Object.fromEntries(
  LEGEND_CATEGORIES.map((c) => [c.id, c.color]),
) as Record<LegendCategory, string>;

export interface PoiStyle {
  /** Display label (map legend, in-world sign). */
  label: string;
  /** Single-character marker glyph (fallback where an icon can't render). */
  glyph: string;
  /** SVG path data on a 0 0 24 24 viewBox, drawn as a line icon on the map
   *  legend and the holo-map markers. Single source of truth for both. */
  icon: string;
  /** Function family this POI belongs to (drives legend grouping). */
  category: LegendCategory;
  /** Accent color shared by every surface. Derived from the category. */
  color: string;
  /** One-line "what happens here" for the legend. */
  desc: string;
}

/** Vendor buildings served by the shared vendor panel/protocol. */
export const VENDOR_KINDS = ["Armory", "Bodega", "Bank", "Dealership"] as const;
export type VendorKind = (typeof VENDOR_KINDS)[number];

export const POI_STYLES: Partial<Record<EntityKind, PoiStyle>> = {
  Building: {
    label: "STORAGE",
    glyph: "S",
    icon: "M3 7l9-4 9 4v10l-9 4-9-4V7z M3 7l9 4 9-4 M12 11v10",
    category: "LOGISTICS",
    color: CATEGORY_COLOR.LOGISTICS,
    desc: "Stash your backpack loot",
  },
  MarketTerminal: {
    label: "MARKET",
    glyph: "M",
    icon: "M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0l-7.2-7.2a2 2 0 0 1-.6-1.4V4a2 2 0 0 1 2-2h7.6a2 2 0 0 1 1.4.6l7.2 7.2a2 2 0 0 1 0 2.8z M7.5 7.5h.01",
    category: "TRADE",
    color: CATEGORY_COLOR.TRADE,
    desc: "Player market — trade in MILD",
  },
  Refinery: {
    label: "REFINERY",
    glyph: "R",
    icon: "M9 3h6 M10 3v6l-5.2 9A1.5 1.5 0 0 0 6.1 20.3h11.8A1.5 1.5 0 0 0 19.2 18L14 9V3 M7.5 15h9",
    category: "PRODUCTION",
    color: CATEGORY_COLOR.PRODUCTION,
    desc: "Refine resources into materials",
  },
  Factory: {
    label: "FACTORY",
    glyph: "F",
    icon: "M2 20V9l6 4V9l6 4V4h4v16z M6 20v-4 M12 20v-4 M18 20v-4",
    category: "PRODUCTION",
    color: CATEGORY_COLOR.PRODUCTION,
    desc: "Manufacture gear from materials",
  },
  Laboratory: {
    label: "LABORATORY",
    glyph: "L",
    icon: "M5 3h14 M6 3v16a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V3 M6 12h12 M9.5 15.5h.01 M12.5 17.5h.01",
    category: "PRODUCTION",
    color: CATEGORY_COLOR.PRODUCTION,
    desc: "Research blueprints",
  },
  Armory: {
    label: "ARMORY",
    glyph: "A",
    icon: "M12 2v3 M12 19v3 M2 12h3 M19 12h3 M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10z M12 11.5a.5.5 0 1 0 0 1 .5.5 0 0 0 0-1z",
    category: "COMBAT",
    color: CATEGORY_COLOR.COMBAT,
    desc: "Buy & sell weapons, armor, ammo",
  },
  Bank: {
    label: "BANK",
    glyph: "B",
    icon: "M3 10 12 3l9 7 M4 10v8 M9 10v8 M15 10v8 M20 10v8 M3 21h18",
    category: "TRADE",
    color: CATEGORY_COLOR.TRADE,
    desc: "Convert looted Cash into MILD",
  },
  Bodega: {
    label: "BODEGA",
    glyph: "G",
    icon: "M6 8h12l1 12H5z M9 8a3 3 0 0 1 6 0",
    category: "TRADE",
    color: CATEGORY_COLOR.TRADE,
    desc: "General store — consumables & resource buyer",
  },
  Dealership: {
    label: "DEALERSHIP",
    glyph: "D",
    icon: "M5 13l1.6-4.6A2 2 0 0 1 8.5 7h7a2 2 0 0 1 1.9 1.4L19 13 M3 13h18v4H3z M6.5 17v2 M17.5 17v2 M7 13.5h.01 M17 13.5h.01",
    category: "TRADE",
    color: CATEGORY_COLOR.TRADE,
    desc: "Vehicles (coming soon)",
  },
  Safehouse: {
    label: "SAFEHOUSE",
    glyph: "H",
    icon: "M3 11 12 3l9 8 M5 10v10h14V10 M10 20v-6h4v6",
    category: "SAFE",
    color: CATEGORY_COLOR.SAFE,
    desc: "Safety bubble — hostiles ignore you",
  },
};

export function isVendorKind(kind: EntityKind): kind is VendorKind {
  return (VENDOR_KINDS as readonly string[]).includes(kind);
}
