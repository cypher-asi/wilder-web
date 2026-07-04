//! Server-side districts: every baked neighborhood gets a danger level and a
//! home faction, driving combat gating, agent homing and the map's intensity
//! gradient.
//!
//! Assignment is nearest-anchor (Voronoi over the 8 baked district anchors).
//! The spawn hub's protected chunks and anything outside the baked map are
//! always `Sanctuary`, regardless of the nearest district.

use std::sync::OnceLock;

use wilder_types::{
    DangerLevel, DistrictInfo, FactionId, Vec3, FACTION_FORUM, FACTION_NEUTRAL, FACTION_REBELS,
    FACTION_WAPES, TILE_SIZE,
};

use crate::is_safe_chunk;
use wilder_types::ChunkCoord;

/// One district with its server-side rules attached.
#[derive(Debug, Clone)]
pub struct DistrictDef {
    pub name: String,
    pub x: f32,
    pub z: f32,
    pub danger: DangerLevel,
    pub home_faction: FactionId,
}

/// Danger level + home faction per district name. Names not in this table
/// (future bakes) default to Contested/neutral so new neighborhoods are
/// playable without a code change.
fn rules_for(name: &str) -> (DangerLevel, FactionId) {
    match name {
        "TRANQUILITY GARDENS" | "HAVEN HEIGHTS" => (DangerLevel::Sanctuary, FACTION_NEUTRAL),
        "LITTLE MEOW" => (DangerLevel::Guarded, FACTION_REBELS),
        "NORTH STAR" => (DangerLevel::Guarded, FACTION_FORUM),
        "NEXUS" | "DISTRICT ZERO" => (DangerLevel::Contested, FACTION_NEUTRAL),
        "SPACE MIND" | "FLASHING LIGHTS" => (DangerLevel::Warzone, FACTION_NEUTRAL),
        _ => (DangerLevel::Contested, FACTION_NEUTRAL),
    }
}

/// All districts with rules, in the baked order (index = stable district id).
pub fn district_defs() -> &'static [DistrictDef] {
    static DEFS: OnceLock<Vec<DistrictDef>> = OnceLock::new();
    DEFS.get_or_init(|| {
        wilder_terrain::districts()
            .iter()
            .map(|d| {
                let (danger, home_faction) = rules_for(&d.name);
                DistrictDef { name: d.name.clone(), x: d.x, z: d.z, danger, home_faction }
            })
            .collect()
    })
}

/// The district whose anchor is nearest to `pos` (Voronoi assignment).
pub fn district_of(pos: Vec3) -> Option<(usize, &'static DistrictDef)> {
    district_defs()
        .iter()
        .enumerate()
        .min_by(|(_, a), (_, b)| {
            let da = (a.x - pos.x).powi(2) + (a.z - pos.z).powi(2);
            let db = (b.x - pos.x).powi(2) + (b.z - pos.z).powi(2);
            da.partial_cmp(&db).unwrap_or(std::cmp::Ordering::Equal)
        })
}

/// True when `pos` falls outside the baked city (open water world boundary).
fn outside_baked_map(pos: Vec3) -> bool {
    let (min_x, min_z, max_x, max_z) = wilder_terrain::CityMap::get().tile_bounds();
    let tx = (pos.x / TILE_SIZE).floor() as i32;
    let tz = (pos.z / TILE_SIZE).floor() as i32;
    tx < min_x || tx >= max_x || tz < min_z || tz >= max_z
}

/// Radius (m) of the legacy combat ring around the spawn hub. The hub sits
/// deep inside TRANQUILITY GARDENS' Voronoi cell, and without this carve-out
/// the sanctuary rule would blanket the entire starter playfield — no feral
/// combat, no territory flips — even though the district anchor is ~1.5 km
/// away. Inside the ring (minus the protected hub chunks) the ground is
/// Contested; the sanctuary district still applies around its own anchor.
pub const HUB_COMBAT_RING_M: f32 = 900.0;

/// Danger level governing combat/capture at a world position. The spawn hub's
/// protected chunks and anywhere outside the baked map are Sanctuary, the
/// combat ring around the hub is Contested, and anything else takes its
/// containing (nearest-anchor) district's level.
pub fn danger_at(pos: Vec3) -> DangerLevel {
    if is_safe_chunk(ChunkCoord::from_world(pos)) {
        return DangerLevel::Sanctuary;
    }
    // Checked before the baked-map bound: the procedural hub neighborhood
    // sits outside the baked city tiles but is very much part of the game.
    if pos.x.hypot(pos.z) < HUB_COMBAT_RING_M {
        return DangerLevel::Contested;
    }
    if outside_baked_map(pos) {
        return DangerLevel::Sanctuary;
    }
    district_of(pos).map(|(_, d)| d.danger).unwrap_or(DangerLevel::Sanctuary)
}

/// Home faction of the district containing `pos` (neutral outside any
/// Guarded home turf).
pub fn home_faction_at(pos: Vec3) -> FactionId {
    district_of(pos).map(|(_, d)| d.home_faction).unwrap_or(FACTION_NEUTRAL)
}

/// Wire form of every district, sent to clients in `PoiList` on join.
pub fn district_infos() -> Vec<DistrictInfo> {
    district_defs()
        .iter()
        .map(|d| DistrictInfo {
            name: d.name.clone(),
            x: d.x,
            z: d.z,
            danger: d.danger,
            home_faction: d.home_faction,
        })
        .collect()
}

/// Index of a faction's Guarded home district (agent staging / respawns).
/// Wapes have none: they live scattered across hostile ground and respawn
/// at their per-agent `home_spot` anchors.
pub fn faction_home_district(faction: FactionId) -> Option<usize> {
    if faction == FACTION_WAPES {
        return None;
    }
    district_defs()
        .iter()
        .position(|d| d.danger == DangerLevel::Guarded && d.home_faction == faction)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn anchor(name: &str) -> Vec3 {
        let d = district_defs().iter().find(|d| d.name == name).unwrap();
        Vec3::new(d.x, 0.0, d.z)
    }

    #[test]
    fn every_baked_district_has_rules() {
        let defs = district_defs();
        assert_eq!(defs.len(), 8);
        let sanctuaries = defs.iter().filter(|d| d.danger == DangerLevel::Sanctuary).count();
        let guarded = defs.iter().filter(|d| d.danger == DangerLevel::Guarded).count();
        let warzones = defs.iter().filter(|d| d.danger == DangerLevel::Warzone).count();
        assert_eq!(sanctuaries, 2);
        assert_eq!(guarded, 2);
        assert_eq!(warzones, 2);
    }

    #[test]
    fn nearest_anchor_assignment() {
        for def in district_defs() {
            let (_, hit) = district_of(Vec3::new(def.x, 0.0, def.z)).unwrap();
            assert_eq!(hit.name, def.name);
            // A small offset still lands in the same Voronoi cell.
            let (_, near) = district_of(Vec3::new(def.x + 40.0, 0.0, def.z - 40.0)).unwrap();
            assert_eq!(near.name, def.name);
        }
    }

    #[test]
    fn danger_lookup_matches_table() {
        assert_eq!(danger_at(anchor("TRANQUILITY GARDENS")), DangerLevel::Sanctuary);
        assert_eq!(danger_at(anchor("HAVEN HEIGHTS")), DangerLevel::Sanctuary);
        assert_eq!(danger_at(anchor("LITTLE MEOW")), DangerLevel::Guarded);
        assert_eq!(danger_at(anchor("NORTH STAR")), DangerLevel::Guarded);
        assert_eq!(danger_at(anchor("NEXUS")), DangerLevel::Contested);
        assert_eq!(danger_at(anchor("DISTRICT ZERO")), DangerLevel::Contested);
        assert_eq!(danger_at(anchor("SPACE MIND")), DangerLevel::Warzone);
        assert_eq!(danger_at(anchor("FLASHING LIGHTS")), DangerLevel::Warzone);
    }

    #[test]
    fn hub_and_off_map_are_sanctuary() {
        // The protected spawn chunks are Sanctuary no matter what district
        // is nearest.
        assert_eq!(danger_at(Vec3::new(3.0, 0.0, 3.0)), DangerLevel::Sanctuary);
        // Far outside the baked city: open water, no combat.
        assert_eq!(danger_at(Vec3::new(1.0e6, 0.0, 1.0e6)), DangerLevel::Sanctuary);
    }

    #[test]
    fn hub_combat_ring_is_contested() {
        // The starter playfield around the hub (outside the protected chunks
        // but inside the combat ring) must allow combat and territory flips,
        // even though the nearest district anchor is a Sanctuary.
        assert_eq!(danger_at(Vec3::new(200.0, 0.0, 0.0)), DangerLevel::Contested);
        assert_eq!(danger_at(Vec3::new(-300.0, 0.0, 400.0)), DangerLevel::Contested);
    }

    #[test]
    fn faction_homes() {
        let rebels = faction_home_district(FACTION_REBELS).unwrap();
        let forum = faction_home_district(FACTION_FORUM).unwrap();
        assert_eq!(district_defs()[rebels].name, "LITTLE MEOW");
        assert_eq!(district_defs()[forum].name, "NORTH STAR");
    }

    #[test]
    fn faction_homes_are_guarded_home_turf() {
        for faction in [FACTION_REBELS, FACTION_FORUM] {
            let idx = faction_home_district(faction).unwrap();
            let d = &district_defs()[idx];
            assert_eq!(d.danger, DangerLevel::Guarded);
            assert_eq!(d.home_faction, faction);
        }
    }
}
