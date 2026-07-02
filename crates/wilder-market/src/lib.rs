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
}
