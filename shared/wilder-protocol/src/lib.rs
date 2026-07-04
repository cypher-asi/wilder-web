//! Wire protocol between the Wilder client and server.
//!
//! Encoding: JSON text frames over WebSocket for now (debuggable, zero client deps).
//! All encode/decode goes through [`encode`]/[`decode`] so a switch to a binary
//! format later is a single-file change. TypeScript mirrors live in
//! `apps/web/src/net/protocol.ts` and must stay in sync with these definitions.

use serde::{Deserialize, Serialize};
use wilder_types::*;

/// Territory grid: a controllable zone is a square block of this many chunks
/// on a side (2 chunks = 64 m). Region math must match
/// `apps/web/src/game/territory.ts`.
pub const REGION_CHUNKS: i32 = 2;

/// Client -> Server messages.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "t", content = "d")]
pub enum C2S {
    /// Bind this connection to a session (token from HTTP login).
    Authenticate { token: String },
    /// Spawn a character into the world (must be authenticated). With
    /// `spectate` the character is loaded as usual (wallet, subscriptions,
    /// `WorldJoined` reply) but no avatar entity is embodied in the world:
    /// nothing to see, kill or collide with. Used by the mobile shell.
    JoinWorld {
        character_id: CharacterId,
        #[serde(default)]
        spectate: bool,
    },
    /// Direct movement input (WASD). `(dx, dz)` is a normalized XZ direction in
    /// world space; `yaw` is the facing (twin-stick aim), which may differ from
    /// the move direction (strafe/backpedal).
    MoveInput { seq: u32, dx: f32, dz: f32, yaw: f32, run: bool },
    /// Click-to-move: server pathfinds to target.
    MoveTo { seq: u32, x: f32, z: f32 },
    /// Stop any current click-to-move path.
    StopMove { seq: u32 },
    /// Dodge roll: a short server-side dash along a normalized XZ direction.
    Roll { seq: u32, dx: f32, dz: f32 },
    /// Toggle crouching (slower movement, crouch animations).
    SetCrouch { on: bool },
    /// Context interaction with an entity (loot, extract, gather...).
    Interact { entity_id: EntityId },
    /// Inventory manipulation.
    InventoryAction(InventoryAction),
    /// Attack: melee swings at facing, ranged fires toward a point.
    Attack { seq: u32, tx: f32, tz: f32 },
    /// Trigger an active ability (hotbar Q/E/R). Server validates cooldowns.
    UseAbility { seq: u32, ability: AbilityKind },
    /// Use a consumable item from a slot.
    UseItem { slot: u16 },
    /// Craft a recipe at a nearby (or personal) station. Phase 2+.
    Craft { recipe: String, station: Option<EntityId> },
    /// Queue a production job at a building. Phase 3.
    QueueProduction { building: EntityId, recipe: String, count: u32 },
    /// Collect the sender's buffered production output at a building
    /// (within 5 m). The server also auto-collects on proximity/interact.
    CollectProduction { building: EntityId },
    /// Cancel one of the sender's own queued jobs at a building. Uncompleted
    /// units' inputs and Energy are refunded; the server validates ownership.
    CancelProduction { building: EntityId, job_id: u64 },
    /// Market actions. Phase 3.
    Market(MarketAction),
    /// NPC vendor actions (Armory, Bodega, Bank...). Requires being in reach
    /// of the vendor building.
    Vendor { vendor: EntityId, action: VendorAction },
    /// Subscribe/unsubscribe to live economy ledger updates (K dashboard).
    EconomySub { on: bool },
    /// Watch one item's market detail (price history, book, supply). `Some`
    /// answers immediately with `ItemMarketState` and re-pushes on new fills;
    /// `None` unsubscribes. Each connection watches at most one kind.
    ItemMarketSub { kind: Option<ItemKind> },
    /// Subscribe/unsubscribe to whole-map agent blips (map filters). While
    /// on, the server streams `MapIntel` at ~1 Hz.
    MapIntelSub { on: bool },
    /// Hire an unowned, living, same-faction agent. The first hire per
    /// character is free (starter grant); later hires cost MILD (see
    /// `AgentSummary::hire_cost`). Answered with `AgentResult`.
    HireAgent { agent_id: AgentId },
    /// Release an owned agent back to its faction. No refund.
    DismissAgent { agent_id: AgentId },
    /// Request hire candidates: answered with `AgentHireOffers` (unowned,
    /// living, same-faction agents, cheapest first).
    AgentHireList,
    /// Subscribe/unsubscribe to the roster of agents this character OWNS.
    /// Subscribing answers immediately with `AgentRoster`, then re-sends
    /// every ~2 s (and on hire/dismiss) while on.
    AgentSub { on: bool },
    /// Watch one OWNED agent's full detail. `Some` answers immediately with
    /// `AgentDetail` and re-pushes ~1 Hz; `None` unsubscribes. Watching an
    /// agent you don't own answers with an `AgentResult` error.
    AgentDetailSub { agent_id: Option<AgentId> },
    /// Follow one OWNED agent with the 3D camera (mobile Watch tab). `Some`
    /// anchors this connection's interest (chunk streaming + entity
    /// replication) on the agent's position and pins the agent to the Hot
    /// tier; `None` clears the anchor. Watching an agent you don't own
    /// answers with an `AgentResult` error.
    WatchAgent { agent_id: Option<AgentId> },
    Chat { text: String },
    Pong { nonce: u32 },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "t", content = "d")]
pub enum InventoryAction {
    MoveSlot { from: u16, to: u16 },
    /// Equip from a backpack slot. `weapon_slot` picks Weapon 1 (0) or
    /// Weapon 2 (1) for weapons; ignored for armor. Defaults to Weapon 1.
    Equip { slot: u16, #[serde(default)] weapon_slot: Option<u8> },
    /// Unequip a weapon (per `weapon_slot`, default Weapon 1) or armor.
    Unequip { weapon: bool, #[serde(default)] weapon_slot: Option<u8> },
    /// Switch the weapon in hand between Weapon 1 (0) and Weapon 2 (1).
    SelectWeapon { weapon_slot: u8 },
    Drop { slot: u16 },
    /// Permanently destroy a backpack stack (burned on the ledger).
    Destroy { slot: u16 },
    /// Move items between inventory and stash (only near stash access).
    Deposit { slot: u16 },
    Withdraw { stash_slot: u16 },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "t", content = "d")]
pub enum VendorAction {
    /// Buy `count` items from the vendor's stock (pays MILD).
    Buy { kind: ItemKind, count: u32 },
    /// Sell `count` carried items to the vendor (receives MILD).
    Sell { kind: ItemKind, count: u32 },
    /// Bank only: convert carried Cash into wallet MILD (minus the fee).
    Convert { count: u32 },
    /// Bank only: move `amount` of `currency` from the at-risk carried balance
    /// into the death-safe bank vault.
    Deposit { currency: Currency, amount: u32 },
    /// Bank only: move `amount` of `currency` from the bank vault back into
    /// the carried balance.
    Withdraw { currency: Currency, amount: u32 },
    Refresh,
}

/// A bankable currency (all three are at-risk when carried, safe when banked).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Currency {
    Mild,
    Shards,
    Energy,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "t", content = "d")]
pub enum MarketAction {
    List { kind: ItemKind, count: u32, price_each: u32 },
    Buy { listing_id: u64, count: u32 },
    Cancel { listing_id: u64 },
    Refresh,
}

/// Server -> Client messages.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "t", content = "d")]
pub enum S2C {
    AuthResult { ok: bool, error: Option<String> },
    WorldJoined {
        entity_id: EntityId,
        character: Character,
        inventory: Inventory,
        server_tick: u64,
        world_seed: u64,
    },
    ChunkData(ChunkData),
    ChunkUnload { coord: ChunkCoord },
    EntitySpawn(EntitySpawnData),
    /// Batched per-tick snapshots for entities in interest range.
    Snapshot {
        server_tick: u64,
        /// Last processed input sequence for the receiving player (reconciliation).
        last_input_seq: u32,
        entities: Vec<EntitySnapshot>,
    },
    EntityDespawn { id: EntityId },
    InventoryUpdate(Inventory),
    StashUpdate { slots: Vec<Option<ItemStack>> },
    CombatEvent(CombatEvent),
    /// XP/level progression changed (kills grant XP; sent on join too).
    XpUpdate { xp: u32, level: u32, next_level_xp: u32, gained: u32 },
    /// The receiving player's currency balances (sent on join and whenever
    /// any of them change). For each currency the first field is the at-risk
    /// carried amount and the `bank_*` field is the death-safe banked amount.
    WalletUpdate {
        wild: u32,
        bank: u32,
        shards: u32,
        #[serde(default)]
        bank_shards: u32,
        energy: u32,
        #[serde(default)]
        bank_energy: u32,
    },
    /// Authoritative ability state for the receiving player (on use + join).
    AbilityUpdate { ability: AbilityKind, cooldown: f32, active: f32 },
    Died { by: Option<String>, lost_items: bool },
    /// Everything a pickup/gather actually added to the backpack. `denied` is
    /// set when nothing fit (drives the "Backpack full" toast + deny sound).
    GatherResult {
        gained: Vec<ItemStack>,
        #[serde(default)]
        denied: bool,
    },
    CraftResult { ok: bool, error: Option<String>, produced: Option<ItemStack> },
    /// A building's shared production queue (all owners' jobs) plus the
    /// receiving player's own uncollected output buffer there.
    ProductionState {
        building: EntityId,
        jobs: Vec<ProductionJob>,
        #[serde(default)]
        buffered: Vec<ItemStack>,
        /// Building's energy throughput cap (max summed job energy running).
        #[serde(default)]
        energy_cap: u32,
        /// Summed `Recipe::energy` of the currently powered jobs.
        #[serde(default)]
        energy_used: u32,
    },
    MarketState { listings: Vec<MarketListing>, wallet: u32 },
    MarketResult { ok: bool, error: Option<String> },
    /// A vendor's stock/prices plus the receiving player's wallet (sent on
    /// interact, refresh and after every vendor transaction).
    VendorState {
        vendor: EntityId,
        kind: EntityKind,
        offers: Vec<VendorOffer>,
        wallet: u32,
        /// Death-safe banked balances (for the Bank deposit/withdraw UI).
        #[serde(default)]
        bank: u32,
        #[serde(default)]
        shards: u32,
        #[serde(default)]
        bank_shards: u32,
        #[serde(default)]
        energy: u32,
        #[serde(default)]
        bank_energy: u32,
    },
    VendorResult { ok: bool, error: Option<String> },
    /// Persistent points of interest (service buildings) and named resource
    /// zones. Sent once on join so the map can label the world beyond the
    /// player's streaming radius.
    PoiList {
        pois: Vec<PoiInfo>,
        zones: Vec<ZoneInfo>,
        /// Registered factions (name, color, hostility) for client tinting.
        #[serde(default)]
        factions: Vec<FactionInfo>,
        /// Named neighborhoods with danger level + home faction.
        #[serde(default)]
        districts: Vec<DistrictInfo>,
    },
    /// Territory control overlay: every region not under neutral control,
    /// plus the current owner of each named neighborhood (aligned with
    /// `PoiList.districts` order; `FACTION_NEUTRAL` = unclaimed). The client
    /// diffs these to fire zone gain/loss notifications and transitions.
    TerritoryState {
        cells: Vec<TerritoryCell>,
        #[serde(default)]
        districts: Vec<FactionId>,
    },
    BlueprintsUpdate { known: Vec<String> },
    /// Full economy snapshot on dashboard subscribe: aggregate stats plus the
    /// recent transaction feed (oldest first).
    EconomyState { stats: EconomyStats, recent: Vec<EconTx> },
    /// Per-tick batch of new ledger transactions for subscribers.
    EconomyTxs { txs: Vec<EconTx>, stats: EconomyStats },
    /// One item's market detail: sent on `ItemMarketSub` and re-pushed
    /// (throttled) while new fills land for the watched kind.
    ItemMarketState(ItemMarketState),
    /// Whole-map actor blips, streamed ~1 Hz to `MapIntelSub` subscribers.
    /// Only players and wild Wapes; faction agents ship once as `MapCensus`.
    MapIntel { blips: Vec<AgentBlip> },
    /// One-time full census of every living faction agent, sent when the map
    /// opens. Static (no interpolation), so the wire form drops `id`/`count`.
    MapCensus { blips: Vec<AgentBlip> },
    /// Always-on ~5 Hz feed of faction agents in the ring just beyond a
    /// player's replicated entity view, out to the dot-render radius. Drives
    /// the live-map "glowing dot" LOD tier (the third fidelity level below
    /// full rigs and capsule impostors). Static wire form (no id/count); the
    /// client re-places these each update rather than interpolating.
    AgentDots { blips: Vec<AgentBlip> },
    /// Leaderboards + faction/guild standings, refreshed for economy
    /// dashboard subscribers.
    LeaderboardState(LeaderboardData),
    /// The receiving character's OWNED agents (subscribe via `AgentSub`;
    /// re-sent every ~2 s and on hire/dismiss while subscribed).
    AgentRoster { agents: Vec<AgentSummary> },
    /// Full detail of one owned agent (subscribe via `AgentDetailSub`,
    /// re-pushed ~1 Hz while watched).
    AgentDetail(AgentDetail),
    /// Hire candidates (unowned, living, same-faction), cheapest first,
    /// with `hire_cost` filled on every summary.
    AgentHireOffers { offers: Vec<AgentSummary> },
    /// Outcome of a hire/dismiss/agent-subscription request.
    AgentResult { ok: bool, error: Option<String> },
    Chat { from: String, text: String },
    Ping { nonce: u32 },
    Error { message: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "t", content = "d")]
pub enum CombatEvent {
    /// A hit landed; (x, y, z) is the impact point for client VFX.
    Hit { attacker: EntityId, target: EntityId, damage: f32, x: f32, y: f32, z: f32 },
    /// Attack whiffed; (x, z) is where the shot/swing terminated.
    Miss { attacker: EntityId, x: f32, z: f32 },
    /// Ranged shot fired; (tx, tz) is the actual ray end point (impact,
    /// blocking wall, or max range) so tracers terminate where bullets stop.
    MuzzleFlash { attacker: EntityId, tx: f32, tz: f32 },
    EntityDied { id: EntityId },
    /// Shockwave ability pulse originating at an entity (VFX broadcast).
    Shockwave { source: EntityId },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProductionJob {
    pub id: u64,
    pub recipe: String,
    pub count: u32,
    pub done: u32,
    /// Seconds remaining for the current unit.
    pub remaining: f32,
    pub powered: bool,
    /// True when the receiving player owns this job (cancelable, highlighted).
    #[serde(default)]
    pub mine: bool,
    /// Short owner label for other actors' jobs ("AGENT"/"PLAYER"; empty on own).
    #[serde(default)]
    pub owner: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MarketListing {
    pub id: u64,
    pub seller: String,
    pub kind: ItemKind,
    pub count: u32,
    pub price_each: u32,
}

/// Market detail for one item kind: the fill-price time series plus live
/// order-book, supply and vendor-reference stats (economy dashboard drill-in).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ItemMarketState {
    pub kind: ItemKind,
    /// Fill-price buckets, oldest first (sparse: only minutes with trades).
    pub series: Vec<PriceBucket>,
    /// Most recent fill price (0 = never traded).
    pub last_price: u32,
    /// Cheapest live ask on the book (0 = nothing listed).
    pub best_ask: u32,
    /// Units currently listed on the book.
    pub listed_units: u32,
    /// Lifetime market fills / units / MILD volume for this kind.
    pub total_fills: u64,
    pub total_units: u64,
    pub total_wild: u64,
    /// Ledger supply counters (minted / burned).
    pub supply: ItemSupply,
    /// NPC vendor reference prices (0 = vendors don't trade it that way).
    pub vendor_buy: u32,
    pub vendor_sell: u32,
    /// Individual recent fills, newest first (the trade tape).
    #[serde(default)]
    pub recent_fills: Vec<MarketFill>,
}

/// A vendor's price line for one item kind. `buy` is what the player pays per
/// unit, `sell` is what the vendor pays the player; 0 means "not traded that
/// way".
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct VendorOffer {
    pub kind: ItemKind,
    pub buy: u32,
    pub sell: u32,
    /// Units the vendor actually holds (stock-backed shelves): 0 on a
    /// buyable line means sold out. Defaults so old clients keep decoding.
    #[serde(default)]
    pub stock: u32,
}

/// A persistent point of interest (service building) for map/legend UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PoiInfo {
    pub id: EntityId,
    pub kind: EntityKind,
    pub name: String,
    pub x: f32,
    pub z: f32,
}

/// A named resource-bias zone with its label anchor (world meters).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZoneInfo {
    pub kind: ZoneKind,
    pub name: String,
    pub x: f32,
    pub z: f32,
}

/// One actor on the whole-map intel overlay. Coordinates are quantized to
/// whole meters (i16) to keep 1 Hz whole-map updates small.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct AgentBlip {
    pub id: u64,
    pub faction: FactionId,
    /// 0 = player, 1 = agent, 2 = wild Wape.
    pub kind: u8,
    pub x: i16,
    pub z: i16,
    /// Actors this blip stands for: 1 = an individual, >1 = a density
    /// cluster (agent populations above the blip cap are aggregated per map
    /// cell per faction instead of shipping one blip each). Omitted from the
    /// wire when 1.
    #[serde(default = "one_u16", skip_serializing_if = "is_one_u16")]
    pub count: u16,
}

fn one_u16() -> u16 {
    1
}

fn is_one_u16(v: &u16) -> bool {
    *v == 1
}

/// One agent's roster line: identity, learned specialization, current
/// activity, vitals, position and wealth. `hire_cost` is only filled on
/// `AgentHireOffers` candidates (None on owned-roster entries).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentSummary {
    pub agent_id: AgentId,
    /// Live replicated entity id of this agent's body (fresh per respawn).
    /// Lets the Watch tab's follow camera look the entity up directly.
    #[serde(default)]
    pub entity_id: EntityId,
    pub name: String,
    pub faction: FactionId,
    pub guild: String,
    /// Label of the dominant learned activity ("Trader", "Scavenger", ...).
    pub archetype: String,
    /// Short human label of the current goal ("Gathering", "Banking", ...).
    pub activity: String,
    pub health: f32,
    pub max_health: f32,
    pub x: f32,
    pub z: f32,
    /// At-risk carried MILD.
    pub carried_wild: u32,
    /// Death-safe banked MILD.
    pub banked_wild: u32,
    /// Total MILD this agent has paid its owner (15% bank-deposit share).
    #[serde(default)]
    pub lifetime_owner_earnings: u64,
    /// MILD to hire this agent (only set on `AgentHireOffers` candidates).
    #[serde(default)]
    pub hire_cost: Option<u32>,
}

/// Per-identity competition counters surfaced in `AgentDetail`.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct AgentStats {
    pub kills: u64,
    pub deaths: u64,
    pub resources: u64,
    pub trades: u64,
    pub crafted: u64,
}

/// One line of an owned agent's live activity log.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentLogEntry {
    /// Unix milliseconds when the event happened.
    pub at_ms: u64,
    pub text: String,
}

/// Full drill-in view of one owned agent (`AgentDetailSub`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentDetail {
    pub summary: AgentSummary,
    /// Fuller description of the current goal, including its target
    /// (e.g. "Gathering resources (3 pulls left)", "Selling at Bodega").
    pub goal: String,
    /// Learned payoff EMA per activity, as (activity name, MILD/min) pairs
    /// in canonical activity order.
    pub traits: Vec<(String, f32)>,
    pub stats: AgentStats,
    /// Backpack + equip slots (same wire type `WorldJoined` uses).
    pub inventory: Inventory,
    /// Known blueprint recipe ids, sorted.
    pub blueprints: Vec<String>,
    /// Carried balances indexed [MILD, Shards, Energy].
    pub carried: [u32; 3],
    /// Banked balances indexed [MILD, Shards, Energy].
    pub banked: [u32; 3],
    /// Recent activity log, oldest first (ring of the last ~64 events).
    pub activity_log: Vec<AgentLogEntry>,
    /// Recent ledger transactions touching this agent, newest first.
    pub recent_txs: Vec<EconTx>,
}

/// Leaderboards payload: per-category top-N boards plus rolled-up faction and
/// guild standings.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LeaderboardData {
    pub boards: Vec<Board>,
    pub factions: Vec<FactionStanding>,
    pub guilds: Vec<GuildStanding>,
    /// Per-neighborhood territory standings (rolling zone-seconds by faction).
    #[serde(default)]
    pub zones: Vec<ZoneStanding>,
}

/// Rolling territory standing for one named neighborhood: who currently holds
/// it (most cells) plus seconds-held per faction over the recent window.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZoneStanding {
    pub district: String,
    /// Faction holding the most cells in the neighborhood right now.
    pub control: FactionId,
    /// Rolling seconds each faction has held cells here (window is momentum,
    /// not lifetime).
    pub seconds: Vec<ZoneSeconds>,
}

/// One faction's rolling seconds-held in a neighborhood.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZoneSeconds {
    pub faction: FactionId,
    pub seconds: u64,
}

/// One leaderboard category (e.g. "Wealth", "Kills") with its ranked rows.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Board {
    pub category: String,
    pub rows: Vec<BoardRow>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BoardRow {
    pub name: String,
    pub faction: FactionId,
    /// Guild name; None for guildless competitors (all players for now).
    pub guild: Option<String>,
    pub value: i64,
}

/// Rolled-up standing for one faction.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FactionStanding {
    pub faction: FactionId,
    pub members: u32,
    pub kills: u64,
    pub deaths: u64,
    pub treasury: i64,
    pub regions_held: u32,
    pub districts_held: u32,
    /// Rolling "zone points": total cell-seconds held across the map over the
    /// recent window (momentum readout for the dashboard).
    #[serde(default)]
    pub zone_points: u64,
}

/// Rolled-up standing for one guild (agent squad).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GuildStanding {
    pub name: String,
    pub faction: FactionId,
    pub members: u32,
    pub kills: u64,
    pub wealth: i64,
}

/// One controlled region on the territory grid. `control` is the holding
/// `FactionId` (neutral regions are never sent). Ids 1 (Rebels) and 2 (The
/// Forum) match the legacy player/enemy encoding, so old clients still read
/// the overlay correctly.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct TerritoryCell {
    pub rx: i32,
    pub rz: i32,
    pub control: FactionId,
}

pub fn encode<T: Serialize>(msg: &T) -> String {
    serde_json::to_string(msg).expect("protocol encode")
}

pub fn decode<'a, T: Deserialize<'a>>(text: &'a str) -> Result<T, serde_json::Error> {
    serde_json::from_str(text)
}

// ---------------------------------------------------------------------------
// Binary frames for the hot per-tick messages
// ---------------------------------------------------------------------------
//
// Snapshot (20 Hz per player) and MapIntel (~1 Hz whole map) dominate wire
// bandwidth, so they ship as compact little-endian binary WebSocket frames
// instead of JSON. Everything else stays JSON text (debuggable, rare).
// The TypeScript decoder in `apps/web/src/net/connection.ts` mirrors these
// layouts exactly and must stay in sync.

/// Frame tags (first byte of a binary frame).
const BIN_SNAPSHOT: u8 = 1;
const BIN_MAP_INTEL: u8 = 2;
const BIN_MAP_CENSUS: u8 = 3;
const BIN_AGENT_DOTS: u8 = 4;

/// Bytes per entity in a binary Snapshot: u64 id, i32 cm x/y/z, i16 centirad
/// yaw, u8 anim, u8 health, u8 shield.
const SNAP_ENTITY_BYTES: usize = 8 + 12 + 2 + 3;
/// Bytes per blip in a binary MapIntel: u64 id, u8 faction, u8 kind,
/// i16 x/z (meters), u16 count.
const INTEL_BLIP_BYTES: usize = 8 + 1 + 1 + 4 + 2;
/// Bytes per blip in a binary MapCensus: u8 faction, u8 kind, i16 x/z
/// (meters). Static dots need no id or cluster count, so this stays tiny
/// (~150 KB for 25k agents in a single one-time frame).
const CENSUS_BLIP_BYTES: usize = 1 + 1 + 4;

/// Stable wire code for an animation state (append-only; the client maps
/// codes back by index).
fn anim_code(a: AnimState) -> u8 {
    match a {
        AnimState::Idle => 0,
        AnimState::Walk => 1,
        AnimState::Run => 2,
        AnimState::Attack => 3,
        AnimState::Hit => 4,
        AnimState::Death => 5,
        AnimState::Gather => 6,
        AnimState::Roll => 7,
        AnimState::Crouch => 8,
        AnimState::CrouchWalk => 9,
    }
}

fn anim_from_code(c: u8) -> AnimState {
    match c {
        1 => AnimState::Walk,
        2 => AnimState::Run,
        3 => AnimState::Attack,
        4 => AnimState::Hit,
        5 => AnimState::Death,
        6 => AnimState::Gather,
        7 => AnimState::Roll,
        8 => AnimState::Crouch,
        9 => AnimState::CrouchWalk,
        _ => AnimState::Idle,
    }
}

/// Binary-encode a hot message; `None` means "not a hot message, send JSON".
/// Positions quantize to centimeters (i32) and yaw to centiradians (i16),
/// matching the server's delta-replication quantization, so the binary path
/// loses no precision over what JSON carried.
pub fn encode_binary(msg: &S2C) -> Option<Vec<u8>> {
    let q32 = |v: f32| (v * 100.0).round() as i32;
    match msg {
        S2C::Snapshot { server_tick, last_input_seq, entities } => {
            let mut buf = Vec::with_capacity(1 + 8 + 4 + 4 + entities.len() * SNAP_ENTITY_BYTES);
            buf.push(BIN_SNAPSHOT);
            buf.extend_from_slice(&server_tick.to_le_bytes());
            buf.extend_from_slice(&last_input_seq.to_le_bytes());
            buf.extend_from_slice(&(entities.len() as u32).to_le_bytes());
            for e in entities {
                buf.extend_from_slice(&e.id.to_le_bytes());
                buf.extend_from_slice(&q32(e.position.x).to_le_bytes());
                buf.extend_from_slice(&q32(e.position.y).to_le_bytes());
                buf.extend_from_slice(&q32(e.position.z).to_le_bytes());
                buf.extend_from_slice(&((e.yaw * 100.0).round() as i16).to_le_bytes());
                buf.push(anim_code(e.anim));
                buf.push((e.health_pct.clamp(0.0, 1.0) * 255.0).round() as u8);
                buf.push((e.shield_pct.clamp(0.0, 1.0) * 255.0).round() as u8);
            }
            Some(buf)
        }
        S2C::MapIntel { blips } => {
            let mut buf = Vec::with_capacity(1 + 4 + blips.len() * INTEL_BLIP_BYTES);
            buf.push(BIN_MAP_INTEL);
            buf.extend_from_slice(&(blips.len() as u32).to_le_bytes());
            for b in blips {
                buf.extend_from_slice(&b.id.to_le_bytes());
                buf.push(b.faction);
                buf.push(b.kind);
                buf.extend_from_slice(&b.x.to_le_bytes());
                buf.extend_from_slice(&b.z.to_le_bytes());
                buf.extend_from_slice(&b.count.to_le_bytes());
            }
            Some(buf)
        }
        S2C::MapCensus { blips } => {
            let mut buf = Vec::with_capacity(1 + 4 + blips.len() * CENSUS_BLIP_BYTES);
            buf.push(BIN_MAP_CENSUS);
            buf.extend_from_slice(&(blips.len() as u32).to_le_bytes());
            for b in blips {
                buf.push(b.faction);
                buf.push(b.kind);
                buf.extend_from_slice(&b.x.to_le_bytes());
                buf.extend_from_slice(&b.z.to_le_bytes());
            }
            Some(buf)
        }
        // Same compact static layout as MapCensus (no id/count on the wire).
        S2C::AgentDots { blips } => {
            let mut buf = Vec::with_capacity(1 + 4 + blips.len() * CENSUS_BLIP_BYTES);
            buf.push(BIN_AGENT_DOTS);
            buf.extend_from_slice(&(blips.len() as u32).to_le_bytes());
            for b in blips {
                buf.push(b.faction);
                buf.push(b.kind);
                buf.extend_from_slice(&b.x.to_le_bytes());
                buf.extend_from_slice(&b.z.to_le_bytes());
            }
            Some(buf)
        }
        _ => None,
    }
}

/// Decode a binary frame produced by [`encode_binary`]. Used by tests and
/// native tooling; the browser client has its own TypeScript decoder.
pub fn decode_binary(buf: &[u8]) -> Option<S2C> {
    let (&tag, rest) = buf.split_first()?;
    let rd_u16 = |b: &[u8], o: usize| u16::from_le_bytes(b[o..o + 2].try_into().unwrap());
    let rd_i16 = |b: &[u8], o: usize| i16::from_le_bytes(b[o..o + 2].try_into().unwrap());
    let rd_u32 = |b: &[u8], o: usize| u32::from_le_bytes(b[o..o + 4].try_into().unwrap());
    let rd_i32 = |b: &[u8], o: usize| i32::from_le_bytes(b[o..o + 4].try_into().unwrap());
    let rd_u64 = |b: &[u8], o: usize| u64::from_le_bytes(b[o..o + 8].try_into().unwrap());
    match tag {
        BIN_SNAPSHOT => {
            if rest.len() < 16 {
                return None;
            }
            let server_tick = rd_u64(rest, 0);
            let last_input_seq = rd_u32(rest, 8);
            let count = rd_u32(rest, 12) as usize;
            let body = &rest[16..];
            if body.len() != count * SNAP_ENTITY_BYTES {
                return None;
            }
            let mut entities = Vec::with_capacity(count);
            for i in 0..count {
                let o = i * SNAP_ENTITY_BYTES;
                entities.push(EntitySnapshot {
                    id: rd_u64(body, o),
                    position: Vec3::new(
                        rd_i32(body, o + 8) as f32 / 100.0,
                        rd_i32(body, o + 12) as f32 / 100.0,
                        rd_i32(body, o + 16) as f32 / 100.0,
                    ),
                    yaw: rd_i16(body, o + 20) as f32 / 100.0,
                    anim: anim_from_code(body[o + 22]),
                    health_pct: body[o + 23] as f32 / 255.0,
                    shield_pct: body[o + 24] as f32 / 255.0,
                });
            }
            Some(S2C::Snapshot { server_tick, last_input_seq, entities })
        }
        BIN_MAP_INTEL => {
            if rest.len() < 4 {
                return None;
            }
            let count = rd_u32(rest, 0) as usize;
            let body = &rest[4..];
            if body.len() != count * INTEL_BLIP_BYTES {
                return None;
            }
            let mut blips = Vec::with_capacity(count);
            for i in 0..count {
                let o = i * INTEL_BLIP_BYTES;
                blips.push(AgentBlip {
                    id: rd_u64(body, o),
                    faction: body[o + 8],
                    kind: body[o + 9],
                    x: rd_i16(body, o + 10),
                    z: rd_i16(body, o + 12),
                    count: rd_u16(body, o + 14),
                });
            }
            Some(S2C::MapIntel { blips })
        }
        BIN_MAP_CENSUS => {
            if rest.len() < 4 {
                return None;
            }
            let count = rd_u32(rest, 0) as usize;
            let body = &rest[4..];
            if body.len() != count * CENSUS_BLIP_BYTES {
                return None;
            }
            let mut blips = Vec::with_capacity(count);
            for i in 0..count {
                let o = i * CENSUS_BLIP_BYTES;
                blips.push(AgentBlip {
                    id: 0,
                    faction: body[o],
                    kind: body[o + 1],
                    x: rd_i16(body, o + 2),
                    z: rd_i16(body, o + 4),
                    count: 1,
                });
            }
            Some(S2C::MapCensus { blips })
        }
        BIN_AGENT_DOTS => {
            if rest.len() < 4 {
                return None;
            }
            let count = rd_u32(rest, 0) as usize;
            let body = &rest[4..];
            if body.len() != count * CENSUS_BLIP_BYTES {
                return None;
            }
            let mut blips = Vec::with_capacity(count);
            for i in 0..count {
                let o = i * CENSUS_BLIP_BYTES;
                blips.push(AgentBlip {
                    id: 0,
                    faction: body[o],
                    kind: body[o + 1],
                    x: rd_i16(body, o + 2),
                    z: rd_i16(body, o + 4),
                    count: 1,
                });
            }
            Some(S2C::AgentDots { blips })
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_c2s() {
        let msg = C2S::MoveInput { seq: 7, dx: 1.0, dz: 0.0, yaw: 0.5, run: true };
        let text = encode(&msg);
        let back: C2S = decode(&text).unwrap();
        match back {
            C2S::MoveInput { seq, run, .. } => {
                assert_eq!(seq, 7);
                assert!(run);
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn roundtrip_s2c_snapshot() {
        let msg = S2C::Snapshot {
            server_tick: 42,
            last_input_seq: 7,
            entities: vec![EntitySnapshot {
                id: 1,
                position: Vec3::new(1.0, 0.0, 2.0),
                yaw: 0.5,
                anim: AnimState::Run,
                health_pct: 1.0,
                shield_pct: 0.0,
            }],
        };
        let text = encode(&msg);
        let back: S2C = decode(&text).unwrap();
        matches!(back, S2C::Snapshot { .. });
    }

    #[test]
    fn roundtrip_map_intel_sub() {
        let text = encode(&C2S::MapIntelSub { on: true });
        match decode::<C2S>(&text).unwrap() {
            C2S::MapIntelSub { on } => assert!(on),
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn binary_roundtrip_snapshot_and_map_intel() {
        let snap = S2C::Snapshot {
            server_tick: 123_456_789_012,
            last_input_seq: 4242,
            entities: vec![EntitySnapshot {
                id: 77,
                position: Vec3::new(12.34, 0.0, -567.89),
                yaw: -3.14,
                anim: AnimState::Run,
                health_pct: 0.5,
                shield_pct: 1.0,
            }],
        };
        let buf = encode_binary(&snap).expect("snapshot is a hot message");
        match decode_binary(&buf).unwrap() {
            S2C::Snapshot { server_tick, last_input_seq, entities } => {
                assert_eq!(server_tick, 123_456_789_012);
                assert_eq!(last_input_seq, 4242);
                assert_eq!(entities.len(), 1);
                let e = &entities[0];
                assert_eq!(e.id, 77);
                assert!((e.position.x - 12.34).abs() < 0.01);
                assert!((e.position.z + 567.89).abs() < 0.01);
                assert!((e.yaw + 3.14).abs() < 0.01);
                assert_eq!(e.anim, AnimState::Run);
                assert!((e.health_pct - 0.5).abs() < 0.005);
                assert!((e.shield_pct - 1.0).abs() < 0.005);
            }
            _ => panic!("wrong variant"),
        }

        let intel = S2C::MapIntel {
            blips: vec![AgentBlip {
                id: (1 << 63) | 5,
                faction: FACTION_FORUM,
                kind: 1,
                x: -120,
                z: 512,
                count: 340,
            }],
        };
        let buf = encode_binary(&intel).expect("map intel is a hot message");
        match decode_binary(&buf).unwrap() {
            S2C::MapIntel { blips } => {
                assert_eq!(blips.len(), 1);
                assert_eq!(blips[0].id, (1 << 63) | 5);
                assert_eq!(blips[0].count, 340);
                assert_eq!(blips[0].x, -120);
            }
            _ => panic!("wrong variant"),
        }

        // Cold messages stay JSON.
        assert!(encode_binary(&S2C::Ping { nonce: 1 }).is_none());
    }

    #[test]
    fn binary_map_census_roundtrip() {
        let census = S2C::MapCensus {
            blips: vec![
                AgentBlip { id: 0, faction: FACTION_REBELS, kind: 1, x: 900, z: -4200, count: 1 },
                AgentBlip { id: 0, faction: FACTION_FORUM, kind: 1, x: -32000, z: 14000, count: 1 },
            ],
        };
        let buf = encode_binary(&census).expect("map census is a hot message");
        // 6 bytes per blip, no per-blip id/count on the wire.
        assert_eq!(buf.len(), 1 + 4 + 2 * CENSUS_BLIP_BYTES);
        match decode_binary(&buf).unwrap() {
            S2C::MapCensus { blips } => {
                assert_eq!(blips.len(), 2);
                assert_eq!(blips[0].faction, FACTION_REBELS);
                assert_eq!(blips[0].x, 900);
                assert_eq!(blips[0].z, -4200);
                assert_eq!(blips[1].faction, FACTION_FORUM);
                assert_eq!(blips[1].x, -32000);
                assert_eq!(blips[1].z, 14000);
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn binary_agent_dots_roundtrip() {
        let dots = S2C::AgentDots {
            blips: vec![
                AgentBlip { id: 0, faction: FACTION_REBELS, kind: 1, x: 300, z: -280, count: 1 },
                AgentBlip { id: 0, faction: FACTION_WAPES, kind: 1, x: -1200, z: 640, count: 1 },
            ],
        };
        let buf = encode_binary(&dots).expect("agent dots is a hot message");
        // Compact 6 bytes per blip, matching MapCensus.
        assert_eq!(buf.len(), 1 + 4 + 2 * CENSUS_BLIP_BYTES);
        match decode_binary(&buf).unwrap() {
            S2C::AgentDots { blips } => {
                assert_eq!(blips.len(), 2);
                assert_eq!(blips[0].faction, FACTION_REBELS);
                assert_eq!(blips[0].x, 300);
                assert_eq!(blips[0].z, -280);
                assert_eq!(blips[1].faction, FACTION_WAPES);
                assert_eq!(blips[1].x, -1200);
                assert_eq!(blips[1].z, 640);
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn roundtrip_map_intel() {
        let msg = S2C::MapIntel {
            blips: vec![AgentBlip { id: 9, faction: FACTION_FORUM, kind: 1, x: -120, z: 512, count: 1 }],
        };
        let text = encode(&msg);
        match decode::<S2C>(&text).unwrap() {
            S2C::MapIntel { blips } => {
                assert_eq!(blips.len(), 1);
                assert_eq!(blips[0].faction, FACTION_FORUM);
                assert_eq!(blips[0].x, -120);
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn roundtrip_leaderboard_state() {
        let msg = S2C::LeaderboardState(LeaderboardData {
            boards: vec![Board {
                category: "Wealth".into(),
                rows: vec![BoardRow {
                    name: "Vex".into(),
                    faction: FACTION_REBELS,
                    guild: Some("Dead Signal".into()),
                    value: 4200,
                }],
            }],
            factions: vec![FactionStanding {
                faction: FACTION_REBELS,
                members: 250,
                kills: 12,
                deaths: 3,
                treasury: 9000,
                regions_held: 4,
                districts_held: 1,
                zone_points: 1234,
            }],
            guilds: vec![GuildStanding {
                name: "Dead Signal".into(),
                faction: FACTION_REBELS,
                members: 30,
                kills: 5,
                wealth: 777,
            }],
            zones: vec![ZoneStanding {
                district: "NEXUS".into(),
                control: FACTION_REBELS,
                seconds: vec![ZoneSeconds { faction: FACTION_REBELS, seconds: 900 }],
            }],
        });
        let text = encode(&msg);
        match decode::<S2C>(&text).unwrap() {
            S2C::LeaderboardState(data) => {
                assert_eq!(data.boards[0].rows[0].guild.as_deref(), Some("Dead Signal"));
                assert_eq!(data.factions[0].regions_held, 4);
                assert_eq!(data.factions[0].zone_points, 1234);
                assert_eq!(data.zones[0].seconds[0].seconds, 900);
                assert_eq!(data.guilds[0].wealth, 777);
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn roundtrip_poi_list_with_factions_and_districts() {
        let msg = S2C::PoiList {
            pois: vec![],
            zones: vec![],
            factions: vec![FactionInfo {
                id: FACTION_REBELS,
                name: "Rebels".into(),
                tagline: "Free the grid.".into(),
                color: 0x2de0a6,
                hostile_to: vec![FACTION_FORUM],
            }],
            districts: vec![DistrictInfo {
                name: "Tranquility Gardens".into(),
                x: 100.0,
                z: -50.0,
                danger: DangerLevel::Sanctuary,
                home_faction: FACTION_REBELS,
            }],
        };
        let text = encode(&msg);
        match decode::<S2C>(&text).unwrap() {
            S2C::PoiList { factions, districts, .. } => {
                assert_eq!(factions[0].hostile_to, vec![FACTION_FORUM]);
                assert_eq!(districts[0].danger, DangerLevel::Sanctuary);
            }
            _ => panic!("wrong variant"),
        }
    }

    /// Pre-faction clients/servers omit the new fields; decoding must fill
    /// the serde defaults instead of failing.
    #[test]
    fn poi_list_decodes_without_faction_fields() {
        let legacy = r#"{"t":"PoiList","d":{"pois":[],"zones":[]}}"#;
        match decode::<S2C>(legacy).unwrap() {
            S2C::PoiList { factions, districts, .. } => {
                assert!(factions.is_empty());
                assert!(districts.is_empty());
            }
            _ => panic!("wrong variant"),
        }
    }
}
