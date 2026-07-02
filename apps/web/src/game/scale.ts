// Canonical world scale, all in meters (1 world unit = 1 m). The baked city
// map (tools/citymap/bake.mjs) is a 1:1-meter rasterization of the official
// Wiami blockout: the island measures ~6.5 x 26 km and streets are genuine
// boulevards, 17-37 m curb to curb. Everything that sizes assets or paints
// road structure should reference these constants so the world stays
// proportionate to the map.

/** Authored height of character.glb; rendered 1:1, never rescaled. */
export const CHARACTER_HEIGHT = 1.83;

/** Standard travel lane width (US arterial). Fixed; road width changes the
 * lane count, not the lane size. */
export const LANE_WIDTH = 3.5;
/** Curbside parking lane width. */
export const PARKING_LANE_WIDTH = 2.4;
/** Painted line width for lane markings. */
export const MARKING_WIDTH = 0.12;

/** Sedan bounding dimensions (drives car prop normalization + parking). */
export const CAR_LENGTH = 4.6;
export const CAR_WIDTH = 1.9;
