//! Storage traits + local implementations.
//!
//! All game state persistence goes through the traits in this crate so the
//! backing store can be swapped (RocksDB locally today; PostgreSQL/Redis/S3 in
//! production later) without touching game logic.

mod rocks;

pub use rocks::RocksStore;

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use uuid::Uuid;
use wilder_types::*;

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("not found")]
    NotFound,
    #[error("conflict: {0}")]
    Conflict(String),
    #[error("storage error: {0}")]
    Backend(String),
}

pub type StoreResult<T> = Result<T, StoreError>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Account {
    pub id: AccountId,
    pub username: String,
    pub password_hash: String,
    pub created_unix: u64,
    /// Soft currency wallet (Phase 3 market). At-risk: burns on death.
    pub wallet: u32,
    /// Banked MILD: safe from death (deposited/withdrawn at a Bank).
    #[serde(default)]
    pub bank: u32,
    /// Salvage currency (earned by destroying items).
    #[serde(default)]
    pub shards: u32,
    /// Charge currency (earned from extractions and ammo caches).
    #[serde(default)]
    pub energy: u32,
}

/// Persistent stash (home storage), one per character.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Stash {
    pub slots: Vec<Option<ItemStack>>,
}

impl Stash {
    pub const DEFAULT_SLOTS: usize = 48;

    pub fn new() -> Self {
        Self { slots: vec![None; Self::DEFAULT_SLOTS] }
    }
}

/// Accounts, characters, inventories, stashes. Production target: PostgreSQL.
pub trait CharacterStore: Send + Sync {
    fn create_account(&self, username: &str, password_hash: &str) -> StoreResult<Account>;
    fn account_by_username(&self, username: &str) -> StoreResult<Account>;
    fn account_by_id(&self, id: AccountId) -> StoreResult<Account>;
    fn update_wallet(&self, id: AccountId, wallet: u32) -> StoreResult<()>;
    /// Persist the banked (death-safe) MILD balance.
    fn update_bank(&self, id: AccountId, bank: u32) -> StoreResult<()>;
    /// Persist the secondary currencies (Shards + Energy).
    fn update_currencies(&self, id: AccountId, shards: u32, energy: u32) -> StoreResult<()>;

    fn create_character(&self, character: &Character) -> StoreResult<()>;
    fn character(&self, id: CharacterId) -> StoreResult<Character>;
    fn characters_for_account(&self, account: AccountId) -> StoreResult<Vec<Character>>;
    fn save_character(&self, character: &Character) -> StoreResult<()>;

    fn inventory(&self, character: CharacterId) -> StoreResult<Inventory>;
    fn save_inventory(&self, character: CharacterId, inv: &Inventory) -> StoreResult<()>;

    fn stash(&self, character: CharacterId) -> StoreResult<Stash>;
    fn save_stash(&self, character: CharacterId, stash: &Stash) -> StoreResult<()>;

    /// Known blueprint ids (Phase 3).
    fn blueprints(&self, character: CharacterId) -> StoreResult<Vec<String>>;
    fn save_blueprints(&self, character: CharacterId, known: &[String]) -> StoreResult<()>;
}

/// Chunk modifications + world metadata. Production target: PostgreSQL.
pub trait WorldStore: Send + Sync {
    /// Load a persisted chunk override, if the chunk was ever modified.
    fn chunk(&self, coord: ChunkCoord) -> StoreResult<Option<ChunkData>>;
    fn save_chunk(&self, chunk: &ChunkData) -> StoreResult<()>;

    fn meta<T: DeserializeOwned>(&self, key: &str) -> StoreResult<Option<T>>;
    fn save_meta<T: Serialize>(&self, key: &str, value: &T) -> StoreResult<()>;
}

/// Session tokens. Local: in-process via RocksDB `sessions` CF so relogs survive
/// server restarts. Production target: Redis with TTL.
pub trait SessionStore: Send + Sync {
    fn create_session(&self, account: AccountId) -> StoreResult<String>;
    fn account_for_token(&self, token: &str) -> StoreResult<AccountId>;
    fn revoke(&self, token: &str) -> StoreResult<()>;
}

pub fn new_token() -> String {
    // Two v4 UUIDs = 256 bits of randomness.
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}
