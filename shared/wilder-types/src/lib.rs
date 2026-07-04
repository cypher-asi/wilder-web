//! Shared domain types used by every Wilder crate and mirrored to the client.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub use glam::Vec3;

pub type AccountId = Uuid;
pub type CharacterId = Uuid;
pub type EntityId = u64;
/// Persistent identity of a non-player economic actor (NPCs, vendor
/// buildings, the market). Minted fresh whenever an agent spawns.
pub type AgentId = Uuid;

// ---------------------------------------------------------------------------
// Factions
// ---------------------------------------------------------------------------

/// Faction identity. Factions are data, not enums: the registry (name, color,
/// hostility matrix) lives server-side in `wilder-world::factions` and is
/// serialized to clients, so adding a faction is a data change.
pub type FactionId = u8;
/// Unaffiliated: players/agents/services outside the faction war. Neutral is
/// hostile to no one and never appears in the registry.
pub const FACTION_NEUTRAL: FactionId = 0;
/// Player faction (all players default to Rebels for now).
pub const FACTION_REBELS: FactionId = 1;
/// The rival organized faction opposing the Rebels.
pub const FACTION_FORUM: FactionId = 2;
/// Wild, unaligned NPCs ("Wapes"): hostile to both organized factions, an
/// environmental threat rather than a competitor for the Rebels/Forum war.
pub const FACTION_WAPES: FactionId = 3;

/// One faction's registry entry, serialized to clients on join (in `PoiList`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FactionInfo {
    pub id: FactionId,
    pub name: String,
    pub tagline: String,
    /// Faction color (RGB packed), used for tints, blips and leaderboards.
    pub color: u32,
    /// Factions this one attacks on sight. Hostility is symmetric: either
    /// side listing the other makes the pair hostile.
    pub hostile_to: Vec<FactionId>,
}

/// Per-district combat/capture intensity.
///
/// - `Sanctuary`: no combat of any kind and no territory capture; everyone
///   rests, trades and crafts side by side.
/// - `Guarded`: faction home turf. Capture is disabled and aggression by
///   outsiders is blocked (combat only in self-defense).
/// - `Contested`: full faction war — combat and capture unrestricted.
/// - `Warzone`: frontier districts. Full war plus boosted loot/resource
///   yields to pay for the risk.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum DangerLevel {
    Sanctuary,
    Guarded,
    Contested,
    Warzone,
}

/// A named neighborhood with its label anchor (world meters), danger level
/// and home faction (`FACTION_NEUTRAL` for unclaimed districts).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DistrictInfo {
    pub name: String,
    pub x: f32,
    pub z: f32,
    pub danger: DangerLevel,
    pub home_faction: FactionId,
}

/// World-space chunk coordinate. Chunks are CHUNK_SIZE x CHUNK_SIZE meters on the XZ plane.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ChunkCoord {
    pub x: i32,
    pub z: i32,
}

impl ChunkCoord {
    pub fn new(x: i32, z: i32) -> Self {
        Self { x, z }
    }

    pub fn from_world(pos: Vec3) -> Self {
        Self {
            x: (pos.x / CHUNK_SIZE).floor() as i32,
            z: (pos.z / CHUNK_SIZE).floor() as i32,
        }
    }
}

/// Chunk edge length in meters.
pub const CHUNK_SIZE: f32 = 32.0;
/// Tile edge length in meters (collision / generation resolution).
pub const TILE_SIZE: f32 = 2.0;
/// Tiles per chunk edge.
pub const TILES_PER_CHUNK: usize = (CHUNK_SIZE / TILE_SIZE) as usize; // 16

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Appearance {
    /// Index into the character model/skin catalog.
    pub body: u8,
    /// Primary color tint (RGB packed).
    pub tint: u32,
}

impl Default for Appearance {
    fn default() -> Self {
        Self { body: 0, tint: 0xff_ff_ff }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CharacterSummary {
    pub id: CharacterId,
    pub name: String,
    pub appearance: Appearance,
    pub level: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Character {
    pub id: CharacterId,
    pub account_id: AccountId,
    pub name: String,
    pub appearance: Appearance,
    pub position: Vec3,
    pub yaw: f32,
    pub level: u32,
    /// Progress into the current level (resets each level-up).
    #[serde(default)]
    pub xp: u32,
    pub health: f32,
    pub max_health: f32,
    /// Energy shield granted by equipped armor. Absorbs damage before health.
    #[serde(default)]
    pub shield: f32,
    #[serde(default)]
    pub max_shield: f32,
    /// Faction allegiance (players default to Rebels).
    #[serde(default)]
    pub faction: FactionId,
}

impl Character {
    pub fn summary(&self) -> CharacterSummary {
        CharacterSummary {
            id: self.id,
            name: self.name.clone(),
            appearance: self.appearance.clone(),
            level: self.level,
        }
    }
}

// ---------------------------------------------------------------------------
// Items / inventory
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ItemKind {
    // Phase 0 starter items
    Medkit,
    Flashlight,
    // Phase 1 weapons/armor
    Pipe,
    Knife,
    Pistol,
    Smg,
    JacketArmor,
    PlateArmor,
    Ammo9mm,
    // Phase 2 resources
    Iron,
    Copper,
    Chemicals,
    Electronics,
    Biomass,
    // Phase 2 refined materials
    SteelPlate,
    CopperWire,
    Polymer,
    CircuitBoard,
    BioGel,
    // Phase 3
    BlueprintFragment,
    PowerCell,
    /// Looted street currency. Worthless until converted to WILD at a Bank.
    Cash,
}

impl ItemKind {
    pub fn display_name(&self) -> &'static str {
        match self {
            ItemKind::Medkit => "Medkit",
            ItemKind::Flashlight => "Flashlight",
            ItemKind::Pipe => "Steel Pipe",
            ItemKind::Knife => "Combat Knife",
            ItemKind::Pistol => "P9 Pistol",
            ItemKind::Smg => "K-11 SMG",
            ItemKind::JacketArmor => "Padded Jacket",
            ItemKind::PlateArmor => "Plate Carrier",
            ItemKind::Ammo9mm => "9mm Ammo",
            ItemKind::Iron => "Iron",
            ItemKind::Copper => "Copper",
            ItemKind::Chemicals => "Chemicals",
            ItemKind::Electronics => "Electronics",
            ItemKind::Biomass => "Biomass",
            ItemKind::SteelPlate => "Steel Plate",
            ItemKind::CopperWire => "Copper Wire",
            ItemKind::Polymer => "Polymer",
            ItemKind::CircuitBoard => "Circuit Board",
            ItemKind::BioGel => "Bio-Gel",
            ItemKind::BlueprintFragment => "Blueprint Fragment",
            ItemKind::PowerCell => "Power Cell",
            ItemKind::Cash => "Cash",
        }
    }

    pub fn max_stack(&self) -> u32 {
        match self {
            ItemKind::Iron
            | ItemKind::Copper
            | ItemKind::Chemicals
            | ItemKind::Electronics
            | ItemKind::Biomass
            | ItemKind::SteelPlate
            | ItemKind::CopperWire
            | ItemKind::Polymer
            | ItemKind::CircuitBoard
            | ItemKind::BioGel
            | ItemKind::Ammo9mm
            | ItemKind::BlueprintFragment => 100,
            ItemKind::Cash => 999,
            ItemKind::Medkit => 5,
            _ => 1,
        }
    }

    /// How much backpack/stash volume one stack entry of this kind occupies.
    /// Capacity is the container's slot count (36 backpack / 48 stash), so a
    /// pistol at cost 4 genuinely crowds out four stacks of resources. The
    /// grid UI renders costly items spanning multiple cells.
    pub fn slot_cost(&self) -> u32 {
        match self {
            ItemKind::Pistol | ItemKind::Smg => 4,
            ItemKind::PlateArmor => 3,
            ItemKind::JacketArmor | ItemKind::Pipe | ItemKind::Knife | ItemKind::PowerCell => 2,
            _ => 1,
        }
    }

    pub fn is_weapon(&self) -> bool {
        matches!(
            self,
            ItemKind::Pipe | ItemKind::Knife | ItemKind::Pistol | ItemKind::Smg
        )
    }

    pub fn is_armor(&self) -> bool {
        matches!(self, ItemKind::JacketArmor | ItemKind::PlateArmor)
    }
}

/// Active player abilities (hotbar Q/E/R). Resolved server-side with cooldowns.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum AbilityKind {
    /// AoE pulse: damage + knockback to nearby NPCs.
    Shockwave,
    /// Heal over time + brief move speed boost.
    Stim,
    /// Brief weapon damage multiplier.
    Overcharge,
}

impl AbilityKind {
    pub const ALL: [AbilityKind; 3] =
        [AbilityKind::Shockwave, AbilityKind::Stim, AbilityKind::Overcharge];

    pub fn index(&self) -> usize {
        match self {
            AbilityKind::Shockwave => 0,
            AbilityKind::Stim => 1,
            AbilityKind::Overcharge => 2,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct ItemStack {
    pub kind: ItemKind,
    pub count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Inventory {
    pub slots: Vec<Option<ItemStack>>,
    /// Weapon 1 equip slot.
    pub equipped_weapon: Option<ItemKind>,
    /// Weapon 2 equip slot.
    #[serde(default)]
    pub equipped_weapon2: Option<ItemKind>,
    /// Which weapon slot is in hand: 0 = Weapon 1, 1 = Weapon 2.
    #[serde(default)]
    pub active_weapon: u8,
    pub equipped_armor: Option<ItemKind>,
}

impl Inventory {
    pub const DEFAULT_SLOTS: usize = 36;

    pub fn new() -> Self {
        Self {
            slots: vec![None; Self::DEFAULT_SLOTS],
            equipped_weapon: None,
            equipped_weapon2: None,
            active_weapon: 0,
            equipped_armor: None,
        }
    }

    /// The weapon currently in hand (per `active_weapon`).
    pub fn active_weapon_kind(&self) -> Option<ItemKind> {
        if self.active_weapon == 1 {
            self.equipped_weapon2
        } else {
            self.equipped_weapon
        }
    }

    /// Grow persisted inventories from older, smaller slot layouts.
    pub fn ensure_slot_count(&mut self) {
        if self.slots.len() < Self::DEFAULT_SLOTS {
            self.slots.resize(Self::DEFAULT_SLOTS, None);
        }
    }
}

impl Default for Inventory {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Entities (replicated)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum EntityKind {
    Player,
    Npc,
    /// Autonomous faction agent (replicated only while Hot / near players).
    Agent,
    LootContainer,
    ExtractionPoint,
    ResourceNode,
    /// Loose currency dropped on death (coins/shards/energy). The `variant`
    /// field carries the currency type: 0 = WILD, 1 = Shards, 2 = Energy.
    CurrencyPickup,
    /// Storage (stash) terminal.
    Building,
    Refinery,
    Factory,
    Laboratory,
    MarketTerminal,
    /// Weapons & armor vendor (WILD buy/sell).
    Armory,
    /// Converts looted Cash into wallet WILD (minus a fee).
    Bank,
    /// General store: sells consumables, buys raw resources cheap.
    Bodega,
    /// Vehicle showroom. Placeholder until vehicles ship.
    Dealership,
    /// Safety bubble: hostiles ignore players inside; health regen applies.
    Safehouse,
}

/// Resource-bias zone: themed districts around the spawn hub drop different
/// resources (mining ground yields metals, overgrowth yields biomass, ...).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ZoneKind {
    /// Bombed-out blocks: chemicals in the rubble, extra Cash on hostiles.
    BlownUp,
    /// Open-pit mining ground: iron and copper.
    Mining,
    /// Factory belt: iron and electronics.
    Industrial,
    /// Collapsed tech quarter: electronics.
    TechRuins,
    /// Blocks reclaimed by nature: biomass.
    Overgrowth,
    /// Chemical processing works: chemicals.
    ChemPlant,
    /// Junked vehicles and machinery: mixed metals.
    Scrapyard,
    /// No particular bias.
    Mixed,
}

impl ZoneKind {
    pub fn display_name(&self) -> &'static str {
        match self {
            ZoneKind::BlownUp => "Blast Zone",
            ZoneKind::Mining => "Mining Pits",
            ZoneKind::Industrial => "Industrial Belt",
            ZoneKind::TechRuins => "Tech Ruins",
            ZoneKind::Overgrowth => "Overgrowth",
            ZoneKind::ChemPlant => "Chem Works",
            ZoneKind::Scrapyard => "Scrapyard",
            ZoneKind::Mixed => "Open City",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AnimState {
    Idle,
    Walk,
    Run,
    Attack,
    /// Flinching from a recent hit; the NPC is briefly stunned in place.
    Hit,
    Death,
    Gather,
    Roll,
    Crouch,
    CrouchWalk,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EntitySnapshot {
    pub id: EntityId,
    pub position: Vec3,
    pub yaw: f32,
    pub anim: AnimState,
    pub health_pct: f32,
    /// Shield fraction (0-1 of max shield); 0 for entities without shields.
    #[serde(default)]
    pub shield_pct: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EntitySpawnData {
    pub id: EntityId,
    pub kind: EntityKind,
    pub name: String,
    pub appearance: Appearance,
    pub position: Vec3,
    pub yaw: f32,
    pub anim: AnimState,
    pub health_pct: f32,
    /// Extra payload interpreted per kind (npc archetype, node resource, etc.)
    pub variant: u32,
    /// For loot containers: the primary contained item, so the client can
    /// float its icon over the crate. None for every other entity kind.
    #[serde(default)]
    pub item: Option<ItemKind>,
    /// Faction allegiance (drives tint/nameplate/hostility on the client).
    #[serde(default)]
    pub faction: FactionId,
}

// ---------------------------------------------------------------------------
// Terrain / chunks (wire representation)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u8)]
pub enum TileKind {
    Road = 0,
    RoadLine = 1,
    Sidewalk = 2,
    Plaza = 3,
    Building = 4,
    Park = 5,
    Water = 6,
}

impl TileKind {
    pub fn walkable(&self) -> bool {
        !matches!(self, TileKind::Building | TileKind::Water)
    }
}

/// A prop placed within a chunk (streetlight, bench, vent, sign...).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PropInstance {
    /// Prop archetype id (indexes the client asset catalog).
    pub archetype: u16,
    /// Position local to chunk origin, meters.
    pub x: f32,
    pub z: f32,
    pub rotation: f32,
}

/// A building footprint within a chunk.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BuildingInstance {
    /// Building archetype id (indexes the client asset catalog).
    pub archetype: u16,
    /// Tile-space footprint, local to chunk (inclusive min, exclusive max).
    pub tx0: u8,
    pub tz0: u8,
    pub tx1: u8,
    pub tz1: u8,
    /// Stories tall.
    pub stories: u8,
    /// Deterministic style seed (facade variation, neon color...).
    pub style: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChunkData {
    pub coord: ChunkCoord,
    /// Row-major TILES_PER_CHUNK^2 tile kinds.
    pub tiles: Vec<TileKind>,
    pub buildings: Vec<BuildingInstance>,
    pub props: Vec<PropInstance>,
}

impl ChunkData {
    pub fn tile(&self, tx: usize, tz: usize) -> TileKind {
        self.tiles[tz * TILES_PER_CHUNK + tx]
    }
}

// ---------------------------------------------------------------------------
// Economy ledger
//
// Every economic mutation is a typed transaction between two parties. Value
// only moves between entities (players and agents); issuance and destruction
// are explicit legs against the `Mint` / `Burn` system endpoints so total
// supply stays auditable: circulating = minted - burned, per item and for
// WILD.
// ---------------------------------------------------------------------------

/// One side of an economy transaction.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "t", content = "d")]
pub enum TxParty {
    /// A player character (persistent id + display name).
    Player {
        id: CharacterId,
        name: String,
        #[serde(default)]
        faction: FactionId,
    },
    /// A non-player actor: NPCs get a fresh identity per spawn; vendor
    /// buildings and the market keep a stable identity per session.
    Agent {
        id: AgentId,
        name: String,
        #[serde(default)]
        faction: FactionId,
    },
    /// Issuance source: gather nodes, NPC spawn inventories, wallet grants,
    /// vendor stock, crafting output.
    Mint,
    /// Destruction sink: death losses, loot expiry, consumed items, spent
    /// ammo, crafting inputs, items sold to vendors.
    Burn,
}

/// What a transaction is denominated in.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "t", content = "d")]
pub enum TxAmount {
    Item { kind: ItemKind, count: u32 },
    Wild { amount: u32 },
    /// Salvage currency earned by destroying items.
    Shards { amount: u32 },
    /// Charge currency earned from extractions and ammo caches.
    Energy { amount: u32 },
    Blueprint { recipe: String },
}

/// Why the transaction happened (a label; supply effects are derived from
/// the `Mint`/`Burn` parties, not from the kind).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum TxKind {
    /// Direct issuance: gathers, spawn inventories, grants, refunds.
    Mint,
    /// Direct destruction: death losses, loot expiry, consumables, ammo.
    Burn,
    /// Loot container pickup (from the previous owner to the picker).
    LootPickup,
    /// Item dropped on the ground (ownership retained until pickup/expiry).
    Drop,
    VendorBuy,
    VendorSell,
    /// Bank: carried Cash burned, wallet WILD minted (minus the fee).
    BankConvert,
    /// Market escrow: items move from the seller to the market agent.
    MarketList,
    MarketBuy,
    MarketCancel,
    /// Crafting/production inputs consumed.
    CraftConsume,
    /// Crafting/production output created.
    CraftProduce,
    /// Commerce cut routed to a territory holder.
    Fee,
    /// Extraction: backpack banked into the stash (self transfer).
    Extract,
}

/// A single ledger entry. `hash` and `block` are mock values for now (derived
/// from the tx sequence / server tick) until the ledger gets a real chain.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EconTx {
    pub seq: u64,
    pub hash: String,
    pub block: u64,
    /// Unix milliseconds when the tx was recorded.
    pub at_ms: u64,
    pub kind: TxKind,
    pub from: TxParty,
    pub to: TxParty,
    pub amount: TxAmount,
    /// WILD fee attached to this tx (informational; fee flows get their own
    /// `Fee` legs).
    pub fee: u32,
}

/// Live supply counters for one item kind.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct ItemSupply {
    pub kind: ItemKind,
    pub minted: u64,
    pub burned: u64,
}

/// Aggregate economy snapshot pushed to dashboard subscribers.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EconomyStats {
    /// Current mock block height.
    pub block: u64,
    /// Total transactions ever recorded.
    pub tx_count: u64,
    pub wild_minted: u64,
    pub wild_burned: u64,
    /// minted - burned (includes WILD held by vendor agents).
    pub wild_circulating: i64,
    #[serde(default)]
    pub shards_minted: u64,
    #[serde(default)]
    pub shards_burned: u64,
    #[serde(default)]
    pub energy_minted: u64,
    #[serde(default)]
    pub energy_burned: u64,
    /// Net WILD sitting on agent balances (vendors/market). Negative means
    /// agents have paid out more than they took in (net faucet).
    pub wild_agent_held: i64,
    /// Per-item supply counters (only kinds that have seen activity).
    pub items: Vec<ItemSupply>,
    pub blueprints_learned: u64,
    pub players_online: u32,
    pub agents_alive: u32,
    /// Player deaths (each burns the victim's backpack).
    pub deaths: u64,
    /// Agents killed by players.
    pub npc_kills: u64,
    /// Market trades completed.
    pub trades: u64,
}
