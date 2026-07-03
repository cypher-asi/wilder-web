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

/// Check the player disc (4 cardinal extents) against the tile grid, then
/// against nearby prop colliders (circle-vs-circle).
pub fn position_clear<W: CollisionWorld>(world: &W, x: f32, z: f32) -> bool {
    world.walkable(x + PLAYER_RADIUS, z)
        && world.walkable(x - PLAYER_RADIUS, z)
        && world.walkable(x, z + PLAYER_RADIUS)
        && world.walkable(x, z - PLAYER_RADIUS)
        && !world.prop_blocked(x, z, PLAYER_RADIUS)
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
}
