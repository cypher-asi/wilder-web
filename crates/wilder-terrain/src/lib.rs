//! Deterministic city generation.
//!
//! A chunk's content is a pure function of (world_seed, chunk_coord), so
//! unmodified chunks are never persisted and client/server always agree.
//!
//! City layout: a road grid with avenues every 4 chunks and streets every
//! 2 chunks. Blocks between roads are filled with buildings, plazas, and
//! parks. All dimensions are tile-aligned (1 tile = 2 m, 16 tiles per chunk).
//!
//! Real-world proportions: streets are 3 tiles (6 m), avenues 6 tiles (12 m,
//! outermost tile on each side is a parking lane), sidewalks 2 tiles (4 m)
//! on BOTH sides of every road, building footprints 4-6 tiles (8-12 m).

use rand::{Rng, SeedableRng};
use rand_pcg::Pcg64Mcg;
use std::f32::consts::{FRAC_PI_2, FRAC_PI_4, PI, TAU};
use wilder_types::*;

/// Prop archetype ids (mirrored in the client asset catalog).
pub mod props {
    pub const STREETLIGHT: u16 = 0;
    pub const BENCH: u16 = 1;
    pub const TRASH: u16 = 2;
    pub const HYDRANT: u16 = 3;
    pub const NEON_SIGN: u16 = 4;
    pub const VENT: u16 = 5;
    pub const TREE: u16 = 6;
    pub const CAR: u16 = 7;
    pub const BARRIER: u16 = 8;
    pub const KIOSK: u16 = 9;
    pub const TRAFFIC_LIGHT: u16 = 10;
    pub const STOP_SIGN: u16 = 11;
}

pub struct TerrainGenerator {
    pub world_seed: u64,
}

impl TerrainGenerator {
    pub fn new(world_seed: u64) -> Self {
        Self { world_seed }
    }

    fn chunk_rng(&self, coord: ChunkCoord) -> Pcg64Mcg {
        // Stable per-chunk stream derived from seed + coordinates.
        let mix = self
            .world_seed
            .wrapping_mul(0x9E37_79B9_7F4A_7C15)
            .wrapping_add((coord.x as u64).wrapping_mul(0xBF58_476D_1CE4_E5B9))
            .wrapping_add((coord.z as u64).wrapping_mul(0x94D0_49BB_1331_11EB));
        Pcg64Mcg::seed_from_u64(mix)
    }

    /// Is there a road along the given chunk-grid line?
    fn road_row(&self, cz: i32) -> bool {
        cz.rem_euclid(2) == 0
    }
    fn road_col(&self, cx: i32) -> bool {
        cx.rem_euclid(2) == 0
    }
    fn avenue_row(&self, cz: i32) -> bool {
        cz.rem_euclid(4) == 0
    }
    fn avenue_col(&self, cx: i32) -> bool {
        cx.rem_euclid(4) == 0
    }

    pub fn generate(&self, coord: ChunkCoord) -> ChunkData {
        let mut rng = self.chunk_rng(coord);
        let n = TILES_PER_CHUNK;
        let mut tiles = vec![TileKind::Plaza; n * n];

        // Road layout within this chunk. Roads run along the low edges of
        // road-rows/cols: tiles 0..road_w are road, then sidewalk.
        let h_road = self.road_row(coord.z);
        let v_road = self.road_col(coord.x);
        // Streets 3 tiles (6 m), avenues 6 tiles (12 m). The outermost tile
        // on each side of an avenue serves as a parking lane.
        let h_w: usize = if self.avenue_row(coord.z) { 6 } else { 3 };
        let v_w: usize = if self.avenue_col(coord.x) { 6 } else { 3 };
        // Roads on the neighboring chunks' low edges put their far-side
        // sidewalk band on this chunk's high edges.
        let far_h_walk = self.road_row(coord.z + 1);
        let far_v_walk = self.road_col(coord.x + 1);

        for tz in 0..n {
            for tx in 0..n {
                let mut kind = TileKind::Plaza;
                let in_h = h_road && tz < h_w;
                let in_v = v_road && tx < v_w;
                if in_h || in_v {
                    kind = TileKind::Road;
                    // Center line markers on the road (visual only).
                    if in_h && !in_v && tz == h_w / 2 && tx % 2 == 0 {
                        kind = TileKind::RoadLine;
                    }
                    if in_v && !in_h && tx == v_w / 2 && tz % 2 == 0 {
                        kind = TileKind::RoadLine;
                    }
                } else {
                    // 2-tile (4 m) sidewalks flank every road on both sides:
                    // the near band belongs to this chunk's own roads, the
                    // far band to roads on the adjacent chunks' low edges.
                    let near_h = h_road && tz < h_w + 2;
                    let near_v = v_road && tx < v_w + 2;
                    let far_h = far_h_walk && tz >= n - 2;
                    let far_v = far_v_walk && tx >= n - 2;
                    if near_h || near_v || far_h || far_v {
                        kind = TileKind::Sidewalk;
                    }
                }
                tiles[tz * n + tx] = kind;
            }
        }

        // Interior area available for buildings/park (between sidewalks).
        let x0 = if v_road { v_w + 2 } else { 0 };
        let z0 = if h_road { h_w + 2 } else { 0 };
        let x1 = if far_v_walk { n - 2 } else { n };
        let z1 = if far_h_walk { n - 2 } else { n };

        let mut buildings = Vec::new();
        let mut props = Vec::new();

        // Occasionally a park instead of buildings (about 1 in 7 interior chunks).
        let is_park = rng.random_ratio(1, 7);
        if is_park {
            for tz in z0..z1 {
                for tx in x0..x1 {
                    tiles[tz * n + tx] = TileKind::Park;
                }
            }
            let trees = rng.random_range(4..9);
            for _ in 0..trees {
                let x = rng.random_range(x0 as f32 * TILE_SIZE..x1 as f32 * TILE_SIZE);
                let z = rng.random_range(z0 as f32 * TILE_SIZE..z1 as f32 * TILE_SIZE);
                props.push(PropInstance {
                    archetype: props::TREE,
                    x,
                    z,
                    rotation: rng.random_range(0.0..TAU),
                });
            }
            for _ in 0..rng.random_range(1..3u32) {
                let x = rng.random_range(x0 as f32 * TILE_SIZE..x1 as f32 * TILE_SIZE);
                let z = rng.random_range(z0 as f32 * TILE_SIZE..z1 as f32 * TILE_SIZE);
                props.push(PropInstance { archetype: props::BENCH, x, z, rotation: 0.0 });
            }
        } else {
            self.place_buildings(&mut rng, &mut tiles, &mut buildings, x0, z0, x1, z1);
        }

        // Tiles are final past this point; props below only read them.
        let sidewalk_at = |tx: usize, tz: usize| tiles[tz * n + tx] == TileKind::Sidewalk;

        // Streetlights every 12 tiles (24 m) on both sides of every road,
        // standing on the sidewalk 0.7 m from the curb. Rotation convention:
        // 0.0 = arm reaches toward -z (near side of a horizontal road),
        // PI = arm toward +z (far side), FRAC_PI_2 = arm toward -x (near
        // side of a vertical road), FRAC_PI_2 + PI = arm toward +x.
        if h_road {
            let z = h_w as f32 * TILE_SIZE + 0.7;
            for tx in (0..n).step_by(12) {
                if sidewalk_at(tx, h_w) {
                    let x = tx as f32 * TILE_SIZE + 1.0;
                    props.push(PropInstance { archetype: props::STREETLIGHT, x, z, rotation: 0.0 });
                }
            }
        }
        if far_h_walk {
            let z = n as f32 * TILE_SIZE - 0.7;
            for tx in (0..n).step_by(12) {
                if sidewalk_at(tx, n - 1) {
                    let x = tx as f32 * TILE_SIZE + 1.0;
                    props.push(PropInstance { archetype: props::STREETLIGHT, x, z, rotation: PI });
                }
            }
        }
        if v_road {
            let x = v_w as f32 * TILE_SIZE + 0.7;
            for tz in (0..n).step_by(12) {
                if sidewalk_at(v_w, tz) {
                    let z = tz as f32 * TILE_SIZE + 1.0;
                    props.push(PropInstance {
                        archetype: props::STREETLIGHT,
                        x,
                        z,
                        rotation: FRAC_PI_2,
                    });
                }
            }
        }
        if far_v_walk {
            let x = n as f32 * TILE_SIZE - 0.7;
            for tz in (0..n).step_by(12) {
                if sidewalk_at(n - 1, tz) {
                    let z = tz as f32 * TILE_SIZE + 1.0;
                    props.push(PropInstance {
                        archetype: props::STREETLIGHT,
                        x,
                        z,
                        rotation: FRAC_PI_2 + PI,
                    });
                }
            }
        }

        // Intersection control: one prop on each sidewalk corner this chunk
        // owns, facing diagonally into the intersection. Traffic lights on
        // avenue intersections, stop signs elsewhere. The four cases below
        // are mutually exclusive (adjacent grid lines are never both roads).
        if h_road && v_road {
            let arch = if self.avenue_row(coord.z) || self.avenue_col(coord.x) {
                props::TRAFFIC_LIGHT
            } else {
                props::STOP_SIGN
            };
            if sidewalk_at(v_w, h_w) {
                props.push(PropInstance {
                    archetype: arch,
                    x: v_w as f32 * TILE_SIZE + 0.7,
                    z: h_w as f32 * TILE_SIZE + 0.7,
                    rotation: FRAC_PI_4, // faces (-x, -z)
                });
            }
        } else if h_road && far_v_walk {
            let arch = if self.avenue_row(coord.z) || self.avenue_col(coord.x + 1) {
                props::TRAFFIC_LIGHT
            } else {
                props::STOP_SIGN
            };
            if sidewalk_at(n - 1, h_w) {
                props.push(PropInstance {
                    archetype: arch,
                    x: n as f32 * TILE_SIZE - 0.7,
                    z: h_w as f32 * TILE_SIZE + 0.7,
                    rotation: -FRAC_PI_4, // faces (+x, -z)
                });
            }
        } else if v_road && far_h_walk {
            let arch = if self.avenue_col(coord.x) || self.avenue_row(coord.z + 1) {
                props::TRAFFIC_LIGHT
            } else {
                props::STOP_SIGN
            };
            if sidewalk_at(v_w, n - 1) {
                props.push(PropInstance {
                    archetype: arch,
                    x: v_w as f32 * TILE_SIZE + 0.7,
                    z: n as f32 * TILE_SIZE - 0.7,
                    rotation: PI - FRAC_PI_4, // faces (-x, +z)
                });
            }
        } else if far_h_walk && far_v_walk {
            let arch = if self.avenue_row(coord.z + 1) || self.avenue_col(coord.x + 1) {
                props::TRAFFIC_LIGHT
            } else {
                props::STOP_SIGN
            };
            if sidewalk_at(n - 1, n - 1) {
                props.push(PropInstance {
                    archetype: arch,
                    x: n as f32 * TILE_SIZE - 0.7,
                    z: n as f32 * TILE_SIZE - 0.7,
                    rotation: PI + FRAC_PI_4, // faces (+x, +z)
                });
            }
        }

        // Parked cars. Avenues get 1-3 cars in their parking lanes (the
        // outermost road tile on each side); narrow streets keep a ~2/3
        // chance of a single car pulled up against the curb.
        if h_road {
            if self.avenue_row(coord.z) {
                let count = rng.random_range(1..=3u32);
                let mut x = if v_road { v_w as f32 * TILE_SIZE } else { 0.0 }
                    + rng.random_range(0.5..4.0);
                for _ in 0..count {
                    if x > n as f32 * TILE_SIZE - 4.0 {
                        break;
                    }
                    let z = if rng.random_bool(0.5) {
                        0.5 * TILE_SIZE // low-side parking lane (tz = 0)
                    } else {
                        (h_w as f32 - 0.5) * TILE_SIZE // high-side lane
                    };
                    let rotation = if rng.random_bool(0.5) { 0.0 } else { PI };
                    props.push(PropInstance { archetype: props::CAR, x, z, rotation });
                    x += 5.0 + rng.random_range(1.0..6.0);
                }
            } else if rng.random_ratio(2, 3) {
                let tx = rng.random_range(2..n - 2);
                props.push(PropInstance {
                    archetype: props::CAR,
                    x: tx as f32 * TILE_SIZE,
                    // Inside the road, hugging the curb on the sidewalk side.
                    z: (h_w as f32 - 0.5) * TILE_SIZE,
                    rotation: if rng.random_bool(0.5) { 0.0 } else { PI },
                });
            }
        }
        if v_road && self.avenue_col(coord.x) {
            let count = rng.random_range(1..=3u32);
            let mut z =
                if h_road { h_w as f32 * TILE_SIZE } else { 0.0 } + rng.random_range(0.5..4.0);
            for _ in 0..count {
                if z > n as f32 * TILE_SIZE - 4.0 {
                    break;
                }
                let x = if rng.random_bool(0.5) {
                    0.5 * TILE_SIZE // low-side parking lane (tx = 0)
                } else {
                    (v_w as f32 - 0.5) * TILE_SIZE // high-side lane
                };
                let rotation = if rng.random_bool(0.5) { FRAC_PI_2 } else { -FRAC_PI_2 };
                props.push(PropInstance { archetype: props::CAR, x, z, rotation });
                z += 5.0 + rng.random_range(1.0..6.0);
            }
        }

        // Sidewalk clutter: scatter onto actual Sidewalk tiles only.
        for _ in 0..rng.random_range(0..4u32) {
            let arch = *[props::TRASH, props::HYDRANT, props::VENT, props::KIOSK]
                .get(rng.random_range(0..4usize))
                .unwrap();
            for _attempt in 0..8 {
                let x = rng.random_range(0.0..n as f32 * TILE_SIZE);
                let z = rng.random_range(0.0..n as f32 * TILE_SIZE);
                let tx = (x / TILE_SIZE) as usize;
                let tz = (z / TILE_SIZE) as usize;
                if sidewalk_at(tx, tz) {
                    props.push(PropInstance {
                        archetype: arch,
                        x,
                        z,
                        rotation: rng.random_range(0.0..TAU),
                    });
                    break;
                }
            }
        }

        ChunkData { coord, tiles, buildings, props }
    }

    #[allow(clippy::too_many_arguments)]
    fn place_buildings(
        &self,
        rng: &mut Pcg64Mcg,
        tiles: &mut [TileKind],
        buildings: &mut Vec<BuildingInstance>,
        x0: usize,
        z0: usize,
        x1: usize,
        z1: usize,
    ) {
        let n = TILES_PER_CHUNK;
        // Greedy packing: carve the interior into 4-6 tile (8-12 m) building
        // footprints with 1-tile alleys between them.
        let mut tz = z0;
        while tz + 4 <= z1 {
            let depth = rng.random_range(4..=usize::min(6, z1 - tz));
            let mut tx = x0;
            while tx + 4 <= x1 {
                let width = rng.random_range(4..=usize::min(6, x1 - tx));
                // Skip some lots to create plazas/alleys.
                if rng.random_ratio(5, 6) {
                    let stories = rng.random_range(2..=8u8);
                    let archetype = rng.random_range(0..4u16);
                    for z in tz..(tz + depth).min(z1) {
                        for x in tx..(tx + width).min(x1) {
                            tiles[z * n + x] = TileKind::Building;
                        }
                    }
                    buildings.push(BuildingInstance {
                        archetype,
                        tx0: tx as u8,
                        tz0: tz as u8,
                        tx1: (tx + width).min(x1) as u8,
                        tz1: (tz + depth).min(z1) as u8,
                        stories,
                        style: rng.random(),
                    });
                }
                tx += width + 1;
            }
            tz += depth + 1;
        }
    }
}

/// Walkability grid for a chunk (server collision + pathfinding).
pub fn walkable_grid(chunk: &ChunkData) -> Vec<bool> {
    chunk.tiles.iter().map(|t| t.walkable()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deterministic() {
        let gen1 = TerrainGenerator::new(1234);
        let gen2 = TerrainGenerator::new(1234);
        let a = gen1.generate(ChunkCoord::new(3, -7));
        let b = gen2.generate(ChunkCoord::new(3, -7));
        assert_eq!(a.tiles, b.tiles);
        assert_eq!(a.buildings.len(), b.buildings.len());
        assert_eq!(a.props.len(), b.props.len());
    }

    #[test]
    fn different_seed_differs() {
        let a = TerrainGenerator::new(1).generate(ChunkCoord::new(1, 1));
        let b = TerrainGenerator::new(2).generate(ChunkCoord::new(1, 1));
        assert!(a.tiles != b.tiles || a.buildings.len() != b.buildings.len());
    }

    #[test]
    fn roads_are_walkable_and_connected_on_grid_lines() {
        let generator = TerrainGenerator::new(42);
        // Chunk (0,0) sits on avenue row 0 and avenue col 0: both roads
        // are avenues, 6 tiles (12 m) wide.
        let chunk = generator.generate(ChunkCoord::new(0, 0));
        assert!(chunk.tile(0, 0).walkable());
        for tx in 0..TILES_PER_CHUNK {
            for tz in 0..6 {
                assert!(
                    matches!(chunk.tile(tx, tz), TileKind::Road | TileKind::RoadLine),
                    "expected avenue road at {tx},{tz}"
                );
                assert!(chunk.tile(tx, tz).walkable(), "road blocked at {tx},{tz}");
            }
        }
        // A 2-tile sidewalk band follows the horizontal avenue.
        for tx in 6..TILES_PER_CHUNK {
            assert_eq!(chunk.tile(tx, 6), TileKind::Sidewalk);
            assert_eq!(chunk.tile(tx, 7), TileKind::Sidewalk);
        }
    }

    #[test]
    fn sidewalks_on_both_sides_of_roads() {
        let generator = TerrainGenerator::new(42);
        // Chunk (0,1) has no horizontal road of its own, but road_row(2)
        // runs along its high edge, so its far-side sidewalk band occupies
        // tz = 14,15 (except where the vertical avenue passes through).
        let chunk = generator.generate(ChunkCoord::new(0, 1));
        for tx in 6..TILES_PER_CHUNK {
            assert_eq!(chunk.tile(tx, 14), TileKind::Sidewalk, "no far sidewalk at {tx},14");
            assert_eq!(chunk.tile(tx, 15), TileKind::Sidewalk, "no far sidewalk at {tx},15");
        }
    }

    #[test]
    fn fixed_props_never_on_road_tiles() {
        let generator = TerrainGenerator::new(7);
        for cz in -4..5 {
            for cx in -4..5 {
                let chunk = generator.generate(ChunkCoord::new(cx, cz));
                for p in &chunk.props {
                    let fixed = matches!(
                        p.archetype,
                        props::STREETLIGHT | props::TRAFFIC_LIGHT | props::STOP_SIGN
                    );
                    if !fixed {
                        continue;
                    }
                    let tx = ((p.x / TILE_SIZE) as usize).min(TILES_PER_CHUNK - 1);
                    let tz = ((p.z / TILE_SIZE) as usize).min(TILES_PER_CHUNK - 1);
                    let kind = chunk.tile(tx, tz);
                    assert!(
                        !matches!(kind, TileKind::Road | TileKind::RoadLine),
                        "prop {} on road tile ({tx},{tz}) in chunk ({cx},{cz})",
                        p.archetype
                    );
                }
            }
        }
    }
}
