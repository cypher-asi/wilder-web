//! Inventory manipulation rules (pure logic; the world crate applies results).

use wilder_types::*;

/// Add items to the first available slots, stacking where possible.
/// Returns the number of items that did NOT fit.
pub fn add_items(inv_slots: &mut [Option<ItemStack>], kind: ItemKind, mut count: u32) -> u32 {
    let max = kind.max_stack();
    // Fill existing stacks first.
    for slot in inv_slots.iter_mut() {
        if count == 0 {
            break;
        }
        if let Some(stack) = slot {
            if stack.kind == kind && stack.count < max {
                let take = (max - stack.count).min(count);
                stack.count += take;
                count -= take;
            }
        }
    }
    // Then empty slots.
    for slot in inv_slots.iter_mut() {
        if count == 0 {
            break;
        }
        if slot.is_none() {
            let take = max.min(count);
            *slot = Some(ItemStack { kind, count: take });
            count -= take;
        }
    }
    count
}

/// Count how many of `kind` the slots hold.
pub fn count_items(inv_slots: &[Option<ItemStack>], kind: ItemKind) -> u32 {
    inv_slots
        .iter()
        .filter_map(|s| s.as_ref())
        .filter(|s| s.kind == kind)
        .map(|s| s.count)
        .sum()
}

/// Remove up to `count` of `kind`. Returns how many were actually removed.
pub fn remove_items(inv_slots: &mut [Option<ItemStack>], kind: ItemKind, mut count: u32) -> u32 {
    let wanted = count;
    for slot in inv_slots.iter_mut() {
        if count == 0 {
            break;
        }
        if let Some(stack) = slot {
            if stack.kind == kind {
                let take = stack.count.min(count);
                stack.count -= take;
                count -= take;
                if stack.count == 0 {
                    *slot = None;
                }
            }
        }
    }
    wanted - count
}

/// Swap/merge two slots.
pub fn move_slot(inv_slots: &mut [Option<ItemStack>], from: usize, to: usize) {
    if from == to || from >= inv_slots.len() || to >= inv_slots.len() {
        return;
    }
    let (a, b) = (inv_slots[from], inv_slots[to]);
    match (a, b) {
        (Some(src), Some(mut dst)) if src.kind == dst.kind => {
            let max = dst.kind.max_stack();
            let take = (max - dst.count).min(src.count);
            dst.count += take;
            let rem = src.count - take;
            inv_slots[to] = Some(dst);
            inv_slots[from] = if rem > 0 {
                Some(ItemStack { kind: src.kind, count: rem })
            } else {
                None
            };
        }
        _ => inv_slots.swap(from, to),
    }
}

/// Equip a weapon/armor from a slot; returns false if the item is not equippable.
pub fn equip(inv: &mut Inventory, slot: usize) -> bool {
    let Some(stack) = inv.slots.get(slot).copied().flatten() else {
        return false;
    };
    if stack.kind.is_weapon() {
        let prev = inv.equipped_weapon.take();
        inv.equipped_weapon = Some(stack.kind);
        inv.slots[slot] = prev.map(|kind| ItemStack { kind, count: 1 });
        true
    } else if stack.kind.is_armor() {
        let prev = inv.equipped_armor.take();
        inv.equipped_armor = Some(stack.kind);
        inv.slots[slot] = prev.map(|kind| ItemStack { kind, count: 1 });
        true
    } else {
        false
    }
}

pub fn unequip(inv: &mut Inventory, weapon: bool) -> bool {
    let item = if weapon {
        inv.equipped_weapon.take()
    } else {
        inv.equipped_armor.take()
    };
    let Some(kind) = item else { return false };
    if add_items(&mut inv.slots, kind, 1) > 0 {
        // No space: put it back.
        if weapon {
            inv.equipped_weapon = Some(kind);
        } else {
            inv.equipped_armor = Some(kind);
        }
        return false;
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stacks_then_fills_empty() {
        let mut slots = vec![None; 3];
        assert_eq!(add_items(&mut slots, ItemKind::Iron, 150), 0);
        assert_eq!(slots[0].unwrap().count, 100);
        assert_eq!(slots[1].unwrap().count, 50);
        assert_eq!(add_items(&mut slots, ItemKind::Iron, 100), 0);
        assert_eq!(count_items(&slots, ItemKind::Iron), 250);
        // 3 slots x 100 max = 300 capacity; 60 more only 50 fit.
        assert_eq!(add_items(&mut slots, ItemKind::Iron, 60), 10);
    }

    #[test]
    fn remove_across_stacks() {
        let mut slots = vec![None; 3];
        add_items(&mut slots, ItemKind::Copper, 180);
        assert_eq!(remove_items(&mut slots, ItemKind::Copper, 150), 150);
        assert_eq!(count_items(&slots, ItemKind::Copper), 30);
    }

    #[test]
    fn equip_swaps_previous() {
        let mut inv = Inventory::new();
        inv.slots[0] = Some(ItemStack { kind: ItemKind::Pipe, count: 1 });
        inv.slots[1] = Some(ItemStack { kind: ItemKind::Pistol, count: 1 });
        assert!(equip(&mut inv, 0));
        assert_eq!(inv.equipped_weapon, Some(ItemKind::Pipe));
        assert!(inv.slots[0].is_none());
        assert!(equip(&mut inv, 1));
        assert_eq!(inv.equipped_weapon, Some(ItemKind::Pistol));
        assert_eq!(inv.slots[1].unwrap().kind, ItemKind::Pipe);
    }
}
