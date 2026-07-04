//! The authoritative world simulation.
//!
//! Runs as a single tokio task at TICK_HZ. WebSocket connections talk to it
//! through a command channel; it replies through per-player message channels.

pub mod agents;
mod chunks;
pub mod districts;
pub mod factions;
pub mod interiors;
mod ledger;
mod npc;
pub mod stats;

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
use agents::{
    base_value, guild_for, mint_agent_name, AgentEvent, AgentSave, FactionAgent, Goal, Role,
    TargetInfo, Tier, AGENT_RESPAWN_SECONDS, COLD_BUCKETS, HOT_RADIUS_CHUNKS,
    RETALIATION_SECONDS, RETREAT_HEALTH_PCT, WEALTH_RETREAT,
};
use factions::{are_hostile, faction_registry};
use ledger::{Ledger, LedgerSave, SupplyEffect};
use npc::{mint_agent_identity, npc_spawns_for_chunk, Npc};
use stats::{build_leaderboard, ActorRef, LiveActor, StatsBook};
use smallvec::SmallVec;

pub const TICK_HZ: u32 = 20;
pub const TICK_DT: f32 = 1.0 / TICK_HZ as f32;
/// Persist characters/chunks every this many ticks (10 s).
const SAVE_INTERVAL_TICKS: u64 = 200;
/// Default spawn: on the road corner of chunk (0,0), always walkable.
const SPAWN: Vec3 = Vec3::new(3.0, 0.0, 3.0);
/// Combat-patrol staging spot in the hub's contested combat ring: outside the
/// protected chunks (|chunk| <= SAFE_RADIUS) but well inside the ring, so the
/// faction war stays visible on the starter playfield around spawn.
const HUB_FRONT_SPOT: Vec3 = Vec3::new(120.0, 0.0, 120.0);
/// Hub-cohort staging grounds: opposite corners of the combat ring, outside
/// the protected 3x3 but a short walk from the hub services and the front.
/// Rebels take the south-east corner (matching their southern geography),
/// Forum the north-west.
const HUB_STAGE_REBELS: Vec3 = Vec3::new(180.0, 0.0, 180.0);
const HUB_STAGE_FORUM: Vec3 = Vec3::new(-180.0, 0.0, -180.0);
/// Version stamp for the seeded agent distribution. Bump when the seeding
/// layout changes so persisted worlds discard the old population and reseed.
const AGENT_SEED_LAYOUT: u32 = 2;
/// Chunks with |x|<=SAFE_RADIUS and |z|<=SAFE_RADIUS are the safe hub.
const SAFE_RADIUS: i32 = 1;
/// Seconds an extraction channel takes.
const EXTRACT_SECONDS: f32 = 5.0;
/// NPC respawn delay after death, seconds.
const NPC_RESPAWN_SECONDS: f32 = 45.0;
/// Loot containers despawn after this long, seconds.
const LOOT_TTL_SECONDS: f32 = 120.0;
/// Loose currency pickups (coins/shards/energy) despawn after this long.
const CURRENCY_PICKUP_TTL: f32 = 60.0;
/// Currency pickups auto-collect when a player walks within this distance.
const CURRENCY_PICKUP_RADIUS: f32 = 1.6;
/// Static ammo caches scattered through every chunk. Kept off the roads
/// (pedestrian tiles only, see `ammo_cache_spots`) and dialed back so ammo is
/// findable but not everywhere; count per chunk and rounds per cache.
const AMMO_CACHE_COUNT: usize = 3;
const AMMO_CACHE_ROUNDS: u32 = 12;
/// Loot (ammo caches, NPC/player drops) is grabbed automatically when a
/// player walks within this distance (metres) - no click required. Click
/// pickup only works with a free cursor, which mouse-look play never has.
const LOOT_PICKUP_RADIUS: f32 = 2.0;
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

/// Territory control is a `FactionId` per region (`FACTION_NEUTRAL` = free).
/// The wire encoding in `wilder_protocol::TerritoryCell` carries the id raw.
///
/// Minimum presence for a faction to capture a region on agents alone;
/// a living player of the faction anchors a capture by themselves.
const CAPTURE_MIN: u32 = 3;
/// Fraction (percent) of gathered/extracted yield seized in enemy regions.
const TERRITORY_TAX_PCT: u32 = 25;
/// Recompute territory occupancy every N ticks (20 Hz -> ~1 Hz).
const TERRITORY_TICK_INTERVAL: u64 = 20;
/// Refresh leaderboards for economy subscribers every N ticks (~5 s).
const LEADERBOARD_TICK_INTERVAL: u64 = 100;
/// Stream whole-map intel blips to map subscribers every N ticks (~5 Hz) so
/// actor motion on the open map reads as smooth, live movement.
const MAP_INTEL_TICK_INTERVAL: u64 = 4;

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

/// World-space center of a territory region (for danger/district lookups).
fn region_center(r: (i32, i32)) -> Vec3 {
    let side = REGION_CHUNKS as f32 * CHUNK_SIZE;
    Vec3::new((r.0 as f32 + 0.5) * side, 0.0, (r.1 as f32 + 0.5) * side)
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

/// Ledger party for a player character (players are Rebels for now).
fn player_party(p: &Player) -> TxParty {
    TxParty::Player {
        id: p.character.id,
        name: p.character.name.clone(),
        faction: FACTION_REBELS,
    }
}

/// Leaderboard identity for a player (usable while `p` is mutably borrowed
/// out of the players map, unlike `World::actor_ref`).
fn player_actor(p: &Player) -> ActorRef {
    ActorRef {
        id: p.character.id,
        name: p.character.name.clone(),
        faction: FACTION_REBELS,
        guild: None,
        is_player: true,
    }
}

/// Leaderboard identity behind a ledger party (system endpoints and vendor
/// services don't compete; guild resolution is left to the caller's row).
fn party_actor(p: &TxParty) -> Option<ActorRef> {
    match p {
        TxParty::Player { id, name, faction } => Some(ActorRef {
            id: *id,
            name: name.clone(),
            faction: *faction,
            guild: None,
            is_player: true,
        }),
        TxParty::Agent { id, name, faction } => Some(ActorRef {
            id: *id,
            name: name.clone(),
            faction: *faction,
            guild: None,
            is_player: false,
        }),
        TxParty::Mint | TxParty::Burn => None,
    }
}

/// Ledger party for an NPC agent (wild NPCs are the Wapes faction).
fn npc_party(n: &Npc) -> TxParty {
    TxParty::Agent { id: n.agent_id, name: n.agent_name.clone(), faction: FACTION_WAPES }
}

/// Ledger party for a service building (vendor / bank / market terminal).
/// Services trade with everyone, so they stay neutral.
fn static_party(s: &StaticEntity) -> TxParty {
    TxParty::Agent { id: s.agent_id, name: s.name.clone(), faction: FACTION_NEUTRAL }
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
    // Resources drop biased by the zone the NPC lives in. Pull count is
    // randomized (raiders carry a bit more) so pile size varies kill-to-kill.
    let pulls = if is_raider {
        rng.random_range(2..=3)
    } else {
        rng.random_range(1..=2)
    };
    for _ in 0..pulls {
        let idx = wilder_economy::zone_resource_index(zone, rng.random());
        let kind = wilder_economy::RESOURCES[idx];
        items.push(ItemStack { kind, count: rng.random_range(1..=5) });
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

/// Minimum spacing between service locations, meters (two doors on the same
/// building face stay far enough apart that their signs never overlap).
const MIN_DOOR_SEP: f32 = 4.0 * TILE_SIZE;

/// Door spots for a chunk: the sidewalk tile outside every tile of every
/// building's street face (-z side, matching the client's procedural
/// storefront convention). Service locations dock to these so each one
/// lives in a real storefront. Road tiles and sliver footprints (chunk-cut
/// building edges under 2 tiles wide) are skipped.
fn door_spots(chunk: &ChunkData, coord: ChunkCoord) -> Vec<Vec3> {
    let mut out = Vec::new();
    for b in &chunk.buildings {
        if b.tz0 == 0 || b.tx1.saturating_sub(b.tx0) < 2 {
            continue; // front row outside the chunk, or a sliver slice
        }
        let tz = b.tz0 as usize - 1;
        for tx in (b.tx0 as usize)..(b.tx1 as usize).min(TILES_PER_CHUNK) {
            let kind = chunk.tile(tx, tz);
            if !kind.walkable() || matches!(kind, TileKind::Road | TileKind::RoadLine) {
                continue;
            }
            out.push(Vec3::new(
                coord.x as f32 * CHUNK_SIZE + (tx as f32 + 0.5) * TILE_SIZE,
                0.0,
                coord.z as f32 * CHUNK_SIZE + (tz as f32 + 0.5) * TILE_SIZE,
            ));
        }
    }
    out
}

/// "FLASHING LIGHTS" -> "Flashing Lights", for service display names.
fn title_case(name: &str) -> String {
    name.split_whitespace()
        .map(|w| {
            let mut chars = w.chars();
            match chars.next() {
                Some(first) => {
                    first.to_uppercase().collect::<String>() + &chars.as_str().to_lowercase()
                }
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Nearest unused door to `target`, keeping MIN_DOOR_SEP from taken spots.
fn pick_door(doors: &[Vec3], used: &[Vec3], target: Vec3) -> Option<Vec3> {
    let mut best: Option<(f32, Vec3)> = None;
    for &door in doors {
        if used.iter().any(|&u| (u - door).length() < MIN_DOOR_SEP) {
            continue;
        }
        let dist = (door - target).length();
        if best.map(|(b, _)| dist < b).unwrap_or(true) {
            best = Some((dist, door));
        }
    }
    best.map(|(_, door)| door)
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
    /// Cached salvage currency (write-through to the store).
    shards: u32,
    /// Cached charge currency (write-through to the store).
    energy: u32,
    /// Last (wild, shards, energy) sent as a WalletUpdate; None forces the
    /// initial send after join. Checked once per tick in replicate().
    wallet_sent: Option<(u32, u32, u32)>,
    /// Subscribed to whole-map agent blips (map open). Recorded now; the
    /// MapIntel stream itself ships in Phase 5.
    #[allow(dead_code)]
    map_intel: bool,
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
            faction: FACTION_REBELS,
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

/// A minted currency that can drop as a loose, collectible pickup.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Currency {
    Wild,
    Shards,
    Energy,
}

impl Currency {
    /// Replicated `variant` index the client uses to pick the pickup's look.
    fn variant(self) -> u32 {
        match self {
            Currency::Wild => 0,
            Currency::Shards => 1,
            Currency::Energy => 2,
        }
    }
}

/// Loose currency scattered on death; grants its amount when a player walks
/// over it, then despawns. Purely a faucet (minted on pickup).
struct CurrencyPickup {
    entity: EntityId,
    position: Vec3,
    currency: Currency,
    amount: u32,
    ttl: f32,
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
    /// Loose currency dropped on death, auto-collected on walk-over.
    pickups: HashMap<EntityId, CurrencyPickup>,
    statics: HashMap<EntityId, StaticEntity>,
    /// World-space room rect `[minx, minz, maxx, maxz]` of each service
    /// entity's walk-in interior (entities without a carved room are absent).
    /// Interacting from anywhere inside the room is allowed.
    interior_bounds: HashMap<EntityId, [f32; 4]>,
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
    /// Non-neutral territory control per region: which faction holds it.
    /// Persisted in world meta so the war map survives restarts.
    territory: HashMap<(i32, i32), FactionId>,
    /// Territory changed since the last save.
    territory_dirty: bool,
    /// Economy transaction ledger + supply counters (K dashboard).
    ledger: Ledger,
    /// Per-competitor stats + faction/guild lifetime totals (leaderboards).
    stats: StatsBook,
    /// Players subscribed to live ledger updates.
    econ_subs: HashSet<EntityId>,
    /// Autonomous faction agents (index-stable; identity swaps on respawn).
    agents: Vec<FactionAgent>,
    /// Live entity id -> agents index, for combat/target lookups.
    agent_by_entity: HashMap<EntityId, usize>,
    /// Spatial hash over alive agents, rebuilt every tick.
    agent_grid: HashMap<ChunkCoord, SmallVec<[u32; 4]>>,
    /// Budgeted A* queue: agent indices waiting for a `find_path` grant.
    agent_path_queue: std::collections::VecDeque<usize>,
    /// (attacker, victim) pairs from recent damage; grants the victim's side
    /// retaliation rights in Guarded districts. Values are seconds remaining.
    recent_attacks: HashMap<(EntityId, EntityId), f32>,
    /// One staging position per district (a walkable spot near the district's
    /// service cluster), filled by `seed_neighborhood_stores`.
    district_spots: Vec<Vec3>,
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
    // War map: which faction holds each region survives restarts too.
    let territory: HashMap<(i32, i32), FactionId> = store
        .meta::<Vec<(i32, i32, FactionId)>>("territory")
        .ok()
        .flatten()
        .unwrap_or_default()
        .into_iter()
        .map(|(x, z, f)| ((x, z), f))
        .collect();
    // Leaderboard stats book (per-competitor records + lifetime rollups).
    let stats: StatsBook = store.meta("stats_book").ok().flatten().unwrap_or_default();

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
        pickups: HashMap::new(),
        statics: HashMap::new(),
        interior_bounds: HashMap::new(),
        nodes: HashMap::new(),
        static_seeded_chunks: HashSet::new(),
        next_entity: 1,
        tick: 0,
        seed,
        rng: SmallRng::seed_from_u64(seed ^ 0xC0FFEE),
        rx,
        territory,
        territory_dirty: false,
        ledger: Ledger::new(ledger_save),
        stats,
        econ_subs: HashSet::new(),
        agents: Vec::new(),
        agent_by_entity: HashMap::new(),
        agent_grid: HashMap::new(),
        agent_path_queue: std::collections::VecDeque::new(),
        recent_attacks: HashMap::new(),
        district_spots: Vec::new(),
    };
    // Seed the spawn district up front so PoiList is complete on every join.
    world.seed_district();
    // Every named neighborhood gets its own service cluster.
    world.seed_neighborhood_stores();
    // Carve walk-in interiors into every service's host building (collision
    // door gaps + room walls; the client mirrors this from replicated data).
    world.register_interiors();
    // Faction agents: restore the persisted population or seed a fresh one.
    world.load_or_seed_agents();
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
        let (mut wallet, shards, energy) = self
            .store
            .account_by_id(account)
            .map(|a| (a.wallet, a.shards, a.energy))
            .unwrap_or((0, 0, 0));
        let grant_key = format!("wallet_granted_{account}");
        let granted: bool = self.store.meta(&grant_key).ok().flatten().unwrap_or(false);
        if !granted {
            wallet += WALLET_GRANT;
            let _ = self.store.update_wallet(account, wallet);
            let _ = self.store.save_meta(&grant_key, &true);
            self.ledger.record(
                TxKind::Mint,
                TxParty::Mint,
                TxParty::Player {
                    id: character.id,
                    name: character.name.clone(),
                    faction: FACTION_REBELS,
                },
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
            shards,
            energy,
            wallet_sent: None,
            map_intel: false,
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
        let _ = tx.send(S2C::PoiList {
            pois: self.poi_list(),
            zones: zone_infos(),
            factions: faction_registry(),
            districts: districts::district_infos(),
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
                match find_path(&self.chunks.nav(), from, Vec3::new(x, 0.0, z)) {
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
            C2S::MapIntelSub { on } => {
                if let Some(player) = self.players.get_mut(&entity) {
                    player.map_intel = on;
                }
                if on {
                    // Answer immediately so the map never opens blank.
                    let blips = self.map_intel_blips();
                    if let Some(player) = self.players.get(&entity) {
                        let _ = player.tx.send(S2C::MapIntel { blips });
                    }
                }
            }
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

        // Attackable targets: NPCs plus embodied (hot) faction agents.
        let candidates: Vec<(EntityId, Vec3)> = self
            .npcs
            .values()
            .filter(|n| n.alive())
            .map(|n| (n.entity, n.position))
            .chain(
                self.agents
                    .iter()
                    .filter(|a| a.tier == Tier::Hot && a.alive())
                    .map(|a| (a.entity, a.position)),
            )
            .collect();

        // Find the target hit, tracking where the attack terminated (impact,
        // blocking wall, or max range) for client VFX.
        let mut hit: Option<(EntityId, f32)> = None;
        let mut end = origin + dir * stats.range;
        if stats.ranged {
            // Hitscan: analytic ray-vs-target test (nearest target within a
            // cylinder around the ray), so hits don't depend on sampling
            // luck against moving targets.
            const HIT_RADIUS: f32 = 0.9;
            let mut best_t = f32::INFINITY;
            for &(target, position) in &candidates {
                let to = position - origin;
                let along = to.dot(dir);
                if along < 0.3 || along > stats.range + HIT_RADIUS {
                    continue;
                }
                let perp = (to - dir * along).length();
                if perp < HIT_RADIUS && along < best_t {
                    best_t = along;
                    hit = Some((target, attack_damage));
                    end = position;
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
            // Melee: nearest alive target in range within a generous frontal arc.
            let mut best: Option<(EntityId, f32)> = None;
            for &(target, position) in &candidates {
                let to = position - origin;
                let dist = to.length();
                if dist <= stats.range + 0.4 {
                    let facing = to.normalize().dot(dir);
                    if facing > 0.2 && best.map(|(_, d)| dist < d).unwrap_or(true) {
                        best = Some((target, dist));
                        end = position;
                    }
                }
            }
            hit = best.map(|(id, _)| (id, attack_damage));
        }

        let attacker = entity;
        if broadcast_flash {
            self.broadcast_combat(CombatEvent::MuzzleFlash { attacker, tx: end.x, tz: end.z });
        }
        let landed = match hit {
            Some((target, damage)) => {
                let impact = Vec3::new(end.x, 1.25, end.z);
                self.deal_damage(attacker, target, damage, Some(impact))
            }
            None => false,
        };
        if !landed {
            self.broadcast_combat(CombatEvent::Miss { attacker, x: end.x, z: end.z });
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
                // Knock nearby NPCs and hot agents back, then apply damage.
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
                for agent in self.agents.iter_mut() {
                    if agent.tier != Tier::Hot || !agent.alive() {
                        continue;
                    }
                    let to = agent.position - origin;
                    if to.length() > SHOCKWAVE_RADIUS {
                        continue;
                    }
                    let dir = if to.length_squared() > 1e-6 {
                        to.normalize()
                    } else {
                        Vec3::new(1.0, 0.0, 0.0)
                    };
                    agent.position = step_move_speed(
                        &self.chunks,
                        agent.position,
                        dir.x,
                        dir.z,
                        SHOCKWAVE_KNOCKBACK,
                        1.0,
                    );
                    targets.push(agent.entity);
                }
                for target in targets {
                    let impact = self
                        .entity_position(target)
                        .map(|p| Vec3::new(p.x, 1.0, p.z))
                        .unwrap_or(origin);
                    self.deal_damage(entity, target, SHOCKWAVE_DAMAGE, Some(impact));
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
            // Leaderboards: credit the killer, debit the Wape's faction.
            let killer = self.actor_ref(attacker);
            if let Some(victim) = party_actor(&agent) {
                self.stats.record_kill(killer.as_ref(), &victim);
            }
            // The agent's spawn-minted inventory scatters where it fell as
            // separate pickups; items stay owned by (attributed to) the dead
            // agent until picked up or the containers expire.
            self.spawn_loot_scattered(drop_pos, items, Some(agent), true);
            // Loose currency spills out alongside the crate: a random handful
            // of WILD coins (raiders carry more), plus an occasional shard and
            // energy cell. These are walk-over collectibles (minted faucet).
            use rand::Rng;
            let coins = if is_raider {
                self.rng.random_range(2..=3)
            } else {
                self.rng.random_range(1..=2)
            };
            for _ in 0..coins {
                let amount = self.rng.random_range(1..=3);
                self.spawn_currency_pickup(drop_pos, Currency::Wild, amount);
            }
            if self.rng.random_bool(if is_raider { 0.5 } else { 0.25 }) {
                let shards = self.rng.random_range(1..=2);
                self.spawn_currency_pickup(drop_pos, Currency::Shards, shards);
            }
            if self.rng.random_bool(0.1) {
                self.spawn_currency_pickup(drop_pos, Currency::Energy, 1);
            }
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

    /// Drop each stack as its own loot container, jittered around `position`,
    /// so a kill scatters distinct pickups (one object per resource/material/
    /// item) instead of a single mixed crate. Each is grabbed - and cued -
    /// separately on walk-over.
    fn spawn_loot_scattered(
        &mut self,
        position: Vec3,
        items: Vec<ItemStack>,
        owner: Option<TxParty>,
        in_supply: bool,
    ) {
        use rand::Rng;
        for stack in items {
            let jitter = Vec3::new(
                self.rng.random_range(-2.4..=2.4),
                0.0,
                self.rng.random_range(-2.4..=2.4),
            );
            let entity = self.alloc_entity();
            self.loot.insert(
                entity,
                LootContainer {
                    entity,
                    position: position + jitter,
                    items: vec![stack],
                    ttl: LOOT_TTL_SECONDS,
                    variant: 0,
                    owner: owner.clone(),
                    in_supply,
                },
            );
        }
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

    /// Grant Shards (salvage currency): bump the cached balance, mint it on
    /// the ledger, and write through to the account store. The client's
    /// WalletUpdate goes out on the next replicate pass.
    fn grant_shards(&mut self, entity: EntityId, amount: u32) {
        if amount == 0 {
            return;
        }
        let Some(player) = self.players.get_mut(&entity) else { return };
        player.shards += amount;
        let to = player_party(player);
        let account = player.character.account_id;
        let (shards, energy) = (player.shards, player.energy);
        self.ledger.record(TxKind::Mint, TxParty::Mint, to, TxAmount::Shards { amount }, 0);
        let _ = self.store.update_currencies(account, shards, energy);
    }

    /// Grant Energy (charge currency); see `grant_shards`.
    fn grant_energy(&mut self, entity: EntityId, amount: u32) {
        if amount == 0 {
            return;
        }
        let Some(player) = self.players.get_mut(&entity) else { return };
        player.energy += amount;
        let to = player_party(player);
        let account = player.character.account_id;
        let (shards, energy) = (player.shards, player.energy);
        self.ledger.record(TxKind::Mint, TxParty::Mint, to, TxAmount::Energy { amount }, 0);
        let _ = self.store.update_currencies(account, shards, energy);
    }

    /// Grant wallet WILD (minted faucet); see `grant_shards`. Used for the
    /// loose coin pickups dropped on death.
    fn grant_wild(&mut self, entity: EntityId, amount: u32) {
        if amount == 0 {
            return;
        }
        let Some(player) = self.players.get_mut(&entity) else { return };
        player.wallet += amount;
        let to = player_party(player);
        let account = player.character.account_id;
        let wallet = player.wallet;
        self.ledger.record(TxKind::Mint, TxParty::Mint, to, TxAmount::Wild { amount }, 0);
        let _ = self.store.update_wallet(account, wallet);
    }

    /// Grant currency by kind (routes to the matching faucet helper).
    fn grant_currency(&mut self, entity: EntityId, currency: Currency, amount: u32) {
        match currency {
            Currency::Wild => self.grant_wild(entity, amount),
            Currency::Shards => self.grant_shards(entity, amount),
            Currency::Energy => self.grant_energy(entity, amount),
        }
    }

    /// Drop a loose currency pickup, jittered around `position` so multiple
    /// drops from one kill read as separate collectibles on the ground.
    fn spawn_currency_pickup(&mut self, position: Vec3, currency: Currency, amount: u32) {
        use rand::Rng;
        if amount == 0 {
            return;
        }
        let entity = self.alloc_entity();
        let jitter = Vec3::new(
            self.rng.random_range(-1.8..=1.8),
            0.0,
            self.rng.random_range(-1.8..=1.8),
        );
        self.pickups.insert(
            entity,
            CurrencyPickup {
                entity,
                position: position + jitter,
                currency,
                amount,
                ttl: CURRENCY_PICKUP_TTL,
            },
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
            let variant = container.variant;
            player.dirty = true;
            let picker = player_party(player);
            let _ = player.tx.send(S2C::InventoryUpdate(player.inventory.clone()));
            let _ = player.tx.send(S2C::GatherResult { gained: taken.clone(), denied });
            if self.loot.get(&target).is_some_and(|c| c.items.is_empty()) {
                self.loot.remove(&target);
            }
            self.record_loot_pickup(picker, owner, in_supply, &taken);
            // Ammo caches carry a small Energy charge for whoever taps them.
            if variant == 1 && !taken.is_empty() {
                self.grant_energy(entity, 1);
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
            let rolled = self.rng.random_range(2..=5u32);
            // Hostile-held ground taxes what you can carry out of it.
            // (Field access, not the helper: `node` holds a &mut borrow.)
            let enemy = self
                .territory
                .get(&region_of(node.position))
                .is_some_and(|&h| are_hostile(h, FACTION_REBELS));
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
                self.stats.add_resources(&player_actor(player), gained as u64);
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
        let room = self.interior_bounds.get(&target).copied();
        let Some(player) = self.players.get_mut(&entity) else { return };
        // Service buildings are interactable from their street side (the
        // entity stands on the sidewalk by the door) or from anywhere inside
        // their walk-in room, whose counter sits well past the 5 m ring.
        let p = player.character.position;
        let near = (pos - p).length() <= 5.0;
        let inside = room.map_or(false, |[x0, z0, x1, z1]| {
            p.x >= x0 - 0.5 && p.x <= x1 + 0.5 && p.z >= z0 - 0.5 && p.z <= z1 + 0.5
        });
        if !near && !inside {
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
        self.stats.add_crafted(&player_actor(player), out_count as u64);
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
                                    faction: FACTION_REBELS,
                                },
                                TxAmount::Item { kind, count },
                                0,
                            );
                            self.stats.add_crafted(&player_actor(player), count as u64);
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

    /// True when the region at `pos` is held by a faction hostile to
    /// `faction` (that faction's members get taxed / cut out there).
    fn region_hostile_to(&self, pos: Vec3, faction: FactionId) -> bool {
        self.territory
            .get(&region_of(pos))
            .is_some_and(|&holder| are_hostile(holder, faction))
    }

    /// Recompute presence-based control for regions with any activity, per
    /// faction. Players anchor a capture for their faction by themselves;
    /// agents and wild Wapes need `CAPTURE_MIN` bodies and a strict majority
    /// (a Wape pack squatting a block turns it hostile ground for everyone).
    /// Sanctuary ground (and the protected hub) never flips; Guarded ground
    /// only ever lights up for its home faction.
    fn tick_territory(&mut self) {
        if self.tick % TERRITORY_TICK_INTERVAL != 0 {
            return;
        }
        // (bodies, players) per faction per region.
        let mut presence: HashMap<(i32, i32), HashMap<FactionId, (u32, u32)>> = HashMap::new();
        let mut add = |pos: Vec3, faction: FactionId, is_player: bool| {
            if faction == FACTION_NEUTRAL {
                return;
            }
            let entry = presence
                .entry(region_of(pos))
                .or_default()
                .entry(faction)
                .or_insert((0, 0));
            entry.0 += 1;
            entry.1 += is_player as u32;
        };
        for p in self.players.values() {
            if p.character.health > 0.0 {
                add(p.character.position, FACTION_REBELS, true);
            }
        }
        for npc in self.npcs.values() {
            if npc.alive() {
                add(npc.position, FACTION_WAPES, false);
            }
        }
        for agent in &self.agents {
            if agent.alive() {
                add(agent.position, agent.faction, false);
            }
        }

        let mut regions: HashSet<(i32, i32)> = HashSet::new();
        regions.extend(presence.keys().copied());
        regions.extend(self.territory.keys().copied());

        let mut changed = false;
        for r in regions {
            let cur = self.territory.get(&r).copied().unwrap_or(FACTION_NEUTRAL);
            let empty = HashMap::new();
            let counts = presence.get(&r).unwrap_or(&empty);
            let desired = if region_is_protected(r) {
                FACTION_NEUTRAL
            } else {
                let center = region_center(r);
                match districts::danger_at(center) {
                    DangerLevel::Sanctuary => FACTION_NEUTRAL,
                    // Home turf: lights up wherever the home faction stands,
                    // and no other faction can ever take it.
                    DangerLevel::Guarded => {
                        let home = districts::home_faction_at(center);
                        if counts.get(&home).map(|&(n, _)| n).unwrap_or(0) > 0 {
                            home
                        } else if cur == home {
                            cur // hold home turf once lit
                        } else {
                            FACTION_NEUTRAL
                        }
                    }
                    DangerLevel::Contested | DangerLevel::Warzone => {
                        let mut best: (FactionId, u32, u32) = (FACTION_NEUTRAL, 0, 0);
                        let mut second = 0u32;
                        for (&f, &(n, players)) in counts {
                            if n > best.1 {
                                second = best.1;
                                best = (f, n, players);
                            } else if n > second {
                                second = n;
                            }
                        }
                        let (winner, n, players) = best;
                        if n > second && (players > 0 || n >= CAPTURE_MIN) {
                            winner
                        } else if cur != FACTION_NEUTRAL
                            && counts.get(&cur).map(|&(n, _)| n).unwrap_or(0) > 0
                        {
                            cur // holder keeps it while still present
                        } else {
                            FACTION_NEUTRAL
                        }
                    }
                }
            };
            if desired != cur {
                if desired == FACTION_NEUTRAL {
                    self.territory.remove(&r);
                } else {
                    self.territory.insert(r, desired);
                }
                changed = true;
            }
        }
        if changed {
            self.territory_dirty = true;
            self.broadcast_territory();
        }
    }

    /// District control rollup: the faction holding the most regions whose
    /// centers fall in each district (ties/no-presence stay neutral).
    fn district_control(&self) -> Vec<FactionId> {
        let defs = districts::district_defs();
        let mut tallies: Vec<HashMap<FactionId, u32>> = vec![HashMap::new(); defs.len()];
        for (&r, &holder) in &self.territory {
            if let Some((di, _)) = districts::district_of(region_center(r)) {
                *tallies[di].entry(holder).or_default() += 1;
            }
        }
        tallies
            .into_iter()
            .map(|t| {
                let mut best = (FACTION_NEUTRAL, 0u32);
                let mut second = 0u32;
                for (f, n) in t {
                    if n > best.1 {
                        second = best.1;
                        best = (f, n);
                    } else if n > second {
                        second = n;
                    }
                }
                if best.1 > second { best.0 } else { FACTION_NEUTRAL }
            })
            .collect()
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
                faction: FACTION_NEUTRAL,
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

                // Credit the seller (minus the burn fee): online player,
                // offline player, or faction agent.
                let fee = cost * MARKET_FEE_PCT / 100;
                let proceeds = cost - fee;
                let _ = seller_name; // display name lives on the listing
                // Ledger: escrowed items leave the market agent for the
                // buyer; the buyer's WILD splits into seller proceeds and
                // the market fee (routed to territory holders or burned).
                let seller_party = self.credit_market_seller(seller, proceeds);
                // Leaderboards: both sides of a fill count a trade.
                if let Some(b) = party_actor(&buyer_party) {
                    self.stats.add_trade(&b);
                }
                if let Some(s) = party_actor(&seller_party) {
                    self.stats.add_trade(&s);
                }
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
    /// split evenly among the controlling faction's members standing in the
    /// region — players and faction agents alike. Neutral ground burns it,
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
        let controller = self.territory.get(&region).copied().unwrap_or(FACTION_NEUTRAL);
        if controller != FACTION_NEUTRAL {
            let holders: Vec<EntityId> = self
                .players
                .values()
                .filter(|p| {
                    controller == FACTION_REBELS
                        && p.character.health > 0.0
                        && region_of(p.character.position) == region
                })
                .map(|p| p.entity)
                .collect();
            let holder_agents: Vec<usize> = self
                .agents
                .iter()
                .enumerate()
                .filter(|(_, a)| {
                    a.alive() && a.faction == controller && region_of(a.position) == region
                })
                .map(|(i, _)| i)
                .collect();
            let total = holders.len() + holder_agents.len();
            let share = if total == 0 { 0 } else { cut / total as u32 };
            if share > 0 {
                let effect = if minted { SupplyEffect::Mint } else { SupplyEffect::Auto };
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
                        effect,
                    );
                    let _ = player.tx.send(S2C::Chat {
                        from: "system".into(),
                        text: format!("+{share} WILD — commerce cut from territory you hold"),
                    });
                }
                for idx in holder_agents {
                    let agent = &mut self.agents[idx];
                    agent.wallet += share;
                    unrouted -= share;
                    let holder = agent.party();
                    self.ledger.record_ex(
                        TxKind::Fee,
                        from.clone(),
                        holder,
                        TxAmount::Wild { amount: share },
                        0,
                        effect,
                    );
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
                        player.sync_shield();
                        player.dirty = true;
                        let _ = player.tx.send(S2C::InventoryUpdate(player.inventory.clone()));
                        // Salvage: destroying grants Shards scaled by how
                        // much space the stack occupied (bulk = value).
                        let gain = stack.count * stack.kind.slot_cost();
                        self.grant_shards(entity, gain);
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
        self.tick_agents();
        self.tick_loot();
        self.tick_nodes();
        self.tick_production();
        self.tick_territory();
        self.tick_regen();
        self.update_interest();
        self.replicate();
        self.flush_economy();
        // Leaderboards refresh for dashboard subscribers every ~5 s.
        if self.tick % LEADERBOARD_TICK_INTERVAL == 0 {
            self.broadcast_leaderboard();
        }
        // Whole-map intel for open maps, ~1 Hz.
        if self.tick % MAP_INTEL_TICK_INTERVAL == 0 {
            self.broadcast_map_intel();
        }

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
            // Extracting from hostile-held territory forfeits part of the haul.
            let taxed = self
                .players
                .get(&entity)
                .map(|p| self.region_hostile_to(p.character.position, FACTION_REBELS))
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
            // A completed extraction charges the runner's Energy reserve.
            self.grant_energy(entity, 5);
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
            // Same gated pipeline as every other attacker: Sanctuary ground
            // shields players from wild Wapes too.
            self.deal_damage(npc_entity, player_entity, damage, None);
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
            .or_else(|| self.players.get(&killer).map(|p| p.character.name.clone()))
            .or_else(|| {
                self.agent_by_entity
                    .get(&killer)
                    .map(|&i| self.agents[i].name.clone())
            });
        // Leaderboards: credit the killer, debit the fallen player.
        let killer_actor = self.actor_ref(killer);
        if let Some(victim_actor) = self.actor_ref(target) {
            self.stats.record_kill(killer_actor.as_ref(), &victim_actor);
        }
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

    // -----------------------------------------------------------------------
    // Generalized combat: any attacker -> any victim, danger/hostility gated
    // -----------------------------------------------------------------------

    /// Current position of any combat-capable entity (player/npc/agent).
    fn entity_position(&self, id: EntityId) -> Option<Vec3> {
        if let Some(p) = self.players.get(&id) {
            return Some(p.character.position);
        }
        if let Some(n) = self.npcs.get(&id) {
            return Some(n.position);
        }
        self.agent_by_entity.get(&id).map(|&i| self.agents[i].position)
    }

    /// (position, faction, alive) of a combat-capable entity.
    fn combatant(&self, id: EntityId) -> Option<(Vec3, FactionId, bool)> {
        if let Some(p) = self.players.get(&id) {
            return Some((p.character.position, FACTION_REBELS, p.character.health > 0.0));
        }
        if let Some(n) = self.npcs.get(&id) {
            // Wild NPCs fight under the Wapes faction (hostile to everyone).
            return Some((n.position, FACTION_WAPES, n.alive()));
        }
        self.agent_by_entity
            .get(&id)
            .map(|&i| &self.agents[i])
            .map(|a| (a.position, a.faction, a.alive()))
    }

    /// Whether `attacker` may damage `target` right now. Gated first by the
    /// victim's ground (Sanctuary blocks everything; Guarded ground only lets
    /// the home faction — or a retaliating victim — fight), then by faction
    /// hostility.
    fn damage_allowed(&self, attacker: EntityId, target: EntityId) -> bool {
        let Some((_, attacker_faction, attacker_alive)) = self.combatant(attacker) else {
            return false;
        };
        let Some((victim_pos, victim_faction, victim_alive)) = self.combatant(target) else {
            return false;
        };
        if !attacker_alive || !victim_alive {
            return false;
        }
        match districts::danger_at(victim_pos) {
            DangerLevel::Sanctuary => return false,
            DangerLevel::Guarded => {
                let home = districts::home_faction_at(victim_pos);
                let retaliating = self.recent_attacks.contains_key(&(target, attacker));
                if attacker_faction != home && !retaliating {
                    return false;
                }
            }
            DangerLevel::Contested | DangerLevel::Warzone => {}
        }
        are_hostile(attacker_faction, victim_faction)
    }

    /// The one damage entry point for every attacker/victim pairing. Returns
    /// whether damage was actually applied (false = gated off / bad target).
    fn deal_damage(
        &mut self,
        attacker: EntityId,
        target: EntityId,
        damage: f32,
        impact: Option<Vec3>,
    ) -> bool {
        if !self.damage_allowed(attacker, target) {
            return false;
        }
        // Grant the victim's side retaliation rights against this attacker.
        self.recent_attacks.insert((attacker, target), RETALIATION_SECONDS);
        let impact = impact
            .or_else(|| self.entity_position(target).map(|p| Vec3::new(p.x, 1.25, p.z)))
            .unwrap_or_default();
        if self.npcs.contains_key(&target) {
            self.damage_npc(attacker, target, damage, impact);
            true
        } else if self.players.contains_key(&target) {
            self.damage_player(attacker, target, damage);
            true
        } else if let Some(&idx) = self.agent_by_entity.get(&target) {
            self.damage_agent(attacker, idx, damage, impact);
            true
        } else {
            false
        }
    }

    fn damage_agent(&mut self, attacker: EntityId, idx: usize, damage: f32, impact: Vec3) {
        let (target, died) = {
            let agent = &mut self.agents[idx];
            if !agent.alive() {
                return;
            }
            agent.health -= damage;
            if agent.alive() {
                agent.react_to_damage(attacker);
                agent.anim = AnimState::Hit;
            }
            (agent.entity, !agent.alive())
        };
        self.broadcast_combat(CombatEvent::Hit {
            attacker,
            target,
            damage,
            x: impact.x,
            y: impact.y,
            z: impact.z,
        });
        if died {
            // Leaderboards first: kill_agent wipes nothing identity-wise,
            // but attribute against the identity that just fell.
            let killer = self.actor_ref(attacker);
            let victim = self.agent_actor_ref(idx);
            self.stats.record_kill(killer.as_ref(), &victim);
            // Hot-tier death: a real body drops real loot.
            self.kill_agent(idx, true);
            if self.players.contains_key(&attacker) {
                self.grant_xp(attacker, XP_RAIDER_KILL);
                self.ledger.npc_kills += 1;
            }
        }
    }

    /// Kill an agent. Hot deaths (`drop_loot`) leave a loot container and
    /// coin spill where the body fell; cold statistical deaths burn the
    /// carried goods outright. Either way the wallet burns, the ledger hears
    /// about everything, and a fresh identity respawns at the faction's
    /// Guarded home district after the timer.
    fn kill_agent(&mut self, idx: usize, drop_loot: bool) {
        let (entity, position, items, wallet, party) = {
            let agent = &mut self.agents[idx];
            agent.health = 0.0;
            agent.anim = AnimState::Death;
            agent.respawn_in = AGENT_RESPAWN_SECONDS;
            agent.goal = Goal::Idle;
            agent.path.clear();
            agent.path_request = None;
            let items = std::mem::take(&mut agent.inventory);
            let wallet = std::mem::take(&mut agent.wallet);
            (agent.entity, agent.position, items, wallet, agent.party())
        };
        // Carried items burn out of supply on death (the physical drop is
        // salvage, re-minted by whoever picks it up — same as player deaths).
        for stack in &items {
            self.ledger.record(
                TxKind::Burn,
                party.clone(),
                TxParty::Burn,
                TxAmount::Item { kind: stack.kind, count: stack.count },
                0,
            );
        }
        if wallet > 0 {
            self.ledger.record(
                TxKind::Burn,
                party.clone(),
                TxParty::Burn,
                TxAmount::Wild { amount: wallet },
                0,
            );
        }
        if drop_loot {
            self.broadcast_combat(CombatEvent::EntityDied { id: entity });
            self.spawn_loot_scattered(position, items, Some(party), false);
            use rand::Rng;
            let coins = self.rng.random_range(1..=3);
            for _ in 0..coins {
                let amount = self.rng.random_range(1..=3);
                self.spawn_currency_pickup(position, Currency::Wild, amount);
            }
        }
    }

    // -----------------------------------------------------------------------
    // Autonomous faction agents
    // -----------------------------------------------------------------------

    fn tick_agents(&mut self) {
        // Retaliation flags decay in real time.
        self.recent_attacks.retain(|_, t| {
            *t -= TICK_DT;
            *t > 0.0
        });

        // Hot/cold classification: every chunk within HOT_RADIUS of any
        // connected player is hot ground. Iterate players, not agents.
        let mut hot_chunks: HashSet<ChunkCoord> = HashSet::new();
        for p in self.players.values() {
            let c = ChunkCoord::from_world(p.character.position);
            for dz in -HOT_RADIUS_CHUNKS..=HOT_RADIUS_CHUNKS {
                for dx in -HOT_RADIUS_CHUNKS..=HOT_RADIUS_CHUNKS {
                    hot_chunks.insert(ChunkCoord::new(c.x + dx, c.z + dz));
                }
            }
        }

        // Rebuild the spatial hash and (re)classify tiers.
        self.agent_grid.clear();
        for (i, agent) in self.agents.iter_mut().enumerate() {
            if !agent.alive() {
                continue;
            }
            let chunk = agent.chunk();
            agent.tier = if hot_chunks.contains(&chunk) { Tier::Hot } else { Tier::Cold };
            self.agent_grid.entry(chunk).or_default().push(i as u32);
        }

        // Respawns: dead agents come back as a fresh identity at their
        // faction's Guarded home district.
        for idx in 0..self.agents.len() {
            if self.agents[idx].alive() {
                continue;
            }
            self.agents[idx].respawn_in -= TICK_DT;
            if self.agents[idx].respawn_in <= 0.0 {
                self.respawn_agent(idx);
            }
        }

        // Simulation slices: hot every tick at TICK_DT, cold once a second
        // from the bucket wheel.
        let cold_bucket = self.tick % COLD_BUCKETS;
        let mut events: Vec<(usize, AgentEvent)> = Vec::new();
        let mut decisions: Vec<usize> = Vec::new();
        for idx in 0..self.agents.len() {
            let (hot, dt) = match self.agents[idx].tier {
                Tier::Hot => (true, TICK_DT),
                Tier::Cold => {
                    if idx as u64 % COLD_BUCKETS != cold_bucket {
                        continue;
                    }
                    (false, COLD_BUCKETS as f32 * TICK_DT)
                }
            };
            if !self.agents[idx].alive() {
                continue;
            }
            // Resolve the Hunt target snapshot before handing off the tick.
            let target = match self.agents[idx].goal {
                Goal::Hunt { target } => {
                    self.combatant(target).map(|(position, _, alive)| TargetInfo { position, alive })
                }
                _ => None,
            };
            let event = {
                let agent = &mut self.agents[idx];
                agent.tick(&self.chunks, dt, hot, target)
            };
            // Queue any path request the tick raised (hot agents only; cold
            // macro movement never needs collision-accurate paths).
            if self.agents[idx].path_request.is_some() && !self.agents[idx].path_queued {
                self.agents[idx].path_queued = true;
                self.agent_path_queue.push_back(idx);
            }
            match event {
                AgentEvent::None => {}
                AgentEvent::NeedsGoal => decisions.push(idx),
                AgentEvent::Act => events.push((idx, event)),
                AgentEvent::Attack { .. } => events.push((idx, event)),
            }
        }

        for (idx, event) in events {
            match event {
                AgentEvent::Attack { target, damage } => {
                    if !self.deal_damage(self.agents[idx].entity, target, damage, None) {
                        // Target became invalid (sanctuary, died, gone):
                        // give up the hunt on the next decision.
                        self.agents[idx].goal = Goal::Idle;
                    }
                }
                AgentEvent::Act => self.agent_act(idx),
                _ => {}
            }
        }
        for idx in decisions {
            self.decide_agent(idx);
        }

        self.serve_agent_paths();

        // Statistical cold-war resolution, once per territory tick.
        if self.tick % TERRITORY_TICK_INTERVAL == 0 {
            self.tick_cold_combat(&hot_chunks);
        }
    }

    /// Grant up to ~20 A* paths per tick (hot agents stuck on geometry).
    fn serve_agent_paths(&mut self) {
        const PATH_BUDGET: usize = 20;
        for _ in 0..PATH_BUDGET {
            let Some(idx) = self.agent_path_queue.pop_front() else { break };
            let Some(agent) = self.agents.get_mut(idx) else { continue };
            agent.path_queued = false;
            let Some(dest) = agent.path_request.take() else { continue };
            if !agent.alive() {
                continue;
            }
            let from = agent.position;
            if let Some(path) = find_path(&self.chunks, from, dest) {
                self.agents[idx].path = path;
            }
        }
    }

    /// Cold-tier statistical combat: in regions where both factions'
    /// (non-replicated) agents co-occupy contested ground with no player
    /// nearby, resolve casualties with strength-weighted rolls.
    fn tick_cold_combat(&mut self, hot_chunks: &HashSet<ChunkCoord>) {
        use rand::Rng;
        // Bucket cold agents by territory region.
        let mut regions: HashMap<(i32, i32), (Vec<usize>, Vec<usize>)> = HashMap::new();
        for (i, agent) in self.agents.iter().enumerate() {
            if !agent.alive() || agent.tier == Tier::Hot {
                continue;
            }
            match districts::danger_at(agent.position) {
                DangerLevel::Contested | DangerLevel::Warzone => {}
                _ => continue, // no cold war on safe ground
            }
            let region = region_of(agent.position);
            let bucket = regions.entry(region).or_default();
            match agent.faction {
                FACTION_REBELS => bucket.0.push(i),
                FACTION_FORUM => bucket.1.push(i),
                _ => {}
            }
        }
        let mut casualties: Vec<(usize, usize)> = Vec::new();
        for (_, (rebels, forum)) in regions {
            if rebels.is_empty() || forum.is_empty() {
                continue;
            }
            // Skip regions with any player-adjacent (hot) chunk: embodied
            // combat owns those.
            let any_hot = rebels
                .iter()
                .chain(forum.iter())
                .any(|&i| hot_chunks.contains(&self.agents[i].chunk()));
            if any_hot {
                continue;
            }
            let strength = |side: &[usize]| -> f32 {
                side.iter().map(|&i| self.agents[i].strength()).sum::<f32>().max(1.0)
            };
            let (rs, fs) = (strength(&rebels), strength(&forum));
            // Each side risks one casualty per resolution, weighted by how
            // outgunned it is (capped so skirmishes stay slow burns). The
            // kill is credited to a random fighter on the winning side.
            let mut roll = |side: &[usize], enemy_side: &[usize], own: f32, enemy: f32, rng: &mut SmallRng| {
                let p = (enemy / (own + enemy) * 0.25).min(0.2) as f64;
                if rng.random_bool(p) {
                    let victim = side[rng.random_range(0..side.len())];
                    let killer = enemy_side[rng.random_range(0..enemy_side.len())];
                    casualties.push((victim, killer));
                }
            };
            roll(&rebels, &forum, rs, fs, &mut self.rng);
            roll(&forum, &rebels, fs, rs, &mut self.rng);
        }
        for (idx, killer) in casualties {
            if self.agents[idx].alive() {
                let killer_actor = self.agent_actor_ref(killer);
                let victim_actor = self.agent_actor_ref(idx);
                self.stats.record_kill(
                    self.agents[killer].alive().then_some(&killer_actor),
                    &victim_actor,
                );
                self.kill_agent(idx, false);
            }
        }
    }

    fn respawn_agent(&mut self, idx: usize) {
        let faction = self.agents[idx].faction;
        // Hub-cohort agents respawn at their staging ground so the war over
        // the starter playfield never drains away; everyone else returns to
        // the faction's home district.
        let home_spot = self.agents[idx].home_spot;
        let home = match home_spot {
            Some(_) => self.agents[idx].home,
            None => districts::faction_home_district(faction)
                .unwrap_or(self.agents[idx].home),
        };
        let spot = home_spot.unwrap_or_else(|| self.district_spot(home));
        let position = self.walkable_spot_near(spot, 12.0);
        let (agent_id, name) = mint_agent_name(faction);
        let old_entity = self.agents[idx].entity;
        // The dead identity leaves the boards; its faction/guild legacy stays.
        self.stats.retire(self.agents[idx].agent_id);
        let entity = self.alloc_entity();
        {
            let agent = &mut self.agents[idx];
            agent.entity = entity;
            agent.agent_id = agent_id;
            agent.name = name;
            agent.home = home;
            agent.guild = guild_for(faction, home);
            agent.position = position;
            agent.health = agent.max_health;
            agent.respawn_in = 0.0;
            agent.goal = Goal::Idle;
            agent.tier = Tier::Cold;
            agent.anim = AnimState::Idle;
            agent.path.clear();
            agent.path_request = None;
            agent.retreat_cooldown = 0.0;
        }
        self.agent_by_entity.remove(&old_entity);
        self.agent_by_entity.insert(entity, idx);
        // Fresh identities start with a modest grubstake and role kit.
        self.grubstake_agent(idx);
    }

    /// Mint a starting wallet + role kit to an agent (seed or respawn).
    fn grubstake_agent(&mut self, idx: usize) {
        use rand::Rng;
        let wallet = self.rng.random_range(40..120u32);
        let role = self.agents[idx].role;
        let kit: &[(ItemKind, u32)] = match role {
            Role::Scavenger => &[],
            Role::Trader => &[],
            Role::Crafter => &[(ItemKind::Iron, 8), (ItemKind::Copper, 6)],
            Role::Enforcer => &[(ItemKind::Pipe, 1), (ItemKind::Medkit, 1)],
            Role::Raider => &[(ItemKind::Knife, 1)],
        };
        let party = self.agents[idx].party();
        self.agents[idx].wallet += wallet;
        self.ledger.record(
            TxKind::Mint,
            TxParty::Mint,
            party.clone(),
            TxAmount::Wild { amount: wallet },
            0,
        );
        for &(kind, count) in kit {
            self.agents[idx].add_item(kind, count);
            self.ledger.record(
                TxKind::Mint,
                TxParty::Mint,
                party.clone(),
                TxAmount::Item { kind, count },
                0,
            );
        }
    }

    /// Staging position for a district (near its service cluster). Always on
    /// walkable ground: service doors are walkable by construction, and the
    /// raw-anchor fallback (tests, doorless districts) snaps to the nearest
    /// walkable tile because baked anchors can sit on building footprints.
    fn district_spot(&self, district: usize) -> Vec3 {
        self.district_spots.get(district).copied().unwrap_or_else(|| {
            let anchor = districts::district_defs()
                .get(district)
                .map(|d| Vec3::new(d.x, 0.0, d.z))
                .unwrap_or(SPAWN);
            self.nearest_walkable(anchor)
        })
    }

    /// Nearest walkable tile center to `pos` (ring search out to ~120 m),
    /// falling back to the always-walkable spawn road corner.
    fn nearest_walkable(&self, pos: Vec3) -> Vec3 {
        if self.chunks.walkable(pos.x, pos.z) {
            return pos;
        }
        let tx0 = (pos.x / TILE_SIZE).floor() as i32;
        let tz0 = (pos.z / TILE_SIZE).floor() as i32;
        for r in 1..=60i32 {
            for dz in -r..=r {
                for dx in -r..=r {
                    if dx.abs().max(dz.abs()) != r {
                        continue;
                    }
                    let x = (tx0 + dx) as f32 * TILE_SIZE + TILE_SIZE * 0.5;
                    let z = (tz0 + dz) as f32 * TILE_SIZE + TILE_SIZE * 0.5;
                    if self.chunks.walkable(x, z) {
                        return Vec3::new(x, pos.y, z);
                    }
                }
            }
        }
        SPAWN
    }

    /// Random walkable point within `radius` of `center`. Rejection-sampled
    /// so agent destinations (gather spots, wander/patrol targets, respawn
    /// jitter) never land in water or inside a building footprint; falls back
    /// to solid ground near `center` when the neighborhood is mostly water.
    fn walkable_spot_near(&mut self, center: Vec3, radius: f32) -> Vec3 {
        use rand::Rng;
        for _ in 0..8 {
            let c = center
                + Vec3::new(
                    self.rng.random_range(-radius..radius),
                    0.0,
                    self.rng.random_range(-radius..radius),
                );
            if self.chunks.walkable(c.x, c.z) {
                return c;
            }
        }
        self.nearest_walkable(center)
    }

    /// Nearest seeded service of `kind` to `pos`.
    fn nearest_service(&self, pos: Vec3, kind: EntityKind) -> Option<(EntityId, Vec3)> {
        self.statics
            .values()
            .filter(|s| s.kind == kind)
            .min_by(|a, b| {
                let da = (a.position - pos).length_squared();
                let db = (b.position - pos).length_squared();
                da.partial_cmp(&db).unwrap_or(std::cmp::Ordering::Equal)
            })
            .map(|s| (s.entity, s.position))
    }

    /// Utility-AI: score candidate goals for one agent and commit to the best.
    fn decide_agent(&mut self, idx: usize) {
        use rand::Rng;
        let (pos, role, faction, health_frac, wallet, carried, entity, retreat_cd) = {
            let a = &self.agents[idx];
            (
                a.position,
                a.role,
                a.faction,
                a.health / a.max_health,
                a.wallet,
                a.carried_value(),
                a.entity,
                a.retreat_cooldown,
            )
        };
        // Stagger the next re-score.
        self.agents[idx].decision_timer =
            self.rng.random_range(agents::DECISION_SECONDS.0..agents::DECISION_SECONDS.1);

        // Safety overrides: hurt or flush agents fall back to a sanctuary.
        if health_frac < RETREAT_HEALTH_PCT || (wallet > WEALTH_RETREAT && retreat_cd <= 0.0) {
            let to = self.nearest_sanctuary_spot(pos);
            self.agents[idx].goal = Goal::Retreat { to };
            return;
        }

        let danger_here = districts::danger_at(pos);
        let mut best: (f32, Goal) = (2.0, Goal::Patrol { to: self.wander_target(idx) });

        // --- Gather: expected WILD from zone drops, boosted in warzones ---
        let zone = zone_of_chunk(ChunkCoord::from_world(pos));
        let weights = wilder_economy::zone_resource_weights(zone);
        let total: u32 = weights.iter().sum();
        let ev: f32 = wilder_economy::RESOURCES
            .iter()
            .zip(weights.iter())
            .map(|(kind, w)| base_value(*kind) as f32 * *w as f32)
            .sum::<f32>()
            / total.max(1) as f32;
        let danger_mult = if danger_here == DangerLevel::Warzone { 1.5 } else { 1.0 };
        let gather_mult = match role {
            Role::Scavenger => 1.6,
            Role::Raider => 1.0,
            Role::Crafter => 0.8,
            Role::Trader => 0.4,
            Role::Enforcer => 0.2,
        };
        let stacks = self.agents[idx].inventory.len();
        if stacks < agents::MAX_STACKS - 4 {
            let score = ev * danger_mult * gather_mult * 2.0;
            if score > best.0 {
                let spot = self.walkable_spot_near(pos, 30.0);
                best = (
                    score,
                    Goal::Gather { spot, pulls_left: self.rng.random_range(3..6), timer: 0.0 },
                );
            }
        }

        // --- Sell: haul value to the nearest store ---
        let sell_mult = match role {
            Role::Trader => 1.4,
            Role::Scavenger => 1.2,
            _ => 1.0,
        };
        if carried >= 30 {
            if let Some((store, store_pos)) = self.nearest_service(pos, EntityKind::Bodega) {
                let score = carried as f32 * 0.08 * sell_mult;
                if score > best.0 {
                    // Traders prefer the market book; everyone else vendors.
                    let list_on_market = role == Role::Trader && self.market.len() < 200;
                    let (store, store_pos) = if list_on_market {
                        self.nearest_service(pos, EntityKind::MarketTerminal)
                            .unwrap_or((store, store_pos))
                    } else {
                        (store, store_pos)
                    };
                    best = (score, Goal::Sell { store, store_pos, list_on_market });
                }
            }
        }

        // --- BuyGear: arm up when the wallet allows ---
        let has_weapon = [ItemKind::Smg, ItemKind::Pistol, ItemKind::Pipe, ItemKind::Knife]
            .iter()
            .any(|k| self.agents[idx].count_item(*k) > 0);
        if !has_weapon && wallet >= 30 {
            if let Some((store, store_pos)) = self.nearest_service(pos, EntityKind::Armory) {
                let kind = if wallet >= 360 {
                    ItemKind::Smg
                } else if wallet >= 170 {
                    ItemKind::Pistol
                } else if wallet >= 55 {
                    ItemKind::Knife
                } else {
                    ItemKind::Pipe
                };
                let score = if role.is_combatant() { 40.0 } else { 15.0 };
                if score > best.0 {
                    best = (score, Goal::Buy { store, store_pos, kind, count: 1 });
                }
            }
        }
        if self.agents[idx].count_item(ItemKind::Medkit) == 0 && wallet >= 60 && has_weapon {
            if let Some((store, store_pos)) = self.nearest_service(pos, EntityKind::Bodega) {
                let score = 8.0;
                if score > best.0 {
                    best = (score, Goal::Buy { store, store_pos, kind: ItemKind::Medkit, count: 1 });
                }
            }
        }

        // --- Craft: best-margin recipe the agent can feed (Crafter bias) ---
        let craft_mult = match role {
            Role::Crafter => 2.0,
            Role::Trader => 0.6,
            _ => 0.3,
        };
        let mut best_recipe: Option<(&'static wilder_crafting::Recipe, f32)> = None;
        for recipe in wilder_crafting::RECIPES {
            if recipe.station == wilder_crafting::Station::Laboratory {
                continue;
            }
            let affordable = recipe
                .inputs
                .iter()
                .all(|&(kind, count)| self.agents[idx].count_item(kind) >= count);
            if !affordable {
                continue;
            }
            let in_value: u32 =
                recipe.inputs.iter().map(|&(k, c)| base_value(k) * c).sum();
            let out_value = base_value(recipe.output.0) * recipe.output.1;
            let margin = out_value.saturating_sub(in_value) as f32;
            if margin > 0.0 && best_recipe.map(|(_, m)| margin > m).unwrap_or(true) {
                best_recipe = Some((recipe, margin));
            }
        }
        if let Some((recipe, margin)) = best_recipe {
            let station_kind = match recipe.station {
                wilder_crafting::Station::Refinery => EntityKind::Refinery,
                _ => EntityKind::Factory,
            };
            if let Some((station, station_pos)) = self.nearest_service(pos, station_kind) {
                let score = margin * craft_mult;
                if score > best.0 {
                    best = (
                        score,
                        Goal::Craft {
                            station,
                            station_pos,
                            recipe: recipe.id,
                            timer: recipe.seconds,
                            started: false,
                        },
                    );
                }
            }
        }
        // Crafters missing inputs restock off the market book when a fair
        // listing exists.
        if role == Role::Crafter && best_recipe.is_none() && wallet >= 30 {
            let wanted = [ItemKind::Iron, ItemKind::Copper, ItemKind::Chemicals, ItemKind::Biomass];
            let listing = self.market.iter().find(|l| {
                wanted.contains(&l.kind) && l.price_each <= base_value(l.kind).saturating_mul(2)
            });
            if let Some(l) = listing {
                if let Some((_, terminal_pos)) =
                    self.nearest_service(pos, EntityKind::MarketTerminal)
                {
                    let score = 12.0;
                    if score > best.0 {
                        best = (
                            score,
                            Goal::BuyMarket {
                                terminal_pos,
                                kind: l.kind,
                                count: l.count.min(wallet / l.price_each.max(1)),
                                max_each: l.price_each,
                            },
                        );
                    }
                }
            }
        }

        // --- Trade: arbitrage underpriced listings (Trader role) ---
        if role == Role::Trader && wallet >= 20 {
            let bargain = self.market.iter().any(|l| {
                let base = base_value(l.kind);
                l.price_each.saturating_mul(10) <= base.saturating_mul(7) && l.price_each <= wallet
            });
            if bargain {
                if let Some((_, terminal_pos)) =
                    self.nearest_service(pos, EntityKind::MarketTerminal)
                {
                    let score = 25.0;
                    if score > best.0 {
                        best = (score, Goal::Trade { terminal_pos });
                    }
                }
            }
        }

        // --- Patrol / Hunt: combat roles look for trouble ---
        if role.is_combatant() && has_weapon {
            let fight_mult = match role {
                Role::Enforcer => 1.8,
                Role::Raider => 1.5,
                _ => 0.0,
            };
            // Nearest hostile the rules would let us hit right now.
            if let Some(target) = self.find_hostile_target(entity, pos, faction) {
                let score = 50.0 * fight_mult;
                if score > best.0 {
                    best = (score, Goal::Hunt { target });
                }
            } else {
                // No target in sight: push toward the agent's assigned front.
                let to = self.patrol_front(idx);
                let score = 6.0 * fight_mult;
                if score > best.0 {
                    best = (score, Goal::Patrol { to });
                }
            }
        }

        self.agents[idx].goal = best.1;
    }

    /// Nearest hostile combatant within engagement range that current danger
    /// rules allow attacking. Players and NPCs are scanned directly (small
    /// sets); agents come from the spatial hash.
    fn find_hostile_target(&self, me: EntityId, pos: Vec3, faction: FactionId) -> Option<EntityId> {
        const ENGAGE_RANGE: f32 = 48.0;
        let mut best: Option<(f32, EntityId)> = None;
        let consider = |id: EntityId, p: Vec3, f: FactionId, best: &mut Option<(f32, EntityId)>| {
            if id == me || !are_hostile(faction, f) {
                return;
            }
            let dist = (p - pos).length();
            if dist > ENGAGE_RANGE {
                return;
            }
            if !self.damage_allowed(me, id) {
                return;
            }
            if best.map(|(d, _)| dist < d).unwrap_or(true) {
                *best = Some((dist, id));
            }
        };
        for p in self.players.values() {
            if p.character.health > 0.0 {
                consider(p.entity, p.character.position, FACTION_REBELS, &mut best);
            }
        }
        for n in self.npcs.values() {
            if n.alive() {
                consider(n.entity, n.position, FACTION_FORUM, &mut best);
            }
        }
        let center = ChunkCoord::from_world(pos);
        for dz in -2..=2 {
            for dx in -2..=2 {
                let Some(bucket) = self.agent_grid.get(&ChunkCoord::new(center.x + dx, center.z + dz))
                else {
                    continue;
                };
                for &i in bucket {
                    let a = &self.agents[i as usize];
                    if a.alive() {
                        consider(a.entity, a.position, a.faction, &mut best);
                    }
                }
            }
        }
        best.map(|(_, id)| id)
    }

    /// Staging spot of the nearest Sanctuary district.
    fn nearest_sanctuary_spot(&self, pos: Vec3) -> Vec3 {
        districts::district_defs()
            .iter()
            .enumerate()
            .filter(|(_, d)| d.danger == DangerLevel::Sanctuary)
            .min_by(|(_, a), (_, b)| {
                let da = (a.x - pos.x).powi(2) + (a.z - pos.z).powi(2);
                let db = (b.x - pos.x).powi(2) + (b.z - pos.z).powi(2);
                da.partial_cmp(&db).unwrap_or(std::cmp::Ordering::Equal)
            })
            .map(|(i, _)| self.district_spot(i))
            .unwrap_or(SPAWN)
    }

    /// All shared "front line" staging spots: every Contested/Warzone
    /// district plus the contested combat ring around the spawn hub (listed
    /// twice — it's the starter playfield players actually watch, so it
    /// deserves the heaviest patrol presence).
    fn patrol_fronts(&self) -> Vec<Vec3> {
        let mut fronts: Vec<Vec3> = districts::district_defs()
            .iter()
            .enumerate()
            .filter(|(_, d)| matches!(d.danger, DangerLevel::Contested | DangerLevel::Warzone))
            .map(|(i, _)| self.district_spot(i))
            .collect();
        let hub_front = self.nearest_walkable(HUB_FRONT_SPOT);
        fronts.push(hub_front);
        fronts.push(hub_front);
        fronts
    }

    /// Patrol destination for a combat-role agent: a jittered spot at its
    /// assigned front. Hub-cohort agents (fixed `home_spot` inside the combat
    /// ring) always fight over the hub front so the war stays visible on the
    /// starter playfield. Everyone else hashes their identity — NOT home
    /// geography — across the shared front list, so Rebel and Forum
    /// combatants converge on the same contested regions and the cold
    /// statistical war actually finds both sides in one bucket.
    fn patrol_front(&mut self, idx: usize) -> Vec3 {
        let hub_local = self.agents[idx]
            .home_spot
            .is_some_and(|h| h.x.hypot(h.z) < districts::HUB_COMBAT_RING_M);
        let front = if hub_local {
            self.nearest_walkable(HUB_FRONT_SPOT)
        } else {
            let fronts = self.patrol_fronts();
            let pick = (self.agents[idx].agent_id.as_u128() % fronts.len() as u128) as usize;
            fronts[pick]
        };
        self.walkable_spot_near(front, 40.0)
    }

    /// Short wander destination around the agent's current position.
    fn wander_target(&mut self, idx: usize) -> Vec3 {
        let pos = self.agents[idx].position;
        // Roam a wide radius so idle agents actually traverse the city (and
        // read as moving dots on the map) instead of milling in place — but
        // only onto walkable ground, never out over the water.
        self.walkable_spot_near(pos, 140.0)
    }

    /// Execute the economic leg of an agent's current goal (it arrived and
    /// its action timer fired).
    fn agent_act(&mut self, idx: usize) {
        match self.agents[idx].goal {
            Goal::Gather { .. } => self.agent_gather_pull(idx),
            Goal::Sell { store, list_on_market, .. } => self.agent_sell(idx, store, list_on_market),
            Goal::Buy { store, kind, count, .. } => self.agent_vendor_buy(idx, store, kind, count),
            Goal::BuyMarket { kind, count, max_each, .. } => {
                self.agent_market_buy(idx, kind, count, max_each);
                self.agents[idx].goal = Goal::Idle;
            }
            Goal::Trade { .. } => self.agent_trade(idx),
            Goal::Craft { .. } => self.agent_craft_step(idx),
            _ => {}
        }
    }

    /// One gather pull: mint zone-weighted resources to the agent.
    fn agent_gather_pull(&mut self, idx: usize) {
        use rand::Rng;
        let pos = self.agents[idx].position;
        let zone = zone_of_chunk(ChunkCoord::from_world(pos));
        let roll: u32 = self.rng.random();
        let kind = wilder_economy::RESOURCES[wilder_economy::zone_resource_index(zone, roll)];
        let base: u32 = self.rng.random_range(2..=4);
        let count = if districts::danger_at(pos) == DangerLevel::Warzone {
            base + base / 2 // warzone yield premium
        } else {
            base
        };
        // Hostile-held ground taxes agents exactly like players.
        let count =
            apply_territory_tax(count, self.region_hostile_to(pos, self.agents[idx].faction));
        let leftover = self.agents[idx].add_item(kind, count);
        let gained = count - leftover;
        if gained == 0 {
            self.agents[idx].goal = Goal::Idle;
            return;
        }
        let party = self.agents[idx].party();
        self.ledger.record(
            TxKind::Mint,
            TxParty::Mint,
            party,
            TxAmount::Item { kind, count: gained },
            0,
        );
        let gatherer = self.agent_actor_ref(idx);
        self.stats.add_resources(&gatherer, gained as u64);
        if let Goal::Gather { pulls_left, .. } = &mut self.agents[idx].goal {
            *pulls_left = pulls_left.saturating_sub(1);
            if *pulls_left == 0 {
                self.agents[idx].goal = Goal::Idle;
            }
        }
    }

    /// Sell everything the store buys; traders list surplus resources on the
    /// market book instead of dumping at vendor floor prices.
    fn agent_sell(&mut self, idx: usize, store: EntityId, list_on_market: bool) {
        if list_on_market {
            self.agent_market_list(idx);
            self.agents[idx].goal = Goal::Idle;
            return;
        }
        let Some((store_kind, store_pos, vendor_agent)) = self
            .statics
            .get(&store)
            .map(|s| (s.kind, s.position, static_party(s)))
        else {
            self.agents[idx].goal = Goal::Idle;
            return;
        };
        let offers = wilder_economy::vendor_offers(store_kind);
        let sellables: Vec<(ItemKind, u32, u32)> = offers
            .iter()
            .filter(|o| o.sell > 0)
            .filter_map(|o| {
                let have = self.agents[idx].count_item(o.kind);
                (have > 0).then_some((o.kind, have, o.sell))
            })
            .collect();
        for (kind, count, sell) in sellables {
            self.agents[idx].remove_item(kind, count);
            let gross = sell.saturating_mul(count);
            let cut = gross * wilder_economy::COMMERCE_CUT_PCT / 100;
            self.agents[idx].wallet += gross - cut;
            let seller = self.agents[idx].party();
            // Same ledger legs as the player vendor-sell flow.
            self.ledger.record_ex(
                TxKind::VendorSell,
                seller.clone(),
                vendor_agent.clone(),
                TxAmount::Item { kind, count },
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
            self.distribute_commerce(store_pos, cut, vendor_agent.clone(), false);
        }
        self.agents[idx].goal = Goal::Idle;
    }

    /// Buy `count` of `kind` from a vendor building (agent-side mirror of the
    /// player VendorBuy flow, identical ledger legs).
    fn agent_vendor_buy(&mut self, idx: usize, store: EntityId, kind: ItemKind, count: u32) {
        self.agents[idx].goal = Goal::Idle;
        let Some((store_kind, store_pos, vendor_agent)) = self
            .statics
            .get(&store)
            .map(|s| (s.kind, s.position, static_party(s)))
        else {
            return;
        };
        let Some(offer) = wilder_economy::vendor_offers(store_kind)
            .iter()
            .find(|e| e.kind == kind && e.buy > 0)
        else {
            return;
        };
        let cost = offer.buy.saturating_mul(count);
        if self.agents[idx].wallet < cost {
            return;
        }
        self.agents[idx].wallet -= cost;
        let leftover = self.agents[idx].add_item(kind, count);
        let bought = count - leftover;
        let buyer = self.agents[idx].party();
        self.ledger.record(
            TxKind::VendorBuy,
            buyer.clone(),
            vendor_agent.clone(),
            TxAmount::Wild { amount: cost },
            0,
        );
        if bought > 0 {
            self.ledger.record_ex(
                TxKind::VendorBuy,
                vendor_agent.clone(),
                buyer,
                TxAmount::Item { kind, count: bought },
                0,
                SupplyEffect::Mint,
            );
        }
        self.distribute_commerce(
            store_pos,
            cost * wilder_economy::COMMERCE_CUT_PCT / 100,
            vendor_agent,
            false,
        );
    }

    /// List the agent's carried resources on the market book at a markup
    /// over reference value.
    fn agent_market_list(&mut self, idx: usize) {
        let market_agent = self.market_party();
        let carried: Vec<(ItemKind, u32)> = self.agents[idx]
            .inventory
            .iter()
            .filter(|s| wilder_economy::RESOURCES.contains(&s.kind) || base_value(s.kind) >= 5)
            .map(|s| (s.kind, s.count))
            .collect();
        for (kind, count) in carried {
            if self.market.len() >= 200 {
                break;
            }
            let removed = self.agents[idx].remove_item(kind, count);
            if removed == 0 {
                continue;
            }
            let price_each = (base_value(kind).saturating_mul(11) / 10).max(1);
            let seller_party = self.agents[idx].party();
            self.ledger.record(
                TxKind::MarketList,
                seller_party,
                market_agent.clone(),
                TxAmount::Item { kind, count: removed },
                0,
            );
            let listing = wilder_market::Listing {
                id: self.next_listing_id,
                // Agent listings key on the agent's uuid (same id space as
                // CharacterId); buys credit the agent's wallet directly.
                seller: self.agents[idx].agent_id,
                seller_name: self.agents[idx].name.clone(),
                kind,
                count: removed,
                price_each,
            };
            self.next_listing_id += 1;
            self.market.push(listing);
        }
        self.save_market();
    }

    /// Buy up to `count` of `kind` off the market book at `max_each` or
    /// better. Mirrors the player MarketBuy ledger legs; sellers (player or
    /// agent) are credited identically.
    fn agent_market_buy(&mut self, idx: usize, kind: ItemKind, count: u32, max_each: u32) -> bool {
        let market_agent = self.market_party();
        let Some(pos) = self
            .market
            .iter()
            .position(|l| l.kind == kind && l.price_each <= max_each && l.count > 0)
        else {
            return false;
        };
        let (listing_seller, price_each, available) = {
            let l = &self.market[pos];
            (l.seller, l.price_each, l.count)
        };
        // Never buy from yourself (relisting loops).
        if listing_seller == self.agents[idx].agent_id {
            return false;
        }
        let wallet = self.agents[idx].wallet;
        let affordable = (wallet / price_each.max(1)).min(count).min(available);
        if affordable == 0 {
            return false;
        }
        let cost = price_each * affordable;
        self.agents[idx].wallet -= cost;
        let leftover = self.agents[idx].add_item(kind, affordable);
        if leftover > 0 {
            // Couldn't haul it all: burn the overflow (rare; stack caps).
            self.ledger.record(
                TxKind::Burn,
                self.agents[idx].party(),
                TxParty::Burn,
                TxAmount::Item { kind, count: leftover },
                0,
            );
        }
        let fee = cost * MARKET_FEE_PCT / 100;
        let proceeds = cost - fee;
        let buyer_party = self.agents[idx].party();
        let seller_party = self.credit_market_seller(listing_seller, proceeds);
        // Leaderboards: both sides of a fill count a trade.
        let buyer_actor = self.agent_actor_ref(idx);
        self.stats.add_trade(&buyer_actor);
        if let Some(s) = party_actor(&seller_party) {
            self.stats.add_trade(&s);
        }
        self.ledger.record(
            TxKind::MarketBuy,
            market_agent.clone(),
            buyer_party.clone(),
            TxAmount::Item { kind, count: affordable },
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
            self.ledger.record(TxKind::Fee, buyer_party, market_agent.clone(), TxAmount::Wild { amount: fee }, 0);
            // Agents trade remotely (cold tier): the fee burns like an
            // unattended terminal's would.
            self.ledger.record(TxKind::Fee, market_agent, TxParty::Burn, TxAmount::Wild { amount: fee }, 0);
        }
        self.ledger.trades += 1;
        let l = &mut self.market[pos];
        l.count -= affordable;
        if l.count == 0 {
            self.market.remove(pos);
        }
        self.save_market();
        true
    }

    /// Credit a market seller's wallet by id — online player, offline
    /// player, or agent — and return the ledger party to attribute.
    fn credit_market_seller(&mut self, seller: CharacterId, proceeds: u32) -> TxParty {
        if let Some(sp) = self.players.values_mut().find(|p| p.character.id == seller) {
            sp.wallet += proceeds;
            let account = sp.character.account_id;
            let wallet = sp.wallet;
            let party = player_party(sp);
            let _ = self.store.update_wallet(account, wallet);
            return party;
        }
        if let Some(agent) = self.agents.iter_mut().find(|a| a.agent_id == seller) {
            agent.wallet += proceeds;
            return agent.party();
        }
        if let Ok(ch) = self.store.character(seller) {
            if let Ok(account) = self.store.account_by_id(ch.account_id) {
                let _ = self.store.update_wallet(account.id, account.wallet + proceeds);
                return TxParty::Player { id: seller, name: ch.name, faction: FACTION_REBELS };
            }
        }
        TxParty::Burn
    }

    /// Trader arbitrage at a terminal: buy the best underpriced listing,
    /// then relist it above reference value.
    fn agent_trade(&mut self, idx: usize) {
        self.agents[idx].goal = Goal::Idle;
        let wallet = self.agents[idx].wallet;
        let me = self.agents[idx].agent_id;
        // Best bargain: largest absolute discount vs reference value.
        let pick = self
            .market
            .iter()
            .filter(|l| {
                l.seller != me
                    && l.price_each <= wallet
                    && l.price_each.saturating_mul(10) <= base_value(l.kind).saturating_mul(7)
            })
            .max_by_key(|l| base_value(l.kind).saturating_sub(l.price_each))
            .map(|l| (l.kind, l.price_each));
        let Some((kind, price_each)) = pick else { return };
        if self.agent_market_buy(idx, kind, u32::MAX, price_each) {
            // Immediately flip the goods back onto the book at a margin.
            self.agent_market_list(idx);
        }
    }

    /// Craft goal steps: first arrival consumes inputs and starts the timer;
    /// timer expiry mints the output.
    fn agent_craft_step(&mut self, idx: usize) {
        let Goal::Craft { recipe, started, .. } = self.agents[idx].goal else { return };
        let Some(recipe) = wilder_crafting::recipe(recipe) else {
            self.agents[idx].goal = Goal::Idle;
            return;
        };
        let party = self.agents[idx].party();
        if !started {
            // Consume inputs (burn legs, same as the player craft flow).
            let affordable = recipe
                .inputs
                .iter()
                .all(|&(kind, count)| self.agents[idx].count_item(kind) >= count);
            if !affordable {
                self.agents[idx].goal = Goal::Idle;
                return;
            }
            for &(kind, count) in recipe.inputs {
                self.agents[idx].remove_item(kind, count);
                self.ledger.record(
                    TxKind::CraftConsume,
                    party.clone(),
                    TxParty::Burn,
                    TxAmount::Item { kind, count },
                    0,
                );
            }
            if let Goal::Craft { started, timer, .. } = &mut self.agents[idx].goal {
                *started = true;
                *timer = recipe.seconds;
            }
            return;
        }
        // Timer done: mint the output.
        let (kind, count) = recipe.output;
        self.agents[idx].add_item(kind, count);
        self.ledger.record(
            TxKind::CraftProduce,
            TxParty::Mint,
            party,
            TxAmount::Item { kind, count },
            0,
        );
        let crafter = self.agent_actor_ref(idx);
        self.stats.add_crafted(&crafter, count as u64);
        self.agents[idx].goal = Goal::Idle;
    }

    // -----------------------------------------------------------------------
    // Agent population: seeding + persistence
    // -----------------------------------------------------------------------

    /// Restore the persisted agent population, or seed a fresh one (count
    /// from `WILDER_AGENTS`, default 500). Populations saved under an older
    /// seed layout are discarded and reseeded so distribution changes (like
    /// the hub cohort) actually reach existing worlds.
    fn load_or_seed_agents(&mut self) {
        let layout: u32 =
            self.store.meta("agent_seed_layout").ok().flatten().unwrap_or(0);
        let saves: Vec<AgentSave> = if layout == AGENT_SEED_LAYOUT {
            self.store.meta("faction_agents").ok().flatten().unwrap_or_default()
        } else {
            Vec::new()
        };
        if !saves.is_empty() {
            for mut save in saves {
                // Sanitize restored positions: older saves can hold agents
                // stranded over open water (pre-walkability-guard drift).
                // Snap those back to their staging ground.
                if !self.chunks.walkable(save.position.x, save.position.z) {
                    let spot = save.home_spot.unwrap_or_else(|| self.district_spot(save.home));
                    save.position = self.nearest_walkable(spot);
                }
                let entity = self.alloc_entity();
                let agent = FactionAgent::from_save(entity, save);
                self.agent_by_entity.insert(entity, self.agents.len());
                self.agents.push(agent);
            }
            tracing::info!(agents = self.agents.len(), "faction agents restored");
            return;
        }
        let total: usize = std::env::var("WILDER_AGENTS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(500);
        self.seed_agents(total);
        let _ = self.store.save_meta("agent_seed_layout", &AGENT_SEED_LAYOUT);
        tracing::info!(agents = self.agents.len(), layout = AGENT_SEED_LAYOUT, "faction agents seeded");
    }

    /// Seed `total` agents. Half the population is a **hub cohort** staged
    /// inside the spawn hub's combat ring (Rebels south-east, Forum
    /// north-west) so the faction war plays out on the starter playfield
    /// players actually see. The rest split by faction geography (Rebels
    /// southern districts, Forum northern), spread across roles.
    /// Deterministic from the world seed.
    fn seed_agents(&mut self, total: usize) {
        use rand::Rng;
        let mut seed_rng = SmallRng::seed_from_u64(self.seed ^ 0xA6E175);
        let defs = districts::district_defs();
        let hub_cohort = total / 2;
        // Home pools by geography: Rebels take the southern half (z >= 0),
        // Forum the northern (z < 0). Guarded homes get extra weight.
        let pool = |faction: FactionId| -> Vec<usize> {
            let mut pool: Vec<usize> = Vec::new();
            for (i, d) in defs.iter().enumerate() {
                let southern = d.z >= 0.0;
                if (faction == FACTION_REBELS) != southern {
                    continue;
                }
                let weight = if d.home_faction == faction { 3 } else { 1 };
                for _ in 0..weight {
                    pool.push(i);
                }
            }
            if pool.is_empty() {
                pool.push(0);
            }
            pool
        };
        let rebel_pool = pool(FACTION_REBELS);
        let forum_pool = pool(FACTION_FORUM);

        for n in 0..total {
            let faction = if n % 2 == 0 { FACTION_REBELS } else { FACTION_FORUM };
            let in_hub = n < hub_cohort;
            let home_pool = if faction == FACTION_REBELS { &rebel_pool } else { &forum_pool };
            let home = if in_hub {
                // Guild/rollup district for hub agents: whatever district the
                // hub falls in (Voronoi), same as players standing there.
                districts::district_of(SPAWN).map(|(i, _)| i).unwrap_or(0)
            } else {
                home_pool[seed_rng.random_range(0..home_pool.len())]
            };
            // Role split: 40% Scavenger, 15% Trader, 15% Crafter,
            // 20% Enforcer, 10% Raider.
            let role = match seed_rng.random_range(0..100u32) {
                0..40 => Role::Scavenger,
                40..55 => Role::Trader,
                55..70 => Role::Crafter,
                70..90 => Role::Enforcer,
                _ => Role::Raider,
            };
            let (agent_id, name) = mint_agent_name(faction);
            // Hub cohort stages just outside the protected 3x3, factions on
            // opposite corners of the ring; district agents stage at their
            // home district's service cluster.
            let (spot, jitter, home_spot) = if in_hub {
                let stage = if faction == FACTION_REBELS {
                    HUB_STAGE_REBELS
                } else {
                    HUB_STAGE_FORUM
                };
                let stage = self.nearest_walkable(stage);
                (stage, 60.0, Some(stage))
            } else {
                (self.district_spot(home), 30.0, None)
            };
            // Jitter around the staging spot, but only onto walkable ground
            // (staging spots can border water or building footprints).
            let mut position = self.nearest_walkable(spot);
            for _ in 0..8 {
                let c = spot
                    + Vec3::new(
                        seed_rng.random_range(-jitter..jitter),
                        0.0,
                        seed_rng.random_range(-jitter..jitter),
                    );
                if self.chunks.walkable(c.x, c.z) {
                    position = c;
                    break;
                }
            }
            let entity = self.alloc_entity();
            let mut agent = FactionAgent::from_save(
                entity,
                AgentSave {
                    agent_id,
                    name,
                    faction,
                    guild: guild_for(faction, home),
                    role,
                    home,
                    home_spot,
                    wallet: 0,
                    inventory: Vec::new(),
                    position,
                    health: 100.0,
                    max_health: 100.0,
                },
            );
            // Stagger first decisions so 500 brains don't all fire at once.
            agent.decision_timer = seed_rng.random_range(0.0..2.0);
            let idx = self.agents.len();
            self.agent_by_entity.insert(entity, idx);
            self.agents.push(agent);
            self.grubstake_agent(idx);
        }
    }

    /// Place a service cluster in every named district: Bodega, Armory,
    /// Bank, MarketTerminal and Safehouse everywhere; Refinery + Factory on
    /// Contested/Warzone ground. Docks to real storefront doors near each
    /// district anchor (same mechanism as the hub), deterministic from the
    /// world seed. Statics don't hold their chunks resident — the cache can
    /// evict them freely, exactly like hub statics and OUTPOSTS.
    fn seed_neighborhood_stores(&mut self) {
        let defs = districts::district_defs();
        self.district_spots = vec![SPAWN; defs.len()];
        let mut used: Vec<Vec3> = Vec::new();
        for (di, def) in defs.iter().enumerate() {
            let anchor = Vec3::new(def.x, 0.0, def.z);
            let coord = ChunkCoord::from_world(anchor);
            let mut services: Vec<(EntityKind, String)> = vec![
                (EntityKind::Bodega, format!("{} Bodega", title_case(&def.name))),
                (EntityKind::Armory, format!("{} Armory", title_case(&def.name))),
                (EntityKind::Bank, format!("{} Bank", title_case(&def.name))),
                (EntityKind::MarketTerminal, format!("{} Market", title_case(&def.name))),
                (EntityKind::Safehouse, format!("{} Safehouse", title_case(&def.name))),
            ];
            if matches!(def.danger, DangerLevel::Contested | DangerLevel::Warzone) {
                services.push((EntityKind::Refinery, format!("{} Refinery", title_case(&def.name))));
                services.push((EntityKind::Factory, format!("{} Factory", title_case(&def.name))));
            }
            // Gather storefront doors ring by ring around the anchor chunk.
            let mut doors: Vec<Vec3> = Vec::new();
            let gather = |doors: &mut Vec<Vec3>, r: i32, chunks: &mut ChunkCache| {
                for dz in -r..=r {
                    for dx in -r..=r {
                        if dx.abs().max(dz.abs()) != r && r != 0 {
                            continue;
                        }
                        let n = ChunkCoord::new(coord.x + dx, coord.z + dz);
                        let chunk = chunks.get(n);
                        doors.extend(door_spots(&chunk, n));
                    }
                }
            };
            gather(&mut doors, 0, &mut self.chunks);
            gather(&mut doors, 1, &mut self.chunks);
            let mut gathered_r = 1;
            let mut first_pos: Option<Vec3> = None;
            for (kind, name) in services {
                let mut picked = pick_door(&doors, &used, anchor);
                while picked.is_none() && gathered_r < 4 {
                    gathered_r += 1;
                    gather(&mut doors, gathered_r, &mut self.chunks);
                    picked = pick_door(&doors, &used, anchor);
                }
                let Some(pos) = picked else {
                    tracing::warn!(district = %def.name, %name, "no free storefront for district service");
                    continue;
                };
                used.push(pos);
                first_pos.get_or_insert(pos);
                let entity = self.alloc_entity();
                self.statics.insert(
                    entity,
                    StaticEntity {
                        entity,
                        kind,
                        position: pos,
                        name,
                        variant: 0,
                        agent_id: static_agent_id(self.seed, entity),
                    },
                );
            }
            // The district's staging spot: outside its first service door,
            // falling back to walkable ground near the raw anchor (baked
            // anchors are street centroids and can land on a building tile).
            self.district_spots[di] = first_pos.unwrap_or_else(|| self.nearest_walkable(anchor));
        }
    }

    fn tick_loot(&mut self) {
        // Auto-pickup: walking within range of any loot container (ammo
        // cache, NPC/player drop) grabs it instantly.
        let mut grabbed: Vec<(EntityId, EntityId)> = Vec::new();
        for player in self.players.values() {
            for container in self.loot.values() {
                if (container.position - player.character.position).length() <= LOOT_PICKUP_RADIUS {
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
            let variant = container.variant;
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
            let grabbed_any = !taken.is_empty();
            self.record_loot_pickup(picker, owner, in_supply, &taken);
            // Only ammo caches carry the small Energy charge; ordinary drops
            // (NPC/player loot) don't mint currency on pickup.
            if grabbed_any && variant == 1 {
                self.grant_energy(pid, 1);
            }
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

        self.tick_currency_pickups();
    }

    /// Walk-over auto-collect for loose currency, plus TTL expiry. The client
    /// hears the pickup cue and shows the "+N" toast off the resulting
    /// WalletUpdate and the pickup entity's despawn.
    fn tick_currency_pickups(&mut self) {
        let mut grabbed: Vec<(EntityId, EntityId, Currency, u32)> = Vec::new();
        for player in self.players.values() {
            for pickup in self.pickups.values() {
                if (pickup.position - player.character.position).length()
                    <= CURRENCY_PICKUP_RADIUS
                {
                    grabbed.push((player.entity, pickup.entity, pickup.currency, pickup.amount));
                }
            }
        }
        for (pid, cid, currency, amount) in grabbed {
            // Another player may have grabbed it earlier this pass.
            if self.pickups.remove(&cid).is_none() {
                continue;
            }
            self.grant_currency(pid, currency, amount);
        }

        let mut expired = Vec::new();
        for pickup in self.pickups.values_mut() {
            pickup.ttl -= TICK_DT;
            if pickup.ttl <= 0.0 {
                expired.push(pickup.entity);
            }
        }
        for id in expired {
            self.pickups.remove(&id);
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
        (self.npcs.values().filter(|n| n.alive()).count()
            + self.agents.iter().filter(|a| a.alive()).count()) as u32
    }

    // -----------------------------------------------------------------------
    // Leaderboards
    // -----------------------------------------------------------------------

    /// Competitor identity behind a live entity id (player, agent or Wape),
    /// for stat attribution.
    fn actor_ref(&self, entity: EntityId) -> Option<ActorRef> {
        if let Some(p) = self.players.get(&entity) {
            return Some(ActorRef {
                id: p.character.id,
                name: p.character.name.clone(),
                faction: FACTION_REBELS,
                guild: None,
                is_player: true,
            });
        }
        if let Some(n) = self.npcs.get(&entity) {
            return Some(ActorRef {
                id: n.agent_id,
                name: n.agent_name.clone(),
                faction: FACTION_FORUM,
                guild: None,
                is_player: false,
            });
        }
        self.agent_by_entity.get(&entity).map(|&i| {
            let a = &self.agents[i];
            ActorRef {
                id: a.agent_id,
                name: a.name.clone(),
                faction: a.faction,
                guild: Some(a.guild.clone()),
                is_player: false,
            }
        })
    }

    /// Competitor identity of an agent by index (works for dead agents too,
    /// where the entity map no longer resolves).
    fn agent_actor_ref(&self, idx: usize) -> ActorRef {
        let a = &self.agents[idx];
        ActorRef {
            id: a.agent_id,
            name: a.name.clone(),
            faction: a.faction,
            guild: Some(a.guild.clone()),
            is_player: false,
        }
    }

    /// Build the leaderboard payload: live competitors (online players +
    /// living agents) with current wealth, joined with the stats book and
    /// territory rollups.
    fn leaderboard(&self) -> LeaderboardData {
        let mut live: Vec<LiveActor> = Vec::with_capacity(self.players.len() + self.agents.len());
        for p in self.players.values() {
            live.push(LiveActor {
                id: p.character.id,
                name: p.character.name.clone(),
                faction: FACTION_REBELS,
                guild: None,
                wealth: p.wallet as i64,
            });
        }
        for a in &self.agents {
            if !a.alive() {
                continue;
            }
            live.push(LiveActor {
                id: a.agent_id,
                name: a.name.clone(),
                faction: a.faction,
                guild: Some(a.guild.clone()),
                wealth: a.wallet as i64 + a.carried_value() as i64,
            });
        }
        let mut regions_by_faction: HashMap<FactionId, u32> = HashMap::new();
        for &holder in self.territory.values() {
            *regions_by_faction.entry(holder).or_default() += 1;
        }
        let mut districts_by_faction: HashMap<FactionId, u32> = HashMap::new();
        for holder in self.district_control() {
            if holder != FACTION_NEUTRAL {
                *districts_by_faction.entry(holder).or_default() += 1;
            }
        }
        build_leaderboard(
            &self.stats,
            &live,
            &faction_registry(),
            &regions_by_faction,
            &districts_by_faction,
        )
    }

    // -----------------------------------------------------------------------
    // Map intel (whole-map blips for the M overlay)
    // -----------------------------------------------------------------------

    /// Every living actor on the map as a quantized blip: players (kind 0),
    /// faction agents hot or cold (kind 1) and wild Wapes (kind 2).
    fn map_intel_blips(&self) -> Vec<AgentBlip> {
        let q = |v: f32| v.clamp(i16::MIN as f32, i16::MAX as f32) as i16;
        let mut blips: Vec<AgentBlip> =
            Vec::with_capacity(self.players.len() + self.agents.len() + self.npcs.len());
        for p in self.players.values() {
            if p.character.health <= 0.0 {
                continue;
            }
            blips.push(AgentBlip {
                id: p.entity,
                faction: FACTION_REBELS,
                kind: 0,
                x: q(p.character.position.x),
                z: q(p.character.position.z),
            });
        }
        for a in &self.agents {
            if !a.alive() {
                continue;
            }
            blips.push(AgentBlip {
                id: a.entity,
                faction: a.faction,
                kind: 1,
                x: q(a.position.x),
                z: q(a.position.z),
            });
        }
        for n in self.npcs.values() {
            if !n.alive() {
                continue;
            }
            blips.push(AgentBlip {
                id: n.entity,
                faction: FACTION_WAPES,
                kind: 2,
                x: q(n.position.x),
                z: q(n.position.z),
            });
        }
        blips
    }

    /// Stream the blip snapshot to every player with the map open.
    fn broadcast_map_intel(&self) {
        if !self.players.values().any(|p| p.map_intel) {
            return;
        }
        let blips = self.map_intel_blips();
        for p in self.players.values().filter(|p| p.map_intel) {
            let _ = p.tx.send(S2C::MapIntel { blips: blips.clone() });
        }
    }

    /// Push a fresh leaderboard snapshot to every economy subscriber.
    fn broadcast_leaderboard(&mut self) {
        self.econ_subs.retain(|id| self.players.contains_key(id));
        if self.econ_subs.is_empty() {
            return;
        }
        let data = self.leaderboard();
        for id in &self.econ_subs {
            if let Some(player) = self.players.get(id) {
                let _ = player.tx.send(S2C::LeaderboardState(data.clone()));
            }
        }
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
        let leaderboard = self.leaderboard();
        if let Some(player) = self.players.get(&entity) {
            let _ = player.tx.send(S2C::EconomyState { stats, recent });
            let _ = player.tx.send(S2C::LeaderboardState(leaderboard));
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
    ///
    /// Each service docks to a real building door spot (a storefront face of
    /// an existing procedural building). Buildings are sparse per chunk, so
    /// doors are gathered from the target chunk and its 8 neighbours and the
    /// nearest free one to the chunk's anchor wins.
    fn seed_district(&mut self) {
        let placements = || DISTRICT.iter().chain(OUTPOSTS.iter());
        let mut chunk_order: Vec<(i32, i32)> = Vec::new();
        for &(c, _, _) in placements() {
            if !chunk_order.contains(&c) {
                chunk_order.push(c);
            }
        }
        let mut used: Vec<Vec3> = Vec::new();
        for c in chunk_order {
            let stations: Vec<(EntityKind, &str)> = placements()
                .filter(|&&(cc, _, _)| cc == c)
                .map(|&(_, kind, name)| (kind, name))
                .collect();
            let coord = ChunkCoord::new(c.0, c.1);
            let mut doors: Vec<Vec3> = Vec::new();
            let gather = |doors: &mut Vec<Vec3>, r: i32, chunks: &mut ChunkCache| {
                for dz in -r..=r {
                    for dx in -r..=r {
                        if dx.abs().max(dz.abs()) != r && r != 0 {
                            continue; // only the new ring
                        }
                        let n = ChunkCoord::new(coord.x + dx, coord.z + dz);
                        let chunk = chunks.get(n);
                        doors.extend(door_spots(&chunk, n));
                    }
                }
            };
            gather(&mut doors, 0, &mut self.chunks);
            gather(&mut doors, 1, &mut self.chunks);
            let mut gathered_r = 1;
            let anchor = if c == (0, 0) {
                SPAWN
            } else {
                Vec3::new(
                    (coord.x as f32 + 0.5) * CHUNK_SIZE,
                    0.0,
                    (coord.z as f32 + 0.5) * CHUNK_SIZE,
                )
            };
            for &(kind, name) in &stations {
                let mut picked = pick_door(&doors, &used, anchor);
                // Building-poor neighbourhoods: widen the search ring until
                // a free storefront turns up (bounded to stay near target).
                while picked.is_none() && gathered_r < 3 {
                    gathered_r += 1;
                    gather(&mut doors, gathered_r, &mut self.chunks);
                    picked = pick_door(&doors, &used, anchor);
                }
                let Some(pos) = picked else {
                    tracing::warn!(?coord, name, "no free storefront door for service");
                    continue;
                };
                used.push(pos);
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

    /// Compute and register the walk-in interior for every service building.
    /// Runs once after `seed_district`: rooms are pure derived data (chunk
    /// geometry + entity positions), so this never needs to persist anything.
    fn register_interiors(&mut self) {
        let mut per_chunk: HashMap<ChunkCoord, Vec<(EntityId, EntityKind, Vec3)>> = HashMap::new();
        for s in self.statics.values() {
            if interiors::is_service_kind(s.kind) {
                per_chunk
                    .entry(ChunkCoord::from_world(s.position))
                    .or_default()
                    .push((s.entity, s.kind, s.position));
            }
        }
        for (coord, services) in per_chunk {
            let chunk = self.chunks.get(coord);
            let ints = interiors::chunk_interiors(&chunk, &services);
            if ints.is_empty() {
                continue;
            }
            for spec in &ints.specs {
                for door in &spec.doors {
                    self.interior_bounds.insert(door.entity, spec.bounds);
                }
            }
            self.chunks.set_interiors(coord, ints);
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
        // Hot faction agents replicate like NPCs (cold agents don't exist as
        // entities; tier flips drive spawn/despawn through the known-entity
        // diff below).
        for agent in self.agents.iter() {
            if agent.tier != Tier::Hot || !agent.alive() {
                continue;
            }
            all.push(Replicated {
                id: agent.entity,
                chunk: agent.chunk(),
                spawn: agent.spawn_data(factions::faction_color(agent.faction)),
                snap: agent.snapshot(),
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
                    faction: FACTION_NEUTRAL,
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
        for pickup in self.pickups.values() {
            all.push(Replicated {
                id: pickup.entity,
                chunk: ChunkCoord::from_world(pickup.position),
                spawn: EntitySpawnData {
                    id: pickup.entity,
                    kind: EntityKind::CurrencyPickup,
                    name: match pickup.currency {
                        Currency::Wild => "WILD".into(),
                        Currency::Shards => "Shards".into(),
                        Currency::Energy => "Energy".into(),
                    },
                    appearance: Appearance::default(),
                    position: pickup.position,
                    yaw: 0.0,
                    anim: AnimState::Idle,
                    health_pct: 1.0,
                    // Currency type drives the client's pickup look.
                    variant: pickup.currency.variant(),
                    item: None,
                    faction: FACTION_NEUTRAL,
                },
                snap: EntitySnapshot {
                    id: pickup.entity,
                    position: pickup.position,
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
                    faction: FACTION_NEUTRAL,
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
                    faction: FACTION_NEUTRAL,
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
            // Push currency balances whenever any of them changed (join,
            // vendor/market/bank flows, salvage, energy grants).
            let balances = (player.wallet, player.shards, player.energy);
            if player.wallet_sent != Some(balances) {
                player.wallet_sent = Some(balances);
                let _ = player.tx.send(S2C::WalletUpdate {
                    wild: balances.0,
                    shards: balances.1,
                    energy: balances.2,
                });
            }
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
        // Faction agents: identity, goods and position survive restarts.
        let agent_saves: Vec<AgentSave> = self.agents.iter().map(|a| a.save()).collect();
        if let Err(e) = self.store.save_meta("faction_agents", &agent_saves) {
            tracing::error!("agent save failed: {e}");
        }
        // Leaderboard stats book (competitor records + lifetime rollups).
        if let Err(e) = self.store.save_meta("stats_book", &self.stats) {
            tracing::error!("stats save failed: {e}");
        }
        // War map: persist region control when it changed since the last save.
        if self.territory_dirty {
            let cells: Vec<(i32, i32, FactionId)> =
                self.territory.iter().map(|(&(x, z), &f)| (x, z, f)).collect();
            match self.store.save_meta("territory", &cells) {
                Ok(()) => self.territory_dirty = false,
                Err(e) => tracing::error!("territory save failed: {e}"),
            }
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
        // Every district/outpost chunk (plus the neighbour rings the seeder
        // may widen to) yields enough free storefront doors for its services.
        let generator = TerrainGenerator::new(0);
        for &(c, _, _) in DISTRICT.iter().chain(OUTPOSTS.iter()) {
            let coord = ChunkCoord::new(c.0, c.1);
            let wanted = DISTRICT
                .iter()
                .chain(OUTPOSTS.iter())
                .filter(|&&(cc, _, _)| cc == c)
                .count();
            let mut doors: Vec<Vec3> = Vec::new();
            for dz in -3..=3 {
                for dx in -3..=3 {
                    let n = ChunkCoord::new(coord.x + dx, coord.z + dz);
                    doors.extend(door_spots(&generator.generate(n), n));
                }
            }
            let anchor = Vec3::new(
                (coord.x as f32 + 0.5) * CHUNK_SIZE,
                0.0,
                (coord.z as f32 + 0.5) * CHUNK_SIZE,
            );
            let mut used: Vec<Vec3> = Vec::new();
            for _ in 0..wanted {
                let picked = pick_door(&doors, &used, anchor);
                assert!(picked.is_some(), "chunk {coord:?} too cramped");
                used.push(picked.unwrap());
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

    /// A minimal world (no tick loop, no connections) for agent/district
    /// tests. The TempDir must outlive the world.
    fn test_world() -> (World, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(RocksStore::open(dir.path()).unwrap());
        let (_tx, rx) = mpsc::unbounded_channel();
        std::mem::forget(_tx); // keep the channel alive without a runtime
        let seed = 42;
        let world = World {
            store: store.clone(),
            chunks: ChunkCache::new(TerrainGenerator::new(seed), store),
            market: Vec::new(),
            next_listing_id: 1,
            next_job_id: 1,
            players: HashMap::new(),
            npcs: HashMap::new(),
            npc_seeded_chunks: HashSet::new(),
            loot: HashMap::new(),
            pickups: HashMap::new(),
            statics: HashMap::new(),
            interior_bounds: HashMap::new(),
            nodes: HashMap::new(),
            static_seeded_chunks: HashSet::new(),
            next_entity: 1,
            tick: 0,
            seed,
            rng: SmallRng::seed_from_u64(seed),
            rx,
            territory: HashMap::new(),
            territory_dirty: false,
            ledger: Ledger::new(LedgerSave::default()),
            stats: StatsBook::default(),
            econ_subs: HashSet::new(),
            agents: Vec::new(),
            agent_by_entity: HashMap::new(),
            agent_grid: HashMap::new(),
            agent_path_queue: std::collections::VecDeque::new(),
            recent_attacks: HashMap::new(),
            district_spots: Vec::new(),
        };
        (world, dir)
    }

    fn spawn_test_agent(
        world: &mut World,
        faction: FactionId,
        role: Role,
        position: Vec3,
    ) -> usize {
        let (agent_id, name) = mint_agent_name(faction);
        let entity = world.alloc_entity();
        let agent = FactionAgent::from_save(
            entity,
            AgentSave {
                agent_id,
                name,
                faction,
                guild: guild_for(faction, 0),
                role,
                home: 0,
                home_spot: None,
                wallet: 100,
                inventory: vec![ItemStack { kind: ItemKind::Pipe, count: 1 }],
                position,
                health: 100.0,
                max_health: 100.0,
            },
        );
        let idx = world.agents.len();
        world.agent_by_entity.insert(entity, idx);
        world.agents.push(agent);
        idx
    }

    fn district_anchor(name: &str) -> Vec3 {
        let d = districts::district_defs().iter().find(|d| d.name == name).unwrap();
        Vec3::new(d.x, 0.0, d.z)
    }

    #[test]
    fn every_district_gets_a_service_cluster() {
        let (mut world, _dir) = test_world();
        world.seed_neighborhood_stores();
        let defs = districts::district_defs();
        assert_eq!(world.district_spots.len(), defs.len());
        for (di, def) in defs.iter().enumerate() {
            let anchor = Vec3::new(def.x, 0.0, def.z);
            for kind in [
                EntityKind::Bodega,
                EntityKind::Armory,
                EntityKind::Bank,
                EntityKind::MarketTerminal,
                EntityKind::Safehouse,
            ] {
                let near = world
                    .statics
                    .values()
                    .filter(|s| s.kind == kind)
                    .any(|s| (s.position - anchor).length() < 400.0);
                assert!(near, "{} missing a {:?} near its anchor", def.name, kind);
            }
            let industrial = matches!(def.danger, DangerLevel::Contested | DangerLevel::Warzone);
            let has_refinery = world
                .statics
                .values()
                .filter(|s| s.kind == EntityKind::Refinery)
                .any(|s| (s.position - anchor).length() < 400.0);
            assert_eq!(
                industrial, has_refinery,
                "{} refinery presence should match its danger level",
                def.name
            );
            // Staging spot resolved to something real (not the SPAWN default).
            assert!((world.district_spots[di] - anchor).length() < 400.0);
        }
        // Every district service appears in the POI list for the map.
        let pois = world.poi_list();
        assert!(pois.iter().any(|p| p.name.contains("Bodega") && p.name.contains("Nexus")));
    }

    #[test]
    fn store_seeding_is_deterministic() {
        let (mut a, _da) = test_world();
        let (mut b, _db) = test_world();
        a.seed_neighborhood_stores();
        b.seed_neighborhood_stores();
        let mut pa: Vec<(String, i32, i32)> = a
            .statics
            .values()
            .map(|s| (s.name.clone(), s.position.x as i32, s.position.z as i32))
            .collect();
        let mut pb: Vec<(String, i32, i32)> = b
            .statics
            .values()
            .map(|s| (s.name.clone(), s.position.x as i32, s.position.z as i32))
            .collect();
        pa.sort();
        pb.sort();
        assert_eq!(pa, pb);
    }

    #[test]
    fn combat_gating_by_district_danger() {
        let (mut world, _dir) = test_world();
        // Sanctuary ground blocks everything.
        let sanctuary = district_anchor("TRANQUILITY GARDENS");
        let a1 = spawn_test_agent(&mut world, FACTION_REBELS, Role::Raider, sanctuary);
        let a2 = spawn_test_agent(&mut world, FACTION_FORUM, Role::Raider, sanctuary);
        let (e1, e2) = (world.agents[a1].entity, world.agents[a2].entity);
        assert!(!world.deal_damage(e1, e2, 10.0, None));
        assert_eq!(world.agents[a2].health, 100.0);

        // Contested ground: hostile factions trade damage freely.
        let contested = district_anchor("NEXUS");
        let b1 = spawn_test_agent(&mut world, FACTION_REBELS, Role::Raider, contested);
        let b2 = spawn_test_agent(&mut world, FACTION_FORUM, Role::Raider, contested);
        let (f1, f2) = (world.agents[b1].entity, world.agents[b2].entity);
        assert!(world.deal_damage(f1, f2, 10.0, None));
        assert_eq!(world.agents[b2].health, 90.0);
        // Same faction never fights, anywhere.
        let b3 = spawn_test_agent(&mut world, FACTION_REBELS, Role::Raider, contested);
        let f3 = world.agents[b3].entity;
        assert!(!world.deal_damage(f1, f3, 10.0, None));

        // Guarded ground: only the home faction may aggress...
        let rebel_home = district_anchor("LITTLE MEOW");
        let g1 = spawn_test_agent(&mut world, FACTION_REBELS, Role::Enforcer, rebel_home);
        let g2 = spawn_test_agent(&mut world, FACTION_FORUM, Role::Raider, rebel_home);
        let (h1, h2) = (world.agents[g1].entity, world.agents[g2].entity);
        // Forum attacking a rebel on rebel home turf: blocked.
        assert!(!world.deal_damage(h2, h1, 10.0, None));
        // Rebel (home faction) attacking the intruder: allowed.
        assert!(world.deal_damage(h1, h2, 10.0, None));
        // ...and now the intruder may retaliate against its attacker.
        assert!(world.deal_damage(h2, h1, 10.0, None));
    }

    #[test]
    fn agent_death_burns_goods_and_respawns_fresh_identity() {
        let (mut world, _dir) = test_world();
        world.seed_neighborhood_stores();
        let contested = district_anchor("NEXUS");
        let idx = spawn_test_agent(&mut world, FACTION_FORUM, Role::Scavenger, contested);
        let old_id = world.agents[idx].agent_id;
        let old_entity = world.agents[idx].entity;
        world.kill_agent(idx, true);
        assert!(!world.agents[idx].alive());
        assert_eq!(world.agents[idx].wallet, 0);
        assert!(world.agents[idx].inventory.is_empty());
        // A loot container dropped where the body fell.
        assert!(world
            .loot
            .values()
            .any(|l| (l.position - contested).length() < 10.0));
        // Fast-forward the respawn timer.
        world.agents[idx].respawn_in = 0.0;
        world.respawn_agent(idx);
        let agent = &world.agents[idx];
        assert!(agent.alive());
        assert_ne!(agent.agent_id, old_id, "respawn must mint a fresh identity");
        assert_ne!(agent.entity, old_entity);
        // Respawned at the faction's Guarded home district.
        let home = district_anchor("NORTH STAR");
        assert!(
            (agent.position - home).length() < 500.0,
            "forum agent should respawn near North Star"
        );
        assert!(!world.agent_by_entity.contains_key(&old_entity));
    }

    #[test]
    fn agent_positions_and_destinations_stay_on_walkable_land() {
        let (mut world, _dir) = test_world();
        world.seed_neighborhood_stores();
        world.seed_agents(120);
        for idx in 0..world.agents.len() {
            let pos = world.agents[idx].position;
            assert!(
                world.chunks.walkable(pos.x, pos.z),
                "agent {idx} seeded off walkable land at {pos:?}"
            );
        }
        // Destination pickers only ever emit walkable ground.
        for idx in 0..40 {
            let wander = world.wander_target(idx);
            assert!(world.chunks.walkable(wander.x, wander.z), "wander target in water");
            let front = world.patrol_front(idx);
            assert!(world.chunks.walkable(front.x, front.z), "patrol target in water");
            let sanctuary = world.nearest_sanctuary_spot(world.agents[idx].position);
            assert!(world.chunks.walkable(sanctuary.x, sanctuary.z), "retreat target in water");
        }
        // Respawns land on walkable ground too.
        world.agents[0].health = 0.0;
        world.respawn_agent(0);
        let pos = world.agents[0].position;
        assert!(world.chunks.walkable(pos.x, pos.z), "respawn off walkable land at {pos:?}");
    }

    #[test]
    fn restored_agents_snap_out_of_the_water() {
        let (mut world, _dir) = test_world();
        world.seed_neighborhood_stores();
        let (agent_id, name) = mint_agent_name(FACTION_FORUM);
        let stranded = AgentSave {
            agent_id,
            name,
            faction: FACTION_FORUM,
            guild: guild_for(FACTION_FORUM, 7),
            role: Role::Enforcer,
            home: 7, // NORTH STAR
            home_spot: None,
            wallet: 50,
            inventory: Vec::new(),
            // Far off the baked map: open water (pre-fix drift artifacts).
            position: Vec3::new(1.0e6, 0.0, 1.0e6),
            health: 80.0,
            max_health: 100.0,
        };
        world.store.save_meta("faction_agents", &vec![stranded]).unwrap();
        world.store.save_meta("agent_seed_layout", &AGENT_SEED_LAYOUT).unwrap();
        world.load_or_seed_agents();
        assert_eq!(world.agents.len(), 1);
        let pos = world.agents[0].position;
        assert!(
            world.chunks.walkable(pos.x, pos.z),
            "restored agent still stranded at sea: {pos:?}"
        );
        // Snapped back to its home district's staging ground.
        let home_spot = world.district_spot(7);
        assert!((pos - home_spot).length() < 200.0, "agent should be home, is at {pos:?}");
    }

    #[test]
    fn hub_cohort_seeds_both_factions_in_the_combat_ring() {
        let (mut world, _dir) = test_world();
        world.seed_neighborhood_stores();
        world.seed_agents(200);
        let in_ring = |p: Vec3| p.x.hypot(p.z) < districts::HUB_COMBAT_RING_M;
        let count = |faction: FactionId| {
            world
                .agents
                .iter()
                .filter(|a| a.faction == faction && in_ring(a.position))
                .count()
        };
        // Half the population stages inside the ring, split across factions.
        let (rebels, forum) = (count(FACTION_REBELS), count(FACTION_FORUM));
        assert!(rebels >= 30, "too few hub Rebels: {rebels}");
        assert!(forum >= 30, "too few hub Forum: {forum}");
        // Hub agents carry a fixed staging spot and respawn back into the
        // ring, so the local war never drains away.
        let idx = world
            .agents
            .iter()
            .position(|a| a.home_spot.is_some())
            .expect("hub cohort missing home_spot");
        world.agents[idx].health = 0.0;
        world.respawn_agent(idx);
        assert!(
            in_ring(world.agents[idx].position),
            "hub agent respawned outside the ring: {:?}",
            world.agents[idx].position
        );
        assert!(world.agents[idx].home_spot.is_some(), "respawn dropped home_spot");
    }

    #[test]
    fn combat_patrol_fronts_are_shared_across_factions() {
        let (mut world, _dir) = test_world();
        world.seed_neighborhood_stores();
        world.seed_agents(300);
        let mut fronts = world.patrol_fronts();
        fronts.dedup_by(|a, b| (*a - *b).length() < 1.0);
        let mut per_front: Vec<[u32; 2]> = vec![[0, 0]; fronts.len()];
        for idx in 0..world.agents.len() {
            if !world.agents[idx].role.is_combatant() {
                continue;
            }
            let dest = world.patrol_front(idx);
            // Bucket the (jittered) destination to its nearest front.
            let fi = fronts
                .iter()
                .enumerate()
                .min_by(|(_, a), (_, b)| {
                    let da = (**a - dest).length_squared();
                    let db = (**b - dest).length_squared();
                    da.partial_cmp(&db).unwrap()
                })
                .map(|(i, _)| i)
                .unwrap();
            match world.agents[idx].faction {
                FACTION_REBELS => per_front[fi][0] += 1,
                FACTION_FORUM => per_front[fi][1] += 1,
                _ => {}
            }
        }
        // The hub front (last entry) is the starter playfield: it must draw
        // combatants from BOTH factions, and most fronts should be contested
        // by both sides — that's what feeds the cold statistical war.
        let hub = per_front.last().unwrap();
        assert!(hub[0] > 0 && hub[1] > 0, "hub front not contested: {per_front:?}");
        let shared = per_front.iter().filter(|c| c[0] > 0 && c[1] > 0).count();
        assert!(shared >= 3, "too few shared fronts: {per_front:?}");
    }

    #[test]
    fn cold_war_rolls_casualties_where_factions_share_a_region() {
        let (mut world, _dir) = test_world();
        world.seed_neighborhood_stores();
        // The hub front: contested ground both factions' patrols converge on.
        let front = world.nearest_walkable(HUB_FRONT_SPOT);
        assert_eq!(districts::danger_at(front), DangerLevel::Contested);
        for _ in 0..4 {
            spawn_test_agent(&mut world, FACTION_REBELS, Role::Enforcer, front);
            spawn_test_agent(&mut world, FACTION_FORUM, Role::Enforcer, front);
        }
        let no_hot: HashSet<ChunkCoord> = HashSet::new();
        for _ in 0..300 {
            world.tick_cold_combat(&no_hot);
        }
        let deaths = world.agents.iter().filter(|a| !a.alive()).count();
        assert!(deaths > 0, "co-occupied contested region should roll casualties");
    }

    #[test]
    fn agent_economy_conserves_wild() {
        let (mut world, _dir) = test_world();
        world.seed_neighborhood_stores();
        let contested = district_anchor("NEXUS");
        let idx = spawn_test_agent(&mut world, FACTION_REBELS, Role::Scavenger, contested);
        world.agents[idx].add_item(ItemKind::Iron, 20);
        let (store, _) = world.nearest_service(contested, EntityKind::Bodega).unwrap();
        let before = world.agents[idx].wallet;
        world.agent_sell(idx, store, false);
        // Bodega pays 2/iron, minus the 10% commerce cut.
        let gross = 40u32;
        let cut = gross * wilder_economy::COMMERCE_CUT_PCT / 100;
        assert_eq!(world.agents[idx].wallet, before + gross - cut);
        assert_eq!(world.agents[idx].count_item(ItemKind::Iron), 0);

        // Vendor buy round-trips through the wallet (the agent already
        // carries one Pipe from its spawn kit).
        let (armory, _) = world.nearest_service(contested, EntityKind::Armory).unwrap();
        let wallet = world.agents[idx].wallet;
        world.agent_vendor_buy(idx, armory, ItemKind::Knife, 1);
        assert_eq!(world.agents[idx].wallet, wallet - 45);
        assert_eq!(world.agents[idx].count_item(ItemKind::Knife), 1);
    }

    #[test]
    fn agents_trade_through_the_real_market_book() {
        let (mut world, _dir) = test_world();
        world.seed_neighborhood_stores();
        let contested = district_anchor("NEXUS");
        let seller = spawn_test_agent(&mut world, FACTION_REBELS, Role::Trader, contested);
        let buyer = spawn_test_agent(&mut world, FACTION_REBELS, Role::Crafter, contested);
        world.agents[seller].add_item(ItemKind::Iron, 30);
        world.agent_market_list(seller);
        assert!(!world.market.is_empty(), "trader should have listed its haul");
        let listing_price = world
            .market
            .iter()
            .find(|l| l.kind == ItemKind::Iron)
            .expect("iron listed")
            .price_each;
        let seller_wallet = world.agents[seller].wallet;
        let buyer_wallet = world.agents[buyer].wallet;
        assert!(world.agent_market_buy(buyer, ItemKind::Iron, 10, listing_price));
        let cost = listing_price * 10;
        let fee = cost * MARKET_FEE_PCT / 100;
        assert_eq!(world.agents[buyer].wallet, buyer_wallet - cost);
        assert_eq!(world.agents[seller].wallet, seller_wallet + cost - fee);
        assert_eq!(world.agents[buyer].count_item(ItemKind::Iron), 10);
    }

    /// Sanity benchmark: 2,000 cold agents ticking for 100 world ticks must
    /// complete (bucket wheel + decision staggering keep per-tick work small).
    #[test]
    fn two_thousand_cold_agents_tick_sanely() {
        let (mut world, _dir) = test_world();
        world.seed_neighborhood_stores();
        world.seed_agents(2000);
        assert_eq!(world.agents.len(), 2000);
        let start = std::time::Instant::now();
        for _ in 0..100 {
            world.tick += 1;
            world.ledger.set_tick(world.tick);
            world.tick_agents();
        }
        // No players connected: everyone must have stayed cold.
        assert!(world.agents.iter().all(|a| a.tier == Tier::Cold));
        // Generous ceiling (debug builds are slow); release target is ~10ms
        // per tick and this asserts we're nowhere near pathological.
        assert!(
            start.elapsed() < std::time::Duration::from_secs(30),
            "2000 cold agents took {:?} for 100 ticks",
            start.elapsed()
        );
    }

    #[test]
    fn territory_flips_per_faction() {
        let (mut world, _dir) = test_world();
        let contested = district_anchor("NEXUS");
        let region = region_of(contested);

        // Three Forum agents dominate the region: they take it.
        for _ in 0..3 {
            spawn_test_agent(&mut world, FACTION_FORUM, Role::Enforcer, contested);
        }
        world.tick_territory();
        assert_eq!(world.territory.get(&region), Some(&FACTION_FORUM));

        // Four Rebels move in and outnumber them: the region flips.
        for _ in 0..4 {
            spawn_test_agent(&mut world, FACTION_REBELS, Role::Enforcer, contested);
        }
        world.tick_territory();
        assert_eq!(world.territory.get(&region), Some(&FACTION_REBELS));

        // Ground held by a hostile faction taxes the other side only.
        assert!(world.region_hostile_to(contested, FACTION_FORUM));
        assert!(!world.region_hostile_to(contested, FACTION_REBELS));

        // Everyone dies: the holder keeps nothing and control relaxes.
        for agent in &mut world.agents {
            agent.health = 0.0;
        }
        world.tick_territory();
        assert_eq!(world.territory.get(&region), None);
    }

    #[test]
    fn wape_packs_capture_hub_ring_ground() {
        // Regression guard for the starter playfield's red zones: a Wape pack
        // squatting a region near the (protected) spawn hub must take it, and
        // neither the sanctuary blanket from TRANQUILITY GARDENS' Voronoi
        // cell nor the Wape territory exclusion may suppress it.
        let (mut world, _dir) = test_world();
        let spot = Vec3::new(100.0, 0.0, 100.0); // hub ring, outside safe chunks
        assert_eq!(districts::danger_at(spot), DangerLevel::Contested);
        for _ in 0..3 {
            let entity = world.alloc_entity();
            let npc = Npc::new(entity, &wilder_ai::SCAV, spot);
            world.npcs.insert(entity, npc);
        }
        world.tick_territory();
        assert_eq!(world.territory.get(&region_of(spot)), Some(&FACTION_WAPES));
        // Wape ground is hostile (taxed) for both organized factions.
        assert!(world.region_hostile_to(spot, FACTION_REBELS));
        assert!(world.region_hostile_to(spot, FACTION_FORUM));
        // The protected hub chunks themselves still never flip.
        assert_eq!(world.territory.get(&(0, 0)), None);
    }

    #[test]
    fn sanctuary_and_guarded_ground_resist_capture() {
        let (mut world, _dir) = test_world();

        // Sanctuary never lights up, no matter who stands there.
        let sanctuary = district_anchor("TRANQUILITY GARDENS");
        for _ in 0..5 {
            spawn_test_agent(&mut world, FACTION_FORUM, Role::Enforcer, sanctuary);
        }
        world.tick_territory();
        assert_eq!(world.territory.get(&region_of(sanctuary)), None);

        // Guarded home turf only ever lights up for its home faction, even
        // when hostiles outnumber the residents.
        let rebel_home = district_anchor("LITTLE MEOW");
        spawn_test_agent(&mut world, FACTION_REBELS, Role::Scavenger, rebel_home);
        for _ in 0..6 {
            spawn_test_agent(&mut world, FACTION_FORUM, Role::Enforcer, rebel_home);
        }
        world.tick_territory();
        assert_eq!(world.territory.get(&region_of(rebel_home)), Some(&FACTION_REBELS));
    }

    #[test]
    fn kills_feed_the_leaderboard() {
        let (mut world, _dir) = test_world();
        world.seed_neighborhood_stores();
        let contested = district_anchor("NEXUS");
        let killer = spawn_test_agent(&mut world, FACTION_REBELS, Role::Raider, contested);
        let victim = spawn_test_agent(&mut world, FACTION_FORUM, Role::Scavenger, contested);
        let (ke, ve) = (world.agents[killer].entity, world.agents[victim].entity);
        let killer_name = world.agents[killer].name.clone();
        let killer_guild = world.agents[killer].guild.clone();
        assert!(world.deal_damage(ke, ve, 1000.0, None));
        assert!(!world.agents[victim].alive());

        let data = world.leaderboard();
        let kills = data.boards.iter().find(|b| b.category == "Kills").unwrap();
        assert_eq!(kills.rows[0].name, killer_name);
        assert_eq!(kills.rows[0].value, 1);
        assert_eq!(kills.rows[0].guild.as_deref(), Some(killer_guild.as_str()));
        let rebels = data.factions.iter().find(|f| f.faction == FACTION_REBELS).unwrap();
        let forum = data.factions.iter().find(|f| f.faction == FACTION_FORUM).unwrap();
        assert_eq!(rebels.kills, 1);
        assert_eq!(forum.deaths, 1);
        assert!(data.guilds.iter().any(|g| g.name == killer_guild && g.kills == 1));

        // The dead identity respawns fresh: its row retires off the boards,
        // but the faction/guild lifetime totals keep the death.
        world.agents[victim].respawn_in = 0.0;
        world.respawn_agent(victim);
        let data = world.leaderboard();
        let forum = data.factions.iter().find(|f| f.faction == FACTION_FORUM).unwrap();
        assert_eq!(forum.deaths, 1);
    }

    #[test]
    fn territory_survives_restart() {
        let dir = tempfile::tempdir().unwrap();
        {
            let (mut world, _d) = test_world();
            // Reuse a fresh store rooted in `dir` for a real save/load cycle.
            let store = Arc::new(RocksStore::open(dir.path()).unwrap());
            world.store = store;
            world.territory.insert((7, -3), FACTION_FORUM);
            world.territory_dirty = true;
            world.save_all();
        }
        let store = Arc::new(RocksStore::open(dir.path()).unwrap());
        let cells: Vec<(i32, i32, FactionId)> =
            store.meta("territory").unwrap().unwrap_or_default();
        assert_eq!(cells, vec![(7, -3, FACTION_FORUM)]);
    }
}
