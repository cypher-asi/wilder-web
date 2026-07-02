//! Deterministic city generation.
//!
//! A chunk's content is a pure function of (world_seed, chunk_coord), so
//! unmodified chunks are never persisted and client/server always agree.
//!
//! City layout: a road grid with avenues every 4 chunks and streets every
//! 2 chunks. Blocks between roads are filled with buildings, plazas, and
//! parks. All dimensions are tile-aligned (1 tile = 2 m, 16 tiles per chunk).

use rand::{Rng, SeedableRng};
use rand_pcg::Pcg64Mcg;
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
        let h_w: usize = if self.avenue_row(coord.z) { 4 } else { 3 };
        let v_w: usize = if self.avenue_col(coord.x) { 4 } else { 3 };

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
                    let near_h = h_road && tz < h_w + 1;
                    let near_v = v_road && tx < v_w + 1;
                    if near_h || near_v {
                        kind = TileKind::Sidewalk;
                    }
                }
                tiles[tz * n + tx] = kind;
            }
        }

        // Interior area available for buildings/park.
        let x0 = if v_road { v_w + 1 } else { 0 };
        let z0 = if h_road { h_w + 1 } else { 0 };

        let mut buildings = Vec::new();
        let mut props = Vec::new();

        // Occasionally a park instead of buildings (about 1 in 7 interior chunks).
        let is_park = rng.random_ratio(1, 7);
        if is_park {
            for tz in z0..n {
                for tx in x0..n {
                    tiles[tz * n + tx] = TileKind::Park;
                }
            }
            let trees = rng.random_range(4..9);
            for _ in 0..trees {
                let x = rng.random_range(x0 as f32 * TILE_SIZE..n as f32 * TILE_SIZE);
                let z = rng.random_range(z0 as f32 * TILE_SIZE..n as f32 * TILE_SIZE);
                props.push(PropInstance {
                    archetype: props::TREE,
                    x,
                    z,
                    rotation: rng.random_range(0.0..std::f32::consts::TAU),
                });
            }
            for _ in 0..rng.random_range(1..3u32) {
                let x = rng.random_range(x0 as f32 * TILE_SIZE..n as f32 * TILE_SIZE);
                let z = rng.random_range(z0 as f32 * TILE_SIZE..n as f32 * TILE_SIZE);
                props.push(PropInstance { archetype: props::BENCH, x, z, rotation: 0.0 });
            }
        } else {
            self.place_buildings(&mut rng, &mut tiles, &mut buildings, x0, z0);
        }

        // Street furniture along roads.
        if h_road {
            for tx in (0..n).step_by(4) {
                let x = tx as f32 * TILE_SIZE + 1.0;
                let z = h_w as f32 * TILE_SIZE + 0.6;
                props.push(PropInstance { archetype: props::STREETLIGHT, x, z, rotation: 0.0 });
            }
            // Parked/abandoned cars.
            if rng.random_ratio(2, 3) {
                let tx = rng.random_range(2..n - 2);
                props.push(PropInstance {
                    archetype: props::CAR,
                    x: tx as f32 * TILE_SIZE,
                    z: (h_w as f32 - 1.0) * TILE_SIZE,
                    rotation: if rng.random_bool(0.5) { 0.0 } else { std::f32::consts::PI },
                });
            }
        }
        if v_road {
            for tz in (2..n).step_by(4) {
                let x = v_w as f32 * TILE_SIZE + 0.6;
                let z = tz as f32 * TILE_SIZE + 1.0;
                props.push(PropInstance {
                    archetype: props::STREETLIGHT,
                    x,
                    z,
                    rotation: std::f32::consts::FRAC_PI_2,
                });
            }
        }
        // Sidewalk clutter.
        for _ in 0..rng.random_range(0..4u32) {
            let arch = *[props::TRASH, props::HYDRANT, props::VENT, props::KIOSK]
                .get(rng.random_range(0..4usize))
                .unwrap();
            // Scatter on sidewalks near the interior edge.
            let x = rng.random_range(x0 as f32 * TILE_SIZE..(n as f32) * TILE_SIZE);
            let z = if h_road { (h_w as f32 + 0.5) * TILE_SIZE } else { rng.random_range(0.0..n as f32 * TILE_SIZE) };
            props.push(PropInstance {
                archetype: arch,
                x,
                z,
                rotation: rng.random_range(0.0..std::f32::consts::TAU),
            });
        }

        ChunkData { coord, tiles, buildings, props }
    }

    fn place_buildings(
        &self,
        rng: &mut Pcg64Mcg,
        tiles: &mut [TileKind],
        buildings: &mut Vec<BuildingInstance>,
        x0: usize,
        z0: usize,
    ) {
        let n = TILES_PER_CHUNK;
        // Greedy packing: carve the interior into building footprints with
        // 1-tile alleys between them.
        let mut tz = z0;
        while tz + 3 <= n {
            let depth = rng.random_range(3..=usize::min(6, n - tz));
            let mut tx = x0;
            while tx + 3 <= n {
                let width = rng.random_range(3..=usize::min(6, n - tx));
                // Skip some lots to create plazas/alleys.
                if rng.random_ratio(5, 6) {
                    let stories = rng.random_range(2..=8u8);
                    let archetype = rng.random_range(0..4u16);
                    for z in tz..(tz + depth).min(n) {
                        for x in tx..(tx + width).min(n) {
                            tiles[z * n + x] = TileKind::Building;
                        }
                    }
                    buildings.push(BuildingInstance {
                        archetype,
                        tx0: tx as u8,
                        tz0: tz as u8,
                        tx1: (tx + width).min(n) as u8,
                        tz1: (tz + depth).min(n) as u8,
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
        // Chunk (0,0) has roads on both low edges.
        let chunk = generator.generate(ChunkCoord::new(0, 0));
        assert!(chunk.tile(0, 0).walkable());
        // Road row continues across the whole chunk.
        for tx in 0..TILES_PER_CHUNK {
            assert!(chunk.tile(tx, 1).walkable(), "road row blocked at {tx}");
        }
    }
}
