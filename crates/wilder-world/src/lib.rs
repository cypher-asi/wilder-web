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
use wilder_combat::{
    ability_stats, armor_multiplier, armor_shield, weapon_stats, FIST, OVERCHARGE_MULT,
    SHIELD_REGEN_DELAY, SHIELD_REGEN_RATE, SHOCKWAVE_DAMAGE, SHOCKWAVE_KNOCKBACK,
    SHOCKWAVE_RADIUS, STIM_HEAL, STIM_SPEED_DURATION, STIM_SPEED_MULT,
};
use wilder_inventory as inv;
use wilder_pathfinding::find_path;
use wilder_persistence::{CharacterStore, RocksStore, Stash, WorldStore};
use wilder_physics::{
    position_clear, step_move, step_move_speed, CollisionWorld, CROUCH_SPEED, ROLL_COOLDOWN,
    ROLL_DURATION, ROLL_SPEED, RUN_SPEED,
};
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
/// Resource node: gathers before depletion, respawn delay, per-gather cooldown.
const NODE_CHARGES: u32 = 5;
const NODE_RESPAWN_SECONDS: f32 = 60.0;
const NODE_GATHER_COOLDOWN: f32 = 1.2;
/// Chance for a blueprint fragment to drop from NPC kills / node gathers.
const FRAGMENT_CHANCE: f64 = 0.10;
/// Global hub power budget (kW) shared by all production jobs.
const POWER_BUDGET: f32 = 100.0;
/// Market fee (percent) burned on every sale.
const MARKET_FEE_PCT: u32 = 5;
/// WILD granted to every account once.
const WALLET_GRANT: u32 = 200;
/// Recipes every character knows from the start; the rest need lab research.
const DEFAULT_BLUEPRINTS: &[&str] =
    &["steel_plate", "copper_wire", "pipe", "knife", "ammo_9mm", "medkit"];
/// Research cost: fragments + resources consumed to unlock any blueprint.
const RESEARCH_FRAGMENTS: u32 = 2;
const RESEARCH_RESOURCES: &[(ItemKind, u32)] =
    &[(ItemKind::Electronics, 5), (ItemKind::Chemicals, 5)];
/// XP granted per NPC kill.
const XP_SCAV_KILL: u32 = 25;
const XP_RAIDER_KILL: u32 = 50;

/// XP needed to advance from `level` to `level + 1`.
fn xp_for_level(level: u32) -> u32 {
    level * 100
}

fn station_power(station: wilder_crafting::Station) -> f32 {
    match station {
        wilder_crafting::Station::Refinery => 10.0,
        wilder_crafting::Station::Factory => 20.0,
        wilder_crafting::Station::Laboratory => 30.0,
    }
}

pub fn is_safe_chunk(coord: ChunkCoord) -> bool {
    coord.x.abs() <= SAFE_RADIUS && coord.z.abs() <= SAFE_RADIUS
}

/// Walkable spots for the hub stations in the spawn chunk: prefer sidewalk /
/// plaza tiles (off the road), keep spots at least 2 tiles apart, and stay
/// close to spawn.
fn hub_spots(chunk: &ChunkData, count: usize) -> Vec<Vec3> {
    let spawn_tx = (SPAWN.x / TILE_SIZE) as i32;
    let spawn_tz = (SPAWN.z / TILE_SIZE) as i32;
    let mut candidates: Vec<(i32, usize, usize)> = Vec::new();
    for tz in 0..TILES_PER_CHUNK {
        for tx in 0..TILES_PER_CHUNK {
            let kind = chunk.tile(tx, tz);
            if !kind.walkable() {
                continue;
            }
            let d = (tx as i32 - spawn_tx).abs().max((tz as i32 - spawn_tz).abs());
            if d < 2 {
                continue; // keep the spawn tile itself clear
            }
            // Prefer off-road tiles; road tiles rank behind everything else.
            let penalty = if matches!(kind, TileKind::Road | TileKind::RoadLine) { 100 } else { 0 };
            candidates.push((d + penalty, tx, tz));
        }
    }
    candidates.sort();
    let mut spots: Vec<(usize, usize)> = Vec::new();
    for &(_, tx, tz) in &candidates {
        if spots.len() >= count {
            break;
        }
        if spots
            .iter()
            .all(|&(sx, sz)| (sx as i32 - tx as i32).abs() + (sz as i32 - tz as i32).abs() >= 2)
        {
            spots.push((tx, tz));
        }
    }
    spots
        .into_iter()
        .map(|(tx, tz)| {
            Vec3::new((tx as f32 + 0.5) * TILE_SIZE, 0.0, (tz as f32 + 0.5) * TILE_SIZE)
        })
        .collect()
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
    pending_inputs: Vec<(u32, f32, f32, f32, bool, f32)>, // seq, dx, dz, yaw, run, dt
    last_input_seq: u32,
    path: Vec<Vec3>,
    view: HashSet<ChunkCoord>,
    known_entities: HashSet<EntityId>,
    moved_this_tick: bool,
    ran_this_tick: bool,
    attacked_this_tick: bool,
    attack_cooldown: f32,
    /// Crouch toggle: slower movement + crouch anims until cleared.
    crouching: bool,
    /// Dodge roll dash: seconds left + normalized XZ direction.
    roll_time: f32,
    roll_dir: (f32, f32),
    roll_cooldown: f32,
    /// Seconds until shield regen resumes (reset on damage taken).
    shield_delay: f32,
    /// Ability cooldowns, indexed by `AbilityKind::index()`.
    ability_cooldowns: [f32; 3],
    /// Stim: healing left to apply + speed boost seconds left.
    stim_heal_left: f32,
    stim_speed_time: f32,
    /// Overcharge: weapon damage multiplier seconds left.
    overcharge_time: f32,
    /// Active extraction channel: (extraction point entity, seconds left).
    extracting: Option<(EntityId, f32)>,
    /// Known blueprint recipe ids.
    blueprints: HashSet<String>,
    /// Production queues per building entity (personal queues, Phase 3).
    production: HashMap<EntityId, Vec<ProductionJobState>>,
    /// Cached account wallet (write-through to the store).
    wallet: u32,
    dirty: bool,
}

struct ProductionJobState {
    id: u64,
    recipe: &'static wilder_crafting::Recipe,
    count: u32,
    done: u32,
    remaining: f32,
    powered: bool,
}

impl ProductionJobState {
    fn to_wire(&self) -> ProductionJob {
        ProductionJob {
            id: self.id,
            recipe: self.recipe.id.to_string(),
            count: self.count,
            done: self.done,
            remaining: self.remaining,
            powered: self.powered,
        }
    }
}

impl Player {
    fn anim(&self) -> AnimState {
        if self.roll_time > 0.0 {
            AnimState::Roll
        } else if self.moved_this_tick {
            // Movement wins: clients layer the shot on the upper body, so a
            // running shooter keeps running instead of freezing mid-stride.
            if self.crouching {
                AnimState::CrouchWalk
            } else if self.ran_this_tick {
                AnimState::Run
            } else {
                AnimState::Walk
            }
        } else if self.attacked_this_tick {
            AnimState::Attack
        } else if self.crouching {
            AnimState::Crouch
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
            shield_pct: if self.character.max_shield > 0.0 {
                (self.character.shield / self.character.max_shield).max(0.0)
            } else {
                0.0
            },
        }
    }

    /// Recompute shield capacity from equipped armor and clamp the current
    /// value. Called on join and whenever armor changes.
    fn sync_shield(&mut self) {
        self.character.max_shield = armor_shield(self.inventory.equipped_armor);
        self.character.shield = self.character.shield.clamp(0.0, self.character.max_shield);
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

struct ResourceNode {
    entity: EntityId,
    position: Vec3,
    /// Resource variant (indexes wilder_economy::RESOURCES).
    variant: u32,
    charges: u32,
    /// Seconds until the node respawns once depleted (0 = active).
    respawn_in: f32,
    /// Seconds until it can be gathered again.
    cooldown: f32,
}

impl ResourceNode {
    fn active(&self) -> bool {
        self.charges > 0
    }
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
    nodes: HashMap<EntityId, ResourceNode>,
    static_seeded_chunks: HashSet<ChunkCoord>,
    next_entity: EntityId,
    tick: u64,
    seed: u64,
    rng: SmallRng,
    rx: mpsc::UnboundedReceiver<WorldCmd>,
    /// Market listings (persisted in world meta).
    market: Vec<wilder_market::Listing>,
    next_listing_id: u64,
    next_job_id: u64,
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

    let market: Vec<wilder_market::Listing> =
        store.meta("market_listings").ok().flatten().unwrap_or_default();
    let next_listing_id: u64 = store.meta("market_next_id").ok().flatten().unwrap_or(1);

    let (tx, rx) = mpsc::unbounded_channel();
    let world = World {
        store: store.clone(),
        chunks: ChunkCache::new(TerrainGenerator::new(seed), store),
        market,
        next_listing_id,
        next_job_id: 1,
        players: HashMap::new(),
        npcs: HashMap::new(),
        npc_seeded_chunks: HashSet::new(),
        loot: HashMap::new(),
        statics: HashMap::new(),
        nodes: HashMap::new(),
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

        // Blueprints: defaults are always known.
        let mut blueprints: HashSet<String> = self
            .store
            .blueprints(character_id)
            .unwrap_or_default()
            .into_iter()
            .collect();
        for id in DEFAULT_BLUEPRINTS {
            blueprints.insert((*id).to_string());
        }

        // One-time WILD grant per account (tracked in world meta).
        let mut wallet = self
            .store
            .account_by_id(account)
            .map(|a| a.wallet)
            .unwrap_or(0);
        let grant_key = format!("wallet_granted_{account}");
        let granted: bool = self.store.meta(&grant_key).ok().flatten().unwrap_or(false);
        if !granted {
            wallet += WALLET_GRANT;
            let _ = self.store.update_wallet(account, wallet);
            let _ = self.store.save_meta(&grant_key, &true);
        }

        let entity = self.alloc_entity();
        let mut character = character;
        if !position_clear(&self.chunks, character.position.x, character.position.z) {
            character.position = SPAWN;
        }

        let mut player = Player {
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
            crouching: false,
            roll_time: 0.0,
            roll_dir: (1.0, 0.0),
            roll_cooldown: 0.0,
            shield_delay: 0.0,
            ability_cooldowns: [0.0; 3],
            stim_heal_left: 0.0,
            stim_speed_time: 0.0,
            overcharge_time: 0.0,
            extracting: None,
            blueprints,
            production: HashMap::new(),
            wallet,
            dirty: true,
        };
        player.sync_shield();
        // Spawn in with a full shield (capacity comes from equipped armor).
        player.character.shield = player.character.max_shield;

        let _ = tx.send(S2C::WorldJoined {
            entity_id: entity,
            character: player.character.clone(),
            inventory: player.inventory.clone(),
            server_tick: self.tick,
            world_seed: self.seed,
        });
        let _ = tx.send(S2C::StashUpdate { slots: player.stash.slots.clone() });
        let _ = tx.send(S2C::XpUpdate {
            xp: player.character.xp,
            level: player.character.level,
            next_level_xp: xp_for_level(player.character.level),
            gained: 0,
        });
        let _ = tx.send(S2C::BlueprintsUpdate {
            known: player.blueprints.iter().cloned().collect(),
        });
        for ability in AbilityKind::ALL {
            let _ = tx.send(S2C::AbilityUpdate { ability, cooldown: 0.0, active: 0.0 });
        }

        self.players.insert(entity, player);
        tracing::info!(entity, "player joined");
        Ok(entity)
    }

    fn leave(&mut self, entity: EntityId) {
        if let Some(mut player) = self.players.remove(&entity) {
            // Refund inputs for unfinished production so items aren't lost
            // (queues are in-memory; jobs only run while the player is online).
            let queues = std::mem::take(&mut player.production);
            for jobs in queues.into_values() {
                for job in jobs {
                    let pending = job.count - job.done;
                    for &(kind, count) in job.recipe.inputs {
                        let refund = count * pending;
                        let leftover = inv::add_items(&mut player.inventory.slots, kind, refund);
                        if leftover > 0 {
                            inv::add_items(&mut player.stash.slots, kind, leftover);
                        }
                    }
                }
            }
            self.persist_player(&player);
            tracing::info!(entity, name = %player.character.name, "player left");
        }
    }

    fn handle_msg(&mut self, entity: EntityId, msg: C2S) {
        match msg {
            C2S::MoveInput { seq, dx, dz, yaw, run } => {
                if let Some(player) = self.players.get_mut(&entity) {
                    player.path.clear();
                    player.extracting = None;
                    player.pending_inputs.push((seq, dx, dz, yaw, run, TICK_DT));
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
            C2S::Roll { seq, dx, dz } => {
                if let Some(player) = self.players.get_mut(&entity) {
                    player.last_input_seq = player.last_input_seq.max(seq);
                    let len = (dx * dx + dz * dz).sqrt();
                    if player.character.health <= 0.0
                        || player.roll_time > 0.0
                        || player.roll_cooldown > 0.0
                        || len < 1e-3
                    {
                        return;
                    }
                    player.path.clear();
                    player.extracting = None;
                    player.crouching = false;
                    player.roll_time = ROLL_DURATION;
                    player.roll_dir = (dx / len, dz / len);
                    player.roll_cooldown = ROLL_COOLDOWN;
                    player.character.yaw = dz.atan2(dx);
                }
            }
            C2S::SetCrouch { on } => {
                if let Some(player) = self.players.get_mut(&entity) {
                    if player.roll_time <= 0.0 {
                        player.crouching = on;
                        player.dirty = true;
                    }
                }
            }
            C2S::Attack { seq, tx, tz } => self.player_attack(entity, seq, tx, tz),
            C2S::UseAbility { seq, ability } => self.use_ability(entity, seq, ability),
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
            C2S::Craft { recipe, station } => self.craft(entity, &recipe, station),
            C2S::QueueProduction { building, recipe, count } => {
                self.queue_production(entity, building, &recipe, count)
            }
            C2S::Market(action) => self.market_action(entity, action),
            C2S::Pong { .. } => {}
            C2S::Authenticate { .. } | C2S::JoinWorld { .. } => {}
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
                    "steel" => ItemKind::SteelPlate,
                    "wire" => ItemKind::CopperWire,
                    "polymer" => ItemKind::Polymer,
                    "circuit" => ItemKind::CircuitBoard,
                    "biogel" => ItemKind::BioGel,
                    "fragment" => ItemKind::BlueprintFragment,
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
                player.character.shield = player.character.max_shield;
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
        // One-tick tolerance: the client paces shots at exactly the weapon
        // cooldown while the server decrements it in whole ticks, so without
        // slack roughly half of a held-trigger's shots would arrive a few ms
        // "early" and be silently dropped. The remainder is carried over
        // below so the long-run fire rate still matches the weapon exactly.
        if player.attack_cooldown > TICK_DT || player.character.health <= 0.0 {
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

        // Carry any residual cooldown so the tolerance can't raise the
        // effective fire rate above the weapon's.
        player.attack_cooldown = stats.cooldown + player.attack_cooldown.max(0.0);
        player.attacked_this_tick = true;
        let damage_mult = if player.overcharge_time > 0.0 { OVERCHARGE_MULT } else { 1.0 };
        let attack_damage = stats.damage * damage_mult;
        let origin = player.character.position;
        let mut dir = Vec3::new(tx - origin.x, 0.0, tz - origin.z);
        if dir.length_squared() < 1e-6 {
            dir = Vec3::new(player.character.yaw.cos(), 0.0, player.character.yaw.sin());
        }
        let dir = dir.normalize();
        player.character.yaw = dir.z.atan2(dir.x);

        let broadcast_flash = stats.ranged;

        // Find the NPC hit, tracking where the attack terminated (impact,
        // blocking wall, or max range) for client VFX.
        let mut hit: Option<(EntityId, f32)> = None;
        let mut end = origin + dir * stats.range;
        if stats.ranged {
            // Hitscan: analytic ray-vs-target test (nearest NPC within a
            // cylinder around the ray), so hits don't depend on sampling
            // luck against moving targets.
            const HIT_RADIUS: f32 = 0.9;
            let mut best_t = f32::INFINITY;
            for npc in self.npcs.values() {
                if !npc.alive() {
                    continue;
                }
                let to = npc.position - origin;
                let along = to.dot(dir);
                if along < 0.3 || along > stats.range + HIT_RADIUS {
                    continue;
                }
                let perp = (to - dir * along).length();
                if perp < HIT_RADIUS && along < best_t {
                    best_t = along;
                    hit = Some((npc.entity, attack_damage));
                    end = npc.position;
                }
            }
            // Walls block the shot, but with slack near the target so
            // enemies hugging a wall are still hittable.
            let limit = if best_t.is_finite() { best_t } else { stats.range };
            let mut t = 0.6;
            while t < limit {
                let p = origin + dir * t;
                if !self.chunks.walkable(p.x, p.z) {
                    if t < best_t - HIT_RADIUS {
                        hit = None;
                        end = p; // wall before the target
                    }
                    break;
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
                        end = npc.position;
                    }
                }
            }
            hit = best.map(|(id, _)| (id, attack_damage));
        }

        let attacker = entity;
        if broadcast_flash {
            self.broadcast_combat(CombatEvent::MuzzleFlash { attacker, tx: end.x, tz: end.z });
        }
        match hit {
            Some((target, damage)) => {
                let impact = Vec3::new(end.x, 1.25, end.z);
                self.damage_npc(attacker, target, damage, impact);
            }
            None => {
                self.broadcast_combat(CombatEvent::Miss { attacker, x: end.x, z: end.z });
            }
        }
    }

    fn use_ability(&mut self, entity: EntityId, seq: u32, ability: AbilityKind) {
        let Some(player) = self.players.get_mut(&entity) else { return };
        player.last_input_seq = player.last_input_seq.max(seq);
        if player.character.health <= 0.0 {
            return;
        }
        let idx = ability.index();
        if player.ability_cooldowns[idx] > 0.0 {
            return;
        }
        let stats = ability_stats(ability);
        player.ability_cooldowns[idx] = stats.cooldown;
        let origin = player.character.position;

        match ability {
            AbilityKind::Shockwave => {
                self.broadcast_combat(CombatEvent::Shockwave { source: entity });
                // Knock nearby NPCs back, then apply damage.
                let mut targets: Vec<EntityId> = Vec::new();
                for npc in self.npcs.values_mut() {
                    if !npc.alive() {
                        continue;
                    }
                    let to = npc.position - origin;
                    if to.length() > SHOCKWAVE_RADIUS {
                        continue;
                    }
                    let dir = if to.length_squared() > 1e-6 {
                        to.normalize()
                    } else {
                        Vec3::new(1.0, 0.0, 0.0)
                    };
                    npc.position = step_move_speed(
                        &self.chunks,
                        npc.position,
                        dir.x,
                        dir.z,
                        SHOCKWAVE_KNOCKBACK,
                        1.0,
                    );
                    targets.push(npc.entity);
                }
                for target in targets {
                    let impact = self
                        .npcs
                        .get(&target)
                        .map(|n| Vec3::new(n.position.x, 1.0, n.position.z))
                        .unwrap_or(origin);
                    self.damage_npc(entity, target, SHOCKWAVE_DAMAGE, impact);
                }
            }
            AbilityKind::Stim => {
                player.stim_heal_left = STIM_HEAL;
                player.stim_speed_time = STIM_SPEED_DURATION;
            }
            AbilityKind::Overcharge => {
                player.overcharge_time = stats.duration;
            }
        }

        if let Some(player) = self.players.get(&entity) {
            let _ = player.tx.send(S2C::AbilityUpdate {
                ability,
                cooldown: stats.cooldown,
                active: stats.duration,
            });
        }
    }

    fn damage_npc(&mut self, attacker: EntityId, target: EntityId, damage: f32, impact: Vec3) {
        let died_info = {
            let Some(npc) = self.npcs.get_mut(&target) else { return };
            npc.health -= damage;
            if npc.health <= 0.0 && npc.alive() {
                npc.state = wilder_ai::NpcState::Dead;
                npc.respawn_in = NPC_RESPAWN_SECONDS;
                npc.anim = AnimState::Death;
                Some((npc.position, npc.archetype.variant == 2))
            } else {
                // Getting shot provokes the NPC even from beyond its passive
                // aggro radius, so sniping draws retaliation.
                if self.players.contains_key(&attacker) {
                    npc.provoke(attacker);
                }
                None
            }
        };
        self.broadcast_combat(CombatEvent::Hit {
            attacker,
            target,
            damage,
            x: impact.x,
            y: impact.y,
            z: impact.z,
        });
        if let Some((drop_pos, is_raider)) = died_info {
            self.broadcast_combat(CombatEvent::EntityDied { id: target });
            self.grant_xp(attacker, if is_raider { XP_RAIDER_KILL } else { XP_SCAV_KILL });

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
                // Rare blueprint fragments feed Laboratory research (Phase 3).
                if rng.random_bool(FRAGMENT_CHANCE) {
                    items.push(ItemStack { kind: ItemKind::BlueprintFragment, count: 1 });
                }
            }
            self.spawn_loot(drop_pos, items);
        }
    }

    /// Grant XP to a player (no-op for NPC attackers) and handle level-ups.
    /// `Character.xp` is progress into the current level; level-ups roll the
    /// remainder over, bump max health, and fully heal.
    fn grant_xp(&mut self, entity: EntityId, amount: u32) {
        let Some(player) = self.players.get_mut(&entity) else { return };
        player.character.xp += amount;
        while player.character.xp >= xp_for_level(player.character.level) {
            player.character.xp -= xp_for_level(player.character.level);
            player.character.level += 1;
            player.character.max_health += 10.0;
            player.character.health = player.character.max_health;
        }
        player.dirty = true;
        let _ = player.tx.send(S2C::XpUpdate {
            xp: player.character.xp,
            level: player.character.level,
            next_level_xp: xp_for_level(player.character.level),
            gained: amount,
        });
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

        // Resource node?
        if let Some(node) = self.nodes.get_mut(&target) {
            let Some(player) = self.players.get_mut(&entity) else { return };
            if !node.active() {
                return;
            }
            if (node.position - player.character.position).length() > 3.0 {
                let _ = player.tx.send(S2C::Error { message: "too far away".into() });
                return;
            }
            if node.cooldown > 0.0 {
                return;
            }
            node.cooldown = NODE_GATHER_COOLDOWN;
            node.charges -= 1;
            if node.charges == 0 {
                node.respawn_in = NODE_RESPAWN_SECONDS;
            }
            use rand::Rng;
            let kind = wilder_economy::node_yield(node.variant);
            let count = self.rng.random_range(2..=5u32);
            let leftover = inv::add_items(&mut player.inventory.slots, kind, count);
            let gained = count - leftover;
            // Rare blueprint fragments feed Laboratory research (Phase 3).
            if self.rng.random_bool(FRAGMENT_CHANCE) {
                inv::add_items(&mut player.inventory.slots, ItemKind::BlueprintFragment, 1);
            }
            player.dirty = true;
            let _ = player.tx.send(S2C::GatherResult {
                gained: (gained > 0).then_some(ItemStack { kind, count: gained }),
            });
            let _ = player.tx.send(S2C::InventoryUpdate(player.inventory.clone()));
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
            EntityKind::Refinery | EntityKind::Factory | EntityKind::Laboratory => {
                // Push this player's queue for the station (opens the UI).
                let jobs: Vec<ProductionJob> = player
                    .production
                    .get(&target)
                    .map(|jobs| jobs.iter().map(|j| j.to_wire()).collect())
                    .unwrap_or_default();
                let _ = player.tx.send(S2C::ProductionState { building: target, jobs });
            }
            EntityKind::MarketTerminal => {
                self.send_market_state(entity);
            }
            _ => {}
        }
    }

    /// Instant crafting at a nearby station, and `research_<id>` unlocks at the
    /// Laboratory. (Timed production queues are the Phase 3 path for stations.)
    fn craft(&mut self, entity: EntityId, recipe_id: &str, station: Option<EntityId>) {
        if let Some(research_id) = recipe_id.strip_prefix("research_") {
            self.research(entity, research_id);
            return;
        }
        let Some(player) = self.players.get(&entity) else { return };
        let fail = |player: &Player, error: &str| {
            let _ = player.tx.send(S2C::CraftResult {
                ok: false,
                error: Some(error.into()),
                produced: None,
            });
        };
        let Some(recipe) = wilder_crafting::recipe(recipe_id) else {
            fail(player, "unknown recipe");
            return;
        };
        if !player.blueprints.contains(recipe.id) {
            fail(player, "blueprint not researched");
            return;
        }
        let station_kind = match recipe.station {
            wilder_crafting::Station::Refinery => EntityKind::Refinery,
            wilder_crafting::Station::Factory => EntityKind::Factory,
            wilder_crafting::Station::Laboratory => EntityKind::Laboratory,
        };
        // The right kind of station must be within reach (explicit id or nearest).
        let near_station = self.statics.values().any(|s| {
            s.kind == station_kind
                && station.map(|id| s.entity == id).unwrap_or(true)
                && (s.position - player.character.position).length() < 3.5
        });
        if !near_station {
            fail(player, &format!("no {:?} in reach", recipe.station));
            return;
        }
        let Some(player) = self.players.get_mut(&entity) else { return };
        // Verify + consume inputs.
        for &(kind, count) in recipe.inputs {
            if inv::count_items(&player.inventory.slots, kind) < count {
                let _ = player.tx.send(S2C::CraftResult {
                    ok: false,
                    error: Some(format!("need {}x {}", count, kind.display_name())),
                    produced: None,
                });
                return;
            }
        }
        for &(kind, count) in recipe.inputs {
            inv::remove_items(&mut player.inventory.slots, kind, count);
        }
        let (out_kind, out_count) = recipe.output;
        let leftover = inv::add_items(&mut player.inventory.slots, out_kind, out_count);
        player.dirty = true;
        let produced = ItemStack { kind: out_kind, count: out_count - leftover };
        let _ = player.tx.send(S2C::CraftResult { ok: true, error: None, produced: Some(produced) });
        let _ = player.tx.send(S2C::InventoryUpdate(player.inventory.clone()));
        if leftover > 0 {
            let pos = player.character.position;
            self.spawn_loot(pos, vec![ItemStack { kind: out_kind, count: leftover }]);
        }
    }

    /// Unlock a blueprint at the Laboratory: consumes fragments + resources.
    fn research(&mut self, entity: EntityId, recipe_id: &str) {
        let near_lab = self
            .players
            .get(&entity)
            .map(|p| {
                self.statics.values().any(|s| {
                    s.kind == EntityKind::Laboratory
                        && (s.position - p.character.position).length() < 3.5
                })
            })
            .unwrap_or(false);
        let Some(player) = self.players.get_mut(&entity) else { return };
        let fail = |player: &Player, error: &str| {
            let _ = player.tx.send(S2C::CraftResult {
                ok: false,
                error: Some(error.into()),
                produced: None,
            });
        };
        if !near_lab {
            fail(player, "no Laboratory in reach");
            return;
        }
        let Some(recipe) = wilder_crafting::recipe(recipe_id) else {
            fail(player, "unknown blueprint");
            return;
        };
        if player.blueprints.contains(recipe.id) {
            fail(player, "already researched");
            return;
        }
        if inv::count_items(&player.inventory.slots, ItemKind::BlueprintFragment)
            < RESEARCH_FRAGMENTS
        {
            fail(player, &format!("need {RESEARCH_FRAGMENTS}x Blueprint Fragment"));
            return;
        }
        for &(kind, count) in RESEARCH_RESOURCES {
            if inv::count_items(&player.inventory.slots, kind) < count {
                fail(player, &format!("need {}x {}", count, kind.display_name()));
                return;
            }
        }
        inv::remove_items(
            &mut player.inventory.slots,
            ItemKind::BlueprintFragment,
            RESEARCH_FRAGMENTS,
        );
        for &(kind, count) in RESEARCH_RESOURCES {
            inv::remove_items(&mut player.inventory.slots, kind, count);
        }
        player.blueprints.insert(recipe.id.to_string());
        player.dirty = true;
        let known: Vec<String> = player.blueprints.iter().cloned().collect();
        let _ = self
            .store
            .save_blueprints(player.character.id, &known);
        let _ = player.tx.send(S2C::CraftResult { ok: true, error: None, produced: None });
        let _ = player.tx.send(S2C::BlueprintsUpdate { known });
        let _ = player.tx.send(S2C::InventoryUpdate(player.inventory.clone()));
    }

    /// Queue a timed production job at a station building (Phase 3).
    fn queue_production(
        &mut self,
        entity: EntityId,
        building: EntityId,
        recipe_id: &str,
        count: u32,
    ) {
        let station = self
            .statics
            .get(&building)
            .map(|s| (s.kind, s.position));
        let Some(player) = self.players.get_mut(&entity) else { return };
        let fail = |player: &Player, error: &str| {
            let _ = player.tx.send(S2C::CraftResult {
                ok: false,
                error: Some(error.into()),
                produced: None,
            });
        };
        let Some((kind, pos)) = station else {
            fail(player, "no such building");
            return;
        };
        if (pos - player.character.position).length() > 3.5 {
            fail(player, "too far from the building");
            return;
        }
        let Some(recipe) = wilder_crafting::recipe(recipe_id) else {
            fail(player, "unknown recipe");
            return;
        };
        if !player.blueprints.contains(recipe.id) {
            fail(player, "blueprint not researched");
            return;
        }
        let expected = match recipe.station {
            wilder_crafting::Station::Refinery => EntityKind::Refinery,
            wilder_crafting::Station::Factory => EntityKind::Factory,
            wilder_crafting::Station::Laboratory => EntityKind::Laboratory,
        };
        if kind != expected {
            fail(player, &format!("recipe needs a {:?}", recipe.station));
            return;
        }
        let count = count.clamp(1, 20);
        // Inputs are consumed up-front for the whole batch.
        for &(k, c) in recipe.inputs {
            if inv::count_items(&player.inventory.slots, k) < c * count {
                fail(player, &format!("need {}x {}", c * count, k.display_name()));
                return;
            }
        }
        for &(k, c) in recipe.inputs {
            inv::remove_items(&mut player.inventory.slots, k, c * count);
        }
        let job = ProductionJobState {
            id: self.next_job_id,
            recipe,
            count,
            done: 0,
            remaining: recipe.seconds,
            powered: false,
        };
        self.next_job_id += 1;
        player.production.entry(building).or_default().push(job);
        player.dirty = true;
        let jobs: Vec<ProductionJob> =
            player.production[&building].iter().map(|j| j.to_wire()).collect();
        let _ = player.tx.send(S2C::InventoryUpdate(player.inventory.clone()));
        let _ = player.tx.send(S2C::ProductionState { building, jobs });
    }

    /// Advance production queues under the global power budget.
    fn tick_production(&mut self) {
        // Deterministic ordering: players by entity id, buildings by id.
        let mut player_ids: Vec<EntityId> = self.players.keys().copied().collect();
        player_ids.sort_unstable();

        let mut power_used = 0.0f32;
        let mut completions: Vec<(EntityId, Vec3, ItemStack)> = Vec::new();

        for pid in player_ids {
            let Some(player) = self.players.get_mut(&pid) else { continue };
            let mut buildings: Vec<EntityId> = player.production.keys().copied().collect();
            buildings.sort_unstable();
            for building in buildings {
                let mut state_changed = false;
                let jobs = player.production.get_mut(&building).unwrap();
                // Only the head job of each queue runs.
                if let Some(job) = jobs.first_mut() {
                    let draw = station_power(job.recipe.station);
                    let powered = power_used + draw <= POWER_BUDGET;
                    if powered {
                        power_used += draw;
                    }
                    if powered != job.powered {
                        job.powered = powered;
                        state_changed = true;
                    }
                    if powered {
                        job.remaining -= TICK_DT;
                        if job.remaining <= 0.0 {
                            job.done += 1;
                            job.remaining = job.recipe.seconds;
                            let (kind, count) = job.recipe.output;
                            let leftover =
                                inv::add_items(&mut player.inventory.slots, kind, count);
                            completions.push((
                                pid,
                                player.character.position,
                                ItemStack { kind, count: leftover },
                            ));
                            player.dirty = true;
                            state_changed = true;
                            let _ = player
                                .tx
                                .send(S2C::InventoryUpdate(player.inventory.clone()));
                        }
                    }
                }
                let jobs = player.production.get_mut(&building).unwrap();
                if jobs.first().map(|j| j.done >= j.count).unwrap_or(false) {
                    jobs.remove(0);
                    state_changed = true;
                }
                if jobs.is_empty() {
                    player.production.remove(&building);
                }
                if state_changed {
                    let jobs: Vec<ProductionJob> = player
                        .production
                        .get(&building)
                        .map(|jobs| jobs.iter().map(|j| j.to_wire()).collect())
                        .unwrap_or_default();
                    let _ = player.tx.send(S2C::ProductionState { building, jobs });
                }
            }
        }

        // Overflow output that didn't fit the inventory drops at the player's feet.
        for (_pid, pos, stack) in completions {
            if stack.count > 0 {
                self.spawn_loot(pos, vec![stack]);
            }
        }
    }

    // -----------------------------------------------------------------------
    // Market
    // -----------------------------------------------------------------------

    fn save_market(&self) {
        let _ = self.store.save_meta("market_listings", &self.market);
        let _ = self.store.save_meta("market_next_id", &self.next_listing_id);
    }

    fn send_market_state(&self, entity: EntityId) {
        let Some(player) = self.players.get(&entity) else { return };
        let listings: Vec<MarketListing> = self
            .market
            .iter()
            .map(|l| MarketListing {
                id: l.id,
                seller: l.seller_name.clone(),
                kind: l.kind,
                count: l.count,
                price_each: l.price_each,
            })
            .collect();
        let _ = player.tx.send(S2C::MarketState { listings, wallet: player.wallet });
    }

    fn market_action(&mut self, entity: EntityId, action: MarketAction) {
        let result = self.apply_market_action(entity, action);
        if let Some(player) = self.players.get(&entity) {
            let _ = player.tx.send(S2C::MarketResult {
                ok: result.is_ok(),
                error: result.err(),
            });
            let _ = player.tx.send(S2C::InventoryUpdate(player.inventory.clone()));
        }
        self.send_market_state(entity);
    }

    fn apply_market_action(&mut self, entity: EntityId, action: MarketAction) -> Result<(), String> {
        match action {
            MarketAction::Refresh => Ok(()),
            MarketAction::List { kind, count, price_each } => {
                let player = self.players.get_mut(&entity).ok_or("not in world")?;
                if count == 0 || price_each == 0 || price_each > 1_000_000 {
                    return Err("invalid listing".into());
                }
                let have = inv::count_items(&player.inventory.slots, kind);
                if have < count {
                    return Err(format!("you only have {have}x {}", kind.display_name()));
                }
                inv::remove_items(&mut player.inventory.slots, kind, count);
                player.dirty = true;
                let listing = wilder_market::Listing {
                    id: self.next_listing_id,
                    seller: player.character.id,
                    seller_name: player.character.name.clone(),
                    kind,
                    count,
                    price_each,
                };
                self.next_listing_id += 1;
                self.market.push(listing);
                self.save_market();
                Ok(())
            }
            MarketAction::Buy { listing_id, count } => {
                let idx = self
                    .market
                    .iter()
                    .position(|l| l.id == listing_id)
                    .ok_or("listing gone")?;
                let (kind, price_each, available, seller, seller_name) = {
                    let l = &self.market[idx];
                    (l.kind, l.price_each, l.count, l.seller, l.seller_name.clone())
                };
                let count = count.min(available).max(1);
                let cost = price_each.saturating_mul(count);
                let buyer = self.players.get_mut(&entity).ok_or("not in world")?;
                if buyer.wallet < cost {
                    return Err(format!("need {cost} WILD, have {}", buyer.wallet));
                }
                buyer.wallet -= cost;
                let buyer_account = buyer.character.account_id;
                let buyer_pos = buyer.character.position;
                let leftover = inv::add_items(&mut buyer.inventory.slots, kind, count);
                buyer.dirty = true;
                let _ = self.store.update_wallet(buyer_account, self.players[&entity].wallet);
                if leftover > 0 {
                    self.spawn_loot(buyer_pos, vec![ItemStack { kind, count: leftover }]);
                }

                // Credit the seller (minus the burn fee), online or offline.
                let fee = cost * MARKET_FEE_PCT / 100;
                let proceeds = cost - fee;
                let seller_online = self
                    .players
                    .values_mut()
                    .find(|p| p.character.id == seller);
                if let Some(sp) = seller_online {
                    sp.wallet += proceeds;
                    let account = sp.character.account_id;
                    let wallet = sp.wallet;
                    let _ = self.store.update_wallet(account, wallet);
                } else if let Ok(ch) = self.store.character(seller) {
                    if let Ok(account) = self.store.account_by_id(ch.account_id) {
                        let _ = self
                            .store
                            .update_wallet(account.id, account.wallet + proceeds);
                    }
                }
                let _ = seller_name; // (transaction history is post-MVP)

                let l = &mut self.market[idx];
                l.count -= count;
                if l.count == 0 {
                    self.market.remove(idx);
                }
                self.save_market();
                Ok(())
            }
            MarketAction::Cancel { listing_id } => {
                let player = self.players.get_mut(&entity).ok_or("not in world")?;
                let idx = self
                    .market
                    .iter()
                    .position(|l| l.id == listing_id)
                    .ok_or("listing gone")?;
                if self.market[idx].seller != player.character.id {
                    return Err("not your listing".into());
                }
                let listing = self.market.remove(idx);
                let leftover =
                    inv::add_items(&mut player.inventory.slots, listing.kind, listing.count);
                player.dirty = true;
                let pos = player.character.position;
                if leftover > 0 {
                    self.spawn_loot(pos, vec![ItemStack { kind: listing.kind, count: leftover }]);
                }
                self.save_market();
                Ok(())
            }
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
        player.sync_shield();
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
        self.tick_nodes();
        self.tick_production();
        self.tick_regen();
        self.update_interest();
        self.replicate();

        // Clear per-tick attack flags only after replicate so the Attack anim
        // state actually reaches other clients (attacks are processed on
        // message receipt, before this tick's movement pass).
        for player in self.players.values_mut() {
            player.attacked_this_tick = false;
        }

        if self.tick % SAVE_INTERVAL_TICKS == 0 {
            self.save_all();
        }
    }

    fn apply_movement(&mut self) {
        for player in self.players.values_mut() {
            player.moved_this_tick = false;
            player.ran_this_tick = false;
            player.attack_cooldown = (player.attack_cooldown - TICK_DT).max(0.0);
            if player.character.health <= 0.0 {
                continue;
            }
            player.roll_cooldown = (player.roll_cooldown - TICK_DT).max(0.0);
            for cd in player.ability_cooldowns.iter_mut() {
                *cd = (*cd - TICK_DT).max(0.0);
            }
            player.stim_speed_time = (player.stim_speed_time - TICK_DT).max(0.0);
            player.overcharge_time = (player.overcharge_time - TICK_DT).max(0.0);
            let before = player.character.position;

            if player.roll_time > 0.0 {
                // Dodge roll dash: overrides direct input (drained but only
                // acked so client reconciliation stays in sync).
                let (dx, dz) = player.roll_dir;
                let next = step_move_speed(
                    &self.chunks,
                    player.character.position,
                    dx,
                    dz,
                    ROLL_SPEED,
                    TICK_DT,
                );
                player.character.position = next;
                player.roll_time -= TICK_DT;
                for (seq, ..) in std::mem::take(&mut player.pending_inputs) {
                    player.last_input_seq = player.last_input_seq.max(seq);
                }
            }

            let speed_mult = if player.stim_speed_time > 0.0 { STIM_SPEED_MULT } else { 1.0 };
            let inputs = std::mem::take(&mut player.pending_inputs);
            for (seq, dx, dz, yaw, run, dt) in inputs {
                player.last_input_seq = player.last_input_seq.max(seq);
                let speed = speed_mult
                    * if player.crouching {
                        CROUCH_SPEED
                    } else if run {
                        RUN_SPEED
                    } else {
                        wilder_physics::WALK_SPEED
                    };
                let next =
                    step_move_speed(&self.chunks, player.character.position, dx, dz, speed, dt);
                player.character.position = next;
                if dx != 0.0 || dz != 0.0 {
                    // Twin-stick: facing follows the client's aim, not the move
                    // direction, so remote viewers see strafing/backpedaling.
                    player.character.yaw = if yaw.is_finite() { yaw } else { dz.atan2(dx) };
                    player.ran_this_tick = run && !player.crouching;
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
            player.character.shield = player.character.max_shield;
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
        // Shield absorbs first; the remainder hits health.
        let absorbed = dealt.min(player.character.shield);
        player.character.shield -= absorbed;
        player.character.health -= dealt - absorbed;
        player.shield_delay = SHIELD_REGEN_DELAY;
        let impact = player.character.position;
        self.broadcast_combat(CombatEvent::Hit {
            attacker,
            target,
            damage: dealt,
            x: impact.x,
            y: 1.25,
            z: impact.z,
        });

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
        player.character.shield = player.character.max_shield;
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

    fn tick_nodes(&mut self) {
        for node in self.nodes.values_mut() {
            node.cooldown = (node.cooldown - TICK_DT).max(0.0);
            if !node.active() {
                node.respawn_in -= TICK_DT;
                if node.respawn_in <= 0.0 {
                    node.charges = NODE_CHARGES;
                    node.respawn_in = 0.0;
                }
            }
        }
    }

    fn tick_regen(&mut self) {
        for player in self.players.values_mut() {
            let coord = ChunkCoord::from_world(player.character.position);
            if is_safe_chunk(coord) && player.character.health < player.character.max_health {
                player.character.health =
                    (player.character.health + 2.0 * TICK_DT).min(player.character.max_health);
            }
            // Shield regen after a delay without taking damage.
            player.shield_delay = (player.shield_delay - TICK_DT).max(0.0);
            if player.shield_delay <= 0.0 && player.character.shield < player.character.max_shield
            {
                player.character.shield = (player.character.shield
                    + SHIELD_REGEN_RATE * TICK_DT)
                    .min(player.character.max_shield);
            }
            // Stim heal-over-time.
            if player.stim_heal_left > 0.0 && player.character.health > 0.0 {
                let rate = STIM_HEAL / ability_stats(AbilityKind::Stim).duration;
                let heal = (rate * TICK_DT).min(player.stim_heal_left);
                player.stim_heal_left -= heal;
                player.character.health =
                    (player.character.health + heal).min(player.character.max_health);
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
                // Hub statics: stash terminal + crafting stations on walkable
                // spots near spawn (positions come from the baked city map).
                let hub: &[(EntityKind, &str)] = &[
                    (EntityKind::Building, "Stash Terminal"),
                    (EntityKind::Refinery, "Refinery"),
                    (EntityKind::Factory, "Factory"),
                    (EntityKind::Laboratory, "Laboratory"),
                    (EntityKind::MarketTerminal, "Market Terminal"),
                ];
                let spots = hub_spots(&self.chunks.get(coord), hub.len());
                for (&(kind, name), pos) in hub.iter().zip(spots) {
                    let entity = self.alloc_entity();
                    self.statics.insert(
                        entity,
                        StaticEntity { entity, kind, position: pos, name: name.into(), variant: 0 },
                    );
                }
            }
            // Resource nodes: roughly every other hostile chunk gets one.
            let nh = (coord.x.wrapping_mul(198491317) ^ coord.z.wrapping_mul(6542989)) as u32;
            if !is_safe_chunk(coord) && nh % 2 == 0 {
                let chunk = self.chunks.get(coord);
                let variant = (nh >> 8) % wilder_economy::RESOURCES.len() as u32;
                // Deterministic walkable spot (offset scan so nodes don't stack
                // on the extraction beacon which scans from (2,2)).
                'node: for tz in (3..TILES_PER_CHUNK).step_by(2) {
                    for tx in (4..TILES_PER_CHUNK).step_by(2) {
                        if chunk.tile(tx, tz).walkable() {
                            let entity = self.alloc_entity();
                            self.nodes.insert(
                                entity,
                                ResourceNode {
                                    entity,
                                    position: Vec3::new(
                                        coord.x as f32 * CHUNK_SIZE + (tx as f32 + 0.5) * TILE_SIZE,
                                        0.0,
                                        coord.z as f32 * CHUNK_SIZE + (tz as f32 + 0.5) * TILE_SIZE,
                                    ),
                                    variant,
                                    charges: NODE_CHARGES,
                                    respawn_in: 0.0,
                                    cooldown: 0.0,
                                },
                            );
                            break 'node;
                        }
                    }
                }
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
                    shield_pct: 0.0,
                },
            });
        }
        for node in self.nodes.values() {
            if !node.active() {
                continue;
            }
            let kind = wilder_economy::node_yield(node.variant);
            let health = node.charges as f32 / NODE_CHARGES as f32;
            all.push(Replicated {
                id: node.entity,
                chunk: ChunkCoord::from_world(node.position),
                spawn: EntitySpawnData {
                    id: node.entity,
                    kind: EntityKind::ResourceNode,
                    name: format!("{} Deposit", kind.display_name()),
                    appearance: Appearance::default(),
                    position: node.position,
                    yaw: 0.0,
                    anim: AnimState::Idle,
                    health_pct: health,
                    variant: node.variant,
                },
                snap: EntitySnapshot {
                    id: node.entity,
                    position: node.position,
                    yaw: 0.0,
                    anim: AnimState::Idle,
                    health_pct: health,
                    shield_pct: 0.0,
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
                    shield_pct: 0.0,
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
