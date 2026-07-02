//! Combat rules: weapon stats, damage resolution. Implemented in Phase 1.

use wilder_types::ItemKind;

#[derive(Debug, Clone, Copy)]
pub struct WeaponStats {
    pub damage: f32,
    /// Meters. Melee weapons have short range.
    pub range: f32,
    /// Seconds between attacks.
    pub cooldown: f32,
    pub ranged: bool,
}

pub const FIST: WeaponStats = WeaponStats { damage: 5.0, range: 1.5, cooldown: 0.8, ranged: false };

pub fn weapon_stats(kind: ItemKind) -> Option<WeaponStats> {
    match kind {
        ItemKind::Pipe => Some(WeaponStats { damage: 12.0, range: 2.0, cooldown: 1.0, ranged: false }),
        ItemKind::Knife => Some(WeaponStats { damage: 9.0, range: 1.6, cooldown: 0.55, ranged: false }),
        ItemKind::Pistol => Some(WeaponStats { damage: 16.0, range: 18.0, cooldown: 0.6, ranged: true }),
        ItemKind::Smg => Some(WeaponStats { damage: 8.0, range: 15.0, cooldown: 0.15, ranged: true }),
        _ => None,
    }
}

/// Damage reduction multiplier from armor.
pub fn armor_multiplier(armor: Option<ItemKind>) -> f32 {
    match armor {
        Some(ItemKind::JacketArmor) => 0.85,
        Some(ItemKind::PlateArmor) => 0.65,
        _ => 1.0,
    }
}
