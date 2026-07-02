//! Resource definitions and yields. Implemented in Phase 2.

use wilder_types::ItemKind;

pub const RESOURCES: [ItemKind; 5] = [
    ItemKind::Iron,
    ItemKind::Copper,
    ItemKind::Chemicals,
    ItemKind::Electronics,
    ItemKind::Biomass,
];

/// Resource node variant -> what it yields.
pub fn node_yield(variant: u32) -> ItemKind {
    RESOURCES[(variant as usize) % RESOURCES.len()]
}
