//! Inventory manipulation rules (pure logic; the world crate applies results).

use wilder_types::*;

/// Total volume the occupied entries consume (see `ItemKind::slot_cost`).
/// Capacity is the container's slot count, so bulky items crowd out others.
pub fn used_volume(inv_slots: &[Option<ItemStack>]) -> u32 {
    inv_slots
        .iter()
        .filter_map(|s| s.as_ref())
        .map(|s| s.kind.slot_cost())
        .sum()
}

/// Add items to the first available slots, stacking where possible.
/// Returns the number of items that did NOT fit. Opening a new slot entry
/// requires enough free volume for the kind's slot cost.
pub fn add_items(inv_slots: &mut [Option<ItemStack>], kind: ItemKind, mut count: u32) -> u32 {
    let max = kind.max_stack();
    // Fill existing stacks first (no new volume consumed).
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
    // Then empty slots, while the volume budget allows.
    let cost = kind.slot_cost();
    let capacity = inv_slots.len() as u32;
    let mut volume = used_volume(inv_slots);
    for slot in inv_slots.iter_mut() {
        if count == 0 {
            break;
        }
        if slot.is_none() {
            if volume + cost > capacity {
                break;
            }
            let take = max.min(count);
            *slot = Some(ItemStack { kind, count: take });
            count -= take;
            volume += cost;
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

/// Equip a weapon/armor from a slot; returns false if the item is not
/// equippable. `weapon_slot` picks Weapon 1 (0) or Weapon 2 (1); ignored for
/// armor.
pub fn equip(inv: &mut Inventory, slot: usize, weapon_slot: u8) -> bool {
    let Some(stack) = inv.slots.get(slot).copied().flatten() else {
        return false;
    };
    if stack.kind.is_weapon() {
        let field = if weapon_slot == 1 {
            &mut inv.equipped_weapon2
        } else {
            &mut inv.equipped_weapon
        };
        let prev = field.take();
        *field = Some(stack.kind);
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

/// Unequip a weapon (per `weapon_slot`) or armor back into the backpack.
pub fn unequip(inv: &mut Inventory, weapon: bool, weapon_slot: u8) -> bool {
    let field: &mut Option<ItemKind> = if weapon {
        if weapon_slot == 1 {
            &mut inv.equipped_weapon2
        } else {
            &mut inv.equipped_weapon
        }
    } else {
        &mut inv.equipped_armor
    };
    let Some(kind) = field.take() else { return false };
    if add_items(&mut inv.slots, kind, 1) > 0 {
        // No space: put it back.
        let field: &mut Option<ItemKind> = if weapon {
            if weapon_slot == 1 {
                &mut inv.equipped_weapon2
            } else {
                &mut inv.equipped_weapon
            }
        } else {
            &mut inv.equipped_armor
        };
        *field = Some(kind);
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
        assert!(equip(&mut inv, 0, 0));
        assert_eq!(inv.equipped_weapon, Some(ItemKind::Pipe));
        assert!(inv.slots[0].is_none());
        assert!(equip(&mut inv, 1, 0));
        assert_eq!(inv.equipped_weapon, Some(ItemKind::Pistol));
        assert_eq!(inv.slots[1].unwrap().kind, ItemKind::Pipe);
    }

    #[test]
    fn bulky_items_consume_volume() {
        // 4 slots of capacity; a pistol (cost 4) fills the whole budget.
        let mut slots = vec![None; 4];
        assert_eq!(add_items(&mut slots, ItemKind::Pistol, 1), 0);
        assert_eq!(used_volume(&slots), 4);
        // No volume left: iron can't open a new entry even though 3 array
        // positions are empty.
        assert_eq!(add_items(&mut slots, ItemKind::Iron, 10), 10);
        // But an existing stack can still top up.
        let mut slots = vec![None; 5];
        assert_eq!(add_items(&mut slots, ItemKind::Pistol, 1), 0);
        assert_eq!(add_items(&mut slots, ItemKind::Iron, 100), 0);
        assert_eq!(add_items(&mut slots, ItemKind::Iron, 50), 50);
        assert_eq!(count_items(&slots, ItemKind::Iron), 100);
    }

    #[test]
    fn weapon_slots_are_independent() {
        let mut inv = Inventory::new();
        inv.slots[0] = Some(ItemStack { kind: ItemKind::Pistol, count: 1 });
        inv.slots[1] = Some(ItemStack { kind: ItemKind::Smg, count: 1 });
        assert!(equip(&mut inv, 0, 0));
        assert!(equip(&mut inv, 1, 1));
        assert_eq!(inv.equipped_weapon, Some(ItemKind::Pistol));
        assert_eq!(inv.equipped_weapon2, Some(ItemKind::Smg));
        assert_eq!(inv.active_weapon_kind(), Some(ItemKind::Pistol));
        inv.active_weapon = 1;
        assert_eq!(inv.active_weapon_kind(), Some(ItemKind::Smg));
        // Unequip weapon 2 returns it to the backpack; weapon 1 untouched.
        assert!(unequip(&mut inv, true, 1));
        assert_eq!(inv.equipped_weapon2, None);
        assert_eq!(inv.equipped_weapon, Some(ItemKind::Pistol));
        assert_eq!(count_items(&inv.slots, ItemKind::Smg), 1);
    }
}
