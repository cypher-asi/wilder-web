//! A* pathfinding over the world tile grid.
//!
//! Used for click-to-move (server resolves the path, the character follows it)
//! and for NPC movement. Paths are computed on the tile grid (2 m resolution)
//! and followed with waypoint steering, which is plenty for street navigation.

use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashMap};

use wilder_physics::CollisionWorld;
use wilder_types::{Vec3, TILE_SIZE};

const MAX_EXPANSIONS: usize = 20_000;

#[derive(Copy, Clone, PartialEq, Eq, Hash, Debug)]
struct Node {
    tx: i32,
    tz: i32,
}

#[derive(Copy, Clone, PartialEq)]
struct Open {
    cost: f32,
    node: Node,
}

impl Eq for Open {}
impl Ord for Open {
    fn cmp(&self, other: &Self) -> Ordering {
        // Min-heap via reversed comparison.
        other
            .cost
            .partial_cmp(&self.cost)
            .unwrap_or(Ordering::Equal)
    }
}
impl PartialOrd for Open {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

fn tile_of(x: f32, z: f32) -> Node {
    Node {
        tx: (x / TILE_SIZE).floor() as i32,
        tz: (z / TILE_SIZE).floor() as i32,
    }
}

fn tile_center(n: Node) -> Vec3 {
    Vec3::new(
        (n.tx as f32 + 0.5) * TILE_SIZE,
        0.0,
        (n.tz as f32 + 0.5) * TILE_SIZE,
    )
}

fn heuristic(a: Node, b: Node) -> f32 {
    let dx = (a.tx - b.tx).abs() as f32;
    let dz = (a.tz - b.tz).abs() as f32;
    // Octile distance.
    let (min, max) = if dx < dz { (dx, dz) } else { (dz, dx) };
    max + 0.41421356 * min
}

/// Find a path of world-space waypoints from `from` to `to`.
/// Returns `None` if the target is unreachable within the search budget.
pub fn find_path<W: CollisionWorld>(world: &W, from: Vec3, to: Vec3) -> Option<Vec<Vec3>> {
    let start = tile_of(from.x, from.z);
    let goal = tile_of(to.x, to.z);
    if start == goal {
        return Some(vec![to]);
    }
    let goal_center = tile_center(goal);
    if !world.walkable(goal_center.x, goal_center.z) {
        return None;
    }

    let walk = |n: Node| {
        let c = tile_center(n);
        world.walkable(c.x, c.z)
    };

    let mut open = BinaryHeap::new();
    let mut came: HashMap<Node, Node> = HashMap::new();
    let mut g: HashMap<Node, f32> = HashMap::new();
    g.insert(start, 0.0);
    open.push(Open { cost: heuristic(start, goal), node: start });

    let mut expansions = 0;
    while let Some(Open { node, .. }) = open.pop() {
        if node == goal {
            // Reconstruct.
            let mut path = vec![to];
            let mut cur = node;
            while cur != start {
                path.push(tile_center(cur));
                cur = came[&cur];
            }
            path.reverse();
            return Some(simplify(path));
        }
        expansions += 1;
        if expansions > MAX_EXPANSIONS {
            return None;
        }

        let g_cur = g[&node];
        for (dx, dz, cost) in NEIGHBORS {
            let next = Node { tx: node.tx + dx, tz: node.tz + dz };
            if !walk(next) {
                continue;
            }
            // No corner cutting on diagonals.
            if *dx != 0 && *dz != 0 {
                let a = Node { tx: node.tx + dx, tz: node.tz };
                let b = Node { tx: node.tx, tz: node.tz + dz };
                if !walk(a) || !walk(b) {
                    continue;
                }
            }
            let ng = g_cur + cost;
            if ng < *g.get(&next).unwrap_or(&f32::INFINITY) {
                g.insert(next, ng);
                came.insert(next, node);
                open.push(Open { cost: ng + heuristic(next, goal), node: next });
            }
        }
    }
    None
}

const NEIGHBORS: &[(i32, i32, f32)] = &[
    (1, 0, 1.0),
    (-1, 0, 1.0),
    (0, 1, 1.0),
    (0, -1, 1.0),
    (1, 1, 1.41421356),
    (1, -1, 1.41421356),
    (-1, 1, 1.41421356),
    (-1, -1, 1.41421356),
];

/// Drop intermediate collinear waypoints to smooth following.
fn simplify(path: Vec<Vec3>) -> Vec<Vec3> {
    if path.len() <= 2 {
        return path;
    }
    let mut out = vec![path[0]];
    for i in 1..path.len() - 1 {
        let a = *out.last().unwrap();
        let b = path[i];
        let c = path[i + 1];
        let ab = (b.x - a.x, b.z - a.z);
        let bc = (c.x - b.x, c.z - b.z);
        let cross = ab.0 * bc.1 - ab.1 * bc.0;
        if cross.abs() > 1e-3 {
            out.push(b);
        }
    }
    out.push(*path.last().unwrap());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Open plane with a solid block from x in [8,16), z in [0,8).
    struct Blocked;
    impl CollisionWorld for Blocked {
        fn walkable(&self, x: f32, z: f32) -> bool {
            !(x >= 8.0 && x < 16.0 && z >= 0.0 && z < 8.0)
        }
    }

    #[test]
    fn straight_line() {
        struct Open2;
        impl CollisionWorld for Open2 {
            fn walkable(&self, _: f32, _: f32) -> bool {
                true
            }
        }
        let p = find_path(&Open2, Vec3::new(1.0, 0.0, 1.0), Vec3::new(21.0, 0.0, 1.0)).unwrap();
        assert!(p.len() >= 1);
        let last = p.last().unwrap();
        assert!((last.x - 21.0).abs() < 0.01);
    }

    #[test]
    fn routes_around_obstacle() {
        let from = Vec3::new(2.0, 0.0, 3.0);
        let to = Vec3::new(20.0, 0.0, 3.0);
        let p = find_path(&Blocked, from, to).unwrap();
        // Path must detour around the block (above z=8 or below z=0).
        assert!(p.iter().any(|w| w.z >= 8.0 || w.z < 0.0));
        // And no waypoint may sit inside the block.
        assert!(p
            .iter()
            .all(|w| !(w.x >= 8.0 && w.x < 16.0 && w.z >= 0.0 && w.z < 8.0)));
    }

    #[test]
    fn unreachable_is_none() {
        struct Sealed;
        impl CollisionWorld for Sealed {
            fn walkable(&self, x: f32, z: f32) -> bool {
                // Only a 1-tile island at origin is walkable.
                (0.0..TILE_SIZE).contains(&x) && (0.0..TILE_SIZE).contains(&z)
            }
        }
        let p = find_path(&Sealed, Vec3::new(1.0, 0.0, 1.0), Vec3::new(50.0, 0.0, 50.0));
        assert!(p.is_none());
    }
}
