//! Exchange identity layer: what can be traded ([`Asset`]), where
//! ([`Venue`]) and by whom ([`OrderOwner`]).
//!
//! # Quote convention
//!
//! Every asset is quoted in WILD (`u32`, displayed as "MILD" in the UI),
//! **per unit**. There are no fractional units: a limit price of 7 on IRON
//! means 7 WILD buys exactly one Iron.

use serde::{Deserialize, Serialize};
use wilder_types::{CharacterId, ItemKind};

/// Everything tradeable on the exchange: every inventory item plus the two
/// non-item currencies (Shards, Energy). WILD itself is the quote currency
/// and is never an `Asset`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Asset {
    Item(ItemKind),
    /// Salvage currency earned by destroying items.
    Shards,
    /// Charge currency earned from extractions and ammo caches.
    Energy,
}

/// Every [`ItemKind`] variant, in declaration order. Kept in sync by the
/// `all_assets_cover_every_item_kind` test below: adding an `ItemKind`
/// variant without extending this list makes that test fail to compile
/// (via the exhaustive `match`).
const ALL_ITEM_KINDS: [ItemKind; 22] = [
    ItemKind::Medkit,
    ItemKind::Flashlight,
    ItemKind::Pipe,
    ItemKind::Knife,
    ItemKind::Pistol,
    ItemKind::Smg,
    ItemKind::JacketArmor,
    ItemKind::PlateArmor,
    ItemKind::Ammo9mm,
    ItemKind::Iron,
    ItemKind::Copper,
    ItemKind::Chemicals,
    ItemKind::Electronics,
    ItemKind::Biomass,
    ItemKind::SteelPlate,
    ItemKind::CopperWire,
    ItemKind::Polymer,
    ItemKind::CircuitBoard,
    ItemKind::BioGel,
    ItemKind::BlueprintFragment,
    ItemKind::PowerCell,
    ItemKind::Cash,
];

impl Asset {
    /// Short uppercase ticker shown in the markets table. Unique per asset
    /// (enforced by test).
    pub fn ticker(&self) -> &'static str {
        match self {
            Asset::Item(kind) => match kind {
                ItemKind::Medkit => "MEDK",
                ItemKind::Flashlight => "LITE",
                ItemKind::Pipe => "PIPE",
                ItemKind::Knife => "KNIF",
                ItemKind::Pistol => "PSTL",
                ItemKind::Smg => "SMG",
                ItemKind::JacketArmor => "JCKT",
                ItemKind::PlateArmor => "PLTE",
                ItemKind::Ammo9mm => "AMMO",
                ItemKind::Iron => "IRON",
                ItemKind::Copper => "COPR",
                ItemKind::Chemicals => "CHEM",
                ItemKind::Electronics => "ELEC",
                ItemKind::Biomass => "BIO",
                ItemKind::SteelPlate => "STEEL",
                ItemKind::CopperWire => "WIRE",
                ItemKind::Polymer => "POLY",
                ItemKind::CircuitBoard => "CIRC",
                ItemKind::BioGel => "BGEL",
                ItemKind::BlueprintFragment => "BLPF",
                ItemKind::PowerCell => "PCEL",
                ItemKind::Cash => "CASH",
            },
            Asset::Shards => "SHRD",
            Asset::Energy => "NRG",
        }
    }

    /// Human-readable name for detail views (item display names where they
    /// exist).
    pub fn display_name(&self) -> String {
        match self {
            Asset::Item(kind) => kind.display_name().to_string(),
            Asset::Shards => "Shards".to_string(),
            Asset::Energy => "Energy".to_string(),
        }
    }

    /// Every listable asset: all item kinds plus Shards and Energy.
    pub fn all() -> Vec<Asset> {
        let mut assets: Vec<Asset> = ALL_ITEM_KINDS.iter().copied().map(Asset::Item).collect();
        assets.push(Asset::Shards);
        assets.push(Asset::Energy);
        assets
    }
}

/// Stable identifier of one trading venue (a district Market Terminal).
/// Venues are derived deterministically from the district list at world
/// boot, so ids are stable across restarts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub struct VenueId(pub u16);

/// One trading venue: each venue keeps fully independent order books per
/// asset, so the same ticker trades at different prices across venues
/// (arbitrage requires physically hauling goods between them).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Venue {
    pub id: VenueId,
    pub name: String,
    /// World-space anchor of the venue's Market Terminal (meters).
    pub x: f32,
    pub z: f32,
}

/// Who owns an order or a settlement inbox. Players and agents share the
/// uuid-based `CharacterId` space (agents mint a fresh uuid per spawn, same
/// as `TxParty::Agent` in the ledger); the variant records which kind of
/// actor placed the order so the world knows which inventory/purse to hit.
/// `Desk` is the exchange's own market-making desk — a single world-owned
/// liquidity provider whose escrow lives outside any inventory/purse.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub enum OrderOwner {
    Player(CharacterId),
    Agent(CharacterId),
    Desk,
}

impl OrderOwner {
    /// The underlying uuid, regardless of actor kind. The desk has no
    /// character; it maps to the nil uuid (which no player or agent ever
    /// mints — v4 uuids are never nil).
    pub fn id(&self) -> CharacterId {
        match self {
            OrderOwner::Player(id) | OrderOwner::Agent(id) => *id,
            OrderOwner::Desk => CharacterId::nil(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn tickers_are_unique_and_uppercase() {
        let assets = Asset::all();
        let mut seen = HashSet::new();
        for asset in &assets {
            let ticker = asset.ticker();
            assert!(!ticker.is_empty());
            assert_eq!(ticker, ticker.to_uppercase(), "ticker {ticker} not uppercase");
            assert!(seen.insert(ticker), "duplicate ticker {ticker}");
        }
        assert_eq!(seen.len(), assets.len());
    }

    /// The exhaustive match forces a compile error when `ItemKind` grows a
    /// variant, which points straight at `ALL_ITEM_KINDS` needing the new
    /// entry too.
    #[test]
    fn all_assets_cover_every_item_kind() {
        fn assert_listed(kind: ItemKind) {
            match kind {
                ItemKind::Medkit
                | ItemKind::Flashlight
                | ItemKind::Pipe
                | ItemKind::Knife
                | ItemKind::Pistol
                | ItemKind::Smg
                | ItemKind::JacketArmor
                | ItemKind::PlateArmor
                | ItemKind::Ammo9mm
                | ItemKind::Iron
                | ItemKind::Copper
                | ItemKind::Chemicals
                | ItemKind::Electronics
                | ItemKind::Biomass
                | ItemKind::SteelPlate
                | ItemKind::CopperWire
                | ItemKind::Polymer
                | ItemKind::CircuitBoard
                | ItemKind::BioGel
                | ItemKind::BlueprintFragment
                | ItemKind::PowerCell
                | ItemKind::Cash => {
                    assert!(
                        ALL_ITEM_KINDS.contains(&kind),
                        "{kind:?} missing from ALL_ITEM_KINDS"
                    );
                }
            }
        }
        for kind in ALL_ITEM_KINDS {
            assert_listed(kind);
        }
        let all = Asset::all();
        assert_eq!(all.len(), ALL_ITEM_KINDS.len() + 2);
        assert!(all.contains(&Asset::Shards));
        assert!(all.contains(&Asset::Energy));
        // No duplicates.
        let unique: HashSet<Asset> = all.iter().copied().collect();
        assert_eq!(unique.len(), all.len());
    }

    #[test]
    fn display_names_exist() {
        for asset in Asset::all() {
            assert!(!asset.display_name().is_empty());
        }
    }

    #[test]
    fn serde_roundtrip() {
        for asset in Asset::all() {
            let json = serde_json::to_string(&asset).expect("serialize");
            let back: Asset = serde_json::from_str(&json).expect("deserialize");
            assert_eq!(asset, back);
        }
        for owner in [OrderOwner::Player(CharacterId::new_v4()), OrderOwner::Desk] {
            let json = serde_json::to_string(&owner).expect("serialize");
            let back: OrderOwner = serde_json::from_str(&json).expect("deserialize");
            assert_eq!(owner, back);
        }
        assert_eq!(OrderOwner::Desk.id(), CharacterId::nil());
    }
}
