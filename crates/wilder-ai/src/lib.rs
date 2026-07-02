//! NPC behavior states. Implemented in Phase 1.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NpcState {
    Patrol,
    Aggro,
    Attack,
    Flee,
    Dead,
}

#[derive(Debug, Clone, Copy)]
pub struct NpcArchetype {
    pub name: &'static str,
    pub max_health: f32,
    pub damage: f32,
    pub attack_range: f32,
    pub aggro_range: f32,
    pub speed: f32,
    /// Client model variant.
    pub variant: u32,
}

pub const SCAV: NpcArchetype = NpcArchetype {
    name: "Scav",
    max_health: 40.0,
    damage: 6.0,
    attack_range: 1.8,
    aggro_range: 10.0,
    speed: 3.2,
    variant: 1,
};

pub const RAIDER: NpcArchetype = NpcArchetype {
    name: "Raider",
    max_health: 70.0,
    damage: 10.0,
    attack_range: 2.0,
    aggro_range: 14.0,
    speed: 4.0,
    variant: 2,
};
