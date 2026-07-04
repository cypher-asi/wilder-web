//! Player market: listings and order matching. Implemented in Phase 3.

use serde::{Deserialize, Serialize};
use wilder_types::{CharacterId, ItemKind};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Listing {
    pub id: u64,
    pub seller: CharacterId,
    pub seller_name: String,
    pub kind: ItemKind,
    pub count: u32,
    pub price_each: u32,
    /// Agent-owned stock: asks decay toward the price floor over time so the
    /// book can't clog with overpriced inventory. Player listings never
    /// decay. (Defaults false for pre-flag saves; the world re-derives it on
    /// load for listings whose seller isn't a stored player character.)
    #[serde(default)]
    pub agent: bool,
}
