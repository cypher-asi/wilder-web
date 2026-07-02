//! The authoritative world simulation.
//!
//! Runs as a single tokio task at TICK_HZ. WebSocket connections talk to it
//! through a command channel; it replies through per-player message channels.

mod chunks;

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{mpsc, oneshot};
use wilder_pathfinding::find_path;
use wilder_persistence::{CharacterStore, RocksStore, WorldStore};
use wilder_physics::{position_clear, step_move, RUN_SPEED};
use wilder_protocol::*;
use wilder_replication::{diff_view, view_set};
use wilder_terrain::TerrainGenerator;
use wilder_types::*;

pub use chunks::ChunkCache;

pub const TICK_HZ: u32 = 20;
pub const TICK_DT: f32 = 1.0 / TICK_HZ as f32;
/// Persist characters/chunks every this many ticks (10 s).
const SAVE_INTERVAL_TICKS: u64 = 200;
/// Default spawn: on the road corner of chunk (0,0), always walkable.
const SPAWN: Vec3 = Vec3::new(3.0, 0.0, 3.0);

/// Commands from connections into the sim.
pub enum WorldCmd {
    Join {
        account: AccountId,
        character_id: CharacterId,
        tx: mpsc::UnboundedSender<S2C>,
        reply: oneshot::Sender<Result<EntityId, String>>,
    },
    Msg {
        entity: EntityId,
        msg: C2S,
    },
    Leave {
        entity: EntityId,
    },
}

#[derive(Clone)]
pub struct WorldHandle {
    pub tx: mpsc::UnboundedSender<WorldCmd>,
    pub seed: u64,
}

struct Player {
    entity: EntityId,
    character: Character,
    inventory: Inventory,
    tx: mpsc::UnboundedSender<S2C>,
    /// Queued direct-movement inputs for this tick.
    pending_inputs: Vec<(u32, f32, f32, bool, f32)>, // seq, dx, dz, run, dt
    last_input_seq: u32,
    /// Active click-to-move path (world-space waypoints).
    path: Vec<Vec3>,
    /// Chunks currently streamed to this player.
    view: HashSet<ChunkCoord>,
    /// Entities currently spawned on this client.
    known_entities: HashSet<EntityId>,
    moved_this_tick: bool,
    ran_this_tick: bool,
    dirty: bool,
}

impl Player {
    fn anim(&self) -> AnimState {
        if self.moved_this_tick {
            if self.ran_this_tick {
                AnimState::Run
            } else {
                AnimState::Walk
            }
        } else {
            AnimState::Idle
        }
    }

    fn snapshot(&self) -> EntitySnapshot {
        EntitySnapshot {
            id: self.entity,
            position: self.character.position,
            yaw: self.character.yaw,
            anim: self.anim(),
            health_pct: if self.character.max_health > 0.0 {
                self.character.health / self.character.max_health
            } else {
                1.0
            },
        }
    }

    fn spawn_data(&self) -> EntitySpawnData {
        EntitySpawnData {
            id: self.entity,
            kind: EntityKind::Player,
            name: self.character.name.clone(),
            appearance: self.character.appearance.clone(),
            position: self.character.position,
            yaw: self.character.yaw,
            anim: self.anim(),
            health_pct: 1.0,
            variant: 0,
        }
    }
}

pub struct World {
    store: Arc<RocksStore>,
    chunks: ChunkCache,
    players: HashMap<EntityId, Player>,
    next_entity: EntityId,
    tick: u64,
    seed: u64,
    rx: mpsc::UnboundedReceiver<WorldCmd>,
}

/// Create the world and spawn its tick loop. Returns a handle for connections.
pub fn spawn_world(store: Arc<RocksStore>) -> WorldHandle {
    // World seed persists so the city never changes between restarts.
    let seed: u64 = match store.meta::<u64>("world_seed") {
        Ok(Some(seed)) => seed,
        _ => {
            let seed: u64 = rand::random();
            let _ = store.save_meta("world_seed", &seed);
            seed
        }
    };

    let (tx, rx) = mpsc::unbounded_channel();
    let world = World {
        store: store.clone(),
        chunks: ChunkCache::new(TerrainGenerator::new(seed), store),
        players: HashMap::new(),
        next_entity: 1,
        tick: 0,
        seed,
        rx,
    };
    tokio::spawn(world.run());
    WorldHandle { tx, seed }
}

impl World {
    async fn run(mut self) {
        tracing::info!(seed = self.seed, "world sim started at {TICK_HZ} Hz");
        let mut interval = tokio::time::interval(Duration::from_millis(1000 / TICK_HZ as u64));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            interval.tick().await;
            // Drain all pending commands, then advance one tick.
            while let Ok(cmd) = self.rx.try_recv() {
                self.handle_cmd(cmd);
            }
            self.step();
        }
    }

    fn handle_cmd(&mut self, cmd: WorldCmd) {
        match cmd {
            WorldCmd::Join { account, character_id, tx, reply } => {
                let result = self.join(account, character_id, tx);
                let _ = reply.send(result);
            }
            WorldCmd::Msg { entity, msg } => self.handle_msg(entity, msg),
            WorldCmd::Leave { entity } => self.leave(entity),
        }
    }

    fn join(
        &mut self,
        account: AccountId,
        character_id: CharacterId,
        tx: mpsc::UnboundedSender<S2C>,
    ) -> Result<EntityId, String> {
        let character = self
            .store
            .character(character_id)
            .map_err(|_| "character not found".to_string())?;
        if character.account_id != account {
            return Err("character does not belong to this account".into());
        }
        // Reject double-join of the same character.
        if self
            .players
            .values()
            .any(|p| p.character.id == character_id)
        {
            return Err("character already in world".into());
        }
        let inventory = self.store.inventory(character_id).unwrap_or_default();

        let entity = self.next_entity;
        self.next_entity += 1;

        let mut character = character;
        // Ensure the saved position is still valid (world gen may have changed).
        if !position_clear(&self.chunks, character.position.x, character.position.z) {
            character.position = SPAWN;
        }

        let player = Player {
            entity,
            character,
            inventory,
            tx: tx.clone(),
            pending_inputs: Vec::new(),
            last_input_seq: 0,
            path: Vec::new(),
            view: HashSet::new(),
            known_entities: HashSet::new(),
            moved_this_tick: false,
            ran_this_tick: false,
            dirty: true,
        };

        let _ = tx.send(S2C::WorldJoined {
            entity_id: entity,
            character: player.character.clone(),
            inventory: player.inventory.clone(),
            server_tick: self.tick,
            world_seed: self.seed,
        });

        self.players.insert(entity, player);
        tracing::info!(entity, "player joined");
        Ok(entity)
    }

    fn leave(&mut self, entity: EntityId) {
        if let Some(player) = self.players.remove(&entity) {
            self.persist_player(&player);
            tracing::info!(entity, name = %player.character.name, "player left");
        }
    }

    fn handle_msg(&mut self, entity: EntityId, msg: C2S) {
        let Some(player) = self.players.get_mut(&entity) else {
            return;
        };
        match msg {
            C2S::MoveInput { seq, dx, dz, run } => {
                player.path.clear();
                player.pending_inputs.push((seq, dx, dz, run, TICK_DT));
            }
            C2S::MoveTo { seq, x, z } => {
                player.last_input_seq = player.last_input_seq.max(seq);
                let from = player.character.position;
                let to = Vec3::new(x, 0.0, z);
                match find_path(&self.chunks, from, to) {
                    Some(path) => player.path = path,
                    None => {
                        let _ = player.tx.send(S2C::Error {
                            message: "can't reach that spot".into(),
                        });
                    }
                }
            }
            C2S::StopMove { seq } => {
                player.last_input_seq = player.last_input_seq.max(seq);
                player.path.clear();
            }
            C2S::InventoryAction(action) => {
                Self::apply_inventory_action(player, action);
                player.dirty = true;
                let _ = player.tx.send(S2C::InventoryUpdate(player.inventory.clone()));
            }
            C2S::Chat { text } => {
                let text: String = text.chars().take(240).collect();
                if text.trim().is_empty() {
                    return;
                }
                let from = player.character.name.clone();
                for p in self.players.values() {
                    let _ = p.tx.send(S2C::Chat { from: from.clone(), text: text.clone() });
                }
            }
            C2S::Pong { .. } => {}
            // Authenticate/JoinWorld are handled by the gateway before entities exist.
            C2S::Authenticate { .. } | C2S::JoinWorld { .. } => {}
            // Phase 1+ messages: accepted but inert in Phase 0.
            C2S::Interact { .. }
            | C2S::Attack { .. }
            | C2S::UseItem { .. }
            | C2S::Craft { .. }
            | C2S::QueueProduction { .. }
            | C2S::Market(_) => {}
        }
    }

    fn apply_inventory_action(player: &mut Player, action: InventoryAction) {
        match action {
            InventoryAction::MoveSlot { from, to } => {
                wilder_inventory::move_slot(&mut player.inventory.slots, from as usize, to as usize);
            }
            InventoryAction::Equip { slot } => {
                wilder_inventory::equip(&mut player.inventory, slot as usize);
            }
            InventoryAction::Unequip { weapon } => {
                wilder_inventory::unequip(&mut player.inventory, weapon);
            }
            InventoryAction::Drop { slot } => {
                if let Some(s) = player.inventory.slots.get_mut(slot as usize) {
                    *s = None;
                }
            }
            // Stash access lands in Phase 1.
            InventoryAction::Deposit { .. } | InventoryAction::Withdraw { .. } => {}
        }
    }

    fn step(&mut self) {
        self.tick += 1;

        self.apply_movement();
        self.update_interest();
        self.replicate();

        if self.tick % SAVE_INTERVAL_TICKS == 0 {
            self.save_all();
        }
    }

    fn apply_movement(&mut self) {
        for player in self.players.values_mut() {
            player.moved_this_tick = false;
            player.ran_this_tick = false;
            let before = player.character.position;

            // Direct inputs (client prediction mirrors this exactly).
            let inputs = std::mem::take(&mut player.pending_inputs);
            for (seq, dx, dz, run, dt) in inputs {
                player.last_input_seq = player.last_input_seq.max(seq);
                let next = step_move(&self.chunks, player.character.position, dx, dz, run, dt);
                player.character.position = next;
                if dx != 0.0 || dz != 0.0 {
                    player.character.yaw = dz.atan2(dx);
                    player.ran_this_tick = run;
                }
            }

            // Click-to-move path following.
            if !player.path.is_empty() {
                let target = player.path[0];
                let pos = player.character.position;
                let (dx, dz) = (target.x - pos.x, target.z - pos.z);
                let dist = (dx * dx + dz * dz).sqrt();
                if dist < 0.15 {
                    player.path.remove(0);
                } else {
                    let next = step_move(&self.chunks, pos, dx, dz, true, TICK_DT);
                    player.character.position = next;
                    player.character.yaw = dz.atan2(dx);
                    player.ran_this_tick = true;
                    // If blocked (didn't move), drop the path.
                    if (next - pos).length() < RUN_SPEED * TICK_DT * 0.1 {
                        player.path.clear();
                    }
                }
            }

            if (player.character.position - before).length_squared() > 1e-10 {
                player.moved_this_tick = true;
                player.dirty = true;
            }
        }
    }

    fn update_interest(&mut self) {
        // Stream chunks in/out per player as they cross chunk borders.
        let mut all_needed: HashSet<ChunkCoord> = HashSet::new();
        for player in self.players.values_mut() {
            let center = ChunkCoord::from_world(player.character.position);
            let new_view = view_set(center);
            if new_view != player.view {
                let (entered, exited) = diff_view(&player.view, &new_view);
                for coord in entered {
                    let chunk = self.chunks.get(coord);
                    let _ = player.tx.send(S2C::ChunkData(chunk));
                }
                for coord in exited {
                    let _ = player.tx.send(S2C::ChunkUnload { coord });
                }
                player.view = new_view;
            }
            all_needed.extend(player.view.iter().copied());
        }
        // Keep server memory bounded: drop chunks nobody is near.
        if self.tick % 100 == 0 {
            self.chunks.evict_except(&all_needed);
        }
    }

    fn replicate(&mut self) {
        // Entity interest: players see players in their view chunks.
        let states: Vec<(EntityId, ChunkCoord, EntitySpawnData, EntitySnapshot)> = self
            .players
            .values()
            .map(|p| {
                (
                    p.entity,
                    ChunkCoord::from_world(p.character.position),
                    p.spawn_data(),
                    p.snapshot(),
                )
            })
            .collect();

        for player in self.players.values_mut() {
            let mut visible: Vec<&EntitySnapshot> = Vec::new();
            let mut visible_ids: HashSet<EntityId> = HashSet::new();

            for (id, chunk, spawn, snap) in &states {
                if !player.view.contains(chunk) {
                    continue;
                }
                visible_ids.insert(*id);
                if !player.known_entities.contains(id) {
                    let _ = player.tx.send(S2C::EntitySpawn(spawn.clone()));
                }
                // The local player's own entity is included: the client uses
                // last_input_seq for reconciliation of its own position.
                visible.push(snap);
            }

            // Despawns.
            for gone in player.known_entities.difference(&visible_ids) {
                let _ = player.tx.send(S2C::EntityDespawn { id: *gone });
            }
            player.known_entities = visible_ids;

            let _ = player.tx.send(S2C::Snapshot {
                server_tick: self.tick,
                last_input_seq: player.last_input_seq,
                entities: visible.iter().map(|s| (*s).clone()).collect(),
            });
        }
    }

    fn save_all(&mut self) {
        for player in self.players.values_mut() {
            if player.dirty {
                let character = player.character.clone();
                let inventory = player.inventory.clone();
                if let Err(e) = self.store.save_character(&character) {
                    tracing::error!("character save failed: {e}");
                }
                if let Err(e) = self.store.save_inventory(character.id, &inventory) {
                    tracing::error!("inventory save failed: {e}");
                }
                player.dirty = false;
            }
        }
        self.chunks.save_dirty();
        tracing::debug!(
            tick = self.tick,
            players = self.players.len(),
            chunks = self.chunks.loaded_count(),
            "world saved"
        );
    }

    fn persist_player(&self, player: &Player) {
        if let Err(e) = self.store.save_character(&player.character) {
            tracing::error!("character save failed: {e}");
        }
        if let Err(e) = self
            .store
            .save_inventory(player.character.id, &player.inventory)
        {
            tracing::error!("inventory save failed: {e}");
        }
    }
}

/// Starting position for new characters.
pub fn spawn_position() -> Vec3 {
    SPAWN
}
