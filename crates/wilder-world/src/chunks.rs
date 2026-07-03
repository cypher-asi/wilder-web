//! Chunk cache: deterministic generation + persisted overrides + collision.

use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::Arc;

use wilder_persistence::{RocksStore, WorldStore};
use wilder_physics::CollisionWorld;
use wilder_terrain::TerrainGenerator;
use wilder_types::*;

pub struct ChunkCache {
    generator: TerrainGenerator,
    store: Arc<RocksStore>,
    // RefCell: the world sim is single-task; collision queries during movement
    // need to lazily load/generate chunks through &self.
    loaded: RefCell<HashMap<ChunkCoord, LoadedChunk>>,
}

struct LoadedChunk {
    data: ChunkData,
    walkable: Vec<bool>,
    dirty: bool,
}

impl ChunkCache {
    pub fn new(generator: TerrainGenerator, store: Arc<RocksStore>) -> Self {
        Self {
            generator,
            store,
            loaded: RefCell::new(HashMap::new()),
        }
    }

    /// Load (from store) or generate the chunk, returning a clone of its data.
    pub fn get(&self, coord: ChunkCoord) -> ChunkData {
        self.ensure(coord);
        self.loaded.borrow()[&coord].data.clone()
    }

    fn ensure(&self, coord: ChunkCoord) {
        if self.loaded.borrow().contains_key(&coord) {
            return;
        }
        let data = match self.store.chunk(coord) {
            Ok(Some(persisted)) => persisted,
            _ => self.generator.generate(coord),
        };
        let walkable = wilder_terrain::walkable_grid(&data);
        self.loaded
            .borrow_mut()
            .insert(coord, LoadedChunk { data, walkable, dirty: false });
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
}

impl CollisionWorld for ChunkCache {
    fn walkable(&self, x: f32, z: f32) -> bool {
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
        chunk.walkable[tz * TILES_PER_CHUNK + tx]
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
}
