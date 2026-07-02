//! NPC state and per-tick AI: patrol -> aggro -> attack -> (flee) -> dead.

use rand::Rng;
use wilder_ai::{NpcArchetype, NpcState, RAIDER, SCAV};
use wilder_physics::{step_move, CollisionWorld};
use wilder_types::*;

use crate::TICK_DT;

pub struct Npc {
    pub entity: EntityId,
    pub archetype: &'static NpcArchetype,
    pub home: Vec3,
    pub position: Vec3,
    pub yaw: f32,
    pub health: f32,
    pub state: NpcState,
    pub target: Option<EntityId>,
    pub attack_cooldown: f32,
    /// Current patrol destination.
    pub patrol_target: Option<Vec3>,
    pub patrol_wait: f32,
    /// Seconds until respawn once dead.
    pub respawn_in: f32,
    pub anim: AnimState,
    pub chunk: ChunkCoord,
}

impl Npc {
    pub fn new(entity: EntityId, archetype: &'static NpcArchetype, home: Vec3) -> Self {
        Self {
            entity,
            archetype,
            home,
            position: home,
            yaw: 0.0,
            health: archetype.max_health,
            state: NpcState::Patrol,
            target: None,
            attack_cooldown: 0.0,
            patrol_target: None,
            patrol_wait: 0.0,
            respawn_in: 0.0,
            anim: AnimState::Idle,
            chunk: ChunkCoord::from_world(home),
        }
    }

    pub fn snapshot(&self) -> EntitySnapshot {
        EntitySnapshot {
            id: self.entity,
            position: self.position,
            yaw: self.yaw,
            anim: self.anim,
            health_pct: (self.health / self.archetype.max_health).max(0.0),
        }
    }

    pub fn spawn_data(&self) -> EntitySpawnData {
        EntitySpawnData {
            id: self.entity,
            kind: EntityKind::Npc,
            name: self.archetype.name.to_string(),
            appearance: Appearance { body: 1, tint: 0xff5544 },
            position: self.position,
            yaw: self.yaw,
            anim: self.anim,
            health_pct: (self.health / self.archetype.max_health).max(0.0),
            variant: self.archetype.variant,
        }
    }

    pub fn alive(&self) -> bool {
        self.state != NpcState::Dead
    }

    /// Advance one tick. Returns Some((player_entity, damage)) if the NPC
    /// lands an attack this tick.
    pub fn tick<W: CollisionWorld>(
        &mut self,
        world: &W,
        players: &[(EntityId, Vec3)],
        rng: &mut impl Rng,
    ) -> Option<(EntityId, f32)> {
        if !self.alive() {
            return None;
        }
        self.attack_cooldown = (self.attack_cooldown - TICK_DT).max(0.0);
        self.anim = AnimState::Idle;

        // Acquire / validate target.
        let mut nearest: Option<(EntityId, Vec3, f32)> = None;
        for (id, pos) in players {
            let d = (*pos - self.position).length();
            if nearest.map(|(_, _, nd)| d < nd).unwrap_or(true) {
                nearest = Some((*id, *pos, d));
            }
        }

        match nearest {
            Some((id, pos, dist)) if dist < self.archetype.aggro_range => {
                self.state = NpcState::Aggro;
                self.target = Some(id);
                let to = pos - self.position;
                self.yaw = to.z.atan2(to.x);

                if dist <= self.archetype.attack_range {
                    self.state = NpcState::Attack;
                    if self.attack_cooldown <= 0.0 {
                        self.attack_cooldown = 1.2;
                        self.anim = AnimState::Attack;
                        return Some((id, self.archetype.damage));
                    }
                } else {
                    // Chase (direct steer with collision slide).
                    let next = step_move(world, self.position, to.x, to.z, true, TICK_DT * (self.archetype.speed / wilder_physics::RUN_SPEED));
                    if (next - self.position).length_squared() > 1e-8 {
                        self.anim = AnimState::Run;
                    }
                    self.position = next;
                }
            }
            _ => {
                self.state = NpcState::Patrol;
                self.target = None;
                self.tick_patrol(world, rng);
            }
        }
        None
    }

    fn tick_patrol<W: CollisionWorld>(&mut self, world: &W, rng: &mut impl Rng) {
        if self.patrol_wait > 0.0 {
            self.patrol_wait -= TICK_DT;
            return;
        }
        let target = match self.patrol_target {
            Some(t) => t,
            None => {
                let t = Vec3::new(
                    self.home.x + rng.random_range(-8.0..8.0),
                    0.0,
                    self.home.z + rng.random_range(-8.0..8.0),
                );
                self.patrol_target = Some(t);
                t
            }
        };
        let to = target - self.position;
        let dist = to.length();
        if dist < 0.4 {
            self.patrol_target = None;
            self.patrol_wait = rng.random_range(1.5..5.0);
            return;
        }
        self.yaw = to.z.atan2(to.x);
        let before = self.position;
        self.position = step_move(
            world,
            self.position,
            to.x,
            to.z,
            false,
            TICK_DT * (self.archetype.speed * 0.6 / wilder_physics::WALK_SPEED),
        );
        if (self.position - before).length_squared() < 1e-8 {
            // Stuck: pick a new spot.
            self.patrol_target = None;
            self.patrol_wait = 1.0;
        } else {
            self.anim = AnimState::Walk;
        }
    }
}

/// Deterministic NPC spawn set for a hostile chunk.
pub fn npc_spawns_for_chunk(coord: ChunkCoord, chunk: &ChunkData) -> Vec<(&'static NpcArchetype, Vec3)> {
    // Simple stable hash for count/placement.
    let h = (coord.x.wrapping_mul(374761393) ^ coord.z.wrapping_mul(668265263)) as u32;
    let count = 1 + (h % 3) as usize; // 1-3 NPCs per hostile chunk
    let mut out = Vec::new();
    let origin = Vec3::new(coord.x as f32 * CHUNK_SIZE, 0.0, coord.z as f32 * CHUNK_SIZE);

    // Place on walkable tiles, scanning from varied offsets.
    let mut found = 0;
    let mut i = h;
    let mut guard = 0;
    while found < count && guard < 64 {
        guard += 1;
        i = i.wrapping_mul(1664525).wrapping_add(1013904223);
        let tx = (i >> 8) as usize % TILES_PER_CHUNK;
        let tz = (i >> 16) as usize % TILES_PER_CHUNK;
        if chunk.tile(tx, tz).walkable() {
            let pos = origin
                + Vec3::new(
                    (tx as f32 + 0.5) * TILE_SIZE,
                    0.0,
                    (tz as f32 + 0.5) * TILE_SIZE,
                );
            let archetype = if (i >> 24) % 4 == 0 { &RAIDER } else { &SCAV };
            out.push((archetype, pos));
            found += 1;
        }
    }
    out
}
