//! The authoritative world simulation.
//!
//! Runs as a single tokio task at TICK_HZ. WebSocket connections talk to it
//! through a command channel; it replies through per-player message channels.

mod chunks;
mod ledger;
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
use ledger::{Ledger, LedgerSave, SupplyEffect};
use npc::{mint_agent_identity, npc_spawns_for_chunk, Npc};

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
/// Static ammo caches scattered through every chunk. Kept off the roads
/// (pedestrian tiles only, see `ammo_cache_spots`) and dialed back so ammo is
/// findable but not everywhere; count per chunk and rounds per cache.
const AMMO_CACHE_COUNT: usize = 3;
const AMMO_CACHE_ROUNDS: u32 = 12;
/// Ammo caches are grabbed automatically when a player walks within this
/// distance (metres) - no click required.
const AMMO_PICKUP_RADIUS: f32 = 2.0;
/// Resource node: gathers before depletion, respawn delay, per-gather cooldown.
const NODE_CHARGES: u32 = 5;
const NODE_RESPAWN_SECONDS: f32 = 60.0;
const NODE_GATHER_COOLDOWN: f32 = 1.2;
/// Chance for a blueprint fragment to drop from NPC kills / node gathers.
const FRAGMENT_CHANCE: f64 = 0.10;
/// Global hub power budget (kW) shared by all production jobs.
const POWER_BUDGET: f32 = 100.0;
/// Market fee (percent) taken from every sale: routed to whoever holds the
/// market's territory, burned otherwise.
const MARKET_FEE_PCT: u32 = 5;
/// WILD granted to every account once.
const WALLET_GRANT: u32 = 200;
/// Safehouse bubble radius (metres): hostiles ignore players inside and
/// health regen applies as if in the safe hub.
const SAFEHOUSE_RADIUS: f32 = 10.0;
/// Themed resource zones ring the hub out to this chunk radius (Chebyshev);
/// everything beyond is `ZoneKind::Mixed`.
const ZONE_RING_CHUNKS: i32 = 6;
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

/// Territory control encoding (matches `wilder_protocol::TerritoryCell`).
const CONTROL_NEUTRAL: u8 = 0;
const CONTROL_PLAYER: u8 = 1;
const CONTROL_ENEMY: u8 = 2;
/// Minimum living hostile NPCs in a region for the enemy to hold it.
const CAPTURE_MIN: usize = 3;
/// Fraction (percent) of gathered/extracted yield seized in enemy regions.
const TERRITORY_TAX_PCT: u32 = 25;
/// Recompute territory occupancy every N ticks (20 Hz -> ~1 Hz).
const TERRITORY_TICK_INTERVAL: u64 = 20;

/// Territory region containing a world position. Region math mirrors the
/// client (`apps/web/src/game/territory.ts`) so lines/tax agree.
fn region_of(pos: Vec3) -> (i32, i32) {
    let c = ChunkCoord::from_world(pos);
    (c.x.div_euclid(REGION_CHUNKS), c.z.div_euclid(REGION_CHUNKS))
}

/// True if a region overlaps the safe hub and so can never be captured.
fn region_is_protected(r: (i32, i32)) -> bool {
    let (rx, rz) = r;
    let cx0 = rx * REGION_CHUNKS;
    let cx1 = cx0 + REGION_CHUNKS - 1;
    let cz0 = rz * REGION_CHUNKS;
    let cz1 = cz0 + REGION_CHUNKS - 1;
    cx0 <= SAFE_RADIUS && cx1 >= -SAFE_RADIUS && cz0 <= SAFE_RADIUS && cz1 >= -SAFE_RADIUS
}

/// Every runner spawns armed: if neither weapon slot holds anything, equip
/// the first weapon carried in the backpack, or grant a Pistol outright when
/// they own no weapon at all. Also snaps `active_weapon` onto a filled slot
/// so joining never puts an armed player on empty fists.
fn ensure_starting_weapon(inventory: &mut Inventory) {
    if inventory.equipped_weapon.is_none() && inventory.equipped_weapon2.is_none() {
        let carried = inventory
            .slots
            .iter()
            .position(|s| s.is_some_and(|stack| stack.kind.is_weapon()));
        match carried {
            Some(slot) => {
                inv::equip(inventory, slot, 0);
            }
            None => inventory.equipped_weapon = Some(ItemKind::Pistol),
        }
        inventory.active_weapon = 0;
    } else if inventory.active_weapon_kind().is_none() {
        // A weapon is equipped but the hand points at the empty slot.
        inventory.active_weapon = if inventory.equipped_weapon.is_some() { 0 } else { 1 };
    }
}

/// Ledger party for a player character.
fn player_party(p: &Player) -> TxParty {
    TxParty::Player { id: p.character.id, name: p.character.name.clone() }
}

/// Ledger party for an NPC agent.
fn npc_party(n: &Npc) -> TxParty {
    TxParty::Agent { id: n.agent_id, name: n.agent_name.clone() }
}

/// Ledger party for a service building (vendor / bank / market terminal).
fn static_party(s: &StaticEntity) -> TxParty {
    TxParty::Agent { id: s.agent_id, name: s.name.clone() }
}

/// Stable per-session agent id for a service building, derived from the world
/// seed and the building's entity id (identical across restarts because the
/// district seeds in a fixed order before any player joins).
fn static_agent_id(seed: u64, entity: EntityId) -> AgentId {
    uuid::Uuid::from_u64_pair(seed ^ 0xA6E7_7A6E_7A6E_77AA, entity)
}

/// Roll the loot an NPC agent carries. Called at spawn (and respawn) so the
/// agent owns its inventory while alive; the same items drop on death.
fn roll_npc_loot(rng: &mut SmallRng, zone: ZoneKind, is_raider: bool) -> Vec<ItemStack> {
    use rand::Rng;
    let mut items: Vec<ItemStack> = Vec::new();
    // Resources always drop (Phase 2 economy feeds on these), biased by the
    // zone the NPC lives in.
    let pulls = if is_raider { 3 } else { 2 };
    for _ in 0..pulls {
        let idx = wilder_economy::zone_resource_index(zone, rng.random());
        let kind = wilder_economy::RESOURCES[idx];
        items.push(ItemStack { kind, count: rng.random_range(1..4) });
    }
    // Cash feeds the Bank loop; blast-zone rubble hides more.
    let (lo, hi) = if is_raider {
        wilder_economy::CASH_DROP_RAIDER
    } else {
        wilder_economy::CASH_DROP_SCAV
    };
    let mut cash = rng.random_range(lo..=hi);
    if zone == ZoneKind::BlownUp {
        cash *= 2;
    }
    items.push(ItemStack { kind: ItemKind::Cash, count: cash });
    if rng.random_bool(0.7) {
        items.push(ItemStack { kind: ItemKind::Ammo9mm, count: rng.random_range(10..25) });
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
    items
}

/// Reduce a yield count by the territory tax when `enemy` is true.
fn apply_territory_tax(count: u32, enemy: bool) -> u32 {
    if enemy {
        count - count * TERRITORY_TAX_PCT / 100
    } else {
        count
    }
}

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

/// Zone kind of the octant at index `oct`, where octant 0 points along +X
/// (east) and octants advance counter-clockwise in world space (+Z = south).
fn zone_of_octant(oct: i32) -> ZoneKind {
    match oct.rem_euclid(8) {
        0 => ZoneKind::BlownUp,    // E
        1 => ZoneKind::ChemPlant,  // SE
        2 => ZoneKind::Mining,     // S
        3 => ZoneKind::Scrapyard,  // SW
        4 => ZoneKind::Overgrowth, // W
        5 => ZoneKind::Mixed,      // NW
        6 => ZoneKind::Industrial, // N
        _ => ZoneKind::TechRuins,  // NE
    }
}

/// Resource-bias zone containing a chunk: the safe hub and everything beyond
/// the zone ring are Mixed; the ring itself is split into eight themed
/// octants around the hub. Pure and O(1), so drop rolls can call it freely.
pub fn zone_of_chunk(coord: ChunkCoord) -> ZoneKind {
    if is_safe_chunk(coord) {
        return ZoneKind::Mixed;
    }
    if coord.x.abs() > ZONE_RING_CHUNKS || coord.z.abs() > ZONE_RING_CHUNKS {
        return ZoneKind::Mixed;
    }
    let angle = (coord.z as f32).atan2(coord.x as f32);
    zone_of_octant((angle / std::f32::consts::FRAC_PI_4).round() as i32)
}

/// Named zone labels (anchor = middle of each octant ring) for the map UI.
fn zone_infos() -> Vec<ZoneInfo> {
    let radius = ZONE_RING_CHUNKS as f32 * 0.6 * CHUNK_SIZE;
    (0..8)
        .filter_map(|oct| {
            let kind = zone_of_octant(oct);
            if kind == ZoneKind::Mixed {
                return None;
            }
            let angle = oct as f32 * std::f32::consts::FRAC_PI_4;
            Some(ZoneInfo {
                kind,
                name: kind.display_name().to_string(),
                x: angle.cos() * radius + CHUNK_SIZE / 2.0,
                z: angle.sin() * radius + CHUNK_SIZE / 2.0,
            })
        })
        .collect()
}

/// Spawn-district service buildings: (chunk offset from the hub, kind, name).
/// Spread across the safe 3x3 so every service is a short walk from spawn.
const DISTRICT: &[((i32, i32), EntityKind, &str)] = &[
    ((0, 0), EntityKind::Building, "Storage"),
    ((0, 0), EntityKind::MarketTerminal, "Market"),
    ((1, 0), EntityKind::Refinery, "Refinery"),
    ((1, 0), EntityKind::Factory, "Factory"),
    ((-1, 0), EntityKind::Bank, "Bank"),
    ((-1, 0), EntityKind::Laboratory, "Laboratory"),
    ((0, 1), EntityKind::Armory, "Armory"),
    ((0, 1), EntityKind::Bodega, "Bodega"),
    ((0, -1), EntityKind::Safehouse, "Safehouse"),
    ((0, -1), EntityKind::Dealership, "Dealership"),
];

/// Commerce outposts in the hostile ring. Unlike the protected hub regions,
/// the ground around these can be player-held, so the territory commerce cut
/// actually pays out here.
const OUTPOSTS: &[((i32, i32), EntityKind, &str)] = &[
    ((3, 0), EntityKind::Bodega, "Bodega Outpost"),
    ((0, 3), EntityKind::Bank, "Bank Outpost"),
    // Storage depots: every terminal opens the same persistent stash, so
    // loot deposited at any location can be withdrawn at all the others.
    ((3, 0), EntityKind::Building, "Storage Depot East"),
    ((0, 3), EntityKind::Building, "Storage Depot South"),
    ((-3, 0), EntityKind::Building, "Storage Depot West"),
    ((0, -3), EntityKind::Building, "Storage Depot North"),
];

/// Spots for service locations in a chunk: each spot is the sidewalk tile in
/// front of an existing building's street face (-z side, matching the
/// client's storefront convention), so every service lives in a real
/// storefront. Prefers doors near the anchor (spawn in the spawn chunk,
/// chunk centre elsewhere) and keeps doors at least 3 tiles apart. Falls
/// back to plain walkable tiles on chunks without enough suitable
/// buildings. Returns world-space positions; may be shorter than `count`
/// on cramped chunks.
fn station_spots(chunk: &ChunkData, coord: ChunkCoord, count: usize) -> Vec<Vec3> {
    let (anchor_tx, anchor_tz) = if coord.x == 0 && coord.z == 0 {
        ((SPAWN.x / TILE_SIZE) as i32, (SPAWN.z / TILE_SIZE) as i32)
    } else {
        (TILES_PER_CHUNK as i32 / 2, TILES_PER_CHUNK as i32 / 2)
    };
    // Door candidates: the tile just outside the front-face midpoint of
    // every building footprint in the chunk.
    let mut candidates: Vec<(i32, usize, usize)> = Vec::new();
    for b in &chunk.buildings {
        if b.tz0 == 0 {
            continue; // front row would be outside the chunk
        }
        let tz = b.tz0 as usize - 1;
        let tx = (b.tx0 as usize + b.tx1 as usize - 1) / 2;
        if tx >= TILES_PER_CHUNK || tz >= TILES_PER_CHUNK {
            continue;
        }
        let kind = chunk.tile(tx, tz);
        if !kind.walkable() {
            continue;
        }
        let d = (tx as i32 - anchor_tx).abs().max((tz as i32 - anchor_tz).abs());
        if d < 2 {
            continue; // keep the anchor tile itself clear
        }
        // Doors opening straight onto a road rank behind sidewalk doors.
        let penalty = if matches!(kind, TileKind::Road | TileKind::RoadLine) { 100 } else { 0 };
        candidates.push((d + penalty, tx, tz));
    }
    candidates.sort();
    let mut spots: Vec<(usize, usize)> = Vec::new();
    for &(_, tx, tz) in &candidates {
        if spots.len() >= count {
            break;
        }
        if spots
            .iter()
            .all(|&(sx, sz)| (sx as i32 - tx as i32).abs().max((sz as i32 - tz as i32).abs()) >= 3)
        {
            spots.push((tx, tz));
        }
    }
    // Fallback for chunks without enough hosting buildings: nearest plain
    // walkable off-road tiles, as before.
    if spots.len() < count {
        let mut fallback: Vec<(i32, usize, usize)> = Vec::new();
        for tz in 0..TILES_PER_CHUNK {
            for tx in 0..TILES_PER_CHUNK {
                let kind = chunk.tile(tx, tz);
                if !kind.walkable() {
                    continue;
                }
                let d = (tx as i32 - anchor_tx).abs().max((tz as i32 - anchor_tz).abs());
                if d < 2 {
                    continue;
                }
                let penalty =
                    if matches!(kind, TileKind::Road | TileKind::RoadLine) { 100 } else { 0 };
                fallback.push((d + penalty, tx, tz));
            }
        }
        fallback.sort();
        for &(_, tx, tz) in &fallback {
            if spots.len() >= count {
                break;
            }
            if spots
                .iter()
                .all(|&(sx, sz)| (sx as i32 - tx as i32).abs().max((sz as i32 - tz as i32).abs()) >= 3)
            {
                spots.push((tx, tz));
            }
        }
    }
    spots
        .into_iter()
        .map(|(tx, tz)| {
            Vec3::new(
                coord.x as f32 * CHUNK_SIZE + (tx as f32 + 0.5) * TILE_SIZE,
                0.0,
                coord.z as f32 * CHUNK_SIZE + (tz as f32 + 0.5) * TILE_SIZE,
            )
        })
        .collect()
}

/// Deterministic, spread-out pedestrian tiles in a chunk for scattering ammo
/// caches. Only off-road walkable tiles (sidewalks / plazas / alley-like
/// pedestrian ground) are eligible so caches sit off the streets. Returns
/// world-space positions; may be shorter than `count` (or empty) if the chunk
/// has few pedestrian tiles.
fn ammo_cache_spots(chunk: &ChunkData, coord: ChunkCoord, count: usize) -> Vec<Vec3> {
    let mut walkables: Vec<(usize, usize)> = Vec::new();
    for tz in 1..TILES_PER_CHUNK {
        for tx in 1..TILES_PER_CHUNK {
            // Sidewalks/plazas only: keep ammo off Road/RoadLine (and off
            // Building/Water, which aren't walkable anyway).
            if matches!(chunk.tile(tx, tz), TileKind::Sidewalk | TileKind::Plaza) {
                walkables.push((tx, tz));
            }
        }
    }
    let mut spots = Vec::new();
    if walkables.is_empty() {
        return spots;
    }
    let base = (coord.x.wrapping_mul(73856093) ^ coord.z.wrapping_mul(19349663)) as u32;
    let mut used: Vec<usize> = Vec::new();
    for i in 0..count {
        let mut idx =
            (base.wrapping_add((i as u32).wrapping_mul(2654435761)) as usize) % walkables.len();
        // Step off any already-used tile so caches don't stack on one spot.
        let mut tries = 0;
        while used.contains(&idx) && tries < walkables.len() {
            idx = (idx + 1) % walkables.len();
            tries += 1;
        }
        used.push(idx);
        let (tx, tz) = walkables[idx];
        spots.push(Vec3::new(
            coord.x as f32 * CHUNK_SIZE + (tx as f32 + 0.5) * TILE_SIZE,
            0.0,
            coord.z as f32 * CHUNK_SIZE + (tz as f32 + 0.5) * TILE_SIZE,
        ));
    }
    spots
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
            item: None,
        }
    }
}

struct LootContainer {
    entity: EntityId,
    position: Vec3,
    items: Vec<ItemStack>,
    ttl: f32,
    /// 0 = generic drop, 1 = ammo cache (persistent, highlighted client-side).
    variant: u32,
    /// Ledger party the contents still belong to (dead NPC, dropping player).
    /// Pickups are attributed as transfers from this owner.
    owner: Option<TxParty>,
    /// Whether the contents still count toward circulating supply. False for
    /// death drops (burned when the player died) and world-seeded ammo caches
    /// (issued on pickup), so pickups from those re-mint instead of transfer.
    in_supply: bool,
}

struct StaticEntity {
    entity: EntityId,
    kind: EntityKind,
    position: Vec3,
    name: String,
    variant: u32,
    /// Economic identity: vendor buildings and the market trade as agents.
    agent_id: AgentId,
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
    /// Non-neutral territory control per region (recomputed from presence).
    territory: HashMap<(i32, i32), u8>,
    /// Economy transaction ledger + supply counters (K dashboard).
    ledger: Ledger,
    /// Players subscribed to live ledger updates.
    econ_subs: HashSet<EntityId>,
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
    // Ledger aggregates survive restarts; the recent-tx feed is in-memory.
    let ledger_save: LedgerSave = store.meta("econ_ledger").ok().flatten().unwrap_or_default();

    let (tx, rx) = mpsc::unbounded_channel();
    let mut world = World {
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
        territory: HashMap::new(),
        ledger: Ledger::new(ledger_save),
        econ_subs: HashSet::new(),
    };
    // Seed the spawn district up front so PoiList is complete on every join.
    world.seed_district();
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
        let mut inventory = self.store.inventory(character_id).unwrap_or_default();
        inventory.ensure_slot_count();
        ensure_starting_weapon(&mut inventory);
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
            self.ledger.record(
                TxKind::Mint,
                TxParty::Mint,
                TxParty::Player { id: character.id, name: character.name.clone() },
                TxAmount::Wild { amount: WALLET_GRANT },
                0,
            );
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
        let _ = tx.send(S2C::TerritoryState { cells: self.territory_cells() });
        let _ = tx.send(S2C::PoiList { pois: self.poi_list(), zones: zone_infos() });
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
                        if refund == 0 {
                            continue;
                        }
                        let leftover = inv::add_items(&mut player.inventory.slots, kind, refund);
                        if leftover > 0 {
                            inv::add_items(&mut player.stash.slots, kind, leftover);
                        }
                        // Inputs were burned when the job was queued; the
                        // refund re-mints them to the leaving player.
                        self.ledger.record(
                            TxKind::Mint,
                            TxParty::Mint,
                            player_party(&player),
                            TxAmount::Item { kind, count: refund },
                            0,
                        );
                    }
                }
            }
            self.econ_subs.remove(&entity);
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
            C2S::Vendor { vendor, action } => self.vendor_action(entity, vendor, action),
            C2S::EconomySub { on } => self.economy_sub(entity, on),
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
                    "cash" => ItemKind::Cash,
                    _ => {
                        let _ = player.tx.send(S2C::Error { message: format!("unknown item {item}") });
                        return;
                    }
                };
                inv::add_items(&mut player.inventory.slots, kind, count);
                player.dirty = true;
                self.ledger.record(
                    TxKind::Mint,
                    TxParty::Mint,
                    player_party(player),
                    TxAmount::Item { kind, count },
                    0,
                );
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
        let weapon = player.inventory.active_weapon_kind();
        let stats = weapon.and_then(weapon_stats).unwrap_or(FIST);

        // Ranged weapons consume ammo (each round fired burns out of supply).
        if stats.ranged {
            let removed = inv::remove_items(&mut player.inventory.slots, ItemKind::Ammo9mm, 1);
            if removed == 0 {
                let _ = player.tx.send(S2C::Error { message: "out of ammo".into() });
                return;
            }
            self.ledger.record(
                TxKind::Burn,
                player_party(player),
                TxParty::Burn,
                TxAmount::Item { kind: ItemKind::Ammo9mm, count: 1 },
                0,
            );
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
                // The dead agent's inventory becomes its loot drop; every
                // pickup is then a ledger transfer from this agent.
                let items = std::mem::take(&mut npc.inventory);
                Some((npc.position, npc.archetype.variant == 2, items, npc_party(npc)))
            } else {
                // Getting shot provokes the NPC even from beyond its passive
                // aggro radius, so sniping draws retaliation.
                if self.players.contains_key(&attacker) {
                    npc.provoke(attacker);
                }
                // Brief hit-stun: the NPC flinches in place before resuming.
                npc.stun_timer = crate::npc::HIT_STUN_SECONDS;
                npc.anim = AnimState::Hit;
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
        if let Some((drop_pos, is_raider, items, agent)) = died_info {
            self.broadcast_combat(CombatEvent::EntityDied { id: target });
            self.grant_xp(attacker, if is_raider { XP_RAIDER_KILL } else { XP_SCAV_KILL });
            self.ledger.npc_kills += 1;
            // The agent's spawn-minted inventory drops where it fell; the
            // items stay owned by (attributed to) the dead agent until
            // someone picks them up or the container expires.
            self.spawn_loot(drop_pos, items, Some(agent), true);
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

    /// Drop a loot container. `owner` is the ledger party the contents are
    /// attributed to on pickup; `in_supply` is false when the contents no
    /// longer count toward circulating supply (death drops, seeded caches).
    fn spawn_loot(
        &mut self,
        position: Vec3,
        items: Vec<ItemStack>,
        owner: Option<TxParty>,
        in_supply: bool,
    ) {
        if items.is_empty() {
            return;
        }
        let entity = self.alloc_entity();
        self.loot.insert(
            entity,
            LootContainer {
                entity,
                position,
                items,
                ttl: LOOT_TTL_SECONDS,
                variant: 0,
                owner,
                in_supply,
            },
        );
    }

    /// A persistent, highlighted cache of ammo placed in the world. Uses an
    /// infinite TTL so scattered supplies stay put until a player grabs them.
    /// World-seeded stock enters supply when a player picks it up.
    fn spawn_ammo_cache(&mut self, position: Vec3, count: u32) {
        let entity = self.alloc_entity();
        self.loot.insert(
            entity,
            LootContainer {
                entity,
                position,
                items: vec![ItemStack { kind: ItemKind::Ammo9mm, count }],
                ttl: f32::INFINITY,
                variant: 1,
                owner: None,
                in_supply: false,
            },
        );
    }

    /// Record every stack a player pulled out of a loot container: a transfer
    /// from the container's owner when the items are still in supply, or a
    /// (re-)mint when they aren't (death drops, world-seeded caches).
    fn record_loot_pickup(
        &mut self,
        picker: TxParty,
        owner: Option<TxParty>,
        in_supply: bool,
        taken: &[ItemStack],
    ) {
        for stack in taken {
            let from = owner.clone().unwrap_or(TxParty::Mint);
            let kind = if owner.is_some() { TxKind::LootPickup } else { TxKind::Mint };
            let effect = if in_supply { SupplyEffect::Auto } else { SupplyEffect::Mint };
            self.ledger.record_ex(
                kind,
                from,
                picker.clone(),
                TxAmount::Item { kind: stack.kind, count: stack.count },
                0,
                effect,
            );
        }
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
            let mut taken: Vec<ItemStack> = Vec::new();
            for stack in container.items.drain(..) {
                let rem = inv::add_items(&mut player.inventory.slots, stack.kind, stack.count);
                if stack.count > rem {
                    taken.push(ItemStack { kind: stack.kind, count: stack.count - rem });
                }
                if rem > 0 {
                    leftovers.push(ItemStack { kind: stack.kind, count: rem });
                }
            }
            // Nothing fit at all: the pickup was denied outright.
            let denied = taken.is_empty() && !leftovers.is_empty();
            container.items = leftovers;
            let owner = container.owner.clone();
            let in_supply = container.in_supply;
            player.dirty = true;
            let picker = player_party(player);
            let _ = player.tx.send(S2C::InventoryUpdate(player.inventory.clone()));
            let _ = player.tx.send(S2C::GatherResult { gained: taken.clone(), denied });
            if self.loot.get(&target).is_some_and(|c| c.items.is_empty()) {
                self.loot.remove(&target);
            }
            self.record_loot_pickup(picker, owner, in_supply, &taken);
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
            let rolled = self.rng.random_range(2..=5u32);
            // Enemy-held ground taxes what you can carry out of it.
            let enemy = self.territory.get(&region_of(node.position)) == Some(&CONTROL_ENEMY);
            let count = apply_territory_tax(rolled, enemy);
            let leftover = inv::add_items(&mut player.inventory.slots, kind, count);
            let gained = count - leftover;
            if gained > 0 {
                self.ledger.record(
                    TxKind::Mint,
                    TxParty::Mint,
                    player_party(player),
                    TxAmount::Item { kind, count: gained },
                    0,
                );
            }
            let mut gained_stacks = Vec::new();
            if gained > 0 {
                gained_stacks.push(ItemStack { kind, count: gained });
            }
            // Rare blueprint fragments feed Laboratory research (Phase 3).
            if self.rng.random_bool(FRAGMENT_CHANCE)
                && inv::add_items(&mut player.inventory.slots, ItemKind::BlueprintFragment, 1) == 0
            {
                self.ledger.record(
                    TxKind::Mint,
                    TxParty::Mint,
                    player_party(player),
                    TxAmount::Item { kind: ItemKind::BlueprintFragment, count: 1 },
                    0,
                );
                gained_stacks.push(ItemStack { kind: ItemKind::BlueprintFragment, count: 1 });
            }
            player.dirty = true;
            let denied = gained_stacks.is_empty() && count > 0;
            let _ = player.tx.send(S2C::GatherResult { gained: gained_stacks, denied });
            let _ = player.tx.send(S2C::InventoryUpdate(player.inventory.clone()));
            return;
        }

        // Static entity (extraction point / stash terminal)?
        let Some(static_entity) = self.statics.get(&target) else { return };
        let kind = static_entity.kind;
        let pos = static_entity.position;
        let Some(player) = self.players.get_mut(&entity) else { return };
        // Service buildings render as 6x4 m storefronts around their entity
        // position, so allow interacting from their street side.
        if (pos - player.character.position).length() > 5.0 {
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
            EntityKind::Armory | EntityKind::Bodega | EntityKind::Bank | EntityKind::Dealership => {
                self.send_vendor_state(entity, target);
            }
            EntityKind::Safehouse => {
                let _ = player.tx.send(S2C::Chat {
                    from: "system".into(),
                    text: "Safehouse: hostiles won't follow you in here.".into(),
                });
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
                && (s.position - player.character.position).length() < 5.0
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
        let crafter = player_party(player);
        for &(kind, count) in recipe.inputs {
            inv::remove_items(&mut player.inventory.slots, kind, count);
            self.ledger.record(
                TxKind::CraftConsume,
                crafter.clone(),
                TxParty::Burn,
                TxAmount::Item { kind, count },
                0,
            );
        }
        let (out_kind, out_count) = recipe.output;
        let leftover = inv::add_items(&mut player.inventory.slots, out_kind, out_count);
        player.dirty = true;
        self.ledger.record(
            TxKind::CraftProduce,
            TxParty::Mint,
            crafter.clone(),
            TxAmount::Item { kind: out_kind, count: out_count },
            0,
        );
        let produced = ItemStack { kind: out_kind, count: out_count - leftover };
        let _ = player.tx.send(S2C::CraftResult { ok: true, error: None, produced: Some(produced) });
        let _ = player.tx.send(S2C::InventoryUpdate(player.inventory.clone()));
        if leftover > 0 {
            let pos = player.character.position;
            self.spawn_loot(
                pos,
                vec![ItemStack { kind: out_kind, count: leftover }],
                Some(crafter),
                true,
            );
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
                        && (s.position - p.character.position).length() < 5.0
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
        let researcher = player_party(player);
        self.ledger.record(
            TxKind::CraftConsume,
            researcher.clone(),
            TxParty::Burn,
            TxAmount::Item { kind: ItemKind::BlueprintFragment, count: RESEARCH_FRAGMENTS },
            0,
        );
        for &(kind, count) in RESEARCH_RESOURCES {
            inv::remove_items(&mut player.inventory.slots, kind, count);
            self.ledger.record(
                TxKind::CraftConsume,
                researcher.clone(),
                TxParty::Burn,
                TxAmount::Item { kind, count },
                0,
            );
        }
        player.blueprints.insert(recipe.id.to_string());
        self.ledger.blueprints_learned += 1;
        self.ledger.record(
            TxKind::CraftProduce,
            TxParty::Mint,
            researcher,
            TxAmount::Blueprint { recipe: recipe.id.to_string() },
            0,
        );
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
        if (pos - player.character.position).length() > 5.0 {
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
        let producer = player_party(player);
        for &(k, c) in recipe.inputs {
            inv::remove_items(&mut player.inventory.slots, k, c * count);
            self.ledger.record(
                TxKind::CraftConsume,
                producer.clone(),
                TxParty::Burn,
                TxAmount::Item { kind: k, count: c * count },
                0,
            );
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
                            self.ledger.record(
                                TxKind::CraftProduce,
                                TxParty::Mint,
                                TxParty::Player {
                                    id: player.character.id,
                                    name: player.character.name.clone(),
                                },
                                TxAmount::Item { kind, count },
                                0,
                            );
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
        for (pid, pos, stack) in completions {
            if stack.count > 0 {
                let owner = self.players.get(&pid).map(player_party);
                self.spawn_loot(pos, vec![stack], owner, true);
            }
        }
    }

    // -----------------------------------------------------------------------
    // Territory
    // -----------------------------------------------------------------------

    fn territory_cells(&self) -> Vec<TerritoryCell> {
        self.territory
            .iter()
            .map(|(&(rx, rz), &control)| TerritoryCell { rx, rz, control })
            .collect()
    }

    fn broadcast_territory(&self) {
        let cells = self.territory_cells();
        for p in self.players.values() {
            let _ = p.tx.send(S2C::TerritoryState { cells: cells.clone() });
        }
    }

    /// True when the region at `pos` is currently enemy-controlled (taxed).
    fn region_taxed(&self, pos: Vec3) -> bool {
        self.territory.get(&region_of(pos)) == Some(&CONTROL_ENEMY)
    }

    /// Recompute presence-based control for regions with any activity. A region
    /// flips to the enemy when living hostiles dominate it, to the players when
    /// they are present and hold the numbers, else it relaxes to neutral.
    fn tick_territory(&mut self) {
        if self.tick % TERRITORY_TICK_INTERVAL != 0 {
            return;
        }
        let mut npc_count: HashMap<(i32, i32), usize> = HashMap::new();
        for npc in self.npcs.values() {
            if npc.state == wilder_ai::NpcState::Dead {
                continue;
            }
            *npc_count.entry(region_of(npc.position)).or_default() += 1;
        }
        let mut player_count: HashMap<(i32, i32), usize> = HashMap::new();
        for p in self.players.values() {
            if p.character.health <= 0.0 {
                continue;
            }
            *player_count.entry(region_of(p.character.position)).or_default() += 1;
        }

        let mut regions: HashSet<(i32, i32)> = HashSet::new();
        regions.extend(npc_count.keys().copied());
        regions.extend(player_count.keys().copied());
        regions.extend(self.territory.keys().copied());

        let mut changed = false;
        for r in regions {
            let cur = self.territory.get(&r).copied().unwrap_or(CONTROL_NEUTRAL);
            let desired = if region_is_protected(r) {
                CONTROL_NEUTRAL
            } else {
                let npc = npc_count.get(&r).copied().unwrap_or(0);
                let plr = player_count.get(&r).copied().unwrap_or(0);
                if npc >= CAPTURE_MIN && npc > plr {
                    CONTROL_ENEMY
                } else if plr > 0 && plr >= npc {
                    CONTROL_PLAYER
                } else {
                    CONTROL_NEUTRAL
                }
            };
            if desired != cur {
                if desired == CONTROL_NEUTRAL {
                    self.territory.remove(&r);
                } else {
                    self.territory.insert(r, desired);
                }
                changed = true;
            }
        }
        if changed {
            self.broadcast_territory();
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

    /// The market trades as an agent: the terminal's identity, or a stable
    /// fallback when no terminal is seeded (never in practice).
    fn market_party(&self) -> TxParty {
        self.statics
            .values()
            .find(|s| s.kind == EntityKind::MarketTerminal)
            .map(static_party)
            .unwrap_or(TxParty::Agent {
                id: static_agent_id(self.seed, 0),
                name: "Market".into(),
            })
    }

    fn apply_market_action(&mut self, entity: EntityId, action: MarketAction) -> Result<(), String> {
        let market_agent = self.market_party();
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
                // Escrow: the listed items move onto the market agent.
                self.ledger.record(
                    TxKind::MarketList,
                    player_party(player),
                    market_agent,
                    TxAmount::Item { kind, count },
                    0,
                );
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
                let buyer_party = player_party(buyer);
                let leftover = inv::add_items(&mut buyer.inventory.slots, kind, count);
                buyer.dirty = true;
                let _ = self.store.update_wallet(buyer_account, self.players[&entity].wallet);
                if leftover > 0 {
                    self.spawn_loot(
                        buyer_pos,
                        vec![ItemStack { kind, count: leftover }],
                        Some(buyer_party.clone()),
                        true,
                    );
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
                // Ledger: escrowed items leave the market agent for the
                // buyer; the buyer's WILD splits into seller proceeds and
                // the market fee (routed to territory holders or burned).
                let seller_party = TxParty::Player { id: seller, name: seller_name };
                self.ledger.record(
                    TxKind::MarketBuy,
                    market_agent.clone(),
                    buyer_party.clone(),
                    TxAmount::Item { kind, count },
                    fee,
                );
                self.ledger.record(
                    TxKind::MarketBuy,
                    buyer_party.clone(),
                    seller_party,
                    TxAmount::Wild { amount: proceeds },
                    fee,
                );
                if fee > 0 {
                    self.ledger.record(
                        TxKind::Fee,
                        buyer_party,
                        market_agent.clone(),
                        TxAmount::Wild { amount: fee },
                        0,
                    );
                }
                self.ledger.trades += 1;

                let l = &mut self.market[idx];
                l.count -= count;
                if l.count == 0 {
                    self.market.remove(idx);
                }
                self.save_market();

                // The market's fee is commerce: whoever holds the terminal's
                // territory takes it, otherwise it burns as before.
                let terminal = self
                    .statics
                    .values()
                    .find(|s| {
                        s.kind == EntityKind::MarketTerminal
                            && (s.position - buyer_pos).length() < 5.0
                    })
                    .map(|s| s.position);
                if let Some(terminal_pos) = terminal {
                    self.distribute_commerce(terminal_pos, fee, market_agent, false);
                } else if fee > 0 {
                    // No terminal in reach: the collected fee burns outright.
                    self.ledger.record(
                        TxKind::Fee,
                        market_agent,
                        TxParty::Burn,
                        TxAmount::Wild { amount: fee },
                        0,
                    );
                }
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
                let canceller = player_party(player);
                // Escrow returns from the market agent to the seller.
                self.ledger.record(
                    TxKind::MarketCancel,
                    market_agent,
                    canceller.clone(),
                    TxAmount::Item { kind: listing.kind, count: listing.count },
                    0,
                );
                if leftover > 0 {
                    self.spawn_loot(
                        pos,
                        vec![ItemStack { kind: listing.kind, count: leftover }],
                        Some(canceller),
                        true,
                    );
                }
                self.save_market();
                Ok(())
            }
        }
    }

    // -----------------------------------------------------------------------
    // NPC vendors & bank
    // -----------------------------------------------------------------------

    fn send_vendor_state(&self, entity: EntityId, vendor: EntityId) {
        let (Some(player), Some(station)) =
            (self.players.get(&entity), self.statics.get(&vendor))
        else {
            return;
        };
        let offers: Vec<VendorOffer> = wilder_economy::vendor_offers(station.kind)
            .iter()
            .map(|e| VendorOffer { kind: e.kind, buy: e.buy, sell: e.sell })
            .collect();
        let _ = player.tx.send(S2C::VendorState {
            vendor,
            kind: station.kind,
            offers,
            wallet: player.wallet,
        });
    }

    fn vendor_action(&mut self, entity: EntityId, vendor: EntityId, action: VendorAction) {
        let result = self.apply_vendor_action(entity, vendor, action);
        if let Some(player) = self.players.get(&entity) {
            let _ = player.tx.send(S2C::VendorResult {
                ok: result.is_ok(),
                error: result.err(),
            });
            let _ = player.tx.send(S2C::InventoryUpdate(player.inventory.clone()));
        }
        self.send_vendor_state(entity, vendor);
    }

    fn apply_vendor_action(
        &mut self,
        entity: EntityId,
        vendor: EntityId,
        action: VendorAction,
    ) -> Result<(), String> {
        let (kind, pos, vendor_agent) = self
            .statics
            .get(&vendor)
            .map(|s| (s.kind, s.position, static_party(s)))
            .ok_or("no such vendor")?;
        {
            let player = self.players.get(&entity).ok_or("not in world")?;
            if (pos - player.character.position).length() > 5.0 {
                return Err("too far away".into());
            }
        }
        match action {
            VendorAction::Refresh => Ok(()),
            VendorAction::Buy { kind: item, count } => {
                let offer = wilder_economy::vendor_offers(kind)
                    .iter()
                    .find(|e| e.kind == item && e.buy > 0)
                    .ok_or("not sold here")?;
                let count = count.clamp(1, 100);
                let cost = offer.buy.saturating_mul(count);
                let player = self.players.get_mut(&entity).ok_or("not in world")?;
                if player.wallet < cost {
                    return Err(format!("need {cost} WILD, have {}", player.wallet));
                }
                player.wallet -= cost;
                let account = player.character.account_id;
                let wallet = player.wallet;
                let player_pos = player.character.position;
                let buyer = player_party(player);
                let leftover = inv::add_items(&mut player.inventory.slots, item, count);
                player.dirty = true;
                let _ = self.store.update_wallet(account, wallet);
                // Ledger: WILD moves onto the vendor agent; the stock the
                // vendor hands over is fresh issuance (bottomless shelves).
                self.ledger.record(
                    TxKind::VendorBuy,
                    buyer.clone(),
                    vendor_agent.clone(),
                    TxAmount::Wild { amount: cost },
                    0,
                );
                self.ledger.record_ex(
                    TxKind::VendorBuy,
                    vendor_agent.clone(),
                    buyer.clone(),
                    TxAmount::Item { kind: item, count },
                    0,
                    SupplyEffect::Mint,
                );
                if leftover > 0 {
                    self.spawn_loot(
                        player_pos,
                        vec![ItemStack { kind: item, count: leftover }],
                        Some(buyer),
                        true,
                    );
                }
                // Whoever holds this ground skims a cut; the rest burns.
                self.distribute_commerce(
                    pos,
                    cost * wilder_economy::COMMERCE_CUT_PCT / 100,
                    vendor_agent,
                    false,
                );
                Ok(())
            }
            VendorAction::Sell { kind: item, count } => {
                let offer = wilder_economy::vendor_offers(kind)
                    .iter()
                    .find(|e| e.kind == item && e.sell > 0)
                    .ok_or("not bought here")?;
                let player = self.players.get_mut(&entity).ok_or("not in world")?;
                let have = inv::count_items(&player.inventory.slots, item);
                if have == 0 {
                    return Err(format!("no {} to sell", item.display_name()));
                }
                let count = count.clamp(1, have);
                inv::remove_items(&mut player.inventory.slots, item, count);
                let gross = offer.sell.saturating_mul(count);
                let cut = gross * wilder_economy::COMMERCE_CUT_PCT / 100;
                player.wallet += gross - cut;
                let account = player.character.account_id;
                let wallet = player.wallet;
                let seller = player_party(player);
                player.dirty = true;
                let _ = self.store.update_wallet(account, wallet);
                // Ledger: sold items are absorbed out of supply; the payout
                // comes off the vendor agent's balance.
                self.ledger.record_ex(
                    TxKind::VendorSell,
                    seller.clone(),
                    vendor_agent.clone(),
                    TxAmount::Item { kind: item, count },
                    0,
                    SupplyEffect::Burn,
                );
                self.ledger.record(
                    TxKind::VendorSell,
                    vendor_agent.clone(),
                    seller,
                    TxAmount::Wild { amount: gross - cut },
                    cut,
                );
                self.distribute_commerce(pos, cut, vendor_agent, false);
                Ok(())
            }
            VendorAction::Convert { count } => {
                if kind != EntityKind::Bank {
                    return Err("only a Bank converts Cash".into());
                }
                let player = self.players.get_mut(&entity).ok_or("not in world")?;
                let have = inv::count_items(&player.inventory.slots, ItemKind::Cash);
                if have == 0 {
                    return Err("no Cash to convert".into());
                }
                let count = count.clamp(1, have);
                inv::remove_items(&mut player.inventory.slots, ItemKind::Cash, count);
                let fee = count * wilder_economy::BANK_FEE_PCT / 100;
                player.wallet += count - fee;
                let account = player.character.account_id;
                let wallet = player.wallet;
                let converter = player_party(player);
                player.dirty = true;
                let _ = self.store.update_wallet(account, wallet);
                // Ledger: Cash burns out of supply and WILD mints in its
                // place (minus the fee, routed below as commerce).
                self.ledger.record_ex(
                    TxKind::BankConvert,
                    converter.clone(),
                    vendor_agent.clone(),
                    TxAmount::Item { kind: ItemKind::Cash, count },
                    fee,
                    SupplyEffect::Burn,
                );
                self.ledger.record_ex(
                    TxKind::BankConvert,
                    vendor_agent.clone(),
                    converter,
                    TxAmount::Wild { amount: count - fee },
                    fee,
                    SupplyEffect::Mint,
                );
                // The bank's fee is the commerce that territory holders skim.
                self.distribute_commerce(pos, fee, vendor_agent, true);
                Ok(())
            }
        }
    }

    /// Route a commerce cut to whoever holds the territory it happened in:
    /// split evenly among alive players standing in a player-held region
    /// (presence is control in this phase). Neutral or enemy ground burns it,
    /// as do rounding remainders.
    ///
    /// Ledger: `from` is the agent routing the cut. When `minted` is true the
    /// cut is new WILD (bank conversion fee) — paid shares are mint legs and
    /// unrouted WILD simply never enters supply; otherwise the cut is real
    /// WILD the agent collected, so unrouted amounts burn.
    fn distribute_commerce(&mut self, pos: Vec3, cut: u32, from: TxParty, minted: bool) {
        if cut == 0 {
            return;
        }
        // Anything not paid out either burns (real WILD) or is never minted.
        let mut unrouted = cut;
        let region = region_of(pos);
        if self.territory.get(&region) == Some(&CONTROL_PLAYER) {
            let holders: Vec<EntityId> = self
                .players
                .values()
                .filter(|p| {
                    p.character.health > 0.0 && region_of(p.character.position) == region
                })
                .map(|p| p.entity)
                .collect();
            let share = if holders.is_empty() { 0 } else { cut / holders.len() as u32 };
            if share > 0 {
                for id in holders {
                    let Some(player) = self.players.get_mut(&id) else { continue };
                    player.wallet += share;
                    unrouted -= share;
                    let account = player.character.account_id;
                    let wallet = player.wallet;
                    let holder = player_party(player);
                    let _ = self.store.update_wallet(account, wallet);
                    self.ledger.record_ex(
                        TxKind::Fee,
                        from.clone(),
                        holder,
                        TxAmount::Wild { amount: share },
                        0,
                        if minted { SupplyEffect::Mint } else { SupplyEffect::Auto },
                    );
                    let _ = player.tx.send(S2C::Chat {
                        from: "system".into(),
                        text: format!("+{share} WILD — commerce cut from territory you hold"),
                    });
                }
            }
        }
        if unrouted > 0 && !minted {
            self.ledger.record(
                TxKind::Fee,
                from,
                TxParty::Burn,
                TxAmount::Wild { amount: unrouted },
                0,
            );
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
            self.ledger.record(
                TxKind::Burn,
                player_party(player),
                TxParty::Burn,
                TxAmount::Item { kind: ItemKind::Medkit, count: 1 },
                0,
            );
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
            InventoryAction::Equip { slot, weapon_slot } => {
                inv::equip(&mut player.inventory, slot as usize, weapon_slot.unwrap_or(0));
            }
            InventoryAction::Unequip { weapon, weapon_slot } => {
                inv::unequip(&mut player.inventory, weapon, weapon_slot.unwrap_or(0));
            }
            InventoryAction::SelectWeapon { weapon_slot } => {
                player.inventory.active_weapon = weapon_slot.min(1);
            }
            InventoryAction::Drop { slot } => {
                if let Some(s) = player.inventory.slots.get_mut(slot as usize) {
                    if let Some(stack) = s.take() {
                        let pos = player.character.position;
                        let dropper = player_party(player);
                        // Dropping keeps ownership: the tx is a self-transfer
                        // and the container stays attributed to the dropper.
                        self.ledger.record(
                            TxKind::Drop,
                            dropper.clone(),
                            dropper.clone(),
                            TxAmount::Item { kind: stack.kind, count: stack.count },
                            0,
                        );
                        let items = vec![stack];
                        // Defer loot spawn until after borrow ends.
                        let _ = player.tx.send(S2C::InventoryUpdate(player.inventory.clone()));
                        player.dirty = true;
                        self.spawn_loot(pos, items, Some(dropper), true);
                        return;
                    }
                }
            }
            InventoryAction::Destroy { slot } => {
                if let Some(s) = player.inventory.slots.get_mut(slot as usize) {
                    if let Some(stack) = s.take() {
                        // Destroyed items leave the world for good: burn them
                        // on the ledger, attributed to the destroyer.
                        let owner = player_party(player);
                        self.ledger.record(
                            TxKind::Burn,
                            owner,
                            TxParty::Burn,
                            TxAmount::Item { kind: stack.kind, count: stack.count },
                            0,
                        );
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
                && (s.position - player.character.position).length() < 5.0
        })
    }

    // -----------------------------------------------------------------------
    // Tick systems
    // -----------------------------------------------------------------------

    fn step(&mut self) {
        self.tick += 1;
        self.ledger.set_tick(self.tick);

        self.apply_movement();
        self.tick_extraction();
        self.tick_npcs();
        self.tick_loot();
        self.tick_nodes();
        self.tick_production();
        self.tick_territory();
        self.tick_regen();
        self.update_interest();
        self.replicate();
        self.flush_economy();

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
            // Extracting from enemy-held territory forfeits part of the haul.
            let taxed = self
                .players
                .get(&entity)
                .map(|p| self.region_taxed(p.character.position))
                .unwrap_or(false);
            let Some(player) = self.players.get_mut(&entity) else { continue };
            player.extracting = None;
            let extractor = player_party(player);
            // Bank everything carried into the stash.
            let mut banked: Vec<ItemStack> = Vec::new();
            for slot in player.inventory.slots.iter_mut() {
                if let Some(stack) = slot.take() {
                    let bankable = apply_territory_tax(stack.count, taxed);
                    // The territory tax seizes (burns) part of the haul.
                    if stack.count > bankable {
                        self.ledger.record(
                            TxKind::Burn,
                            extractor.clone(),
                            TxParty::Burn,
                            TxAmount::Item { kind: stack.kind, count: stack.count - bankable },
                            0,
                        );
                    }
                    let rem = inv::add_items(&mut player.stash.slots, stack.kind, bankable);
                    let banked_count = bankable - rem;
                    if banked_count > 0 {
                        banked.push(ItemStack { kind: stack.kind, count: banked_count });
                        // Extraction is a self-transfer: backpack -> stash.
                        self.ledger.record(
                            TxKind::Extract,
                            extractor.clone(),
                            extractor.clone(),
                            TxAmount::Item { kind: stack.kind, count: banked_count },
                            0,
                        );
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

    /// Positions of every Safehouse building (a handful at most).
    fn safehouse_positions(&self) -> Vec<Vec3> {
        self.statics
            .values()
            .filter(|s| s.kind == EntityKind::Safehouse)
            .map(|s| s.position)
            .collect()
    }

    fn tick_npcs(&mut self) {
        // Respawns and AI. Players sheltering inside a safehouse bubble are
        // invisible to hostiles: they can't be targeted or chased.
        let safehouses = self.safehouse_positions();
        let player_positions: Vec<(EntityId, Vec3)> = self
            .players
            .values()
            .filter(|p| p.character.health > 0.0)
            .filter(|p| {
                !safehouses
                    .iter()
                    .any(|s| (*s - p.character.position).length() < SAFEHOUSE_RADIUS)
            })
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
                    // A respawn is a brand-new agent: fresh identity and a
                    // freshly minted inventory (the old agent's items are
                    // in its death drop, not carried over).
                    let (agent_id, agent_name) = mint_agent_identity(npc.archetype);
                    npc.agent_id = agent_id;
                    npc.agent_name = agent_name;
                    let zone = zone_of_chunk(ChunkCoord::from_world(npc.home));
                    npc.inventory =
                        roll_npc_loot(&mut self.rng, zone, npc.archetype.variant == 2);
                    let agent = npc_party(npc);
                    for stack in &npc.inventory {
                        self.ledger.record(
                            TxKind::Mint,
                            TxParty::Mint,
                            agent.clone(),
                            TxAmount::Item { kind: stack.kind, count: stack.count },
                            0,
                        );
                    }
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
        // Ledger: everything in the backpack burns out of supply on death.
        // The physical drop is salvage — whoever picks it up re-mints it,
        // attributed as a transfer from the dead player.
        let victim = player_party(player);
        for stack in &dropped {
            self.ledger.record(
                TxKind::Burn,
                victim.clone(),
                TxParty::Burn,
                TxAmount::Item { kind: stack.kind, count: stack.count },
                0,
            );
        }
        self.ledger.deaths += 1;
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
        self.spawn_loot(drop_pos, dropped, Some(victim), false);
        self.persist_player_entity(target);
    }

    fn tick_loot(&mut self) {
        // Auto-pickup: walking within range of an ammo cache grabs it instantly.
        let mut grabbed: Vec<(EntityId, EntityId)> = Vec::new();
        for player in self.players.values() {
            for container in self.loot.values() {
                if container.variant != 1 {
                    continue;
                }
                if (container.position - player.character.position).length() <= AMMO_PICKUP_RADIUS {
                    grabbed.push((player.entity, container.entity));
                }
            }
        }
        for (pid, cid) in grabbed {
            let (Some(container), Some(player)) =
                (self.loot.get_mut(&cid), self.players.get_mut(&pid))
            else {
                continue;
            };
            let mut leftovers = Vec::new();
            let mut taken: Vec<ItemStack> = Vec::new();
            for stack in container.items.drain(..) {
                let rem = inv::add_items(&mut player.inventory.slots, stack.kind, stack.count);
                if stack.count > rem {
                    taken.push(ItemStack { kind: stack.kind, count: stack.count - rem });
                }
                if rem > 0 {
                    leftovers.push(ItemStack { kind: stack.kind, count: rem });
                }
            }
            let empty = leftovers.is_empty();
            container.items = leftovers;
            let owner = container.owner.clone();
            let in_supply = container.in_supply;
            let picker = player_party(player);
            // Auto-pickup never sends `denied`: a full backpack next to a
            // cache would spam the toast every tick.
            if !taken.is_empty() {
                player.dirty = true;
                let _ = player.tx.send(S2C::InventoryUpdate(player.inventory.clone()));
                let _ = player.tx.send(S2C::GatherResult { gained: taken.clone(), denied: false });
            }
            if empty {
                self.loot.remove(&cid);
            }
            self.record_loot_pickup(picker, owner, in_supply, &taken);
        }

        let mut expired = Vec::new();
        for container in self.loot.values_mut() {
            container.ttl -= TICK_DT;
            if container.ttl <= 0.0 {
                expired.push(container.entity);
            }
        }
        for id in expired {
            let Some(container) = self.loot.remove(&id) else { continue };
            // Unclaimed loot rots out of the world: burn what was still in
            // supply, attributed to whoever owned it last.
            if container.in_supply {
                let from = container.owner.unwrap_or(TxParty::Mint);
                for stack in container.items {
                    self.ledger.record(
                        TxKind::Burn,
                        from.clone(),
                        TxParty::Burn,
                        TxAmount::Item { kind: stack.kind, count: stack.count },
                        0,
                    );
                }
            }
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
        let safehouses = self.safehouse_positions();
        for player in self.players.values_mut() {
            let coord = ChunkCoord::from_world(player.character.position);
            let sheltered = is_safe_chunk(coord)
                || safehouses
                    .iter()
                    .any(|s| (*s - player.character.position).length() < SAFEHOUSE_RADIUS);
            if sheltered && player.character.health < player.character.max_health {
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
    // Economy ledger (K dashboard)
    // -----------------------------------------------------------------------

    fn agents_alive(&self) -> u32 {
        self.npcs.values().filter(|n| n.alive()).count() as u32
    }

    /// Subscribe/unsubscribe a player to live ledger updates. Subscribing
    /// answers with a full snapshot (stats + the recent-tx ring).
    fn economy_sub(&mut self, entity: EntityId, on: bool) {
        if !on {
            self.econ_subs.remove(&entity);
            return;
        }
        let stats = self.ledger.stats(self.players.len() as u32, self.agents_alive());
        let recent = self.ledger.recent();
        if let Some(player) = self.players.get(&entity) {
            let _ = player.tx.send(S2C::EconomyState { stats, recent });
            self.econ_subs.insert(entity);
        }
    }

    /// Push the tick's new transactions (plus refreshed stats) to subscribers.
    fn flush_economy(&mut self) {
        if !self.ledger.has_pending() {
            return;
        }
        let txs = self.ledger.take_pending();
        self.econ_subs.retain(|id| self.players.contains_key(id));
        if self.econ_subs.is_empty() {
            return;
        }
        let stats = self.ledger.stats(self.players.len() as u32, self.agents_alive());
        for id in &self.econ_subs {
            if let Some(player) = self.players.get(id) {
                let _ = player.tx.send(S2C::EconomyTxs { txs: txs.clone(), stats: stats.clone() });
            }
        }
    }

    // -----------------------------------------------------------------------
    // Streaming / replication
    // -----------------------------------------------------------------------

    /// Place every spawn-district service building and hostile-ring outpost.
    /// Runs once at world start (before any player joins) so the POI list is
    /// always complete and positions never depend on who streamed what first.
    fn seed_district(&mut self) {
        let placements = || DISTRICT.iter().chain(OUTPOSTS.iter());
        let mut chunk_order: Vec<(i32, i32)> = Vec::new();
        for &(c, _, _) in placements() {
            if !chunk_order.contains(&c) {
                chunk_order.push(c);
            }
        }
        for c in chunk_order {
            let stations: Vec<(EntityKind, &str)> = placements()
                .filter(|&&(cc, _, _)| cc == c)
                .map(|&(_, kind, name)| (kind, name))
                .collect();
            let coord = ChunkCoord::new(c.0, c.1);
            let chunk = self.chunks.get(coord);
            let spots = station_spots(&chunk, coord, stations.len());
            if spots.len() < stations.len() {
                tracing::warn!(?coord, "chunk too cramped for all district buildings");
            }
            for (&(kind, name), pos) in stations.iter().zip(spots) {
                let entity = self.alloc_entity();
                self.statics.insert(
                    entity,
                    StaticEntity {
                        entity,
                        kind,
                        position: pos,
                        name: name.into(),
                        variant: 0,
                        agent_id: static_agent_id(self.seed, entity),
                    },
                );
            }
        }
    }

    /// Every persistent service building, for the map/legend UI. Extraction
    /// points are excluded: they seed lazily and replicate like entities.
    fn poi_list(&self) -> Vec<PoiInfo> {
        let mut pois: Vec<PoiInfo> = self
            .statics
            .values()
            .filter(|s| s.kind != EntityKind::ExtractionPoint)
            .map(|s| PoiInfo {
                id: s.entity,
                kind: s.kind,
                name: s.name.clone(),
                x: s.position.x,
                z: s.position.z,
            })
            .collect();
        pois.sort_by_key(|p| p.id);
        pois
    }

    fn seed_chunk_content(&mut self, coord: ChunkCoord) {
        // NPCs in hostile chunks.
        if !is_safe_chunk(coord) && !self.npc_seeded_chunks.contains(&coord) {
            self.npc_seeded_chunks.insert(coord);
            let chunk = self.chunks.get(coord);
            let zone = zone_of_chunk(coord);
            for (archetype, pos) in npc_spawns_for_chunk(coord, &chunk) {
                let entity = self.alloc_entity();
                let mut npc = Npc::new(entity, archetype, pos);
                // Agents spawn with their inventory minted to them, so what
                // they drop on death was theirs all along.
                npc.inventory = roll_npc_loot(&mut self.rng, zone, archetype.variant == 2);
                let agent = npc_party(&npc);
                for stack in &npc.inventory {
                    self.ledger.record(
                        TxKind::Mint,
                        TxParty::Mint,
                        agent.clone(),
                        TxAmount::Item { kind: stack.kind, count: stack.count },
                        0,
                    );
                }
                self.npcs.insert(entity, npc);
            }
        }
        // Static entities: extraction points (service buildings are seeded
        // eagerly by `seed_district` at world start).
        if !self.static_seeded_chunks.contains(&coord) {
            self.static_seeded_chunks.insert(coord);
            // Resource nodes: roughly every other hostile chunk gets one,
            // yielding whatever its zone favors (mining ground -> metals...).
            let nh = (coord.x.wrapping_mul(198491317) ^ coord.z.wrapping_mul(6542989)) as u32;
            if !is_safe_chunk(coord) && nh % 2 == 0 {
                let chunk = self.chunks.get(coord);
                let variant = wilder_economy::zone_resource_index(zone_of_chunk(coord), nh >> 8) as u32;
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
                                    agent_id: static_agent_id(self.seed, entity),
                                },
                            );
                            break 'find;
                        }
                    }
                }
            }
            // Ammo caches everywhere (including the safe hub) so ammo is easy
            // to find and obvious. Persistent until looted.
            let chunk = self.chunks.get(coord);
            for pos in ammo_cache_spots(&chunk, coord, AMMO_CACHE_COUNT) {
                self.spawn_ammo_cache(pos, AMMO_CACHE_ROUNDS);
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
                    name: if container.variant == 1 { "Ammo Cache".into() } else { "Loot".into() },
                    appearance: Appearance::default(),
                    position: container.position,
                    yaw: 0.0,
                    anim: AnimState::Idle,
                    health_pct: 1.0,
                    variant: container.variant,
                    // Biggest stack decides the floating icon.
                    item: container
                        .items
                        .iter()
                        .max_by_key(|s| s.count)
                        .map(|s| s.kind),
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
                    item: None,
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
                    item: None,
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
        // Ledger aggregates (supply counters, KPI totals) survive restarts.
        if let Err(e) = self.store.save_meta("econ_ledger", &self.ledger.save()) {
            tracing::error!("ledger save failed: {e}");
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zone_ring_octants() {
        // Cardinal directions map to their themed zones (+Z = south).
        assert_eq!(zone_of_chunk(ChunkCoord::new(4, 0)), ZoneKind::BlownUp); // E
        assert_eq!(zone_of_chunk(ChunkCoord::new(0, 4)), ZoneKind::Mining); // S
        assert_eq!(zone_of_chunk(ChunkCoord::new(-4, 0)), ZoneKind::Overgrowth); // W
        assert_eq!(zone_of_chunk(ChunkCoord::new(0, -4)), ZoneKind::Industrial); // N
        assert_eq!(zone_of_chunk(ChunkCoord::new(4, 4)), ZoneKind::ChemPlant); // SE
        assert_eq!(zone_of_chunk(ChunkCoord::new(-4, 4)), ZoneKind::Scrapyard); // SW
        assert_eq!(zone_of_chunk(ChunkCoord::new(4, -4)), ZoneKind::TechRuins); // NE
        assert_eq!(zone_of_chunk(ChunkCoord::new(-4, -4)), ZoneKind::Mixed); // NW
        // The safe hub and the far city are unbiased.
        assert_eq!(zone_of_chunk(ChunkCoord::new(0, 0)), ZoneKind::Mixed);
        assert_eq!(zone_of_chunk(ChunkCoord::new(1, 1)), ZoneKind::Mixed);
        assert_eq!(zone_of_chunk(ChunkCoord::new(40, 0)), ZoneKind::Mixed);
    }

    #[test]
    fn district_covers_every_service() {
        use std::collections::HashSet;
        let kinds: HashSet<EntityKind> = DISTRICT.iter().map(|&(_, k, _)| k).collect();
        for kind in [
            EntityKind::Building,
            EntityKind::Refinery,
            EntityKind::Factory,
            EntityKind::Laboratory,
            EntityKind::MarketTerminal,
            EntityKind::Armory,
            EntityKind::Bank,
            EntityKind::Bodega,
            EntityKind::Dealership,
            EntityKind::Safehouse,
        ] {
            assert!(kinds.contains(&kind), "{kind:?} missing from the spawn district");
        }
        // Every district building sits inside the safe hub.
        for &((x, z), _, _) in DISTRICT {
            assert!(is_safe_chunk(ChunkCoord::new(x, z)));
        }
        // Outposts sit on capturable (unprotected, hostile) ground.
        for &((x, z), _, _) in OUTPOSTS {
            let coord = ChunkCoord::new(x, z);
            assert!(!is_safe_chunk(coord));
            let region = (x.div_euclid(REGION_CHUNKS), z.div_euclid(REGION_CHUNKS));
            assert!(!region_is_protected(region));
        }
    }

    #[test]
    fn district_placements_have_room() {
        // Every district/outpost chunk on the baked map yields enough
        // walkable, spread-out spots for its buildings.
        let generator = TerrainGenerator::new(0);
        for &(c, _, _) in DISTRICT.iter().chain(OUTPOSTS.iter()) {
            let coord = ChunkCoord::new(c.0, c.1);
            let chunk = generator.generate(coord);
            let wanted = DISTRICT
                .iter()
                .chain(OUTPOSTS.iter())
                .filter(|&&(cc, _, _)| cc == c)
                .count();
            let spots = station_spots(&chunk, coord, wanted);
            assert_eq!(spots.len(), wanted, "chunk {coord:?} too cramped");
            for pos in &spots {
                assert_eq!(ChunkCoord::from_world(*pos), coord);
            }
        }
    }

    #[test]
    fn join_always_arms_the_player() {
        // No weapon anywhere: grant an equipped pistol.
        let mut inv = Inventory::new();
        ensure_starting_weapon(&mut inv);
        assert_eq!(inv.equipped_weapon, Some(ItemKind::Pistol));
        assert_eq!(inv.active_weapon, 0);

        // Weapon carried but not equipped: auto-equip it (no free pistol).
        let mut inv = Inventory::new();
        inv.slots[3] = Some(ItemStack { kind: ItemKind::Knife, count: 1 });
        ensure_starting_weapon(&mut inv);
        assert_eq!(inv.equipped_weapon, Some(ItemKind::Knife));
        assert!(inv.slots[3].is_none());

        // Only Weapon 2 filled but hand on empty Weapon 1: snap the hand over.
        let mut inv = Inventory::new();
        inv.equipped_weapon2 = Some(ItemKind::Smg);
        ensure_starting_weapon(&mut inv);
        assert_eq!(inv.equipped_weapon2, Some(ItemKind::Smg));
        assert_eq!(inv.active_weapon, 1);

        // Already armed: untouched.
        let mut inv = Inventory::new();
        inv.equipped_weapon = Some(ItemKind::Pipe);
        inv.active_weapon = 0;
        ensure_starting_weapon(&mut inv);
        assert_eq!(inv.equipped_weapon, Some(ItemKind::Pipe));
        assert_eq!(inv.equipped_weapon2, None);
    }

    #[test]
    fn bank_and_commerce_math() {
        // Bank conversion: 10% fee floor-divides in the house's favor.
        let count = 95u32;
        let fee = count * wilder_economy::BANK_FEE_PCT / 100;
        assert_eq!(fee, 9);
        assert_eq!(count - fee, 86);
        // Territory tax still reduces yields only on enemy ground.
        assert_eq!(apply_territory_tax(100, true), 75);
        assert_eq!(apply_territory_tax(100, false), 100);
    }
}
