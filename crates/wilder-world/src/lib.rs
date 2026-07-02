//! The authoritative world simulation.
//!
//! Runs as a single tokio task at TICK_HZ. WebSocket connections talk to it
//! through a command channel; it replies through per-player message channels.

mod chunks;
mod npc;

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use rand::rngs::SmallRng;
use rand::SeedableRng;
use tokio::sync::{mpsc, oneshot};
use wilder_combat::{armor_multiplier, weapon_stats, FIST};
use wilder_inventory as inv;
use wilder_pathfinding::find_path;
use wilder_persistence::{CharacterStore, RocksStore, Stash, WorldStore};
use wilder_physics::{position_clear, step_move, CollisionWorld, RUN_SPEED};
use wilder_protocol::*;
use wilder_replication::{diff_view, view_set};
use wilder_terrain::TerrainGenerator;
use wilder_types::*;

pub use chunks::ChunkCache;
use npc::{npc_spawns_for_chunk, Npc};

pub const TICK_HZ: u32 = 20;
pub const TICK_DT: f32 = 1.0 / TICK_HZ as f32;
/// Persist characters/chunks every this many ticks (10 s).
const SAVE_INTERVAL_TICKS: u64 = 200;
/// Default spawn: on the road corner of chunk (0,0), always walkable.
const SPAWN: Vec3 = Vec3::new(3.0, 0.0, 3.0);
/// Chunks with |x|<=SAFE_RADIUS and |z|<=SAFE_RADIUS are the safe hub.
const SAFE_RADIUS: i32 = 1;
/// Seconds an extraction channel takes.
const EXTRACT_SECONDS: f32 = 5.0;
/// NPC respawn delay after death, seconds.
const NPC_RESPAWN_SECONDS: f32 = 45.0;
/// Loot containers despawn after this long, seconds.
const LOOT_TTL_SECONDS: f32 = 120.0;

pub fn is_safe_chunk(coord: ChunkCoord) -> bool {
    coord.x.abs() <= SAFE_RADIUS && coord.z.abs() <= SAFE_RADIUS
}

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
    stash: Stash,
    tx: mpsc::UnboundedSender<S2C>,
    pending_inputs: Vec<(u32, f32, f32, bool, f32)>, // seq, dx, dz, run, dt
    last_input_seq: u32,
    path: Vec<Vec3>,
    view: HashSet<ChunkCoord>,
    known_entities: HashSet<EntityId>,
    moved_this_tick: bool,
    ran_this_tick: bool,
    attacked_this_tick: bool,
    attack_cooldown: f32,
    /// Active extraction channel: (extraction point entity, seconds left).
    extracting: Option<(EntityId, f32)>,
    dirty: bool,
}

impl Player {
    fn anim(&self) -> AnimState {
        if self.attacked_this_tick {
            AnimState::Attack
        } else if self.moved_this_tick {
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
                (self.character.health / self.character.max_health).max(0.0)
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

struct LootContainer {
    entity: EntityId,
    position: Vec3,
    items: Vec<ItemStack>,
    ttl: f32,
}

struct StaticEntity {
    entity: EntityId,
    kind: EntityKind,
    position: Vec3,
    name: String,
    variant: u32,
}

pub struct World {
    store: Arc<RocksStore>,
    chunks: ChunkCache,
    players: HashMap<EntityId, Player>,
    npcs: HashMap<EntityId, Npc>,
    /// Hostile chunks whose NPCs have already been spawned this session.
    npc_seeded_chunks: HashSet<ChunkCoord>,
    loot: HashMap<EntityId, LootContainer>,
    statics: HashMap<EntityId, StaticEntity>,
    static_seeded_chunks: HashSet<ChunkCoord>,
    next_entity: EntityId,
    tick: u64,
    seed: u64,
    rng: SmallRng,
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
        npcs: HashMap::new(),
        npc_seeded_chunks: HashSet::new(),
        loot: HashMap::new(),
        statics: HashMap::new(),
        static_seeded_chunks: HashSet::new(),
        next_entity: 1,
        tick: 0,
        seed,
        rng: SmallRng::seed_from_u64(seed ^ 0xC0FFEE),
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
            while let Ok(cmd) = self.rx.try_recv() {
                self.handle_cmd(cmd);
            }
            self.step();
        }
    }

    fn alloc_entity(&mut self) -> EntityId {
        let id = self.next_entity;
        self.next_entity += 1;
        id
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
        if self
            .players
            .values()
            .any(|p| p.character.id == character_id)
        {
            return Err("character already in world".into());
        }
        let inventory = self.store.inventory(character_id).unwrap_or_default();
        let stash = self.store.stash(character_id).unwrap_or_else(|_| Stash::new());

        let entity = self.alloc_entity();
        let mut character = character;
        if !position_clear(&self.chunks, character.position.x, character.position.z) {
            character.position = SPAWN;
        }

        let player = Player {
            entity,
            character,
            inventory,
            stash,
            tx: tx.clone(),
            pending_inputs: Vec::new(),
            last_input_seq: 0,
            path: Vec::new(),
            view: HashSet::new(),
            known_entities: HashSet::new(),
            moved_this_tick: false,
            ran_this_tick: false,
            attacked_this_tick: false,
            attack_cooldown: 0.0,
            extracting: None,
            dirty: true,
        };

        let _ = tx.send(S2C::WorldJoined {
            entity_id: entity,
            character: player.character.clone(),
            inventory: player.inventory.clone(),
            server_tick: self.tick,
            world_seed: self.seed,
        });
        let _ = tx.send(S2C::StashUpdate { slots: player.stash.slots.clone() });

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
        match msg {
            C2S::MoveInput { seq, dx, dz, run } => {
                if let Some(player) = self.players.get_mut(&entity) {
                    player.path.clear();
                    player.extracting = None;
                    player.pending_inputs.push((seq, dx, dz, run, TICK_DT));
                }
            }
            C2S::MoveTo { seq, x, z } => {
                let Some(player) = self.players.get_mut(&entity) else { return };
                player.last_input_seq = player.last_input_seq.max(seq);
                player.extracting = None;
                let from = player.character.position;
                match find_path(&self.chunks, from, Vec3::new(x, 0.0, z)) {
                    Some(path) => player.path = path,
                    None => {
                        let _ = player
                            .tx
                            .send(S2C::Error { message: "can't reach that spot".into() });
                    }
                }
            }
            C2S::StopMove { seq } => {
                if let Some(player) = self.players.get_mut(&entity) {
                    player.last_input_seq = player.last_input_seq.max(seq);
                    player.path.clear();
                }
            }
            C2S::Attack { seq, tx, tz } => self.player_attack(entity, seq, tx, tz),
            C2S::Interact { entity_id } => self.interact(entity, entity_id),
            C2S::UseItem { slot } => self.use_item(entity, slot),
            C2S::InventoryAction(action) => self.inventory_action(entity, action),
            C2S::Chat { text } => {
                let text: String = text.chars().take(240).collect();
                if text.trim().is_empty() {
                    return;
                }
                if let Some(rest) = text.strip_prefix('/') {
                    self.dev_command(entity, rest.trim());
                    return;
                }
                let Some(player) = self.players.get(&entity) else { return };
                let from = player.character.name.clone();
                for p in self.players.values() {
                    let _ = p.tx.send(S2C::Chat { from: from.clone(), text: text.clone() });
                }
            }
            C2S::Pong { .. } => {}
            C2S::Authenticate { .. } | C2S::JoinWorld { .. } => {}
            // Phase 2/3 messages: inert for now.
            C2S::Craft { .. } | C2S::QueueProduction { .. } | C2S::Market(_) => {}
        }
    }

    /// Dev-only slash commands (enabled with WILDER_DEV=1): /give <item> [n], /heal, /tp x z
    fn dev_command(&mut self, entity: EntityId, command: &str) {
        let dev = std::env::var("WILDER_DEV").map(|v| v == "1").unwrap_or(false);
        let Some(player) = self.players.get_mut(&entity) else { return };
        if !dev {
            let _ = player.tx.send(S2C::Error { message: "unknown command".into() });
            return;
        }
        let parts: Vec<&str> = command.split_whitespace().collect();
        match parts.as_slice() {
            ["give", item, rest @ ..] => {
                let count: u32 = rest.first().and_then(|n| n.parse().ok()).unwrap_or(1);
                let kind = match item.to_lowercase().as_str() {
                    "pipe" => ItemKind::Pipe,
                    "knife" => ItemKind::Knife,
                    "pistol" => ItemKind::Pistol,
                    "smg" => ItemKind::Smg,
                    "ammo" => ItemKind::Ammo9mm,
                    "medkit" => ItemKind::Medkit,
                    "jacket" => ItemKind::JacketArmor,
                    "plate" => ItemKind::PlateArmor,
                    "iron" => ItemKind::Iron,
                    "copper" => ItemKind::Copper,
                    "chemicals" => ItemKind::Chemicals,
                    "electronics" => ItemKind::Electronics,
                    "biomass" => ItemKind::Biomass,
                    _ => {
                        let _ = player.tx.send(S2C::Error { message: format!("unknown item {item}") });
                        return;
                    }
                };
                inv::add_items(&mut player.inventory.slots, kind, count);
                player.dirty = true;
                let _ = player.tx.send(S2C::InventoryUpdate(player.inventory.clone()));
            }
            ["heal"] => {
                player.character.health = player.character.max_health;
            }
            ["tp", x, z] => {
                if let (Ok(x), Ok(z)) = (x.parse::<f32>(), z.parse::<f32>()) {
                    player.character.position = Vec3::new(x, 0.0, z);
                    player.path.clear();
                    player.dirty = true;
                }
            }
            _ => {
                let _ = player.tx.send(S2C::Error {
                    message: "dev commands: /give <item> [n], /heal, /tp <x> <z>".into(),
                });
            }
        }
    }

    // -----------------------------------------------------------------------
    // Combat & interaction
    // -----------------------------------------------------------------------

    fn player_attack(&mut self, entity: EntityId, seq: u32, tx: f32, tz: f32) {
        let Some(player) = self.players.get_mut(&entity) else { return };
        player.last_input_seq = player.last_input_seq.max(seq);
        if player.attack_cooldown > 0.0 || player.character.health <= 0.0 {
            return;
        }
        let weapon = player.inventory.equipped_weapon;
        let stats = weapon.and_then(weapon_stats).unwrap_or(FIST);

        // Ranged weapons consume ammo.
        if stats.ranged {
            let removed = inv::remove_items(&mut player.inventory.slots, ItemKind::Ammo9mm, 1);
            if removed == 0 {
                let _ = player.tx.send(S2C::Error { message: "out of ammo".into() });
                return;
            }
            let _ = player.tx.send(S2C::InventoryUpdate(player.inventory.clone()));
            player.dirty = true;
        }

        player.attack_cooldown = stats.cooldown;
        player.attacked_this_tick = true;
        let origin = player.character.position;
        let mut dir = Vec3::new(tx - origin.x, 0.0, tz - origin.z);
        if dir.length_squared() < 1e-6 {
            dir = Vec3::new(player.character.yaw.cos(), 0.0, player.character.yaw.sin());
        }
        let dir = dir.normalize();
        player.character.yaw = dir.z.atan2(dir.x);

        let broadcast_flash = stats.ranged;

        // Find the NPC hit.
        let mut hit: Option<(EntityId, f32)> = None;
        if stats.ranged {
            // Hitscan: march the ray; buildings block. Targets are checked
            // before the wall test so enemies hugging a wall are still hittable.
            let mut t = 0.6;
            'ray: while t < stats.range {
                let p = origin + dir * t;
                for npc in self.npcs.values() {
                    if npc.alive() && (npc.position - p).length() < 0.9 {
                        hit = Some((npc.entity, stats.damage));
                        break 'ray;
                    }
                }
                if !self.chunks.walkable(p.x, p.z) {
                    break; // wall
                }
                t += 0.5;
            }
        } else {
            // Melee: nearest alive NPC in range within a generous frontal arc.
            let mut best: Option<(EntityId, f32)> = None;
            for npc in self.npcs.values() {
                if !npc.alive() {
                    continue;
                }
                let to = npc.position - origin;
                let dist = to.length();
                if dist <= stats.range + 0.4 {
                    let facing = to.normalize().dot(dir);
                    if facing > 0.2 && best.map(|(_, d)| dist < d).unwrap_or(true) {
                        best = Some((npc.entity, dist));
                    }
                }
            }
            hit = best.map(|(id, _)| (id, stats.damage));
        }

        let attacker = entity;
        if broadcast_flash {
            self.broadcast_combat(CombatEvent::MuzzleFlash { attacker, tx, tz });
        }
        match hit {
            Some((target, damage)) => {
                self.damage_npc(attacker, target, damage);
            }
            None => {
                self.broadcast_combat(CombatEvent::Miss { attacker });
            }
        }
    }

    fn damage_npc(&mut self, attacker: EntityId, target: EntityId, damage: f32) {
        let died_info = {
            let Some(npc) = self.npcs.get_mut(&target) else { return };
            npc.health -= damage;
            if npc.health <= 0.0 && npc.alive() {
                npc.state = wilder_ai::NpcState::Dead;
                npc.respawn_in = NPC_RESPAWN_SECONDS;
                npc.anim = AnimState::Death;
                Some((npc.position, npc.archetype.variant == 2))
            } else {
                None
            }
        };
        self.broadcast_combat(CombatEvent::Hit { attacker, target, damage });
        if let Some((drop_pos, is_raider)) = died_info {
            self.broadcast_combat(CombatEvent::EntityDied { id: target });

            // Roll loot.
            let mut items: Vec<ItemStack> = Vec::new();
            {
                use rand::Rng;
                let rng = &mut self.rng;
                // Resources always drop (Phase 2 economy feeds on these).
                let table = [
                    ItemKind::Iron,
                    ItemKind::Copper,
                    ItemKind::Biomass,
                    ItemKind::Chemicals,
                    ItemKind::Electronics,
                ];
                let pulls = if is_raider { 3 } else { 2 };
                for _ in 0..pulls {
                    let kind = table[rng.random_range(0..table.len())];
                    items.push(ItemStack { kind, count: rng.random_range(1..4) });
                }
                if rng.random_bool(0.35) {
                    items.push(ItemStack { kind: ItemKind::Ammo9mm, count: rng.random_range(5..15) });
                }
                if rng.random_bool(0.15) {
                    items.push(ItemStack { kind: ItemKind::Medkit, count: 1 });
                }
                if is_raider && rng.random_bool(0.25) {
                    let weapon = if rng.random_bool(0.3) { ItemKind::Pistol } else { ItemKind::Pipe };
                    items.push(ItemStack { kind: weapon, count: 1 });
                }
            }
            self.spawn_loot(drop_pos, items);
        }
    }

    fn spawn_loot(&mut self, position: Vec3, items: Vec<ItemStack>) {
        if items.is_empty() {
            return;
        }
        let entity = self.alloc_entity();
        self.loot.insert(
            entity,
            LootContainer { entity, position, items, ttl: LOOT_TTL_SECONDS },
        );
    }

    fn interact(&mut self, entity: EntityId, target: EntityId) {
        // Loot container?
        if let Some(container) = self.loot.get_mut(&target) {
            let Some(player) = self.players.get_mut(&entity) else { return };
            if (container.position - player.character.position).length() > 3.0 {
                let _ = player.tx.send(S2C::Error { message: "too far away".into() });
                return;
            }
            let mut leftovers = Vec::new();
            for stack in container.items.drain(..) {
                let rem = inv::add_items(&mut player.inventory.slots, stack.kind, stack.count);
                if rem > 0 {
                    leftovers.push(ItemStack { kind: stack.kind, count: rem });
                }
            }
            container.items = leftovers;
            player.dirty = true;
            let _ = player.tx.send(S2C::InventoryUpdate(player.inventory.clone()));
            let _ = player.tx.send(S2C::GatherResult { gained: None });
            if container.items.is_empty() {
                self.loot.remove(&target);
            }
            return;
        }

        // Static entity (extraction point / stash terminal)?
        let Some(static_entity) = self.statics.get(&target) else { return };
        let kind = static_entity.kind;
        let pos = static_entity.position;
        let Some(player) = self.players.get_mut(&entity) else { return };
        if (pos - player.character.position).length() > 3.5 {
            let _ = player.tx.send(S2C::Error { message: "too far away".into() });
            return;
        }
        match kind {
            EntityKind::ExtractionPoint => {
                player.path.clear();
                player.extracting = Some((target, EXTRACT_SECONDS));
                let _ = player.tx.send(S2C::ExtractStart { seconds: EXTRACT_SECONDS });
            }
            EntityKind::Building => {
                // Stash terminal: just push current stash state (opens the UI).
                let _ = player.tx.send(S2C::StashUpdate { slots: player.stash.slots.clone() });
            }
            _ => {}
        }
    }

    fn use_item(&mut self, entity: EntityId, slot: u16) {
        let Some(player) = self.players.get_mut(&entity) else { return };
        let Some(stack) = player.inventory.slots.get(slot as usize).copied().flatten() else {
            return;
        };
        if stack.kind == ItemKind::Medkit && player.character.health < player.character.max_health {
            inv::remove_items(&mut player.inventory.slots[slot as usize..slot as usize + 1], ItemKind::Medkit, 1);
            player.character.health =
                (player.character.health + 50.0).min(player.character.max_health);
            player.dirty = true;
            let _ = player.tx.send(S2C::InventoryUpdate(player.inventory.clone()));
        }
    }

    fn inventory_action(&mut self, entity: EntityId, action: InventoryAction) {
        let near_stash = self.near_stash_terminal(entity);
        let Some(player) = self.players.get_mut(&entity) else { return };
        match action {
            InventoryAction::MoveSlot { from, to } => {
                inv::move_slot(&mut player.inventory.slots, from as usize, to as usize);
            }
            InventoryAction::Equip { slot } => {
                inv::equip(&mut player.inventory, slot as usize);
            }
            InventoryAction::Unequip { weapon } => {
                inv::unequip(&mut player.inventory, weapon);
            }
            InventoryAction::Drop { slot } => {
                if let Some(s) = player.inventory.slots.get_mut(slot as usize) {
                    if let Some(stack) = s.take() {
                        let pos = player.character.position;
                        let items = vec![stack];
                        // Defer loot spawn until after borrow ends.
                        let _ = player.tx.send(S2C::InventoryUpdate(player.inventory.clone()));
                        player.dirty = true;
                        self.spawn_loot(pos, items);
                        return;
                    }
                }
            }
            InventoryAction::Deposit { slot } => {
                if !near_stash {
                    let _ = player.tx.send(S2C::Error { message: "no stash terminal nearby".into() });
                    return;
                }
                if let Some(s) = player.inventory.slots.get_mut(slot as usize) {
                    if let Some(stack) = s.take() {
                        let rem = inv::add_items(&mut player.stash.slots, stack.kind, stack.count);
                        if rem > 0 {
                            *s = Some(ItemStack { kind: stack.kind, count: rem });
                        }
                    }
                }
                let _ = player.tx.send(S2C::StashUpdate { slots: player.stash.slots.clone() });
            }
            InventoryAction::Withdraw { stash_slot } => {
                if !near_stash {
                    let _ = player.tx.send(S2C::Error { message: "no stash terminal nearby".into() });
                    return;
                }
                if let Some(s) = player.stash.slots.get_mut(stash_slot as usize) {
                    if let Some(stack) = s.take() {
                        let rem = inv::add_items(&mut player.inventory.slots, stack.kind, stack.count);
                        if rem > 0 {
                            *s = Some(ItemStack { kind: stack.kind, count: rem });
                        }
                    }
                }
                let _ = player.tx.send(S2C::StashUpdate { slots: player.stash.slots.clone() });
            }
        }
        player.dirty = true;
        let _ = player.tx.send(S2C::InventoryUpdate(player.inventory.clone()));
    }

    fn near_stash_terminal(&self, entity: EntityId) -> bool {
        let Some(player) = self.players.get(&entity) else { return false };
        self.statics.values().any(|s| {
            s.kind == EntityKind::Building
                && (s.position - player.character.position).length() < 3.5
        })
    }

    // -----------------------------------------------------------------------
    // Tick systems
    // -----------------------------------------------------------------------

    fn step(&mut self) {
        self.tick += 1;

        self.apply_movement();
        self.tick_extraction();
        self.tick_npcs();
        self.tick_loot();
        self.tick_regen();
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
            player.attacked_this_tick = false;
            player.attack_cooldown = (player.attack_cooldown - TICK_DT).max(0.0);
            if player.character.health <= 0.0 {
                continue;
            }
            let before = player.character.position;

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

    fn tick_extraction(&mut self) {
        let mut completed: Vec<EntityId> = Vec::new();
        for player in self.players.values_mut() {
            let Some((point, remaining)) = player.extracting.as_mut() else { continue };
            // Cancel if the player wandered off.
            let point_pos = self.statics.get(point).map(|s| s.position);
            let near = point_pos
                .map(|p| (p - player.character.position).length() < 4.0)
                .unwrap_or(false);
            if !near || player.moved_this_tick {
                player.extracting = None;
                let _ = player.tx.send(S2C::ExtractCancel);
                continue;
            }
            *remaining -= TICK_DT;
            if *remaining <= 0.0 {
                completed.push(player.entity);
            }
        }
        for entity in completed {
            let Some(player) = self.players.get_mut(&entity) else { continue };
            player.extracting = None;
            // Bank everything carried into the stash.
            let mut banked: Vec<ItemStack> = Vec::new();
            for slot in player.inventory.slots.iter_mut() {
                if let Some(stack) = slot.take() {
                    let rem = inv::add_items(&mut player.stash.slots, stack.kind, stack.count);
                    let banked_count = stack.count - rem;
                    if banked_count > 0 {
                        banked.push(ItemStack { kind: stack.kind, count: banked_count });
                    }
                    if rem > 0 {
                        *slot = Some(ItemStack { kind: stack.kind, count: rem });
                    }
                }
            }
            // Return to the hub.
            player.character.position = SPAWN;
            player.character.health = player.character.max_health;
            player.path.clear();
            player.dirty = true;
            let _ = player.tx.send(S2C::ExtractResult { success: true, banked });
            let _ = player.tx.send(S2C::InventoryUpdate(player.inventory.clone()));
            let _ = player.tx.send(S2C::StashUpdate { slots: player.stash.slots.clone() });
            self.persist_player_entity(entity);
        }
    }

    fn tick_npcs(&mut self) {
        // Respawns and AI.
        let player_positions: Vec<(EntityId, Vec3)> = self
            .players
            .values()
            .filter(|p| p.character.health > 0.0)
            .map(|p| (p.entity, p.character.position))
            .collect();

        let mut attacks: Vec<(EntityId, EntityId, f32)> = Vec::new(); // (npc, player, dmg)
        for npc in self.npcs.values_mut() {
            if !npc.alive() {
                npc.respawn_in -= TICK_DT;
                if npc.respawn_in <= 0.0 {
                    npc.health = npc.archetype.max_health;
                    npc.state = wilder_ai::NpcState::Patrol;
                    npc.position = npc.home;
                    npc.anim = AnimState::Idle;
                }
                continue;
            }
            // Only tick NPCs near any player (cheap interest gating).
            let near_player = player_positions
                .iter()
                .any(|(_, p)| (*p - npc.position).length() < 80.0);
            if !near_player {
                continue;
            }
            if let Some((target, damage)) = npc.tick(&self.chunks, &player_positions, &mut self.rng)
            {
                attacks.push((npc.entity, target, damage));
            }
        }

        for (npc_entity, player_entity, damage) in attacks {
            self.damage_player(npc_entity, player_entity, damage);
        }
    }

    fn damage_player(&mut self, attacker: EntityId, target: EntityId, damage: f32) {
        let Some(player) = self.players.get_mut(&target) else { return };
        if player.character.health <= 0.0 {
            return;
        }
        let mult = armor_multiplier(player.inventory.equipped_armor);
        let dealt = damage * mult;
        player.character.health -= dealt;
        self.broadcast_combat(CombatEvent::Hit { attacker, target, damage: dealt });

        if self.players[&target].character.health <= 0.0 {
            self.kill_player(attacker, target);
        }
    }

    fn kill_player(&mut self, killer: EntityId, target: EntityId) {
        let killer_name = self
            .npcs
            .get(&killer)
            .map(|n| n.archetype.name.to_string())
            .or_else(|| self.players.get(&killer).map(|p| p.character.name.clone()));
        let Some(player) = self.players.get_mut(&target) else { return };

        // Death: drop carried items where you fell.
        let drop_pos = player.character.position;
        let mut dropped: Vec<ItemStack> = Vec::new();
        for slot in player.inventory.slots.iter_mut() {
            if let Some(stack) = slot.take() {
                dropped.push(stack);
            }
        }
        // Equipped gear survives (jacket stays on your back).
        player.extracting = None;
        player.path.clear();
        player.character.health = player.character.max_health;
        player.character.position = SPAWN;
        player.dirty = true;
        let lost = !dropped.is_empty();
        let _ = player.tx.send(S2C::Died { by: killer_name, lost_items: lost });
        let _ = player.tx.send(S2C::InventoryUpdate(player.inventory.clone()));
        let entity = player.entity;
        self.broadcast_combat(CombatEvent::EntityDied { id: entity });
        self.spawn_loot(drop_pos, dropped);
        self.persist_player_entity(target);
    }

    fn tick_loot(&mut self) {
        let mut expired = Vec::new();
        for container in self.loot.values_mut() {
            container.ttl -= TICK_DT;
            if container.ttl <= 0.0 {
                expired.push(container.entity);
            }
        }
        for id in expired {
            self.loot.remove(&id);
        }
    }

    fn tick_regen(&mut self) {
        for player in self.players.values_mut() {
            let coord = ChunkCoord::from_world(player.character.position);
            if is_safe_chunk(coord) && player.character.health < player.character.max_health {
                player.character.health =
                    (player.character.health + 2.0 * TICK_DT).min(player.character.max_health);
            }
        }
    }

    fn broadcast_combat(&self, event: CombatEvent) {
        for player in self.players.values() {
            let _ = player.tx.send(S2C::CombatEvent(event.clone()));
        }
    }

    // -----------------------------------------------------------------------
    // Streaming / replication
    // -----------------------------------------------------------------------

    fn seed_chunk_content(&mut self, coord: ChunkCoord) {
        // NPCs in hostile chunks.
        if !is_safe_chunk(coord) && !self.npc_seeded_chunks.contains(&coord) {
            self.npc_seeded_chunks.insert(coord);
            let chunk = self.chunks.get(coord);
            for (archetype, pos) in npc_spawns_for_chunk(coord, &chunk) {
                let entity = self.alloc_entity();
                self.npcs.insert(entity, Npc::new(entity, archetype, pos));
            }
        }
        // Static entities: extraction points + hub stash terminal.
        if !self.static_seeded_chunks.contains(&coord) {
            self.static_seeded_chunks.insert(coord);
            if coord.x == 0 && coord.z == 0 {
                let entity = self.alloc_entity();
                self.statics.insert(
                    entity,
                    StaticEntity {
                        entity,
                        kind: EntityKind::Building,
                        position: Vec3::new(9.0, 0.0, 3.0),
                        name: "Stash Terminal".into(),
                        variant: 0,
                    },
                );
            }
            let h = (coord.x.wrapping_mul(2654435761u32 as i32)
                ^ coord.z.wrapping_mul(40503)) as u32;
            if !is_safe_chunk(coord) && h % 5 == 0 {
                // Find a walkable spot for the extraction beacon.
                let chunk = self.chunks.get(coord);
                'find: for tz in (2..TILES_PER_CHUNK).step_by(3) {
                    for tx in (2..TILES_PER_CHUNK).step_by(3) {
                        if chunk.tile(tx, tz).walkable() {
                            let entity = self.alloc_entity();
                            self.statics.insert(
                                entity,
                                StaticEntity {
                                    entity,
                                    kind: EntityKind::ExtractionPoint,
                                    position: Vec3::new(
                                        coord.x as f32 * CHUNK_SIZE + (tx as f32 + 0.5) * TILE_SIZE,
                                        0.0,
                                        coord.z as f32 * CHUNK_SIZE + (tz as f32 + 0.5) * TILE_SIZE,
                                    ),
                                    name: "Extraction Point".into(),
                                    variant: 0,
                                },
                            );
                            break 'find;
                        }
                    }
                }
            }
        }
    }

    fn update_interest(&mut self) {
        let mut all_needed: HashSet<ChunkCoord> = HashSet::new();
        let mut newly_seen: Vec<ChunkCoord> = Vec::new();
        for player in self.players.values_mut() {
            let center = ChunkCoord::from_world(player.character.position);
            let new_view = view_set(center);
            if new_view != player.view {
                let (entered, exited) = diff_view(&player.view, &new_view);
                for coord in entered {
                    let chunk = self.chunks.get(coord);
                    let _ = player.tx.send(S2C::ChunkData(chunk));
                    newly_seen.push(coord);
                }
                for coord in exited {
                    let _ = player.tx.send(S2C::ChunkUnload { coord });
                }
                player.view = new_view;
            }
            all_needed.extend(player.view.iter().copied());
        }
        for coord in newly_seen {
            self.seed_chunk_content(coord);
        }
        if self.tick % 100 == 0 {
            self.chunks.evict_except(&all_needed);
        }
    }

    fn replicate(&mut self) {
        struct Replicated {
            id: EntityId,
            chunk: ChunkCoord,
            spawn: EntitySpawnData,
            snap: EntitySnapshot,
        }

        let mut all: Vec<Replicated> = Vec::new();
        for p in self.players.values() {
            all.push(Replicated {
                id: p.entity,
                chunk: ChunkCoord::from_world(p.character.position),
                spawn: p.spawn_data(),
                snap: p.snapshot(),
            });
        }
        for npc in self.npcs.values() {
            if !npc.alive() {
                continue;
            }
            all.push(Replicated {
                id: npc.entity,
                chunk: ChunkCoord::from_world(npc.position),
                spawn: npc.spawn_data(),
                snap: npc.snapshot(),
            });
        }
        for container in self.loot.values() {
            all.push(Replicated {
                id: container.entity,
                chunk: ChunkCoord::from_world(container.position),
                spawn: EntitySpawnData {
                    id: container.entity,
                    kind: EntityKind::LootContainer,
                    name: "Loot".into(),
                    appearance: Appearance::default(),
                    position: container.position,
                    yaw: 0.0,
                    anim: AnimState::Idle,
                    health_pct: 1.0,
                    variant: 0,
                },
                snap: EntitySnapshot {
                    id: container.entity,
                    position: container.position,
                    yaw: 0.0,
                    anim: AnimState::Idle,
                    health_pct: 1.0,
                },
            });
        }
        for s in self.statics.values() {
            all.push(Replicated {
                id: s.entity,
                chunk: ChunkCoord::from_world(s.position),
                spawn: EntitySpawnData {
                    id: s.entity,
                    kind: s.kind,
                    name: s.name.clone(),
                    appearance: Appearance::default(),
                    position: s.position,
                    yaw: 0.0,
                    anim: AnimState::Idle,
                    health_pct: 1.0,
                    variant: s.variant,
                },
                snap: EntitySnapshot {
                    id: s.entity,
                    position: s.position,
                    yaw: 0.0,
                    anim: AnimState::Idle,
                    health_pct: 1.0,
                },
            });
        }

        for player in self.players.values_mut() {
            let mut visible: Vec<EntitySnapshot> = Vec::new();
            let mut visible_ids: HashSet<EntityId> = HashSet::new();

            for r in &all {
                if !player.view.contains(&r.chunk) {
                    continue;
                }
                visible_ids.insert(r.id);
                if !player.known_entities.contains(&r.id) {
                    let _ = player.tx.send(S2C::EntitySpawn(r.spawn.clone()));
                }
                visible.push(r.snap.clone());
            }

            for gone in player.known_entities.difference(&visible_ids) {
                let _ = player.tx.send(S2C::EntityDespawn { id: *gone });
            }
            player.known_entities = visible_ids;

            let _ = player.tx.send(S2C::Snapshot {
                server_tick: self.tick,
                last_input_seq: player.last_input_seq,
                entities: visible,
            });
        }
    }

    // -----------------------------------------------------------------------
    // Persistence
    // -----------------------------------------------------------------------

    fn save_all(&mut self) {
        for player in self.players.values_mut() {
            if player.dirty {
                if let Err(e) = self.store.save_character(&player.character) {
                    tracing::error!("character save failed: {e}");
                }
                if let Err(e) = self
                    .store
                    .save_inventory(player.character.id, &player.inventory)
                {
                    tracing::error!("inventory save failed: {e}");
                }
                if let Err(e) = self.store.save_stash(player.character.id, &player.stash) {
                    tracing::error!("stash save failed: {e}");
                }
                player.dirty = false;
            }
        }
        self.chunks.save_dirty();
        tracing::debug!(
            tick = self.tick,
            players = self.players.len(),
            npcs = self.npcs.len(),
            chunks = self.chunks.loaded_count(),
            "world saved"
        );
    }

    fn persist_player_entity(&self, entity: EntityId) {
        if let Some(player) = self.players.get(&entity) {
            self.persist_player(player);
        }
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
        if let Err(e) = self.store.save_stash(player.character.id, &player.stash) {
            tracing::error!("stash save failed: {e}");
        }
    }
}

/// Starting position for new characters.
pub fn spawn_position() -> Vec3 {
    SPAWN
}
