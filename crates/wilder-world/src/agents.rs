//! Autonomous faction agents: persistent economic actors that gather, trade,
//! craft, fight and die across every district of the map.
//!
//! This module owns the agent-local state machine (goal + movement + timers).
//! Everything that touches shared world state — deciding goals against live
//! prices, executing economy actions through the ledger, combat resolution —
//! lives on `World` in `lib.rs` and is driven by the events this tick returns.
//!
//! Two-tier LOD: agents near a connected player are **Hot** (full 20 Hz
//! embodied simulation with collision) and replicate as `EntityKind::Agent`
//! entities; everyone else is **Cold** (1 Hz macro simulation from a bucket
//! wheel, no collision stepping, not replicated). The economy is identical in
//! both tiers; only the physical fidelity differs.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use wilder_combat::{weapon_stats, WeaponStats, FIST};
use wilder_inventory as inv;
use wilder_physics::{step_move_speed, CollisionWorld};
use wilder_types::*;

use crate::econ::{Currency, Purse};

/// Movement speed, m/s (a brisk jog — fast enough that agents visibly travel
/// across the map/minimap rather than crawling).
pub const AGENT_SPEED: f32 = 6.5;
/// Hot tier: within this many chunks (Chebyshev) of any connected player.
pub const HOT_RADIUS_CHUNKS: i32 = 2;
/// Cold agents tick from a bucket wheel (`idx % buckets == tick % buckets`).
/// This is the minimum wheel size (1 Hz slices at 20 Hz sim); the wheel grows
/// with population so one tick never simulates more than `COLD_TICK_BUDGET`
/// cold agents (their slice dt grows to match, so sim-time stays honest).
pub const COLD_BUCKETS: u64 = 20;
/// Cap on cold agents simulated per world tick (see `COLD_BUCKETS`).
pub const COLD_TICK_BUDGET: u64 = 1024;
/// Seconds a dead agent waits before respawning as a fresh identity.
pub const AGENT_RESPAWN_SECONDS: f32 = 60.0;
/// Retreat when health drops below this fraction.
pub const RETREAT_HEALTH_PCT: f32 = 0.4;
/// Bank the wallet down (and rest) when it exceeds this many MILD.
pub const WEALTH_RETREAT: u32 = 600;
/// Operating float an agent keeps in its wallet after a bank run (enough to
/// re-arm and buy meds); everything above this is deposited into the vault.
pub const AGENT_BANK_KEEP: u32 = 150;
/// MILD a fresh (respawned) agent pulls from its bank vault to fund the next
/// life, on top of the minted grubstake. Accumulated savings survive death.
pub const AGENT_COMEBACK_WITHDRAW: u32 = 300;
/// Seconds between goal re-scores (staggered per agent).
pub const DECISION_SECONDS: (f32, f32) = (1.0, 2.0);
/// Seconds between gather pulls at a spot.
pub const GATHER_PULL_SECONDS: f32 = 4.0;
/// A* is only requested for targets within this range; farther destinations
/// use straight-line steering (hot: with collision slide, cold: unimpeded).
pub const PATH_RANGE: f32 = 150.0;
/// Attackers stay "retaliation-flagged" for their victims this long.
pub const RETALIATION_SECONDS: f32 = 10.0;
/// Health regained per second while resting in a sanctuary.
pub const SANCTUARY_HEAL_RATE: f32 = 6.0;
/// Seconds after a wealth-retreat before wealth triggers another one.
pub const RETREAT_COOLDOWN: f32 = 240.0;
/// Facing responsiveness, 1/s: the replicated yaw follows the desired
/// heading through a low-pass so per-tick steering noise (crowd-separation
/// shoves, jittering melee targets) can't whip the body back and forth,
/// while real turns still complete in a fraction of a second.
pub const FACE_RESPONSE: f32 = 8.0;
/// Max body turn rate, rad/s. The low-pass alone can't damp *collinear*
/// push-pull (desired heading alternating straight forward/backward keeps
/// the smoothed vector on one line, so its angle still snaps 180°); the
/// rate limit caps any flip to a smooth ~half-second turn.
pub const TURN_RATE: f32 = std::f32::consts::TAU;
/// Seconds the Run pose lingers after the last actual step, so stop-start
/// crowd jostling doesn't flap Run/Idle on every tick.
pub const RUN_HOLD: f32 = 0.25;
/// Agents notice dropped loot within this range when re-scoring goals.
pub const LOOT_SCAN_RANGE: f32 = 60.0;
/// Stash size shared with players (wilder_persistence::Stash::DEFAULT_SLOTS).
pub const STASH_SLOTS: usize = 48;
/// Carried keeper value (MILD) past which an agent scores an Extract run to
/// a Storage terminal (item analog of the `WEALTH_RETREAT` bank run).
pub const EXTRACT_VALUE: u32 = 400;
/// Free backpack volume at or below which extraction pressure kicks in even
/// under the value threshold (a nearly-full pack routes to Storage).
pub const EXTRACT_FREE_VOLUME: u32 = 6;

/// Activity classes an agent learns payoffs over. There are no fixed roles:
/// every agent carries a payoff estimate per class and specializes toward
/// whatever has actually been paying *it* (see [`Traits`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Activity {
    /// Pull resources from the field.
    Gather,
    /// Market work: arbitrage, restocking, vendor purchases.
    Trade,
    /// Turn inputs into higher-value outputs at a station.
    Craft,
    /// Hunt hostiles and win fights.
    Fight,
    /// Take or hold territory regions for the faction.
    Capture,
    /// Realize carried value: haul to counters, loot drops, extract cargo.
    Haul,
}

/// All activity classes, index-aligned with `Traits::payoff`.
pub const ACTIVITIES: [Activity; 6] = [
    Activity::Gather,
    Activity::Trade,
    Activity::Craft,
    Activity::Fight,
    Activity::Capture,
    Activity::Haul,
];

impl Activity {
    pub fn index(self) -> usize {
        match self {
            Activity::Gather => 0,
            Activity::Trade => 1,
            Activity::Craft => 2,
            Activity::Fight => 3,
            Activity::Capture => 4,
            Activity::Haul => 5,
        }
    }
}

/// EMA step for payoff samples (higher = faster adaptation, noisier).
const TRAIT_ALPHA: f32 = 0.15;
/// Softmax temperature over payoff EMAs (MILD/min). Smaller = sharper
/// specialization for the same payoff gap.
const TRAIT_TEMP: f32 = 25.0;
/// Exploration floor: no activity's weight ever drops below this share, so
/// agents keep sampling everything and can re-specialize when the world
/// changes.
const TRAIT_FLOOR: f32 = 0.08;
/// Payoff samples are clamped to this band (MILD/min) so one windfall or
/// one catastrophic death can't blow out the estimate.
const TRAIT_SAMPLE_BAND: (f32, f32) = (-80.0, 240.0);

/// Learned behavior profile: per-activity payoff EMAs in reference MILD per
/// minute of commitment. Behavior multipliers are a softmax over these with
/// an exploration floor — specialization *emerges* from realized returns
/// (kills, margins, capture income) and losses (deaths charge the activity
/// that got the agent killed), rather than being assigned top-down.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Traits {
    pub payoff: [f32; 6],
}

impl Default for Traits {
    fn default() -> Self {
        Traits { payoff: [0.0; 6] }
    }
}

impl Traits {
    /// Fold one realized payoff-rate sample (MILD/min; negative = loss)
    /// into the activity's estimate.
    pub fn credit(&mut self, activity: Activity, rate: f32) {
        let sample = rate.clamp(TRAIT_SAMPLE_BAND.0, TRAIT_SAMPLE_BAND.1);
        let p = &mut self.payoff[activity.index()];
        *p += (sample - *p) * TRAIT_ALPHA;
    }

    /// Behavior multiplier for an activity, scaled so a uniform (fresh)
    /// profile yields exactly 1.0 everywhere. Softmax over payoff EMAs with
    /// an exploration floor: range ≈ [0.48, 3.6].
    pub fn mult(&self, activity: Activity) -> f32 {
        let n = ACTIVITIES.len() as f32;
        let max = self.payoff.iter().fold(f32::MIN, |a, &b| a.max(b));
        let exps = self.payoff.map(|p| ((p - max) / TRAIT_TEMP).exp());
        let sum: f32 = exps.iter().sum();
        let w = exps[activity.index()] / sum.max(1e-6);
        (TRAIT_FLOOR + (1.0 - n * TRAIT_FLOOR) * w) * n
    }

    /// Whether this agent leans toward `activity`: it's the agent's dominant
    /// (best-earning) activity, or a strong learned specialization. Gates that
    /// used a raw `mult >= 1.2` threshold were unreachable for fresh/seeded
    /// populations — softmax multipliers barely clear 1.15 on random priors —
    /// which silently disabled every trader/crafter behavior they guarded.
    /// Dominance is self-normalizing: any population splits into leanings.
    pub fn leans(&self, activity: Activity) -> bool {
        self.dominant() == activity || self.mult(activity) >= 1.2
    }

    /// The activity this agent currently earns best at.
    pub fn dominant(&self) -> Activity {
        let mut best = Activity::Gather;
        for a in ACTIVITIES {
            if self.payoff[a.index()] > self.payoff[best.index()] {
                best = a;
            }
        }
        best
    }

    /// Feed/leaderboard label derived from the dominant activity.
    pub fn archetype(&self) -> &'static str {
        match self.dominant() {
            Activity::Gather => "Scavenger",
            Activity::Trade => "Trader",
            Activity::Craft => "Crafter",
            Activity::Fight => "Enforcer",
            Activity::Capture => "Vanguard",
            Activity::Haul => "Runner",
        }
    }

    /// Profile leaning toward one activity (mult ≈ 2.0 there, ≈ 0.79
    /// elsewhere). Used by tests and anywhere a known disposition is needed.
    pub fn leaning(activity: Activity) -> Self {
        let mut t = Traits::default();
        t.payoff[activity.index()] = 40.0;
        t
    }

    pub fn fighter() -> Self {
        Self::leaning(Activity::Fight)
    }
    pub fn gatherer() -> Self {
        Self::leaning(Activity::Gather)
    }
    pub fn trader() -> Self {
        Self::leaning(Activity::Trade)
    }
    pub fn crafter() -> Self {
        Self::leaning(Activity::Craft)
    }
    pub fn hauler() -> Self {
        Self::leaning(Activity::Haul)
    }

    /// Mild random priors so a fresh population starts diverse (initial
    /// mult spread roughly 0.8–1.4) and experience then takes over.
    pub fn seeded<R: rand::Rng>(rng: &mut R) -> Self {
        let mut t = Traits::default();
        for p in &mut t.payoff {
            *p = rng.random_range(0.0..12.0);
        }
        t
    }
}

/// Activity class a goal's outcome (or death during it) attributes to.
pub fn activity_of(goal: Goal) -> Activity {
    match goal {
        Goal::Gather { .. } => Activity::Gather,
        Goal::Trade { .. } | Goal::BuyMarket { .. } | Goal::Buy { .. } => Activity::Trade,
        Goal::Craft { .. } | Goal::Research { .. } | Goal::Collect { .. } => Activity::Craft,
        Goal::Patrol { .. } | Goal::Hunt { .. } | Goal::Idle | Goal::Retreat { .. } => {
            Activity::Fight
        }
        Goal::Capture { .. } | Goal::Defend { .. } => Activity::Capture,
        Goal::Sell { .. } | Goal::Loot { .. } | Goal::Bank { .. } | Goal::Extract { .. } => {
            Activity::Haul
        }
    }
}

/// Simulation fidelity tier (see module docs).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tier {
    Hot,
    Cold,
}

/// What an agent is currently committed to. Goals carry their own progress
/// state; the world's utility scorer (`World::decide_agent`) picks new ones.
#[derive(Debug, Clone, Copy)]
pub enum Goal {
    Idle,
    /// Work a resource node: arrive at its spot, then pull off it on a
    /// timer through the same `gather_node` rules players use.
    Gather { node: EntityId, spot: Vec3, pulls_left: u32, timer: f32 },
    /// Haul to a store and sell carried goods (traders list on the market).
    Sell { store: EntityId, store_pos: Vec3, list_on_market: bool },
    /// Buy `count` of `kind` from a vendor.
    Buy { store: EntityId, store_pos: Vec3, kind: ItemKind, count: u32 },
    /// Buy `kind` off the market book (up to `max_each` per unit).
    BuyMarket { terminal_pos: Vec3, kind: ItemKind, count: u32, max_each: u32 },
    /// Work the market terminal for arbitrage opportunities.
    Trade { terminal_pos: Vec3 },
    /// Walk to a station and queue a production batch through the shared
    /// `queue_production` path (inputs + Energy burn at the counter; the
    /// output lands in the building's buffer for a later Collect).
    Craft { station: EntityId, station_pos: Vec3, recipe: &'static str },
    /// Walk to a Laboratory and unlock `recipe` through the shared
    /// `research()` path (fragments + resources + Energy).
    Research { lab: EntityId, lab_pos: Vec3, recipe: &'static str },
    /// Pick up this agent's buffered production output at a building.
    Collect { building: EntityId, building_pos: Vec3 },
    /// Move toward a contested area looking for targets.
    Patrol { to: Vec3 },
    /// Push into a territory region to flip it: stand on the ground until
    /// the presence math (see `World::tick_territory`) does the rest.
    Capture { region: (i32, i32), to: Vec3 },
    /// Hold a friendly region against enemy presence (same mechanics as
    /// Capture; split so feeds/attribution read correctly).
    Defend { region: (i32, i32), to: Vec3 },
    /// Chase and attack a hostile entity.
    Hunt { target: EntityId },
    /// Fall back to a sanctuary and heal up.
    Retreat { to: Vec3 },
    /// Walk to a dropped loot container and grab its contents.
    Loot { container: EntityId, pos: Vec3 },
    /// Haul wealth to a Bank and deposit it into the death-safe vault.
    Bank { store: EntityId, store_pos: Vec3 },
    /// Haul keeper cargo (fragments, craft materials, spare gear) to a
    /// Storage terminal and deposit it into the death-safe stash.
    Extract { store: EntityId, store_pos: Vec3 },
}

impl Goal {
    /// Where this goal wants the agent to stand, if anywhere.
    pub fn destination(&self) -> Option<Vec3> {
        match self {
            Goal::Idle | Goal::Hunt { .. } => None,
            Goal::Gather { spot, .. } => Some(*spot),
            Goal::Sell { store_pos, .. } => Some(*store_pos),
            Goal::Buy { store_pos, .. } => Some(*store_pos),
            Goal::BuyMarket { terminal_pos, .. } => Some(*terminal_pos),
            Goal::Trade { terminal_pos } => Some(*terminal_pos),
            Goal::Craft { station_pos, .. } => Some(*station_pos),
            Goal::Research { lab_pos, .. } => Some(*lab_pos),
            Goal::Collect { building_pos, .. } => Some(*building_pos),
            Goal::Patrol { to } => Some(*to),
            Goal::Capture { to, .. } => Some(*to),
            Goal::Defend { to, .. } => Some(*to),
            Goal::Retreat { to } => Some(*to),
            Goal::Loot { pos, .. } => Some(*pos),
            Goal::Bank { store_pos, .. } => Some(*store_pos),
            Goal::Extract { store_pos, .. } => Some(*store_pos),
        }
    }
}

/// Hunt-target snapshot resolved by the world before the agent ticks.
#[derive(Debug, Clone, Copy)]
pub struct TargetInfo {
    pub position: Vec3,
    pub alive: bool,
}

/// What an agent's tick asks the world to do.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum AgentEvent {
    None,
    /// Landed an attack on `target` this tick (hot tier only).
    Attack { target: EntityId, damage: f32 },
    /// Arrived and an action timer fired: execute the goal's economic leg.
    Act,
    /// Goal finished or became invalid: re-score and commit to a new one.
    NeedsGoal,
}

/// Persisted form of one agent (world_meta key `faction_agents`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentSave {
    pub agent_id: AgentId,
    pub name: String,
    pub faction: FactionId,
    pub guild: String,
    /// Learned behavior profile — persists so agents grow and evolve across
    /// sessions (and across respawns; see `World::respawn_agent`).
    #[serde(default)]
    pub traits: Traits,
    pub home: usize,
    /// Fixed staging position this agent defends and respawns at (hub-cohort
    /// agents). `None` = legacy behavior: stage at the home district's spot.
    #[serde(default)]
    pub home_spot: Option<Vec3>,
    /// Carried + banked currency balances.
    #[serde(default)]
    pub purse: Purse,
    /// Slotted backpack + equipped gear (pre-purse saves are dropped by the
    /// `AGENT_SEED_LAYOUT` bump, so no flat-stack migration is needed).
    #[serde(default)]
    pub inventory: Inventory,
    /// Known blueprint recipe ids (defaults are re-inserted on load, so
    /// older saves without the field just know the starter set).
    #[serde(default)]
    pub blueprints: Vec<String>,
    /// Death-safe item stash slots (48, same volume rules as the player
    /// stash). Older saves without the field start with an empty stash.
    #[serde(default)]
    pub stash: Vec<Option<ItemStack>>,
    /// Outstanding production work: (building, job id) of batches this agent
    /// queued and hasn't collected yet.
    #[serde(default)]
    pub pending_jobs: Vec<(EntityId, u64)>,
    pub position: Vec3,
    pub health: f32,
    pub max_health: f32,
}

/// Mint a fresh agent identity: uuid + a feed-friendly display name like
/// "REBEL-3F2A" / "FORUM-9C01" (same pattern as `npc::mint_agent_identity`).
pub fn mint_agent_name(faction: FactionId) -> (AgentId, String) {
    let id = uuid::Uuid::new_v4();
    let short = id.simple().to_string()[..4].to_uppercase();
    let prefix = match faction {
        FACTION_REBELS => "REBEL",
        FACTION_FORUM => "FORUM",
        _ => "AGENT",
    };
    (id, format!("{prefix}-{short}"))
}

/// Guild names per faction; agents map to one by home district.
pub fn guild_for(faction: FactionId, home_district: usize) -> String {
    const REBEL_GUILDS: &[&str] = &["Dead Signal", "Static Choir", "Neon Fangs"];
    const FORUM_GUILDS: &[&str] = &["The Moderators", "Silent Sysops", "Archive Wardens"];
    let table = if faction == FACTION_FORUM { FORUM_GUILDS } else { REBEL_GUILDS };
    table[home_district % table.len()].to_string()
}

/// Reference value of an item in MILD, for utility scoring and trader
/// arbitrage. Resources track the Bodega sell line; refined goods carry a
/// value-added markup over their recipe inputs; gear sits under Armory buy
/// prices so the market is the cheaper path.
pub fn base_value(kind: ItemKind) -> u32 {
    match kind {
        ItemKind::Iron | ItemKind::Copper => 2,
        ItemKind::Chemicals => 3,
        ItemKind::Electronics => 4,
        ItemKind::Biomass => 1,
        ItemKind::SteelPlate => 13,
        ItemKind::CopperWire => 5,
        ItemKind::Polymer => 17,
        ItemKind::CircuitBoard => 29,
        ItemKind::BioGel => 11,
        ItemKind::Pipe => 26,
        ItemKind::Knife => 38,
        ItemKind::Pistol => 112,
        ItemKind::Smg => 250,
        ItemKind::JacketArmor => 72,
        ItemKind::PlateArmor => 180,
        ItemKind::Ammo9mm => 1,
        ItemKind::Medkit => 20,
        ItemKind::Flashlight => 6,
        ItemKind::Cash => 1,
        ItemKind::BlueprintFragment => 40,
        ItemKind::PowerCell => 30,
    }
}

/// Personal kit an agent hangs onto: weapons, ammo and meds keep it
/// combat-effective; everything else is sellable cargo.
pub fn is_kit(kind: ItemKind) -> bool {
    matches!(
        kind,
        ItemKind::Smg
            | ItemKind::Pistol
            | ItemKind::Pipe
            | ItemKind::Knife
            | ItemKind::Ammo9mm
            | ItemKind::Medkit
    )
}

/// How many of `kind` this agent keeps for itself; anything above the
/// reserve is sellable surplus. The wielded weapon and armor live in the
/// equip slots (outside the backpack), so every backpack weapon is cargo;
/// only a working buffer of ammo and medkits stays reserved.
pub fn kit_reserve(_agent: &FactionAgent, kind: ItemKind) -> u32 {
    match kind {
        ItemKind::Ammo9mm => 90,
        ItemKind::Medkit => 2,
        _ => 0,
    }
}

/// Weapon kinds in preference order, best first.
pub const WEAPON_PREFERENCE: [ItemKind; 4] =
    [ItemKind::Smg, ItemKind::Pistol, ItemKind::Pipe, ItemKind::Knife];
/// Armor kinds in preference order, best first.
pub const ARMOR_PREFERENCE: [ItemKind; 2] = [ItemKind::PlateArmor, ItemKind::JacketArmor];

/// Rank of `kind` in a preference table (lower = better; not listed = worst).
fn gear_rank(kind: ItemKind, table: &[ItemKind]) -> usize {
    table.iter().position(|&t| t == kind).unwrap_or(usize::MAX)
}

pub struct FactionAgent {
    pub entity: EntityId,
    pub agent_id: AgentId,
    pub name: String,
    pub faction: FactionId,
    pub guild: String,
    /// Learned behavior weights (see [`Traits`]): what this agent has found
    /// profitable, updated from realized payoffs and losses.
    pub traits: Traits,
    /// Index into `districts::district_defs()`.
    pub home: usize,
    /// Fixed staging position for hub-cohort agents (respawn + patrol
    /// anchor). `None` = stage at the home district's spot.
    pub home_spot: Option<Vec3>,
    /// Currency balances, carried and banked. Carried burns on death; the
    /// banked side survives and funds comebacks (see `AGENT_COMEBACK_WITHDRAW`).
    pub purse: Purse,
    /// Slotted backpack + equipped gear: the same model players use (36-slot
    /// volume budget, equip slots outside it). Equipped gear survives death.
    pub inventory: Inventory,
    /// Known blueprint recipe ids. Like `traits` and the banked purse,
    /// blueprint knowledge survives death (the respawned identity keeps it).
    pub blueprints: HashSet<String>,
    /// Death-safe stash slots (48, shared `inv` volume rules), filled and
    /// drained through the same Storage terminals players use. Like the
    /// banked purse, the stash survives death and respawn untouched.
    pub stash: Vec<Option<ItemStack>>,
    /// (building, job id) of queued production batches awaiting a Collect.
    /// Cleared on death (the dead identity's jobs and buffers are purged).
    pub pending_jobs: Vec<(EntityId, u64)>,
    pub position: Vec3,
    pub yaw: f32,
    pub health: f32,
    pub max_health: f32,
    pub tier: Tier,
    pub goal: Goal,
    /// Seconds spent pursuing the current goal (reset when the world commits
    /// a new one). Divides realized payoffs into MILD/min rate samples.
    pub goal_age: f32,
    /// Seconds until the brain re-scores (staggered across agents).
    pub decision_timer: f32,
    /// Seconds until respawn once dead (0 while alive).
    pub respawn_in: f32,
    /// Current waypoint path (from the budgeted A* queue).
    pub path: Vec<Vec3>,
    /// Destination awaiting a path grant, if any.
    pub path_request: Option<Vec3>,
    /// Already sitting in the world's path queue.
    pub path_queued: bool,
    /// Already sitting in the world's decision queue (budgeted re-scores).
    pub decision_queued: bool,
    pub attack_cooldown: f32,
    /// Suppresses wealth-triggered retreats right after one completed.
    pub retreat_cooldown: f32,
    pub anim: AnimState,
    /// Seconds left holding the Attack pose after a swing. A single-tick
    /// (50 ms) Attack blip would be dropped between replication snapshots,
    /// making fights read as idle glitching on clients.
    pub anim_hold: f32,
    /// Seconds left holding the Run pose after the last actual step.
    pub run_hold: f32,
    /// Chunk this agent currently occupies in the world's `agent_grid`
    /// (`None` = not in the grid, i.e. dead or never inserted). Maintained
    /// by `World::regrid_agent`; runtime only, never persisted.
    pub grid_chunk: Option<ChunkCoord>,
    /// Smoothed facing direction backing `yaw` (see `steer_yaw`).
    face: (f32, f32),
}

impl FactionAgent {
    pub fn alive(&self) -> bool {
        self.health > 0.0
    }

    pub fn party(&self) -> TxParty {
        TxParty::Agent { id: self.agent_id, name: self.name.clone(), faction: self.faction }
    }

    pub fn chunk(&self) -> ChunkCoord {
        ChunkCoord::from_world(self.position)
    }

    /// Carried spending money (at-risk MILD). Mutations go through the purse.
    pub fn wallet(&self) -> u32 {
        self.purse.carried(Currency::Wild)
    }

    /// Death-safe banked MILD.
    pub fn bank(&self) -> u32 {
        self.purse.banked(Currency::Wild)
    }

    /// Stats of the equipped weapon. Agents fight with what's in the equip
    /// slot, like players; carried weapons are cargo until equipped (see
    /// `equip_best_gear`). Agents only use weapon slot 1.
    pub fn weapon(&self) -> WeaponStats {
        self.inventory.equipped_weapon.and_then(weapon_stats).unwrap_or(FIST)
    }

    /// Move the best owned weapon and armor into the equip slots (displaced
    /// gear swaps back into the pack as sellable cargo). Called after any
    /// acquisition — grubstake, loot, buys, crafting — so agents always
    /// fight with the best gear they own.
    pub fn equip_best_gear(&mut self) {
        for (held, table) in [
            (self.inventory.equipped_weapon, &WEAPON_PREFERENCE[..]),
            (self.inventory.equipped_armor, &ARMOR_PREFERENCE[..]),
        ] {
            // Each swap strictly improves the equipped rank, so one pass per
            // slot kind suffices — but the displaced piece changes the pack,
            // so re-scan until no upgrade remains.
            let mut held_rank = held.map_or(usize::MAX, |k| gear_rank(k, table));
            loop {
                let upgrade = (0..self.inventory.slots.len()).find(|&i| {
                    self.inventory.slots[i]
                        .is_some_and(|st| gear_rank(st.kind, table) < held_rank)
                });
                let Some(slot) = upgrade else { break };
                let kind = self.inventory.slots[slot].unwrap().kind;
                inv::equip(&mut self.inventory, slot, 0);
                held_rank = gear_rank(kind, table);
            }
        }
    }

    /// Relative combat strength for statistical (cold-tier) resolution.
    pub fn strength(&self) -> f32 {
        let w = self.weapon();
        let dps = w.damage / w.cooldown.max(0.05);
        dps * (self.health / self.max_health).max(0.1)
    }

    pub fn count_item(&self, kind: ItemKind) -> u32 {
        inv::count_items(&self.inventory.slots, kind)
    }

    pub fn stash_count(&self, kind: ItemKind) -> u32 {
        inv::count_items(&self.stash, kind)
    }

    /// Add items through the shared slotted-inventory rules (36-slot volume
    /// budget). Returns the count that did NOT fit — callers must deny the
    /// action or spill the leftover as ground loot, never drop it silently.
    pub fn add_item(&mut self, kind: ItemKind, count: u32) -> u32 {
        inv::add_items(&mut self.inventory.slots, kind, count)
    }

    /// Remove up to `count` items; returns how many were actually removed.
    pub fn remove_item(&mut self, kind: ItemKind, count: u32) -> u32 {
        inv::remove_items(&mut self.inventory.slots, kind, count)
    }

    /// Backpack volume in use (equip slots live outside the budget).
    pub fn used_volume(&self) -> u32 {
        inv::used_volume(&self.inventory.slots)
    }

    /// Total backpack volume budget.
    pub fn capacity(&self) -> u32 {
        self.inventory.slots.len() as u32
    }

    /// Total reference value of backpack goods (drives the Sell utility).
    /// Equipped gear is excluded: it survives death and never sells.
    pub fn carried_value(&self) -> u32 {
        self.inventory.slots.iter().flatten().map(|s| base_value(s.kind) * s.count).sum()
    }

    /// Reference value of the extractable haul: everything except the
    /// personal kit (ammo/meds an agent keeps to stay effective).
    pub fn haul_value(&self) -> u32 {
        self.inventory
            .slots
            .iter()
            .flatten()
            .filter(|s| !is_kit(s.kind))
            .map(|s| base_value(s.kind) * s.count)
            .sum()
    }

    /// Credit a realized payoff (reference MILD; negative = loss) against
    /// the time invested in the current goal, as a MILD/min rate sample.
    /// Clamping the elapsed time keeps instant windfalls from reading as
    /// infinite rates and marathon goals from reading as zero.
    pub fn learn(&mut self, activity: Activity, wild: f32) {
        let minutes = (self.goal_age / 60.0).clamp(0.05, 5.0);
        self.traits.credit(activity, wild / minutes);
    }

    /// Whether this agent answers violence with violence: it needs a real
    /// weapon and must not have learned that fighting is a losing trade
    /// (payoff-specialized economists break off instead).
    pub fn fights_back(&self) -> bool {
        self.weapon().damage > FIST.damage && self.traits.mult(Activity::Fight) >= 0.9
    }

    /// React to taking (non-lethal) damage: fighters turn on the attacker,
    /// everyone else breaks off toward safety on the next decision.
    pub fn react_to_damage(&mut self, attacker: EntityId) {
        if !self.alive() {
            return;
        }
        if self.fights_back() {
            self.goal = Goal::Hunt { target: attacker };
            self.goal_age = 0.0;
        } else {
            // Flee: force an immediate re-score; low health biases Retreat.
            self.decision_timer = 0.0;
        }
        self.attack_cooldown = self.attack_cooldown.max(0.2);
    }

    pub fn snapshot(&self) -> EntitySnapshot {
        EntitySnapshot {
            id: self.entity,
            position: self.position,
            yaw: self.yaw,
            anim: self.anim,
            health_pct: (self.health / self.max_health).max(0.0),
            shield_pct: 0.0,
        }
    }

    pub fn spawn_data(&self, tint: u32) -> EntitySpawnData {
        EntitySpawnData {
            id: self.entity,
            kind: EntityKind::Agent,
            name: self.name.clone(),
            appearance: Appearance { body: 1, tint },
            position: self.position,
            yaw: self.yaw,
            anim: self.anim,
            health_pct: (self.health / self.max_health).max(0.0),
            variant: 0,
            item: None,
            faction: self.faction,
        }
    }

    pub fn save(&self) -> AgentSave {
        AgentSave {
            agent_id: self.agent_id,
            name: self.name.clone(),
            faction: self.faction,
            guild: self.guild.clone(),
            traits: self.traits,
            home: self.home,
            home_spot: self.home_spot,
            purse: self.purse,
            inventory: self.inventory.clone(),
            blueprints: self.blueprints.iter().cloned().collect(),
            stash: self.stash.clone(),
            pending_jobs: self.pending_jobs.clone(),
            position: self.position,
            health: self.health,
            max_health: self.max_health,
        }
    }

    pub fn from_save(entity: EntityId, save: AgentSave) -> Self {
        FactionAgent {
            entity,
            agent_id: save.agent_id,
            name: save.name,
            faction: save.faction,
            guild: save.guild,
            traits: save.traits,
            home: save.home,
            home_spot: save.home_spot,
            purse: save.purse,
            inventory: {
                let mut inventory = save.inventory;
                inventory.ensure_slot_count();
                inventory
            },
            blueprints: {
                // Defaults are always known, whatever the save carried.
                let mut blueprints: HashSet<String> =
                    save.blueprints.into_iter().collect();
                for id in wilder_crafting::DEFAULT_BLUEPRINTS {
                    blueprints.insert((*id).to_string());
                }
                blueprints
            },
            stash: {
                let mut stash = save.stash;
                stash.resize(STASH_SLOTS, None);
                stash
            },
            pending_jobs: save.pending_jobs,
            position: save.position,
            yaw: 0.0,
            health: save.health.max(1.0),
            max_health: save.max_health.max(1.0),
            tier: Tier::Cold,
            goal: Goal::Idle,
            goal_age: 0.0,
            decision_timer: 0.0,
            respawn_in: 0.0,
            path: Vec::new(),
            path_request: None,
            path_queued: false,
            decision_queued: false,
            attack_cooldown: 0.0,
            retreat_cooldown: 0.0,
            anim: AnimState::Idle,
            anim_hold: 0.0,
            run_hold: 0.0,
            grid_chunk: None,
            face: (1.0, 0.0),
        }
    }

    /// Turn the body toward (dx, dz) through a low-pass filter. Steering and
    /// combat both re-aim every tick from instantaneous positions; in a
    /// crowd, separation shoves make those positions (and sub-meter melee
    /// targets) jitter, and an unfiltered `atan2` whips the replicated yaw
    /// back and forth erratically. Filtering only the *displayed* facing
    /// keeps movement exact while the body turns smoothly.
    fn steer_yaw(&mut self, dx: f32, dz: f32, dt: f32) {
        let len = (dx * dx + dz * dz).sqrt();
        if len < 1e-5 {
            return;
        }
        let (dx, dz) = (dx / len, dz / len);
        let k = (dt * FACE_RESPONSE).min(1.0);
        self.face.0 += (dx - self.face.0) * k;
        self.face.1 += (dz - self.face.1) * k;
        if self.face.0 * self.face.0 + self.face.1 * self.face.1 < 1e-4 {
            // A near-180° reversal collapsed the average through zero, where
            // atan2 is unstable: adopt the new heading (rate-limited below).
            self.face = (dx, dz);
        }
        // Rate-limit the actual body turn: collinear reversals pass through
        // the low-pass unattenuated and would still snap the yaw 180°.
        let target = self.face.1.atan2(self.face.0);
        let mut d = target - self.yaw;
        while d > std::f32::consts::PI {
            d -= std::f32::consts::TAU;
        }
        while d < -std::f32::consts::PI {
            d += std::f32::consts::TAU;
        }
        let max = TURN_RATE * dt;
        self.yaw += d.clamp(-max, max);
        // Keep the wrapped representation canonical for replication.
        while self.yaw > std::f32::consts::PI {
            self.yaw -= std::f32::consts::TAU;
        }
        while self.yaw < -std::f32::consts::PI {
            self.yaw += std::f32::consts::TAU;
        }
    }

    /// Advance movement toward `dest`, stopping once within `arrive` meters;
    /// returns the remaining distance. Hot agents step with collision
    /// (following any granted path); cold agents advance unimpeded (macro
    /// simulation). Destinations beyond `PATH_RANGE` steer straight instead
    /// of requesting A*.
    ///
    /// `arrive` matters for crowds: goals share exact destinations (one store
    /// counter, one gather spot), and agents that all march to the same point
    /// interpenetrate — steering re-converges them faster than the crowd
    /// separation pass can push them apart. Stopping at the goal's action
    /// radius leaves room for a crowd to stand as a loose ring instead.
    fn move_toward<W: CollisionWorld>(
        &mut self,
        world: &W,
        dest: Vec3,
        arrive: f32,
        dt: f32,
        hot: bool,
    ) -> f32 {
        // Follow the granted path's next waypoint when one exists.
        let target = loop {
            match self.path.first().copied() {
                Some(wp) if (wp - self.position).length() < 0.5 => {
                    self.path.remove(0);
                }
                Some(wp) => break wp,
                None => break dest,
            }
        };
        let to = target - self.position;
        let dist_to_dest = (dest - self.position).length();
        if dist_to_dest <= arrive.max(0.1) {
            return dist_to_dest;
        }
        self.steer_yaw(to.x, to.z, dt);
        if hot {
            let before = self.position;
            // Never step past the steering target: a fixed-length step that
            // overshoots the destination leaves the agent ping-ponging across
            // it (180° yaw flip every tick) whenever the leftover distance
            // falls inside the arrival radius band.
            let move_dt = dt.min(to.length() / AGENT_SPEED);
            self.position =
                step_move_speed(world, self.position, to.x, to.z, AGENT_SPEED, move_dt);
            if (self.position - before).length_squared() < 1e-8 {
                // Stuck against geometry: ask for a real path (once).
                if self.path.is_empty()
                    && self.path_request.is_none()
                    && dist_to_dest <= PATH_RANGE
                {
                    self.path_request = Some(dest);
                }
            } else {
                self.anim = AnimState::Run;
                self.run_hold = RUN_HOLD;
            }
        } else {
            // Cold macro movement: advance along the segment. No prop or
            // building collision at this tier, but a step never lands on
            // unwalkable ground (water / building footprints): blocked steps
            // slide along one axis (coastline following) and a fully boxed-in
            // agent abandons its goal instead of pushing out to sea. Agents
            // already standing on unwalkable ground (stale saves, old water
            // drift) keep stepping so they can walk back onto the map.
            let step = (AGENT_SPEED * dt).min(to.length());
            if to.length_squared() > 1e-8 {
                let next = self.position + to.normalize() * step;
                if !world.walkable(self.position.x, self.position.z)
                    || world.walkable(next.x, next.z)
                {
                    self.position = next;
                    self.anim = AnimState::Run;
                } else {
                    let slide_x = Vec3::new(next.x, self.position.y, self.position.z);
                    let slide_z = Vec3::new(self.position.x, self.position.y, next.z);
                    let slid = [slide_x, slide_z].into_iter().find(|p| {
                        (*p - self.position).length_squared() > 1e-6
                            && world.walkable(p.x, p.z)
                    });
                    match slid {
                        Some(p) => {
                            self.position = p;
                            self.anim = AnimState::Run;
                        }
                        // Boxed in against water: give up on this destination
                        // (Idle forces a fresh goal on the next slice).
                        None => self.goal = Goal::Idle,
                    }
                }
            }
        }
        (dest - self.position).length()
    }

    /// One simulation slice (hot: dt = tick, cold: dt ≈ 1 s). Pure against
    /// shared world state: reads collision through `world`, resolves the Hunt
    /// target through `target`, and reports everything else as an event.
    pub fn tick<W: CollisionWorld>(
        &mut self,
        world: &W,
        dt: f32,
        hot: bool,
        target: Option<TargetInfo>,
    ) -> AgentEvent {
        if !self.alive() {
            return AgentEvent::None;
        }
        self.anim = AnimState::Idle;
        self.attack_cooldown = (self.attack_cooldown - dt).max(0.0);
        self.retreat_cooldown = (self.retreat_cooldown - dt).max(0.0);
        self.anim_hold = (self.anim_hold - dt).max(0.0);
        self.run_hold = (self.run_hold - dt).max(0.0);
        self.decision_timer -= dt;
        self.goal_age += dt;

        let event = self.tick_goal(world, dt, hot, target);
        // Run-pose hysteresis: crowd jostling makes stepped/blocked ticks
        // alternate, which would flap Run/Idle on nearly every replication
        // snapshot. Let the Run pose linger briefly instead.
        if self.anim == AnimState::Idle && self.run_hold > 0.0 {
            self.anim = AnimState::Run;
        }
        event
    }

    fn tick_goal<W: CollisionWorld>(
        &mut self,
        world: &W,
        dt: f32,
        hot: bool,
        target: Option<TargetInfo>,
    ) -> AgentEvent {
        match self.goal {
            Goal::Idle => AgentEvent::NeedsGoal,
            Goal::Patrol { to } | Goal::Capture { to, .. } | Goal::Defend { to, .. } => {
                // Walk to the spot, then let the brain re-score on its timer:
                // holding ground is just re-choosing to stand on it while it
                // stays worth holding (presence is what captures).
                if self.move_toward(world, to, 1.5, dt, hot) < 2.0 || self.decision_timer <= 0.0 {
                    AgentEvent::NeedsGoal
                } else {
                    AgentEvent::None
                }
            }
            Goal::Gather { spot, timer, pulls_left, .. } => {
                if pulls_left == 0 {
                    return AgentEvent::NeedsGoal;
                }
                if self.move_toward(world, spot, 1.2, dt, hot) > 2.0 {
                    return AgentEvent::None;
                }
                self.anim = AnimState::Gather;
                let next = timer - dt;
                if let Goal::Gather { timer, .. } = &mut self.goal {
                    *timer = if next <= 0.0 { next + GATHER_PULL_SECONDS } else { next };
                }
                if next <= 0.0 {
                    AgentEvent::Act
                } else {
                    AgentEvent::None
                }
            }
            Goal::Sell { store_pos, .. }
            | Goal::Buy { store_pos, .. }
            | Goal::Bank { store_pos, .. }
            | Goal::Extract { store_pos, .. }
            | Goal::BuyMarket { terminal_pos: store_pos, .. }
            | Goal::Trade { terminal_pos: store_pos } => {
                if self.move_toward(world, store_pos, 3.0, dt, hot) <= 5.0 {
                    AgentEvent::Act
                } else if self.decision_timer <= 0.0 {
                    // Still in transit when the brain timer fires: re-score.
                    // The storefront we committed to may have packed up since
                    // (live congestion), and this is what lets a walker peel
                    // off to an emptier counter — or go back to work — instead
                    // of locking in a jammed door until arrival.
                    AgentEvent::NeedsGoal
                } else {
                    AgentEvent::None
                }
            }
            Goal::Craft { station_pos, .. }
            | Goal::Research { lab_pos: station_pos, .. }
            | Goal::Collect { building_pos: station_pos, .. } => {
                // Counter errands: queue a batch / research / collect the
                // buffer on arrival. Nothing is committed until then, so
                // transit re-scores like any other errand and a crowding
                // station can be rerouted.
                if self.move_toward(world, station_pos, 3.0, dt, hot) <= 5.0 {
                    AgentEvent::Act
                } else if self.decision_timer <= 0.0 {
                    AgentEvent::NeedsGoal
                } else {
                    AgentEvent::None
                }
            }
            Goal::Hunt { target: tid } => {
                let Some(info) = target else {
                    return AgentEvent::NeedsGoal;
                };
                if !info.alive {
                    return AgentEvent::NeedsGoal;
                }
                if !hot {
                    // Cold tier never resolves per-hit combat; drift toward
                    // the target region (statistical combat covers the rest),
                    // but revalidate on the decision timer. Without it a cold
                    // hunter shadows its victim forever — straight into a
                    // sanctuary it can't fight in, camping whatever counter
                    // the victim stops at (the re-score drops protected
                    // targets because `find_hostile_target` won't offer them).
                    self.move_toward(world, info.position, 2.0, dt, false);
                    return if self.decision_timer <= 0.0 {
                        AgentEvent::NeedsGoal
                    } else {
                        AgentEvent::None
                    };
                }
                let weapon = self.weapon();
                let dist = (info.position - self.position).length();
                if dist <= weapon.range + 0.4 {
                    let to = info.position - self.position;
                    self.steer_yaw(to.x, to.z, dt);
                    if self.attack_cooldown <= 0.0 {
                        self.attack_cooldown = weapon.cooldown.max(0.6);
                        self.anim = AnimState::Attack;
                        self.anim_hold = 0.5;
                        return AgentEvent::Attack { target: tid, damage: weapon.damage };
                    }
                    // Keep the swing pose up between attacks: a single-tick
                    // Attack blip vanishes between replication snapshots and
                    // fights read as idle stutter on clients.
                    if self.anim_hold > 0.0 {
                        self.anim = AnimState::Attack;
                    }
                } else if dist > 60.0 {
                    return AgentEvent::NeedsGoal; // lost the leash
                } else {
                    // Close to just inside attack range, not onto the target:
                    // stacked melee hunters otherwise stand in each other.
                    let arrive = (weapon.range - 0.4).max(0.9);
                    self.move_toward(world, info.position, arrive, dt, true);
                }
                AgentEvent::None
            }
            Goal::Loot { pos, .. } => {
                if self.move_toward(world, pos, 1.2, dt, hot) > 2.0 {
                    AgentEvent::None
                } else {
                    // Arrived on top of the drop: the world transfers the
                    // contents (and validates the container still exists).
                    AgentEvent::Act
                }
            }
            Goal::Retreat { to } => {
                if self.move_toward(world, to, 4.0, dt, hot) > 8.0 {
                    return AgentEvent::None;
                }
                // Resting in the sanctuary: heal up, then get back to work.
                self.health = (self.health + SANCTUARY_HEAL_RATE * dt).min(self.max_health);
                if self.health >= self.max_health {
                    self.retreat_cooldown = RETREAT_COOLDOWN;
                    AgentEvent::NeedsGoal
                } else {
                    AgentEvent::None
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_agent() -> FactionAgent {
        let (agent_id, name) = mint_agent_name(FACTION_REBELS);
        let mut purse = Purse::default();
        purse.credit(Currency::Wild, 80);
        let mut inventory = Inventory::new();
        inv::add_items(&mut inventory.slots, ItemKind::Iron, 5);
        FactionAgent::from_save(
            7,
            AgentSave {
                agent_id,
                name,
                faction: FACTION_REBELS,
                guild: guild_for(FACTION_REBELS, 4),
                traits: Traits::default(),
                home: 4,
                home_spot: None,
                purse,
                inventory,
                blueprints: Vec::new(),
                stash: Vec::new(),
                pending_jobs: Vec::new(),
                position: Vec3::new(10.0, 0.0, 10.0),
                health: 100.0,
                max_health: 100.0,
            },
        )
    }

    #[test]
    fn identity_names_carry_faction_prefix() {
        let (_, rebel) = mint_agent_name(FACTION_REBELS);
        let (_, forum) = mint_agent_name(FACTION_FORUM);
        assert!(rebel.starts_with("REBEL-"));
        assert!(forum.starts_with("FORUM-"));
    }

    #[test]
    fn inventory_add_remove_roundtrip() {
        let mut a = sample_agent();
        assert_eq!(a.add_item(ItemKind::Iron, 120), 0);
        assert_eq!(a.count_item(ItemKind::Iron), 125);
        assert_eq!(a.remove_item(ItemKind::Iron, 30), 30);
        assert_eq!(a.count_item(ItemKind::Iron), 95);
        // Removing more than carried removes only what exists.
        assert_eq!(a.remove_item(ItemKind::Iron, 1000), 95);
        assert_eq!(a.count_item(ItemKind::Iron), 0);
    }

    #[test]
    fn equip_best_gear_upgrades_the_equip_slots() {
        let mut a = sample_agent();
        assert_eq!(a.weapon().damage, FIST.damage);
        a.add_item(ItemKind::Pipe, 1);
        a.equip_best_gear();
        assert_eq!(a.weapon().damage, weapon_stats(ItemKind::Pipe).unwrap().damage);
        assert_eq!(a.count_item(ItemKind::Pipe), 0, "wielded weapon leaves the pack");
        // A better find displaces the pipe back into the pack as cargo.
        a.add_item(ItemKind::Pistol, 1);
        a.add_item(ItemKind::JacketArmor, 1);
        a.equip_best_gear();
        assert_eq!(a.weapon().damage, weapon_stats(ItemKind::Pistol).unwrap().damage);
        assert_eq!(a.count_item(ItemKind::Pipe), 1);
        assert_eq!(a.inventory.equipped_armor, Some(ItemKind::JacketArmor));
        // Equipping a worse weapon never happens.
        a.add_item(ItemKind::Knife, 1);
        a.equip_best_gear();
        assert_eq!(a.inventory.equipped_weapon, Some(ItemKind::Pistol));
        assert_eq!(a.count_item(ItemKind::Knife), 1);
    }

    #[test]
    fn backpack_volume_bounds_the_haul() {
        let mut a = sample_agent(); // 5 Iron: one slot, volume 1
        assert_eq!(a.capacity(), 36);
        // Pistols don't stack and cost 4 volume each: eight fill 33/36.
        assert_eq!(a.add_item(ItemKind::Pistol, 8), 0);
        assert_eq!(a.used_volume(), 33);
        // A ninth needs 4 free volume; only 3 remain — denied, not truncated.
        assert_eq!(a.add_item(ItemKind::Pistol, 1), 1);
        assert_eq!(a.count_item(ItemKind::Pistol), 8);
        // Cheap stackables still fit in the leftover volume.
        assert_eq!(a.add_item(ItemKind::Copper, 10), 0);
        assert_eq!(a.used_volume(), 34);
    }

    #[test]
    fn save_roundtrip_preserves_identity_and_goods() {
        let mut a = sample_agent();
        a.traits = Traits::fighter();
        a.purse.credit(Currency::Shards, 3);
        a.purse.deposit(Currency::Wild, 25);
        a.add_item(ItemKind::Pistol, 1);
        a.equip_best_gear();
        a.blueprints.insert("polymer".to_string());
        inv::add_items(&mut a.stash, ItemKind::SteelPlate, 4);
        a.pending_jobs.push((42, 7));
        let json = serde_json::to_string(&a.save()).unwrap();
        let back: AgentSave = serde_json::from_str(&json).unwrap();
        let b = FactionAgent::from_save(99, back);
        assert_eq!(b.agent_id, a.agent_id);
        assert_eq!(b.name, a.name);
        assert_eq!(b.faction, a.faction);
        assert_eq!(b.guild, a.guild);
        assert_eq!(b.traits, a.traits, "learned traits must survive the save");
        assert_eq!(b.purse, a.purse, "carried and banked balances must survive");
        assert_eq!(b.count_item(ItemKind::Iron), 5);
        assert_eq!(b.inventory.equipped_weapon, Some(ItemKind::Pistol));
        assert!(b.blueprints.contains("polymer"), "researched blueprints must survive");
        assert!(b.blueprints.contains("steel_plate"), "defaults are always known");
        assert_eq!(b.stash_count(ItemKind::SteelPlate), 4, "stashed goods must survive");
        assert_eq!(b.stash.len(), STASH_SLOTS);
        assert_eq!(b.pending_jobs, vec![(42, 7)], "queued work notes must survive");
        assert_eq!(b.entity, 99);
    }

    #[test]
    fn saves_without_purse_or_pack_load_default() {
        // Sparse/older blobs must still load: unknown fields (the retired
        // flat `wallet`) are ignored, missing purse and inventory default.
        let json = r#"{
            "agent_id": "6ec4a03c-4de5-4e56-9d42-6a2c8bbd7c1e",
            "name": "REBEL-6EC4", "faction": 1, "guild": "Dead Signal",
            "role": "Scavenger", "home": 4, "wallet": 80,
            "position": [1.0, 0.0, 2.0], "health": 90.0, "max_health": 100.0
        }"#;
        let save: AgentSave = serde_json::from_str(json).unwrap();
        assert_eq!(save.traits, Traits::default());
        for a in ACTIVITIES {
            assert!((save.traits.mult(a) - 1.0).abs() < 1e-4);
        }
        assert_eq!(save.purse, Purse::default());
        let agent = FactionAgent::from_save(1, save);
        assert_eq!(agent.capacity(), 36, "defaulted pack must have full slots");
    }

    #[test]
    fn traits_learn_and_specialize_from_payoffs() {
        let mut t = Traits::default();
        // Neutral profile: every multiplier is exactly 1.
        for a in ACTIVITIES {
            assert!((t.mult(a) - 1.0).abs() < 1e-4);
        }
        // Crafting keeps paying: its weight rises, everything else sinks.
        for _ in 0..30 {
            t.credit(Activity::Craft, 60.0);
        }
        assert_eq!(t.dominant(), Activity::Craft);
        assert_eq!(t.archetype(), "Crafter");
        assert!(t.mult(Activity::Craft) > 1.5, "craft mult: {}", t.mult(Activity::Craft));
        assert!(t.mult(Activity::Gather) < 1.0);
        // Exploration floor: even the losers keep a nonzero share.
        for a in ACTIVITIES {
            assert!(t.mult(a) >= TRAIT_FLOOR * ACTIVITIES.len() as f32 - 1e-4);
        }
        // Deaths charge the activity: heavy losses push it below neutral.
        let mut t = Traits::default();
        for _ in 0..30 {
            t.credit(Activity::Fight, -50.0);
        }
        assert!(t.mult(Activity::Fight) < 1.0);
        assert_ne!(t.dominant(), Activity::Fight);
    }

    #[test]
    fn haul_value_excludes_personal_kit() {
        let mut a = sample_agent(); // carries 5 Iron (value 2 each)
        a.add_item(ItemKind::Pistol, 1);
        a.add_item(ItemKind::Ammo9mm, 20);
        a.add_item(ItemKind::Medkit, 1);
        a.add_item(ItemKind::SteelPlate, 2);
        assert_eq!(a.haul_value(), 5 * 2 + 2 * 13);
        assert!(a.carried_value() > a.haul_value());
    }

    #[test]
    fn loot_goal_acts_on_arrival() {
        struct Open;
        impl CollisionWorld for Open {
            fn walkable(&self, _: f32, _: f32) -> bool {
                true
            }
        }
        let mut a = sample_agent();
        a.goal = Goal::Loot { container: 42, pos: Vec3::new(40.0, 0.0, 10.0) };
        a.decision_timer = 100.0;
        let mut acted = false;
        for _ in 0..20 {
            if a.tick(&Open, 1.0, false, None) == AgentEvent::Act {
                acted = true;
                break;
            }
        }
        assert!(acted, "agent should reach the drop and ask to act");
        assert!((a.position - Vec3::new(40.0, 0.0, 10.0)).length() <= 2.0);
    }

    #[test]
    fn sell_errand_rescores_when_the_decision_timer_fires() {
        struct Open;
        impl CollisionWorld for Open {
            fn walkable(&self, _: f32, _: f32) -> bool {
                true
            }
        }
        let mut a = sample_agent();
        a.goal =
            Goal::Sell { store: 1, store_pos: Vec3::new(500.0, 0.0, 10.0), list_on_market: false };
        a.decision_timer = 1.5;
        // Timer still alive mid-transit: keep walking.
        assert_eq!(a.tick(&Open, 1.0, false, None), AgentEvent::None);
        // Timer fired well short of the store: ask for a fresh decision so
        // live congestion can reroute the errand instead of locking it in.
        assert_eq!(a.tick(&Open, 1.0, false, None), AgentEvent::NeedsGoal);
    }

    #[test]
    fn cold_movement_ignores_props_but_advances() {
        // Everything walkable: cold macro movement is unimpeded.
        struct Open;
        impl CollisionWorld for Open {
            fn walkable(&self, _: f32, _: f32) -> bool {
                true
            }
        }
        let mut a = sample_agent();
        a.goal = Goal::Patrol { to: Vec3::new(100.0, 0.0, 10.0) };
        a.decision_timer = 100.0;
        let before = a.position;
        a.tick(&Open, 1.0, false, None);
        assert!((a.position - before).length() > 3.0, "cold agent should advance");
    }

    #[test]
    fn hot_movement_settles_at_destination_without_oscillating() {
        struct Open;
        impl CollisionWorld for Open {
            fn walkable(&self, _: f32, _: f32) -> bool {
                true
            }
        }
        let mut a = sample_agent();
        a.position = Vec3::new(0.0, 0.0, 0.0);
        // 3.4 m = 10 full 0.325 m steps + 0.15 m: an unclamped fixed-length
        // step overshoots the spot into the far side of the 0.1 m arrival
        // radius and ping-pongs (180° yaw flip per tick) forever.
        a.goal =
            Goal::Gather { node: 1, spot: Vec3::new(3.4, 0.0, 0.0), pulls_left: 10, timer: 100.0 };
        a.decision_timer = 1000.0;
        let dt = 0.05;
        for _ in 0..200 {
            a.tick(&Open, dt, true, None);
        }
        // Settles inside the Gather arrive radius (1.2 m: crowds stand in a
        // loose ring around shared spots instead of stacking on the point),
        // well within the 2.0 m action range.
        assert!(
            (a.position.x - 3.4).abs() < 1.25,
            "agent should settle near the spot: {:?}",
            a.position
        );
        // Once settled, further ticks must not move the body or swing the yaw.
        let settled = a.position;
        let yaw_before = a.yaw;
        for _ in 0..20 {
            a.tick(&Open, dt, true, None);
        }
        assert!(
            (a.position - settled).length() < 1e-4,
            "agent kept sliding after settling: {:?} -> {:?}",
            settled,
            a.position
        );
        let mut dy = (a.yaw - yaw_before).abs();
        if dy > std::f32::consts::PI {
            dy = 2.0 * std::f32::consts::PI - dy;
        }
        assert!(dy < 0.01, "yaw flipped by {dy} rad while standing at the spot");
    }

    #[test]
    fn scrum_jitter_does_not_whip_the_yaw_around() {
        struct Open;
        impl CollisionWorld for Open {
            fn walkable(&self, _: f32, _: f32) -> bool {
                true
            }
        }
        // A hunter standing in melee range of a target whose position
        // jitters every tick (crowd-separation shoves in a scrum). The
        // replicated yaw must wobble far less than the raw atan2 noise.
        let mut a = sample_agent(); // unarmed: FIST range 1.5
        a.position = Vec3::new(0.0, 0.0, 0.0);
        a.goal = Goal::Hunt { target: 42 };
        a.decision_timer = 1000.0;
        let dt = 0.05;
        let mut min_yaw = f32::MAX;
        let mut max_yaw = f32::MIN;
        for i in 0..100 {
            // Target ~1.2 m away, shoved +/-0.25 m sideways on alternating
            // ticks: raw desired heading swings ~+/-12 degrees per tick.
            let jitter = if i % 2 == 0 { 0.25 } else { -0.25 };
            let info = TargetInfo { position: Vec3::new(1.2, 0.0, jitter), alive: true };
            a.tick(&Open, dt, true, Some(info));
            if i >= 40 {
                min_yaw = min_yaw.min(a.yaw);
                max_yaw = max_yaw.max(a.yaw);
            }
        }
        let wobble = (max_yaw - min_yaw).to_degrees();
        assert!(wobble < 8.0, "yaw wobbled {wobble:.1} degrees in the scrum");
    }

    #[test]
    fn reversals_turn_the_body_smoothly_instead_of_snapping() {
        struct Open;
        impl CollisionWorld for Open {
            fn walkable(&self, _: f32, _: f32) -> bool {
                true
            }
        }
        let mut a = sample_agent();
        a.position = Vec3::new(0.0, 0.0, 0.0);
        a.decision_timer = 1000.0;
        let dt = 0.05;
        // Walk east to settle the facing, then flip the goal due west: the
        // yaw must sweep around over multiple ticks, never snapping.
        a.goal = Goal::Patrol { to: Vec3::new(50.0, 0.0, 0.0) };
        for _ in 0..20 {
            a.tick(&Open, dt, true, None);
        }
        a.goal = Goal::Patrol { to: Vec3::new(-50.0, 0.0, 0.0) };
        let max_step = TURN_RATE * dt + 1e-3;
        for _ in 0..40 {
            let before = a.yaw;
            a.tick(&Open, dt, true, None);
            let mut d = (a.yaw - before).abs();
            if d > std::f32::consts::PI {
                d = std::f32::consts::TAU - d;
            }
            assert!(d <= max_step, "yaw snapped {:.0} degrees in one tick", d.to_degrees());
        }
        // ... and it does complete the turn-around.
        let facing_west = (a.yaw.abs() - std::f32::consts::PI).abs() < 0.2;
        assert!(facing_west, "agent should end up facing west, yaw={}", a.yaw);
    }

    #[test]
    fn cold_movement_never_steps_into_water() {
        // Land for x < 20, water beyond: an agent heading east must stop at
        // (or slide along) the coastline instead of walking out to sea.
        struct Coast;
        impl CollisionWorld for Coast {
            fn walkable(&self, x: f32, _: f32) -> bool {
                x < 20.0
            }
        }
        let mut a = sample_agent();
        a.goal = Goal::Patrol { to: Vec3::new(200.0, 0.0, 10.0) };
        a.decision_timer = 100.0;
        for _ in 0..30 {
            a.tick(&Coast, 1.0, false, None);
        }
        assert!(a.position.x < 20.0, "cold agent crossed into water: {:?}", a.position);
    }

    #[test]
    fn cold_movement_escapes_water_it_woke_up_in() {
        // Restored save stranded at sea: steps toward a land destination must
        // still advance (the no-water rule only gates land -> water).
        struct Coast;
        impl CollisionWorld for Coast {
            fn walkable(&self, x: f32, _: f32) -> bool {
                x < 20.0
            }
        }
        let mut a = sample_agent();
        a.position = Vec3::new(300.0, 0.0, 10.0); // far out at sea
        a.goal = Goal::Patrol { to: Vec3::new(5.0, 0.0, 10.0) };
        a.decision_timer = 1000.0;
        for _ in 0..60 {
            a.tick(&Coast, 1.0, false, None);
        }
        assert!(a.position.x < 20.0, "agent should have walked back ashore: {:?}", a.position);
    }
}
