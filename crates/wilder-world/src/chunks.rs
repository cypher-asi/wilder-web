//! Chunk cache: deterministic generation + persisted overrides + collision.

use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::Arc;

use wilder_persistence::{RocksStore, WorldStore};
use wilder_physics::{disc_aabb_overlap, CollisionWorld, BUILDING_FRONT_PROUD};
use wilder_terrain::TerrainGenerator;
use wilder_types::*;

use crate::interiors::ChunkInteriors;

pub struct ChunkCache {
    generator: TerrainGenerator,
    store: Arc<RocksStore>,
    // RefCell: the world sim is single-task; collision queries during movement
    // need to lazily load/generate chunks through &self.
    loaded: RefCell<HashMap<ChunkCoord, LoadedChunk>>,
    /// Registered walk-in interiors per chunk (service buildings). Applied to
    /// the collision grids whenever the chunk is (re)loaded.
    interiors: RefCell<HashMap<ChunkCoord, ChunkInteriors>>,
}

struct LoadedChunk {
    data: ChunkData,
    /// Physics walkability: interior room tiles are open (walls and door
    /// gaps are enforced by `building_aabbs`).
    walkable: Vec<bool>,
    /// Pathfinding walkability: the raw tile grid, with interiors still
    /// solid. A* is tile-granular and cannot see the sub-tile walls, so nav
    /// keeps routing around store buildings instead of cutting through them.
    nav_walkable: Vec<bool>,
    /// World-space collision boxes `[minx, minz, maxx, maxz]`: storefront
    /// front-face buffers (door gaps carved for interiors) plus interior
    /// walls / counters / furniture.
    building_aabbs: Vec<[f32; 4]>,
    dirty: bool,
}

/// Front-face collision buffers for a chunk's buildings, in world space.
fn building_front_aabbs(data: &ChunkData) -> Vec<[f32; 4]> {
    let ox = data.coord.x as f32 * CHUNK_SIZE;
    let oz = data.coord.z as f32 * CHUNK_SIZE;
    data.buildings
        .iter()
        .map(|b| {
            let minx = ox + b.tx0 as f32 * TILE_SIZE;
            let maxx = ox + b.tx1 as f32 * TILE_SIZE;
            let lot = oz + b.tz0 as f32 * TILE_SIZE;
            [minx, lot - BUILDING_FRONT_PROUD, maxx, lot]
        })
        .collect()
}

/// Physics walkability + collision boxes for a chunk, with any registered
/// interiors applied: room tiles open up, host front bands gain door gaps,
/// and interior walls/furniture join the box list.
fn apply_interiors(
    data: &ChunkData,
    ints: Option<&ChunkInteriors>,
) -> (Vec<bool>, Vec<[f32; 4]>) {
    let mut walkable = wilder_terrain::walkable_grid(data);
    let mut bands = building_front_aabbs(data);
    let Some(ints) = ints else {
        return (walkable, bands);
    };
    for &(building, ref replacement) in &ints.front_bands {
        // Swap the host's full-width band for the door-gapped segments. The
        // building keeps exactly one entry slot; extra segments append.
        if let Some(first) = replacement.first() {
            bands[building] = *first;
            bands.extend_from_slice(&replacement[1..]);
        } else {
            // Degenerate (door spans the whole face): zero-size the band.
            bands[building] = [0.0, 0.0, 0.0, 0.0];
        }
    }
    for spec in &ints.specs {
        let [tx0, tz0, tx1, tz1] = spec.tiles;
        for tz in tz0..tz1 {
            for tx in tx0..tx1 {
                walkable[tz as usize * TILES_PER_CHUNK + tx as usize] = true;
            }
        }
        bands.extend_from_slice(&spec.colliders);
    }
    (walkable, bands)
}

impl ChunkCache {
    pub fn new(generator: TerrainGenerator, store: Arc<RocksStore>) -> Self {
        Self {
            generator,
            store,
            loaded: RefCell::new(HashMap::new()),
            interiors: RefCell::new(HashMap::new()),
        }
    }

    /// Load (from store) or generate the chunk, returning a clone of its data.
    pub fn get(&self, coord: ChunkCoord) -> ChunkData {
        self.ensure(coord);
        self.loaded.borrow()[&coord].data.clone()
    }

    /// Register the walk-in interiors carved into this chunk's buildings.
    /// Takes effect immediately if the chunk is loaded, and re-applies on
    /// every future load (interiors are derived data, never persisted).
    pub fn set_interiors(&self, coord: ChunkCoord, ints: ChunkInteriors) {
        self.interiors.borrow_mut().insert(coord, ints);
        let mut loaded = self.loaded.borrow_mut();
        if let Some(chunk) = loaded.get_mut(&coord) {
            let ints = self.interiors.borrow();
            let (walkable, building_aabbs) = apply_interiors(&chunk.data, ints.get(&coord));
            chunk.walkable = walkable;
            chunk.building_aabbs = building_aabbs;
        }
    }

    /// Pathfinding view of this world: interiors read as solid so A* keeps
    /// routing around store buildings (the tile grid can't express their
    /// sub-tile walls / door gaps).
    pub fn nav(&self) -> NavView<'_> {
        NavView { cache: self }
    }

    fn ensure(&self, coord: ChunkCoord) {
        if self.loaded.borrow().contains_key(&coord) {
            return;
        }
        let data = match self.store.chunk(coord) {
            Ok(Some(persisted)) => persisted,
            _ => self.generator.generate(coord),
        };
        let nav_walkable = wilder_terrain::walkable_grid(&data);
        let ints = self.interiors.borrow();
        let (walkable, building_aabbs) = apply_interiors(&data, ints.get(&coord));
        drop(ints);
        self.loaded.borrow_mut().insert(
            coord,
            LoadedChunk { data, walkable, nav_walkable, building_aabbs, dirty: false },
        );
    }

    /// Mark a chunk modified (it will persist on the next save pass).
    #[allow(dead_code)]
    pub fn mark_dirty(&self, coord: ChunkCoord) {
        if let Some(chunk) = self.loaded.borrow_mut().get_mut(&coord) {
            chunk.dirty = true;
        }
    }

    /// Persist all dirty chunks.
    pub fn save_dirty(&self) {
        let mut loaded = self.loaded.borrow_mut();
        for chunk in loaded.values_mut() {
            if chunk.dirty {
                if let Err(e) = self.store.save_chunk(&chunk.data) {
                    tracing::error!("chunk save failed: {e}");
                } else {
                    chunk.dirty = false;
                }
            }
        }
    }

    /// Drop chunks not in `keep` (never drops dirty chunks).
    pub fn evict_except(&self, keep: &std::collections::HashSet<ChunkCoord>) {
        self.loaded
            .borrow_mut()
            .retain(|coord, chunk| chunk.dirty || keep.contains(coord));
    }

    pub fn loaded_count(&self) -> usize {
        self.loaded.borrow().len()
    }

    fn tile_walkable(&self, x: f32, z: f32, nav: bool) -> bool {
        let coord = ChunkCoord::from_world(Vec3::new(x, 0.0, z));
        self.ensure(coord);
        let loaded = self.loaded.borrow();
        let chunk = &loaded[&coord];
        let lx = x - coord.x as f32 * CHUNK_SIZE;
        let lz = z - coord.z as f32 * CHUNK_SIZE;
        let tx = (lx / TILE_SIZE) as usize;
        let tz = (lz / TILE_SIZE) as usize;
        let tx = tx.min(TILES_PER_CHUNK - 1);
        let tz = tz.min(TILES_PER_CHUNK - 1);
        let grid = if nav { &chunk.nav_walkable } else { &chunk.walkable };
        grid[tz * TILES_PER_CHUNK + tx]
    }
}

/// Pathfinding-only collision view (see [`ChunkCache::nav`]).
pub struct NavView<'a> {
    cache: &'a ChunkCache,
}

impl CollisionWorld for NavView<'_> {
    fn walkable(&self, x: f32, z: f32) -> bool {
        self.cache.tile_walkable(x, z, true)
    }
}

impl CollisionWorld for ChunkCache {
    fn walkable(&self, x: f32, z: f32) -> bool {
        self.tile_walkable(x, z, false)
    }

    fn prop_blocked(&self, x: f32, z: f32, radius: f32) -> bool {
        // A prop centered up to (radius + its radius) away can overlap the
        // disc; scan every chunk within that reach (at most a 2x2 block).
        let reach = radius + wilder_terrain::MAX_PROP_RADIUS;
        let cx0 = ((x - reach) / CHUNK_SIZE).floor() as i32;
        let cx1 = ((x + reach) / CHUNK_SIZE).floor() as i32;
        let cz0 = ((z - reach) / CHUNK_SIZE).floor() as i32;
        let cz1 = ((z + reach) / CHUNK_SIZE).floor() as i32;
        for cz in cz0..=cz1 {
            for cx in cx0..=cx1 {
                let coord = ChunkCoord::new(cx, cz);
                self.ensure(coord);
                let loaded = self.loaded.borrow();
                let chunk = &loaded[&coord];
                let ox = cx as f32 * CHUNK_SIZE;
                let oz = cz as f32 * CHUNK_SIZE;
                for p in &chunk.data.props {
                    let pr = wilder_terrain::prop_collision_radius(p.archetype);
                    if pr <= 0.0 {
                        continue;
                    }
                    let dx = ox + p.x - x;
                    let dz = oz + p.z - z;
                    let rr = radius + pr;
                    if dx * dx + dz * dz < rr * rr {
                        return true;
                    }
                }
            }
        }
        false
    }

    fn building_blocked(&self, x: f32, z: f32, radius: f32) -> bool {
        // A front buffer extends at most BUILDING_FRONT_PROUD past its chunk;
        // scan every chunk whose contents can reach the disc (at most a 2x2).
        let reach = radius + BUILDING_FRONT_PROUD;
        let cx0 = ((x - reach) / CHUNK_SIZE).floor() as i32;
        let cx1 = ((x + reach) / CHUNK_SIZE).floor() as i32;
        let cz0 = ((z - reach) / CHUNK_SIZE).floor() as i32;
        let cz1 = ((z + reach) / CHUNK_SIZE).floor() as i32;
        for cz in cz0..=cz1 {
            for cx in cx0..=cx1 {
                let coord = ChunkCoord::new(cx, cz);
                self.ensure(coord);
                let loaded = self.loaded.borrow();
                let chunk = &loaded[&coord];
                for &[minx, minz, maxx, maxz] in &chunk.building_aabbs {
                    if disc_aabb_overlap(x, z, radius, minx, minz, maxx, maxz) {
                        return true;
                    }
                }
            }
        }
        false
    }
}
