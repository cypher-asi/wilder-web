//! Wire protocol between the Wilder client and server.
//!
//! Encoding: JSON text frames over WebSocket for now (debuggable, zero client deps).
//! All encode/decode goes through [`encode`]/[`decode`] so a switch to a binary
//! format later is a single-file change. TypeScript mirrors live in
//! `apps/web/src/net/protocol.ts` and must stay in sync with these definitions.

use serde::{Deserialize, Serialize};
use wilder_types::*;

/// Territory grid: a controllable zone is a square block of this many chunks
/// on a side. Region math must match `apps/web/src/game/territory.ts`.
pub const REGION_CHUNKS: i32 = 4;

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
    Chat { text: String },
    Pong { nonce: u32 },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "t", content = "d")]
pub enum InventoryAction {
    MoveSlot { from: u16, to: u16 },
    Equip { slot: u16 },
    Unequip { weapon: bool },
    Drop { slot: u16 },
    /// Move items between inventory and stash (only near stash access).
    Deposit { slot: u16 },
    Withdraw { stash_slot: u16 },
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
    /// Authoritative ability state for the receiving player (on use + join).
    AbilityUpdate { ability: AbilityKind, cooldown: f32, active: f32 },
    Died { by: Option<String>, lost_items: bool },
    ExtractStart { seconds: f32 },
    ExtractCancel,
    ExtractResult { success: bool, banked: Vec<ItemStack> },
    GatherResult { gained: Option<ItemStack> },
    CraftResult { ok: bool, error: Option<String>, produced: Option<ItemStack> },
    ProductionState { building: EntityId, jobs: Vec<ProductionJob> },
    MarketState { listings: Vec<MarketListing>, wallet: u32 },
    MarketResult { ok: bool, error: Option<String> },
    /// Territory control overlay: every region not under neutral control.
    TerritoryState { cells: Vec<TerritoryCell> },
    BlueprintsUpdate { known: Vec<String> },
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
}
