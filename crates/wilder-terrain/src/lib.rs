//! City terrain from the baked Wilder World map.
//!
//! The city layout (streets, sidewalks, plots, parks, building footprints) is
//! rasterized offline from the map.wilderworld.com blockout GLBs into a 2 m
//! tile grid (`tools/citymap/bake.mjs`) and embedded here as `citymap.bin`.
//! A chunk's tiles and buildings are a pure slice of that grid; decoration
//! props remain a deterministic function of (world_seed, chunk_coord), so
//! unmodified chunks are never persisted and client/server always agree.
//!
//! Chunks outside the baked map are open water (unwalkable), which forms the
//! natural world boundary.

use rand::{Rng, SeedableRng};
use rand_pcg::Pcg64Mcg;
use std::collections::HashMap;
use std::f32::consts::{FRAC_PI_2, FRAC_PI_4, PI, TAU};
use std::sync::OnceLock;
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

/// Player-collision radius (meters) for a prop archetype. `0.0` means the prop
/// is walk-through (flat floor grates, wall-mounted signs). Mirrored on the
/// client in `apps/web/src/game/collision.ts`.
pub fn prop_collision_radius(archetype: u16) -> f32 {
    use props::*;
    match archetype {
        STREETLIGHT => 0.35,
        BENCH => 0.6,
        TRASH => 0.35,
        HYDRANT => 0.3,
        TREE => 0.55,
        CAR => 0.9,
        BARRIER => 0.5,
        KIOSK => 1.1,
        TRAFFIC_LIGHT => 0.3,
        STOP_SIGN => 0.25,
        // NEON_SIGN (wall-mounted) and VENT (floor grate) are walk-through.
        _ => 0.0,
    }
}

/// Largest value [`prop_collision_radius`] can return. Bounds how far a
/// collision query must reach into neighboring chunks.
pub const MAX_PROP_RADIUS: f32 = 1.1;

const CITYMAP_BIN: &[u8] = include_bytes!("../assets/citymap.bin");
const DISTRICTS_JSON: &str = include_str!("../assets/districts.json");

/// A named city district: label + world-meter anchor (street centroid), baked
/// by `tools/citymap/bake.mjs` alongside `citymap.bin`.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct District {
    pub name: String,
    pub x: f32,
    pub z: f32,
}

/// The baked city's named districts, parsed once on first use.
pub fn districts() -> &'static [District] {
    static DISTRICTS: OnceLock<Vec<District>> = OnceLock::new();
    DISTRICTS.get_or_init(|| {
        serde_json::from_str(DISTRICTS_JSON).expect("bad districts.json")
    })
}

/// The baked city: global tile grid + per-chunk building instances.
pub struct CityMap {
    /// World tile coordinate of grid column 0 / row 0.
    tile_min_x: i32,
    tile_min_z: i32,
    width: usize,
    height: usize,
    /// Row-major (z-major) tile kinds.
    tiles: Vec<TileKind>,
    buildings: HashMap<(i32, i32), Vec<BuildingInstance>>,
    /// Spawn point in world meters (always on a walkable road tile).
    pub spawn: Vec3,
}

fn tile_kind_from_u8(v: u8) -> TileKind {
    match v {
        0 => TileKind::Road,
        1 => TileKind::RoadLine,
        2 => TileKind::Sidewalk,
        3 => TileKind::Plaza,
        4 => TileKind::Building,
        5 => TileKind::Park,
        _ => TileKind::Water,
    }
}

impl CityMap {
    fn parse(data: &[u8]) -> CityMap {
        let mut o = 0usize;
        let take = |o: &mut usize, n: usize| {
            let s = &data[*o..*o + n];
            *o += n;
            s
        };
        let read_i32 = |o: &mut usize| i32::from_le_bytes(take(o, 4).try_into().unwrap());
        let read_u32 = |o: &mut usize| u32::from_le_bytes(take(o, 4).try_into().unwrap());
        let read_f32 = |o: &mut usize| f32::from_le_bytes(take(o, 4).try_into().unwrap());

        assert_eq!(take(&mut o, 4), b"WCM1", "bad citymap.bin magic");
        let tile_min_x = read_i32(&mut o);
        let tile_min_z = read_i32(&mut o);
        let width = read_u32(&mut o) as usize;
        let height = read_u32(&mut o) as usize;
        let spawn_x = read_f32(&mut o);
        let spawn_z = read_f32(&mut o);

        let building_count = read_u32(&mut o) as usize;
        let mut buildings: HashMap<(i32, i32), Vec<BuildingInstance>> = HashMap::new();
        for _ in 0..building_count {
            let cx = read_i32(&mut o);
            let cz = read_i32(&mut o);
            let b = take(&mut o, 6);
            let style = read_u32(&mut o);
            buildings.entry((cx, cz)).or_default().push(BuildingInstance {
                archetype: b[5] as u16,
                tx0: b[0],
                tz0: b[1],
                tx1: b[2],
                tz1: b[3],
                stories: b[4],
                style,
            });
        }

        let run_count = read_u32(&mut o) as usize;
        let mut tiles = Vec::with_capacity(width * height);
        for _ in 0..run_count {
            let r = take(&mut o, 3);
            let len = u16::from_le_bytes([r[0], r[1]]) as usize;
            let kind = tile_kind_from_u8(r[2]);
            tiles.resize(tiles.len() + len, kind);
        }
        assert_eq!(tiles.len(), width * height, "citymap tile count mismatch");

        CityMap {
            tile_min_x,
            tile_min_z,
            width,
            height,
            tiles,
            buildings,
            spawn: Vec3::new(spawn_x, 0.0, spawn_z),
        }
    }

    pub fn get() -> &'static CityMap {
        static MAP: OnceLock<CityMap> = OnceLock::new();
        MAP.get_or_init(|| CityMap::parse(CITYMAP_BIN))
    }

    /// Tile kind at a global world tile coordinate; Water outside the map.
    pub fn tile_at(&self, wtx: i32, wtz: i32) -> TileKind {
        let gx = wtx - self.tile_min_x;
        let gz = wtz - self.tile_min_z;
        if gx < 0 || gz < 0 || gx >= self.width as i32 || gz >= self.height as i32 {
            return TileKind::Water;
        }
        self.tiles[gz as usize * self.width + gx as usize]
    }

    /// World-tile bounds of the baked map: (min_x, min_z, max_x, max_z), max exclusive.
    pub fn tile_bounds(&self) -> (i32, i32, i32, i32) {
        (
            self.tile_min_x,
            self.tile_min_z,
            self.tile_min_x + self.width as i32,
            self.tile_min_z + self.height as i32,
        )
    }
}

/// Stable position hash for prop spacing decisions that must agree across
/// chunk borders (uses world tile coords, independent of the chunk grid).
fn tile_hash(wtx: i32, wtz: i32) -> u32 {
    let mut h = (wtx as u32).wrapping_mul(0x85eb_ca6b) ^ (wtz as u32).wrapping_mul(0xc2b2_ae35);
    h ^= h >> 13;
    h = h.wrapping_mul(0x27d4_eb2f);
    h ^ (h >> 16)
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

    pub fn generate(&self, coord: ChunkCoord) -> ChunkData {
        let map = CityMap::get();
        let n = TILES_PER_CHUNK;
        let base_tx = coord.x * n as i32;
        let base_tz = coord.z * n as i32;

        let mut tiles = vec![TileKind::Water; n * n];
        let mut any_land = false;
        for tz in 0..n {
            for tx in 0..n {
                let kind = map.tile_at(base_tx + tx as i32, base_tz + tz as i32);
                if kind != TileKind::Water {
                    any_land = true;
                }
                tiles[tz * n + tx] = kind;
            }
        }

        let buildings = map.buildings.get(&(coord.x, coord.z)).cloned().unwrap_or_default();

        let mut chunk = ChunkData { coord, tiles, buildings, props: Vec::new() };
        if any_land {
            self.decorate(&mut chunk, map, base_tx, base_tz);
        }
        chunk
    }

    /// Deterministic street furniture derived from the baked tiles.
    fn decorate(&self, chunk: &mut ChunkData, map: &CityMap, base_tx: i32, base_tz: i32) {
        let n = TILES_PER_CHUNK;
        let mut rng = self.chunk_rng(chunk.coord);
        let at = |tx: i32, tz: i32| map.tile_at(base_tx + tx, base_tz + tz);
        let center = |t: usize| (t as f32 + 0.5) * TILE_SIZE;

        for tz in 0..n {
            for tx in 0..n {
                let kind = chunk.tiles[tz * n + tx];
                let (itx, itz) = (tx as i32, tz as i32);
                let wtx = base_tx + itx;
                let wtz = base_tz + itz;
                let h = tile_hash(wtx, wtz);

                match kind {
                    TileKind::Sidewalk => {
                        // Which sides face a road? (curb tiles only)
                        let road_xm = at(itx - 1, itz) == TileKind::Road;
                        let road_xp = at(itx + 1, itz) == TileKind::Road;
                        let road_zm = at(itx, itz - 1) == TileKind::Road;
                        let road_zp = at(itx, itz + 1) == TileKind::Road;
                        let road_sides =
                            road_xm as u32 + road_xp as u32 + road_zm as u32 + road_zp as u32;
                        if road_sides == 0 {
                            continue;
                        }

                        // Intersection corners (roads on both axes): traffic
                        // control facing diagonally into the crossing.
                        if (road_xm || road_xp) && (road_zm || road_zp) {
                            if h % 5 == 0 {
                                let sx = if road_xm { -1.0 } else { 1.0 };
                                let sz = if road_zm { -1.0 } else { 1.0 };
                                let arch = if h % 10 == 0 {
                                    props::TRAFFIC_LIGHT
                                } else {
                                    props::STOP_SIGN
                                };
                                let rotation = match (road_xm, road_zm) {
                                    (true, true) => FRAC_PI_4,
                                    (false, true) => -FRAC_PI_4,
                                    (true, false) => PI - FRAC_PI_4,
                                    (false, false) => PI + FRAC_PI_4,
                                };
                                chunk.props.push(PropInstance {
                                    archetype: arch,
                                    x: center(tx) + sx * 0.55,
                                    z: center(tz) + sz * 0.55,
                                    rotation,
                                });
                            }
                            continue;
                        }

                        // Streetlights along straight curbs, roughly every
                        // 22 m (spacing via world-tile hash so borders agree).
                        // Rotation: 0 = arm toward -z, PI = +z, FRAC_PI_2 = -x.
                        if h % 11 == 0 {
                            let (dx, dz, rotation) = if road_zm {
                                (0.0, -0.65, 0.0)
                            } else if road_zp {
                                (0.0, 0.65, PI)
                            } else if road_xm {
                                (-0.65, 0.0, FRAC_PI_2)
                            } else {
                                (0.65, 0.0, FRAC_PI_2 + PI)
                            };
                            chunk.props.push(PropInstance {
                                archetype: props::STREETLIGHT,
                                x: center(tx) + dx,
                                z: center(tz) + dz,
                                rotation,
                            });
                        } else if h % 31 == 7 {
                            // Occasional hydrant on the curb line.
                            chunk.props.push(PropInstance {
                                archetype: props::HYDRANT,
                                x: center(tx),
                                z: center(tz),
                                rotation: rng.random_range(0.0..TAU),
                            });
                        }
                    }
                    TileKind::Road => {
                        // Parked cars in the curbside parking lane: road tile
                        // with sidewalk on exactly one side, sparse, aligned
                        // with the curb. The curb tile center sits 1.0 m from
                        // the curb face; a parking lane is 2.4 m wide, so the
                        // car center goes 1.2 m off the curb face (0.2 m from
                        // tile center, away from the sidewalk) to keep the
                        // 1.9 m body clear of both the sidewalk and the
                        // outermost lane line.
                        let walk_xm = at(itx - 1, itz) == TileKind::Sidewalk;
                        let walk_xp = at(itx + 1, itz) == TileKind::Sidewalk;
                        let walk_zm = at(itx, itz - 1) == TileKind::Sidewalk;
                        let walk_zp = at(itx, itz + 1) == TileKind::Sidewalk;
                        if h % 37 != 0 {
                            continue;
                        }
                        let (dx, dz, rotation) = if walk_zm {
                            (0.0, 0.2, if h & 64 == 0 { 0.0 } else { PI })
                        } else if walk_zp {
                            (0.0, -0.2, if h & 64 == 0 { 0.0 } else { PI })
                        } else if walk_xm {
                            (0.2, 0.0, if h & 64 == 0 { FRAC_PI_2 } else { -FRAC_PI_2 })
                        } else if walk_xp {
                            (-0.2, 0.0, if h & 64 == 0 { FRAC_PI_2 } else { -FRAC_PI_2 })
                        } else {
                            continue;
                        };
                        chunk.props.push(PropInstance {
                            archetype: props::CAR,
                            x: center(tx) + dx,
                            z: center(tz) + dz,
                            rotation,
                        });
                    }
                    TileKind::Park => {
                        if h % 13 == 0 {
                            chunk.props.push(PropInstance {
                                archetype: props::TREE,
                                x: center(tx) + rng.random_range(-0.7..0.7),
                                z: center(tz) + rng.random_range(-0.7..0.7),
                                rotation: rng.random_range(0.0..TAU),
                            });
                        } else if h % 89 == 3 {
                            chunk.props.push(PropInstance {
                                archetype: props::BENCH,
                                x: center(tx),
                                z: center(tz),
                                rotation: rng.random_range(0.0..TAU),
                            });
                        }
                    }
                    TileKind::Plaza => {
                        // Sparse plaza clutter: kiosks, benches, trees.
                        if h % 61 == 0 {
                            let arch = match h % 3 {
                                0 => props::KIOSK,
                                1 => props::BENCH,
                                _ => props::TREE,
                            };
                            chunk.props.push(PropInstance {
                                archetype: arch,
                                x: center(tx),
                                z: center(tz),
                                rotation: rng.random_range(0.0..TAU),
                            });
                        }
                    }
                    _ => {}
                }
            }
        }

        // Sidewalk clutter: a few trash bags / vents per chunk, random spots.
        let sidewalk_at = |tx: usize, tz: usize| chunk.tiles[tz * n + tx] == TileKind::Sidewalk;
        for _ in 0..rng.random_range(0..4u32) {
            let arch = *[props::TRASH, props::VENT, props::TRASH, props::BARRIER]
                .get(rng.random_range(0..4usize))
                .unwrap();
            for _attempt in 0..8 {
                let x = rng.random_range(0.0..n as f32 * TILE_SIZE);
                let z = rng.random_range(0.0..n as f32 * TILE_SIZE);
                let tx = (x / TILE_SIZE) as usize;
                let tz = (z / TILE_SIZE) as usize;
                if sidewalk_at(tx, tz) {
                    chunk.props.push(PropInstance {
                        archetype: arch,
                        x,
                        z,
                        rotation: rng.random_range(0.0..TAU),
                    });
                    break;
                }
            }
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
    fn spawn_is_on_walkable_road() {
        let map = CityMap::get();
        // wilder-world's SPAWN constant assumes the bake anchors spawn here.
        assert_eq!(map.spawn, Vec3::new(3.0, 0.0, 3.0));
        let generator = TerrainGenerator::new(42);
        let coord = ChunkCoord::from_world(map.spawn);
        let chunk = generator.generate(coord);
        let tx = ((map.spawn.x - coord.x as f32 * CHUNK_SIZE) / TILE_SIZE) as usize;
        let tz = ((map.spawn.z - coord.z as f32 * CHUNK_SIZE) / TILE_SIZE) as usize;
        assert!(matches!(chunk.tile(tx, tz), TileKind::Road | TileKind::RoadLine));
        // A 5x5 neighborhood around spawn is walkable (guaranteed by the bake).
        for dz in -2i32..=2 {
            for dx in -2i32..=2 {
                let kind =
                    map.tile_at((map.spawn.x / TILE_SIZE) as i32 + dx, (map.spawn.z / TILE_SIZE) as i32 + dz);
                assert!(kind.walkable(), "unwalkable tile at spawn offset ({dx},{dz})");
            }
        }
    }

    #[test]
    fn districts_parse_and_sit_inside_the_map() {
        let map = CityMap::get();
        let (min_x, min_z, max_x, max_z) = map.tile_bounds();
        let list = districts();
        assert_eq!(list.len(), 8);
        assert!(list.iter().any(|d| d.name == "TRANQUILITY GARDENS"));
        for d in list {
            let tx = (d.x / TILE_SIZE) as i32;
            let tz = (d.z / TILE_SIZE) as i32;
            assert!(tx >= min_x && tx < max_x && tz >= min_z && tz < max_z, "{} anchor off-map", d.name);
        }
    }

    #[test]
    fn district_anchors_have_walkable_ground_nearby() {
        // wilder-world snaps district staging spots to walkable tiles near
        // the baked anchors; that only works if land actually exists there.
        let map = CityMap::get();
        for d in districts() {
            let mut nearest = f32::MAX;
            'search: for r in 0..100 {
                let rad = r as f32 * TILE_SIZE;
                for a in 0..64 {
                    let ang = a as f32 / 64.0 * std::f32::consts::TAU;
                    let x = d.x + rad * ang.cos();
                    let z = d.z + rad * ang.sin();
                    let kind =
                        map.tile_at((x / TILE_SIZE).floor() as i32, (z / TILE_SIZE).floor() as i32);
                    if kind.walkable() {
                        nearest = rad;
                        break 'search;
                    }
                }
            }
            assert!(
                nearest <= 100.0,
                "{}: no walkable tile within 100m of anchor ({}, {})",
                d.name,
                d.x,
                d.z
            );
        }
    }

    #[test]
    fn outside_map_is_water() {
        let generator = TerrainGenerator::new(42);
        let chunk = generator.generate(ChunkCoord::new(100_000, 100_000));
        assert!(chunk.tiles.iter().all(|t| *t == TileKind::Water));
        assert!(chunk.buildings.is_empty());
        assert!(chunk.props.is_empty());
    }

    #[test]
    fn buildings_match_building_tiles() {
        // Every baked building rect must sit on Building tiles, and the rect
        // coordinates must be inside the chunk.
        let map = CityMap::get();
        let generator = TerrainGenerator::new(7);
        let coord = ChunkCoord::from_world(map.spawn);
        for cz in coord.z - 3..coord.z + 4 {
            for cx in coord.x - 3..coord.x + 4 {
                let chunk = generator.generate(ChunkCoord::new(cx, cz));
                for b in &chunk.buildings {
                    assert!(b.tx0 < b.tx1 && b.tz0 < b.tz1);
                    assert!((b.tx1 as usize) <= TILES_PER_CHUNK);
                    assert!((b.tz1 as usize) <= TILES_PER_CHUNK);
                    for tz in b.tz0..b.tz1 {
                        for tx in b.tx0..b.tx1 {
                            assert_eq!(
                                chunk.tile(tx as usize, tz as usize),
                                TileKind::Building,
                                "building rect off Building tiles in ({cx},{cz})"
                            );
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn fixed_props_never_on_road_tiles() {
        let map = CityMap::get();
        let generator = TerrainGenerator::new(7);
        let coord = ChunkCoord::from_world(map.spawn);
        for cz in coord.z - 4..coord.z + 5 {
            for cx in coord.x - 4..coord.x + 5 {
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
