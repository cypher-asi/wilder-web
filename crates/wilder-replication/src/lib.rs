//! Interest management: which chunks and entities each player should see.

use std::collections::HashSet;

use wilder_types::ChunkCoord;

/// Chunk radius players see around themselves (3 => a 7x7 chunk area, 224 m).
/// Sized so the fully zoomed-out camera (120 m) still sees loaded terrain.
pub const VIEW_RADIUS: i32 = 3;

/// The set of chunk coords within view of a center chunk.
pub fn view_set(center: ChunkCoord) -> HashSet<ChunkCoord> {
    let mut set = HashSet::with_capacity(((VIEW_RADIUS * 2 + 1) * (VIEW_RADIUS * 2 + 1)) as usize);
    for dz in -VIEW_RADIUS..=VIEW_RADIUS {
        for dx in -VIEW_RADIUS..=VIEW_RADIUS {
            set.insert(ChunkCoord::new(center.x + dx, center.z + dz));
        }
    }
    set
}

/// Diff two interest sets: (entered, exited).
pub fn diff_view(
    old: &HashSet<ChunkCoord>,
    new: &HashSet<ChunkCoord>,
) -> (Vec<ChunkCoord>, Vec<ChunkCoord>) {
    let entered = new.difference(old).copied().collect();
    let exited = old.difference(new).copied().collect();
    (entered, exited)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn view_set_size() {
        let set = view_set(ChunkCoord::new(0, 0));
        let side = (VIEW_RADIUS * 2 + 1) as usize;
        assert_eq!(set.len(), side * side);
        assert!(set.contains(&ChunkCoord::new(VIEW_RADIUS, -VIEW_RADIUS)));
        assert!(!set.contains(&ChunkCoord::new(VIEW_RADIUS + 1, 0)));
    }

    #[test]
    fn diff_on_move() {
        let a = view_set(ChunkCoord::new(0, 0));
        let b = view_set(ChunkCoord::new(1, 0));
        let (entered, exited) = diff_view(&a, &b);
        let side = (VIEW_RADIUS * 2 + 1) as usize;
        assert_eq!(entered.len(), side);
        assert_eq!(exited.len(), side);
        assert!(entered.iter().all(|c| c.x == VIEW_RADIUS + 1));
        assert!(exited.iter().all(|c| c.x == -VIEW_RADIUS));
    }
}
