//! The authoritative world simulation.
//!
//! Runs as a single tokio task at TICK_HZ. WebSocket connections talk to it
//! through a command channel; it replies through per-player message channels.

pub mod agents;
mod chunks;
pub mod districts;
pub mod econ;
pub mod factions;
pub mod interiors;
mod ledger;
pub mod market_stats;
pub mod stats;

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;
use std::time::{Duration, Instant};

use rand::rngs::SmallRng;
use rand::SeedableRng;
use tokio::sync::{mpsc, oneshot};
use wilder_combat::{
    ability_stats, armor_multiplier, armor_shield, weapon_stats, FIST, OVERCHARGE_MULT,
    SHIELD_REGEN_DELAY, SHIELD_REGEN_RATE, SHOCKWAVE_DAMAGE, SHOCKWAVE_KNOCKBACK,
    SHOCKWAVE_RADIUS, STIM_HEAL, STIM_SPEED_DURATION, STIM_SPEED_MULT,
};
use wilder_inventory as inv;
use serde::{Deserialize, Serialize};
use wilder_pathfinding::find_path;
use wilder_persistence::{CharacterStore, RocksStore, Stash, WorldStore};
use wilder_physics::{
    nudge, position_clear, step_move, step_move_speed, CollisionWorld, CROUCH_SPEED,
    PLAYER_RADIUS, ROLL_COOLDOWN, ROLL_DURATION, ROLL_SPEED, RUN_SPEED,
};
use wilder_protocol::*;
use wilder_replication::{diff_view, view_set, VIEW_RADIUS};
use wilder_terrain::TerrainGenerator;
use wilder_types::*;

pub use chunks::ChunkCache;
use agents::{
    activity_name, activity_of, base_value, goal_activity_label, guild_for, mint_agent_name,
    Activity,
    AgentEvent, AgentSave, FactionAgent, Goal, TargetInfo, Tier, Traits,
    AGENT_RESPAWN_SECONDS, COLD_BUCKETS, COLD_TICK_BUDGET, HOT_RADIUS_CHUNKS,
    RETREAT_HEALTH_PCT, SPAWN_PROTECT_SECONDS, WEALTH_RETREAT, ACTIVITIES,
};
use econ::{Currency, EconActor, OwnerId, Purse};
use factions::{are_hostile, faction_registry};
use ledger::{Ledger, LedgerSave, SupplyEffect};
use market_stats::{MarketStats, MarketStatsSave};
use stats::{build_leaderboard, ActorRef, LiveActor, StatsBook};
use smallvec::SmallVec;

pub const TICK_HZ: u32 = 20;
pub const TICK_DT: f32 = 1.0 / TICK_HZ as f32;
/// Persist characters/chunks every this many ticks (10 s).
const SAVE_INTERVAL_TICKS: u64 = 200;
/// Agents per persisted shard. Shards save round-robin on their own cadence
/// so agent persistence never serializes the whole population in one tick
/// (a 50k-agent JSON blob is a multi-ms spike); the full population still
/// cycles through roughly every `SAVE_INTERVAL_TICKS`.
const AGENT_SAVE_SHARD: usize = 1024;

/// Check disk pressure (and maybe purge) this often (20 Hz -> ~60 s).
const PURGE_CHECK_TICKS: u64 = TICK_HZ as u64 * 60;
/// Username prefix that marks a throwaway per-tab guest identity (see the web
/// client's `bootstrap`). Only these are ever auto-purged.
const GUEST_PREFIX: &str = "runner_";
/// Cap guest deletions per purge pass so a large backlog drains over several
/// 60 s passes instead of stalling one sim tick with a huge write batch.
const MAX_PURGE_PER_PASS: usize = 5000;
const GIB: f64 = (1024 * 1024 * 1024) as f64;

/// Serializes the off-thread post-purge compaction so we never launch a second
/// compaction while one is still running.
static PURGE_COMPACTING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Reclaim disk once the store passes this many bytes (env
/// `WILDER_DISK_HIGH_WATER_GB`, default 40 GB — matches the 50 GB disk).
fn disk_high_water_bytes() -> u64 {
    let gb = std::env::var("WILDER_DISK_HIGH_WATER_GB")
        .ok()
        .and_then(|v| v.parse::<f64>().ok())
        .filter(|g| *g > 0.0)
        .unwrap_or(40.0);
    (gb * GIB) as u64
}

/// Minimum age a guest account must reach before it's eligible for purge (env
/// `WILDER_GUEST_MIN_AGE_SECS`, default 24 h). Guards against nuking a guest
/// that just registered but hasn't connected yet.
fn guest_min_age_secs() -> u64 {
    std::env::var("WILDER_GUEST_MIN_AGE_SECS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(24 * 60 * 60)
}

fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

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
const AGENT_SEED_LAYOUT: u32 = 6;
/// Chunks with |x|<=SAFE_RADIUS and |z|<=SAFE_RADIUS are the safe hub.
const SAFE_RADIUS: i32 = 1;
/// Congestion model for service routing (Bodega/Armory/craft stations).
/// A storefront comfortably serves this many agents at once; each peer
/// already committed there past that softens its appeal, so a cohort splits
/// across services and, once every sink is jammed, the errand loses out to
/// gathering/crafting entirely (agents defer instead of piling on a door).
const SERVICE_CAPACITY: f32 = 5.0;
/// Travel distance (m) at which a service's appeal halves. Agents prefer a
/// near service but will detour to a much emptier one farther away.
const SERVICE_TRAVEL_HALF: f32 = 120.0;
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
/// Loot (ammo caches, agent/player drops) is grabbed automatically when a
/// player walks within this distance (metres) - no click required. Click
/// pickup only works with a free cursor, which mouse-look play never has.
const LOOT_PICKUP_RADIUS: f32 = 2.0;
/// Min seconds between auto-pickup "backpack full" denials per player, so
/// standing on loot with a full pack doesn't spam the toast/sound each tick.
const AUTO_PICKUP_DENY_COOLDOWN: f64 = 3.0;
/// Resource node: gathers before depletion, respawn delay, per-gather cooldown.
/// Compiled defaults; charge count, respawn and density read optional env
/// overrides once at world init (see [`NodeTuning::from_env`]).
const NODE_CHARGES: u32 = 5;
const NODE_RESPAWN_SECONDS: f32 = 60.0;
const NODE_GATHER_COOLDOWN: f32 = 1.2;
/// Resource nodes per hostile chunk (env `WILDER_NODES_PER_CHUNK`); one node
/// per ~2 chunks couldn't feed the agent population now that agents mine the
/// same real nodes players do.
const NODES_PER_HOSTILE_CHUNK: usize = 3;
/// Chebyshev chunk radius `best_gather_node` searches around an agent.
const NODE_SEARCH_CHUNKS: i32 = 2;
/// Max agents claiming one node at a time, so a cohort spreads across the
/// local deposits instead of queueing on whichever looked closest.
const NODE_CLAIM_CAP: u32 = 2;
/// Chance for a blueprint fragment to drop from node gathers.
const FRAGMENT_CHANCE: f64 = 0.10;
/// Max jobs queued at one production building (all owners combined), so
/// agents can't pile a queue up infinitely.
const PRODUCTION_QUEUE_CAP: usize = 16;
/// Reference MILD value of one Energy for agent utility scoring (Energy has
/// no market price yet; this is what the craft EV charges per unit burned).
const ENERGY_MILD_VALUE: f32 = 3.0;
/// Market fee (percent) taken from every sale: routed to whoever holds the
/// market's territory, burned otherwise.
const MARKET_FEE_PCT: u32 = 5;
/// Order book capacity (listings). Agents stop listing at the cap unless a
/// dead floor-priced agent listing can be scrapped to make room.
const MARKET_BOOK_CAP: usize = 200;
/// Agent asks decay toward their price floor every this many ticks (~15 s):
/// unsold stock walks down to meet demand instead of clogging the book.
const MARKET_DECAY_TICKS: u64 = 300;
/// MILD granted to every account once.
const WALLET_GRANT: u32 = 200;
/// Max agents one character can own at a time.
const MAX_OWNED_AGENTS: usize = 5;
/// Percent of an owned agent's bank deposits routed to the owner's banked
/// MILD (the "earnings share").
const OWNER_SHARE_PCT: u32 = 15;
/// Hire pricing: `base + wealth/2 + trait_rate * strongest payoff EMA`.
/// Wealth is the agent's total MILD (carried + banked) — buying an agent's
/// savings costs half their face value; the trait term prices proven skill
/// (payoff EMAs are MILD/min, so a 40 MILD/min specialist adds 10,000).
/// A character's FIRST hire is free (starter grant).
const AGENT_HIRE_BASE: u32 = 500;
const AGENT_HIRE_TRAIT_RATE: f32 = 250.0;
/// Candidates returned by an `AgentHireList` request.
const AGENT_HIRE_OFFERS: usize = 20;
/// Ring capacity of one owned agent's live activity log.
const AGENT_LOG_CAP: usize = 64;
/// Re-send `AgentRoster` to subscribers every N ticks (~2 s).
const AGENT_ROSTER_TICK_INTERVAL: u64 = 40;
/// Re-push `AgentDetail` to watchers every N ticks (~1 s).
const AGENT_DETAIL_TICK_INTERVAL: u64 = 20;
/// Safehouse bubble radius (metres): hostiles ignore players inside and
/// health regen applies as if in the safe hub.
const SAFEHOUSE_RADIUS: f32 = 10.0;
/// Themed resource zones ring the hub out to this chunk radius (Chebyshev);
/// everything beyond is `ZoneKind::Mixed`.
const ZONE_RING_CHUNKS: i32 = 6;
/// Recipes every actor knows from the start; the rest need lab research.
/// (Canonical set lives beside the recipes in wilder-crafting.)
const DEFAULT_BLUEPRINTS: &[&str] = wilder_crafting::DEFAULT_BLUEPRINTS;
/// Research cost: fragments + resources + Energy consumed per unlock.
const RESEARCH_FRAGMENTS: u32 = 2;
const RESEARCH_RESOURCES: &[(ItemKind, u32)] =
    &[(ItemKind::Electronics, 5), (ItemKind::Chemicals, 5)];
const RESEARCH_ENERGY: u32 = wilder_crafting::RESEARCH_ENERGY;
/// XP granted per agent kill.
const XP_RAIDER_KILL: u32 = 50;

/// Territory control is a `FactionId` per region (`FACTION_NEUTRAL` = free).
/// The wire encoding in `wilder_protocol::TerritoryCell` carries the id raw.
///
/// Capture is Halo-style: a cell is claimed by the sole faction standing in
/// it (first there wins an empty/neutral cell), an occupied cell only flips
/// once every enemy body is cleared out, and ownership persists while the
/// cell is empty. A cell with two or more factions present is a standoff and
/// does not change hands.
///
/// Fraction (percent) of gathered/extracted yield seized in enemy regions.
const TERRITORY_TAX_PCT: u32 = 25;
/// Recompute territory occupancy every N ticks (20 Hz -> ~1 Hz).
const TERRITORY_TICK_INTERVAL: u64 = 20;
/// Field-intel strength attributed to a connected player (agents read this
/// when weighing local force balance; roughly a pistol-armed fighter).
const PLAYER_INTEL_STRENGTH: f32 = 20.0;
/// Per-intel-tick (~1 s) decay of a region's observed commerce income.
const INTEL_INCOME_DECAY: f32 = 0.99;
/// Per-intel-tick decay of a region's recent-casualty signal.
const INTEL_CASUALTY_DECAY: f32 = 0.95;
/// Recount agents committed to each congestible service every N ticks; the
/// count stays live between recounts as `decide_agent` reassigns agents.
const SERVICE_LOAD_RECOUNT_INTERVAL: u64 = 20;
/// Faction slots the zone clock tracks (ids 0..=3: neutral, rebels, forum,
/// wapes).
const ZONE_FACTIONS: usize = 4;
/// Rolling window (seconds) for the dashboard "zone points" momentum metric,
/// split into fixed-size buckets that expire off the tail.
const ZONE_WINDOW_SECS: f64 = 3600.0;
const ZONE_BUCKET_SECS: f64 = 60.0;
const ZONE_BUCKETS: usize = (ZONE_WINDOW_SECS / ZONE_BUCKET_SECS) as usize;
/// Refresh leaderboards for economy subscribers every N ticks (~5 s).
const LEADERBOARD_TICK_INTERVAL: u64 = 100;
/// Re-push watched item market detail (on new fills) every N ticks (~1 s).
const ITEM_MARKET_TICK_INTERVAL: u64 = 20;
/// Stream whole-map intel blips to map subscribers every N ticks (~5 Hz) so
/// actor motion on the open map reads as smooth, live movement.
const MAP_INTEL_TICK_INTERVAL: u64 = 4;
/// Log the per-system tick-time breakdown every N ticks (~30 s).
const TIMING_LOG_TICKS: u64 = 600;

/// Phases of `World::step`, in execution order, for per-system wall-time
/// accounting. Timing is always on: two `Instant::now()` reads per phase are
/// noise next to the systems they wrap.
#[derive(Clone, Copy, PartialEq, Eq)]
enum TickPhase {
    Movement,
    Agents,
    Separation,
    Loot,
    Production,
    Territory,
    Regen,
    Interest,
    Replicate,
    Economy,
    Broadcasts,
    Save,
}

impl TickPhase {
    const COUNT: usize = 12;

    const ALL: [TickPhase; TickPhase::COUNT] = [
        TickPhase::Movement,
        TickPhase::Agents,
        TickPhase::Separation,
        TickPhase::Loot,
        TickPhase::Production,
        TickPhase::Territory,
        TickPhase::Regen,
        TickPhase::Interest,
        TickPhase::Replicate,
        TickPhase::Economy,
        TickPhase::Broadcasts,
        TickPhase::Save,
    ];

    fn name(self) -> &'static str {
        match self {
            TickPhase::Movement => "movement",
            TickPhase::Agents => "agents",
            TickPhase::Separation => "separation",
            TickPhase::Loot => "loot",
            TickPhase::Production => "production",
            TickPhase::Territory => "territory",
            TickPhase::Regen => "regen",
            TickPhase::Interest => "interest",
            TickPhase::Replicate => "replicate",
            TickPhase::Economy => "economy",
            TickPhase::Broadcasts => "broadcasts",
            TickPhase::Save => "save",
        }
    }
}

/// Accumulated wall time per `step()` phase since the last reset. The live
/// loop logs+resets every `TIMING_LOG_TICKS`; the headless benchmark reads a
/// summary at the end of its run.
#[derive(Default)]
struct TickTimings {
    accum: [Duration; TickPhase::COUNT],
    total: Duration,
    max_total: Duration,
    ticks: u64,
}

impl TickTimings {
    fn add(&mut self, phase: TickPhase, elapsed: Duration) {
        self.accum[phase as usize] += elapsed;
    }

    fn finish_tick(&mut self, total: Duration) {
        self.total += total;
        self.max_total = self.max_total.max(total);
        self.ticks += 1;
    }

    fn avg_tick(&self) -> Duration {
        if self.ticks == 0 {
            return Duration::ZERO;
        }
        self.total / self.ticks as u32
    }

    /// Per-phase average micros per tick, formatted, slowest first.
    /// Phases that averaged under a microsecond are omitted.
    fn summary(&self) -> String {
        if self.ticks == 0 {
            return "no ticks".into();
        }
        let mut avg_us: Vec<(&'static str, u128)> = TickPhase::ALL
            .iter()
            .map(|&phase| {
                (phase.name(), self.accum[phase as usize].as_micros() / self.ticks as u128)
            })
            .filter(|&(_, us)| us > 0)
            .collect();
        avg_us.sort_by(|a, b| b.1.cmp(&a.1));
        avg_us
            .iter()
            .map(|(name, us)| format!("{name}={us}us"))
            .collect::<Vec<_>>()
            .join(" ")
    }

    fn reset(&mut self) {
        *self = TickTimings::default();
    }
}

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

/// Live per-region field intel, rebuilt once per territory tick (~1 Hz) from
/// the same presence sweep that settles ownership. This is what agents "see"
/// when they re-score goals: local force balance, who holds the ground, and
/// how much commerce has recently flowed through it.
#[derive(Debug, Clone, Copy, Default)]
struct RegionIntel {
    /// Current controller after this tick (FACTION_NEUTRAL = unheld).
    controller: FactionId,
    /// Alive bodies per side (players count under their own faction).
    rebels: u32,
    forum: u32,
    wapes: u32,
    /// Summed combat strength per side (see `FactionAgent::strength`).
    rebel_strength: f32,
    forum_strength: f32,
    wape_strength: f32,
    /// Decaying accumulator of commerce MILD routed through this region —
    /// the *observed* economic worth of holding the ground.
    income: f32,
    /// Decaying count of recent kills here (danger signal).
    casualties: f32,
}

impl RegionIntel {
    /// (friendly bodies, hostile bodies, friendly strength, hostile
    /// strength) from `faction`'s point of view. All three factions are
    /// mutually hostile, so everyone else counts as the enemy side.
    fn sides(&self, faction: FactionId) -> (u32, u32, f32, f32) {
        match faction {
            FACTION_REBELS => (
                self.rebels,
                self.forum + self.wapes,
                self.rebel_strength,
                self.forum_strength + self.wape_strength,
            ),
            FACTION_FORUM => (
                self.forum,
                self.rebels + self.wapes,
                self.forum_strength,
                self.rebel_strength + self.wape_strength,
            ),
            FACTION_WAPES => (
                self.wapes,
                self.rebels + self.forum,
                self.wape_strength,
                self.rebel_strength + self.forum_strength,
            ),
            _ => (0, 0, 0.0, 0.0),
        }
    }
}

/// Marginal value of one more friendly body pushing into a region we do
/// NOT hold (Halo rules: the sole faction present claims the cell, standoffs
/// don't flip). Highest for the first body into clean ground; decays as
/// friendlies pile on (their presence is no longer pivotal).
fn capture_pivotality(mine: u32, enemy: u32) -> f32 {
    if enemy == 0 {
        // Walk-in claim: the first body flips it, extras are redundant.
        if mine == 0 {
            1.0
        } else {
            0.35 / mine as f32
        }
    } else {
        // Contested: bodies matter until the last enemy is cleared, but with
        // diminishing returns as our side stacks up.
        0.8 / (1.0 + mine as f32 * 0.5)
    }
}

/// Marginal value of one more friendly body holding a region we DO hold.
/// Empty-but-held ground persists (no defense needed); ground with enemies
/// on it flips the moment our last body leaves, so thin defenses score high
/// — and higher than walk-in claims of equal-value ground, because a flip
/// loses income we already collect.
fn defend_pivotality(mine: u32, enemy: u32) -> f32 {
    if enemy == 0 {
        0.0
    } else if mine == 0 {
        1.5 // about to flip: most urgent territory play there is
    } else {
        1.2 / mine as f32
    }
}

/// Sliding-window accumulator of zone-seconds held per district and faction.
/// Powers the dashboard "zone points" metric as a live momentum readout
/// (rolling window) rather than a lifetime total, so it is kept purely
/// in-memory and resets on restart.
struct ZoneClock {
    /// Ring of time buckets; `buckets[slot][district][faction]` = seconds a
    /// faction held cells in that district during the slot.
    buckets: Vec<Vec<[f64; ZONE_FACTIONS]>>,
    /// Ring slot currently accruing.
    head: usize,
    /// Seconds already folded into the head bucket.
    head_elapsed: f64,
}

impl ZoneClock {
    fn new(districts: usize) -> Self {
        ZoneClock {
            buckets: vec![vec![[0.0; ZONE_FACTIONS]; districts]; ZONE_BUCKETS],
            head: 0,
            head_elapsed: 0.0,
        }
    }

    /// Advance the clock by `dt` seconds, rolling to fresh buckets (dropping
    /// the oldest) as slots fill up.
    fn advance(&mut self, dt: f64) {
        self.head_elapsed += dt;
        while self.head_elapsed >= ZONE_BUCKET_SECS {
            self.head_elapsed -= ZONE_BUCKET_SECS;
            self.head = (self.head + 1) % self.buckets.len();
            for cell in &mut self.buckets[self.head] {
                *cell = [0.0; ZONE_FACTIONS];
            }
        }
    }

    /// Credit `dt` seconds of control to `faction` in `district`.
    fn add(&mut self, district: usize, faction: FactionId, dt: f64) {
        let f = faction as usize;
        if f == 0 || f >= ZONE_FACTIONS {
            return; // neutral holdings earn no points
        }
        if let Some(slot) = self.buckets[self.head].get_mut(district) {
            slot[f] += dt;
        }
    }

    /// Rolling seconds held per district, per faction (summed over the window).
    fn seconds_by_district(&self) -> Vec<[u64; ZONE_FACTIONS]> {
        let districts = self.buckets.first().map(|b| b.len()).unwrap_or(0);
        let mut sums = vec![[0.0f64; ZONE_FACTIONS]; districts];
        for bucket in &self.buckets {
            for (di, cell) in bucket.iter().enumerate() {
                for f in 0..ZONE_FACTIONS {
                    sums[di][f] += cell[f];
                }
            }
        }
        sums.into_iter()
            .map(|c| {
                let mut r = [0u64; ZONE_FACTIONS];
                for f in 0..ZONE_FACTIONS {
                    r[f] = c[f].round() as u64;
                }
                r
            })
            .collect()
    }
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
    TxParty::Player {
        id: p.character.id,
        name: p.character.name.clone(),
        faction: p.character.faction,
    }
}

/// Leaderboard identity for a player (usable while `p` is mutably borrowed
/// out of the players map, unlike `World::actor_ref`).
fn player_actor(p: &Player) -> ActorRef {
    ActorRef {
        id: p.character.id,
        name: p.character.name.clone(),
        faction: p.character.faction,
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

/// Street Cash a seeded/respawned Wape carries, zone-scaled off the retired
/// NPC drop tables (blast-zone rubble hides more). Keeps the Cash -> Bank
/// conversion loop fed now that wild Wapes are full faction agents.
fn wape_grubstake_cash(rng: &mut SmallRng, zone: ZoneKind, raider_like: bool) -> u32 {
    use rand::Rng;
    let (lo, hi) = if raider_like {
        wilder_economy::CASH_DROP_RAIDER
    } else {
        wilder_economy::CASH_DROP_SCAV
    };
    let mut cash = rng.random_range(lo..=hi);
    if zone == ZoneKind::BlownUp {
        cash *= 2;
    }
    cash
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

/// Per-building energy throughput cap: the max summed `Recipe::energy` of
/// concurrently running jobs at one station. Jobs past the cap wait in the
/// queue unpowered. More district stations = more world throughput (this
/// replaced the old global kW budget).
fn station_energy_cap(station: wilder_crafting::Station) -> u32 {
    match station {
        wilder_crafting::Station::Refinery => 4,
        wilder_crafting::Station::Factory => 4,
        wilder_crafting::Station::Laboratory => 5,
    }
}

/// The static entity kind that hosts a crafting station.
fn station_entity_kind(station: wilder_crafting::Station) -> EntityKind {
    match station {
        wilder_crafting::Station::Refinery => EntityKind::Refinery,
        wilder_crafting::Station::Factory => EntityKind::Factory,
        wilder_crafting::Station::Laboratory => EntityKind::Laboratory,
    }
}

pub fn is_safe_chunk(coord: ChunkCoord) -> bool {
    coord.x.abs() <= SAFE_RADIUS && coord.z.abs() <= SAFE_RADIUS
}

/// Service entity an agent's goal is queued at, if any. These are the errands
/// that physically crowd a storefront (vendor sell/buy, craft station) or a
/// resource deposit, so they feed the congestion counter that spreads agents
/// across services and nodes.
fn goal_service_target(goal: Goal) -> Option<EntityId> {
    match goal {
        Goal::Sell { store, .. }
        | Goal::Buy { store, .. }
        | Goal::Bank { store, .. }
        | Goal::Extract { store, .. } => Some(store),
        Goal::Craft { station, .. } => Some(station),
        Goal::Gather { node, .. } => Some(node),
        _ => None,
    }
}

/// MILD a vendor storefront of `store_kind` would actually pay for the
/// agent's pack, per its price table. This — not raw carried value — is what
/// prices a Sell errand: a Bodega pays nothing for an SMG, and an agent that
/// values its own weapon at the counter walks into a sell-nothing loop at
/// the door (arrive, sell zero items, re-decide, pick Sell again, forever).
fn vendor_sell_value(agent: &FactionAgent, store_kind: EntityKind) -> u32 {
    wilder_economy::vendor_offers(store_kind)
        .iter()
        .filter(|o| o.sell > 0)
        .map(|o| o.sell.saturating_mul(agent.count_item(o.kind)))
        .sum()
}

/// Whether `kind` ever goes on the market book: raw resources, valuables,
/// and gear (weapons/ammo/meds trade too — agents list what's above their
/// personal kit reserve, see [`market_surplus`]).
fn market_listable(kind: ItemKind) -> bool {
    agents::is_kit(kind)
        || wilder_economy::RESOURCES.contains(&kind)
        || base_value(kind) >= 5
}

/// Per-kind sellable surplus in an agent's pack: listable kinds only, with
/// the personal kit reserve (best weapon, ammo/medkit buffer) subtracted so
/// an agent never sells itself defenseless.
fn market_surplus(agent: &FactionAgent) -> Vec<(ItemKind, u32)> {
    let mut totals: Vec<(ItemKind, u32)> = Vec::new();
    for s in agent.inventory.slots.iter().flatten() {
        if !market_listable(s.kind) {
            continue;
        }
        match totals.iter_mut().find(|(k, _)| *k == s.kind) {
            Some((_, c)) => *c += s.count,
            None => totals.push((s.kind, s.count)),
        }
    }
    totals
        .into_iter()
        .filter_map(|(k, c)| {
            let surplus = c.saturating_sub(agents::kit_reserve(agent, k));
            (surplus > 0).then_some((k, surplus))
        })
        .collect()
}

/// Reference value of everything the agent would list on the market book.
fn market_list_value(agent: &FactionAgent) -> u32 {
    market_surplus(agent).iter().map(|&(k, c)| base_value(k) * c).sum()
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
    // Second hub Bodega on the opposite face: the spawn cohort is the densest
    // crowd on the map, so it gets two sell/medkit sinks for congestion-aware
    // routing to split across (one Bodega alone just relocates the pile-up).
    ((0, -1), EntityKind::Bodega, "Bodega South"),
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
    /// Post-respawn invulnerability left (no damage taken or dealt while > 0).
    spawn_protection: f32,
    /// Ability cooldowns, indexed by `AbilityKind::index()`.
    ability_cooldowns: [f32; 3],
    /// Stim: healing left to apply + speed boost seconds left.
    stim_heal_left: f32,
    stim_speed_time: f32,
    /// Overcharge: weapon damage multiplier seconds left.
    overcharge_time: f32,
    /// Known blueprint recipe ids.
    blueprints: HashSet<String>,
    /// Cached account currency balances (write-through to the store).
    /// Carried burns on death, same as faction agents; banked is death-safe.
    purse: Purse,
    /// Last (wild, bank, shards, bank_shards, energy, bank_energy) sent as a
    /// WalletUpdate; None forces the initial send. Checked in replicate().
    wallet_sent: Option<(u32, u32, u32, u32, u32, u32)>,
    /// Quantized state last sent per entity: replicate() sends an entity in
    /// the tick snapshot only when this changed (delta replication). Loot,
    /// statics and idle actors cost nothing per tick.
    sent_snaps: HashMap<EntityId, SentSnap>,
    /// Subscribed to whole-map agent blips (map open). Recorded now; the
    /// MapIntel stream itself ships in Phase 5.
    #[allow(dead_code)]
    map_intel: bool,
    /// Subscribed to the owned-agent roster (`AgentSub`): re-sent every
    /// `AGENT_ROSTER_TICK_INTERVAL` ticks and on hire/dismiss.
    agent_sub: bool,
    /// Owned agent being watched in detail (`AgentDetailSub`), as an index
    /// into `World::agents`. Validated against ownership on every push.
    agent_detail: Option<usize>,
    /// World-clock seconds of the last "backpack full" deny sent for
    /// auto-pickup. Rate-limits the toast so standing on loot with a full
    /// pack doesn't spam it every tick.
    last_full_deny: f64,
    dirty: bool,
}

/// Max hot faction agents replicated to one player per tick. The client only
/// draws ~24 full rigs plus a few hundred instanced silhouettes, so shipping
/// every hot agent in view past that is pure wire cost. Nearest-first.
const REPLICATED_AGENT_CAP: usize = 192;
/// Hysteresis headroom: agents this client already knows about stay
/// replicated up to this softer cap, so the nearest-K boundary doesn't
/// strobe spawn/despawn as relative distances jitter tick to tick.
const REPLICATED_AGENT_KEEP: usize = 240;

/// Chunk radius (Chebyshev) of the always-on "agent dot" feed around each
/// player. Must be greater than `wilder_replication::VIEW_RADIUS` (the inner
/// replicated entity ring is skipped) and stay within the client's main
/// camera far plane (~1000 m). 12 chunks ≈ 384 m of glowing dots.
const DOT_RADIUS_CHUNKS: i32 = 12;
/// Nearest-first cap on dots shipped to one player per update; caps the wire
/// cost and the client point cloud in a dense city.
const DOT_MAX: usize = 1500;

/// Quantized replication state: centimetre positions, centiradian yaw and
/// 8-bit health/shield fractions. Two jobs: change detection for delta
/// snapshots (an entity is resent only when its quantized state moves), and
/// short wire text (the rounded values are what actually get sent, so JSON
/// floats stay a few digits instead of full f32 precision).
#[derive(Clone, Copy, PartialEq)]
struct SentSnap {
    qx: i32,
    qy: i32,
    qz: i32,
    qyaw: i16,
    anim: AnimState,
    qhp: u8,
    qshield: u8,
}

impl SentSnap {
    fn quantize(snap: &EntitySnapshot) -> Self {
        Self {
            qx: (snap.position.x * 100.0).round() as i32,
            qy: (snap.position.y * 100.0).round() as i32,
            qz: (snap.position.z * 100.0).round() as i32,
            // Yaw is wrapped (-pi..pi], so centiradians fit i16.
            qyaw: (snap.yaw * 100.0).round() as i16,
            anim: snap.anim,
            qhp: (snap.health_pct.clamp(0.0, 1.0) * 255.0).round() as u8,
            qshield: (snap.shield_pct.clamp(0.0, 1.0) * 255.0).round() as u8,
        }
    }

    /// The snapshot as actually sent: the entity's wire values are the
    /// quantized ones, so client state and the server's change detection
    /// can never drift apart.
    fn to_wire(&self, id: EntityId) -> EntitySnapshot {
        EntitySnapshot {
            id,
            position: Vec3::new(
                self.qx as f32 / 100.0,
                self.qy as f32 / 100.0,
                self.qz as f32 / 100.0,
            ),
            yaw: self.qyaw as f32 / 100.0,
            anim: self.anim,
            health_pct: self.qhp as f32 / 255.0,
            shield_pct: self.qshield as f32 / 255.0,
        }
    }
}

struct ProductionJobState {
    id: u64,
    /// Durable owner: outlives entity ids across reconnects/respawns.
    owner: OwnerId,
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

    fn to_save(&self) -> ProductionJobSave {
        ProductionJobSave {
            id: self.id,
            owner: self.owner,
            recipe: self.recipe.id.to_string(),
            count: self.count,
            done: self.done,
            remaining: self.remaining,
        }
    }
}

/// Persisted form of a production job (world meta `production_queues`).
/// The recipe rides as its id; jobs whose recipe no longer exists are
/// dropped on load.
#[derive(Serialize, Deserialize)]
struct ProductionJobSave {
    id: u64,
    owner: OwnerId,
    recipe: String,
    count: u32,
    done: u32,
    remaining: f32,
}

impl ProductionJobSave {
    fn into_state(self) -> Option<ProductionJobState> {
        Some(ProductionJobState {
            id: self.id,
            owner: self.owner,
            recipe: wilder_crafting::recipe(&self.recipe)?,
            count: self.count,
            done: self.done,
            remaining: self.remaining,
            powered: false,
        })
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
            faction: self.character.faction,
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
    /// Ledger party the contents still belong to (dead agent, dropping player).
    /// Pickups are attributed as transfers from this owner.
    owner: Option<TxParty>,
    /// Whether the contents still count toward circulating supply. False for
    /// death drops (burned when the player died) and world-seeded ammo caches
    /// (issued on pickup), so pickups from those re-mint instead of transfer.
    in_supply: bool,
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
    /// World-clock seconds of the last successful pull; drives the lazy
    /// per-gather cooldown (NEG_INFINITY = never gathered).
    last_gather: f64,
    /// World-clock seconds when charges hit zero; drives the lazy respawn.
    /// Meaningless while `charges > 0`.
    depleted_at: f64,
}

/// Node timers are lazy timestamps instead of per-tick countdowns: state is
/// computed on access (gather, targeting, replication), so a world's worth of
/// agent-materialized nodes costs nothing at rest.
impl ResourceNode {
    /// Effective charges at `now` under the lazy respawn rule.
    fn charges_at(&self, now: f64, full: u32, respawn_seconds: f32) -> u32 {
        if self.charges == 0 && now - self.depleted_at >= respawn_seconds as f64 {
            full
        } else {
            self.charges
        }
    }

    /// Apply the lazy respawn in place (call before mutating `charges`).
    fn refresh(&mut self, now: f64, full: u32, respawn_seconds: f32) {
        self.charges = self.charges_at(now, full, respawn_seconds);
    }

    /// Whether the per-gather cooldown has elapsed at `now`.
    fn cooldown_ready(&self, now: f64) -> bool {
        now - self.last_gather >= NODE_GATHER_COOLDOWN as f64
    }
}

/// Resource-node tunables, read from the environment once at world init.
#[derive(Clone, Copy)]
struct NodeTuning {
    per_chunk: usize,
    charges: u32,
    respawn_seconds: f32,
}

impl Default for NodeTuning {
    fn default() -> Self {
        Self {
            per_chunk: NODES_PER_HOSTILE_CHUNK,
            charges: NODE_CHARGES,
            respawn_seconds: NODE_RESPAWN_SECONDS,
        }
    }
}

impl NodeTuning {
    fn from_env() -> Self {
        fn env<T: std::str::FromStr>(key: &str, default: T) -> T {
            std::env::var(key).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
        }
        let d = Self::default();
        Self {
            per_chunk: env("WILDER_NODES_PER_CHUNK", d.per_chunk),
            charges: env("WILDER_NODE_CHARGES", d.charges).max(1),
            respawn_seconds: env("WILDER_NODE_RESPAWN", d.respawn_seconds),
        }
    }
}

/// Result of one successful gather pull (a node charge was consumed).
struct GatherOutcome {
    /// Stacks that actually entered the actor's pack (yield + any fragment).
    gained: Vec<ItemStack>,
    /// The pull yielded items but none fit (they spilled to ground loot).
    denied: bool,
}

pub struct World {
    store: Arc<RocksStore>,
    chunks: ChunkCache,
    players: HashMap<EntityId, Player>,
    loot: HashMap<EntityId, LootContainer>,
    /// Loose currency dropped on death, auto-collected on walk-over.
    pickups: HashMap<EntityId, CurrencyPickup>,
    statics: HashMap<EntityId, StaticEntity>,
    /// Static services bucketed by kind (statics never move once seeded).
    /// `decide_agent` routes errands through `nearest_service` and
    /// `route_service` constantly; one bucket walk beats filtering the whole
    /// statics map per call. Maintained by `register_static`.
    services_by_kind: HashMap<EntityKind, Vec<(EntityId, Vec3)>>,
    /// World-space room rect `[minx, minz, maxx, maxz]` of each service
    /// entity's walk-in interior (entities without a carved room are absent).
    /// Interacting from anywhere inside the room is allowed.
    interior_bounds: HashMap<EntityId, [f32; 4]>,
    nodes: HashMap<EntityId, ResourceNode>,
    /// Node ids bucketed by chunk (nodes never move); agent gather targeting
    /// and node replication walk chunks instead of the whole node map.
    nodes_by_chunk: HashMap<ChunkCoord, SmallVec<[EntityId; 4]>>,
    /// Chunks whose nodes have been materialized (by player streaming or
    /// agent targeting — see `ensure_nodes`). Nodes are never evicted.
    node_seeded_chunks: HashSet<ChunkCoord>,
    /// Node density/charge/respawn tunables, read from env once at init.
    node_tuning: NodeTuning,
    static_seeded_chunks: HashSet<ChunkCoord>,
    next_entity: EntityId,
    tick: u64,
    seed: u64,
    rng: SmallRng,
    rx: mpsc::UnboundedReceiver<WorldCmd>,
    /// Market listings (persisted in world meta).
    market: Vec<wilder_market::Listing>,
    /// Stock-backed vendor shelves keyed by vendor static (Armory/Bodega).
    /// A vendor only sells what it holds; sold-in items land here. Seeded
    /// once per vendor (`ensure_vendor_stock`), persisted in world meta
    /// (`vendor_stock`) on the save cadence. An empty entry means sold out —
    /// it stays in the map so the seed never re-mints.
    vendor_stock: HashMap<EntityId, Vec<ItemStack>>,
    /// Vendor stock changed since the last save sweep.
    vendor_stock_dirty: bool,
    next_listing_id: u64,
    next_job_id: u64,
    /// Shared production queues keyed by station building. Only buildings
    /// with live jobs have an entry, so ticking scales with active industry,
    /// not the statics map. Persisted in world meta (`production_queues`) —
    /// jobs keep running while their owner is offline.
    production: HashMap<EntityId, Vec<ProductionJobState>>,
    /// Completed-but-uncollected output per (building, owner). The owner
    /// collects within 5 m (players also auto-collect). Persisted in world
    /// meta (`production_outputs`).
    production_outputs: HashMap<(EntityId, OwnerId), Vec<ItemStack>>,
    /// Production state changed since the last save sweep.
    production_dirty: bool,
    /// Non-neutral territory control per region: which faction holds it.
    /// Persisted in world meta so the war map survives restarts.
    territory: HashMap<(i32, i32), FactionId>,
    /// Territory changed since the last save.
    territory_dirty: bool,
    /// Per-region field intel agents read when deciding (rebuilt ~1 Hz by
    /// `tick_territory` from the same presence sweep that settles control).
    field_intel: HashMap<(i32, i32), RegionIntel>,
    /// Commerce MILD routed per region since the last intel rebuild.
    region_income: HashMap<(i32, i32), u32>,
    /// Kills per region since the last intel rebuild.
    region_casualties: HashMap<(i32, i32), u32>,
    /// Rolling zone-seconds held per district/faction (dashboard momentum).
    zone_clock: ZoneClock,
    /// Economy transaction ledger + supply counters (K dashboard).
    ledger: Ledger,
    /// Per-item market fill-price history (dashboard item charts + agent
    /// pricing reference).
    market_stats: MarketStats,
    /// Per-competitor stats + faction/guild lifetime totals (leaderboards).
    stats: StatsBook,
    /// Players subscribed to live ledger updates.
    econ_subs: HashSet<EntityId>,
    /// Players watching one item's market detail (dashboard drill-in).
    item_subs: HashMap<EntityId, ItemKind>,
    /// Autonomous faction agents (index-stable; identity swaps on respawn).
    agents: Vec<FactionAgent>,
    /// Live entity id -> agents index, for combat/target lookups.
    agent_by_entity: HashMap<EntityId, usize>,
    /// Spatial hash over alive agents, maintained incrementally: an agent's
    /// bucket entry moves when it crosses a chunk boundary (`regrid_agent`)
    /// instead of rebuilding the whole map every tick.
    agent_grid: HashMap<ChunkCoord, SmallVec<[u32; 4]>>,
    /// Agent indices currently in the Hot tier, refreshed each tick by the
    /// player-driven classification (promote via grid lookups around
    /// players, demote from this list) — never a whole-population scan.
    hot_agents: Vec<u32>,
    /// Agent indices currently dead and awaiting respawn. Killing pushes
    /// here; the respawn sweep walks only this list.
    dead_agents: Vec<u32>,
    /// Budgeted A* queue: agent indices waiting for a `find_path` grant.
    agent_path_queue: std::collections::VecDeque<usize>,
    /// Budgeted decision queue: agent indices waiting for a `decide_agent`
    /// re-score. A per-tick budget flattens decision bursts (a whole cold
    /// bucket going idle at once) into a steady, bounded per-tick cost.
    agent_decision_queue: std::collections::VecDeque<u32>,
    /// Next agent-save shard to persist (round-robin, see `tick_agent_saves`).
    agent_save_cursor: usize,
    /// Service entity -> count of agents currently committed to it (Sell/Buy
    /// vendor errands, craft stations). Drives congestion-aware routing so a
    /// cohort self-distributes across storefronts instead of funneling to the
    /// nearest one. Rebuilt each tick, then mutated as agents re-decide.
    service_load: HashMap<EntityId, u32>,
    /// One staging position per district (a walkable spot near the district's
    /// service cluster), filled by `seed_neighborhood_stores`.
    district_spots: Vec<Vec3>,
    /// Owner -> owned agent indices (fast roster lookups). Rebuilt on load,
    /// kept correct on hire/dismiss (agent indices are stable — respawn
    /// reuses the slot — so this never needs per-tick maintenance).
    owned_agents: HashMap<CharacterId, Vec<usize>>,
    /// Live activity log per OWNED agent (ring of `AGENT_LOG_CAP` entries).
    /// Only owned agents have an entry: created on hire, dropped on dismiss,
    /// carried across respawn (re-keyed to the fresh identity).
    agent_logs: HashMap<AgentId, VecDeque<AgentLogEntry>>,
    /// Per-system wall-time accounting for `step()`.
    timings: TickTimings,
}

/// Build a fully seeded world (district services, interiors, agents) reading
/// its command stream from `rx`. `spawn_world` wraps this in the live tick
/// loop; the headless benchmark steps it directly.
fn new_world(store: Arc<RocksStore>, rx: mpsc::UnboundedReceiver<WorldCmd>) -> World {
    // World seed persists so the city never changes between restarts.
    let seed: u64 = match store.meta::<u64>("world_seed") {
        Ok(Some(seed)) => seed,
        _ => {
            let seed: u64 = rand::random();
            let _ = store.save_meta("world_seed", &seed);
            seed
        }
    };

    let mut market: Vec<wilder_market::Listing> =
        store.meta("market_listings").ok().flatten().unwrap_or_default();
    // Saves predating the `agent` flag: any listing whose seller isn't a
    // stored player character is agent stock (eligible for ask decay).
    for l in market.iter_mut() {
        if !l.agent {
            l.agent = store.character(l.seller).is_err();
        }
    }
    let next_listing_id: u64 = store.meta("market_next_id").ok().flatten().unwrap_or(1);
    // Vendor shelves: persisted stock per vendor static (entity ids are
    // stable across restarts because statics seed deterministically).
    let vendor_stock: HashMap<EntityId, Vec<ItemStack>> = store
        .meta::<Vec<(EntityId, Vec<ItemStack>)>>("vendor_stock")
        .ok()
        .flatten()
        .unwrap_or_default()
        .into_iter()
        .collect();
    // Production queues + output buffers survive restarts (spec §61): jobs
    // keep running and buffered goods stay claimable. Building entity ids
    // are stable because statics seed deterministically before anything
    // dynamic allocates.
    let production: HashMap<EntityId, Vec<ProductionJobState>> = store
        .meta::<Vec<(EntityId, Vec<ProductionJobSave>)>>("production_queues")
        .ok()
        .flatten()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|(building, jobs)| {
            let jobs: Vec<ProductionJobState> =
                jobs.into_iter().filter_map(ProductionJobSave::into_state).collect();
            (!jobs.is_empty()).then_some((building, jobs))
        })
        .collect();
    let next_job_id = production
        .values()
        .flatten()
        .map(|j| j.id + 1)
        .max()
        .unwrap_or(1);
    let production_outputs: HashMap<(EntityId, OwnerId), Vec<ItemStack>> = store
        .meta::<Vec<(EntityId, OwnerId, Vec<ItemStack>)>>("production_outputs")
        .ok()
        .flatten()
        .unwrap_or_default()
        .into_iter()
        .map(|(building, owner, stacks)| ((building, owner), stacks))
        .collect();
    // Ledger aggregates survive restarts; the recent-tx feed is in-memory.
    let ledger_save: LedgerSave = store.meta("econ_ledger").ok().flatten().unwrap_or_default();
    // Per-item market price history survives restarts too.
    let market_stats_save: MarketStatsSave =
        store.meta("market_stats").ok().flatten().unwrap_or_default();
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

    let mut world = World {
        store: store.clone(),
        chunks: ChunkCache::new(TerrainGenerator::new(seed), store),
        market,
        vendor_stock,
        vendor_stock_dirty: false,
        next_listing_id,
        next_job_id,
        production,
        production_outputs,
        production_dirty: false,
        players: HashMap::new(),
        loot: HashMap::new(),
        pickups: HashMap::new(),
        statics: HashMap::new(),
        services_by_kind: HashMap::new(),
        interior_bounds: HashMap::new(),
        nodes: HashMap::new(),
        nodes_by_chunk: HashMap::new(),
        node_seeded_chunks: HashSet::new(),
        node_tuning: NodeTuning::from_env(),
        static_seeded_chunks: HashSet::new(),
        next_entity: 1,
        tick: 0,
        seed,
        rng: SmallRng::seed_from_u64(seed ^ 0xC0FFEE),
        rx,
        territory,
        territory_dirty: false,
        field_intel: HashMap::new(),
        region_income: HashMap::new(),
        region_casualties: HashMap::new(),
        zone_clock: ZoneClock::new(districts::district_defs().len()),
        ledger: Ledger::new(ledger_save),
        market_stats: MarketStats::new(market_stats_save),
        stats,
        econ_subs: HashSet::new(),
        item_subs: HashMap::new(),
        agents: Vec::new(),
        agent_by_entity: HashMap::new(),
        agent_grid: HashMap::new(),
        hot_agents: Vec::new(),
        dead_agents: Vec::new(),
        agent_path_queue: std::collections::VecDeque::new(),
        agent_decision_queue: std::collections::VecDeque::new(),
        agent_save_cursor: 0,
        service_load: HashMap::new(),
        district_spots: Vec::new(),
        owned_agents: HashMap::new(),
        agent_logs: HashMap::new(),
        timings: TickTimings::default(),
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
    // Ownership index: restored saves carry owners; hires maintain it live.
    world.rebuild_owned_agents();
    world
}

/// Create the world and spawn its tick loop. Returns a handle for connections.
pub fn spawn_world(store: Arc<RocksStore>) -> WorldHandle {
    let (tx, rx) = mpsc::unbounded_channel();
    let world = new_world(store, rx);
    let seed = world.seed;
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
            if self.tick % TIMING_LOG_TICKS == 0 {
                self.log_timings();
            }
        }
    }

    /// Emit the per-system tick-time breakdown accumulated since the last
    /// log, then reset. Escalates to warn when the average tick eats more
    /// than half the 50 ms budget.
    fn log_timings(&mut self) {
        let avg = self.timings.avg_tick();
        let max = self.timings.max_total;
        let summary = self.timings.summary();
        let over_budget = avg > Duration::from_millis(1000 / TICK_HZ as u64 / 2);
        if over_budget {
            tracing::warn!(?avg, ?max, agents = self.agents.len(), players = self.players.len(), "tick budget pressure: {summary}");
        } else {
            tracing::debug!(?avg, ?max, "tick timings: {summary}");
        }
        self.timings.reset();
    }

    /// Run one phase of `step()` under the wall-time accounting.
    #[inline]
    fn timed(&mut self, phase: TickPhase, f: impl FnOnce(&mut Self)) {
        let start = Instant::now();
        f(self);
        self.timings.add(phase, start.elapsed());
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

        // One-time MILD grant per account (tracked in world meta).
        let mut purse = self
            .store
            .account_by_id(account)
            .map(|a| Purse {
                carried: [a.wallet, a.shards, a.energy],
                banked: [a.bank, a.bank_shards, a.bank_energy],
            })
            .unwrap_or_default();
        let grant_key = format!("wallet_granted_{account}");
        let granted: bool = self.store.meta(&grant_key).ok().flatten().unwrap_or(false);
        if !granted {
            purse.credit(Currency::Wild, WALLET_GRANT);
            let _ = self.store.update_wallet(account, purse.carried(Currency::Wild));
            let _ = self.store.save_meta(&grant_key, &true);
            self.ledger.record(
                TxKind::Mint,
                TxParty::Mint,
                TxParty::Player {
                    id: character.id,
                    name: character.name.clone(),
                    faction: character.faction,
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
            spawn_protection: 0.0,
            ability_cooldowns: [0.0; 3],
            stim_heal_left: 0.0,
            stim_speed_time: 0.0,
            overcharge_time: 0.0,
            blueprints,
            purse,
            wallet_sent: None,
            sent_snaps: HashMap::new(),
            map_intel: false,
            agent_sub: false,
            agent_detail: None,
            last_full_deny: f64::NEG_INFINITY,
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
        let _ = tx.send(S2C::TerritoryState {
            cells: self.territory_cells(),
            districts: self.district_control(),
        });
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
        if let Some(player) = self.players.remove(&entity) {
            // Production jobs persist and keep running while the owner is
            // offline (queues live on the building, keyed by character id);
            // no disconnect refund needed anymore.
            self.econ_subs.remove(&entity);
            self.item_subs.remove(&entity);
            self.persist_player(&player);
            tracing::info!(entity, name = %player.character.name, "player left");
        }
    }

    fn handle_msg(&mut self, entity: EntityId, msg: C2S) {
        match msg {
            C2S::MoveInput { seq, dx, dz, yaw, run } => {
                if let Some(player) = self.players.get_mut(&entity) {
                    player.path.clear();
                    player.pending_inputs.push((seq, dx, dz, yaw, run, TICK_DT));
                }
            }
            C2S::MoveTo { seq, x, z } => {
                let Some(player) = self.players.get_mut(&entity) else { return };
                player.last_input_seq = player.last_input_seq.max(seq);
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
                self.queue_production(EconActor::Player(entity), building, &recipe, count);
            }
            C2S::CollectProduction { building } => {
                self.collect_production(EconActor::Player(entity), building);
            }
            C2S::Market(action) => self.market_action(entity, action),
            C2S::Vendor { vendor, action } => self.vendor_action(entity, vendor, action),
            C2S::EconomySub { on } => self.economy_sub(entity, on),
            C2S::ItemMarketSub { kind } => self.item_market_sub(entity, kind),
            C2S::HireAgent { agent_id } => self.hire_agent(entity, agent_id),
            C2S::DismissAgent { agent_id } => self.dismiss_agent(entity, agent_id),
            C2S::AgentHireList => self.agent_hire_list(entity),
            C2S::AgentSub { on } => self.agent_sub(entity, on),
            C2S::AgentDetailSub { agent_id } => self.agent_detail_sub(entity, agent_id),
            C2S::MapIntelSub { on } => {
                if let Some(player) = self.players.get_mut(&entity) {
                    player.map_intel = on;
                }
                if on {
                    // Answer immediately so the map never opens blank: the
                    // live blips (players + Wapes) plus a one-time full census
                    // of every faction agent as static dots.
                    let blips = self.map_intel_blips();
                    let census = self.map_census_blips();
                    if let Some(player) = self.players.get(&entity) {
                        let _ = player.tx.send(S2C::MapIntel { blips });
                        let _ = player.tx.send(S2C::MapCensus { blips: census });
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

        // Attackable targets: embodied (hot) faction agents (from the
        // maintained hot list, not a population scan) plus other players
        // (PvP). Whether the hit actually lands is `deal_damage`'s call —
        // faction hostility, safe zones and spawn protection gate there.
        let candidates: Vec<(EntityId, Vec3)> = self
            .hot_agents
            .iter()
            .map(|&i| &self.agents[i as usize])
            .filter(|a| a.tier == Tier::Hot && a.alive())
            .map(|a| (a.entity, a.position))
            .chain(
                self.players
                    .values()
                    .filter(|p| p.entity != entity && p.character.health > 0.0)
                    .map(|p| (p.entity, p.character.position)),
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
                // Knock nearby hot agents back, then apply damage.
                let mut targets: Vec<EntityId> = Vec::new();
                for i in 0..self.agents.len() {
                    let agent = &self.agents[i];
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
                    let agent = &mut self.agents[i];
                    agent.position = step_move_speed(
                        &self.chunks,
                        agent.position,
                        dir.x,
                        dir.z,
                        SHOCKWAVE_KNOCKBACK,
                        1.0,
                    );
                    targets.push(agent.entity);
                    self.regrid_agent(i);
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

    /// Grant XP to a player (no-op for agent attackers) and handle level-ups.
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
        player.purse.credit(Currency::Shards, amount);
        let to = player_party(player);
        let account = player.character.account_id;
        let (shards, energy) =
            (player.purse.carried(Currency::Shards), player.purse.carried(Currency::Energy));
        self.ledger.record(TxKind::Mint, TxParty::Mint, to, TxAmount::Shards { amount }, 0);
        let _ = self.store.update_currencies(account, shards, energy);
    }

    /// Grant Energy (charge currency); see `grant_shards`.
    fn grant_energy(&mut self, entity: EntityId, amount: u32) {
        if amount == 0 {
            return;
        }
        let Some(player) = self.players.get_mut(&entity) else { return };
        player.purse.credit(Currency::Energy, amount);
        let to = player_party(player);
        let account = player.character.account_id;
        let (shards, energy) =
            (player.purse.carried(Currency::Shards), player.purse.carried(Currency::Energy));
        self.ledger.record(TxKind::Mint, TxParty::Mint, to, TxAmount::Energy { amount }, 0);
        let _ = self.store.update_currencies(account, shards, energy);
    }

    /// Grant wallet MILD (minted faucet); see `grant_shards`. Used for the
    /// loose coin pickups dropped on death.
    fn grant_wild(&mut self, entity: EntityId, amount: u32) {
        if amount == 0 {
            return;
        }
        let Some(player) = self.players.get_mut(&entity) else { return };
        player.purse.credit(Currency::Wild, amount);
        let to = player_party(player);
        let account = player.character.account_id;
        let wallet = player.purse.carried(Currency::Wild);
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

    /// Shared-currency faucet for any econ actor: Purse credit + Mint leg +
    /// write-through. Players route via the entity helpers (which also feed
    /// the WalletUpdate delta); agents credit their purse directly and
    /// persist with their shard save.
    fn grant_currency_actor(&mut self, actor: EconActor, currency: Currency, amount: u32) {
        if amount == 0 {
            return;
        }
        match actor {
            EconActor::Player(id) => self.grant_currency(id, currency, amount),
            EconActor::Agent(idx) => {
                let Some(agent) = self.agents.get_mut(idx) else { return };
                agent.purse.credit(currency, amount);
                let to = agent.party();
                self.ledger.record(TxKind::Mint, TxParty::Mint, to, currency.tx_amount(amount), 0);
            }
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

    // -----------------------------------------------------------------------
    // EconActor: shared player/agent accessors for the economy entry points
    // -----------------------------------------------------------------------

    /// Current position of an economic actor (None = not in the world).
    fn actor_position(&self, actor: EconActor) -> Option<Vec3> {
        match actor {
            EconActor::Player(id) => self.players.get(&id).map(|p| p.character.position),
            EconActor::Agent(idx) => self.agents.get(idx).map(|a| a.position),
        }
    }

    /// Faction an actor trades/fights under.
    fn actor_faction(&self, actor: EconActor) -> FactionId {
        match actor {
            EconActor::Player(id) => {
                self.players.get(&id).map_or(FACTION_NEUTRAL, |p| p.character.faction)
            }
            EconActor::Agent(idx) => self.agents.get(idx).map_or(FACTION_NEUTRAL, |a| a.faction),
        }
    }

    /// Ledger party for an actor.
    fn actor_party(&self, actor: EconActor) -> Option<TxParty> {
        match actor {
            EconActor::Player(id) => self.players.get(&id).map(player_party),
            EconActor::Agent(idx) => self.agents.get(idx).map(|a| a.party()),
        }
    }

    /// Read access to an actor's currency balances.
    fn actor_purse(&self, actor: EconActor) -> Option<&Purse> {
        match actor {
            EconActor::Player(id) => self.players.get(&id).map(|p| &p.purse),
            EconActor::Agent(idx) => self.agents.get(idx).map(|a| &a.purse),
        }
    }

    /// Mutable access to an actor's currency balances.
    fn actor_purse_mut(&mut self, actor: EconActor) -> Option<&mut Purse> {
        match actor {
            EconActor::Player(id) => self.players.get_mut(&id).map(|p| &mut p.purse),
            EconActor::Agent(idx) => self.agents.get_mut(idx).map(|a| &mut a.purse),
        }
    }

    /// Mutable access to an actor's backpack slots (players and agents run
    /// the same slotted model; equip slots stay actor-specific). Callers
    /// mutate, so players are marked dirty for the persistence sweep.
    fn actor_slots_mut(&mut self, actor: EconActor) -> Option<&mut [Option<ItemStack>]> {
        match actor {
            EconActor::Player(id) => self.players.get_mut(&id).map(|p| {
                p.dirty = true;
                p.inventory.slots.as_mut_slice()
            }),
            EconActor::Agent(idx) => {
                self.agents.get_mut(idx).map(|a| a.inventory.slots.as_mut_slice())
            }
        }
    }

    /// The recipes an actor may craft. Both sides research theirs: players
    /// persist via the blueprint store, agents via the population shards.
    fn actor_knows_blueprint(&self, actor: EconActor, recipe_id: &str) -> bool {
        match actor {
            EconActor::Player(id) => {
                self.players.get(&id).is_some_and(|p| p.blueprints.contains(recipe_id))
            }
            EconActor::Agent(idx) => {
                self.agents.get(idx).is_some_and(|a| a.blueprints.contains(recipe_id))
            }
        }
    }

    /// Durable owner identity for production jobs/buffers: character id for
    /// players (survives reconnects), agent uuid for agents (survives
    /// restarts; a respawn mints a new identity and the old one is purged).
    fn actor_owner_id(&self, actor: EconActor) -> Option<OwnerId> {
        match actor {
            EconActor::Player(id) => self.players.get(&id).map(|p| OwnerId::Player(p.character.id)),
            EconActor::Agent(idx) => self.agents.get(idx).map(|a| OwnerId::Agent(a.agent_id)),
        }
    }

    /// Whether an actor can reach `target`: within `range` metres of the
    /// entity, or anywhere inside its walk-in room (service counters sit
    /// well past the door's interaction ring).
    fn actor_in_range(&self, actor: EconActor, target: EntityId, range: f32) -> bool {
        let Some(pos) = self.actor_position(actor) else { return false };
        let target_pos = self
            .statics
            .get(&target)
            .map(|s| s.position)
            .or_else(|| self.nodes.get(&target).map(|n| n.position))
            .or_else(|| self.entity_position(target));
        if target_pos.is_some_and(|t| (t - pos).length() <= range) {
            return true;
        }
        self.interior_bounds.get(&target).is_some_and(|[x0, z0, x1, z1]| {
            pos.x >= x0 - 0.5 && pos.x <= x1 + 0.5 && pos.z >= z0 - 0.5 && pos.z <= z1 + 0.5
        })
    }

    /// Yield after the territory tax for whatever ground the pull happens
    /// on: hostile-held regions tax players and agents identically.
    fn actor_taxed_yield(&self, actor: EconActor, pos: Vec3, count: u32) -> u32 {
        apply_territory_tax(count, self.region_hostile_to(pos, self.actor_faction(actor)))
    }

    /// Add items to an actor's backpack under the shared slotted rules;
    /// returns the leftover that did NOT fit. Callers must spill leftovers
    /// to ground loot or deny the action — never drop them silently. Agents
    /// wear acquired upgrades immediately (players manage their own slots).
    fn actor_add_items(&mut self, actor: EconActor, kind: ItemKind, count: u32) -> u32 {
        let leftover = match self.actor_slots_mut(actor) {
            Some(slots) => inv::add_items(slots, kind, count),
            None => return count,
        };
        if let EconActor::Agent(idx) = actor {
            self.agents[idx].equip_best_gear();
        }
        leftover
    }

    /// Remove up to `count` items from an actor's backpack; returns how many
    /// were actually removed.
    fn actor_remove_items(&mut self, actor: EconActor, kind: ItemKind, count: u32) -> u32 {
        match self.actor_slots_mut(actor) {
            Some(slots) => inv::remove_items(slots, kind, count),
            None => 0,
        }
    }

    fn actor_count_items(&self, actor: EconActor, kind: ItemKind) -> u32 {
        match actor {
            EconActor::Player(id) => self
                .players
                .get(&id)
                .map_or(0, |p| inv::count_items(&p.inventory.slots, kind)),
            EconActor::Agent(idx) => self.agents.get(idx).map_or(0, |a| a.count_item(kind)),
        }
    }

    /// Send a client message when the actor has a client; agents silently
    /// skip (their feedback loop is utility scoring, not UI).
    fn actor_notify(&self, actor: EconActor, msg: S2C) {
        if let EconActor::Player(id) = actor {
            if let Some(p) = self.players.get(&id) {
                let _ = p.tx.send(msg);
            }
        }
    }

    /// World clock in seconds (the tick counter scaled by the fixed dt);
    /// basis for the lazy node cooldown/respawn timestamps.
    fn world_seconds(&self) -> f64 {
        self.tick as f64 * TICK_DT as f64
    }

    /// One gather pull off a resource node under the shared rulebook —
    /// identical for players and agents: 3 m range, charge + 1.2 s cooldown
    /// (lazy timestamps), a 2-5 yield roll with the warzone +50% risk
    /// premium, territory tax, 10% blueprint-fragment chance, and a ledger
    /// Mint attributed to the actor. Yield that doesn't fit the pack spills
    /// as ground loot at the node. Returns None when no charge was consumed
    /// (missing/depleted/cooling node, out of range).
    fn gather_node(&mut self, actor: EconActor, node_id: EntityId) -> Option<GatherOutcome> {
        use rand::Rng;
        let now = self.world_seconds();
        let tuning = self.node_tuning;
        let node = self.nodes.get_mut(&node_id)?;
        node.refresh(now, tuning.charges, tuning.respawn_seconds);
        if node.charges == 0 || !node.cooldown_ready(now) {
            return None;
        }
        let (node_pos, variant) = (node.position, node.variant);
        if !self.actor_in_range(actor, node_id, 3.0) {
            return None;
        }
        let party = self.actor_party(actor)?;
        let node = self.nodes.get_mut(&node_id).expect("node checked above");
        node.last_gather = now;
        node.charges -= 1;
        if node.charges == 0 {
            node.depleted_at = now;
        }
        let kind = wilder_economy::node_yield(variant);
        let mut rolled = self.rng.random_range(2..=5u32);
        // Warzone risk premium applies to anyone working dangerous ground.
        if districts::danger_at(node_pos) == DangerLevel::Warzone {
            rolled += rolled / 2;
        }
        // Hostile-held ground taxes what you carry out of it.
        let count = self.actor_taxed_yield(actor, node_pos, rolled);
        let leftover = self.actor_add_items(actor, kind, count);
        let gained = count - leftover;
        if count > 0 {
            // Everything extracted is minted: overflow lands on the ground
            // below the node, it doesn't vanish.
            self.ledger.record(
                TxKind::Mint,
                TxParty::Mint,
                party.clone(),
                TxAmount::Item { kind, count },
                0,
            );
        }
        if leftover > 0 {
            self.spawn_loot(
                node_pos,
                vec![ItemStack { kind, count: leftover }],
                Some(party.clone()),
                false,
            );
        }
        if gained > 0 {
            let gatherer = match actor {
                EconActor::Player(id) => self.players.get(&id).map(player_actor),
                EconActor::Agent(idx) => Some(self.agent_actor_ref(idx)),
            };
            if let Some(gatherer) = gatherer {
                self.stats.add_resources(&gatherer, gained as u64);
            }
        }
        let mut gained_stacks = Vec::new();
        if gained > 0 {
            gained_stacks.push(ItemStack { kind, count: gained });
        }
        // Rare blueprint fragments feed Laboratory research (kept only when
        // they fit — a fragment never spills).
        if self.rng.random_bool(FRAGMENT_CHANCE)
            && self.actor_add_items(actor, ItemKind::BlueprintFragment, 1) == 0
        {
            self.ledger.record(
                TxKind::Mint,
                TxParty::Mint,
                party,
                TxAmount::Item { kind: ItemKind::BlueprintFragment, count: 1 },
                0,
            );
            gained_stacks.push(ItemStack { kind: ItemKind::BlueprintFragment, count: 1 });
        }
        Some(GatherOutcome { denied: gained_stacks.is_empty() && count > 0, gained: gained_stacks })
    }

    /// Write the actor's purse through to durable storage. Players write
    /// through to the account store (same four balance calls the store has
    /// always exposed); agents persist through the sharded population saves,
    /// so there is nothing to do here.
    fn persist_actor_purse(&mut self, actor: EconActor) {
        if let EconActor::Player(id) = actor {
            let Some(p) = self.players.get(&id) else { return };
            let account = p.character.account_id;
            let purse = p.purse;
            let _ = self.store.update_wallet(account, purse.carried(Currency::Wild));
            let _ = self.store.update_bank(account, purse.banked(Currency::Wild));
            let _ = self.store.update_currencies(
                account,
                purse.carried(Currency::Shards),
                purse.carried(Currency::Energy),
            );
            let _ = self.store.update_bank_currencies(
                account,
                purse.banked(Currency::Shards),
                purse.banked(Currency::Energy),
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

        // Resource node? Players pull through the same shared `gather_node`
        // rulebook agents use; the only player-specific part is the UI echo.
        if self.nodes.contains_key(&target) {
            let actor = EconActor::Player(entity);
            if !self.actor_in_range(actor, target, 3.0) {
                if let Some(player) = self.players.get(&entity) {
                    let _ = player.tx.send(S2C::Error { message: "too far away".into() });
                }
                return;
            }
            // None = depleted or still cooling: silent, like today.
            let Some(outcome) = self.gather_node(actor, target) else { return };
            let Some(player) = self.players.get_mut(&entity) else { return };
            let _ = player
                .tx
                .send(S2C::GatherResult { gained: outcome.gained, denied: outcome.denied });
            let _ = player.tx.send(S2C::InventoryUpdate(player.inventory.clone()));
            return;
        }

        // Static entity (stash terminal / service building)?
        let Some(static_entity) = self.statics.get(&target) else { return };
        let kind = static_entity.kind;
        // Service buildings are interactable from their street side (the
        // entity stands on the sidewalk by the door) or from anywhere inside
        // their walk-in room, whose counter sits well past the 5 m ring.
        let in_range = self.actor_in_range(EconActor::Player(entity), target, 5.0);
        let Some(player) = self.players.get_mut(&entity) else { return };
        if !in_range {
            let _ = player.tx.send(S2C::Error { message: "too far away".into() });
            return;
        }
        match kind {
            EntityKind::Building => {
                // Stash terminal: just push current stash state (opens the UI).
                let _ = player.tx.send(S2C::StashUpdate { slots: player.stash.slots.clone() });
            }
            EntityKind::Refinery | EntityKind::Factory | EntityKind::Laboratory => {
                // Grab any buffered output first (in-range by the check
                // above), then push the shared queue state (opens the UI).
                self.collect_production(EconActor::Player(entity), target);
                self.send_production_state(entity, target);
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

    /// `research_<id>` unlocks at the Laboratory. Anything else is a legacy
    /// instant-craft request: the bypass is retired, so it routes into the
    /// shared production queue at the given (or nearest) matching station.
    /// The current client only ever sends Craft for research.
    fn craft(&mut self, entity: EntityId, recipe_id: &str, station: Option<EntityId>) {
        if let Some(research_id) = recipe_id.strip_prefix("research_") {
            self.research(EconActor::Player(entity), research_id);
            return;
        }
        let actor = EconActor::Player(entity);
        let Some(recipe) = wilder_crafting::recipe(recipe_id) else {
            self.craft_fail(actor, "unknown recipe");
            return;
        };
        let building = station.or_else(|| {
            let pos = self.players.get(&entity)?.character.position;
            self.services_by_kind
                .get(&station_entity_kind(recipe.station))
                .into_iter()
                .flatten()
                .min_by(|a, b| {
                    let da = (a.1 - pos).length_squared();
                    let db = (b.1 - pos).length_squared();
                    da.partial_cmp(&db).unwrap_or(std::cmp::Ordering::Equal)
                })
                .map(|&(id, _)| id)
        });
        let Some(building) = building else {
            self.craft_fail(actor, &format!("no {:?} in reach", recipe.station));
            return;
        };
        self.queue_production(actor, building, recipe_id, 1);
    }

    /// CraftResult failure notice (players get UI feedback; agents no-op).
    fn craft_fail(&self, actor: EconActor, error: &str) {
        self.actor_notify(
            actor,
            S2C::CraftResult { ok: false, error: Some(error.to_string()), produced: None },
        );
    }

    /// Unlock a blueprint at the Laboratory — shared player/agent path:
    /// consumes fragments + resources + carried Energy, inserts into the
    /// actor's blueprint set (players persist via the blueprint store and
    /// get a BlueprintsUpdate; agents persist through population shards).
    /// Returns true when the unlock happened.
    fn research(&mut self, actor: EconActor, recipe_id: &str) -> bool {
        let near_lab = self
            .services_by_kind
            .get(&EntityKind::Laboratory)
            .into_iter()
            .flatten()
            .any(|&(id, _)| self.actor_in_range(actor, id, 5.0));
        if !near_lab {
            self.craft_fail(actor, "no Laboratory in reach");
            return false;
        }
        let Some(recipe) = wilder_crafting::recipe(recipe_id) else {
            self.craft_fail(actor, "unknown blueprint");
            return false;
        };
        if self.actor_knows_blueprint(actor, recipe.id) {
            self.craft_fail(actor, "already researched");
            return false;
        }
        if self.actor_count_items(actor, ItemKind::BlueprintFragment) < RESEARCH_FRAGMENTS {
            self.craft_fail(actor, &format!("need {RESEARCH_FRAGMENTS}x Blueprint Fragment"));
            return false;
        }
        for &(kind, count) in RESEARCH_RESOURCES {
            if self.actor_count_items(actor, kind) < count {
                self.craft_fail(actor, &format!("need {}x {}", count, kind.display_name()));
                return false;
            }
        }
        if self.actor_purse(actor).map_or(0, |p| p.carried(Currency::Energy)) < RESEARCH_ENERGY {
            self.craft_fail(actor, &format!("need {RESEARCH_ENERGY} Energy"));
            return false;
        }
        let Some(researcher) = self.actor_party(actor) else { return false };
        self.actor_remove_items(actor, ItemKind::BlueprintFragment, RESEARCH_FRAGMENTS);
        self.ledger.record(
            TxKind::CraftConsume,
            researcher.clone(),
            TxParty::Burn,
            TxAmount::Item { kind: ItemKind::BlueprintFragment, count: RESEARCH_FRAGMENTS },
            0,
        );
        for &(kind, count) in RESEARCH_RESOURCES {
            self.actor_remove_items(actor, kind, count);
            self.ledger.record(
                TxKind::CraftConsume,
                researcher.clone(),
                TxParty::Burn,
                TxAmount::Item { kind, count },
                0,
            );
        }
        if let Some(purse) = self.actor_purse_mut(actor) {
            purse.debit(Currency::Energy, RESEARCH_ENERGY);
        }
        self.persist_actor_purse(actor);
        self.ledger.record(
            TxKind::CraftConsume,
            researcher.clone(),
            TxParty::Burn,
            TxAmount::Energy { amount: RESEARCH_ENERGY },
            0,
        );
        self.ledger.blueprints_learned += 1;
        self.ledger.record(
            TxKind::CraftProduce,
            TxParty::Mint,
            researcher,
            TxAmount::Blueprint { recipe: recipe.id.to_string() },
            0,
        );
        match actor {
            EconActor::Player(entity) => {
                let Some(player) = self.players.get_mut(&entity) else { return true };
                player.blueprints.insert(recipe.id.to_string());
                player.dirty = true;
                let known: Vec<String> = player.blueprints.iter().cloned().collect();
                let _ = self.store.save_blueprints(player.character.id, &known);
                let _ =
                    player.tx.send(S2C::CraftResult { ok: true, error: None, produced: None });
                let _ = player.tx.send(S2C::BlueprintsUpdate { known });
                let _ = player.tx.send(S2C::InventoryUpdate(player.inventory.clone()));
                // WalletUpdate flows on the next replicate pass (wallet_sent
                // delta check catches the Energy debit).
            }
            EconActor::Agent(idx) => {
                self.agents[idx].blueprints.insert(recipe.id.to_string());
            }
        }
        true
    }

    /// Queue a timed production batch at a station building — the one entry
    /// point for players and agents alike. Validation: building exists and
    /// matches the recipe's station, actor within 5 m, blueprint known,
    /// queue below cap, inputs AND `recipe.energy * count` carried Energy
    /// available. Inputs and Energy burn up-front (CraftConsume); output
    /// lands in the (building, owner) buffer as units complete. Returns the
    /// job id on success.
    fn queue_production(
        &mut self,
        actor: EconActor,
        building: EntityId,
        recipe_id: &str,
        count: u32,
    ) -> Option<u64> {
        let Some(kind) = self.statics.get(&building).map(|s| s.kind) else {
            self.craft_fail(actor, "no such building");
            return None;
        };
        if !self.actor_in_range(actor, building, 5.0) {
            self.craft_fail(actor, "too far from the building");
            return None;
        }
        let Some(recipe) = wilder_crafting::recipe(recipe_id) else {
            self.craft_fail(actor, "unknown recipe");
            return None;
        };
        if !self.actor_knows_blueprint(actor, recipe.id) {
            self.craft_fail(actor, "blueprint not researched");
            return None;
        }
        if kind != station_entity_kind(recipe.station) {
            self.craft_fail(actor, &format!("recipe needs a {:?}", recipe.station));
            return None;
        }
        if self.production.get(&building).map_or(0, |q| q.len()) >= PRODUCTION_QUEUE_CAP {
            self.craft_fail(actor, "production queue is full");
            return None;
        }
        let count = count.clamp(1, 20);
        // Inputs + Energy are consumed up-front for the whole batch.
        for &(k, c) in recipe.inputs {
            if self.actor_count_items(actor, k) < c * count {
                self.craft_fail(actor, &format!("need {}x {}", c * count, k.display_name()));
                return None;
            }
        }
        let energy = recipe.energy * count;
        if self.actor_purse(actor).map_or(0, |p| p.carried(Currency::Energy)) < energy {
            self.craft_fail(actor, &format!("need {energy} Energy"));
            return None;
        }
        let owner = self.actor_owner_id(actor)?;
        let producer = self.actor_party(actor)?;
        for &(k, c) in recipe.inputs {
            self.actor_remove_items(actor, k, c * count);
            self.ledger.record(
                TxKind::CraftConsume,
                producer.clone(),
                TxParty::Burn,
                TxAmount::Item { kind: k, count: c * count },
                0,
            );
        }
        if energy > 0 {
            if let Some(purse) = self.actor_purse_mut(actor) {
                purse.debit(Currency::Energy, energy);
            }
            self.persist_actor_purse(actor);
            self.ledger.record(
                TxKind::CraftConsume,
                producer,
                TxParty::Burn,
                TxAmount::Energy { amount: energy },
                0,
            );
        }
        let id = self.next_job_id;
        self.next_job_id += 1;
        self.production.entry(building).or_default().push(ProductionJobState {
            id,
            owner,
            recipe,
            count,
            done: 0,
            remaining: recipe.seconds,
            powered: false,
        });
        self.production_dirty = true;
        if let EconActor::Player(entity) = actor {
            if let Some(player) = self.players.get(&entity) {
                let _ = player.tx.send(S2C::InventoryUpdate(player.inventory.clone()));
            }
            self.send_production_state(entity, building);
        }
        Some(id)
    }

    /// Cancel one of the actor's queued jobs: the uncompleted units' inputs
    /// and Energy come back (re-minted — the queue-time legs burned them);
    /// finished units stay in the output buffer. No client message maps
    /// here yet (cancel UI is Phase 6); agents and tests drive it directly.
    #[allow(dead_code)]
    fn cancel_production(&mut self, actor: EconActor, building: EntityId, job_id: u64) -> bool {
        let Some(owner) = self.actor_owner_id(actor) else { return false };
        let Some(queue) = self.production.get_mut(&building) else { return false };
        let Some(pos) = queue.iter().position(|j| j.id == job_id && j.owner == owner) else {
            return false;
        };
        let job = queue.remove(pos);
        if queue.is_empty() {
            self.production.remove(&building);
        }
        self.production_dirty = true;
        let pending = job.count - job.done;
        let party = self.actor_party(actor);
        for &(kind, count) in job.recipe.inputs {
            let refund = count * pending;
            if refund == 0 {
                continue;
            }
            let leftover = self.actor_add_items(actor, kind, refund);
            if leftover > 0 {
                if let Some(at) = self.actor_position(actor) {
                    self.spawn_loot(
                        at,
                        vec![ItemStack { kind, count: leftover }],
                        party.clone(),
                        true,
                    );
                }
            }
            if let Some(party) = party.clone() {
                self.ledger.record(
                    TxKind::Mint,
                    TxParty::Mint,
                    party,
                    TxAmount::Item { kind, count: refund },
                    0,
                );
            }
        }
        let energy = job.recipe.energy * pending;
        if energy > 0 {
            if let Some(purse) = self.actor_purse_mut(actor) {
                purse.credit(Currency::Energy, energy);
            }
            self.persist_actor_purse(actor);
            if let Some(party) = party {
                self.ledger.record(
                    TxKind::Mint,
                    TxParty::Mint,
                    party,
                    TxAmount::Energy { amount: energy },
                    0,
                );
            }
        }
        if let EconActor::Player(entity) = actor {
            if let Some(player) = self.players.get(&entity) {
                let _ = player.tx.send(S2C::InventoryUpdate(player.inventory.clone()));
            }
            self.send_production_state(entity, building);
        }
        true
    }

    /// Hand an actor everything buffered under its owner id at `building`
    /// (5 m / interior rule). Whatever doesn't fit the pack stays buffered.
    /// Returns what was actually collected.
    fn collect_production(&mut self, actor: EconActor, building: EntityId) -> Vec<ItemStack> {
        let Some(owner) = self.actor_owner_id(actor) else { return Vec::new() };
        if !self.actor_in_range(actor, building, 5.0) {
            return Vec::new();
        }
        let Some(stacks) = self.production_outputs.remove(&(building, owner)) else {
            return Vec::new();
        };
        let mut collected = Vec::new();
        let mut leftovers = Vec::new();
        for stack in stacks {
            let rem = self.actor_add_items(actor, stack.kind, stack.count);
            if stack.count > rem {
                collected.push(ItemStack { kind: stack.kind, count: stack.count - rem });
            }
            if rem > 0 {
                leftovers.push(ItemStack { kind: stack.kind, count: rem });
            }
        }
        if !leftovers.is_empty() {
            self.production_outputs.insert((building, owner), leftovers);
        }
        if collected.is_empty() {
            return collected;
        }
        self.production_dirty = true;
        match actor {
            EconActor::Player(entity) => {
                if let Some(player) = self.players.get(&entity) {
                    let _ = player.tx.send(S2C::InventoryUpdate(player.inventory.clone()));
                    // The gather toast doubles as collection feedback until
                    // the Phase 6 production UI lands.
                    let _ = player
                        .tx
                        .send(S2C::GatherResult { gained: collected.clone(), denied: false });
                }
            }
            EconActor::Agent(idx) => {
                // Retire the pending note once nothing of ours is left here.
                let live = self
                    .production
                    .get(&building)
                    .is_some_and(|q| q.iter().any(|j| j.owner == owner))
                    || self.production_outputs.contains_key(&(building, owner));
                if !live {
                    self.agents[idx].pending_jobs.retain(|&(b, _)| b != building);
                }
            }
        }
        collected
    }

    /// Push a building's shared queue plus the receiving player's own
    /// buffer (opens/refreshes the production UI).
    fn send_production_state(&self, entity: EntityId, building: EntityId) {
        let Some(player) = self.players.get(&entity) else { return };
        let jobs: Vec<ProductionJob> = self
            .production
            .get(&building)
            .map(|q| q.iter().map(|j| j.to_wire()).collect())
            .unwrap_or_default();
        let buffered = self
            .production_outputs
            .get(&(building, OwnerId::Player(player.character.id)))
            .cloned()
            .unwrap_or_default();
        let _ = player.tx.send(S2C::ProductionState { building, jobs, buffered });
    }

    /// Refresh the production UI of every online player invested in
    /// `building` (has a job or a buffer there) after queue state changed.
    fn broadcast_production_state(&self, building: EntityId) {
        let queue = self.production.get(&building);
        for player in self.players.values() {
            let owner = OwnerId::Player(player.character.id);
            let invested = queue.is_some_and(|q| q.iter().any(|j| j.owner == owner))
                || self.production_outputs.contains_key(&(building, owner));
            if invested {
                self.send_production_state(player.entity, building);
            }
        }
    }

    /// Advance each active building's queue under its per-station energy
    /// cap: jobs run concurrently from the head while the summed
    /// `Recipe::energy` of running jobs fits `station_energy_cap`; the rest
    /// wait unpowered. Completed units land in the (building, owner) output
    /// buffer — never straight into a backpack. Cost scales with buildings
    /// that actually have jobs, not the statics map.
    fn tick_production(&mut self) {
        if !self.production.is_empty() {
            let mut buildings: Vec<EntityId> = self.production.keys().copied().collect();
            buildings.sort_unstable();
            for building in buildings {
                let mut completions: Vec<(OwnerId, &'static wilder_crafting::Recipe)> =
                    Vec::new();
                let mut state_changed = false;
                let now_empty = {
                    let jobs = self.production.get_mut(&building).unwrap();
                    let cap = jobs
                        .first()
                        .map(|j| station_energy_cap(j.recipe.station))
                        .unwrap_or(0);
                    let mut running = 0u32;
                    for job in jobs.iter_mut() {
                        let powered = running + job.recipe.energy <= cap;
                        if powered {
                            running += job.recipe.energy;
                        }
                        if powered != job.powered {
                            job.powered = powered;
                            state_changed = true;
                        }
                        if !powered {
                            continue;
                        }
                        job.remaining -= TICK_DT;
                        if job.remaining <= 0.0 {
                            job.done += 1;
                            job.remaining = job.recipe.seconds;
                            completions.push((job.owner, job.recipe));
                            state_changed = true;
                        }
                    }
                    jobs.retain(|j| j.done < j.count);
                    jobs.is_empty()
                };
                if now_empty {
                    self.production.remove(&building);
                }
                for (owner, recipe) in completions {
                    self.complete_production_unit(building, owner, recipe);
                }
                if state_changed {
                    self.production_dirty = true;
                    self.broadcast_production_state(building);
                }
            }
        }
        // Seamless player pickup until the HUD grows a Collect button
        // (Phase 6): buffered goods flow to online owners standing in range.
        self.auto_collect_player_buffers();
    }

    /// One finished unit: buffer the output at (building, owner), mint it
    /// on the ledger, bump craft stats, and let agents learn the margin.
    fn complete_production_unit(
        &mut self,
        building: EntityId,
        owner: OwnerId,
        recipe: &'static wilder_crafting::Recipe,
    ) {
        let (kind, count) = recipe.output;
        let buffer = self.production_outputs.entry((building, owner)).or_default();
        match buffer.iter_mut().find(|s| s.kind == kind) {
            Some(stack) => stack.count += count,
            None => buffer.push(ItemStack { kind, count }),
        }
        self.production_dirty = true;
        let party = self.owner_party(owner);
        self.ledger.record(
            TxKind::CraftProduce,
            TxParty::Mint,
            party,
            TxAmount::Item { kind, count },
            0,
        );
        match owner {
            OwnerId::Player(id) => {
                if let Some(p) = self.players.values().find(|p| p.character.id == id) {
                    self.stats.add_crafted(&player_actor(p), count as u64);
                }
            }
            OwnerId::Agent(id) => {
                if let Some(idx) = self.agents.iter().position(|a| a.agent_id == id) {
                    let crafter = self.agent_actor_ref(idx);
                    self.stats.add_crafted(&crafter, count as u64);
                    // Learn the value-added margin net of the Energy burned.
                    let in_value: u32 =
                        recipe.inputs.iter().map(|&(k, c)| base_value(k) * c).sum();
                    let out_value = base_value(kind).saturating_mul(count);
                    let margin = out_value.saturating_sub(in_value) as f32
                        - recipe.energy as f32 * ENERGY_MILD_VALUE;
                    self.agents[idx].learn(Activity::Craft, margin);
                }
            }
        }
    }

    /// Ledger party for a job owner, resolvable while the owner is offline
    /// (players) or after the exact index moved (agents).
    fn owner_party(&self, owner: OwnerId) -> TxParty {
        match owner {
            OwnerId::Player(id) => {
                if let Some(p) = self.players.values().find(|p| p.character.id == id) {
                    return player_party(p);
                }
                match self.store.character(id) {
                    Ok(ch) => TxParty::Player { id, name: ch.name, faction: ch.faction },
                    Err(_) => TxParty::Burn,
                }
            }
            OwnerId::Agent(id) => match self.agents.iter().find(|a| a.agent_id == id) {
                Some(a) => a.party(),
                None => TxParty::Burn,
            },
        }
    }

    /// Buffered output flows to online player owners standing within reach
    /// — the client has no Collect button until Phase 6, so goods must
    /// keep reaching players without UI changes (interact also collects).
    fn auto_collect_player_buffers(&mut self) {
        if self.production_outputs.is_empty() {
            return;
        }
        let mut pulls: Vec<(EntityId, EntityId)> = Vec::new();
        for &(building, owner) in self.production_outputs.keys() {
            let OwnerId::Player(char_id) = owner else { continue };
            if let Some(p) = self.players.values().find(|p| p.character.id == char_id) {
                pulls.push((p.entity, building));
            }
        }
        pulls.sort_unstable();
        for (entity, building) in pulls {
            // collect_production applies the 5 m / interior range rule.
            self.collect_production(EconActor::Player(entity), building);
        }
    }

    /// Drop a dead identity's production: queued batches vanish (their
    /// inputs and Energy were burned at queue time — carried-goods-at-risk
    /// rules apply) and uncollected buffers burn on the ledger.
    fn purge_owner_production(&mut self, owner: OwnerId, party: TxParty) {
        let mut changed = false;
        self.production.retain(|_, queue| {
            let before = queue.len();
            queue.retain(|j| j.owner != owner);
            changed |= queue.len() != before;
            !queue.is_empty()
        });
        let keys: Vec<(EntityId, OwnerId)> =
            self.production_outputs.keys().filter(|&&(_, o)| o == owner).copied().collect();
        for key in keys {
            if let Some(stacks) = self.production_outputs.remove(&key) {
                changed = true;
                for stack in stacks {
                    self.ledger.record(
                        TxKind::Burn,
                        party.clone(),
                        TxParty::Burn,
                        TxAmount::Item { kind: stack.kind, count: stack.count },
                        0,
                    );
                }
            }
        }
        if changed {
            self.production_dirty = true;
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
        let districts = self.district_control();
        for p in self.players.values() {
            let _ = p.tx.send(S2C::TerritoryState {
                cells: cells.clone(),
                districts: districts.clone(),
            });
        }
    }

    /// True when the region at `pos` is held by a faction hostile to
    /// `faction` (that faction's members get taxed / cut out there).
    fn region_hostile_to(&self, pos: Vec3, faction: FactionId) -> bool {
        self.territory
            .get(&region_of(pos))
            .is_some_and(|&holder| are_hostile(holder, faction))
    }

    /// Recompute Halo-style control for regions with any activity. A cell is
    /// claimed by the *sole* faction standing in it (first there wins an
    /// empty/neutral cell), only flips once every enemy body has been cleared
    /// out, and stays held while empty. A cell with two or more factions
    /// present is a standoff and keeps its current owner. Sanctuary ground
    /// (and the protected hub) never flips; Guarded ground only ever lights up
    /// for its home faction. After settling ownership, the rolling zone clock
    /// accrues seconds-held for the dashboard.
    fn tick_territory(&mut self) {
        if self.tick % TERRITORY_TICK_INTERVAL != 0 {
            return;
        }
        // (bodies, players, strength) per faction per region — one sweep
        // feeds both the control math and the field intel agents decide on.
        let mut presence: HashMap<(i32, i32), HashMap<FactionId, (u32, u32, f32)>> =
            HashMap::new();
        let mut add = |pos: Vec3, faction: FactionId, is_player: bool, strength: f32| {
            if faction == FACTION_NEUTRAL {
                return;
            }
            let entry = presence
                .entry(region_of(pos))
                .or_default()
                .entry(faction)
                .or_insert((0, 0, 0.0));
            entry.0 += 1;
            entry.1 += is_player as u32;
            entry.2 += strength;
        };
        for p in self.players.values() {
            if p.character.health > 0.0 {
                add(p.character.position, p.character.faction, true, PLAYER_INTEL_STRENGTH);
            }
        }
        // Agents come off the maintained spatial grid: only living agents,
        // already grouped by chunk, with the region derived once per bucket
        // — not a scan of the whole (mostly irrelevant) population vec.
        // Remember who stood where for the capture-payoff credits below.
        let mut agent_where: Vec<((i32, i32), u32)> = Vec::new();
        for (chunk, bucket) in &self.agent_grid {
            if bucket.is_empty() {
                continue;
            }
            let region = (chunk.x.div_euclid(REGION_CHUNKS), chunk.z.div_euclid(REGION_CHUNKS));
            let counts = presence.entry(region).or_default();
            for &i in bucket {
                let agent = &self.agents[i as usize];
                // The grid holds living agents, but deaths that bypass
                // kill_agent (tests zero health directly) regrid lazily.
                if !agent.alive() || agent.faction == FACTION_NEUTRAL {
                    continue;
                }
                let entry = counts.entry(agent.faction).or_insert((0, 0, 0.0));
                entry.0 += 1;
                entry.2 += agent.strength();
                agent_where.push((region, i));
            }
        }

        let mut regions: HashSet<(i32, i32)> = HashSet::new();
        regions.extend(presence.keys().copied());
        regions.extend(self.territory.keys().copied());

        let mut changed = false;
        // Regions that just flipped to a faction (payoff credits below).
        let mut flips: HashMap<(i32, i32), FactionId> = HashMap::new();
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
                        if counts.get(&home).map(|&(n, _, _)| n).unwrap_or(0) > 0 {
                            home
                        } else if cur == home {
                            cur // hold home turf once lit
                        } else {
                            FACTION_NEUTRAL
                        }
                    }
                    DangerLevel::Contested | DangerLevel::Warzone => {
                        // Halo capture: the sole faction present owns the cell
                        // (claims neutral ground on arrival, or takes it once
                        // the last enemy is cleared). Empty cells keep their
                        // holder; two-plus factions is a standoff (no flip).
                        // `counts` only holds factions with at least one body.
                        let mut present = counts.keys().copied();
                        match (present.next(), present.next()) {
                            (None, _) => cur,           // empty: holder persists
                            (Some(only), None) => only, // sole presence claims
                            (Some(_), Some(_)) => cur,  // standoff: no flip
                        }
                    }
                }
            };
            if desired != cur {
                if desired == FACTION_NEUTRAL {
                    self.territory.remove(&r);
                } else {
                    self.territory.insert(r, desired);
                    flips.insert(r, desired);
                }
                changed = true;
            }
        }
        if changed {
            self.territory_dirty = true;
            self.broadcast_territory();
        }

        // Rebuild the field intel map: presence counts/strengths, settled
        // control, and decaying income/casualty signals.
        let fresh_income = std::mem::take(&mut self.region_income);
        let fresh_casualties = std::mem::take(&mut self.region_casualties);
        let mut intel_regions: HashSet<(i32, i32)> = HashSet::new();
        intel_regions.extend(presence.keys().copied());
        intel_regions.extend(self.territory.keys().copied());
        intel_regions.extend(self.field_intel.keys().copied());
        intel_regions.extend(fresh_income.keys().copied());
        intel_regions.extend(fresh_casualties.keys().copied());
        let mut intel: HashMap<(i32, i32), RegionIntel> = HashMap::new();
        for r in intel_regions {
            let mut cell = RegionIntel::default();
            if let Some(old) = self.field_intel.get(&r) {
                cell.income = old.income * INTEL_INCOME_DECAY;
                cell.casualties = old.casualties * INTEL_CASUALTY_DECAY;
            }
            cell.income += fresh_income.get(&r).copied().unwrap_or(0) as f32;
            cell.casualties += fresh_casualties.get(&r).copied().unwrap_or(0) as f32;
            if let Some(counts) = presence.get(&r) {
                for (&f, &(n, _, s)) in counts {
                    match f {
                        FACTION_REBELS => {
                            cell.rebels = n;
                            cell.rebel_strength = s;
                        }
                        FACTION_FORUM => {
                            cell.forum = n;
                            cell.forum_strength = s;
                        }
                        FACTION_WAPES => {
                            cell.wapes = n;
                            cell.wape_strength = s;
                        }
                        _ => {}
                    }
                }
            }
            cell.controller = self.territory.get(&r).copied().unwrap_or(FACTION_NEUTRAL);
            // Drop dead entries so the map tracks activity, not history.
            let quiet = cell.rebels == 0
                && cell.forum == 0
                && cell.wapes == 0
                && cell.controller == FACTION_NEUTRAL
                && cell.income < 0.5
                && cell.casualties < 0.1;
            if !quiet {
                intel.insert(r, cell);
            }
        }
        self.field_intel = intel;

        // Learning: a flip pays every friendly body standing in the region
        // (their presence did the flipping); a contested hold pays the agents
        // deliberately standing guard. Both are rate samples (MILD/min) —
        // the value a body earns its faction by being exactly here.
        for &(r, i) in &agent_where {
            let idx = i as usize;
            let Some(cell) = self.field_intel.get(&r).copied() else { continue };
            let faction = self.agents[idx].faction;
            if flips.get(&r) == Some(&faction) {
                self.agents[idx]
                    .traits
                    .credit(Activity::Capture, 35.0 + (cell.income * 0.3).min(45.0));
                continue;
            }
            let (_, enemy, _, _) = cell.sides(faction);
            let holding = matches!(
                self.agents[idx].goal,
                Goal::Capture { .. } | Goal::Defend { .. }
            );
            if holding && cell.controller == faction && enemy > 0 {
                self.agents[idx]
                    .traits
                    .credit(Activity::Capture, 12.0 + (cell.income * 0.2).min(20.0));
            }
        }

        // Accrue rolling zone-seconds for whatever is held this tick. The
        // territory tick runs at a fixed cadence, so each pass credits the
        // same slice of wall-clock time to every held cell's district.
        let dt = TERRITORY_TICK_INTERVAL as f64 / TICK_HZ as f64;
        self.zone_clock.advance(dt);
        for (&r, &holder) in &self.territory {
            if let Some((di, _)) = districts::district_of(region_center(r)) {
                self.zone_clock.add(di, holder, dt);
            }
        }
    }

    /// Per-neighborhood rolling territory standings for the dashboard: current
    /// owner (most cells) plus seconds-held per faction over the window.
    fn zone_standings(&self) -> Vec<ZoneStanding> {
        let defs = districts::district_defs();
        let control = self.district_control();
        let secs = self.zone_clock.seconds_by_district();
        let registry = faction_registry();
        defs.iter()
            .enumerate()
            .map(|(di, d)| {
                let per = secs.get(di).copied().unwrap_or([0; ZONE_FACTIONS]);
                let seconds = registry
                    .iter()
                    .map(|f| ZoneSeconds {
                        faction: f.id,
                        seconds: per.get(f.id as usize).copied().unwrap_or(0),
                    })
                    .collect();
                ZoneStanding {
                    district: d.name.clone(),
                    control: control.get(di).copied().unwrap_or(FACTION_NEUTRAL),
                    seconds,
                }
            })
            .collect()
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
        let _ = player
            .tx
            .send(S2C::MarketState { listings, wallet: player.purse.carried(Currency::Wild) });
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

    /// Position of a MarketTerminal the actor is standing at (5 m or inside
    /// its walk-in room) — the shared range rule for trading on the book.
    fn market_terminal_near(&self, actor: EconActor) -> Option<Vec3> {
        self.services_by_kind
            .get(&EntityKind::MarketTerminal)
            .into_iter()
            .flatten()
            .find(|&&(entity, _)| self.actor_in_range(actor, entity, 5.0))
            .map(|&(_, pos)| pos)
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
                    agent: false,
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
                if !buyer.purse.debit(Currency::Wild, cost) {
                    return Err(format!(
                        "need {cost} MILD, have {}",
                        buyer.purse.carried(Currency::Wild)
                    ));
                }
                let buyer_account = buyer.character.account_id;
                let buyer_pos = buyer.character.position;
                let buyer_name = buyer.character.name.clone();
                let buyer_party = player_party(buyer);
                let leftover = inv::add_items(&mut buyer.inventory.slots, kind, count);
                buyer.dirty = true;
                let _ = self
                    .store
                    .update_wallet(buyer_account, self.players[&entity].purse.carried(Currency::Wild));
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
                // Ledger: escrowed items leave the market agent for the
                // buyer; the buyer's MILD splits into seller proceeds and
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
                self.market_stats.record_fill(kind, price_each, count, buyer_name, seller_name);

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
    // Vendors & bank
    // -----------------------------------------------------------------------

    /// Units of `kind` a vendor currently holds on its shelves.
    fn vendor_stock_count(&self, vendor: EntityId, kind: ItemKind) -> u32 {
        self.vendor_stock
            .get(&vendor)
            .map_or(0, |stacks| stacks.iter().filter(|s| s.kind == kind).map(|s| s.count).sum())
    }

    /// Put `count` of `kind` onto a vendor's shelves.
    fn vendor_stock_add(&mut self, vendor: EntityId, kind: ItemKind, count: u32) {
        let stacks = self.vendor_stock.entry(vendor).or_default();
        match stacks.iter_mut().find(|s| s.kind == kind) {
            Some(stack) => stack.count += count,
            None => stacks.push(ItemStack { kind, count }),
        }
        self.vendor_stock_dirty = true;
    }

    /// Take up to `count` of `kind` off a vendor's shelves; returns what came
    /// off. The entry itself stays (empty = sold out, never re-seeded).
    fn vendor_stock_remove(&mut self, vendor: EntityId, kind: ItemKind, count: u32) -> u32 {
        let Some(stacks) = self.vendor_stock.get_mut(&vendor) else { return 0 };
        let mut left = count;
        for stack in stacks.iter_mut().filter(|s| s.kind == kind) {
            let take = left.min(stack.count);
            stack.count -= take;
            left -= take;
            if left == 0 {
                break;
            }
        }
        stacks.retain(|s| s.count > 0);
        self.vendor_stock_dirty = true;
        count - left
    }

    /// Seed starting stock onto every Armory/Bodega shelf that has never had
    /// an entry: a modest bootstrap per price line the vendor SELLS, minted
    /// once to the vendor's ledger party. Vendors with a persisted entry
    /// (even an empty, sold-out one) are left alone, so restarts and re-runs
    /// never re-mint. Called after static seeding; idempotent.
    fn ensure_vendor_stock(&mut self) {
        let vendors: Vec<EntityId> = self
            .statics
            .values()
            .filter(|s| matches!(s.kind, EntityKind::Armory | EntityKind::Bodega))
            .filter(|s| !self.vendor_stock.contains_key(&s.entity))
            .map(|s| s.entity)
            .collect();
        for vendor in vendors {
            let (kind, party) = {
                let s = &self.statics[&vendor];
                (s.kind, static_party(s))
            };
            let seed: Vec<ItemStack> = wilder_economy::vendor_offers(kind)
                .iter()
                .filter(|e| e.buy > 0)
                .map(|e| ItemStack {
                    kind: e.kind,
                    count: wilder_economy::seed_stock_count(e.kind),
                })
                .collect();
            for stack in &seed {
                self.ledger.record(
                    TxKind::Mint,
                    TxParty::Mint,
                    party.clone(),
                    TxAmount::Item { kind: stack.kind, count: stack.count },
                    0,
                );
            }
            self.vendor_stock.insert(vendor, seed);
            self.vendor_stock_dirty = true;
        }
    }

    fn send_vendor_state(&self, entity: EntityId, vendor: EntityId) {
        let (Some(player), Some(station)) =
            (self.players.get(&entity), self.statics.get(&vendor))
        else {
            return;
        };
        let offers: Vec<VendorOffer> = wilder_economy::vendor_offers(station.kind)
            .iter()
            .map(|e| VendorOffer {
                kind: e.kind,
                buy: e.buy,
                sell: e.sell,
                stock: self.vendor_stock_count(vendor, e.kind),
            })
            .collect();
        let purse = &player.purse;
        let _ = player.tx.send(S2C::VendorState {
            vendor,
            kind: station.kind,
            offers,
            wallet: purse.carried(Currency::Wild),
            bank: purse.banked(Currency::Wild),
            shards: purse.carried(Currency::Shards),
            bank_shards: purse.banked(Currency::Shards),
            energy: purse.carried(Currency::Energy),
            bank_energy: purse.banked(Currency::Energy),
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
                self.vendor_buy(EconActor::Player(entity), vendor, item, count.clamp(1, 100))
            }
            VendorAction::Sell { kind: item, count } => {
                self.vendor_sell(EconActor::Player(entity), vendor, item, count)
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
                player.purse.credit(Currency::Wild, count - fee);
                let account = player.character.account_id;
                let wallet = player.purse.carried(Currency::Wild);
                let converter = player_party(player);
                player.dirty = true;
                let _ = self.store.update_wallet(account, wallet);
                // Ledger: Cash burns out of supply and MILD mints in its
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
            VendorAction::Deposit { currency, amount } => {
                if kind != EntityKind::Bank {
                    return Err("only a Bank holds deposits".into());
                }
                self.move_to_bank(EconActor::Player(entity), currency.into(), amount, true)
            }
            VendorAction::Withdraw { currency, amount } => {
                if kind != EntityKind::Bank {
                    return Err("only a Bank holds deposits".into());
                }
                self.move_to_bank(EconActor::Player(entity), currency.into(), amount, false)
            }
        }
    }

    /// Vendor buy for any economy actor: same rules and ledger legs whether a
    /// player or a faction agent stands at the counter. Shelves are stock-
    /// backed: the vendor only sells what it holds (out of stock = denied,
    /// a short shelf clamps the batch). Debits the purse, hands over the
    /// stock (overflow spills as ground loot at the buyer's feet — paid for,
    /// never silently dropped), and routes the commerce cut.
    fn vendor_buy(
        &mut self,
        actor: EconActor,
        vendor: EntityId,
        item: ItemKind,
        count: u32,
    ) -> Result<(), String> {
        let (kind, pos, vendor_agent) = self
            .statics
            .get(&vendor)
            .map(|s| (s.kind, s.position, static_party(s)))
            .ok_or("no such vendor")?;
        let offer = wilder_economy::vendor_offers(kind)
            .iter()
            .find(|e| e.kind == item && e.buy > 0)
            .ok_or("not sold here")?;
        let in_stock = self.vendor_stock_count(vendor, item);
        if in_stock == 0 {
            return Err("out of stock".into());
        }
        let count = count.min(in_stock);
        let cost = offer.buy.saturating_mul(count);
        let buyer = self.actor_party(actor).ok_or("not in world")?;
        let purse = self.actor_purse_mut(actor).ok_or("not in world")?;
        if !purse.debit(Currency::Wild, cost) {
            return Err(format!("need {cost} MILD, have {}", purse.carried(Currency::Wild)));
        }
        self.persist_actor_purse(actor);
        let buyer_pos = self.actor_position(actor).unwrap_or(pos);
        self.vendor_stock_remove(vendor, item, count);
        let leftover = self.actor_add_items(actor, item, count);
        // Ledger: MILD moves onto the vendor agent; the goods come OFF the
        // vendor's real shelf — a transfer, not issuance (the items already
        // entered supply when they were mined/crafted/seeded).
        self.ledger.record(
            TxKind::VendorBuy,
            buyer.clone(),
            vendor_agent.clone(),
            TxAmount::Wild { amount: cost },
            0,
        );
        self.ledger.record(
            TxKind::VendorBuy,
            vendor_agent.clone(),
            buyer.clone(),
            TxAmount::Item { kind: item, count },
            0,
        );
        if leftover > 0 {
            self.spawn_loot(
                buyer_pos,
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

    /// Vendor sell for any economy actor: items land on the vendor's real
    /// shelf (capped per kind — a full shelf refuses the trade — so vendors
    /// never become infinite item vacuums), the payout (minus the commerce
    /// cut) lands in the purse, the cut routes to whoever holds the ground.
    /// Sells up to `count`, clamped to what's held and to the shelf cap.
    fn vendor_sell(
        &mut self,
        actor: EconActor,
        vendor: EntityId,
        item: ItemKind,
        count: u32,
    ) -> Result<(), String> {
        let (kind, pos, vendor_agent) = self
            .statics
            .get(&vendor)
            .map(|s| (s.kind, s.position, static_party(s)))
            .ok_or("no such vendor")?;
        let offer = wilder_economy::vendor_offers(kind)
            .iter()
            .find(|e| e.kind == item && e.sell > 0)
            .ok_or("not bought here")?;
        let have = self.actor_count_items(actor, item);
        if have == 0 {
            return Err(format!("no {} to sell", item.display_name()));
        }
        let shelf_room = wilder_economy::VENDOR_STOCK_CAP
            .saturating_sub(self.vendor_stock_count(vendor, item));
        if shelf_room == 0 {
            return Err(format!("vendor is fully stocked on {}", item.display_name()));
        }
        let count = count.clamp(1, have).min(shelf_room);
        let seller = self.actor_party(actor).ok_or("not in world")?;
        self.actor_remove_items(actor, item, count);
        self.vendor_stock_add(vendor, item, count);
        let gross = offer.sell.saturating_mul(count);
        let cut = gross * wilder_economy::COMMERCE_CUT_PCT / 100;
        if let Some(purse) = self.actor_purse_mut(actor) {
            purse.credit(Currency::Wild, gross - cut);
        }
        self.persist_actor_purse(actor);
        // Ledger: sold items transfer onto the vendor's shelf (they stay in
        // supply for the next buyer); the payout comes off the vendor
        // agent's balance.
        self.ledger.record(
            TxKind::VendorSell,
            seller.clone(),
            vendor_agent.clone(),
            TxAmount::Item { kind: item, count },
            0,
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

    /// Move `amount` of a currency between an actor's at-risk carried balance
    /// and its death-safe bank vault (`deposit` picks the direction). The
    /// currency never leaves supply — it just changes its exposure to death —
    /// so no ledger leg is recorded. Write-through to the account store.
    fn move_to_bank(
        &mut self,
        actor: EconActor,
        currency: Currency,
        amount: u32,
        deposit: bool,
    ) -> Result<(), String> {
        let purse = self.actor_purse_mut(actor).ok_or("not in world")?;
        let moved =
            if deposit { purse.deposit(currency, amount) } else { purse.withdraw(currency, amount) };
        if moved == 0 {
            return Err(if deposit { "nothing to deposit" } else { "nothing banked" }.into());
        }
        if let EconActor::Player(id) = actor {
            if let Some(p) = self.players.get_mut(&id) {
                p.dirty = true;
            }
        }
        self.persist_actor_purse(actor);
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Extraction: stashing items at Storage terminals
    // -----------------------------------------------------------------------

    /// Storage terminal the actor can extract at: within 5 m or inside its
    /// walk-in room. Same range rule for players and agents.
    fn near_storage(&self, actor: EconActor) -> Option<EntityId> {
        self.statics
            .values()
            .filter(|s| s.kind == EntityKind::Building)
            .find(|s| self.actor_in_range(actor, s.entity, 5.0))
            .map(|s| s.entity)
    }

    /// Mutable view of an actor's stash slots (players persist via the
    /// stash store, agents via the population shards).
    fn actor_stash_slots_mut(&mut self, actor: EconActor) -> Option<&mut [Option<ItemStack>]> {
        match actor {
            EconActor::Player(id) => self.players.get_mut(&id).map(|p| {
                p.dirty = true;
                p.stash.slots.as_mut_slice()
            }),
            EconActor::Agent(idx) => self.agents.get_mut(idx).map(|a| a.stash.as_mut_slice()),
        }
    }

    /// Land items the caller already pulled out of the source container in
    /// the destination (stash on deposit, backpack on withdraw) and record
    /// the `TxKind::Extract` ledger leg for what moved. Extraction is a
    /// risk transfer, not a supply change, so both directions are neutral
    /// transfers between the owner and the Storage terminal's party (the
    /// withdraw leg is the deposit with the parties swapped). Returns the
    /// leftover that did NOT fit — the caller restores it to the source.
    fn stash_settle(
        &mut self,
        actor: EconActor,
        storage: EntityId,
        kind: ItemKind,
        count: u32,
        deposit: bool,
    ) -> u32 {
        if count == 0 {
            return 0;
        }
        let leftover = if deposit {
            match self.actor_stash_slots_mut(actor) {
                Some(slots) => inv::add_items(slots, kind, count),
                None => count,
            }
        } else {
            self.actor_add_items(actor, kind, count)
        };
        let moved = count - leftover;
        if moved == 0 {
            return leftover;
        }
        let (Some(owner), Some(storage_party)) =
            (self.actor_party(actor), self.statics.get(&storage).map(static_party))
        else {
            return leftover;
        };
        let (from, to) = if deposit {
            (owner, storage_party)
        } else {
            (storage_party, owner)
        };
        self.ledger.record(TxKind::Extract, from, to, TxAmount::Item { kind, count: moved }, 0);
        if deposit {
            self.ledger.items_extracted += moved as u64;
        } else {
            self.ledger.items_withdrawn += moved as u64;
        }
        leftover
    }

    /// Move up to `count` of `kind` between an actor's backpack and stash at
    /// a Storage terminal — the shared extract/deposit path (players' stash
    /// UI actions and agent Extract errands both land here). Range-checked
    /// (5 m / interior); whatever doesn't fit the destination stays where it
    /// was. Returns how many actually moved.
    fn stash_transfer(
        &mut self,
        actor: EconActor,
        storage: EntityId,
        kind: ItemKind,
        count: u32,
        deposit: bool,
    ) -> Result<u32, String> {
        if !self.actor_in_range(actor, storage, 5.0) {
            return Err("no stash terminal nearby".into());
        }
        let pulled = if deposit {
            self.actor_remove_items(actor, kind, count)
        } else {
            match self.actor_stash_slots_mut(actor) {
                Some(slots) => inv::remove_items(slots, kind, count),
                None => 0,
            }
        };
        if pulled == 0 {
            return Ok(0);
        }
        let leftover = self.stash_settle(actor, storage, kind, pulled, deposit);
        if leftover > 0 {
            // Destination full: the remainder goes back where it came from
            // (it was pulled a moment ago, so it always fits).
            if deposit {
                self.actor_add_items(actor, kind, leftover);
            } else if let Some(slots) = self.actor_stash_slots_mut(actor) {
                inv::add_items(slots, kind, leftover);
            }
        }
        Ok(pulled - leftover)
    }

    /// Route a commerce cut to whoever holds the territory it happened in:
    /// split evenly among the controlling faction's members standing in the
    /// region — players and faction agents alike. Neutral ground burns it,
    /// as do rounding remainders.
    ///
    /// Ledger: `from` is the agent routing the cut. When `minted` is true the
    /// cut is new MILD (bank conversion fee) — paid shares are mint legs and
    /// unrouted MILD simply never enters supply; otherwise the cut is real
    /// MILD the agent collected, so unrouted amounts burn.
    fn distribute_commerce(&mut self, pos: Vec3, cut: u32, from: TxParty, minted: bool) {
        if cut == 0 {
            return;
        }
        // Anything not paid out either burns (real WILD) or is never minted.
        let mut unrouted = cut;
        let region = region_of(pos);
        // Field intel: commerce flowed here — this ground is worth holding,
        // whoever (if anyone) currently skims it.
        *self.region_income.entry(region).or_insert(0) += cut;
        let controller = self.territory.get(&region).copied().unwrap_or(FACTION_NEUTRAL);
        if controller != FACTION_NEUTRAL {
            // One holder list, players and agents alike: everyone standing on
            // controlled ground splits the cut through the same actor path.
            let mut holders: Vec<EconActor> = self
                .players
                .values()
                .filter(|p| {
                    controller == p.character.faction
                        && p.character.health > 0.0
                        && region_of(p.character.position) == region
                })
                .map(|p| EconActor::Player(p.entity))
                .collect();
            holders.extend(
                self.agents
                    .iter()
                    .enumerate()
                    .filter(|(_, a)| {
                        a.alive() && a.faction == controller && region_of(a.position) == region
                    })
                    .map(|(i, _)| EconActor::Agent(i)),
            );
            let share = if holders.is_empty() { 0 } else { cut / holders.len() as u32 };
            if share > 0 {
                let effect = if minted { SupplyEffect::Mint } else { SupplyEffect::Auto };
                for actor in holders {
                    let Some(holder) = self.actor_party(actor) else { continue };
                    if let Some(purse) = self.actor_purse_mut(actor) {
                        purse.credit(Currency::Wild, share);
                    }
                    unrouted -= share;
                    self.persist_actor_purse(actor);
                    self.ledger.record_ex(
                        TxKind::Fee,
                        from.clone(),
                        holder,
                        TxAmount::Wild { amount: share },
                        0,
                        effect,
                    );
                    self.actor_notify(
                        actor,
                        S2C::Chat {
                            from: "system".into(),
                            text: format!("+{share} MILD — commerce cut from territory you hold"),
                        },
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
        // Stash moves run through the shared extraction path (Storage range
        // rule + Extract ledger legs) before the pure-backpack actions
        // below borrow the player.
        match action {
            InventoryAction::Deposit { slot } => {
                self.player_stash_action(entity, slot, true);
                return;
            }
            InventoryAction::Withdraw { stash_slot } => {
                self.player_stash_action(entity, stash_slot, false);
                return;
            }
            _ => {}
        }
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
            // Handled above through the shared extraction path.
            InventoryAction::Deposit { .. } | InventoryAction::Withdraw { .. } => {}
        }
        player.sync_shield();
        player.dirty = true;
        let _ = player.tx.send(S2C::InventoryUpdate(player.inventory.clone()));
    }

    /// One stash UI action: deposit a backpack slot into the stash, or pull
    /// a stash slot back into the backpack — through the shared extraction
    /// leg (`stash_settle`: Storage terminal party + Extract ledger legs).
    /// Slot-preserving: whatever doesn't fit the destination stays in the
    /// clicked slot, exactly as before.
    fn player_stash_action(&mut self, entity: EntityId, slot: u16, deposit: bool) {
        let actor = EconActor::Player(entity);
        let Some(storage) = self.near_storage(actor) else {
            if let Some(player) = self.players.get(&entity) {
                let _ = player.tx.send(S2C::Error { message: "no stash terminal nearby".into() });
            }
            return;
        };
        let Some(player) = self.players.get_mut(&entity) else { return };
        let source = if deposit {
            player.inventory.slots.get_mut(slot as usize)
        } else {
            player.stash.slots.get_mut(slot as usize)
        };
        if let Some(stack) = source.and_then(|s| s.take()) {
            let leftover = self.stash_settle(actor, storage, stack.kind, stack.count, deposit);
            if leftover > 0 {
                let Some(player) = self.players.get_mut(&entity) else { return };
                let slots =
                    if deposit { &mut player.inventory.slots } else { &mut player.stash.slots };
                slots[slot as usize] = Some(ItemStack { kind: stack.kind, count: leftover });
            }
        }
        let Some(player) = self.players.get_mut(&entity) else { return };
        player.sync_shield();
        player.dirty = true;
        let _ = player.tx.send(S2C::StashUpdate { slots: player.stash.slots.clone() });
        let _ = player.tx.send(S2C::InventoryUpdate(player.inventory.clone()));
    }

    // -----------------------------------------------------------------------
    // Tick systems
    // -----------------------------------------------------------------------

    fn step(&mut self) {
        self.tick += 1;
        self.ledger.set_tick(self.tick);
        let step_start = Instant::now();

        self.timed(TickPhase::Movement, |w| w.apply_movement());
        self.timed(TickPhase::Agents, |w| w.tick_agents());
        self.timed(TickPhase::Separation, |w| w.separate_characters());
        self.timed(TickPhase::Loot, |w| w.tick_loot());
        // Nodes have no per-tick phase: cooldown/respawn are lazy timestamps
        // evaluated on access (gather, targeting, replication).
        self.timed(TickPhase::Production, |w| w.tick_production());
        self.timed(TickPhase::Territory, |w| w.tick_territory());
        self.timed(TickPhase::Regen, |w| w.tick_regen());
        self.timed(TickPhase::Interest, |w| w.update_interest());
        self.timed(TickPhase::Replicate, |w| w.replicate());
        self.timed(TickPhase::Economy, |w| w.flush_economy());
        self.timed(TickPhase::Broadcasts, |w| {
            // Leaderboards refresh for dashboard subscribers every ~5 s.
            if w.tick % LEADERBOARD_TICK_INTERVAL == 0 {
                w.broadcast_leaderboard();
            }
            // Whole-map intel for open maps, ~5 Hz.
            if w.tick % MAP_INTEL_TICK_INTERVAL == 0 {
                w.broadcast_map_intel();
            }
            // Far-agent dot LOD feed for the live map, ~5 Hz (always on).
            if w.tick % MAP_INTEL_TICK_INTERVAL == 0 {
                w.broadcast_agent_dots();
            }
            // Unsold agent asks decay toward their floor every ~15 s.
            if w.tick % MARKET_DECAY_TICKS == 0 {
                w.tick_market_decay();
            }
            // Item market drill-in: re-push watched kinds that traded, ~1 Hz.
            if w.tick % ITEM_MARKET_TICK_INTERVAL == 0 {
                w.broadcast_item_markets();
            }
            // Owned-agent roster (~2 s) and drill-in detail (~1 Hz).
            if w.tick % AGENT_ROSTER_TICK_INTERVAL == 0 {
                w.broadcast_agent_rosters();
            }
            if w.tick % AGENT_DETAIL_TICK_INTERVAL == 0 {
                w.broadcast_agent_details();
            }
        });

        // Clear per-tick attack flags only after replicate so the Attack anim
        // state actually reaches other clients (attacks are processed on
        // message receipt, before this tick's movement pass).
        for player in self.players.values_mut() {
            player.attacked_this_tick = false;
        }

        if self.tick % SAVE_INTERVAL_TICKS == 0 {
            self.timed(TickPhase::Save, |w| w.save_all());
        }
        // Agent persistence rotates one bounded shard at a time on its own
        // stride (the early return is a couple of integer ops on off-ticks).
        self.timed(TickPhase::Save, |w| w.tick_agent_saves());

        // Disk-pressure guard: reclaim space by purging stale guest data once
        // the store crosses the high-water mark (~1/min, off-ticks are free).
        if self.tick % PURGE_CHECK_TICKS == 0 {
            self.timed(TickPhase::Save, |w| w.tick_disk_guard());
        }

        self.timings.finish_tick(step_start.elapsed());
    }

    fn apply_movement(&mut self) {
        for player in self.players.values_mut() {
            player.moved_this_tick = false;
            player.ran_this_tick = false;
            player.attack_cooldown = (player.attack_cooldown - TICK_DT).max(0.0);
            player.spawn_protection = (player.spawn_protection - TICK_DT).max(0.0);
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

    /// Post-movement crowd separation: embodied characters (hot agents) are
    /// soft discs that push out of each other and out of player
    /// discs, so melee piles no longer interpenetrate. Players are never
    /// moved — client prediction owns their position and a server-side shove
    /// would fight reconciliation — and every push respects world collision.
    ///
    /// Several relaxation iterations per tick: steering re-converges agents
    /// that share a destination at up to one movement step per tick, so a
    /// single half-overlap push (capped at the same step) can only ever fight
    /// it to a draw — doorway queues then fester at half-body overlap.
    /// Iterating until separation outruns re-convergence lets piles unwind;
    /// the loop exits early once nobody moved.
    fn separate_characters(&mut self) {
        /// Two character discs touch at twice the shared body radius.
        const MIN_SEP: f32 = PLAYER_RADIUS * 2.0;
        /// Fraction of the remaining overlap resolved per iteration. Softness
        /// spreads the resolution over a few ticks so packed crowds relax
        /// smoothly instead of jittering.
        const RELAX: f32 = 0.5;
        /// A body never gets shoved faster than it can run (per iteration).
        const MAX_PUSH: f32 = agents::AGENT_SPEED * TICK_DT;
        const ITERATIONS: usize = 4;

        enum Body {
            Agent(usize),
            Player,
        }

        let mut bodies: Vec<(Body, Vec3)> = Vec::new();
        // Hot agents only — the maintained hot list keeps this from
        // scanning the whole population every tick.
        for &i in &self.hot_agents {
            let a = &self.agents[i as usize];
            if a.tier == Tier::Hot && a.alive() {
                bodies.push((Body::Agent(i as usize), a.position));
            }
        }
        for p in self.players.values() {
            if p.character.health > 0.0 {
                bodies.push((Body::Player, p.character.position));
            }
        }
        if bodies.len() < 2 {
            return;
        }

        // Fine spatial hash: cell = MIN_SEP, so any overlapping pair sits in
        // the same or an adjacent cell. Built once; positions only move a
        // fraction of a cell per iteration, so the 3x3 scan still sees every
        // candidate pair on the second pass.
        let cell =
            |p: &Vec3| ((p.x / MIN_SEP).floor() as i32, (p.z / MIN_SEP).floor() as i32);
        let mut grid: HashMap<(i32, i32), SmallVec<[u32; 4]>> =
            HashMap::with_capacity(bodies.len());
        for (i, (_, pos)) in bodies.iter().enumerate() {
            grid.entry(cell(pos)).or_default().push(i as u32);
        }

        let mut pushes = vec![(0.0f32, 0.0f32); bodies.len()];
        let mut moved = false;
        for iteration in 0..ITERATIONS {
            if iteration > 0 && !moved {
                break; // fully separated (or fully wedged) after one pass
            }
            for p in pushes.iter_mut() {
                *p = (0.0, 0.0);
            }
            for (i, (kind_i, pos_i)) in bodies.iter().enumerate() {
                let movable_i = !matches!(kind_i, Body::Player);
                let (cx, cz) = cell(pos_i);
                for dz in -1..=1 {
                    for dx in -1..=1 {
                        let Some(bucket) = grid.get(&(cx + dx, cz + dz)) else { continue };
                        for &j in bucket {
                            let j = j as usize;
                            if j <= i {
                                continue; // each pair once
                            }
                            let (kind_j, pos_j) = &bodies[j];
                            let movable_j = !matches!(kind_j, Body::Player);
                            if !movable_i && !movable_j {
                                continue;
                            }
                            let dxw = pos_j.x - pos_i.x;
                            let dzw = pos_j.z - pos_i.z;
                            let d2 = dxw * dxw + dzw * dzw;
                            if d2 >= MIN_SEP * MIN_SEP {
                                continue;
                            }
                            let d = d2.sqrt();
                            // Coincident centers: derive a stable push axis
                            // from the pair indices so the bodies part ways.
                            let (nx, nz) = if d > 1e-4 {
                                (dxw / d, dzw / d)
                            } else {
                                let a = (i * 31 + j * 17) as f32;
                                (a.cos(), a.sin())
                            };
                            let overlap = (MIN_SEP - d) * RELAX;
                            // Immovable neighbors (players) transfer their share.
                            let (wi, wj) = match (movable_i, movable_j) {
                                (true, true) => (0.5, 0.5),
                                (true, false) => (1.0, 0.0),
                                _ => (0.0, 1.0),
                            };
                            pushes[i].0 -= nx * overlap * wi;
                            pushes[i].1 -= nz * overlap * wi;
                            pushes[j].0 += nx * overlap * wj;
                            pushes[j].1 += nz * overlap * wj;
                        }
                    }
                }
            }

            moved = false;
            for (idx, (_, pos)) in bodies.iter_mut().enumerate() {
                let (mut px, mut pz) = pushes[idx];
                let len2 = px * px + pz * pz;
                if len2 < 1e-8 {
                    continue;
                }
                let len = len2.sqrt();
                if len > MAX_PUSH {
                    px *= MAX_PUSH / len;
                    pz *= MAX_PUSH / len;
                }
                let next = nudge(&self.chunks, *pos, px, pz);
                if (next - *pos).length_squared() > 1e-10 {
                    *pos = next;
                    moved = true;
                }
            }
        }

        for (body, pos) in bodies {
            match body {
                Body::Agent(i) => {
                    if (self.agents[i].position - pos).length_squared() > 1e-10 {
                        self.agents[i].position = pos;
                        self.regrid_agent(i);
                    }
                }
                Body::Player => {}
            }
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
            .players
            .get(&killer)
            .map(|p| p.character.name.clone())
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
        // Carried currency is at-risk too: MILD, Shards and Energy (only the
        // banked portion is safe). The ledger burns the FULL carried purse
        // here; half of each balance then drops as currency pickups, which
        // re-mint on collection (see `collect_currency_pickup`). Net supply
        // stays coherent: -carried at death, +spill on pickup, with the
        // burned half (and any expired pickups) permanently out of supply.
        let account = player.character.account_id;
        let burned = player.purse.burn_carried_on_death();
        let lost_wallet = burned[Currency::Wild.index()];
        let lost_shards = burned[Currency::Shards.index()];
        let lost_energy = burned[Currency::Energy.index()];
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
        if lost_wallet > 0 {
            self.ledger.record(
                TxKind::Burn,
                victim.clone(),
                TxParty::Burn,
                TxAmount::Wild { amount: lost_wallet },
                0,
            );
            let _ = self.store.update_wallet(account, 0);
        }
        if lost_shards > 0 {
            self.ledger.record(
                TxKind::Burn,
                victim.clone(),
                TxParty::Burn,
                TxAmount::Shards { amount: lost_shards },
                0,
            );
        }
        if lost_energy > 0 {
            self.ledger.record(
                TxKind::Burn,
                victim.clone(),
                TxParty::Burn,
                TxAmount::Energy { amount: lost_energy },
                0,
            );
        }
        if lost_shards > 0 || lost_energy > 0 {
            let _ = self.store.update_currencies(account, 0, 0);
        }
        self.ledger.deaths += 1;
        // Equipped gear survives (jacket stays on your back).
        player.path.clear();
        player.character.health = player.character.max_health;
        player.character.shield = player.character.max_shield;
        player.character.position = SPAWN;
        player.spawn_protection = SPAWN_PROTECT_SECONDS;
        player.dirty = true;
        let lost = !dropped.is_empty();
        let _ = player.tx.send(S2C::Died { by: killer_name, lost_items: lost });
        let _ = player.tx.send(S2C::InventoryUpdate(player.inventory.clone()));
        let entity = player.entity;
        self.broadcast_combat(CombatEvent::EntityDied { id: entity });
        self.spawn_loot(drop_pos, dropped, Some(victim), false);
        // Half of each carried balance spills at the body (see burn comment).
        for currency in Currency::ALL {
            self.spawn_currency_pickup(drop_pos, currency, burned[currency.index()] / 2);
        }
        self.persist_player_entity(target);
    }

    // -----------------------------------------------------------------------
    // Generalized combat: any attacker -> any victim, danger/hostility gated
    // -----------------------------------------------------------------------

    /// Current position of any combat-capable entity (player/agent).
    fn entity_position(&self, id: EntityId) -> Option<Vec3> {
        if let Some(p) = self.players.get(&id) {
            return Some(p.character.position);
        }
        self.agent_by_entity.get(&id).map(|&i| self.agents[i].position)
    }

    /// (position, faction, alive) of a combat-capable entity.
    fn combatant(&self, id: EntityId) -> Option<(Vec3, FactionId, bool)> {
        if let Some(p) = self.players.get(&id) {
            return Some((p.character.position, p.character.faction, p.character.health > 0.0));
        }
        self.agent_by_entity
            .get(&id)
            .map(|&i| &self.agents[i])
            .map(|a| (a.position, a.faction, a.alive()))
    }

    /// Whether the actor behind `id` is inside its post-respawn grace window
    /// (takes no damage AND deals none while the timer runs).
    fn spawn_protected(&self, id: EntityId) -> bool {
        if let Some(p) = self.players.get(&id) {
            return p.spawn_protection > 0.0;
        }
        self.agent_by_entity
            .get(&id)
            .is_some_and(|&i| self.agents[i].spawn_protection > 0.0)
    }

    /// Whether `pos` sits inside any Safehouse's protective bubble.
    fn in_safehouse_bubble(&self, pos: Vec3) -> bool {
        self.services_by_kind
            .get(&EntityKind::Safehouse)
            .is_some_and(|v| v.iter().any(|&(_, p)| (p - pos).length() < SAFEHOUSE_RADIUS))
    }

    /// Whether `attacker` may damage `target` right now. Everyone is fair
    /// game everywhere — hostility is the faction matrix (all three factions
    /// mutually hostile, same-faction never) — except in safe zones:
    /// Sanctuary ground and safehouse bubbles block all damage, and a
    /// spawn-protected (just-respawned) actor neither takes nor deals any.
    fn damage_allowed(&self, attacker: EntityId, target: EntityId) -> bool {
        let Some((attacker_pos, attacker_faction, attacker_alive)) = self.combatant(attacker)
        else {
            return false;
        };
        let Some((victim_pos, victim_faction, victim_alive)) = self.combatant(target) else {
            return false;
        };
        if !attacker_alive || !victim_alive {
            return false;
        }
        if self.spawn_protected(attacker) || self.spawn_protected(target) {
            return false;
        }
        if districts::danger_at(victim_pos) == DangerLevel::Sanctuary {
            return false;
        }
        if self.in_safehouse_bubble(victim_pos) || self.in_safehouse_bubble(attacker_pos) {
            return false;
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
        let impact = impact
            .or_else(|| self.entity_position(target).map(|p| Vec3::new(p.x, 1.25, p.z)))
            .unwrap_or_default();
        if self.players.contains_key(&target) {
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
            // A winning fight is the Fight activity's payoff: bounty plus a
            // share of what the victim was carrying (the killer's side can
            // now loot it / hold the ground it defended).
            let spoils = self.agents[idx].wallet() + self.agents[idx].carried_value();
            if let Some(&killer_idx) = self.agent_by_entity.get(&attacker) {
                self.agents[killer_idx]
                    .learn(Activity::Fight, 25.0 + (spoils as f32) * 0.3);
                if self.agents[killer_idx].owner.is_some() {
                    let victim = self.agents[idx].name.clone();
                    let aid = self.agents[killer_idx].agent_id;
                    self.push_agent_log(aid, format!("Killed {victim}"));
                }
            }
            // Hot-tier death: a real body drops real loot.
            self.kill_agent(idx, true);
            if self.players.contains_key(&attacker) {
                self.grant_xp(attacker, XP_RAIDER_KILL);
                self.ledger.npc_kills += 1;
            }
        }
    }

    /// Kill an agent. Hot deaths (`drop_loot`) leave a loot container and a
    /// currency spill where the body fell; cold statistical deaths (no body)
    /// burn the carried goods outright. Either way every carried currency
    /// burns on the ledger (banked balances survive, like players); with a
    /// body, half of each balance then drops as pickups that re-mint on
    /// collection, so net supply stays coherent (-carried at death, +spill
    /// on pickup, the rest permanently burned). A fresh identity respawns at
    /// the faction's home (Guarded district, or the Wape's scattered anchor)
    /// after the timer. Equipped gear stays on the identity, exactly like a
    /// player's jacket staying on their back.
    fn kill_agent(&mut self, idx: usize, drop_loot: bool) {
        if self.agents[idx].owner.is_some() {
            let aid = self.agents[idx].agent_id;
            self.push_agent_log(
                aid,
                "Died in the field — carried MILD and cargo lost".to_string(),
            );
        }
        let (entity, position, items, burned, party, agent_id) = {
            let agent = &mut self.agents[idx];
            agent.health = 0.0;
            agent.anim = AnimState::Death;
            agent.respawn_in = AGENT_RESPAWN_SECONDS;
            // Dying is the loss signal: charge everything on the body to the
            // activity that got the agent killed, so risky lines of work
            // learn their true (risk-adjusted) return.
            let lost = agent.wallet() + agent.carried_value();
            agent.learn(activity_of(agent.goal), -(lost as f32));
            agent.goal = Goal::Idle;
            agent.path.clear();
            agent.path_request = None;
            agent.pending_jobs.clear();
            let items: Vec<ItemStack> =
                agent.inventory.slots.iter_mut().filter_map(|s| s.take()).collect();
            let burned = agent.purse.burn_carried_on_death();
            (agent.entity, agent.position, items, burned, agent.party(), agent.agent_id)
        };
        // The dying identity's production dies with it: queued batches drop
        // (their inputs/Energy burned at queue time — same at-risk rule as
        // carried goods) and uncollected buffers burn out of supply.
        self.purge_owner_production(OwnerId::Agent(agent_id), party.clone());
        // Field intel: a body dropped here (danger signal).
        *self.region_casualties.entry(region_of(position)).or_insert(0) += 1;
        // Dead: out of the spatial grid, onto the respawn list.
        self.regrid_agent(idx);
        if !self.dead_agents.contains(&(idx as u32)) {
            self.dead_agents.push(idx as u32);
        }
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
        for currency in Currency::ALL {
            let amount = burned[currency.index()];
            if amount > 0 {
                self.ledger.record(
                    TxKind::Burn,
                    party.clone(),
                    TxParty::Burn,
                    currency.tx_amount(amount),
                    0,
                );
            }
        }
        if drop_loot {
            self.broadcast_combat(CombatEvent::EntityDied { id: entity });
            self.spawn_loot_scattered(position, items, Some(party), false);
            // Half of each carried balance spills at the body (see above).
            for currency in Currency::ALL {
                self.spawn_currency_pickup(position, currency, burned[currency.index()] / 2);
            }
        }
    }

    // -----------------------------------------------------------------------
    // Autonomous faction agents
    // -----------------------------------------------------------------------

    /// Keep `agent_grid` in sync with one agent's position/liveness. Call
    /// after anything that moves, kills, revives or spawns an agent: the
    /// bucket entry moves only when the occupied chunk actually changed, so
    /// the grid never needs a whole-population rebuild.
    fn regrid_agent(&mut self, idx: usize) {
        let agent = &self.agents[idx];
        let new_chunk = if agent.alive() { Some(agent.chunk()) } else { None };
        if agent.grid_chunk == new_chunk {
            return;
        }
        if let Some(old) = self.agents[idx].grid_chunk {
            if let Some(bucket) = self.agent_grid.get_mut(&old) {
                if let Some(pos) = bucket.iter().position(|&i| i == idx as u32) {
                    bucket.swap_remove(pos);
                }
            }
        }
        if let Some(chunk) = new_chunk {
            self.agent_grid.entry(chunk).or_default().push(idx as u32);
        }
        self.agents[idx].grid_chunk = new_chunk;
    }

    fn tick_agents(&mut self) {
        // Hot/cold classification: every chunk within HOT_RADIUS of any
        // connected player is hot ground. Iterate players, not agents.
        // Hysteresis: an already-hot agent stays hot one ring further out
        // (the exit set), so agents loitering at the boundary don't flap
        // between tiers — every flap is a full entity spawn/despawn on the
        // wire and a rig remount on every client.
        let mut hot_chunks: HashSet<ChunkCoord> = HashSet::new();
        let mut hot_exit_chunks: HashSet<ChunkCoord> = HashSet::new();
        for p in self.players.values() {
            let c = ChunkCoord::from_world(p.character.position);
            for dz in -(HOT_RADIUS_CHUNKS + 1)..=(HOT_RADIUS_CHUNKS + 1) {
                for dx in -(HOT_RADIUS_CHUNKS + 1)..=(HOT_RADIUS_CHUNKS + 1) {
                    let coord = ChunkCoord::new(c.x + dx, c.z + dz);
                    hot_exit_chunks.insert(coord);
                    if dx.abs() <= HOT_RADIUS_CHUNKS && dz.abs() <= HOT_RADIUS_CHUNKS {
                        hot_chunks.insert(coord);
                    }
                }
            }
        }

        // Player-driven tier classification: sweep the previous hot set for
        // demotions (left the exit zone, died) and promote cold agents found
        // in the grid buckets of hot chunks. Work scales with players and
        // hot agents, never the whole population.
        let mut next_hot: Vec<u32> = Vec::with_capacity(self.hot_agents.len() + 64);
        for i in std::mem::take(&mut self.hot_agents) {
            let agent = &mut self.agents[i as usize];
            if agent.alive() && hot_exit_chunks.contains(&agent.chunk()) {
                next_hot.push(i);
            } else {
                agent.tier = Tier::Cold;
            }
        }
        for coord in &hot_chunks {
            let Some(bucket) = self.agent_grid.get(coord) else { continue };
            for &i in bucket {
                let agent = &mut self.agents[i as usize];
                if agent.alive() && agent.tier == Tier::Cold {
                    agent.tier = Tier::Hot;
                    next_hot.push(i);
                }
            }
        }
        self.hot_agents = next_hot;

        // Respawns: dead agents come back as a fresh identity at their
        // faction's Guarded home district. Only the dead list is walked.
        let mut di = 0;
        while di < self.dead_agents.len() {
            let idx = self.dead_agents[di] as usize;
            // Revived outside this sweep (tests drive respawn_agent
            // directly): just drop the stale entry.
            if self.agents[idx].alive() {
                self.dead_agents.swap_remove(di);
                continue;
            }
            self.agents[idx].respawn_in -= TICK_DT;
            if self.agents[idx].respawn_in <= 0.0 {
                self.respawn_agent(idx);
                self.dead_agents.swap_remove(di);
            } else {
                di += 1;
            }
        }

        // Simulation slices: hot agents every tick at TICK_DT, cold agents
        // from the bucket wheel. Iterate the hot list plus this tick's cold
        // bucket stride — not every agent every tick. The wheel scales with
        // population: at most COLD_TICK_BUDGET cold agents per tick, so a
        // 10-100x population pays with slice cadence (1 s at small counts,
        // a few seconds at 50k) instead of per-tick CPU. Slice dt grows to
        // match, so per-agent sim-time stays honest at any wheel size.
        let cold_buckets =
            COLD_BUCKETS.max((self.agents.len() as u64).div_ceil(COLD_TICK_BUDGET));
        let cold_bucket = self.tick % cold_buckets;
        let mut events: Vec<(usize, AgentEvent)> = Vec::new();
        let hot_now = self.hot_agents.clone();
        for i in hot_now {
            self.tick_one_agent(i as usize, true, TICK_DT, &mut events);
        }
        let mut idx = cold_bucket as usize;
        while idx < self.agents.len() {
            // Hot agents in this stride already ticked from the hot list.
            if self.agents[idx].tier == Tier::Cold {
                self.tick_one_agent(idx, false, cold_buckets as f32 * TICK_DT, &mut events);
            }
            idx += cold_buckets as usize;
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
        // Congestion counts: the full recount is O(population), so it runs
        // once a second instead of every tick. `decide_agent` keeps the
        // counter live as agents re-choose in between; goals dropped outside
        // the decision path (deaths, boxed-in bailouts) leak into the counts
        // for at most a second before the next recount absorbs them.
        if self.tick % SERVICE_LOAD_RECOUNT_INTERVAL == 0 {
            self.rebuild_service_load();
        }
        // Drain the decision queue under a per-tick budget. Re-scores burst
        // (a freshly seeded world, a whole cold bucket finishing goals at
        // once); the queue spreads that spike over a few ticks instead of
        // stalling one.
        const DECISION_BUDGET: usize = 256;
        let n = self.agent_decision_queue.len().min(DECISION_BUDGET);
        for _ in 0..n {
            let idx = self.agent_decision_queue.pop_front().unwrap() as usize;
            self.agents[idx].decision_queued = false;
            if self.agents[idx].alive() {
                self.decide_agent(idx);
            }
        }

        self.serve_agent_paths();

        // Statistical cold-war resolution, once per territory tick.
        if self.tick % TERRITORY_TICK_INTERVAL == 0 {
            self.tick_cold_combat(&hot_chunks);
        }
    }

    /// One agent's simulation slice: goal upkeep, the behavior tick itself,
    /// path-queue bookkeeping and grid maintenance. Shared by the hot list
    /// (every tick) and the cold bucket wheel.
    fn tick_one_agent(
        &mut self,
        idx: usize,
        hot: bool,
        dt: f32,
        events: &mut Vec<(usize, AgentEvent)>,
    ) {
        if !self.agents[idx].alive() {
            return;
        }
        // Drop stale loot goals: someone else grabbed the container (or
        // it expired) while the agent was still walking over.
        if let Goal::Loot { container, .. } = self.agents[idx].goal {
            if !self.loot.contains_key(&container) {
                self.agents[idx].goal = Goal::Idle;
            }
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
        // The tick moved the agent; keep the spatial grid current.
        self.regrid_agent(idx);
        // Queue any path request the tick raised (hot agents only; cold
        // macro movement never needs collision-accurate paths).
        if self.agents[idx].path_request.is_some() && !self.agents[idx].path_queued {
            self.agents[idx].path_queued = true;
            self.agent_path_queue.push_back(idx);
        }
        match event {
            AgentEvent::None => {}
            AgentEvent::NeedsGoal => {
                // Queue for a budgeted re-score (once; the flag clears when
                // the queue serves it). Until then the agent keeps running
                // its current goal.
                if !self.agents[idx].decision_queued {
                    self.agents[idx].decision_queued = true;
                    self.agent_decision_queue.push_back(idx as u32);
                }
            }
            AgentEvent::Act => events.push((idx, event)),
            AgentEvent::Attack { .. } => events.push((idx, event)),
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

    /// Cold-tier statistical combat: in regions where two or more factions'
    /// (non-replicated) agents co-occupy contested ground with no player
    /// nearby, resolve casualties with strength-weighted rolls. All three
    /// factions are mutually hostile, so each side rolls against the
    /// combined strength of everyone else present.
    fn tick_cold_combat(&mut self, hot_chunks: &HashSet<ChunkCoord>) {
        use rand::Rng;
        // Bucket cold agents by territory region, walking the maintained
        // spatial grid (living agents grouped by chunk, region derived once
        // per bucket) instead of enumerating the whole population.
        let mut regions: HashMap<(i32, i32), [Vec<usize>; 3]> = HashMap::new();
        for (chunk, grid_bucket) in &self.agent_grid {
            if grid_bucket.is_empty() {
                continue;
            }
            let region = (chunk.x.div_euclid(REGION_CHUNKS), chunk.z.div_euclid(REGION_CHUNKS));
            for &i in grid_bucket {
                let agent = &self.agents[i as usize];
                if !agent.alive() || agent.tier == Tier::Hot {
                    continue;
                }
                match districts::danger_at(agent.position) {
                    DangerLevel::Contested | DangerLevel::Warzone => {}
                    _ => continue, // no cold war on safe ground
                }
                let bucket = regions.entry(region).or_default();
                match agent.faction {
                    FACTION_REBELS => bucket[0].push(i as usize),
                    FACTION_FORUM => bucket[1].push(i as usize),
                    FACTION_WAPES => bucket[2].push(i as usize),
                    _ => {}
                }
            }
        }
        let mut casualties: Vec<(usize, usize)> = Vec::new();
        for (_, sides) in regions {
            if sides.iter().filter(|s| !s.is_empty()).count() < 2 {
                continue;
            }
            // Skip regions with any player-adjacent (hot) chunk: embodied
            // combat owns those.
            let any_hot = sides
                .iter()
                .flatten()
                .any(|&i| hot_chunks.contains(&self.agents[i].chunk()));
            if any_hot {
                continue;
            }
            let strengths: Vec<f32> = sides
                .iter()
                .map(|side| {
                    side.iter().map(|&i| self.agents[i].strength()).sum::<f32>().max(1.0)
                })
                .collect();
            // Each side risks one casualty per resolution, weighted by how
            // outgunned it is (capped so skirmishes stay slow burns). The
            // kill is credited to a random fighter among everyone else.
            for s in 0..sides.len() {
                if sides[s].is_empty() {
                    continue;
                }
                let enemies: Vec<usize> = sides
                    .iter()
                    .enumerate()
                    .filter(|&(e, _)| e != s)
                    .flat_map(|(_, side)| side.iter().copied())
                    .collect();
                if enemies.is_empty() {
                    continue;
                }
                let own = strengths[s];
                let enemy: f32 = strengths
                    .iter()
                    .enumerate()
                    .filter(|&(e, _)| e != s && !sides[e].is_empty())
                    .map(|(_, &st)| st)
                    .sum();
                let p = (enemy / (own + enemy) * 0.25).min(0.2) as f64;
                if self.rng.random_bool(p) {
                    let victim = sides[s][self.rng.random_range(0..sides[s].len())];
                    let killer = enemies[self.rng.random_range(0..enemies.len())];
                    casualties.push((victim, killer));
                }
            }
        }
        for (idx, killer) in casualties {
            if self.agents[idx].alive() {
                let killer_actor = self.agent_actor_ref(killer);
                let victim_actor = self.agent_actor_ref(idx);
                self.stats.record_kill(
                    self.agents[killer].alive().then_some(&killer_actor),
                    &victim_actor,
                );
                // Statistical wins teach Fight the same way embodied ones do.
                let spoils = self.agents[idx].wallet() + self.agents[idx].carried_value();
                if self.agents[killer].alive() {
                    self.agents[killer].learn(Activity::Fight, 25.0 + (spoils as f32) * 0.3);
                    if self.agents[killer].owner.is_some() {
                        let victim = self.agents[idx].name.clone();
                        let aid = self.agents[killer].agent_id;
                        self.push_agent_log(aid, format!("Killed {victim}"));
                    }
                }
                self.kill_agent(idx, false);
            }
        }
    }

    fn respawn_agent(&mut self, idx: usize) {
        let faction = self.agents[idx].faction;
        // Anchored agents (hub cohorts, scattered Wapes) respawn at their
        // staging ground so the war over the starter playfield never drains
        // away; everyone else returns to the faction's home district.
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
        let old_agent_id = self.agents[idx].agent_id;
        // The dead identity leaves the boards; its faction/guild legacy stays
        // — and so do its learned traits (death already charged the fatal
        // activity in kill_agent), so agents grow and evolve across lives.
        self.stats.retire(old_agent_id);
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
            // Fresh spawns get a short grace window (no damage in or out).
            agent.spawn_protection = SPAWN_PROTECT_SECONDS;
        }
        self.agent_by_entity.remove(&old_entity);
        self.agent_by_entity.insert(entity, idx);
        // Owned agents carry their activity log across lives, re-keyed to
        // the fresh identity (ownership itself lives on the slot and was
        // never cleared).
        if self.agents[idx].owner.is_some() {
            let mut log = self.agent_logs.remove(&old_agent_id).unwrap_or_default();
            if log.len() >= AGENT_LOG_CAP {
                log.pop_front();
            }
            let name = self.agents[idx].name.clone();
            log.push_back(AgentLogEntry {
                at_ms: ledger::unix_ms(),
                text: format!("Respawned as {name}"),
            });
            self.agent_logs.insert(agent_id, log);
        }
        // Alive again at the staging ground: back into the spatial grid.
        self.regrid_agent(idx);
        // Fresh identities start with a modest grubstake and a kit that
        // follows the learned disposition.
        self.grubstake_agent(idx);
    }

    /// Mint a starting wallet + kit to an agent (seed or respawn). The kit
    /// follows the agent's learned disposition: proven fighters come back
    /// armed, proven crafters come back with inputs.
    fn grubstake_agent(&mut self, idx: usize) {
        use rand::Rng;
        let wallet = self.rng.random_range(40..120u32);
        let traits = self.agents[idx].traits;
        let kit: &[(ItemKind, u32)] = if traits.leans(Activity::Fight)
            || traits.leans(Activity::Capture)
        {
            &[(ItemKind::Pipe, 1), (ItemKind::Medkit, 1)]
        } else if traits.leans(Activity::Craft) {
            &[(ItemKind::Iron, 8), (ItemKind::Copper, 6)]
        } else {
            &[]
        };
        let party = self.agents[idx].party();
        self.agents[idx].purse.credit(Currency::Wild, wallet);
        self.ledger.record(
            TxKind::Mint,
            TxParty::Mint,
            party.clone(),
            TxAmount::Wild { amount: wallet },
            0,
        );
        for &(kind, count) in kit {
            // Death-safe stash first: a respawned identity re-kits from its
            // own vault before the world mints anything (mirrors the bank
            // comeback withdraw below). The draw is a remote respawn perk,
            // not a Storage visit, so the Extract leg is a self-transfer.
            let drawn = {
                let agent = &mut self.agents[idx];
                let got = inv::remove_items(&mut agent.stash, kind, count);
                // The grubstake kit always fits: it lands in a freshly
                // drained (or freshly seeded) backpack far below the
                // volume budget.
                agent.add_item(kind, got);
                got
            };
            if drawn > 0 {
                self.ledger.record(
                    TxKind::Extract,
                    party.clone(),
                    party.clone(),
                    TxAmount::Item { kind, count: drawn },
                    0,
                );
                self.ledger.items_withdrawn += drawn as u64;
            }
            let mint = count - drawn;
            if mint == 0 {
                continue;
            }
            self.agents[idx].add_item(kind, mint);
            self.ledger.record(
                TxKind::Mint,
                TxParty::Mint,
                party.clone(),
                TxAmount::Item { kind, count: mint },
                0,
            );
        }
        // Crafters get a few Energy cells so the queue fuel (Phase 3) exists
        // before their first pickup/cache tap; the rest earn it in the field.
        if traits.leans(Activity::Craft) {
            self.grant_currency_actor(EconActor::Agent(idx), Currency::Energy, 5);
        }
        // Wapes carry street Cash scaled to their home turf's zone (the drop
        // tables the retired wild NPCs used), so killing Wapes still feeds
        // the Cash -> Bank conversion loop.
        if self.agents[idx].faction == FACTION_WAPES {
            let anchor = self.agents[idx].home_spot.unwrap_or(self.agents[idx].position);
            let zone = zone_of_chunk(ChunkCoord::from_world(anchor));
            let raider_like = traits.leans(Activity::Fight);
            let cash = wape_grubstake_cash(&mut self.rng, zone, raider_like);
            self.agents[idx].add_item(ItemKind::Cash, cash);
            self.ledger.record(
                TxKind::Mint,
                TxParty::Mint,
                party.clone(),
                TxAmount::Item { kind: ItemKind::Cash, count: cash },
                0,
            );
        }
        self.agents[idx].equip_best_gear();
        // Accumulated savings survive death: pull a comeback stake from the
        // vault into the fresh wallet so a proven earner returns funded rather
        // than broke. Whatever stays banked keeps riding along, still safe.
        // Internal move (agent-held either way), so no mint/burn is recorded.
        self.agents[idx].purse.withdraw(Currency::Wild, agents::AGENT_COMEBACK_WITHDRAW);
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

    /// Add a seeded static entity, keeping the by-kind service table in sync
    /// (the routing helpers below walk one kind's bucket, never the whole
    /// statics map). Statics never move or despawn, so insert is the only
    /// maintenance point.
    fn register_static(&mut self, s: StaticEntity) {
        self.services_by_kind.entry(s.kind).or_default().push((s.entity, s.position));
        self.statics.insert(s.entity, s);
    }

    /// Nearest seeded service of `kind` to `pos`.
    fn nearest_service(&self, pos: Vec3, kind: EntityKind) -> Option<(EntityId, Vec3)> {
        self.services_by_kind
            .get(&kind)
            .into_iter()
            .flatten()
            .min_by(|a, b| {
                let da = (a.1 - pos).length_squared();
                let db = (b.1 - pos).length_squared();
                da.partial_cmp(&db).unwrap_or(std::cmp::Ordering::Equal)
            })
            .copied()
    }

    /// Congestion-aware routing: choose a service of `kind` by trading off
    /// travel distance against how crowded it already is, and return an
    /// **appeal** factor in `(0, 1]` for the caller to scale the errand's
    /// utility by. A near, empty storefront scores ~1; a packed or distant one
    /// scores low, so the whole errand can lose to gathering/crafting when
    /// every sink is jammed. `self`'s own commitment must already be removed
    /// from `service_load` (see `decide_agent`) so it doesn't count itself.
    fn route_service(&self, pos: Vec3, kind: EntityKind) -> Option<(EntityId, Vec3, f32)> {
        let mut best: Option<(EntityId, Vec3, f32)> = None;
        for &(entity, position) in self.services_by_kind.get(&kind).into_iter().flatten() {
            let dist = (position - pos).length();
            let dist_factor = 1.0 / (1.0 + dist / SERVICE_TRAVEL_HALF);
            let occ = self.service_load.get(&entity).copied().unwrap_or(0) as f32;
            let crowd_factor = SERVICE_CAPACITY / (SERVICE_CAPACITY + occ);
            let appeal = dist_factor * crowd_factor;
            if best.map(|(_, _, a)| appeal > a).unwrap_or(true) {
                best = Some((entity, position, appeal));
            }
        }
        best
    }

    /// Nearest workable resource node around `pos`: materializes node state
    /// for the surrounding chunks (a set-membership check per chunk once
    /// seeded, so the decision hot path stays cheap), then picks the closest
    /// active node that isn't already claimed by `NODE_CLAIM_CAP` gatherers
    /// (claims ride the same congestion map storefronts use).
    fn best_gather_node(&mut self, pos: Vec3) -> Option<(EntityId, Vec3)> {
        let center = ChunkCoord::from_world(pos);
        let now = self.world_seconds();
        let tuning = self.node_tuning;
        let mut best: Option<(EntityId, Vec3, f32)> = None;
        for dz in -NODE_SEARCH_CHUNKS..=NODE_SEARCH_CHUNKS {
            for dx in -NODE_SEARCH_CHUNKS..=NODE_SEARCH_CHUNKS {
                let coord = ChunkCoord::new(center.x + dx, center.z + dz);
                self.ensure_nodes(coord);
                let Some(ids) = self.nodes_by_chunk.get(&coord) else { continue };
                for &id in ids {
                    let Some(node) = self.nodes.get(&id) else { continue };
                    if node.charges_at(now, tuning.charges, tuning.respawn_seconds) == 0 {
                        continue;
                    }
                    if self.service_load.get(&id).copied().unwrap_or(0) >= NODE_CLAIM_CAP {
                        continue;
                    }
                    let d = (node.position - pos).length();
                    if best.map_or(true, |(_, _, bd)| d < bd) {
                        best = Some((id, node.position, d));
                    }
                }
            }
        }
        best.map(|(id, p, _)| (id, p))
    }

    /// Recount agents committed to each congestible service. Run once per tick
    /// before the decision batch; `decide_agent` then keeps it live as agents
    /// re-choose, so within-tick deciders see each other's fresh commitments
    /// (no thundering herd onto whichever storefront happened to look empty).
    fn rebuild_service_load(&mut self) {
        self.service_load.clear();
        for a in &self.agents {
            if !a.alive() {
                continue;
            }
            if let Some(e) = goal_service_target(a.goal) {
                *self.service_load.entry(e).or_insert(0) += 1;
            }
        }
    }

    /// Commit `idx` to `goal`, recording its load on any congestible service
    /// so peers deciding later this tick route around it.
    fn commit_goal(&mut self, idx: usize, goal: Goal) {
        let prev_label = goal_activity_label(self.agents[idx].goal);
        self.agents[idx].goal = goal;
        self.agents[idx].goal_age = 0.0;
        if let Some(e) = goal_service_target(goal) {
            *self.service_load.entry(e).or_insert(0) += 1;
        }
        // Owned agents narrate goal changes (label transitions only —
        // re-committing to another node of the same activity stays quiet,
        // and returning to Idle between errands isn't news).
        if self.agents[idx].owner.is_some() {
            let label = goal_activity_label(goal);
            if label != prev_label && !matches!(goal, Goal::Idle) {
                let text = self.agent_goal_description(idx);
                let aid = self.agents[idx].agent_id;
                self.push_agent_log(aid, text);
            }
        }
    }

    /// Utility-AI: score candidate goals for one agent and commit to the
    /// best. There is no role table — every multiplier comes from the
    /// agent's learned `Traits`, and territory plays (capture/defend) are
    /// scored from live field intel by marginal impact, so what an agent
    /// does emerges from what it has seen pay off on the ground it's on.
    fn decide_agent(&mut self, idx: usize) {
        use rand::Rng;
        let (pos, traits, faction, health_frac, wallet, carried, entity, retreat_cd) = {
            let a = &self.agents[idx];
            (
                a.position,
                a.traits,
                a.faction,
                a.health / a.max_health,
                a.wallet(),
                a.carried_value(),
                a.entity,
                a.retreat_cooldown,
            )
        };
        // Stagger the next re-score.
        self.agents[idx].decision_timer =
            self.rng.random_range(agents::DECISION_SECONDS.0..agents::DECISION_SECONDS.1);

        // Drop this agent's current commitment from the congestion counter so
        // it doesn't count itself when routing, and so whatever it commits to
        // below is the only thing peers see it queued at.
        if let Some(e) = goal_service_target(self.agents[idx].goal) {
            if let Some(c) = self.service_load.get_mut(&e) {
                *c = c.saturating_sub(1);
            }
        }

        // Safety override: hurt agents fall back to a sanctuary and heal.
        if health_frac < RETREAT_HEALTH_PCT {
            let to = self.nearest_sanctuary_spot(pos);
            self.commit_goal(idx, Goal::Retreat { to });
            return;
        }
        // Wealth override: a flush agent hauls its at-risk wallet to a Bank and
        // vaults it (death-safe). Carrying it into the field risks losing the
        // lot on death, so securing it is the rational move. No Bank reachable
        // → fall back to the old behavior and wait it out in a sanctuary.
        if wallet > WEALTH_RETREAT && retreat_cd <= 0.0 {
            if let Some((store, store_pos, _)) = self.route_service(pos, EntityKind::Bank) {
                self.commit_goal(idx, Goal::Bank { store, store_pos });
            } else {
                let to = self.nearest_sanctuary_spot(pos);
                self.commit_goal(idx, Goal::Retreat { to });
            }
            return;
        }

        let danger_here = districts::danger_at(pos);
        let mut best: (f32, Goal) = (2.0, Goal::Patrol { to: self.wander_target(idx) });

        // --- Gather: expected MILD from zone drops, boosted in warzones ---
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
        // Enemy-held ground taxes the yield; the scorer prices that in
        // (execution already applies the tax) so gathering naturally drifts
        // onto friendly or free ground — another reason to want territory.
        let tax_mult = if self.region_hostile_to(pos, faction) {
            1.0 - TERRITORY_TAX_PCT as f32 / 100.0
        } else {
            1.0
        };
        let gather_mult = traits.mult(Activity::Gather);
        // Free-volume capacity gates (the slotted model's version of the old
        // stack-count checks): keep room for a few more pulls before another
        // gathering run, a little less for opportunistic loot grabs.
        let free_volume =
            self.agents[idx].capacity().saturating_sub(self.agents[idx].used_volume());
        if free_volume > 4 {
            let score = ev * danger_mult * tax_mult * gather_mult * 2.0;
            // Gathering needs a real deposit now: no active node in reach
            // (after materializing the neighborhood) means Gather scores 0.
            if score > best.0 {
                if let Some((node, spot)) = self.best_gather_node(pos) {
                    best = (
                        score,
                        Goal::Gather {
                            node,
                            spot,
                            pulls_left: self.rng.random_range(3..6),
                            timer: 0.0,
                        },
                    );
                }
            }
        }

        // --- Sell: price the errand by what the counter actually PAYS ---
        // The channel choice is economic: list on the market book when its
        // expected net proceeds (live floating price minus the market fee)
        // beat the Bodega's fixed floor, or when the agent's learned Trade
        // leaning says the book has been paying it — that leaning is the
        // exploration path that discovers a market the raw comparison still
        // prices below the vendor at bootstrap. Raw carried value is the
        // wrong signal on either channel: it counts the agent's own
        // weapons/meds, which no counter accepts, so a kit-only agent would
        // march to the Bodega, sell nothing, and re-pick Sell forever — a
        // permanent statue crowd at the door. Destinations come from the
        // congestion-aware router so packed storefronts price themselves out.
        let sell_mult = traits.mult(Activity::Haul);
        let market_pay = self.market_sell_value(idx);
        let vendor_pay = vendor_sell_value(&self.agents[idx], EntityKind::Bodega);
        let want_market = (market_pay > vendor_pay || traits.leans(Activity::Trade))
            && self.market.len() < MARKET_BOOK_CAP;
        let sell_plan = if want_market {
            self.route_service(pos, EntityKind::MarketTerminal)
                .map(|r| (true, market_pay.max(market_list_value(&self.agents[idx])), r))
        } else {
            None
        }
        .or_else(|| {
            self.route_service(pos, EntityKind::Bodega).map(|r| (false, vendor_pay, r))
        });
        if let Some((list_on_market, payable, (store, store_pos, appeal))) = sell_plan {
            if payable >= 30 {
                let score = payable as f32 * 0.08 * sell_mult * appeal;
                if score > best.0 {
                    best = (score, Goal::Sell { store, store_pos, list_on_market });
                }
            }
        }

        // --- Extract: bank keeper cargo (fragments, craft materials, spare
        // gear) into the death-safe stash at a Storage terminal — the item
        // analog of the wealth bank run. Scored once the at-risk keeper
        // value crosses the threshold, or under pack pressure when the
        // keepers are worth anything at all; the learned Haul leaning weighs
        // how much this agent cares about securing cargo vs. selling it. ---
        let keeper_value = self.extract_value(idx);
        let pack_pressure = free_volume <= agents::EXTRACT_FREE_VOLUME;
        if keeper_value >= agents::EXTRACT_VALUE || (pack_pressure && keeper_value >= 30) {
            if let Some((store, store_pos, appeal)) =
                self.route_service(pos, EntityKind::Building)
            {
                let score = keeper_value as f32 * 0.1 * traits.mult(Activity::Haul) * appeal;
                if score > best.0 {
                    best = (score, Goal::Extract { store, store_pos });
                }
            }
        }

        // --- Loot: grab dropped containers nearby (free value on the ground).
        // Ammo caches (variant 1) are world spawns left for players; agents
        // only chase death drops. ---
        if free_volume > 2 {
            let loot_mult = traits.mult(Activity::Haul);
            let mut best_loot: Option<(f32, EntityId, Vec3)> = None;
            for c in self.loot.values() {
                if c.variant != 0 {
                    continue;
                }
                let dist = (c.position - pos).length();
                if dist > agents::LOOT_SCAN_RANGE {
                    continue;
                }
                let value: u32 = c.items.iter().map(|s| base_value(s.kind) * s.count).sum();
                if value < 5 {
                    continue;
                }
                // Nearer drops of equal value win (half weight at max range).
                let score =
                    value as f32 * loot_mult * (1.0 - 0.5 * dist / agents::LOOT_SCAN_RANGE);
                if best_loot.map(|(s, _, _)| score > s).unwrap_or(true) {
                    best_loot = Some((score, c.entity, c.position));
                }
            }
            if let Some((score, container, cpos)) = best_loot {
                if score > best.0 {
                    best = (score, Goal::Loot { container, pos: cpos });
                }
            }
        }

        // --- BuyGear: arm up when the wallet allows ---
        // Wielded weapons live in the equip slot now; a carried one is just
        // cargo that hasn't been equipped (or displaced surplus).
        let has_weapon = self.agents[idx].weapon().damage > FIST.damage
            || agents::WEAPON_PREFERENCE.iter().any(|k| self.agents[idx].count_item(*k) > 0);
        if !has_weapon && wallet >= 30 {
            // Everyone needs a weapon (retaliation, defense); agents
            // whose fighting has been paying want one much more.
            let want = 15.0 * traits.mult(Activity::Fight).max(0.8);
            // Market first: the best weapon class with a live ask at or
            // under the Armory's counter price arms the agent for less and
            // clears the book — this is the demand side of the gear market.
            let market_pick = agents::WEAPON_PREFERENCE
                .iter()
                .find_map(|&k| self.market_bargain(k, wallet).map(|p| (k, p)));
            if let Some((kind, price_each)) = market_pick {
                if let Some((_, terminal_pos)) =
                    self.nearest_service(pos, EntityKind::MarketTerminal)
                {
                    if want > best.0 {
                        best = (
                            want,
                            Goal::BuyMarket { terminal_pos, kind, count: 1, max_each: price_each },
                        );
                    }
                }
            } else if let Some((store, store_pos, appeal)) =
                self.route_service(pos, EntityKind::Armory)
            {
                // Shelves are stock-backed now: a sold-out line is unbuyable,
                // so pick the best affordable weapon the Armory actually
                // holds (none in stock = no vendor errand this pass).
                let picks: &[(u32, ItemKind)] = &[
                    (360, ItemKind::Smg),
                    (170, ItemKind::Pistol),
                    (55, ItemKind::Knife),
                    (0, ItemKind::Pipe),
                ];
                let kind = picks
                    .iter()
                    .find(|&&(min, k)| wallet >= min && self.vendor_stock_count(store, k) > 0)
                    .map(|&(_, k)| k);
                if let Some(kind) = kind {
                    let score = want * appeal;
                    if score > best.0 {
                        best = (score, Goal::Buy { store, store_pos, kind, count: 1 });
                    }
                }
            }
        }
        if self.agents[idx].count_item(ItemKind::Medkit) == 0 && wallet >= 60 && has_weapon {
            // Same market-first routing as weapons: a live medkit ask at or
            // under the Bodega's price wins the errand.
            if let Some(price_each) = self.market_bargain(ItemKind::Medkit, wallet) {
                if let Some((_, terminal_pos)) =
                    self.nearest_service(pos, EntityKind::MarketTerminal)
                {
                    let score = 8.0;
                    if score > best.0 {
                        best = (
                            score,
                            Goal::BuyMarket {
                                terminal_pos,
                                kind: ItemKind::Medkit,
                                count: 2,
                                max_each: price_each,
                            },
                        );
                    }
                }
            } else if let Some((store, store_pos, appeal)) =
                self.route_service(pos, EntityKind::Bodega)
            {
                // Sold-out shelves are unbuyable (fall back to the book next
                // time a fair ask shows up).
                if self.vendor_stock_count(store, ItemKind::Medkit) > 0 {
                    let score = 8.0 * appeal;
                    if score > best.0 {
                        best =
                            (score, Goal::Buy { store, store_pos, kind: ItemKind::Medkit, count: 1 });
                    }
                }
            }
        }
        // Ammo top-up: firearm carriers refill their kit reserve off the
        // book when a fair ask exists — crafted ammo surplus finds real
        // buyers instead of rotting in packs.
        if matches!(
            self.agents[idx].inventory.equipped_weapon,
            Some(ItemKind::Smg | ItemKind::Pistol)
        ) && wallet >= 30
        {
            let short = agents::kit_reserve(&self.agents[idx], ItemKind::Ammo9mm)
                .saturating_sub(self.agents[idx].count_item(ItemKind::Ammo9mm));
            if short > 0 {
                if let Some(price_each) = self.market_bargain(ItemKind::Ammo9mm, wallet) {
                    if let Some((_, terminal_pos)) =
                        self.nearest_service(pos, EntityKind::MarketTerminal)
                    {
                        let score = 6.0;
                        if score > best.0 {
                            best = (
                                score,
                                Goal::BuyMarket {
                                    terminal_pos,
                                    kind: ItemKind::Ammo9mm,
                                    count: short.min(wallet / price_each.max(1)),
                                    max_each: price_each,
                                },
                            );
                        }
                    }
                }
            }
        }

        // --- Collect: finished production waiting in a buffer somewhere ---
        let craft_mult = traits.mult(Activity::Craft);
        let agent_owner = OwnerId::Agent(self.agents[idx].agent_id);
        for &(building, _) in &self.agents[idx].pending_jobs {
            let Some(buffer) = self.production_outputs.get(&(building, agent_owner)) else {
                continue;
            };
            let Some(building_pos) = self.statics.get(&building).map(|s| s.position) else {
                continue;
            };
            // Errand value = what's sitting in the buffer; same 2.0 weight
            // as the craft errand that queued it.
            let value: u32 = buffer.iter().map(|s| base_value(s.kind) * s.count).sum();
            let score = value as f32 * 2.0 * craft_mult;
            if score > best.0 {
                best = (score, Goal::Collect { building, building_pos });
            }
        }

        // --- Craft: best-margin KNOWN recipe the agent can feed (inputs +
        // Energy), margin net of the Energy the unit burns. The best locked
        // recipe is remembered as a research prospect. ---
        let carried_energy = self.agents[idx].purse.carried(Currency::Energy);
        let mut best_recipe: Option<(&'static wilder_crafting::Recipe, f32)> = None;
        let mut best_locked: Option<(&'static wilder_crafting::Recipe, f32)> = None;
        for recipe in wilder_crafting::RECIPES {
            if recipe.station == wilder_crafting::Station::Laboratory {
                continue;
            }
            let in_value: u32 =
                recipe.inputs.iter().map(|&(k, c)| base_value(k) * c).sum();
            let out_value = base_value(recipe.output.0) * recipe.output.1;
            let margin = out_value.saturating_sub(in_value) as f32
                - recipe.energy as f32 * ENERGY_MILD_VALUE;
            if margin <= 0.0 {
                continue;
            }
            if !self.agents[idx].blueprints.contains(recipe.id) {
                if best_locked.map(|(_, m)| margin > m).unwrap_or(true) {
                    best_locked = Some((recipe, margin));
                }
                continue;
            }
            let affordable = recipe
                .inputs
                .iter()
                .all(|&(kind, count)| self.agents[idx].count_item(kind) >= count)
                && recipe.energy <= carried_energy;
            if !affordable {
                continue;
            }
            if best_recipe.map(|(_, m)| margin > m).unwrap_or(true) {
                best_recipe = Some((recipe, margin));
            }
        }
        if let Some((recipe, margin)) = best_recipe {
            let station_kind = station_entity_kind(recipe.station);
            if let Some((station, station_pos, appeal)) = self.route_service(pos, station_kind) {
                // Same 2.0 errand weight as gathering: value-added work at a
                // station competes on equal footing with pulling raw drops,
                // so craft-leaning agents actually consume resources — that
                // consumption is the demand side of the market book. A full
                // queue kills the errand outright (the batch would bounce).
                let full = self.production.get(&station).map_or(0, |q| q.len())
                    >= PRODUCTION_QUEUE_CAP;
                let score = margin * 2.0 * craft_mult * appeal;
                if !full && score > best.0 {
                    best = (score, Goal::Craft { station, station_pos, recipe: recipe.id });
                }
            }
        }
        // --- Research: a locked recipe beats everything we know and the
        // tuition (fragments + resources + Energy) is in hand ---
        if let Some((locked, locked_margin)) = best_locked {
            let known_margin = best_recipe.map(|(_, m)| m).unwrap_or(0.0);
            let funded = self.agents[idx].count_item(ItemKind::BlueprintFragment)
                >= RESEARCH_FRAGMENTS
                && RESEARCH_RESOURCES
                    .iter()
                    .all(|&(k, c)| self.agents[idx].count_item(k) >= c)
                && carried_energy >= RESEARCH_ENERGY;
            if locked_margin > known_margin && funded {
                if let Some((lab, lab_pos, appeal)) =
                    self.route_service(pos, EntityKind::Laboratory)
                {
                    // Modest utility: the unlock pays out over future crafts,
                    // so score the margin ADVANTAGE, not the margin itself.
                    let score = (locked_margin - known_margin) * craft_mult * appeal;
                    if score > best.0 {
                        best = (score, Goal::Research { lab, lab_pos, recipe: locked.id });
                    }
                }
            }
        }
        // Craft-leaning agents missing inputs restock off the market book
        // when a fair listing exists. Wanted kinds come from actual recipe
        // inputs — raw resources AND intermediates (plates, polymer,
        // boards...) — so every production input has real buy-side demand.
        if traits.leans(Activity::Craft) && best_recipe.is_none() && wallet >= 30 {
            let wanted = |kind: ItemKind| {
                wilder_crafting::RECIPES
                    .iter()
                    .filter(|r| r.station != wilder_crafting::Station::Laboratory)
                    .flat_map(|r| r.inputs.iter())
                    .any(|&(k, _)| k == kind)
            };
            let listing = self.market.iter().find(|l| {
                wanted(l.kind)
                    && l.price_each <= self.market_ref_price(l.kind).saturating_mul(2)
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

        // --- Trade: arbitrage underpriced listings ---
        if wallet >= 20 {
            let trade_mult = traits.mult(Activity::Trade);
            let bargain = self.market.iter().any(|l| {
                let market_ref = self.market_ref_price(l.kind);
                l.price_each.saturating_mul(10) <= market_ref.saturating_mul(7)
                    && l.price_each <= wallet
            });
            if bargain {
                if let Some((_, terminal_pos)) =
                    self.nearest_service(pos, EntityKind::MarketTerminal)
                {
                    let score = 18.0 * trade_mult;
                    if score > best.0 {
                        best = (score, Goal::Trade { terminal_pos });
                    }
                }
            }
        }

        // --- Fight: hunt a hostile the rules let us hit right now ---
        // Any armed agent weighs this; the learned Fight weight and the
        // local force balance (from field intel) decide whether trouble is
        // worth it. Outgunned agents rationally pass; a strong local
        // majority presses the advantage.
        let my_region = region_of(pos);
        let local = self.field_intel.get(&my_region).copied().unwrap_or_default();
        let (_, local_enemies, my_str, enemy_str) = local.sides(faction);
        let own_str = self.agents[idx].strength();
        let advantage = if local_enemies == 0 {
            0.5
        } else {
            (my_str + own_str) / (my_str + own_str + enemy_str).max(1.0)
        };
        if has_weapon {
            let fight_mult = traits.mult(Activity::Fight);
            if let Some(target) = self.find_hostile_target(entity, pos, faction) {
                let score = 30.0 * fight_mult * 2.0 * advantage;
                if score > best.0 {
                    best = (score, Goal::Hunt { target });
                }
            }
        }

        // --- Capture / Defend: territory as a first-class goal ---
        // Scan the local neighborhood (this region + 8 neighbors) and score
        // each cell by observed worth x marginal impact of one more body
        // (pivotality under the Halo capture rules) x survival odds. Nobody
        // piles onto safely-held ground and nobody feeds a hopeless fight —
        // that's the best-response core that makes front lines emerge.
        {
            let cap_mult = traits.mult(Activity::Capture);
            let exposure = ((wallet + carried) as f32 / 500.0).min(1.0);
            let mut best_play: Option<(f32, (i32, i32), bool)> = None;
            for dz in -1..=1 {
                for dx in -1..=1 {
                    let r = (my_region.0 + dx, my_region.1 + dz);
                    if region_is_protected(r) {
                        continue;
                    }
                    let center = region_center(r);
                    if !matches!(
                        districts::danger_at(center),
                        DangerLevel::Contested | DangerLevel::Warzone
                    ) {
                        continue; // sanctuary / guarded ground can't be taken
                    }
                    let cell = self.field_intel.get(&r).copied().unwrap_or_default();
                    let (mine, enemy, my_s, enemy_s) = cell.sides(faction);
                    // Fighting for ground with enemies on it needs a weapon.
                    if enemy > 0 && !has_weapon {
                        continue;
                    }
                    let defend = cell.controller == faction;
                    let pivot = if defend {
                        defend_pivotality(mine, enemy)
                    } else {
                        capture_pivotality(mine, enemy)
                    };
                    if pivot <= 0.0 {
                        continue;
                    }
                    // Worth = base claim value + observed commerce flowing
                    // through the cell (ground with storefronts matters).
                    let value = 8.0 + (cell.income * 0.25).min(20.0);
                    // Survival odds against the local force balance, and a
                    // wealth-at-risk discount so rich haulers don't wander
                    // into meat grinders.
                    let safety = if enemy == 0 {
                        1.0
                    } else {
                        (my_s + own_str) / (my_s + own_str + enemy_s).max(1.0)
                    };
                    let risk = 1.0 - (1.0 - safety) * exposure * 0.8;
                    let dist = (center - pos).length();
                    let near = 1.0 / (1.0 + dist / 120.0);
                    let score = value * pivot * cap_mult * safety * risk * near;
                    if score > best_play.map(|(s, _, _)| s).unwrap_or(0.0) {
                        best_play = Some((score, r, defend));
                    }
                }
            }
            if let Some((score, r, defend)) = best_play {
                if score > best.0 {
                    let side = REGION_CHUNKS as f32 * CHUNK_SIZE;
                    let to = self.walkable_spot_near(region_center(r), side * 0.4);
                    let goal = if defend {
                        Goal::Defend { region: r, to }
                    } else {
                        Goal::Capture { region: r, to }
                    };
                    best = (score, goal);
                }
            }
        }

        // --- Patrol: armed agents with nothing better to do push toward a
        // front, where the capture/fight opportunities actually are. ---
        if has_weapon {
            let fight_mult = traits.mult(Activity::Fight).max(traits.mult(Activity::Capture));
            let to = self.patrol_front(idx);
            let score = 4.0 * fight_mult;
            if score > best.0 {
                best = (score, Goal::Patrol { to });
            }
        }

        self.commit_goal(idx, best.1);
    }

    /// Nearest hostile combatant within engagement range that current danger
    /// rules allow attacking. Players are scanned directly (a small set);
    /// agents come from the spatial hash.
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
                consider(p.entity, p.character.position, p.character.faction, &mut best);
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

    /// Patrol destination for a fight-leaning agent: a jittered spot at its
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
            Goal::Craft { .. } => self.agent_queue_craft(idx),
            Goal::Research { .. } => self.agent_research(idx),
            Goal::Collect { .. } => self.agent_collect(idx),
            Goal::Loot { container, .. } => self.agent_loot_pickup(idx, container),
            Goal::Bank { .. } => self.agent_bank_deposit(idx),
            Goal::Extract { store, .. } => self.agent_extract(idx, store),
            _ => {}
        }
    }

    /// Vault the agent's at-risk wallet (above its operating float) into its
    /// death-safe bank balance. Reached the Bank counter. The MILD stays in
    /// supply — it's still agent-held — so there's no ledger leg; only its
    /// exposure to death changes.
    fn agent_bank_deposit(&mut self, idx: usize) {
        // Same shared bank flow the player Deposit action routes through;
        // agents keep an operating float and vault everything above it.
        let carried = self
            .actor_purse(EconActor::Agent(idx))
            .map_or(0, |p| p.carried(Currency::Wild));
        let deposit = carried.saturating_sub(agents::AGENT_BANK_KEEP);
        if deposit > 0 {
            // Owned agents pay their employer's cut off the top of every
            // deposit; the rest goes into the agent's own vault.
            let share = if self.agents[idx].owner.is_some() {
                deposit * OWNER_SHARE_PCT / 100
            } else {
                0
            };
            self.pay_owner_share(idx, share);
            let vaulted = deposit - share;
            if vaulted > 0 {
                let _ = self.move_to_bank(EconActor::Agent(idx), Currency::Wild, vaulted, true);
            }
            if self.agents[idx].owner.is_some() {
                let aid = self.agents[idx].agent_id;
                self.push_agent_log(aid, format!("Banked {vaulted} MILD ({share} to you)"));
            }
        }
        // Vaulted: suppress another wealth run for a while, then back to work.
        let agent = &mut self.agents[idx];
        agent.retreat_cooldown = agents::RETREAT_COOLDOWN;
        agent.goal = Goal::Idle;
    }

    /// Drain a loot container into the agent's pack (it walked onto the
    /// drop). Mirrors the player walk-over pickup, including the ledger
    /// attribution; whatever doesn't fit stays on the ground.
    fn agent_loot_pickup(&mut self, idx: usize, container_id: EntityId) {
        self.agents[idx].goal = Goal::Idle;
        let Some(container) = self.loot.get_mut(&container_id) else { return };
        let items: Vec<ItemStack> = container.items.drain(..).collect();
        let owner = container.owner.clone();
        let in_supply = container.in_supply;
        let variant = container.variant;
        let mut taken: Vec<ItemStack> = Vec::new();
        let mut leftovers: Vec<ItemStack> = Vec::new();
        for stack in items {
            let rem = self.agents[idx].add_item(stack.kind, stack.count);
            if stack.count > rem {
                taken.push(ItemStack { kind: stack.kind, count: stack.count - rem });
            }
            if rem > 0 {
                leftovers.push(ItemStack { kind: stack.kind, count: rem });
            }
        }
        if leftovers.is_empty() {
            self.loot.remove(&container_id);
        } else if let Some(container) = self.loot.get_mut(&container_id) {
            container.items = leftovers;
        }
        if !taken.is_empty() {
            // Looted gear goes straight into the hands/on the back when it
            // beats what's equipped.
            self.agents[idx].equip_best_gear();
            let value: u32 = taken.iter().map(|s| base_value(s.kind) * s.count).sum();
            self.agents[idx].learn(Activity::Haul, value as f32);
            let picker = self.agents[idx].party();
            self.record_loot_pickup(picker, owner, in_supply, &taken);
            if self.agents[idx].owner.is_some() {
                let units: u32 = taken.iter().map(|s| s.count).sum();
                let aid = self.agents[idx].agent_id;
                self.push_agent_log(aid, format!("Picked up loot ({units} items)"));
            }
            // Ammo caches carry the same small Energy charge players tap.
            if variant == 1 {
                self.grant_currency_actor(EconActor::Agent(idx), Currency::Energy, 1);
            }
        }
    }

    /// One gather pull at the agent's target node, through the same
    /// `gather_node` rulebook players use (no more virtual minting). The
    /// node can be racing other actors: a pull that finds it cooling just
    /// waits for the next timer tick; a dry or missing node ends the goal
    /// so the brain re-picks. One charge per act, so the cold tier's larger
    /// dt slices can never over-draw a node.
    fn agent_gather_pull(&mut self, idx: usize) {
        let Goal::Gather { node, .. } = self.agents[idx].goal else { return };
        let now = self.world_seconds();
        let tuning = self.node_tuning;
        let available = self.nodes.get_mut(&node).is_some_and(|n| {
            n.refresh(now, tuning.charges, tuning.respawn_seconds);
            n.charges > 0
        });
        if !available {
            // Someone drained it under us: re-decide (usually another node).
            self.agents[idx].goal = Goal::Idle;
            return;
        }
        let Some(outcome) = self.gather_node(EconActor::Agent(idx), node) else {
            // On the 1.2 s cooldown (another actor just pulled): the 4 s
            // pull timer retries on its own.
            return;
        };
        if outcome.denied {
            // Pack full — gathering more is pointless, go haul instead.
            self.agents[idx].goal = Goal::Idle;
            return;
        }
        // Learning: each pull is a completed unit of gathering work (travel
        // included the first time); the clock restarts per pull so the rate
        // reflects steady-state yield, not the whole trip averaged down.
        let value: u32 =
            outcome.gained.iter().map(|s| base_value(s.kind).saturating_mul(s.count)).sum();
        if value > 0 {
            self.agents[idx].learn(Activity::Gather, value as f32);
        }
        self.agents[idx].goal_age = 0.0;
        if let Goal::Gather { pulls_left, .. } = &mut self.agents[idx].goal {
            *pulls_left = pulls_left.saturating_sub(1);
            if *pulls_left == 0 {
                self.agents[idx].goal = Goal::Idle;
            }
        }
    }

    /// Sell everything the store buys; traders list surplus resources on the
    /// market book instead of dumping at vendor floor prices. Each sale goes
    /// through the same `vendor_sell` flow the player VendorSell action uses.
    fn agent_sell(&mut self, idx: usize, store: EntityId, list_on_market: bool) {
        if list_on_market {
            self.agent_market_list(idx);
            self.agents[idx].goal = Goal::Idle;
            return;
        }
        let Some(store_kind) = self.statics.get(&store).map(|s| s.kind) else {
            self.agents[idx].goal = Goal::Idle;
            return;
        };
        let sellables: Vec<(ItemKind, u32)> = wilder_economy::vendor_offers(store_kind)
            .iter()
            .filter(|o| o.sell > 0)
            .filter_map(|o| {
                let have = self.agents[idx].count_item(o.kind);
                (have > 0).then_some((o.kind, have))
            })
            .collect();
        let wallet_before = self.agents[idx].purse.carried(Currency::Wild);
        for (kind, count) in sellables {
            let _ = self.vendor_sell(EconActor::Agent(idx), store, kind, count);
        }
        if self.agents[idx].owner.is_some() {
            let earned =
                self.agents[idx].purse.carried(Currency::Wild).saturating_sub(wallet_before);
            if earned > 0 {
                let aid = self.agents[idx].agent_id;
                self.push_agent_log(aid, format!("Sold goods at a vendor for {earned} MILD"));
            }
        }
        self.agents[idx].goal = Goal::Idle;
    }

    /// Buy `count` of `kind` from a vendor building through the same
    /// `vendor_buy` flow the player VendorBuy action uses (identical rules
    /// and ledger legs; failures just drop the errand).
    fn agent_vendor_buy(&mut self, idx: usize, store: EntityId, kind: ItemKind, count: u32) {
        self.agents[idx].goal = Goal::Idle;
        if self.vendor_buy(EconActor::Agent(idx), store, kind, count).is_ok()
            && self.agents[idx].owner.is_some()
        {
            let aid = self.agents[idx].agent_id;
            self.push_agent_log(aid, format!("Bought {count} {}", kind.display_name()));
        }
    }

    /// Best-margin recipe the agent KNOWS (net of the Energy burn),
    /// independent of whether the pack can feed it right now — its inputs
    /// are the materials the agent "plans to craft with" for extraction and
    /// stash withdraw planning.
    fn best_known_recipe(&self, idx: usize) -> Option<&'static wilder_crafting::Recipe> {
        let mut best: Option<(&'static wilder_crafting::Recipe, f32)> = None;
        for recipe in wilder_crafting::RECIPES {
            if recipe.station == wilder_crafting::Station::Laboratory
                || !self.agents[idx].blueprints.contains(recipe.id)
            {
                continue;
            }
            let in_value: u32 = recipe.inputs.iter().map(|&(k, c)| base_value(k) * c).sum();
            let out_value = base_value(recipe.output.0) * recipe.output.1;
            let margin = out_value.saturating_sub(in_value) as f32
                - recipe.energy as f32 * ENERGY_MILD_VALUE;
            if margin > 0.0 && best.map(|(_, m)| margin > m).unwrap_or(true) {
                best = Some((recipe, margin));
            }
        }
        best.map(|(r, _)| r)
    }

    /// Keeper cargo an Extract errand would stash, per kind: blueprint
    /// fragments, carried inputs of the best known recipe (materials the
    /// agent plans to craft with) and spare backpack gear — unless the agent
    /// leans Trade, in which case gear is sale cargo headed for the book,
    /// not the vault. Deliberately a simple heuristic; equipped gear lives
    /// outside the backpack and never shows up here.
    fn extract_keepers(&self, idx: usize) -> Vec<(ItemKind, u32)> {
        let agent = &self.agents[idx];
        let mut keep: Vec<(ItemKind, u32)> = Vec::new();
        let mut add = |kind: ItemKind, count: u32| {
            if count > 0 && !keep.iter().any(|&(k, _)| k == kind) {
                keep.push((kind, count));
            }
        };
        add(ItemKind::BlueprintFragment, agent.count_item(ItemKind::BlueprintFragment));
        if let Some(recipe) = self.best_known_recipe(idx) {
            for &(kind, _) in recipe.inputs {
                add(kind, agent.count_item(kind));
            }
        }
        if !agent.traits.leans(Activity::Trade) {
            for &kind in agents::WEAPON_PREFERENCE.iter().chain(agents::ARMOR_PREFERENCE.iter())
            {
                add(kind, agent.count_item(kind));
            }
        }
        keep
    }

    /// Reference value of the cargo `extract_keepers` would stash (drives
    /// the Extract utility, mirroring how `haul_value` drives Sell).
    fn extract_value(&self, idx: usize) -> u32 {
        self.extract_keepers(idx)
            .iter()
            .map(|&(k, c)| base_value(k).saturating_mul(c))
            .sum()
    }

    /// Extract errand arrival: deposit the keeper cargo into the death-safe
    /// stash through the shared `stash_transfer` path (same 5 m Storage rule
    /// and Extract ledger legs players get), then — minimal withdraw
    /// planning — crafters pull back one queue batch of their best known
    /// recipe's inputs so banking the surplus doesn't stall the workshop
    /// loop. Deeper withdraw planning (shopping the stash from Craft goals
    /// en route) is deferred until the simple version proves insufficient.
    fn agent_extract(&mut self, idx: usize, store: EntityId) {
        self.agents[idx].goal = Goal::Idle;
        let keepers = self.extract_keepers(idx);
        let mut stashed_value = 0u32;
        for (kind, count) in keepers {
            if let Ok(moved) =
                self.stash_transfer(EconActor::Agent(idx), store, kind, count, true)
            {
                stashed_value += base_value(kind).saturating_mul(moved);
            }
        }
        if self.agents[idx].traits.leans(Activity::Craft) {
            if let Some(recipe) = self.best_known_recipe(idx) {
                for &(kind, per_unit) in recipe.inputs {
                    // One batch, sized like agent_queue_craft's cap (5).
                    let want =
                        (per_unit * 5).saturating_sub(self.agents[idx].count_item(kind));
                    let _ =
                        self.stash_transfer(EconActor::Agent(idx), store, kind, want, false);
                }
            }
        }
        // Learning: secured cargo is realized (risk-removed) value, sampled
        // at a discount to an actual sale so counters stay attractive.
        if stashed_value > 0 {
            self.agents[idx].learn(Activity::Haul, stashed_value as f32 * 0.2);
        }
    }

    /// Live market reference price for an item: the most recent fill when the
    /// kind has traded, clamped to sane bounds around the static base value
    /// (so one absurd fill can't poison agent decisions), else the base value.
    fn market_ref_price(&self, kind: ItemKind) -> u32 {
        let base = base_value(kind).max(1);
        match self.market_stats.last_price(kind) {
            Some(p) => p.clamp((base / 2).max(1), base.saturating_mul(3)),
            None => base,
        }
    }

    /// Cheapest live ask for `kind` the agent can afford, when it beats the
    /// vendor's counter price (at-or-under: same MILD, but the fill keeps
    /// the floating market alive). No vendor line for the kind → any
    /// affordable ask up to twice the market reference qualifies.
    fn market_bargain(&self, kind: ItemKind, wallet: u32) -> Option<u32> {
        let ask = self
            .market
            .iter()
            .filter(|l| l.kind == kind && l.count > 0 && l.price_each <= wallet)
            .map(|l| l.price_each)
            .min()?;
        let vendor = wilder_economy::reference_prices(kind).0;
        let cap = if vendor > 0 {
            vendor
        } else {
            self.market_ref_price(kind).saturating_mul(2)
        };
        (ask <= cap).then_some(ask)
    }

    /// Walk every agent ask down ~5% toward its price floor (unsold stock
    /// meets demand instead of clogging the book forever); player listings
    /// are never repriced. Changed kinds are marked dirty so item-market
    /// watchers see the book move. Called every `MARKET_DECAY_TICKS`.
    fn tick_market_decay(&mut self) {
        let mut changed = false;
        for i in 0..self.market.len() {
            let l = &self.market[i];
            if !l.agent {
                continue;
            }
            let floor = (base_value(l.kind) / 2).max(1);
            if l.price_each <= floor {
                continue;
            }
            let next = (l.price_each.saturating_mul(95) / 100).clamp(floor, l.price_each - 1);
            let kind = l.kind;
            self.market[i].price_each = next;
            self.market_stats.mark_dirty(kind);
            changed = true;
        }
        if changed {
            self.save_market();
        }
    }

    /// Ask price for a fresh agent listing. Prices float with supply and
    /// demand instead of sitting on a static markup: with live competition on
    /// the book the new seller undercuts the cheapest ask by ~5%; on an empty
    /// book (demand just cleared the supply) it marks up ~10% over the last
    /// fill — rounded *up*, or cheap items (iron at 2 MILD) would floor the
    /// markup away and the price could never float off its base. Clamped to
    /// [base/2, base*3] so the loop can't run away.
    fn agent_ask_price(&self, kind: ItemKind) -> u32 {
        let base = base_value(kind).max(1);
        let floor = (base / 2).max(1);
        let ceil = base.saturating_mul(3);
        let best_ask = self
            .market
            .iter()
            .filter(|l| l.kind == kind && l.count > 0)
            .map(|l| l.price_each)
            .min();
        let anchor = match best_ask {
            Some(ask) => ask.saturating_mul(95) / 100,
            None => self.market_ref_price(kind).saturating_mul(11).div_ceil(10),
        };
        anchor.clamp(floor, ceil)
    }

    /// Expected net MILD (after the market fee) from listing the agent's
    /// listable cargo at today's floating ask. The Sell scorer compares this
    /// against the Bodega's fixed floor to pick the errand's channel.
    fn market_sell_value(&self, idx: usize) -> u32 {
        let gross: u32 = market_surplus(&self.agents[idx])
            .iter()
            .map(|&(k, c)| self.agent_ask_price(k).saturating_mul(c))
            .sum();
        gross.saturating_mul(100 - MARKET_FEE_PCT) / 100
    }

    /// Evict one floor-priced agent listing to make room on a full book (the
    /// escrowed items burn — dead stock nobody bought at the minimum price).
    /// Returns false when the book is wall-to-wall player listings.
    fn evict_stale_listing(&mut self) -> bool {
        let Some(pos) = self
            .market
            .iter()
            .position(|l| l.agent && l.price_each <= (base_value(l.kind) / 2).max(1))
        else {
            return false;
        };
        let l = self.market.remove(pos);
        self.ledger.record(
            TxKind::Burn,
            self.market_party(),
            TxParty::Burn,
            TxAmount::Item { kind: l.kind, count: l.count },
            0,
        );
        self.market_stats.mark_dirty(l.kind);
        true
    }

    /// List the agent's sellable surplus (resources, valuables, and gear
    /// above the personal kit reserve) on the market book at the current
    /// floating market price.
    fn agent_market_list(&mut self, idx: usize) {
        let market_agent = self.market_party();
        let carried = market_surplus(&self.agents[idx]);
        for (kind, count) in carried {
            // Full book: scrap dead floor-priced agent stock to make room;
            // if none exists the book really is full and listing stops.
            if self.market.len() >= MARKET_BOOK_CAP && !self.evict_stale_listing() {
                break;
            }
            let price_each = self.agent_ask_price(kind);
            let removed = self.agents[idx].remove_item(kind, count);
            if removed == 0 {
                continue;
            }
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
                agent: true,
            };
            self.next_listing_id += 1;
            self.market.push(listing);
            if self.agents[idx].owner.is_some() {
                let aid = self.agents[idx].agent_id;
                self.push_agent_log(
                    aid,
                    format!(
                        "Listed {removed} {} at {price_each} MILD each",
                        kind.display_name()
                    ),
                );
            }
        }
        self.save_market();
    }

    /// Buy up to `count` of `kind` off the market book at `max_each` or
    /// better. Mirrors the player MarketBuy constraints and ledger legs:
    /// the agent must be standing at a MarketTerminal (5 m / interior, same
    /// range players trade at — no more remote fills) and sellers (player
    /// or agent) are credited identically.
    fn agent_market_buy(&mut self, idx: usize, kind: ItemKind, count: u32, max_each: u32) -> bool {
        // Range parity: the goal routing walks agents to a terminal before
        // Act fires; enforce it at execution too so no path can fill
        // remotely.
        let Some(terminal_pos) = self.market_terminal_near(EconActor::Agent(idx)) else {
            return false;
        };
        let market_agent = self.market_party();
        let Some(pos) = self
            .market
            .iter()
            .position(|l| l.kind == kind && l.price_each <= max_each && l.count > 0)
        else {
            return false;
        };
        let (listing_seller, seller_name, price_each, available) = {
            let l = &self.market[pos];
            (l.seller, l.seller_name.clone(), l.price_each, l.count)
        };
        // Never buy from yourself (relisting loops).
        if listing_seller == self.agents[idx].agent_id {
            return false;
        }
        let wallet = self.agents[idx].wallet();
        let affordable = (wallet / price_each.max(1)).min(count).min(available);
        if affordable == 0 {
            return false;
        }
        let cost = price_each * affordable;
        self.agents[idx].purse.debit(Currency::Wild, cost);
        let leftover = self.actor_add_items(EconActor::Agent(idx), kind, affordable);
        if leftover > 0 {
            // Couldn't haul it all: the overflow spills to the ground as the
            // buyer's loot (mirrors the player market-buy path) rather than
            // silently vanishing from supply.
            let pos = self.agents[idx].position;
            let buyer = self.agents[idx].party();
            self.spawn_loot(pos, vec![ItemStack { kind, count: leftover }], Some(buyer), true);
        }
        self.agents[idx].equip_best_gear();
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
            self.ledger.record(
                TxKind::Fee,
                buyer_party,
                market_agent.clone(),
                TxAmount::Wild { amount: fee },
                0,
            );
        }
        // Fee parity with the player path: the terminal's territory holder
        // skims the market fee (distribute_commerce burns it on neutral
        // ground) — agent fills stopped burning it unconditionally.
        self.distribute_commerce(terminal_pos, fee, market_agent, false);
        self.ledger.trades += 1;
        let buyer_name = self.agents[idx].name.clone();
        self.market_stats.record_fill(kind, price_each, affordable, buyer_name, seller_name);
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
            sp.purse.credit(Currency::Wild, proceeds);
            let account = sp.character.account_id;
            let wallet = sp.purse.carried(Currency::Wild);
            let party = player_party(sp);
            let _ = self.store.update_wallet(account, wallet);
            return party;
        }
        if let Some(agent) = self.agents.iter_mut().find(|a| a.agent_id == seller) {
            agent.purse.credit(Currency::Wild, proceeds);
            // Reinforce the channel: realized market proceeds teach Trade,
            // so sellers whose listings actually fill keep working the book.
            agent.learn(Activity::Trade, proceeds as f32);
            return agent.party();
        }
        if let Ok(ch) = self.store.character(seller) {
            if let Ok(account) = self.store.account_by_id(ch.account_id) {
                let _ = self.store.update_wallet(account.id, account.wallet + proceeds);
                return TxParty::Player { id: seller, name: ch.name, faction: ch.faction };
            }
        }
        TxParty::Burn
    }

    /// Trader arbitrage at a terminal: buy the best underpriced listing,
    /// then relist it at the floating market price.
    fn agent_trade(&mut self, idx: usize) {
        self.agents[idx].goal = Goal::Idle;
        let wallet = self.agents[idx].wallet();
        let me = self.agents[idx].agent_id;
        // Best bargain: largest absolute discount vs the live market price.
        let pick = self
            .market
            .iter()
            .filter(|l| {
                l.seller != me
                    && l.price_each <= wallet
                    && l.price_each.saturating_mul(10)
                        <= self.market_ref_price(l.kind).saturating_mul(7)
            })
            .max_by_key(|l| self.market_ref_price(l.kind).saturating_sub(l.price_each))
            .map(|l| (l.kind, l.price_each));
        let Some((kind, price_each)) = pick else { return };
        let before = self.agents[idx].count_item(kind);
        if self.agent_market_buy(idx, kind, u32::MAX, price_each) {
            // Learning: the arbitrage spread captured on this flip.
            let got = self.agents[idx].count_item(kind).saturating_sub(before);
            let spread = self.market_ref_price(kind).saturating_sub(price_each);
            self.agents[idx].learn(Activity::Trade, (spread * got) as f32);
            // Immediately flip the goods back onto the book at a margin.
            self.agent_market_list(idx);
        }
    }

    /// Craft goal arrival: queue a batch through the SAME `queue_production`
    /// path players use (5 m, blueprint, station, inputs, Energy, queue cap
    /// all validated there; inputs + Energy burn at the counter). The agent
    /// remembers (building, job_id) and comes back on a Collect errand;
    /// learning happens per finished unit in `complete_production_unit`.
    fn agent_queue_craft(&mut self, idx: usize) {
        let Goal::Craft { station, recipe, .. } = self.agents[idx].goal else { return };
        self.agents[idx].goal = Goal::Idle;
        let Some(recipe_def) = wilder_crafting::recipe(recipe) else { return };
        // Batch what the pack and purse can feed, capped small so one agent
        // doesn't squat a public queue slot for minutes.
        let mut batch = u32::MAX;
        for &(kind, count) in recipe_def.inputs {
            batch = batch.min(self.agents[idx].count_item(kind) / count.max(1));
        }
        if recipe_def.energy > 0 {
            batch = batch.min(self.agents[idx].purse.carried(Currency::Energy) / recipe_def.energy);
        }
        let batch = batch.min(5);
        if batch == 0 {
            return;
        }
        if let Some(job_id) = self.queue_production(EconActor::Agent(idx), station, recipe, batch)
        {
            self.agents[idx].pending_jobs.push((station, job_id));
            if self.agents[idx].owner.is_some() {
                let aid = self.agents[idx].agent_id;
                self.push_agent_log(aid, format!("Queued {batch}x {recipe} for crafting"));
            }
        }
    }

    /// Research goal arrival: unlock the blueprint through the shared
    /// `research()` path (fragments + resources + Energy burn there; the
    /// new recipe persists with the agent's shard save).
    fn agent_research(&mut self, idx: usize) {
        let Goal::Research { recipe, .. } = self.agents[idx].goal else { return };
        self.agents[idx].goal = Goal::Idle;
        self.research(EconActor::Agent(idx), recipe);
    }

    /// Collect goal arrival: pull this agent's output buffer at the
    /// building (retires the pending-job note once nothing is left).
    fn agent_collect(&mut self, idx: usize) {
        let Goal::Collect { building, .. } = self.agents[idx].goal else { return };
        self.agents[idx].goal = Goal::Idle;
        let collected = self.collect_production(EconActor::Agent(idx), building);
        if !collected.is_empty() && self.agents[idx].owner.is_some() {
            let units: u32 = collected.iter().map(|s| s.count).sum();
            let aid = self.agents[idx].agent_id;
            self.push_agent_log(aid, format!("Collected {units} crafted units"));
        }
        if collected.is_empty() {
            // Nothing here for us (raced a purge or a stale note): drop the
            // note so the brain stops routing back.
            let owner = OwnerId::Agent(self.agents[idx].agent_id);
            let live = self
                .production
                .get(&building)
                .is_some_and(|q| q.iter().any(|j| j.owner == owner))
                || self.production_outputs.contains_key(&(building, owner));
            if !live {
                self.agents[idx].pending_jobs.retain(|&(b, _)| b != building);
            }
        }
    }

    // -----------------------------------------------------------------------
    // Agent population: seeding + persistence
    // -----------------------------------------------------------------------

    /// Restore the persisted agent population, or seed a fresh one (count
    /// from `WILDER_AGENTS`, default 25,000). Populations saved under an
    /// older seed layout are discarded and reseeded so distribution changes
    /// (like the hub cohort) actually reach existing worlds.
    fn load_or_seed_agents(&mut self) {
        let layout: u32 =
            self.store.meta("agent_seed_layout").ok().flatten().unwrap_or(0);
        let saves: Vec<AgentSave> = if layout == AGENT_SEED_LAYOUT {
            // Sharded layout when the descriptor exists (concatenate every
            // shard), else the legacy single blob (pre-shard worlds).
            let shard_count: Option<usize> =
                self.store.meta("faction_agents_shards").ok().flatten();
            match shard_count {
                Some(shards) => (0..shards)
                    .flat_map(|shard| {
                        self.store
                            .meta::<Vec<AgentSave>>(&format!("faction_agents_shard_{shard}"))
                            .ok()
                            .flatten()
                            .unwrap_or_default()
                    })
                    .collect(),
                None => self.store.meta("faction_agents").ok().flatten().unwrap_or_default(),
            }
        } else {
            Vec::new()
        };
        if !saves.is_empty() {
            for mut save in saves {
                // Sanitize restored positions: older saves can hold agents
                // stranded over open water (pre-walkability-guard drift).
                // Scatter them around their staging ground — a deterministic
                // snap would stack every stranded agent on one exact point.
                if !self.chunks.walkable(save.position.x, save.position.z) {
                    let spot = save.home_spot.unwrap_or_else(|| self.district_spot(save.home));
                    save.position = self.walkable_spot_near(spot, 25.0);
                }
                let entity = self.alloc_entity();
                let agent = FactionAgent::from_save(entity, save);
                let idx = self.agents.len();
                self.agent_by_entity.insert(entity, idx);
                self.agents.push(agent);
                self.regrid_agent(idx);
            }
            tracing::info!(agents = self.agents.len(), "faction agents restored");
            // One full-shard write so the sharded layout is complete before
            // the rotating saver takes over (this is also what migrates a
            // legacy single-blob save to shards).
            self.save_agent_shards_full();
            return;
        }
        let total: usize = std::env::var("WILDER_AGENTS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(25_000);
        self.seed_agents(total);
        let _ = self.store.save_meta("agent_seed_layout", &AGENT_SEED_LAYOUT);
        self.save_agent_shards_full();
        tracing::info!(agents = self.agents.len(), layout = AGENT_SEED_LAYOUT, "faction agents seeded");
    }

    /// Seed `total` agents with the Wape share from `WILDER_WAPE_SHARE`
    /// (percent, default 20).
    fn seed_agents(&mut self, total: usize) {
        let wape_share: u32 = std::env::var("WILDER_WAPE_SHARE")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(20)
            .min(100);
        self.seed_agents_with_wape_share(total, wape_share);
    }

    /// Seed `total` agents. `wape_share` percent seed as wild Wapes on
    /// scattered anchors across hostile ground (the retired NPC spawns'
    /// density feel: thinned inside the hub combat ring, denser outside).
    /// Of the organized remainder (50/50 Rebels/Forum), half is a **hub
    /// cohort** staged inside the spawn hub's combat ring (Rebels
    /// south-east, Forum north-west) so the faction war plays out on the
    /// starter playfield players actually see; the rest split by faction
    /// geography (Rebels southern districts, Forum northern), with
    /// randomized trait priors. Deterministic from the world seed.
    fn seed_agents_with_wape_share(&mut self, total: usize, wape_share: u32) {
        use rand::Rng;
        let mut seed_rng = SmallRng::seed_from_u64(self.seed ^ 0xA6E175);
        let defs = districts::district_defs();
        let wape_total = total * wape_share as usize / 100;
        let org_total = total - wape_total;
        let hub_cohort = org_total / 2;
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

        for n in 0..org_total {
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
            // No fixed roles: mild random trait priors start the population
            // diverse, then realized payoffs drive specialization.
            let traits = Traits::seeded(&mut seed_rng);
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
                    traits,
                    home,
                    home_spot,
                    purse: Purse::default(),
                    inventory: Inventory::new(),
                    blueprints: Vec::new(),
                    stash: Vec::new(),
                    pending_jobs: Vec::new(),
                    owner: None,
                    lifetime_owner_earnings: 0,
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
            self.regrid_agent(idx);
            self.grubstake_agent(idx);
        }

        // Wild Wapes: no guarded home district — each one anchors to a
        // scattered spot on hostile ground (`home_spot`) it stages at,
        // respawns at, and roams from. Scav-like and raider-like trait
        // priors replace the old fixed archetypes. Anchors come from a
        // bounded set of pack sites: each site probe generates fresh chunks
        // (rejection sampling over the whole map), so site count — not
        // population — bounds the seeding cost; a site hosts a small pack.
        if wape_total == 0 {
            return;
        }
        let site_count = wape_total.div_ceil(4).min(256);
        let sites: Vec<Vec3> =
            (0..site_count).map(|_| self.wape_anchor(&mut seed_rng)).collect();
        for n in 0..wape_total {
            let anchor = sites[n % sites.len()];
            let home = districts::district_of(anchor).map(|(i, _)| i).unwrap_or(0);
            let traits = Traits::wape_seeded(&mut seed_rng);
            let (agent_id, name) = mint_agent_name(FACTION_WAPES);
            let mut position = anchor;
            for _ in 0..8 {
                let c = anchor
                    + Vec3::new(
                        seed_rng.random_range(-20.0..20.0),
                        0.0,
                        seed_rng.random_range(-20.0..20.0),
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
                    faction: FACTION_WAPES,
                    guild: guild_for(FACTION_WAPES, home),
                    traits,
                    home,
                    home_spot: Some(anchor),
                    purse: Purse::default(),
                    inventory: Inventory::new(),
                    blueprints: Vec::new(),
                    stash: Vec::new(),
                    pending_jobs: Vec::new(),
                    owner: None,
                    lifetime_owner_earnings: 0,
                    position,
                    health: 100.0,
                    max_health: 100.0,
                },
            );
            agent.decision_timer = seed_rng.random_range(0.0..2.0);
            let idx = self.agents.len();
            self.agent_by_entity.insert(entity, idx);
            self.agents.push(agent);
            self.regrid_agent(idx);
            self.grubstake_agent(idx);
        }
    }

    /// Scattered home anchor for one seeded Wape: a walkable spot on hostile
    /// (Contested/Warzone) ground. Mirrors the retired per-chunk NPC spawn
    /// density feel — inside the hub combat ring only ~25% of samples are
    /// accepted, so packs thin out near spawn and thicken beyond it.
    fn wape_anchor(&mut self, rng: &mut SmallRng) -> Vec3 {
        use rand::Rng;
        for _ in 0..48 {
            let radius = rng.random_range(150.0..1500.0f32);
            let angle = rng.random_range(0.0..std::f32::consts::TAU);
            let candidate = Vec3::new(radius * angle.cos(), 0.0, radius * angle.sin());
            if radius < districts::HUB_COMBAT_RING_M && !rng.random_bool(0.25) {
                continue; // hub-ring thinning
            }
            if !matches!(
                districts::danger_at(candidate),
                DangerLevel::Contested | DangerLevel::Warzone
            ) {
                continue;
            }
            let spot = self.nearest_walkable(candidate);
            if matches!(
                districts::danger_at(spot),
                DangerLevel::Contested | DangerLevel::Warzone
            ) {
                return spot;
            }
        }
        self.nearest_walkable(HUB_FRONT_SPOT)
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
                self.register_static(StaticEntity {
                    entity,
                    kind,
                    position: pos,
                    name,
                    variant: 0,
                    agent_id: static_agent_id(self.seed, entity),
                });
            }
            // The district's staging spot: outside its first service door,
            // falling back to walkable ground near the raw anchor (baked
            // anchors are street centroids and can land on a building tile).
            self.district_spots[di] = first_pos.unwrap_or_else(|| self.nearest_walkable(anchor));
        }
        // Fresh storefronts open with a modest seeded shelf (persisted stock
        // entries are left alone — this only fills brand-new vendors).
        self.ensure_vendor_stock();
    }

    fn tick_loot(&mut self) {
        let now = self.world_seconds();
        // Auto-pickup: walking within range of any loot container (ammo
        // cache, agent/player drop) grabs it instantly.
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
            if !taken.is_empty() {
                player.dirty = true;
                let _ = player.tx.send(S2C::InventoryUpdate(player.inventory.clone()));
                let _ = player.tx.send(S2C::GatherResult { gained: taken.clone(), denied: false });
            } else if !container.items.is_empty() {
                // Full pack standing on loot: notify, but rate-limited so the
                // "Backpack full" toast + deny sound don't repeat every tick.
                if now - player.last_full_deny >= AUTO_PICKUP_DENY_COOLDOWN {
                    player.last_full_deny = now;
                    let _ = player
                        .tx
                        .send(S2C::GatherResult { gained: Vec::new(), denied: true });
                }
            }
            if empty {
                self.loot.remove(&cid);
            }
            let grabbed_any = !taken.is_empty();
            self.record_loot_pickup(picker, owner, in_supply, &taken);
            // Only ammo caches carry the small Energy charge; ordinary drops
            // (agent/player loot) don't mint currency on pickup.
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
    /// WalletUpdate and the pickup entity's despawn. Hot agents share the
    /// sweep (players get first grab) — this is how the crafting class earns
    /// the Energy its queues burn. Cold agents skip physical pickups.
    fn tick_currency_pickups(&mut self) {
        let mut grabbed: Vec<(EconActor, EntityId, Currency, u32)> = Vec::new();
        for player in self.players.values() {
            for pickup in self.pickups.values() {
                if (pickup.position - player.character.position).length()
                    <= CURRENCY_PICKUP_RADIUS
                {
                    grabbed.push((
                        EconActor::Player(player.entity),
                        pickup.entity,
                        pickup.currency,
                        pickup.amount,
                    ));
                }
            }
        }
        // Hot agents walking over a pickup collect it too. Pickups are few;
        // the agent grid bounds the candidate set to the pickup's own chunk
        // ring (the radius is well under a chunk).
        for pickup in self.pickups.values() {
            let c = ChunkCoord::from_world(pickup.position);
            'found: for dz in -1..=1 {
                for dx in -1..=1 {
                    let coord = ChunkCoord::new(c.x + dx, c.z + dz);
                    for &i in self.agent_grid.get(&coord).into_iter().flatten() {
                        let agent = &self.agents[i as usize];
                        if agent.tier == Tier::Hot
                            && agent.alive()
                            && (pickup.position - agent.position).length()
                                <= CURRENCY_PICKUP_RADIUS
                        {
                            grabbed.push((
                                EconActor::Agent(i as usize),
                                pickup.entity,
                                pickup.currency,
                                pickup.amount,
                            ));
                            break 'found;
                        }
                    }
                }
            }
        }
        for (actor, cid, currency, amount) in grabbed {
            // Someone else may have grabbed it earlier this pass.
            if self.pickups.remove(&cid).is_none() {
                continue;
            }
            self.grant_currency_actor(actor, currency, amount);
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
        self.agents.iter().filter(|a| a.alive()).count() as u32
    }

    // -----------------------------------------------------------------------
    // Leaderboards
    // -----------------------------------------------------------------------

    /// Competitor identity behind a live entity id (player or agent), for
    /// stat attribution.
    fn actor_ref(&self, entity: EntityId) -> Option<ActorRef> {
        if let Some(p) = self.players.get(&entity) {
            return Some(ActorRef {
                id: p.character.id,
                name: p.character.name.clone(),
                faction: p.character.faction,
                guild: None,
                is_player: true,
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
                faction: p.character.faction,
                guild: None,
                wealth: p.purse.carried(Currency::Wild) as i64
                    + p.purse.banked(Currency::Wild) as i64,
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
                wealth: a.wallet() as i64 + a.bank() as i64 + a.carried_value() as i64,
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
            self.zone_standings(),
        )
    }

    // -----------------------------------------------------------------------
    // Map intel (whole-map blips for the M overlay)
    // -----------------------------------------------------------------------

    /// The live map actors that actually move and stay few in number:
    /// players (kind 0) and nearby hot Wape agents (kind 2, the wild
    /// hostiles worth flagging on the minimap). Faction agents are shipped
    /// once as a static `MapCensus` on subscribe (see `map_census_blips`), so
    /// this ~5 Hz stream stays tiny no matter how big the population is.
    fn map_intel_blips(&self) -> Vec<AgentBlip> {
        let q = |v: f32| v.clamp(i16::MIN as f32, i16::MAX as f32) as i16;
        let mut blips: Vec<AgentBlip> = Vec::new();
        for p in self.players.values() {
            if p.character.health <= 0.0 {
                continue;
            }
            blips.push(AgentBlip {
                id: p.entity,
                faction: p.character.faction,
                kind: 0,
                x: q(p.character.position.x),
                z: q(p.character.position.z),
                count: 1,
            });
        }
        for &i in &self.hot_agents {
            let a = &self.agents[i as usize];
            if a.tier != Tier::Hot || !a.alive() || a.faction != FACTION_WAPES {
                continue;
            }
            blips.push(AgentBlip {
                id: a.entity,
                faction: FACTION_WAPES,
                kind: 2,
                x: q(a.position.x),
                z: q(a.position.z),
                count: 1,
            });
        }
        blips
    }

    /// One-time full census of every living faction agent as an individual
    /// static blip (kind 1). Sent when the map opens; the client renders it
    /// as a single point cloud that never updates per-frame. No cap and no
    /// clustering — the compact wire form (6 bytes/blip, no id/count) keeps
    /// even a 25k population to ~150 KB in a single frame.
    fn map_census_blips(&self) -> Vec<AgentBlip> {
        let q = |v: f32| v.clamp(i16::MIN as f32, i16::MAX as f32) as i16;
        let mut blips: Vec<AgentBlip> = Vec::with_capacity(self.agents.len());
        for a in &self.agents {
            if !a.alive() {
                continue;
            }
            blips.push(AgentBlip {
                id: 0,
                faction: a.faction,
                kind: 1,
                x: q(a.position.x),
                z: q(a.position.z),
                count: 1,
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

    /// Living faction agents in the ring just beyond a player's replicated
    /// entity view (`VIEW_RADIUS` chunks) out to `DOT_RADIUS_CHUNKS`, as
    /// compact static blips. These drive the client's third LOD tier: glowing
    /// dots for agents too far to be full rigs or capsule impostors. The inner
    /// view ring is skipped so a dot never doubles a replicated entity. Walks
    /// only the `agent_grid` buckets in the ring, so cost scales with local
    /// agent density, not the whole population; capped nearest-first.
    fn nearby_agent_dots(&self, origin: Vec3) -> Vec<AgentBlip> {
        let q = |v: f32| v.clamp(i16::MIN as f32, i16::MAX as f32) as i16;
        let center = ChunkCoord::from_world(origin);
        let mut ranked: Vec<(f32, AgentBlip)> = Vec::new();
        for dz in -DOT_RADIUS_CHUNKS..=DOT_RADIUS_CHUNKS {
            for dx in -DOT_RADIUS_CHUNKS..=DOT_RADIUS_CHUNKS {
                // Skip the inner replicated ring: those agents already draw as
                // full rigs / capsule impostors on the client.
                if dx.abs() <= VIEW_RADIUS && dz.abs() <= VIEW_RADIUS {
                    continue;
                }
                let coord = ChunkCoord::new(center.x + dx, center.z + dz);
                let Some(bucket) = self.agent_grid.get(&coord) else { continue };
                for &i in bucket {
                    let a = &self.agents[i as usize];
                    if !a.alive() {
                        continue;
                    }
                    let d2 = (a.position - origin).length_squared();
                    ranked.push((
                        d2,
                        AgentBlip {
                            id: 0,
                            faction: a.faction,
                            kind: 1,
                            x: q(a.position.x),
                            z: q(a.position.z),
                            count: 1,
                        },
                    ));
                }
            }
        }
        if ranked.len() > DOT_MAX {
            ranked.select_nth_unstable_by(DOT_MAX, |a, b| a.0.total_cmp(&b.0));
            ranked.truncate(DOT_MAX);
        }
        ranked.into_iter().map(|(_, b)| b).collect()
    }

    /// Push the far-agent dot feed to every in-world player (always on, no
    /// subscription — this is a live-map LOD layer, not a menu overlay).
    fn broadcast_agent_dots(&self) {
        for p in self.players.values() {
            let blips = self.nearby_agent_dots(p.character.position);
            let _ = p.tx.send(S2C::AgentDots { blips });
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

    /// Watch (or stop watching) one item's market detail. Subscribing answers
    /// immediately with a full `ItemMarketState`; while watched, new fills
    /// re-push the state (throttled by `broadcast_item_markets`).
    fn item_market_sub(&mut self, entity: EntityId, kind: Option<ItemKind>) {
        let Some(kind) = kind else {
            self.item_subs.remove(&entity);
            return;
        };
        let state = self.item_market_state(kind);
        if let Some(player) = self.players.get(&entity) {
            let _ = player.tx.send(S2C::ItemMarketState(state));
            self.item_subs.insert(entity, kind);
        }
    }

    /// Build the market detail snapshot for one item kind: price series +
    /// totals from `market_stats`, live book stats, ledger supply, and the
    /// fixed vendor reference prices.
    fn item_market_state(&self, kind: ItemKind) -> ItemMarketState {
        let (series, recent_fills, last_price, total_fills, total_units, total_wild) =
            match self.market_stats.history(kind) {
                Some(h) => (
                    h.buckets.iter().copied().collect(),
                    // Tape goes out newest-first: that's the render order.
                    h.recent.iter().rev().cloned().collect(),
                    h.last_price,
                    h.total_fills,
                    h.total_units,
                    h.total_wild,
                ),
                None => (Vec::new(), Vec::new(), 0, 0, 0, 0),
            };
        let mut best_ask = 0u32;
        let mut listed_units = 0u32;
        for l in self.market.iter().filter(|l| l.kind == kind && l.count > 0) {
            listed_units += l.count;
            if best_ask == 0 || l.price_each < best_ask {
                best_ask = l.price_each;
            }
        }
        let (vendor_buy, vendor_sell) = wilder_economy::reference_prices(kind);
        ItemMarketState {
            kind,
            series,
            last_price,
            best_ask,
            listed_units,
            total_fills,
            total_units,
            total_wild,
            supply: self.ledger.item_supply(kind),
            vendor_buy,
            vendor_sell,
            recent_fills,
        }
    }

    /// Re-push item market detail to watchers whose kind saw new fills since
    /// the last broadcast (called on a ~1 s cadence from the tick loop).
    fn broadcast_item_markets(&mut self) {
        if self.item_subs.is_empty() {
            // Nobody watching: drop the dirty set so it can't grow unbounded.
            self.market_stats.take_dirty();
            return;
        }
        let dirty = self.market_stats.take_dirty();
        if dirty.is_empty() {
            return;
        }
        self.item_subs.retain(|id, _| self.players.contains_key(id));
        let watchers: Vec<(EntityId, ItemKind)> = self
            .item_subs
            .iter()
            .filter(|(_, kind)| dirty.contains(kind))
            .map(|(&id, &kind)| (id, kind))
            .collect();
        for (id, kind) in watchers {
            let state = self.item_market_state(kind);
            if let Some(player) = self.players.get(&id) {
                let _ = player.tx.send(S2C::ItemMarketState(state));
            }
        }
    }

    // -----------------------------------------------------------------------
    // Owned agents: hire / dismiss / roster + detail subscriptions
    // -----------------------------------------------------------------------

    /// Rebuild the owner → agent-indices index from scratch (startup, after
    /// `load_or_seed_agents`). Hire/dismiss maintain it incrementally; agent
    /// indices are stable across respawn (the slot is reused), so nothing
    /// else ever needs to touch it.
    fn rebuild_owned_agents(&mut self) {
        self.owned_agents.clear();
        for (idx, agent) in self.agents.iter().enumerate() {
            if let Some(owner) = agent.owner {
                self.owned_agents.entry(owner).or_default().push(idx);
            }
        }
    }

    /// MILD price to hire this agent: `base + total wealth / 2 + rate *
    /// strongest trait payoff`. Wealth (carried + banked MILD) prices the
    /// balance sheet you'd start earning a share of; the strongest payoff
    /// EMA (MILD/min) prices proven skill. A character's FIRST hire is free
    /// (starter grant) — that discount is applied at charge time, not here.
    fn agent_hire_cost(&self, idx: usize) -> u32 {
        let a = &self.agents[idx];
        let wealth = a.purse.carried(Currency::Wild) + a.purse.banked(Currency::Wild);
        let strongest = a.traits.payoff.iter().fold(0.0f32, |m, &p| m.max(p));
        AGENT_HIRE_BASE + wealth / 2 + (strongest * AGENT_HIRE_TRAIT_RATE) as u32
    }

    fn send_agent_result(&self, entity: EntityId, ok: bool, error: Option<String>) {
        if let Some(player) = self.players.get(&entity) {
            let _ = player.tx.send(S2C::AgentResult { ok, error });
        }
    }

    /// Roster line for one agent. `hire_cost` is only filled for
    /// `AgentHireOffers` candidates.
    fn agent_summary(&self, idx: usize, hire_cost: Option<u32>) -> AgentSummary {
        let a = &self.agents[idx];
        AgentSummary {
            agent_id: a.agent_id,
            name: a.name.clone(),
            faction: a.faction,
            guild: a.guild.clone(),
            archetype: a.traits.archetype().to_string(),
            activity: if a.alive() { goal_activity_label(a.goal).to_string() } else { "Dead".to_string() },
            health: a.health.max(0.0),
            max_health: a.max_health,
            x: a.position.x,
            z: a.position.z,
            carried_wild: a.purse.carried(Currency::Wild),
            banked_wild: a.purse.banked(Currency::Wild),
            lifetime_owner_earnings: a.lifetime_owner_earnings,
            hire_cost,
        }
    }

    /// Immediate `AgentRoster` push of this player's owned agents.
    fn send_agent_roster(&self, entity: EntityId) {
        let Some(player) = self.players.get(&entity) else { return };
        let agents = self
            .owned_agents
            .get(&player.character.id)
            .map(|idxs| idxs.iter().map(|&i| self.agent_summary(i, None)).collect())
            .unwrap_or_default();
        let _ = player.tx.send(S2C::AgentRoster { agents });
    }

    /// Roster refresh on hire/dismiss for players who are subscribed.
    fn refresh_agent_roster(&self, entity: EntityId) {
        if self.players.get(&entity).is_some_and(|p| p.agent_sub) {
            self.send_agent_roster(entity);
        }
    }

    /// `C2S::HireAgent`: take ownership of an unowned, living, same-faction
    /// agent. The first hire per character is free (starter grant); later
    /// hires charge `agent_hire_cost` MILD from the carried wallet and burn
    /// the fee (a MILD sink — nobody sold the agent).
    fn hire_agent(&mut self, entity: EntityId, agent_id: AgentId) {
        let Some(player) = self.players.get(&entity) else { return };
        let char_id = player.character.id;
        let faction = player.character.faction;
        let Some(idx) = self.agents.iter().position(|a| a.agent_id == agent_id) else {
            self.send_agent_result(entity, false, Some("agent not found".into()));
            return;
        };
        if self.agents[idx].owner.is_some() {
            self.send_agent_result(entity, false, Some("agent already has an employer".into()));
            return;
        }
        if !self.agents[idx].alive() {
            self.send_agent_result(entity, false, Some("agent is dead".into()));
            return;
        }
        if self.agents[idx].faction != faction {
            self.send_agent_result(entity, false, Some("agent serves another faction".into()));
            return;
        }
        let owned = self.owned_agents.get(&char_id).map_or(0, |v| v.len());
        if owned >= MAX_OWNED_AGENTS {
            self.send_agent_result(
                entity,
                false,
                Some(format!("roster full ({MAX_OWNED_AGENTS} agents max)")),
            );
            return;
        }
        // Starter grant: the first agent is free so every character can get
        // into the management game.
        let cost = if owned == 0 { 0 } else { self.agent_hire_cost(idx) };
        if cost > 0 {
            let Some(p) = self.players.get_mut(&entity) else { return };
            if !p.purse.debit(Currency::Wild, cost) {
                self.send_agent_result(entity, false, Some("not enough carried MILD".into()));
                return;
            }
            p.dirty = true;
            let party = player_party(p);
            self.persist_actor_purse(EconActor::Player(entity));
            // The fee leaves supply — hiring is a sink, not a payment to
            // anyone. WalletUpdate flows on the next replicate pass.
            self.ledger.record(
                TxKind::AgentHire,
                party,
                TxParty::Burn,
                TxAmount::Wild { amount: cost },
                0,
            );
        }
        self.agents[idx].owner = Some(char_id);
        self.owned_agents.entry(char_id).or_default().push(idx);
        // Owned agents get a live activity log from the moment of hire.
        let mut log = VecDeque::with_capacity(AGENT_LOG_CAP);
        log.push_back(AgentLogEntry {
            at_ms: ledger::unix_ms(),
            text: if cost == 0 {
                "Hired (starter grant — free)".to_string()
            } else {
                format!("Hired for {cost} MILD")
            },
        });
        self.agent_logs.insert(agent_id, log);
        self.send_agent_result(entity, true, None);
        self.refresh_agent_roster(entity);
    }

    /// `C2S::DismissAgent`: release an owned agent back to its faction. No
    /// refund; the agent keeps everything it earned.
    fn dismiss_agent(&mut self, entity: EntityId, agent_id: AgentId) {
        let Some(player) = self.players.get(&entity) else { return };
        let char_id = player.character.id;
        let Some(idx) = self.agents.iter().position(|a| a.agent_id == agent_id) else {
            self.send_agent_result(entity, false, Some("agent not found".into()));
            return;
        };
        if self.agents[idx].owner != Some(char_id) {
            self.send_agent_result(entity, false, Some("not your agent".into()));
            return;
        }
        self.agents[idx].owner = None;
        if let Some(idxs) = self.owned_agents.get_mut(&char_id) {
            idxs.retain(|&i| i != idx);
            if idxs.is_empty() {
                self.owned_agents.remove(&char_id);
            }
        }
        self.agent_logs.remove(&agent_id);
        // Anyone watching this agent's detail loses access with the dismissal.
        for p in self.players.values_mut() {
            if p.agent_detail == Some(idx) {
                p.agent_detail = None;
            }
        }
        self.send_agent_result(entity, true, None);
        self.refresh_agent_roster(entity);
    }

    /// `C2S::AgentHireList`: up to `AGENT_HIRE_OFFERS` unowned, living,
    /// same-faction candidates, cheapest first, each carrying its computed
    /// `hire_cost` (the starter grant makes the actual first charge 0
    /// regardless of the displayed price).
    fn agent_hire_list(&mut self, entity: EntityId) {
        let Some(player) = self.players.get(&entity) else { return };
        let faction = player.character.faction;
        let mut candidates: Vec<(u32, usize)> = self
            .agents
            .iter()
            .enumerate()
            .filter(|(_, a)| a.owner.is_none() && a.alive() && a.faction == faction)
            .map(|(i, _)| (self.agent_hire_cost(i), i))
            .collect();
        candidates.sort_by_key(|&(cost, _)| cost);
        candidates.truncate(AGENT_HIRE_OFFERS);
        let offers: Vec<AgentSummary> =
            candidates.iter().map(|&(cost, i)| self.agent_summary(i, Some(cost))).collect();
        if let Some(player) = self.players.get(&entity) {
            let _ = player.tx.send(S2C::AgentHireOffers { offers });
        }
    }

    /// `C2S::AgentSub`: subscribe answers immediately with the owned-agent
    /// roster, then `broadcast_agent_rosters` re-sends every
    /// `AGENT_ROSTER_TICK_INTERVAL` ticks while on.
    fn agent_sub(&mut self, entity: EntityId, on: bool) {
        let Some(player) = self.players.get_mut(&entity) else { return };
        player.agent_sub = on;
        if on {
            self.send_agent_roster(entity);
        }
    }

    /// `C2S::AgentDetailSub`: watch one OWNED agent's full detail (immediate
    /// snapshot + ~1 Hz re-push). `None` unsubscribes.
    fn agent_detail_sub(&mut self, entity: EntityId, agent_id: Option<AgentId>) {
        let Some(agent_id) = agent_id else {
            if let Some(player) = self.players.get_mut(&entity) {
                player.agent_detail = None;
            }
            return;
        };
        let Some(player) = self.players.get(&entity) else { return };
        let char_id = player.character.id;
        let Some(idx) = self.agents.iter().position(|a| a.agent_id == agent_id) else {
            self.send_agent_result(entity, false, Some("agent not found".into()));
            return;
        };
        if self.agents[idx].owner != Some(char_id) {
            self.send_agent_result(entity, false, Some("not your agent".into()));
            return;
        }
        if let Some(player) = self.players.get_mut(&entity) {
            player.agent_detail = Some(idx);
        }
        let detail = self.agent_detail_snapshot(idx);
        if let Some(player) = self.players.get(&entity) {
            let _ = player.tx.send(S2C::AgentDetail(detail));
        }
    }

    /// Full `AgentDetail` payload for one agent: summary + goal prose +
    /// learned traits + competition stats + full economic state + activity
    /// log + its slice of the recent ledger.
    fn agent_detail_snapshot(&self, idx: usize) -> AgentDetail {
        let a = &self.agents[idx];
        let stats = self
            .stats
            .actors
            .get(&a.agent_id)
            .map(|s| AgentStats {
                kills: s.kills,
                deaths: s.deaths,
                resources: s.resources,
                trades: s.trades,
                crafted: s.crafted,
            })
            .unwrap_or_default();
        let mut blueprints: Vec<String> = a.blueprints.iter().cloned().collect();
        blueprints.sort();
        let me = a.agent_id;
        let is_me = |p: &TxParty| matches!(p, TxParty::Agent { id, .. } if *id == me);
        let recent_txs: Vec<EconTx> = self
            .ledger
            .recent()
            .into_iter()
            .rev()
            .filter(|tx| is_me(&tx.from) || is_me(&tx.to))
            .take(20)
            .collect();
        AgentDetail {
            summary: self.agent_summary(idx, None),
            goal: self.agent_goal_description(idx),
            traits: ACTIVITIES
                .iter()
                .map(|&act| (activity_name(act).to_string(), a.traits.payoff[act.index()]))
                .collect(),
            stats,
            inventory: a.inventory.clone(),
            blueprints,
            carried: [
                a.purse.carried(Currency::Wild),
                a.purse.carried(Currency::Shards),
                a.purse.carried(Currency::Energy),
            ],
            banked: [
                a.purse.banked(Currency::Wild),
                a.purse.banked(Currency::Shards),
                a.purse.banked(Currency::Energy),
            ],
            activity_log: self
                .agent_logs
                .get(&a.agent_id)
                .map(|d| d.iter().cloned().collect())
                .unwrap_or_default(),
            recent_txs,
        }
    }

    /// Fuller prose description of an agent's current goal, including its
    /// target where one exists ("Selling goods at the Bodega").
    fn agent_goal_description(&self, idx: usize) -> String {
        let a = &self.agents[idx];
        if !a.alive() {
            return "Dead — waiting to respawn".to_string();
        }
        let building = |e: EntityId| -> String {
            self.statics
                .get(&e)
                .map(|s| format!("{:?}", s.kind))
                .unwrap_or_else(|| "a building".to_string())
        };
        match a.goal {
            Goal::Idle => "Idle — waiting for the next opportunity".to_string(),
            Goal::Gather { pulls_left, .. } => {
                format!("Gathering resources ({pulls_left} pulls left)")
            }
            Goal::Sell { store, list_on_market, .. } => {
                if list_on_market {
                    "Hauling goods to the market terminal".to_string()
                } else {
                    format!("Selling goods at the {}", building(store))
                }
            }
            Goal::Buy { store, kind, count, .. } => {
                format!("Buying {count} {} at the {}", kind.display_name(), building(store))
            }
            Goal::BuyMarket { kind, count, max_each, .. } => format!(
                "Buying {count} {} on the market (up to {max_each} MILD each)",
                kind.display_name()
            ),
            Goal::Trade { .. } => "Working the market terminal for arbitrage".to_string(),
            Goal::Craft { recipe, .. } => format!("Crafting {recipe} at a station"),
            Goal::Research { recipe, .. } => {
                format!("Researching {recipe} at the Laboratory")
            }
            Goal::Collect { building: b, .. } => {
                format!("Collecting finished goods at the {}", building(b))
            }
            Goal::Patrol { .. } => "Patrolling contested ground".to_string(),
            Goal::Capture { region, .. } => {
                format!("Capturing region ({}, {})", region.0, region.1)
            }
            Goal::Defend { region, .. } => {
                format!("Defending region ({}, {})", region.0, region.1)
            }
            Goal::Hunt { .. } => "Hunting a hostile target".to_string(),
            Goal::Retreat { .. } => "Retreating to a sanctuary to heal".to_string(),
            Goal::Loot { .. } => "Grabbing a loot drop".to_string(),
            Goal::Bank { store, .. } => {
                format!("Hauling wealth to the {} vault", building(store))
            }
            Goal::Extract { store, .. } => {
                format!("Stashing cargo at the {}", building(store))
            }
        }
    }

    /// Append one line to an OWNED agent's activity ring. No-op for unowned
    /// agents (only hire creates the map entry), which keeps the map bounded
    /// by the number of owned agents.
    fn push_agent_log(&mut self, agent_id: AgentId, text: String) {
        if let Some(log) = self.agent_logs.get_mut(&agent_id) {
            if log.len() >= AGENT_LOG_CAP {
                log.pop_front();
            }
            log.push_back(AgentLogEntry { at_ms: ledger::unix_ms(), text });
        }
    }

    /// Route the owner's cut of an owned agent's bank deposit: debit the
    /// agent's carried MILD and land it in the owner's BANKED wild (online
    /// wallets update in place + WalletUpdate on the next replicate pass;
    /// offline accounts get a write-through bank credit). Records the
    /// `OwnerShare` ledger leg agent → player.
    fn pay_owner_share(&mut self, idx: usize, share: u32) {
        let Some(owner) = self.agents[idx].owner else { return };
        if share == 0 || !self.agents[idx].purse.debit(Currency::Wild, share) {
            return;
        }
        self.agents[idx].lifetime_owner_earnings += share as u64;
        let agent_party = self.agents[idx].party();
        let online =
            self.players.iter().find(|(_, p)| p.character.id == owner).map(|(&e, _)| e);
        let to_party = if let Some(e) = online {
            let p = self.players.get_mut(&e).unwrap();
            // Straight into the vault: credit carried then move it banked.
            p.purse.credit(Currency::Wild, share);
            p.purse.deposit(Currency::Wild, share);
            p.dirty = true;
            let party = player_party(p);
            self.persist_actor_purse(EconActor::Player(e));
            party
        } else if let Ok(ch) = self.store.character(owner) {
            if let Ok(account) = self.store.account_by_id(ch.account_id) {
                let _ = self.store.update_bank(account.id, account.bank + share);
            }
            TxParty::Player { id: owner, name: ch.name, faction: ch.faction }
        } else {
            // Owner character vanished from the store: put the cut back.
            self.agents[idx].purse.credit(Currency::Wild, share);
            self.agents[idx].lifetime_owner_earnings -= share as u64;
            return;
        };
        self.ledger.record(
            TxKind::OwnerShare,
            agent_party,
            to_party,
            TxAmount::Wild { amount: share },
            0,
        );
    }

    /// Re-send `AgentRoster` to subscribed players (~2 s cadence).
    fn broadcast_agent_rosters(&mut self) {
        let subs: Vec<EntityId> =
            self.players.iter().filter(|(_, p)| p.agent_sub).map(|(&e, _)| e).collect();
        for e in subs {
            self.send_agent_roster(e);
        }
    }

    /// Re-push `AgentDetail` to watchers (~1 Hz), dropping watches whose
    /// ownership lapsed (dismissed from another session, etc).
    fn broadcast_agent_details(&mut self) {
        let watches: Vec<(EntityId, usize, CharacterId)> = self
            .players
            .iter()
            .filter_map(|(&e, p)| p.agent_detail.map(|idx| (e, idx, p.character.id)))
            .collect();
        for (e, idx, char_id) in watches {
            if self.agents.get(idx).is_none_or(|a| a.owner != Some(char_id)) {
                if let Some(p) = self.players.get_mut(&e) {
                    p.agent_detail = None;
                }
                continue;
            }
            let detail = self.agent_detail_snapshot(idx);
            if let Some(player) = self.players.get(&e) {
                let _ = player.tx.send(S2C::AgentDetail(detail));
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
                self.register_static(StaticEntity {
                    entity,
                    kind,
                    position: pos,
                    name: name.into(),
                    variant: 0,
                    agent_id: static_agent_id(self.seed, entity),
                });
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

    /// Every persistent service building, for the map/legend UI.
    fn poi_list(&self) -> Vec<PoiInfo> {
        let mut pois: Vec<PoiInfo> = self
            .statics
            .values()
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
        // Resource nodes materialize through the view-independent path (the
        // same one agent gather targeting uses).
        self.ensure_nodes(coord);
        // Per-chunk world content: ammo caches (service buildings are seeded
        // eagerly by `seed_district` at world start).
        if !self.static_seeded_chunks.contains(&coord) {
            self.static_seeded_chunks.insert(coord);
            // Ammo caches everywhere (including the safe hub) so ammo is easy
            // to find and obvious. Persistent until looted.
            let chunk = self.chunks.get(coord);
            for pos in ammo_cache_spots(&chunk, coord, AMMO_CACHE_COUNT) {
                self.spawn_ammo_cache(pos, AMMO_CACHE_ROUNDS);
            }
        }
    }

    /// Materialize the chunk's resource nodes on first access from ANY path —
    /// player chunk streaming or agent gather targeting — so mining works the
    /// same across the whole map, not just where players have looked.
    /// Placement is a pure function of the chunk coord (hash + deterministic
    /// walkable-tile scan), so whichever actor arrives first creates the
    /// identical nodes. Materialized chunks are tracked forever (nodes stay
    /// resident once created, they are never evicted); the set check keeps
    /// repeat calls nearly free on the agent decision hot path. The world is
    /// never materialized eagerly — only chunks someone actually reaches.
    fn ensure_nodes(&mut self, coord: ChunkCoord) {
        if !self.node_seeded_chunks.insert(coord) {
            return;
        }
        if is_safe_chunk(coord) {
            return;
        }
        let per_chunk = self.node_tuning.per_chunk;
        if per_chunk == 0 {
            return;
        }
        let chunk = self.chunks.get(coord);
        let zone = zone_of_chunk(coord);
        let nh = (coord.x.wrapping_mul(198491317) ^ coord.z.wrapping_mul(6542989)) as u32;
        // Each node scans its own z-band of the chunk for the first walkable
        // tile, spreading the deposits across the chunk deterministically
        // (bands with no walkable ground simply host no node).
        let band = ((TILES_PER_CHUNK - 3) / per_chunk).max(1);
        for i in 0..per_chunk {
            let z0 = 3 + i * band;
            let z1 =
                if i + 1 == per_chunk { TILES_PER_CHUNK } else { (z0 + band).min(TILES_PER_CHUNK) };
            let mut placed = None;
            'scan: for tz in (z0..z1).step_by(2) {
                for tx in (4..TILES_PER_CHUNK).step_by(2) {
                    if chunk.tile(tx, tz).walkable() {
                        placed = Some((tx, tz));
                        break 'scan;
                    }
                }
            }
            let Some((tx, tz)) = placed else { continue };
            // Zone-weighted resource, varied per node so a chunk's deposits
            // aren't all clones of each other.
            let variant = wilder_economy::zone_resource_index(
                zone,
                (nh >> 8).wrapping_add(i as u32).wrapping_mul(0x9E37_79B9),
            ) as u32;
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
                    charges: self.node_tuning.charges,
                    last_gather: f64::NEG_INFINITY,
                    depleted_at: 0.0,
                },
            );
            self.nodes_by_chunk.entry(coord).or_default().push(entity);
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
            /// Hot faction agent: subject to the per-player nearest-K cap.
            is_agent: bool,
        }

        let mut all: Vec<Replicated> = Vec::new();
        for p in self.players.values() {
            all.push(Replicated {
                id: p.entity,
                chunk: ChunkCoord::from_world(p.character.position),
                spawn: p.spawn_data(),
                snap: p.snapshot(),
                is_agent: false,
            });
        }
        // Hot faction agents replicate as full entities (cold agents don't
        // exist as entities; tier flips drive spawn/despawn through the
        // known-entity diff below). The hot list keeps this off the whole
        // population.
        for &i in &self.hot_agents {
            let agent = &self.agents[i as usize];
            if agent.tier != Tier::Hot || !agent.alive() {
                continue;
            }
            all.push(Replicated {
                id: agent.entity,
                chunk: agent.chunk(),
                spawn: agent.spawn_data(factions::faction_color(agent.faction)),
                snap: agent.snapshot(),
                is_agent: true,
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
                is_agent: false,
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
                        Currency::Wild => "MILD".into(),
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
                is_agent: false,
            });
        }
        // Nodes: only chunks in some player's view are walked, so this costs
        // nothing per node the agent population has materialized elsewhere.
        // The lazy respawn is evaluated in passing (read-only), so a node
        // that came back while untouched pops in for approaching players;
        // depleted nodes despawn until their respawn clock runs out.
        {
            let now = self.world_seconds();
            let tuning = self.node_tuning;
            let mut viewed: HashSet<ChunkCoord> = HashSet::new();
            for p in self.players.values() {
                viewed.extend(p.view.iter().copied());
            }
            for coord in viewed {
                for &id in self.nodes_by_chunk.get(&coord).into_iter().flatten() {
                    let Some(node) = self.nodes.get(&id) else { continue };
                    let charges = node.charges_at(now, tuning.charges, tuning.respawn_seconds);
                    if charges == 0 {
                        continue;
                    }
                    let kind = wilder_economy::node_yield(node.variant);
                    let health = charges as f32 / tuning.charges as f32;
                    all.push(Replicated {
                        id: node.entity,
                        chunk: coord,
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
                        is_agent: false,
                    });
                }
            }
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
                is_agent: false,
            });
        }

        for player in self.players.values_mut() {
            // Push currency balances whenever any of them changed (join,
            // vendor/market/bank flows, salvage, energy grants).
            let balances = (
                player.purse.carried(Currency::Wild),
                player.purse.banked(Currency::Wild),
                player.purse.carried(Currency::Shards),
                player.purse.banked(Currency::Shards),
                player.purse.carried(Currency::Energy),
                player.purse.banked(Currency::Energy),
            );
            if player.wallet_sent != Some(balances) {
                player.wallet_sent = Some(balances);
                let _ = player.tx.send(S2C::WalletUpdate {
                    wild: balances.0,
                    bank: balances.1,
                    shards: balances.2,
                    bank_shards: balances.3,
                    energy: balances.4,
                    bank_energy: balances.5,
                });
            }
            let mut visible: Vec<EntitySnapshot> = Vec::new();
            let mut visible_ids: HashSet<EntityId> = HashSet::new();

            // Cap the hot agents shipped to this player to the nearest K.
            // The pre-pass ranks agents in view by distance; `agent_keep`
            // is None when everyone fits under the cap.
            let mut agent_rank: Vec<(EntityId, f32)> = Vec::new();
            let ppos = player.character.position;
            for r in &all {
                if r.is_agent && player.view.contains(&r.chunk) {
                    agent_rank.push((r.id, (r.snap.position - ppos).length_squared()));
                }
            }
            let agent_keep: Option<HashSet<EntityId>> =
                if agent_rank.len() > REPLICATED_AGENT_CAP {
                    agent_rank.sort_unstable_by(|a, b| a.1.total_cmp(&b.1));
                    let mut keep: HashSet<EntityId> =
                        agent_rank[..REPLICATED_AGENT_CAP].iter().map(|(id, _)| *id).collect();
                    // Hysteresis: already-known agents past the cap survive up
                    // to the softer keep limit instead of despawning at once.
                    for (id, _) in &agent_rank[REPLICATED_AGENT_CAP..] {
                        if keep.len() >= REPLICATED_AGENT_KEEP {
                            break;
                        }
                        if player.known_entities.contains(id) {
                            keep.insert(*id);
                        }
                    }
                    Some(keep)
                } else {
                    None
                };

            for r in &all {
                if !player.view.contains(&r.chunk) {
                    continue;
                }
                if r.is_agent {
                    if let Some(keep) = &agent_keep {
                        if !keep.contains(&r.id) {
                            continue;
                        }
                    }
                }
                visible_ids.insert(r.id);
                if !player.known_entities.contains(&r.id) {
                    let _ = player.tx.send(S2C::EntitySpawn(r.spawn.clone()));
                }
                // Delta replication: resend only entities whose quantized
                // state changed since this player's last snapshot of them.
                // The local player's own entity always ships — its snapshot
                // carries the input-ack reconciliation on the client.
                let q = SentSnap::quantize(&r.snap);
                let changed = player.sent_snaps.get(&r.id) != Some(&q);
                if changed || r.id == player.entity {
                    if changed {
                        player.sent_snaps.insert(r.id, q);
                    }
                    visible.push(q.to_wire(r.id));
                }
            }

            for gone in player.known_entities.difference(&visible_ids) {
                let _ = player.tx.send(S2C::EntityDespawn { id: *gone });
                player.sent_snaps.remove(gone);
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
        // Per-item market price history (dashboard charts).
        if let Err(e) = self.store.save_meta("market_stats", &self.market_stats.save()) {
            tracing::error!("market stats save failed: {e}");
        }
        // Faction agents persist separately in rotating shards (see
        // `tick_agent_saves`) so this pass never serializes the population.
        // Leaderboard stats book (competitor records + lifetime rollups).
        if let Err(e) = self.store.save_meta("stats_book", &self.stats) {
            tracing::error!("stats save failed: {e}");
        }
        // Production queues + output buffers (jobs keep running while their
        // owner is offline, so both must survive restarts).
        if self.production_dirty {
            let queues: Vec<(EntityId, Vec<ProductionJobSave>)> = self
                .production
                .iter()
                .map(|(&b, jobs)| (b, jobs.iter().map(|j| j.to_save()).collect()))
                .collect();
            let outputs: Vec<(EntityId, OwnerId, Vec<ItemStack>)> = self
                .production_outputs
                .iter()
                .map(|(&(b, o), stacks)| (b, o, stacks.clone()))
                .collect();
            match self
                .store
                .save_meta("production_queues", &queues)
                .and_then(|()| self.store.save_meta("production_outputs", &outputs))
            {
                Ok(()) => self.production_dirty = false,
                Err(e) => tracing::error!("production save failed: {e}"),
            }
        }
        // Vendor shelves: persist stock when it changed since the last save.
        if self.vendor_stock_dirty {
            let shelves: Vec<(EntityId, Vec<ItemStack>)> =
                self.vendor_stock.iter().map(|(&v, stacks)| (v, stacks.clone())).collect();
            match self.store.save_meta("vendor_stock", &shelves) {
                Ok(()) => self.vendor_stock_dirty = false,
                Err(e) => tracing::error!("vendor stock save failed: {e}"),
            }
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
            chunks = self.chunks.loaded_count(),
            "world saved"
        );
    }

    /// Persist one shard of the agent population, round-robin. Sharding
    /// bounds the per-tick serialization cost at `AGENT_SAVE_SHARD` agents;
    /// the stride spreads the shards so the whole population still cycles
    /// through roughly every `SAVE_INTERVAL_TICKS` (each agent's saved state
    /// is at most ~10 s stale, same as every other persisted system).
    fn tick_agent_saves(&mut self) {
        if self.agents.is_empty() {
            return;
        }
        let shards = self.agents.len().div_ceil(AGENT_SAVE_SHARD);
        let stride = (SAVE_INTERVAL_TICKS / shards as u64).max(1);
        if self.tick % stride != 0 {
            return;
        }
        let shard = self.agent_save_cursor % shards;
        self.agent_save_cursor = (shard + 1) % shards;
        self.save_agent_shard(shard);
    }

    /// Serialize and store agents `[shard * AGENT_SAVE_SHARD, ..)`.
    fn save_agent_shard(&self, shard: usize) {
        let lo = shard * AGENT_SAVE_SHARD;
        let hi = (lo + AGENT_SAVE_SHARD).min(self.agents.len());
        let saves: Vec<AgentSave> = self.agents[lo..hi].iter().map(|a| a.save()).collect();
        if let Err(e) = self.store.save_meta(&format!("faction_agents_shard_{shard}"), &saves) {
            tracing::error!("agent shard save failed: {e}");
        }
    }

    /// Reclaim disk when the store crosses the high-water mark by purging
    /// throwaway guest accounts (and their characters/inventory/stash/sessions
    /// + leaderboard rows). Currently-connected accounts are always spared, and
    /// deletions are bounded per pass so a big backlog drains over successive
    /// checks rather than stalling one tick. The space is only physically
    /// released by compaction, which runs off-thread so the sim keeps ticking.
    fn tick_disk_guard(&mut self) {
        let used = self.store.on_disk_bytes();
        let high_water = disk_high_water_bytes();
        if used < high_water {
            return;
        }

        let older_than = now_unix().saturating_sub(guest_min_age_secs());
        let active: HashSet<AccountId> =
            self.players.values().map(|p| p.character.account_id).collect();
        let report = match self.store.purge_stale_guests(
            &active,
            GUEST_PREFIX,
            older_than,
            MAX_PURGE_PER_PASS,
        ) {
            Ok(report) => report,
            Err(e) => {
                tracing::error!("disk purge failed: {e}");
                return;
            }
        };

        if report.is_empty() {
            tracing::warn!(
                used_gb = used as f64 / GIB,
                high_water_gb = high_water as f64 / GIB,
                "disk over high-water but no purgeable guest accounts found"
            );
            return;
        }

        // Drop leaderboard/stats rows for the removed characters (keyed by
        // character id) so the books don't retain ghost competitors.
        for cid in &report.character_ids {
            self.stats.actors.remove(cid);
        }

        tracing::warn!(
            used_gb = used as f64 / GIB,
            accounts = report.accounts_deleted,
            characters = report.character_ids.len(),
            sessions = report.sessions_deleted,
            "purged stale guest accounts to reclaim disk"
        );

        // Physically release the freed space via a full compaction, off the sim
        // thread. Skip if a previous compaction is still running.
        use std::sync::atomic::Ordering;
        if PURGE_COMPACTING
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
        {
            let store = Arc::clone(&self.store);
            std::thread::spawn(move || {
                store.compact();
                PURGE_COMPACTING.store(false, Ordering::Release);
            });
        }
    }

    /// Write the whole population (every shard + the shard-count descriptor)
    /// in one pass. Runs once at startup right after load/seed so the shard
    /// set is complete and self-consistent before the rotating saver takes
    /// over; also migrates legacy single-blob saves to the sharded layout.
    fn save_agent_shards_full(&mut self) {
        let shards = self.agents.len().div_ceil(AGENT_SAVE_SHARD).max(1);
        if let Err(e) = self.store.save_meta("faction_agents_shards", &shards) {
            tracing::error!("agent shard descriptor save failed: {e}");
            return;
        }
        for shard in 0..shards {
            self.save_agent_shard(shard);
        }
        self.agent_save_cursor = 0;
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

// ---------------------------------------------------------------------------
// Headless benchmark
// ---------------------------------------------------------------------------

/// Headless load harness (`cargo run -p wilder-world --release --bin
/// worldbench`): seeds a fresh world in a throwaway store, parks fake
/// players on the hub combat ring so agents around them go hot, steps the
/// world directly (no tokio runtime, no sleeping between ticks) and prints
/// tick percentiles, the per-phase breakdown and player-0's wire bandwidth.
pub mod bench {
    use super::*;

    pub struct BenchConfig {
        pub agents: usize,
        pub players: usize,
        pub ticks: u64,
    }

    pub fn run(cfg: BenchConfig) {
        std::env::set_var("WILDER_AGENTS", cfg.agents.to_string());
        let dir =
            std::env::temp_dir().join(format!("wilder-worldbench-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        run_in(cfg, &dir);
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn run_in(cfg: BenchConfig, dir: &std::path::Path) {
        let store = Arc::new(RocksStore::open(dir).expect("open bench store"));
        let (_cmd_tx, cmd_rx) = mpsc::unbounded_channel();
        let setup = Instant::now();
        let mut world = new_world(store.clone(), cmd_rx);
        println!(
            "seeded {} agents, {} statics in {:.2?}",
            world.agents.len(),
            world.statics.len(),
            setup.elapsed()
        );

        // Fake players parked around the hub combat ring: hot-tier agent
        // simulation, chunk seeding and replication all engage around them.
        let mut player_rx: Vec<(EntityId, mpsc::UnboundedReceiver<S2C>)> = Vec::new();
        for i in 0..cfg.players {
            let account = store
                .create_account(&format!("bench-{i}"), "bench")
                .expect("bench account");
            let angle = i as f32 / cfg.players.max(1) as f32 * std::f32::consts::TAU;
            let ring = Vec3::new(140.0 * angle.cos(), 0.0, 140.0 * angle.sin());
            let character = Character {
                id: uuid::Uuid::new_v4(),
                account_id: account.id,
                name: format!("BENCH-{i}"),
                appearance: Appearance::default(),
                position: world.nearest_walkable(ring),
                yaw: 0.0,
                level: 1,
                xp: 0,
                health: 100.0,
                max_health: 100.0,
                shield: 0.0,
                max_shield: 0.0,
                faction: FACTION_REBELS,
            };
            store.create_character(&character).expect("bench character");
            let (ptx, prx) = mpsc::unbounded_channel();
            let entity = world.join(account.id, character.id, ptx).expect("bench join");
            player_rx.push((entity, prx));
        }

        // Warm up: stream in chunks/agents around the parked players and drain
        // the join burst so steady-state stats aren't polluted by setup.
        for _ in 0..(TICK_HZ as u64 * 2) {
            world.step();
        }
        for (_, prx) in player_rx.iter_mut() {
            while prx.try_recv().is_ok() {}
        }
        world.timings.reset();

        let mut per_tick_us: Vec<u64> = Vec::with_capacity(cfg.ticks as usize);
        let mut msgs: u64 = 0;
        let mut p0_bytes: u64 = 0;
        let run_start = Instant::now();
        for _ in 0..cfg.ticks {
            let start = Instant::now();
            world.step();
            per_tick_us.push(start.elapsed().as_micros() as u64);
            for (pi, (_, prx)) in player_rx.iter_mut().enumerate() {
                while let Ok(msg) = prx.try_recv() {
                    msgs += 1;
                    if pi == 0 {
                        // Hot messages ship binary in production; count the
                        // frame size the gateway would actually send.
                        p0_bytes += match wilder_protocol::encode_binary(&msg) {
                            Some(bytes) => bytes.len() as u64,
                            None => encode(&msg).len() as u64,
                        };
                    }
                }
            }
        }
        let elapsed = run_start.elapsed();

        per_tick_us.sort_unstable();
        let pct = |p: f64| per_tick_us[((per_tick_us.len() - 1) as f64 * p) as usize];
        let budget_us = 1_000_000 / TICK_HZ as u64;
        println!(
            "agents={} players={} ticks={} wall={:.2?}",
            cfg.agents, cfg.players, cfg.ticks, elapsed
        );
        println!(
            "tick p50={}us p90={}us p99={}us max={}us (budget {}us)",
            pct(0.50),
            pct(0.90),
            pct(0.99),
            per_tick_us.last().copied().unwrap_or(0),
            budget_us
        );
        println!("phases: {}", world.timings.summary());
        if cfg.players > 0 {
            let secs = cfg.ticks as f64 / TICK_HZ as f64;
            println!(
                "wire: {} msgs total, player0 {:.1} KB/s ({} bytes over {:.0} sim-seconds)",
                msgs,
                p0_bytes as f64 / 1024.0 / secs,
                p0_bytes,
                secs
            );
        }
        let over = per_tick_us.iter().filter(|&&us| us > budget_us).count();
        println!(
            "ticks over budget: {} / {} ({:.2}%)",
            over,
            per_tick_us.len(),
            over as f64 / per_tick_us.len().max(1) as f64 * 100.0
        );

        // Economy pulse: is the emergent market loop alive at this scale?
        let traders =
            world.agents.iter().filter(|a| a.traits.leans(Activity::Trade)).count();
        let (fills, units, wild) = world.market_stats.totals();
        let mut goal_counts: HashMap<&'static str, usize> = HashMap::new();
        for a in &world.agents {
            let label = match a.goal {
                Goal::Idle => "idle",
                Goal::Patrol { .. } => "patrol",
                Goal::Gather { .. } => "gather",
                Goal::Sell { list_on_market: true, .. } => "sell-market",
                Goal::Sell { .. } => "sell-vendor",
                Goal::Buy { .. } => "buy-vendor",
                Goal::BuyMarket { .. } => "buy-market",
                Goal::Trade { .. } => "trade",
                Goal::Craft { .. } => "craft",
                Goal::Research { .. } => "research",
                Goal::Collect { .. } => "collect",
                Goal::Loot { .. } => "loot",
                Goal::Hunt { .. } => "hunt",
                Goal::Capture { .. } => "capture",
                Goal::Defend { .. } => "defend",
                Goal::Retreat { .. } => "retreat",
                Goal::Bank { .. } => "bank",
                Goal::Extract { .. } => "extract",
            };
            *goal_counts.entry(label).or_insert(0) += 1;
        }
        let mut goals: Vec<_> = goal_counts.into_iter().collect();
        goals.sort_by(|a, b| b.1.cmp(&a.1));
        let goals =
            goals.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join(" ");
        println!("econ: trade-leaning agents: {traders} / {}", world.agents.len());
        println!(
            "econ: market book listings={} fills={fills} units={units} wild={wild}",
            world.market.len()
        );
        println!("econ: goals {goals}");
    }
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
            vendor_stock: HashMap::new(),
            vendor_stock_dirty: false,
            next_listing_id: 1,
            next_job_id: 1,
            production: HashMap::new(),
            production_outputs: HashMap::new(),
            production_dirty: false,
            players: HashMap::new(),
            loot: HashMap::new(),
            pickups: HashMap::new(),
            statics: HashMap::new(),
            services_by_kind: HashMap::new(),
            interior_bounds: HashMap::new(),
            nodes: HashMap::new(),
            nodes_by_chunk: HashMap::new(),
            node_seeded_chunks: HashSet::new(),
            node_tuning: NodeTuning::default(),
            static_seeded_chunks: HashSet::new(),
            next_entity: 1,
            tick: 0,
            seed,
            rng: SmallRng::seed_from_u64(seed),
            rx,
            territory: HashMap::new(),
            territory_dirty: false,
            field_intel: HashMap::new(),
            region_income: HashMap::new(),
            region_casualties: HashMap::new(),
            zone_clock: ZoneClock::new(districts::district_defs().len()),
            ledger: Ledger::new(LedgerSave::default()),
            market_stats: MarketStats::default(),
            stats: StatsBook::default(),
            econ_subs: HashSet::new(),
            item_subs: HashMap::new(),
            agents: Vec::new(),
            agent_by_entity: HashMap::new(),
            agent_grid: HashMap::new(),
            hot_agents: Vec::new(),
            dead_agents: Vec::new(),
            agent_path_queue: std::collections::VecDeque::new(),
            agent_decision_queue: std::collections::VecDeque::new(),
            agent_save_cursor: 0,
            service_load: HashMap::new(),
            district_spots: Vec::new(),
            owned_agents: HashMap::new(),
            agent_logs: HashMap::new(),
            timings: TickTimings::default(),
        };
        (world, dir)
    }

    fn spawn_test_agent(
        world: &mut World,
        faction: FactionId,
        traits: Traits,
        position: Vec3,
    ) -> usize {
        let (agent_id, name) = mint_agent_name(faction);
        let entity = world.alloc_entity();
        let mut agent = FactionAgent::from_save(
            entity,
            AgentSave {
                agent_id,
                name,
                faction,
                guild: guild_for(faction, 0),
                traits,
                home: 0,
                home_spot: None,
                purse: {
                    let mut p = Purse::default();
                    p.credit(Currency::Wild, 100);
                    p
                },
                inventory: {
                    let mut inventory = Inventory::new();
                    inv::add_items(&mut inventory.slots, ItemKind::Pipe, 1);
                    inventory
                },
                blueprints: Vec::new(),
                stash: Vec::new(),
                pending_jobs: Vec::new(),
                owner: None,
                lifetime_owner_earnings: 0,
                position,
                health: 100.0,
                max_health: 100.0,
            },
        );
        agent.equip_best_gear();
        let idx = world.agents.len();
        world.agent_by_entity.insert(entity, idx);
        world.agents.push(agent);
        world.regrid_agent(idx);
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
        let a1 = spawn_test_agent(&mut world, FACTION_REBELS, Traits::fighter(), sanctuary);
        let a2 = spawn_test_agent(&mut world, FACTION_FORUM, Traits::fighter(), sanctuary);
        let (e1, e2) = (world.agents[a1].entity, world.agents[a2].entity);
        assert!(!world.deal_damage(e1, e2, 10.0, None));
        assert_eq!(world.agents[a2].health, 100.0);

        // Contested ground: hostile factions trade damage freely.
        let contested = district_anchor("NEXUS");
        let b1 = spawn_test_agent(&mut world, FACTION_REBELS, Traits::fighter(), contested);
        let b2 = spawn_test_agent(&mut world, FACTION_FORUM, Traits::fighter(), contested);
        let (f1, f2) = (world.agents[b1].entity, world.agents[b2].entity);
        assert!(world.deal_damage(f1, f2, 10.0, None));
        assert_eq!(world.agents[b2].health, 90.0);
        // Same faction never fights, anywhere.
        let b3 = spawn_test_agent(&mut world, FACTION_REBELS, Traits::fighter(), contested);
        let f3 = world.agents[b3].entity;
        assert!(!world.deal_damage(f1, f3, 10.0, None));

        // Guarded ground is open combat now: home turf grants capture
        // immunity (see territory tests), not damage immunity.
        let rebel_home = district_anchor("LITTLE MEOW");
        let g1 = spawn_test_agent(&mut world, FACTION_REBELS, Traits::fighter(), rebel_home);
        let g2 = spawn_test_agent(&mut world, FACTION_FORUM, Traits::fighter(), rebel_home);
        let (h1, h2) = (world.agents[g1].entity, world.agents[g2].entity);
        // Forum attacking a rebel on rebel home turf: allowed.
        assert!(world.deal_damage(h2, h1, 10.0, None));
        // And the rebel fights back, same as anywhere hostile.
        assert!(world.deal_damage(h1, h2, 10.0, None));
    }

    #[test]
    fn all_factions_fight_each_other_outside_safe_zones() {
        let (mut world, _dir) = test_world();
        let contested = district_anchor("NEXUS");
        let r = spawn_test_agent(&mut world, FACTION_REBELS, Traits::fighter(), contested);
        let f = spawn_test_agent(&mut world, FACTION_FORUM, Traits::fighter(), contested);
        let w = spawn_test_agent(&mut world, FACTION_WAPES, Traits::fighter(), contested);
        let (re, fe, we) =
            (world.agents[r].entity, world.agents[f].entity, world.agents[w].entity);
        assert!(world.deal_damage(re, we, 5.0, None), "rebel vs wape");
        assert!(world.deal_damage(fe, we, 5.0, None), "forum vs wape");
        assert!(world.deal_damage(we, re, 5.0, None), "wape vs rebel");
        assert!(world.deal_damage(we, fe, 5.0, None), "wape vs forum");
        assert!(world.deal_damage(re, fe, 5.0, None), "rebel vs forum");
    }

    #[test]
    fn respawn_protection_blocks_damage_both_ways() {
        let (mut world, _dir) = test_world();
        let contested = district_anchor("NEXUS");
        let a = spawn_test_agent(&mut world, FACTION_REBELS, Traits::fighter(), contested);
        let b = spawn_test_agent(&mut world, FACTION_FORUM, Traits::fighter(), contested);
        // Kill and respawn `a`; it comes back with the grace timer running.
        world.kill_agent(a, false);
        world.respawn_agent(a);
        assert!(world.agents[a].spawn_protection > 0.0);
        // Move it back onto contested ground next to its enemy (respawn
        // relocated it to the home district).
        world.agents[a].position = contested;
        world.regrid_agent(a);
        let (ea, eb) = (world.agents[a].entity, world.agents[b].entity);
        // Protected: no damage in...
        assert!(!world.deal_damage(eb, ea, 10.0, None));
        // ...and none out.
        assert!(!world.deal_damage(ea, eb, 10.0, None));
        // Once the timer runs out, combat is open again.
        world.agents[a].spawn_protection = 0.0;
        assert!(world.deal_damage(eb, ea, 10.0, None));
        assert!(world.deal_damage(ea, eb, 10.0, None));
    }

    #[test]
    fn wape_seeding_share_homes_and_priors() {
        let (mut world, _dir) = test_world();
        world.seed_neighborhood_stores();
        world.seed_agents_with_wape_share(100, 20);
        let wapes: Vec<&FactionAgent> =
            world.agents.iter().filter(|a| a.faction == FACTION_WAPES).collect();
        assert_eq!(wapes.len(), 20, "20% wape share of 100");
        for w in &wapes {
            assert!(w.name.starts_with("WAPE-"), "wape name: {}", w.name);
            let anchor = w.home_spot.expect("wapes anchor to a scattered home_spot");
            assert!(
                matches!(
                    districts::danger_at(anchor),
                    DangerLevel::Contested | DangerLevel::Warzone
                ),
                "wape anchored on safe ground at {anchor:?}"
            );
            // Grubstake includes street Cash so the Bank loop stays fed.
            assert!(
                w.inventory.slots.iter().flatten().any(|s| s.kind == ItemKind::Cash),
                "wape grubstake missing Cash"
            );
            // Scav/raider priors lean fight/gather/haul, never trade/craft.
            assert!(!matches!(w.traits.dominant(), Activity::Trade | Activity::Craft));
        }
        // No guarded home district: respawns anchor to home_spot instead.
        assert_eq!(districts::faction_home_district(FACTION_WAPES), None);
        // The organized remainder still splits 50/50.
        let rebels = world.agents.iter().filter(|a| a.faction == FACTION_REBELS).count();
        let forum = world.agents.iter().filter(|a| a.faction == FACTION_FORUM).count();
        assert_eq!(rebels, 40);
        assert_eq!(forum, 40);
    }

    #[test]
    fn wape_intel_sides_count_both_organized_factions_as_enemies() {
        let intel = RegionIntel {
            controller: FACTION_NEUTRAL,
            rebels: 2,
            forum: 3,
            wapes: 4,
            rebel_strength: 20.0,
            forum_strength: 30.0,
            wape_strength: 40.0,
            income: 0.0,
            casualties: 0.0,
        };
        let (friends, enemies, fs, es) = intel.sides(FACTION_WAPES);
        assert_eq!((friends, enemies), (4, 5));
        assert_eq!((fs, es), (40.0, 50.0));
    }

    #[test]
    fn hot_agent_death_spills_half_carried_currency() {
        let (mut world, _dir) = test_world();
        let contested = district_anchor("NEXUS");
        let idx = spawn_test_agent(&mut world, FACTION_FORUM, Traits::fighter(), contested);
        world.agents[idx].purse = Purse { carried: [101, 7, 3], banked: [50, 0, 0] };
        world.kill_agent(idx, true);
        let spilled = |world: &World, c: Currency| -> u32 {
            world.pickups.values().filter(|p| p.currency == c).map(|p| p.amount).sum()
        };
        assert_eq!(spilled(&world, Currency::Wild), 50, "half of 101, rounded down");
        assert_eq!(spilled(&world, Currency::Shards), 3);
        assert_eq!(spilled(&world, Currency::Energy), 1);
        // The full carried purse burned; the banked side is untouched.
        assert_eq!(world.agents[idx].purse.carried, [0, 0, 0]);
        assert_eq!(world.agents[idx].purse.banked, [50, 0, 0]);
    }

    #[test]
    fn cold_agent_death_burns_everything_without_pickups() {
        let (mut world, _dir) = test_world();
        let contested = district_anchor("NEXUS");
        let idx = spawn_test_agent(&mut world, FACTION_FORUM, Traits::fighter(), contested);
        world.agents[idx].purse = Purse { carried: [100, 4, 2], banked: [25, 0, 0] };
        world.kill_agent(idx, false);
        assert!(world.pickups.is_empty(), "no body, no spill");
        assert_eq!(world.agents[idx].purse.carried, [0, 0, 0]);
        assert_eq!(world.agents[idx].purse.banked, [25, 0, 0]);
    }

    #[test]
    fn player_death_spills_half_carried_currency() {
        let (mut world, _dir) = test_world();
        let contested = district_anchor("NEXUS");
        let victim = insert_test_player(&mut world, contested);
        world.players.get_mut(&victim).unwrap().purse =
            Purse { carried: [80, 5, 2], banked: [10, 0, 0] };
        let killer = spawn_test_agent(&mut world, FACTION_FORUM, Traits::fighter(), contested);
        let killer_entity = world.agents[killer].entity;
        world.kill_player(killer_entity, victim);
        let spilled = |world: &World, c: Currency| -> u32 {
            world.pickups.values().filter(|p| p.currency == c).map(|p| p.amount).sum()
        };
        assert_eq!(spilled(&world, Currency::Wild), 40);
        assert_eq!(spilled(&world, Currency::Shards), 2);
        assert_eq!(spilled(&world, Currency::Energy), 1);
        let player = &world.players[&victim];
        assert_eq!(player.purse.carried, [0, 0, 0], "carried burns on death");
        assert_eq!(player.purse.banked, [10, 0, 0], "banked survives");
        // Respawned at the hub with the grace timer running.
        assert!(player.spawn_protection > 0.0, "respawn grants spawn protection");
    }

    #[test]
    fn pvp_damage_gated_by_faction_and_safe_zones() {
        let (mut world, _dir) = test_world();
        let contested = district_anchor("NEXUS");
        let a = insert_test_player(&mut world, contested);
        let b = insert_test_player(&mut world, contested + Vec3::new(2.0, 0.0, 0.0));
        // Same faction (both default Rebels): no PvP anywhere.
        assert!(!world.deal_damage(a, b, 10.0, None));
        // Hostile factions on contested ground: PvP lands.
        world.players.get_mut(&b).unwrap().character.faction = FACTION_FORUM;
        assert!(world.deal_damage(a, b, 10.0, None));
        assert!(world.players[&b].character.health < 100.0);
        // Sanctuary still blocks PvP.
        let sanctuary = district_anchor("TRANQUILITY GARDENS");
        world.players.get_mut(&a).unwrap().character.position = sanctuary;
        world.players.get_mut(&b).unwrap().character.position = sanctuary;
        assert!(!world.deal_damage(a, b, 10.0, None));
    }

    #[test]
    fn player_faction_persists_from_store_to_spawn_data() {
        let (mut world, _dir) = test_world();
        let account = world.store.create_account("wape-fan", "pw").unwrap();
        let character = Character {
            id: uuid::Uuid::new_v4(),
            account_id: account.id,
            name: "WAPELOVER".into(),
            appearance: Appearance::default(),
            position: SPAWN,
            yaw: 0.0,
            level: 1,
            xp: 0,
            health: 100.0,
            max_health: 100.0,
            shield: 0.0,
            max_shield: 0.0,
            faction: FACTION_WAPES,
        };
        world.store.create_character(&character).unwrap();
        let (tx, _rx) = mpsc::unbounded_channel();
        let entity = world.join(account.id, character.id, tx).unwrap();
        let player = &world.players[&entity];
        assert_eq!(player.character.faction, FACTION_WAPES);
        assert_eq!(player.spawn_data().faction, FACTION_WAPES);
        assert!(matches!(
            player_party(player),
            TxParty::Player { faction: FACTION_WAPES, .. }
        ));
    }

    #[test]
    fn overlapping_hot_agents_get_pushed_apart() {
        let (mut world, _dir) = test_world();
        let spot = world.nearest_walkable(district_anchor("NEXUS"));
        let a = spawn_test_agent(&mut world, FACTION_REBELS, Traits::fighter(), spot);
        let b = spawn_test_agent(
            &mut world,
            FACTION_FORUM,
            Traits::fighter(),
            spot + Vec3::new(0.1, 0.0, 0.0),
        );
        world.agents[a].tier = Tier::Hot;
        world.agents[b].tier = Tier::Hot;
        world.hot_agents.push(a as u32);
        world.hot_agents.push(b as u32);
        for _ in 0..40 {
            world.separate_characters();
        }
        let d = (world.agents[a].position - world.agents[b].position).length();
        assert!(d >= PLAYER_RADIUS * 2.0 - 1e-3, "agents still interpenetrate: {d}");
    }

    #[test]
    fn separation_pushes_agents_out_of_players_but_never_moves_players() {
        let (mut world, _dir) = test_world();
        let spot = world.nearest_walkable(district_anchor("NEXUS"));
        let a = spawn_test_agent(&mut world, FACTION_REBELS, Traits::fighter(), spot);
        world.agents[a].tier = Tier::Hot;
        world.hot_agents.push(a as u32);

        // A connected player standing exactly on the agent.
        let entity = world.alloc_entity();
        let (tx, _rx) = mpsc::unbounded_channel();
        let character = Character {
            id: uuid::Uuid::new_v4(),
            account_id: uuid::Uuid::new_v4(),
            name: "TESTER".into(),
            appearance: Appearance::default(),
            position: spot,
            yaw: 0.0,
            level: 1,
            xp: 0,
            health: 100.0,
            max_health: 100.0,
            shield: 0.0,
            max_shield: 0.0,
            faction: FACTION_REBELS,
        };
        world.players.insert(
            entity,
            Player {
                entity,
                character,
                inventory: Inventory::new(),
                stash: Stash::new(),
                tx,
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
                spawn_protection: 0.0,
                ability_cooldowns: [0.0; 3],
                stim_heal_left: 0.0,
                stim_speed_time: 0.0,
                overcharge_time: 0.0,
                blueprints: HashSet::new(),
                purse: Purse::default(),
                wallet_sent: None,
                sent_snaps: HashMap::new(),
                map_intel: false,
            agent_sub: false,
            agent_detail: None,
                last_full_deny: f64::NEG_INFINITY,
                dirty: true,
            },
        );

        for _ in 0..40 {
            world.separate_characters();
        }
        let player_pos = world.players[&entity].character.position;
        assert_eq!(player_pos, spot, "players must never be shoved by separation");
        let d = (world.agents[a].position - player_pos).length();
        assert!(d >= PLAYER_RADIUS * 2.0 - 1e-3, "agent still inside the player: {d}");
    }

    #[test]
    fn agent_death_burns_goods_and_respawns_fresh_identity() {
        let (mut world, _dir) = test_world();
        world.seed_neighborhood_stores();
        let contested = district_anchor("NEXUS");
        let idx = spawn_test_agent(&mut world, FACTION_FORUM, Traits::gatherer(), contested);
        let old_id = world.agents[idx].agent_id;
        let old_entity = world.agents[idx].entity;
        // Cargo in the backpack (the spawn Pipe sits in the equip slot and
        // survives death; only backpack slots drop).
        world.agents[idx].add_item(ItemKind::Iron, 5);
        world.kill_agent(idx, true);
        assert!(!world.agents[idx].alive());
        assert_eq!(world.agents[idx].wallet(), 0);
        assert_eq!(world.agents[idx].used_volume(), 0, "backpack drops on death");
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
    fn banked_wealth_survives_death_and_funds_comeback() {
        let (mut world, _dir) = test_world();
        world.seed_neighborhood_stores();
        let contested = district_anchor("NEXUS");
        let idx = spawn_test_agent(&mut world, FACTION_FORUM, Traits::gatherer(), contested);
        // Savings in the vault, at-risk MILD in the wallet on top.
        world.agents[idx].purse = Purse { carried: [200, 0, 0], banked: [500, 0, 0] };
        // Death burns the carried wallet but never touches the vault.
        world.kill_agent(idx, false);
        assert_eq!(world.agents[idx].wallet(), 0, "carried wallet burns on death");
        assert_eq!(world.agents[idx].bank(), 500, "banked MILD is safe from death");
        // Respawn pulls a comeback stake out of the vault into the fresh wallet.
        world.agents[idx].respawn_in = 0.0;
        world.respawn_agent(idx);
        assert!(
            world.agents[idx].wallet() >= agents::AGENT_COMEBACK_WITHDRAW,
            "respawn should fund the wallet from the vault"
        );
        assert_eq!(
            world.agents[idx].bank(),
            500 - agents::AGENT_COMEBACK_WITHDRAW,
            "the comeback stake comes out of the vault"
        );
    }

    #[test]
    fn agent_wealth_run_vaults_the_wallet() {
        let (mut world, _dir) = test_world();
        world.seed_neighborhood_stores();
        // Stand an agent on a Bank counter so the deposit executes on arrival.
        let bank_pos = world
            .services_by_kind
            .get(&EntityKind::Bank)
            .and_then(|v| v.first())
            .map(|&(_, p)| p)
            .expect("a Bank was seeded");
        let idx = spawn_test_agent(&mut world, FACTION_REBELS, Traits::gatherer(), bank_pos);
        world.agents[idx].purse = Purse { carried: [WEALTH_RETREAT + 400, 0, 0], banked: [0; 3] };
        world.agents[idx].retreat_cooldown = 0.0;
        world.agents[idx].health = world.agents[idx].max_health;
        // Decide → wealth override routes to the Bank; then execute the deposit.
        world.decide_agent(idx);
        assert!(
            matches!(world.agents[idx].goal, Goal::Bank { .. }),
            "a flush agent should choose a bank run"
        );
        world.agent_bank_deposit(idx);
        assert_eq!(
            world.agents[idx].wallet(),
            agents::AGENT_BANK_KEEP,
            "deposit leaves only the operating float in the wallet"
        );
        assert_eq!(
            world.agents[idx].bank(),
            WEALTH_RETREAT + 400 - agents::AGENT_BANK_KEEP,
            "everything above the float is vaulted"
        );
    }

    #[test]
    fn vendor_shelves_are_stock_backed() {
        let (mut world, _dir) = test_world();
        world.seed_neighborhood_stores();
        let contested = district_anchor("NEXUS");
        let (armory, _) = world.nearest_service(contested, EntityKind::Armory).unwrap();
        // Fresh shelves open with the seeded bootstrap, minted exactly once.
        let seeded = wilder_economy::seed_stock_count(ItemKind::Knife);
        assert_eq!(world.vendor_stock_count(armory, ItemKind::Knife), seeded);
        let minted_at_seed = world.ledger.item_supply(ItemKind::Knife).minted;

        let idx = spawn_test_agent(&mut world, FACTION_REBELS, Traits::gatherer(), contested);
        world.agents[idx].purse.credit(Currency::Wild, 1000);
        // Buying comes OFF the shelf: a transfer, not issuance.
        assert!(world.vendor_buy(EconActor::Agent(idx), armory, ItemKind::Knife, 1).is_ok());
        assert_eq!(world.vendor_stock_count(armory, ItemKind::Knife), seeded - 1);
        assert_eq!(world.ledger.item_supply(ItemKind::Knife).minted, minted_at_seed);
        // A big ask clamps to what's left; the next one is denied outright.
        assert!(world.vendor_buy(EconActor::Agent(idx), armory, ItemKind::Knife, 99).is_ok());
        assert_eq!(world.vendor_stock_count(armory, ItemKind::Knife), 0);
        assert_eq!(
            world.vendor_buy(EconActor::Agent(idx), armory, ItemKind::Knife, 1),
            Err("out of stock".into())
        );
    }

    #[test]
    fn selling_to_a_vendor_stocks_its_shelf_up_to_the_cap() {
        let (mut world, _dir) = test_world();
        world.seed_neighborhood_stores();
        let contested = district_anchor("NEXUS");
        let (bodega, _) = world.nearest_service(contested, EntityKind::Bodega).unwrap();
        let idx = spawn_test_agent(&mut world, FACTION_REBELS, Traits::gatherer(), contested);
        world.agents[idx].add_item(ItemKind::Iron, 30);
        let burned_before = world.ledger.item_supply(ItemKind::Iron).burned;
        assert!(world.vendor_sell(EconActor::Agent(idx), bodega, ItemKind::Iron, 30).is_ok());
        // Sold goods land on the shelf and STAY in supply (no burn leg).
        assert_eq!(world.vendor_stock_count(bodega, ItemKind::Iron), 30);
        assert_eq!(world.ledger.item_supply(ItemKind::Iron).burned, burned_before);
        // A full shelf refuses the trade — vendors aren't item vacuums.
        world.vendor_stock_add(bodega, ItemKind::Iron, wilder_economy::VENDOR_STOCK_CAP);
        world.agents[idx].add_item(ItemKind::Iron, 5);
        assert!(world.vendor_sell(EconActor::Agent(idx), bodega, ItemKind::Iron, 5).is_err());
        assert_eq!(world.agents[idx].count_item(ItemKind::Iron), 5, "denied sale keeps goods");
    }

    #[test]
    fn vendor_stock_persists_and_never_reseeds() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(RocksStore::open(dir.path()).unwrap());
        let (_tx, rx) = mpsc::unbounded_channel();
        std::mem::forget(_tx);
        let mut world = new_world(store.clone(), rx);
        let (armory, armory_pos) = world
            .nearest_service(district_anchor("NEXUS"), EntityKind::Armory)
            .expect("armory seeded");
        let seeded = wilder_economy::seed_stock_count(ItemKind::Knife);
        assert_eq!(world.vendor_stock_count(armory, ItemKind::Knife), seeded);
        let idx = spawn_test_agent(&mut world, FACTION_REBELS, Traits::gatherer(), armory_pos);
        world.agents[idx].purse.credit(Currency::Wild, 1000);
        world.vendor_buy(EconActor::Agent(idx), armory, ItemKind::Knife, 1).unwrap();
        world.save_all();

        // Restart: the depleted shelf comes back as-is (statics reseed
        // deterministically so the entity key matches) and the bootstrap
        // never re-mints over a persisted entry.
        let (_tx2, rx2) = mpsc::unbounded_channel();
        std::mem::forget(_tx2);
        let mut world2 = new_world(store, rx2);
        assert_eq!(world2.vendor_stock_count(armory, ItemKind::Knife), seeded - 1);
        let minted = world2.ledger.item_supply(ItemKind::Knife).minted;
        world2.ensure_vendor_stock();
        assert_eq!(world2.vendor_stock_count(armory, ItemKind::Knife), seeded - 1);
        assert_eq!(world2.ledger.item_supply(ItemKind::Knife).minted, minted);
    }

    #[test]
    fn agent_market_fees_route_to_territory_holders() {
        let (mut world, _dir) = test_world();
        world.seed_neighborhood_stores();
        let contested = district_anchor("NEXUS");
        let seller = spawn_test_agent(&mut world, FACTION_REBELS, Traits::trader(), contested);
        world.agents[seller].add_item(ItemKind::Iron, 30);
        world.agent_market_list(seller);
        let listing_price =
            world.market.iter().find(|l| l.kind == ItemKind::Iron).expect("listed").price_each;
        let (_, terminal_pos) =
            world.nearest_service(contested, EntityKind::MarketTerminal).unwrap();
        let buyer = spawn_test_agent(&mut world, FACTION_REBELS, Traits::crafter(), terminal_pos);
        // Forum holds the ground under the terminal, with one member on it;
        // the rebel counterparties get no share of their own fee.
        let holder = spawn_test_agent(&mut world, FACTION_FORUM, Traits::fighter(), terminal_pos);
        world.territory.insert(region_of(terminal_pos), FACTION_FORUM);
        let holder_wallet = world.agents[holder].wallet();
        assert!(world.agent_market_buy(buyer, ItemKind::Iron, 10, listing_price));
        let fee = listing_price * 10 * MARKET_FEE_PCT / 100;
        assert!(fee > 0, "test needs a nonzero fee to prove routing");
        assert_eq!(
            world.agents[holder].wallet(),
            holder_wallet + fee,
            "the market fee is commerce: territory holders skim it"
        );
    }

    #[test]
    fn stash_moves_emit_extract_ledger_legs() {
        let (mut world, _dir) = test_world();
        let pos = Vec3::new(10.0, 0.0, 10.0);
        insert_test_station(&mut world, EntityKind::Building, pos);
        let entity = spawn_test_player(&mut world, pos);
        let player = world.players.get_mut(&entity).unwrap();
        inv::add_items(&mut player.inventory.slots, ItemKind::Iron, 12);
        world.inventory_action(entity, InventoryAction::Deposit { slot: 0 });
        let player = &world.players[&entity];
        assert_eq!(inv::count_items(&player.stash.slots, ItemKind::Iron), 12);
        assert_eq!(inv::count_items(&player.inventory.slots, ItemKind::Iron), 0);
        assert_eq!(world.ledger.items_extracted, 12);
        // The feed carries a typed Extract leg (owner -> storage party).
        assert!(world.ledger.recent().iter().any(|tx| matches!(tx.kind, TxKind::Extract)));
        world.inventory_action(entity, InventoryAction::Withdraw { stash_slot: 0 });
        let player = &world.players[&entity];
        assert_eq!(inv::count_items(&player.inventory.slots, ItemKind::Iron), 12);
        assert_eq!(inv::count_items(&player.stash.slots, ItemKind::Iron), 0);
        assert_eq!(world.ledger.items_withdrawn, 12);
        // Out of range: the move is refused before anything settles.
        world.players.get_mut(&entity).unwrap().character.position =
            pos + Vec3::new(50.0, 0.0, 0.0);
        world.inventory_action(entity, InventoryAction::Deposit { slot: 0 });
        assert_eq!(world.ledger.items_extracted, 12, "no terminal in reach, no extract");
        assert_eq!(inv::count_items(&world.players[&entity].inventory.slots, ItemKind::Iron), 12);
    }

    #[test]
    fn agents_extract_keeper_cargo_and_the_stash_survives_death() {
        let (mut world, _dir) = test_world();
        world.seed_neighborhood_stores();
        let contested = district_anchor("NEXUS");
        let idx = spawn_test_agent(&mut world, FACTION_REBELS, Traits::hauler(), contested);
        let store = insert_test_station(&mut world, EntityKind::Building, contested);
        // Fragment cargo over the EXTRACT_VALUE threshold: the hauler should
        // pick the Storage errand over selling or gathering.
        world.agents[idx].add_item(ItemKind::BlueprintFragment, 12);
        world.decide_agent(idx);
        assert!(
            matches!(world.agents[idx].goal, Goal::Extract { .. }),
            "valuable keeper cargo should route to Storage, got {:?}",
            world.agents[idx].goal
        );
        world.agent_extract(idx, store);
        assert_eq!(world.agents[idx].stash_count(ItemKind::BlueprintFragment), 12);
        assert_eq!(world.agents[idx].count_item(ItemKind::BlueprintFragment), 0);
        assert!(world.ledger.items_extracted >= 12);
        // Death burns the pack, never the vault; the respawned identity
        // keeps its stash like it keeps its bank and blueprints.
        world.kill_agent(idx, false);
        world.agents[idx].respawn_in = 0.0;
        world.respawn_agent(idx);
        assert_eq!(world.agents[idx].stash_count(ItemKind::BlueprintFragment), 12);
    }

    #[test]
    fn grubstake_draws_kit_from_the_stash_before_minting() {
        let (mut world, _dir) = test_world();
        world.seed_neighborhood_stores();
        let contested = district_anchor("NEXUS");
        let idx = spawn_test_agent(&mut world, FACTION_REBELS, Traits::fighter(), contested);
        inv::add_items(&mut world.agents[idx].stash, ItemKind::Pipe, 1);
        inv::add_items(&mut world.agents[idx].stash, ItemKind::Medkit, 1);
        let pipe_minted = world.ledger.item_supply(ItemKind::Pipe).minted;
        let medkit_minted = world.ledger.item_supply(ItemKind::Medkit).minted;
        let withdrawn = world.ledger.items_withdrawn;
        world.kill_agent(idx, false);
        world.agents[idx].respawn_in = 0.0;
        world.respawn_agent(idx);
        // The fighter kit came out of the vault: nothing new entered supply.
        assert_eq!(world.agents[idx].count_item(ItemKind::Pipe), 1);
        assert_eq!(world.agents[idx].count_item(ItemKind::Medkit), 1);
        assert_eq!(world.agents[idx].stash_count(ItemKind::Pipe), 0);
        assert_eq!(world.agents[idx].stash_count(ItemKind::Medkit), 0);
        assert_eq!(world.ledger.item_supply(ItemKind::Pipe).minted, pipe_minted);
        assert_eq!(world.ledger.item_supply(ItemKind::Medkit).minted, medkit_minted);
        assert_eq!(world.ledger.items_withdrawn, withdrawn + 2);
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
            traits: Traits::fighter(),
            home: 7, // NORTH STAR
            home_spot: None,
            purse: {
                let mut p = Purse::default();
                p.credit(Currency::Wild, 50);
                p
            },
            inventory: Inventory::new(),
            blueprints: Vec::new(),
            stash: Vec::new(),
            pending_jobs: Vec::new(),
            owner: None,
            lifetime_owner_earnings: 0,
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
    fn sharded_agent_saves_roundtrip_across_restart() {
        let (mut world, _dir) = test_world();
        world.seed_neighborhood_stores();
        // Span multiple shards so the concatenating loader is exercised.
        world.seed_agents(AGENT_SAVE_SHARD + 500);
        world.save_agent_shards_full();
        let names: Vec<String> = world.agents.iter().map(|a| a.name.clone()).collect();
        // Simulate a restart: wipe the live population, restore from disk.
        world.agents.clear();
        world.agent_by_entity.clear();
        world.agent_grid.clear();
        world.hot_agents.clear();
        world.dead_agents.clear();
        world.store.save_meta("agent_seed_layout", &AGENT_SEED_LAYOUT).unwrap();
        world.load_or_seed_agents();
        let restored: Vec<String> = world.agents.iter().map(|a| a.name.clone()).collect();
        assert_eq!(restored, names, "shards should reassemble the population in order");
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
            if world.agents[idx].traits.mult(Activity::Fight) < 1.0 {
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
    fn service_routing_avoids_the_crowded_storefront() {
        let (mut world, _dir) = test_world();
        let place = |world: &mut World, pos: Vec3| -> EntityId {
            let e = world.alloc_entity();
            world.register_static(StaticEntity {
                entity: e,
                kind: EntityKind::Bodega,
                position: pos,
                name: "Bodega".into(),
                variant: 0,
                agent_id: static_agent_id(world.seed, e),
            });
            e
        };
        // Two Bodegas: A is nearer the agent, B a short detour farther.
        let a = place(&mut world, Vec3::new(0.0, 0.0, 0.0));
        let b = place(&mut world, Vec3::new(40.0, 0.0, 0.0));
        let from = Vec3::new(-5.0, 0.0, 0.0);

        // Empty: the nearer Bodega wins and its appeal is high.
        let (near, _, near_appeal) = world.route_service(from, EntityKind::Bodega).unwrap();
        assert_eq!(near, a, "with no crowd the nearer Bodega should win");

        // Pack the near Bodega past capacity: routing flips to the emptier
        // farther one (agents avoid the jam instead of piling on).
        world.service_load.insert(a, 40);
        let (routed, _, routed_appeal) = world.route_service(from, EntityKind::Bodega).unwrap();
        assert_eq!(routed, b, "a packed Bodega should push agents to an emptier one");
        assert!(
            routed_appeal < near_appeal,
            "congested routing appeal ({routed_appeal}) should fall below the uncontested one ({near_appeal})"
        );
    }

    /// End-to-end crowd regression: run the full population for ~5
    /// sim-minutes and check no Bodega accumulates a statue mob. Guards the
    /// three historical pile-up bugs at once: kit-only agents looping Sell at
    /// a counter that buys nothing, cold hunters shadowing victims into the
    /// sanctuary forever, and errands never re-routing off a packed door.
    /// Deterministic: fixed world seed, no wall-clock inputs.
    #[test]
    fn bodega_crowds_stay_dispersed() {
        let (mut world, _dir) = test_world();
        world.seed_district();
        world.seed_neighborhood_stores();
        world.seed_agents(500);
        // Arm half the population: kit-heavy packs are what fed the old
        // sell-nothing loop, so make sure the pressure is present.
        for i in 0..world.agents.len() {
            if i % 2 == 0 {
                world.agents[i].add_item(ItemKind::Smg, 1);
                world.agents[i].add_item(ItemKind::Ammo9mm, 60);
            }
        }
        for _ in 0..6000 {
            world.tick += 1;
            world.ledger.set_tick(world.tick);
            world.tick_agents();
        }
        for s in world.statics.values().filter(|s| s.kind == EntityKind::Bodega) {
            let crowd = world
                .agents
                .iter()
                .filter(|a| a.alive() && (a.position - s.position).length() < 12.0)
                .count();
            assert!(
                crowd <= 20,
                "{} has a {crowd}-agent mob at the door (statue-pile regression)",
                s.name
            );
        }
    }

    /// Build the minimal connected-player record used by hot-tier tests.
    fn insert_test_player(world: &mut World, pos: Vec3) -> EntityId {
        let entity = world.alloc_entity();
        let (tx, _rx) = mpsc::unbounded_channel();
        std::mem::forget(_rx);
        let character = Character {
            id: uuid::Uuid::new_v4(),
            account_id: uuid::Uuid::new_v4(),
            name: "TESTER".into(),
            appearance: Appearance::default(),
            position: pos,
            yaw: 0.0,
            level: 1,
            xp: 0,
            health: 100.0,
            max_health: 100.0,
            shield: 0.0,
            max_shield: 0.0,
            faction: FACTION_REBELS,
        };
        world.players.insert(
            entity,
            Player {
                entity,
                character,
                inventory: Inventory::new(),
                stash: Stash::new(),
                tx,
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
                spawn_protection: 0.0,
                ability_cooldowns: [0.0; 3],
                stim_heal_left: 0.0,
                stim_speed_time: 0.0,
                overcharge_time: 0.0,
                blueprints: HashSet::new(),
                purse: Purse::default(),
                wallet_sent: None,
                sent_snaps: HashMap::new(),
                map_intel: false,
            agent_sub: false,
            agent_detail: None,
                last_full_deny: f64::NEG_INFINITY,
                dirty: true,
            },
        );
        entity
    }

    /// Hot-tier twin of `bodega_crowds_stay_dispersed`: a connected player
    /// keeps the hub hot (20 Hz embodied sim, collision, separation) — the
    /// exact conditions of the on-screen statue-mob reports — and no hub
    /// Bodega may accumulate a pile at the door.
    #[test]
    fn hot_hub_bodega_stays_dispersed() {
        let (mut world, _dir) = test_world();
        world.seed_district();
        world.seed_neighborhood_stores();
        world.seed_agents(500);
        for i in 0..world.agents.len() {
            if i % 2 == 0 {
                world.agents[i].add_item(ItemKind::Smg, 1);
                world.agents[i].add_item(ItemKind::Ammo9mm, 60);
            }
        }
        // A connected player at spawn keeps the hub hot, like the live game.
        insert_test_player(&mut world, SPAWN);
        // ~5 sim-minutes at 20 Hz with hot-tier collision + separation.
        for _ in 0..6000 {
            world.tick += 1;
            world.ledger.set_tick(world.tick);
            world.tick_agents();
            world.separate_characters();
        }
        for s in world.statics.values().filter(|s| s.kind == EntityKind::Bodega) {
            let crowd = world
                .agents
                .iter()
                .filter(|a| a.alive() && (a.position - s.position).length() < 12.0)
                .count();
            assert!(
                crowd <= 20,
                "{} has a {crowd}-agent hot-tier mob at the door",
                s.name
            );
        }
    }

    #[test]
    fn kit_only_agents_dont_mob_the_bodega() {
        let (mut world, _dir) = test_world();
        let pos = district_anchor("NEXUS");
        // A Bodega right next door, so if Sell scores at all it wins routing.
        let entity = world.alloc_entity();
        world.register_static(StaticEntity {
            entity,
            kind: EntityKind::Bodega,
            position: pos + Vec3::new(10.0, 0.0, 0.0),
            name: "Bodega".into(),
            variant: 0,
            agent_id: static_agent_id(world.seed, entity),
        });
        let idx = spawn_test_agent(&mut world, FACTION_REBELS, Traits::hauler(), pos);
        // A valuable pack — but it's all personal kit, which the Bodega
        // (raw resources in, consumables out) pays nothing for. Under
        // carried-value scoring this agent walked to the counter, sold
        // nothing, re-picked Sell and stood at the door forever.
        world.agents[idx].add_item(ItemKind::Smg, 1);
        world.agents[idx].add_item(ItemKind::Ammo9mm, 60);
        world.agents[idx].add_item(ItemKind::Medkit, 1);
        for _ in 0..5 {
            world.decide_agent(idx);
            assert!(
                !matches!(world.agents[idx].goal, Goal::Sell { .. }),
                "kit-only agent must not queue at a store, got {:?}",
                world.agents[idx].goal
            );
        }
        // Give it goods the Bodega actually pays for: now Sell is rational.
        world.agents[idx].add_item(ItemKind::Electronics, 40);
        world.decide_agent(idx);
        assert!(
            matches!(world.agents[idx].goal, Goal::Sell { .. }),
            "agent hauling real resources should go sell, got {:?}",
            world.agents[idx].goal
        );
    }

    #[test]
    fn cold_war_rolls_casualties_where_factions_share_a_region() {
        let (mut world, _dir) = test_world();
        world.seed_neighborhood_stores();
        // The hub front: contested ground both factions' patrols converge on.
        let front = world.nearest_walkable(HUB_FRONT_SPOT);
        assert_eq!(districts::danger_at(front), DangerLevel::Contested);
        for _ in 0..4 {
            spawn_test_agent(&mut world, FACTION_REBELS, Traits::fighter(), front);
            spawn_test_agent(&mut world, FACTION_FORUM, Traits::fighter(), front);
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
        let idx = spawn_test_agent(&mut world, FACTION_REBELS, Traits::gatherer(), contested);
        world.agents[idx].add_item(ItemKind::Iron, 20);
        let (store, _) = world.nearest_service(contested, EntityKind::Bodega).unwrap();
        let before = world.agents[idx].wallet();
        world.agent_sell(idx, store, false);
        // Bodega pays 2/iron, minus the 10% commerce cut.
        let gross = 40u32;
        let cut = gross * wilder_economy::COMMERCE_CUT_PCT / 100;
        assert_eq!(world.agents[idx].wallet(), before + gross - cut);
        assert_eq!(world.agents[idx].count_item(ItemKind::Iron), 0);

        // Vendor buy round-trips through the wallet (the agent already
        // carries one Pipe from its spawn kit).
        let (armory, _) = world.nearest_service(contested, EntityKind::Armory).unwrap();
        let wallet = world.agents[idx].wallet();
        world.agent_vendor_buy(idx, armory, ItemKind::Knife, 1);
        assert_eq!(world.agents[idx].wallet(), wallet - 45);
        assert_eq!(world.agents[idx].count_item(ItemKind::Knife), 1);
    }

    /// A connected player standing at `position` (throwaway channel).
    fn spawn_test_player(world: &mut World, position: Vec3) -> EntityId {
        let entity = world.alloc_entity();
        let (tx, rx) = mpsc::unbounded_channel();
        std::mem::forget(rx); // keep sends alive without a runtime
        let character = Character {
            id: uuid::Uuid::new_v4(),
            account_id: uuid::Uuid::new_v4(),
            name: "TESTER".into(),
            appearance: Appearance::default(),
            position,
            yaw: 0.0,
            level: 1,
            xp: 0,
            health: 100.0,
            max_health: 100.0,
            shield: 0.0,
            max_shield: 0.0,
            faction: FACTION_REBELS,
        };
        world.players.insert(
            entity,
            Player {
                entity,
                character,
                inventory: Inventory::new(),
                stash: Stash::new(),
                tx,
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
                spawn_protection: 0.0,
                ability_cooldowns: [0.0; 3],
                stim_heal_left: 0.0,
                stim_speed_time: 0.0,
                overcharge_time: 0.0,
                blueprints: HashSet::new(),
                purse: Purse::default(),
                wallet_sent: None,
                sent_snaps: HashMap::new(),
                map_intel: false,
            agent_sub: false,
            agent_detail: None,
                last_full_deny: f64::NEG_INFINITY,
                dirty: true,
            },
        );
        entity
    }

    /// A fresh, gatherable node at `position` (bypasses chunk placement).
    fn plant_test_node(world: &mut World, position: Vec3, variant: u32) -> EntityId {
        let entity = world.alloc_entity();
        world.nodes.insert(
            entity,
            ResourceNode {
                entity,
                position,
                variant,
                charges: world.node_tuning.charges,
                last_gather: f64::NEG_INFINITY,
                depleted_at: 0.0,
            },
        );
        world.nodes_by_chunk.entry(ChunkCoord::from_world(position)).or_default().push(entity);
        entity
    }

    #[test]
    fn node_placement_is_deterministic_and_spread() {
        let (mut w1, _d1) = test_world();
        let (mut w2, _d2) = test_world();
        // A hostile chunk well outside the safe hub.
        let coord = ChunkCoord::new(4, 3);
        w1.ensure_nodes(coord);
        w2.ensure_nodes(coord);
        let snap = |w: &World| -> Vec<(i32, i32, u32)> {
            let mut v: Vec<_> = w
                .nodes
                .values()
                .map(|n| ((n.position.x * 10.0) as i32, (n.position.z * 10.0) as i32, n.variant))
                .collect();
            v.sort();
            v
        };
        let nodes = snap(&w1);
        assert!(!nodes.is_empty(), "a hostile chunk should host resource nodes");
        assert_eq!(nodes, snap(&w2), "same coord must materialize identical nodes");
        // Distinct tiles per node.
        let spots: HashSet<(i32, i32)> = nodes.iter().map(|&(x, z, _)| (x, z)).collect();
        assert_eq!(spots.len(), nodes.len(), "nodes must land on distinct tiles");
        // Re-ensuring is idempotent, and safe chunks never host nodes.
        let before = w1.nodes.len();
        w1.ensure_nodes(coord);
        w1.ensure_nodes(ChunkCoord::new(0, 0));
        assert_eq!(w1.nodes.len(), before);
    }

    #[test]
    fn gather_node_depletes_cools_and_respawns_lazily() {
        let (mut world, _dir) = test_world();
        let pos = world.nearest_walkable(district_anchor("NEXUS"));
        let idx = spawn_test_agent(&mut world, FACTION_REBELS, Traits::gatherer(), pos);
        let node = plant_test_node(&mut world, pos, 0);
        let actor = EconActor::Agent(idx);
        let cooldown_ticks = (NODE_GATHER_COOLDOWN / TICK_DT).ceil() as u64 + 1;

        assert!(world.gather_node(actor, node).is_some(), "fresh node should yield");
        assert!(
            world.gather_node(actor, node).is_none(),
            "the 1.2 s cooldown must block back-to-back pulls"
        );
        world.tick += cooldown_ticks;
        assert!(world.gather_node(actor, node).is_some(), "ready again after the cooldown");
        // Drain whatever charges remain (over-pulling is harmless).
        for _ in 0..world.node_tuning.charges {
            world.tick += cooldown_ticks;
            let _ = world.gather_node(actor, node);
        }
        assert_eq!(world.nodes[&node].charges, 0, "node should be drained");
        world.tick += cooldown_ticks;
        assert!(world.gather_node(actor, node).is_none(), "depleted node yields nothing");
        // Nobody ticks node timers anymore: enough world clock passes and
        // the next access refills it.
        world.tick += (world.node_tuning.respawn_seconds / TICK_DT) as u64 + 1;
        assert!(world.gather_node(actor, node).is_some(), "node must respawn lazily on access");
        assert_eq!(world.nodes[&node].charges, world.node_tuning.charges - 1);
    }

    #[test]
    fn gather_rules_are_shared_by_players_and_agents() {
        let (mut world, _dir) = test_world();
        let pos = world.nearest_walkable(district_anchor("NEXUS"));
        let idx = spawn_test_agent(&mut world, FACTION_REBELS, Traits::gatherer(), pos);
        let player = spawn_test_player(&mut world, pos + Vec3::new(2.0, 0.0, 0.0));
        let agent_node = plant_test_node(&mut world, pos, 0);
        let player_node = plant_test_node(&mut world, pos + Vec3::new(2.0, 0.0, 0.0), 0);

        let agent_pull =
            world.gather_node(EconActor::Agent(idx), agent_node).expect("agent pull succeeds");
        let player_pull = world
            .gather_node(EconActor::Player(player), player_node)
            .expect("player pull succeeds");
        // Same rulebook, same bounds: 2-5 roll, +50% warzone premium at
        // most, territory tax at most 25% — for BOTH actor kinds.
        for outcome in [&agent_pull, &player_pull] {
            let yielded = outcome
                .gained
                .iter()
                .find(|s| s.kind == ItemKind::Iron)
                .expect("the node's resource should be yielded");
            assert!(
                (1..=7).contains(&yielded.count),
                "yield outside the shared roll bounds: {}",
                yielded.count
            );
        }
        assert_eq!(
            inv::count_items(&world.players[&player].inventory.slots, ItemKind::Iron),
            player_pull.gained.iter().find(|s| s.kind == ItemKind::Iron).unwrap().count,
            "player yield must land in the shared slotted inventory"
        );
        // Out of range is refused for everyone (both nodes already cooled
        // by moving the clock, so range is the only gate).
        world.tick += (NODE_GATHER_COOLDOWN / TICK_DT).ceil() as u64 + 1;
        let far = plant_test_node(&mut world, pos + Vec3::new(50.0, 0.0, 0.0), 0);
        assert!(world.gather_node(EconActor::Agent(idx), far).is_none());
        assert!(world.gather_node(EconActor::Player(player), far).is_none());
    }

    #[test]
    fn agent_gather_requires_a_real_node() {
        let (mut world, _dir) = test_world();
        world.seed_neighborhood_stores();
        let pos = world.nearest_walkable(district_anchor("NEXUS"));
        let idx = spawn_test_agent(&mut world, FACTION_REBELS, Traits::gatherer(), pos);
        // A gather goal pointed at a node that doesn't exist mints nothing
        // (the old virtual mint is gone) and ends so the brain re-picks.
        let before = world.agents[idx].used_volume();
        world.agents[idx].goal =
            Goal::Gather { node: 999_999_999, spot: pos, pulls_left: 3, timer: 0.0 };
        world.agent_gather_pull(idx);
        assert_eq!(world.agents[idx].used_volume(), before, "no node, no yield");
        assert!(matches!(world.agents[idx].goal, Goal::Idle));
        // The decision path only ever commits Gather against a live
        // materialized node.
        world.decide_agent(idx);
        if let Goal::Gather { node, spot, .. } = world.agents[idx].goal {
            let n = world.nodes.get(&node).expect("gather goals must target real nodes");
            assert_eq!(n.position, spot, "the walk target is the node itself");
            assert!(n.charges > 0);
        }
        // A pull at a planted node yields through the shared path.
        let node = plant_test_node(&mut world, pos, 0);
        world.agents[idx].goal = Goal::Gather { node, spot: pos, pulls_left: 3, timer: 0.0 };
        world.agent_gather_pull(idx);
        assert!(
            world.agents[idx].count_item(ItemKind::Iron) > 0,
            "agent pull should yield the node's resource"
        );
        assert_eq!(world.nodes[&node].charges, world.node_tuning.charges - 1);
        if let Goal::Gather { pulls_left, .. } = world.agents[idx].goal {
            assert_eq!(pulls_left, 2, "one pull per act");
        }
    }

    #[test]
    fn agents_scoop_dropped_loot() {
        let (mut world, _dir) = test_world();
        world.seed_neighborhood_stores();
        let pos = district_anchor("NEXUS");
        let idx = spawn_test_agent(&mut world, FACTION_REBELS, Traits::gatherer(), pos);
        // A juicy drop right next to the agent (well above the gather score).
        let drop_pos = pos + Vec3::new(3.0, 0.0, 0.0);
        world.spawn_loot(
            drop_pos,
            vec![ItemStack { kind: ItemKind::Pistol, count: 1 }],
            None,
            false,
        );
        let container = *world.loot.keys().next().unwrap();
        world.decide_agent(idx);
        assert!(
            matches!(world.agents[idx].goal, Goal::Loot { container: c, .. } if c == container),
            "scavenger next to a weapon drop should go loot it, got {:?}",
            world.agents[idx].goal
        );
        world.agents[idx].goal = Goal::Loot { container, pos: drop_pos };
        world.agent_loot_pickup(idx, container);
        // The looted upgrade goes straight into the equip slot; the spawn
        // Pipe it displaced returns to the pack as cargo.
        assert_eq!(world.agents[idx].inventory.equipped_weapon, Some(ItemKind::Pistol));
        assert_eq!(world.agents[idx].count_item(ItemKind::Pipe), 1);
        assert!(!world.loot.contains_key(&container), "emptied drop should despawn");

        // Ammo caches are for players: agents never target them.
        world.spawn_ammo_cache(drop_pos, 12);
        world.decide_agent(idx);
        assert!(
            !matches!(world.agents[idx].goal, Goal::Loot { .. }),
            "agents must leave ammo caches alone, got {:?}",
            world.agents[idx].goal
        );
    }

    #[test]
    fn agents_trade_through_the_real_market_book() {
        let (mut world, _dir) = test_world();
        world.seed_neighborhood_stores();
        let contested = district_anchor("NEXUS");
        let seller = spawn_test_agent(&mut world, FACTION_REBELS, Traits::trader(), contested);
        let buyer = spawn_test_agent(&mut world, FACTION_REBELS, Traits::crafter(), contested);
        world.agents[seller].add_item(ItemKind::Iron, 30);
        world.agent_market_list(seller);
        assert!(!world.market.is_empty(), "trader should have listed its haul");
        let listing_price = world
            .market
            .iter()
            .find(|l| l.kind == ItemKind::Iron)
            .expect("iron listed")
            .price_each;
        let seller_wallet = world.agents[seller].wallet();
        let buyer_wallet = world.agents[buyer].wallet();
        // Fills execute at the terminal now: out past 5 m the book refuses,
        // walking up unlocks it (same range rule players live under).
        assert!(!world.agent_market_buy(buyer, ItemKind::Iron, 10, listing_price));
        let (_, terminal_pos) = world
            .nearest_service(contested, EntityKind::MarketTerminal)
            .expect("market terminal seeded");
        world.agents[buyer].position = terminal_pos;
        assert!(world.agent_market_buy(buyer, ItemKind::Iron, 10, listing_price));
        let cost = listing_price * 10;
        let fee = cost * MARKET_FEE_PCT / 100;
        assert_eq!(world.agents[buyer].wallet(), buyer_wallet - cost);
        assert_eq!(world.agents[seller].wallet(), seller_wallet + cost - fee);
        assert_eq!(world.agents[buyer].count_item(ItemKind::Iron), 10);
        // The fill landed on the per-item price history at the fill price.
        let hist = world.market_stats.history(ItemKind::Iron).expect("iron history");
        assert_eq!(hist.last_price, listing_price);
        assert_eq!(hist.total_units, 10);
        assert_eq!(hist.total_fills, 1);
        // ...and the drill-in snapshot reflects book + history + vendor refs.
        let state = world.item_market_state(ItemKind::Iron);
        assert_eq!(state.last_price, listing_price);
        assert_eq!(state.listed_units, 20);
        assert_eq!(state.best_ask, listing_price);
        assert_eq!(state.vendor_sell, 2); // Bodega floor
        assert_eq!(state.series.len(), 1);
        // The trade tape carries the fill with both counterparties named.
        assert_eq!(state.recent_fills.len(), 1);
        let tape = &state.recent_fills[0];
        assert_eq!(tape.price_each, listing_price);
        assert_eq!(tape.count, 10);
        assert_eq!(tape.buyer, world.agents[buyer].name);
        assert_eq!(tape.seller, world.agents[seller].name);
    }

    #[test]
    fn agents_list_surplus_gear_but_keep_their_kit() {
        let (mut world, _dir) = test_world();
        world.seed_neighborhood_stores();
        let contested = district_anchor("NEXUS");
        let idx = spawn_test_agent(&mut world, FACTION_REBELS, Traits::trader(), contested);
        // Two SMGs: the best goes to the equip slot (kit), the spare is cargo.
        world.agents[idx].add_item(ItemKind::Smg, 2);
        world.agents[idx].equip_best_gear();
        world.agents[idx].add_item(ItemKind::Ammo9mm, 100);
        world.agents[idx].add_item(ItemKind::Medkit, 3);
        world.agent_market_list(idx);

        let listed = |world: &World, k: ItemKind| {
            world.market.iter().filter(|l| l.kind == k).map(|l| l.count).sum::<u32>()
        };
        // The spare SMG, ammo above the 90-round reserve and the third medkit
        // hit the book; the fighting kit never does.
        assert_eq!(listed(&world, ItemKind::Smg), 1);
        assert_eq!(listed(&world, ItemKind::Ammo9mm), 10);
        assert_eq!(listed(&world, ItemKind::Medkit), 1);
        assert_eq!(world.agents[idx].inventory.equipped_weapon, Some(ItemKind::Smg));
        assert_eq!(world.agents[idx].count_item(ItemKind::Ammo9mm), 90);
        assert_eq!(world.agents[idx].count_item(ItemKind::Medkit), 2);
    }

    #[test]
    fn weaponless_agents_arm_off_the_book_before_the_armory() {
        let (mut world, _dir) = test_world();
        world.seed_neighborhood_stores();
        let contested = district_anchor("NEXUS");
        // Haul leaning damps the capture multiplier so the errand comparison
        // (market ask vs Armory counter) is what the test exercises.
        let idx = spawn_test_agent(&mut world, FACTION_REBELS, Traits::hauler(), contested);
        // Fully disarm: the spawn Pipe may sit in the pack or the equip slot.
        world.agents[idx].remove_item(ItemKind::Pipe, 1);
        world.agents[idx].inventory.equipped_weapon = None;
        world.agents[idx].purse.credit(Currency::Wild, 300); // 400 total
        // An SMG ask under the Armory's 320 counter price is the bargain path.
        world.market.push(wilder_market::Listing {
            id: 900,
            seller: uuid::Uuid::new_v4(),
            seller_name: "VEX".into(),
            kind: ItemKind::Smg,
            count: 1,
            price_each: 300,
            agent: true,
        });
        assert_eq!(world.market_bargain(ItemKind::Smg, 400), Some(300));
        // Too poor to take the ask -> no bargain.
        assert_eq!(world.market_bargain(ItemKind::Smg, 200), None);
        world.decide_agent(idx);
        assert!(
            matches!(
                world.agents[idx].goal,
                Goal::BuyMarket { kind: ItemKind::Smg, max_each: 300, .. }
            ),
            "expected a market-first weapon buy, got {:?}",
            world.agents[idx].goal
        );
        // An ask above the vendor's counter price never qualifies.
        world.market[0].price_each = 350;
        assert_eq!(world.market_bargain(ItemKind::Smg, 400), None);
    }

    #[test]
    fn crafters_restock_intermediates_off_the_book() {
        let (mut world, _dir) = test_world();
        world.seed_neighborhood_stores();
        let contested = district_anchor("NEXUS");
        let idx = spawn_test_agent(&mut world, FACTION_REBELS, Traits::crafter(), contested);
        // A fairly priced intermediate (SteelPlate, ref 13: fair up to 26) is
        // wanted craft input now, not just the four raw resources.
        world.market.push(wilder_market::Listing {
            id: 901,
            seller: uuid::Uuid::new_v4(),
            seller_name: "VEX".into(),
            kind: ItemKind::SteelPlate,
            count: 4,
            price_each: 20,
            agent: true,
        });
        world.decide_agent(idx);
        assert!(
            matches!(
                world.agents[idx].goal,
                Goal::BuyMarket { kind: ItemKind::SteelPlate, .. }
            ),
            "expected an intermediate-material restock, got {:?}",
            world.agents[idx].goal
        );
    }

    #[test]
    fn agent_ask_price_floats_with_the_book() {
        let (mut world, _dir) = test_world();
        let base = base_value(ItemKind::Iron).max(1);

        // Virgin market: list at ~110% of base value, rounded up so cheap
        // items still leave the floor (iron: ceil(2.2) = 3).
        assert_eq!(world.agent_ask_price(ItemKind::Iron), (base * 11).div_ceil(10));

        // Competition on the book: undercut the cheapest ask by ~5%.
        world.market.push(wilder_market::Listing {
            id: 900,
            seller: uuid::Uuid::nil(),
            seller_name: "Vex".into(),
            kind: ItemKind::Iron,
            count: 5,
            price_each: 5,
            agent: true,
        });
        assert_eq!(world.agent_ask_price(ItemKind::Iron), 4); // 5 * 95 / 100
        // An overpriced ask is undercut but stays inside the clamp band.
        world.market[0].price_each = 500;
        assert_eq!(world.agent_ask_price(ItemKind::Iron), base * 3);
        world.market.clear();

        // Demand cleared the book: next ask marks up over the last fill,
        // clamped to the [base/2, base*3] band.
        world.market_stats.record_fill(ItemKind::Iron, 5, 10, "B".into(), "S".into());
        assert_eq!(world.market_ref_price(ItemKind::Iron), 5);
        assert_eq!(world.agent_ask_price(ItemKind::Iron), (5u32 * 11).div_ceil(10).min(base * 3));
        // A pathological fill price is clamped before it steers pricing.
        world.market_stats.record_fill(ItemKind::Iron, 10_000, 1, "B".into(), "S".into());
        assert_eq!(world.market_ref_price(ItemKind::Iron), base * 3);
        assert_eq!(world.agent_ask_price(ItemKind::Iron), base * 3);
    }

    #[test]
    fn agent_asks_decay_and_stale_stock_evicts() {
        let (mut world, _dir) = test_world();
        let mk = |id: u64, kind: ItemKind, price: u32, agent: bool| wilder_market::Listing {
            id,
            seller: uuid::Uuid::nil(),
            seller_name: "X".into(),
            kind,
            count: 3,
            price_each: price,
            agent,
        };
        // Knife base 38 -> floor 19. An overpriced agent ask walks down 5%
        // per decay tick; the player ask never moves.
        world.market.push(mk(1, ItemKind::Knife, 41, true));
        world.market.push(mk(2, ItemKind::Knife, 41, false));
        world.tick_market_decay();
        assert_eq!(world.market[0].price_each, 38); // 41 * 95 / 100
        assert_eq!(world.market[1].price_each, 41);
        // Repeated decay bottoms out at the floor and stays there.
        for _ in 0..64 {
            world.tick_market_decay();
        }
        let floor = (base_value(ItemKind::Knife) / 2).max(1);
        assert_eq!(world.market[0].price_each, floor);
        assert_eq!(world.market[1].price_each, 41);

        // Eviction scraps the floor-priced agent listing (burned on the
        // ledger) but never touches player stock.
        assert!(world.evict_stale_listing());
        assert_eq!(world.market.len(), 1);
        assert!(!world.market[0].agent);
        assert!(!world.evict_stale_listing());
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
    fn territory_capture_is_halo_style() {
        let (mut world, _dir) = test_world();
        let contested = district_anchor("NEXUS");
        let region = region_of(contested);

        // First there wins: a single Forum agent claims the empty cell.
        let forum = spawn_test_agent(&mut world, FACTION_FORUM, Traits::fighter(), contested);
        world.tick_territory();
        assert_eq!(world.territory.get(&region), Some(&FACTION_FORUM));

        // Rebels move in alongside Forum: a contested standoff does NOT flip
        // the cell, no matter how many pile in.
        for _ in 0..4 {
            spawn_test_agent(&mut world, FACTION_REBELS, Traits::fighter(), contested);
        }
        world.tick_territory();
        assert_eq!(
            world.territory.get(&region),
            Some(&FACTION_FORUM),
            "cell must not flip while the holder still has a body in it"
        );

        // Clear the last Forum body: now Rebels are the sole presence and
        // take the cell.
        world.agents[forum].health = 0.0;
        world.tick_territory();
        assert_eq!(world.territory.get(&region), Some(&FACTION_REBELS));

        // Ground held by a hostile faction taxes the other side only.
        assert!(world.region_hostile_to(contested, FACTION_FORUM));
        assert!(!world.region_hostile_to(contested, FACTION_REBELS));

        // Everyone leaves: ownership persists until someone else clears and
        // claims it (Halo hill stays yours while empty).
        for agent in &mut world.agents {
            agent.health = 0.0;
        }
        world.tick_territory();
        assert_eq!(world.territory.get(&region), Some(&FACTION_REBELS));
    }

    #[test]
    fn zone_clock_accrues_rolling_seconds() {
        let (mut world, _dir) = test_world();
        let contested = district_anchor("NEXUS");
        spawn_test_agent(&mut world, FACTION_FORUM, Traits::fighter(), contested);
        // Hold the cell across several territory ticks (each credits ~1 s).
        for _ in 0..5 {
            world.tick_territory();
        }
        let zones = world.zone_standings();
        let nexus = zones.iter().find(|z| z.district == "NEXUS").unwrap();
        assert_eq!(nexus.control, FACTION_FORUM);
        let forum_secs = nexus
            .seconds
            .iter()
            .find(|s| s.faction == FACTION_FORUM)
            .map(|s| s.seconds)
            .unwrap_or(0);
        assert!(forum_secs >= 4, "expected several seconds held, got {forum_secs}");
        // Rolls up into the faction leaderboard as "zone points".
        let data = world.leaderboard();
        let forum = data.factions.iter().find(|f| f.faction == FACTION_FORUM).unwrap();
        assert!(forum.zone_points >= 4);
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
            spawn_test_agent(&mut world, FACTION_WAPES, Traits::fighter(), spot);
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
            spawn_test_agent(&mut world, FACTION_FORUM, Traits::fighter(), sanctuary);
        }
        world.tick_territory();
        assert_eq!(world.territory.get(&region_of(sanctuary)), None);

        // Guarded home turf only ever lights up for its home faction, even
        // when hostiles outnumber the residents.
        let rebel_home = district_anchor("LITTLE MEOW");
        spawn_test_agent(&mut world, FACTION_REBELS, Traits::gatherer(), rebel_home);
        for _ in 0..6 {
            spawn_test_agent(&mut world, FACTION_FORUM, Traits::fighter(), rebel_home);
        }
        world.tick_territory();
        assert_eq!(world.territory.get(&region_of(rebel_home)), Some(&FACTION_REBELS));
    }

    #[test]
    fn kills_feed_the_leaderboard() {
        let (mut world, _dir) = test_world();
        world.seed_neighborhood_stores();
        let contested = district_anchor("NEXUS");
        let killer = spawn_test_agent(&mut world, FACTION_REBELS, Traits::fighter(), contested);
        let victim = spawn_test_agent(&mut world, FACTION_FORUM, Traits::gatherer(), contested);
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

    #[test]
    fn pivotality_peaks_where_one_body_is_decisive() {
        // Capture: the first body onto clean neutral ground flips it, so it
        // is fully pivotal; friendlies piling on add less and less.
        assert!(capture_pivotality(0, 0) > capture_pivotality(1, 0));
        assert!(capture_pivotality(1, 0) > capture_pivotality(4, 0));
        // Contested pushes stay worth joining, with diminishing returns.
        assert!(capture_pivotality(0, 2) > capture_pivotality(3, 2));
        // Defense: securely held ground (no enemies) needs nobody — Halo
        // rules keep empty cells with their holder.
        assert_eq!(defend_pivotality(0, 0), 0.0);
        assert_eq!(defend_pivotality(3, 0), 0.0);
        // A held cell with enemies on it and no defenders is about to flip:
        // more urgent than a walk-in claim of fresh ground.
        assert!(defend_pivotality(0, 2) > capture_pivotality(0, 0));
        // Thin defenses beat stacked ones (marginal body matters more).
        assert!(defend_pivotality(1, 2) > defend_pivotality(4, 2));
    }

    #[test]
    fn territory_flips_credit_capture_learning() {
        let (mut world, _dir) = test_world();
        let contested = district_anchor("NEXUS");
        let idx = spawn_test_agent(&mut world, FACTION_REBELS, Traits::default(), contested);
        let before = world.agents[idx].traits.payoff[Activity::Capture.index()];
        // Sole presence on neutral contested ground claims the cell — and the
        // flip must pay the body that did the claiming.
        world.tick_territory();
        assert_eq!(world.territory.get(&region_of(contested)), Some(&FACTION_REBELS));
        let after = world.agents[idx].traits.payoff[Activity::Capture.index()];
        assert!(after > before, "flip should credit Capture: {before} -> {after}");
    }

    #[test]
    fn capture_leaning_agents_choose_territory_goals() {
        let (mut world, _dir) = test_world();
        world.seed_neighborhood_stores();
        let contested = district_anchor("NEXUS");
        let idx = spawn_test_agent(
            &mut world,
            FACTION_REBELS,
            Traits::leaning(Activity::Capture),
            contested,
        );
        // Build field intel (also claims the agent's own cell); the scorer
        // should then send a capture specialist at the neutral neighbors.
        world.tick_territory();
        world.decide_agent(idx);
        assert!(
            matches!(world.agents[idx].goal, Goal::Capture { .. } | Goal::Defend { .. }),
            "capture-leaning agent should play for territory, chose {:?}",
            world.agents[idx].goal
        );
    }

    #[test]
    fn both_factions_take_ground_and_learning_stays_live() {
        let (mut world, _dir) = test_world();
        world.seed_neighborhood_stores();
        world.seed_agents(200);
        let seeded: Vec<Traits> = world.agents.iter().map(|a| a.traits).collect();
        // A minute of sim: the hub cohorts stage on opposite corners of the
        // contested ring, so presence alone must plant both flags.
        for _ in 0..1200 {
            world.tick += 1;
            world.ledger.set_tick(world.tick);
            world.tick_agents();
            world.tick_territory();
        }
        let holders: HashSet<FactionId> = world.territory.values().copied().collect();
        assert!(holders.contains(&FACTION_REBELS), "rebels hold no ground");
        assert!(holders.contains(&FACTION_FORUM), "forum holds no ground");
        // Realized payoffs (gather pulls, flips, kills) must have moved
        // somebody's estimates away from their seeded priors.
        let moved = world
            .agents
            .iter()
            .zip(&seeded)
            .filter(|(a, s)| a.traits != **s)
            .count();
        assert!(moved > 0, "no agent learned anything in a minute of sim");
    }

    // -------------------------------------------------------------------
    // Phase 3: energy-fueled building queues + output buffers
    // -------------------------------------------------------------------

    /// Register a bare station static (skips the full district seeding).
    fn insert_test_station(world: &mut World, kind: EntityKind, pos: Vec3) -> EntityId {
        let entity = world.alloc_entity();
        world.register_static(StaticEntity {
            entity,
            kind,
            position: pos,
            name: "TEST STATION".into(),
            variant: 0,
            agent_id: uuid::Uuid::new_v4(),
        });
        entity
    }

    /// Stock a player for `steel_plate` batches: iron, blueprints, Energy.
    fn stock_player(world: &mut World, entity: EntityId, iron: u32, energy: u32) {
        let player = world.players.get_mut(&entity).unwrap();
        inv::add_items(&mut player.inventory.slots, ItemKind::Iron, iron);
        player.blueprints.insert("steel_plate".into());
        player.purse.credit(Currency::Energy, energy);
    }

    #[test]
    fn queue_charges_inputs_and_energy_upfront_and_cancel_refunds() {
        let (mut world, _dir) = test_world();
        let pos = Vec3::new(10.0, 0.0, 10.0);
        let station = insert_test_station(&mut world, EntityKind::Refinery, pos);
        let entity = insert_test_player(&mut world, pos);
        stock_player(&mut world, entity, 8, 10);
        let actor = EconActor::Player(entity);

        // 2x steel_plate: 8 iron + 2 Energy burn at the counter.
        let job = world.queue_production(actor, station, "steel_plate", 2);
        assert!(job.is_some());
        assert_eq!(world.actor_count_items(actor, ItemKind::Iron), 0);
        assert_eq!(world.actor_purse(actor).unwrap().carried(Currency::Energy), 8);

        // Insufficient Energy denies the batch before anything is consumed.
        let player = world.players.get_mut(&entity).unwrap();
        inv::add_items(&mut player.inventory.slots, ItemKind::Iron, 40);
        let denied = world.queue_production(actor, station, "steel_plate", 10);
        assert!(denied.is_none(), "10 units need 10 Energy, only 8 carried");
        assert_eq!(world.actor_count_items(actor, ItemKind::Iron), 40);

        // Cancel refunds the uncompleted units' inputs AND Energy.
        assert!(world.cancel_production(actor, station, job.unwrap()));
        assert_eq!(world.actor_count_items(actor, ItemKind::Iron), 48);
        assert_eq!(world.actor_purse(actor).unwrap().carried(Currency::Energy), 10);
        assert!(world.production.is_empty(), "cancelled queue should retire");
    }

    #[test]
    fn building_energy_cap_powers_concurrent_jobs_up_to_the_cap() {
        let (mut world, _dir) = test_world();
        let pos = Vec3::new(10.0, 0.0, 10.0);
        let station = insert_test_station(&mut world, EntityKind::Refinery, pos);
        let entity = insert_test_player(&mut world, pos);
        stock_player(&mut world, entity, 20, 5);
        let actor = EconActor::Player(entity);
        // 5 one-Energy jobs at a cap-4 Refinery: four run, the fifth waits.
        for _ in 0..5 {
            assert!(world.queue_production(actor, station, "steel_plate", 1).is_some());
        }
        world.tick_production();
        let jobs = &world.production[&station];
        let powered: Vec<bool> = jobs.iter().map(|j| j.powered).collect();
        assert_eq!(powered, vec![true, true, true, true, false]);
        // Progress accrues only on the powered four.
        assert!(jobs[3].remaining < jobs[3].recipe.seconds);
        assert_eq!(jobs[4].remaining, jobs[4].recipe.seconds);
        // The sixth-teenth job bounces off the queue cap.
        let player = world.players.get_mut(&entity).unwrap();
        inv::add_items(&mut player.inventory.slots, ItemKind::Iron, 64);
        player.purse.credit(Currency::Energy, 16);
        for _ in 0..11 {
            assert!(world.queue_production(actor, station, "steel_plate", 1).is_some());
        }
        assert_eq!(world.production[&station].len(), PRODUCTION_QUEUE_CAP);
        assert!(world.queue_production(actor, station, "steel_plate", 1).is_none());
    }

    #[test]
    fn output_buffers_collect_within_range_only() {
        let (mut world, _dir) = test_world();
        let pos = Vec3::new(10.0, 0.0, 10.0);
        let station = insert_test_station(&mut world, EntityKind::Refinery, pos);
        let entity = insert_test_player(&mut world, pos);
        stock_player(&mut world, entity, 4, 1);
        let actor = EconActor::Player(entity);
        let owner = world.actor_owner_id(actor).unwrap();
        assert!(world.queue_production(actor, station, "steel_plate", 1).is_some());
        // Step away so the auto-collect sweep can't grab the output.
        world.players.get_mut(&entity).unwrap().character.position =
            pos + Vec3::new(50.0, 0.0, 0.0);
        for _ in 0..(4.0 / TICK_DT) as u32 + 2 {
            world.tick_production();
        }
        assert!(world.production.is_empty(), "batch should have completed");
        let buffer = &world.production_outputs[&(station, owner)];
        assert!(
            buffer.len() == 1
                && buffer[0].kind == ItemKind::SteelPlate
                && buffer[0].count == 1,
            "output belongs in the buffer, not the backpack"
        );
        assert_eq!(world.actor_count_items(actor, ItemKind::SteelPlate), 0);
        // Out of range: nothing moves.
        assert!(world.collect_production(actor, station).is_empty());
        assert!(world.production_outputs.contains_key(&(station, owner)));
        // In range: the buffer empties into the pack.
        world.players.get_mut(&entity).unwrap().character.position = pos;
        let got = world.collect_production(actor, station);
        assert!(got.len() == 1 && got[0].kind == ItemKind::SteelPlate && got[0].count == 1);
        assert_eq!(world.actor_count_items(actor, ItemKind::SteelPlate), 1);
        assert!(!world.production_outputs.contains_key(&(station, owner)));
    }

    #[test]
    fn players_near_the_station_auto_collect_finished_units() {
        let (mut world, _dir) = test_world();
        let pos = Vec3::new(10.0, 0.0, 10.0);
        let station = insert_test_station(&mut world, EntityKind::Refinery, pos);
        let entity = insert_test_player(&mut world, pos);
        stock_player(&mut world, entity, 4, 1);
        let actor = EconActor::Player(entity);
        assert!(world.queue_production(actor, station, "steel_plate", 1).is_some());
        // Standing at the counter: the finished unit flows straight through
        // the buffer into the pack (no Collect button until Phase 6).
        for _ in 0..(4.0 / TICK_DT) as u32 + 2 {
            world.tick_production();
        }
        assert_eq!(world.actor_count_items(actor, ItemKind::SteelPlate), 1);
        assert!(world.production_outputs.is_empty());
    }

    #[test]
    fn production_queues_and_buffers_survive_restart() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(RocksStore::open(dir.path()).unwrap());
        let (_tx, rx) = mpsc::unbounded_channel();
        std::mem::forget(_tx);
        let mut world = new_world(store.clone(), rx);
        let station = world
            .services_by_kind
            .get(&EntityKind::Refinery)
            .and_then(|v| v.first())
            .map(|&(id, _)| id)
            .expect("district seeding places refineries");
        let station_pos = world.statics[&station].position;
        let entity = insert_test_player(&mut world, station_pos);
        stock_player(&mut world, entity, 8, 2);
        let actor = EconActor::Player(entity);
        let owner = world.actor_owner_id(actor).unwrap();
        let job = world.queue_production(actor, station, "steel_plate", 2).unwrap();
        // Half a unit of progress plus a hand-buffered stack to round-trip.
        for _ in 0..40 {
            world.tick_production();
        }
        world
            .production_outputs
            .insert((station, owner), vec![ItemStack { kind: ItemKind::Copper, count: 3 }]);
        world.production_dirty = true;
        let remaining_before = world.production[&station][0].remaining;
        world.save_all();

        // Restart: same store, fresh world.
        let (_tx2, rx2) = mpsc::unbounded_channel();
        std::mem::forget(_tx2);
        let world2 = new_world(store, rx2);
        let jobs = &world2.production[&station];
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].id, job);
        assert_eq!(jobs[0].owner, owner);
        assert_eq!(jobs[0].recipe.id, "steel_plate");
        assert_eq!(jobs[0].count, 2);
        assert!((jobs[0].remaining - remaining_before).abs() < 1e-3);
        assert!(world2.next_job_id > job, "job ids must not recycle after load");
        let buffer = &world2.production_outputs[&(station, owner)];
        assert!(buffer.len() == 1 && buffer[0].kind == ItemKind::Copper && buffer[0].count == 3);
    }

    #[test]
    fn research_costs_energy_and_agents_unlock_through_the_shared_path() {
        let (mut world, _dir) = test_world();
        let pos = Vec3::new(10.0, 0.0, 10.0);
        insert_test_station(&mut world, EntityKind::Laboratory, pos);
        let idx = spawn_test_agent(&mut world, FACTION_REBELS, Traits::crafter(), pos);
        let actor = EconActor::Agent(idx);
        assert!(!world.actor_knows_blueprint(actor, "polymer"));
        world.agents[idx].add_item(ItemKind::BlueprintFragment, RESEARCH_FRAGMENTS);
        world.agents[idx].add_item(ItemKind::Electronics, 5);
        world.agents[idx].add_item(ItemKind::Chemicals, 5);
        // Fragments + resources in hand but no Energy: research denied.
        assert!(!world.research(actor, "polymer"));
        world.agents[idx].purse.credit(Currency::Energy, RESEARCH_ENERGY);
        assert!(world.research(actor, "polymer"));
        assert!(world.actor_knows_blueprint(actor, "polymer"));
        assert_eq!(world.agents[idx].purse.carried(Currency::Energy), 0);
        assert_eq!(world.agents[idx].count_item(ItemKind::BlueprintFragment), 0);
        // Unlocked knowledge rides the shard save format.
        let save = world.agents[idx].save();
        assert!(save.blueprints.contains(&"polymer".to_string()));
    }

    #[test]
    fn agents_only_queue_recipes_they_know() {
        let (mut world, _dir) = test_world();
        let pos = Vec3::new(10.0, 0.0, 10.0);
        let station = insert_test_station(&mut world, EntityKind::Refinery, pos);
        let actor_idx = spawn_test_agent(&mut world, FACTION_REBELS, Traits::crafter(), pos);
        let actor = EconActor::Agent(actor_idx);
        // polymer is not a default blueprint: the shared validation denies it
        // even with inputs + Energy in hand.
        world.agents[actor_idx].add_item(ItemKind::Chemicals, 3);
        world.agents[actor_idx].add_item(ItemKind::Biomass, 2);
        world.agents[actor_idx].purse.credit(Currency::Energy, 5);
        assert!(world.queue_production(actor, station, "polymer", 1).is_none());
        world.agents[actor_idx].blueprints.insert("polymer".into());
        assert!(world.queue_production(actor, station, "polymer", 1).is_some());
    }

    #[test]
    fn agent_queue_craft_end_to_end_queues_waits_and_collects() {
        let (mut world, _dir) = test_world();
        let pos = Vec3::new(10.0, 0.0, 10.0);
        let station = insert_test_station(&mut world, EntityKind::Refinery, pos);
        let idx = spawn_test_agent(&mut world, FACTION_REBELS, Traits::crafter(), pos);
        // Gather-stocked crafter: iron for one plate + Energy to fuel it.
        world.agents[idx].add_item(ItemKind::Iron, 4);
        world.agents[idx].purse.credit(Currency::Energy, 2);
        world.agents[idx].goal =
            Goal::Craft { station, station_pos: pos, recipe: "steel_plate" };
        world.agent_act(idx);
        assert_eq!(world.agents[idx].pending_jobs, vec![(station, 1)]);
        assert_eq!(world.agents[idx].count_item(ItemKind::Iron), 0);
        assert_eq!(world.agents[idx].purse.carried(Currency::Energy), 1);
        // The batch cooks into the agent's buffer.
        for _ in 0..(4.0 / TICK_DT) as u32 + 2 {
            world.tick_production();
        }
        let owner = OwnerId::Agent(world.agents[idx].agent_id);
        assert!(world.production_outputs.contains_key(&(station, owner)));
        // The brain routes a Collect errand at the waiting buffer...
        world.decide_agent(idx);
        assert!(
            matches!(world.agents[idx].goal, Goal::Collect { building, .. } if building == station),
            "expected a Collect errand, got {:?}",
            world.agents[idx].goal
        );
        // ...and arrival pulls the goods and retires the pending note.
        world.agent_act(idx);
        assert_eq!(world.agents[idx].count_item(ItemKind::SteelPlate), 1);
        assert!(world.agents[idx].pending_jobs.is_empty());
        assert!(!world.production_outputs.contains_key(&(station, owner)));
    }

    #[test]
    fn agent_death_purges_its_jobs_and_buffers() {
        let (mut world, _dir) = test_world();
        let pos = Vec3::new(10.0, 0.0, 10.0);
        let station = insert_test_station(&mut world, EntityKind::Refinery, pos);
        let idx = spawn_test_agent(&mut world, FACTION_REBELS, Traits::crafter(), pos);
        world.agents[idx].add_item(ItemKind::Iron, 4);
        world.agents[idx].purse.credit(Currency::Energy, 1);
        assert!(world
            .queue_production(EconActor::Agent(idx), station, "steel_plate", 1)
            .is_some());
        let owner = OwnerId::Agent(world.agents[idx].agent_id);
        world
            .production_outputs
            .insert((station, owner), vec![ItemStack { kind: ItemKind::Pipe, count: 1 }]);
        world.agents[idx].pending_jobs.push((station, 1));
        world.kill_agent(idx, false);
        assert!(world.production.is_empty(), "dead owner's queued jobs must drop");
        assert!(!world.production_outputs.contains_key(&(station, owner)));
        assert!(world.agents[idx].pending_jobs.is_empty());
    }

    #[test]
    fn hot_agents_share_currency_pickups() {
        let (mut world, _dir) = test_world();
        let pos = Vec3::new(10.0, 0.0, 10.0);
        let idx = spawn_test_agent(&mut world, FACTION_REBELS, Traits::crafter(), pos);
        world.agents[idx].tier = Tier::Hot;
        world.regrid_agent(idx);
        world.spawn_currency_pickup(pos, Currency::Energy, 3);
        // Pin the pickup onto the agent (spawn jitters the drop position).
        for p in world.pickups.values_mut() {
            p.position = pos;
        }
        let before = world.agents[idx].purse.carried(Currency::Energy);
        world.tick_currency_pickups();
        assert_eq!(world.agents[idx].purse.carried(Currency::Energy), before + 3);
        assert!(world.pickups.is_empty());
    }
}
