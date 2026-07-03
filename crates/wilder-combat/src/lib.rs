//! Combat rules: weapon stats, armor, abilities, damage resolution.

use wilder_types::{AbilityKind, ItemKind};

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
        ItemKind::Pipe => Some(WeaponStats { damage: 22.0, range: 2.0, cooldown: 1.0, ranged: false }),
        ItemKind::Knife => Some(WeaponStats { damage: 16.0, range: 1.6, cooldown: 0.55, ranged: false }),
        // Tuned so a Scav (40 hp) drops in 2 pistol shots / 3 SMG shots and a
        // Raider (70 hp) in 3 / 5.
        ItemKind::Pistol => Some(WeaponStats { damage: 30.0, range: 18.0, cooldown: 0.3, ranged: true }),
        ItemKind::Smg => Some(WeaponStats { damage: 15.0, range: 15.0, cooldown: 0.1, ranged: true }),
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

/// Energy shield capacity granted by armor. Shield absorbs damage before
/// health and regenerates out of combat.
pub fn armor_shield(armor: Option<ItemKind>) -> f32 {
    match armor {
        Some(ItemKind::JacketArmor) => 25.0,
        Some(ItemKind::PlateArmor) => 50.0,
        _ => 0.0,
    }
}

/// Shield regen: rate (per second) and delay after last damage taken.
pub const SHIELD_REGEN_RATE: f32 = 5.0;
pub const SHIELD_REGEN_DELAY: f32 = 5.0;

#[derive(Debug, Clone, Copy)]
pub struct AbilityStats {
    /// Seconds between uses.
    pub cooldown: f32,
    /// Seconds the effect stays active (0 = instant).
    pub duration: f32,
}

pub fn ability_stats(kind: AbilityKind) -> AbilityStats {
    match kind {
        AbilityKind::Shockwave => AbilityStats { cooldown: 8.0, duration: 0.0 },
        AbilityKind::Stim => AbilityStats { cooldown: 15.0, duration: 5.0 },
        AbilityKind::Overcharge => AbilityStats { cooldown: 20.0, duration: 4.0 },
    }
}

pub const SHOCKWAVE_DAMAGE: f32 = 15.0;
pub const SHOCKWAVE_RADIUS: f32 = 4.0;
pub const SHOCKWAVE_KNOCKBACK: f32 = 2.5;
/// Stim: total healing spread over the ability duration + speed boost window.
pub const STIM_HEAL: f32 = 30.0;
pub const STIM_SPEED_MULT: f32 = 1.25;
pub const STIM_SPEED_DURATION: f32 = 3.0;
pub const OVERCHARGE_MULT: f32 = 1.5;
