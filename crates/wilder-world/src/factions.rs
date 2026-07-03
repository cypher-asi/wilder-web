//! Faction registry and hostility matrix.
//!
//! Factions are data, not enums: everything a faction *is* (name, color,
//! who it fights) lives in [`faction_registry`], so adding a third faction is
//! a new registry entry, not a refactor. `FACTION_NEUTRAL` (id 0) is implicit:
//! it never appears in the registry and is hostile to no one — services,
//! loot and unaffiliated actors all carry it by `serde(default)`.

use wilder_types::{FactionId, FactionInfo, FACTION_FORUM, FACTION_REBELS};

/// All registered (non-neutral) factions, serialized to clients on join.
pub fn faction_registry() -> Vec<FactionInfo> {
    vec![
        FactionInfo {
            id: FACTION_REBELS,
            name: "Rebels".into(),
            tagline: "Free the grid.".into(),
            color: 0x2d_e0_a6,
            hostile_to: vec![FACTION_FORUM],
        },
        FactionInfo {
            id: FACTION_FORUM,
            name: "The Forum".into(),
            tagline: "Order through moderation.".into(),
            color: 0xff_38_60,
            hostile_to: vec![FACTION_REBELS],
        },
    ]
}

/// Whether two factions attack each other on sight.
///
/// Table-driven off [`faction_registry`]: hostility is symmetric (either side
/// listing the other makes the pair hostile). Neutral (absent from the
/// registry) and unknown ids are hostile to no one; a faction is never
/// hostile to itself.
pub fn are_hostile(a: FactionId, b: FactionId) -> bool {
    if a == b {
        return false;
    }
    faction_registry().iter().any(|f| {
        (f.id == a && f.hostile_to.contains(&b)) || (f.id == b && f.hostile_to.contains(&a))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use wilder_types::FACTION_NEUTRAL;

    #[test]
    fn rebels_and_forum_are_mutually_hostile() {
        assert!(are_hostile(FACTION_REBELS, FACTION_FORUM));
        assert!(are_hostile(FACTION_FORUM, FACTION_REBELS));
    }

    #[test]
    fn neutral_is_hostile_to_no_one() {
        for f in [FACTION_NEUTRAL, FACTION_REBELS, FACTION_FORUM] {
            assert!(!are_hostile(FACTION_NEUTRAL, f));
            assert!(!are_hostile(f, FACTION_NEUTRAL));
        }
    }

    #[test]
    fn factions_are_not_self_hostile() {
        for f in faction_registry() {
            assert!(!are_hostile(f.id, f.id));
        }
    }

    #[test]
    fn unknown_ids_are_not_hostile() {
        assert!(!are_hostile(99, FACTION_REBELS));
        assert!(!are_hostile(FACTION_FORUM, 99));
        assert!(!are_hostile(99, 100));
    }

    #[test]
    fn registry_excludes_neutral() {
        assert!(faction_registry().iter().all(|f| f.id != FACTION_NEUTRAL));
    }
}
