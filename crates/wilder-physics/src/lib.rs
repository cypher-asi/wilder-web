//! Server-authoritative character movement + tile collision.
//!
//! The client runs the same constants for prediction; any divergence is
//! corrected by reconciliation against server snapshots.

use wilder_types::*;

pub const WALK_SPEED: f32 = 3.0; // m/s
pub const RUN_SPEED: f32 = 9.0; // m/s
pub const CROUCH_SPEED: f32 = 1.6; // m/s
pub const PLAYER_RADIUS: f32 = 0.4; // meters

// Dodge roll: a fixed-length dash simulated identically on client + server.
pub const ROLL_SPEED: f32 = 7.5; // m/s
pub const ROLL_DURATION: f32 = 0.5; // seconds
pub const ROLL_COOLDOWN: f32 = 0.9; // seconds (from roll start)

/// How far a building's storefront ground floor is rendered proud of its
/// footprint lot line, toward the street (-z face). Collision blocks this band
/// so the player disc stops flush with the visual wall instead of clipping into
/// it. Must match `proud` in the client's render/building.ts and the
/// BUILDING_FRONT_PROUD constant in the TS collision mirror.
pub const BUILDING_FRONT_PROUD: f32 = 0.3; // meters

/// Provides walkability lookups in world space (implemented by the world's
/// chunk cache on the server and by streamed chunks on the client).
pub trait CollisionWorld {
    /// Whether the tile containing the world-space point is walkable.
    /// Unloaded chunks should return `false` (treat as solid).
    fn walkable(&self, x: f32, z: f32) -> bool;

    /// Whether a disc of `radius` centered at (x, z) overlaps a solid prop
    /// collider (bike, trash bin, bench, tree, ...). Default: no prop
    /// collision, for tile-only worlds (pathfinding tests, unit tests).
    fn prop_blocked(&self, _x: f32, _z: f32, _radius: f32) -> bool {
        false
    }

    /// Whether a disc of `radius` centered at (x, z) overlaps a building's
    /// storefront front-face buffer (the [`BUILDING_FRONT_PROUD`] band in front
    /// of the footprint lot line). Default: no building buffer, for tile-only
    /// worlds. Building footprint tiles themselves are already handled by
    /// [`CollisionWorld::walkable`].
    fn building_blocked(&self, _x: f32, _z: f32, _radius: f32) -> bool {
        false
    }
}

/// Whether a disc at (cx, cz) with `radius` overlaps the axis-aligned box
/// [minx, maxx] x [minz, maxz] (closest-point test).
pub fn disc_aabb_overlap(
    cx: f32,
    cz: f32,
    radius: f32,
    minx: f32,
    minz: f32,
    maxx: f32,
    maxz: f32,
) -> bool {
    let nx = cx.clamp(minx, maxx);
    let nz = cz.clamp(minz, maxz);
    let dx = cx - nx;
    let dz = cz - nz;
    dx * dx + dz * dz < radius * radius
}

/// Move with axis-separated collision so players slide along walls.
pub fn step_move<W: CollisionWorld>(
    world: &W,
    pos: Vec3,
    dx: f32,
    dz: f32,
    run: bool,
    dt: f32,
) -> Vec3 {
    let speed = if run { RUN_SPEED } else { WALK_SPEED };
    step_move_speed(world, pos, dx, dz, speed, dt)
}

/// Like [`step_move`] but with an explicit speed (crouch, roll dash).
pub fn step_move_speed<W: CollisionWorld>(
    world: &W,
    pos: Vec3,
    dx: f32,
    dz: f32,
    speed: f32,
    dt: f32,
) -> Vec3 {
    let len = (dx * dx + dz * dz).sqrt();
    if len < 1e-5 || dt <= 0.0 {
        return pos;
    }
    // Clamp dt to avoid huge teleports from bad clients.
    let dt = dt.min(0.25);
    let step = speed * dt / len;
    let (mx, mz) = (dx * step, dz * step);

    let mut out = pos;
    let nx = out.x + mx;
    if position_clear(world, nx, out.z) {
        out.x = nx;
    }
    let nz = out.z + mz;
    if position_clear(world, out.x, nz) {
        out.z = nz;
    }
    out
}

/// Displace a character disc by an explicit (dx, dz) offset with the same
/// axis-separated collision rules as [`step_move`]. Used for crowd-separation
/// pushes, where the displacement is a resolved overlap rather than a
/// velocity: blocked axes are simply dropped (the body slides or stays put).
pub fn nudge<W: CollisionWorld>(world: &W, pos: Vec3, dx: f32, dz: f32) -> Vec3 {
    let mut out = pos;
    if dx != 0.0 && position_clear(world, out.x + dx, out.z) {
        out.x += dx;
    }
    if dz != 0.0 && position_clear(world, out.x, out.z + dz) {
        out.z += dz;
    }
    out
}

/// Check the player disc (4 cardinal extents) against the tile grid, then
/// against nearby prop colliders (circle-vs-circle).
pub fn position_clear<W: CollisionWorld>(world: &W, x: f32, z: f32) -> bool {
    world.walkable(x + PLAYER_RADIUS, z)
        && world.walkable(x - PLAYER_RADIUS, z)
        && world.walkable(x, z + PLAYER_RADIUS)
        && world.walkable(x, z - PLAYER_RADIUS)
        && !world.prop_blocked(x, z, PLAYER_RADIUS)
        && !world.building_blocked(x, z, PLAYER_RADIUS)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct OpenWorld;
    impl CollisionWorld for OpenWorld {
        fn walkable(&self, _x: f32, _z: f32) -> bool {
            true
        }
    }

    /// Solid wall for x >= 4.0.
    struct WallWorld;
    impl CollisionWorld for WallWorld {
        fn walkable(&self, x: f32, _z: f32) -> bool {
            x < 4.0
        }
    }

    #[test]
    fn moves_at_speed() {
        let dt = 0.05;
        let p = step_move(&OpenWorld, Vec3::ZERO, 1.0, 0.0, false, dt);
        assert!((p.x - WALK_SPEED * dt).abs() < 1e-4);
    }

    #[test]
    fn blocked_by_wall_but_slides() {
        let start = Vec3::new(3.0, 0.0, 0.0);
        let p = step_move(&WallWorld, start, 1.0, 1.0, true, 0.2);
        // X blocked by the wall (disc radius stops before x=4), Z free.
        assert!(p.x + PLAYER_RADIUS < 4.0 + 1e-3, "x went to {}", p.x);
        assert!(p.z > start.z);
    }

    #[test]
    fn clamps_teleport_dt() {
        let p = step_move(&OpenWorld, Vec3::ZERO, 1.0, 0.0, true, 100.0);
        assert!(p.x <= RUN_SPEED * 0.25 + 1e-4);
    }

    /// Open tiles, but a solid prop (radius 0.5) sits at x = 4.
    struct PropWorld;
    impl CollisionWorld for PropWorld {
        fn walkable(&self, _x: f32, _z: f32) -> bool {
            true
        }
        fn prop_blocked(&self, x: f32, z: f32, radius: f32) -> bool {
            let (dx, dz) = (x - 4.0, z);
            dx * dx + dz * dz < (radius + 0.5) * (radius + 0.5)
        }
    }

    #[test]
    fn blocked_by_prop() {
        let start = Vec3::new(3.0, 0.0, 0.0);
        let p = step_move(&PropWorld, start, 1.0, 0.0, true, 0.2);
        // Player disc (0.4) stops before reaching the prop disc (0.5) at x=4.
        assert!(p.x + PLAYER_RADIUS + 0.5 <= 4.0 + 1e-3, "x went to {}", p.x);
    }

    /// Open tiles, with a building front-face buffer occupying the band
    /// z in [4 - PROUD, 4] (lot line at z=4, storefront wall proud toward -z).
    struct BuildingWorld;
    impl CollisionWorld for BuildingWorld {
        fn walkable(&self, _x: f32, z: f32) -> bool {
            // Footprint tiles start at the lot line (z >= 4).
            z < 4.0
        }
        fn building_blocked(&self, x: f32, z: f32, radius: f32) -> bool {
            disc_aabb_overlap(
                x,
                z,
                radius,
                -10.0,
                4.0 - BUILDING_FRONT_PROUD,
                10.0,
                4.0,
            )
        }
    }

    #[test]
    fn blocked_by_building_front_buffer() {
        // Walking toward +z into the storefront: the disc must stop flush with
        // the proud wall, i.e. its leading edge at the wall (4 - PROUD), not at
        // the lot line (4).
        let start = Vec3::new(0.0, 0.0, 2.0);
        let p = step_move(&BuildingWorld, start, 0.0, 1.0, true, 0.5);
        assert!(
            p.z + PLAYER_RADIUS <= 4.0 - BUILDING_FRONT_PROUD + 1e-3,
            "z went to {} (past the proud wall)",
            p.z
        );
    }

    #[test]
    fn disc_aabb_overlap_basics() {
        // Disc centered away from the box, not touching.
        assert!(!disc_aabb_overlap(0.0, 0.0, 0.4, 1.0, 1.0, 2.0, 2.0));
        // Disc edge crossing into the box.
        assert!(disc_aabb_overlap(0.7, 0.0, 0.4, 1.0, -1.0, 2.0, 1.0));
    }
}
