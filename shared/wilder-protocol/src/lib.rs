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
    /// Spawn a character into the world (must be authenticated).
    JoinWorld { character_id: CharacterId },
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
    /// Market actions. Phase 3.
    Market(MarketAction),
    /// NPC vendor actions (Armory, Bodega, Bank...). Requires being in reach
    /// of the vendor building.
    Vendor { vendor: EntityId, action: VendorAction },
    /// Subscribe/unsubscribe to live economy ledger updates (K dashboard).
    EconomySub { on: bool },
    /// Subscribe/unsubscribe to whole-map agent blips (map filters). While
    /// on, the server streams `MapIntel` at ~1 Hz.
    MapIntelSub { on: bool },
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
    /// Buy `count` items from the vendor's stock (pays WILD).
    Buy { kind: ItemKind, count: u32 },
    /// Sell `count` carried items to the vendor (receives WILD).
    Sell { kind: ItemKind, count: u32 },
    /// Bank only: convert carried Cash into wallet WILD (minus the fee).
    Convert { count: u32 },
    Refresh,
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
    /// any of the three changes).
    WalletUpdate { wild: u32, shards: u32, energy: u32 },
    /// Authoritative ability state for the receiving player (on use + join).
    AbilityUpdate { ability: AbilityKind, cooldown: f32, active: f32 },
    Died { by: Option<String>, lost_items: bool },
    ExtractStart { seconds: f32 },
    ExtractCancel,
    ExtractResult { success: bool, banked: Vec<ItemStack> },
    /// Everything a pickup/gather actually added to the backpack. `denied` is
    /// set when nothing fit (drives the "Backpack full" toast + deny sound).
    GatherResult {
        gained: Vec<ItemStack>,
        #[serde(default)]
        denied: bool,
    },
    CraftResult { ok: bool, error: Option<String>, produced: Option<ItemStack> },
    ProductionState { building: EntityId, jobs: Vec<ProductionJob> },
    MarketState { listings: Vec<MarketListing>, wallet: u32 },
    MarketResult { ok: bool, error: Option<String> },
    /// A vendor's stock/prices plus the receiving player's wallet (sent on
    /// interact, refresh and after every vendor transaction).
    VendorState { vendor: EntityId, kind: EntityKind, offers: Vec<VendorOffer>, wallet: u32 },
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
    /// Territory control overlay: every region not under neutral control.
    TerritoryState { cells: Vec<TerritoryCell> },
    BlueprintsUpdate { known: Vec<String> },
    /// Full economy snapshot on dashboard subscribe: aggregate stats plus the
    /// recent transaction feed (oldest first).
    EconomyState { stats: EconomyStats, recent: Vec<EconTx> },
    /// Per-tick batch of new ledger transactions for subscribers.
    EconomyTxs { txs: Vec<EconTx>, stats: EconomyStats },
    /// Whole-map actor blips, streamed ~1 Hz to `MapIntelSub` subscribers.
    MapIntel { blips: Vec<AgentBlip> },
    /// Leaderboards + faction/guild standings, refreshed for economy
    /// dashboard subscribers.
    LeaderboardState(LeaderboardData),
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MarketListing {
    pub id: u64,
    pub seller: String,
    pub kind: ItemKind,
    pub count: u32,
    pub price_each: u32,
}

/// A vendor's price line for one item kind. `buy` is what the player pays per
/// unit, `sell` is what the vendor pays the player; 0 means "not traded that
/// way".
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct VendorOffer {
    pub kind: ItemKind,
    pub buy: u32,
    pub sell: u32,
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
    /// 0 = player, 1 = agent, 2 = feral.
    pub kind: u8,
    pub x: i16,
    pub z: i16,
}

/// Leaderboards payload: per-category top-N boards plus rolled-up faction and
/// guild standings.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LeaderboardData {
    pub boards: Vec<Board>,
    pub factions: Vec<FactionStanding>,
    pub guilds: Vec<GuildStanding>,
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

/// One controlled region on the territory grid. `control`: 1 = player-held,
/// 2 = enemy-held (neutral regions are never sent).
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct TerritoryCell {
    pub rx: i32,
    pub rz: i32,
    pub control: u8,
}

pub fn encode<T: Serialize>(msg: &T) -> String {
    serde_json::to_string(msg).expect("protocol encode")
}

pub fn decode<'a, T: Deserialize<'a>>(text: &'a str) -> Result<T, serde_json::Error> {
    serde_json::from_str(text)
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
    fn roundtrip_map_intel() {
        let msg = S2C::MapIntel {
            blips: vec![AgentBlip { id: 9, faction: FACTION_FORUM, kind: 1, x: -120, z: 512 }],
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
            }],
            guilds: vec![GuildStanding {
                name: "Dead Signal".into(),
                faction: FACTION_REBELS,
                members: 30,
                kills: 5,
                wealth: 777,
            }],
        });
        let text = encode(&msg);
        match decode::<S2C>(&text).unwrap() {
            S2C::LeaderboardState(data) => {
                assert_eq!(data.boards[0].rows[0].guild.as_deref(), Some("Dead Signal"));
                assert_eq!(data.factions[0].regions_held, 4);
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
