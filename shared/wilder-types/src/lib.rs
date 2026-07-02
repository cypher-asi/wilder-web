//! Shared domain types used by every Wilder crate and mirrored to the client.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub use glam::Vec3;

pub type AccountId = Uuid;
pub type CharacterId = Uuid;
pub type EntityId = u64;

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
            ItemKind::Medkit => 5,
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

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct ItemStack {
    pub kind: ItemKind,
    pub count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Inventory {
    pub slots: Vec<Option<ItemStack>>,
    pub equipped_weapon: Option<ItemKind>,
    pub equipped_armor: Option<ItemKind>,
}

impl Inventory {
    pub const DEFAULT_SLOTS: usize = 24;

    pub fn new() -> Self {
        Self {
            slots: vec![None; Self::DEFAULT_SLOTS],
            equipped_weapon: None,
            equipped_armor: None,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum EntityKind {
    Player,
    Npc,
    LootContainer,
    ExtractionPoint,
    ResourceNode,
    /// Stash terminal.
    Building,
    Refinery,
    Factory,
    Laboratory,
    MarketTerminal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AnimState {
    Idle,
    Walk,
    Run,
    Attack,
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
