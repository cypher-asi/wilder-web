// Service interaction: which entity kinds are interactable and what panel
// each one opens. Shared by the E-key handler (PlayerInput) and the in-room
// counter click volumes (render/Interior.tsx) so both paths behave the same.

import { EntityKind } from "../net/protocol";
import { game, useGame } from "../state/game";

export const STATION_KINDS = new Set<EntityKind>(["Refinery", "Factory", "Laboratory"]);
export const VENDOR_KINDS = new Set<EntityKind>(["Armory", "Bank", "Bodega", "Dealership"]);
export const INTERACT_KINDS = new Set<EntityKind>([
  "MarketTerminal",
  "Building",
  ...STATION_KINDS,
  ...VENDOR_KINDS,
]);

/**
 * Open (toggle) the panel for a service entity and notify the server. The
 * server validates range itself (within 5 m of the entity or inside its
 * host building's room).
 */
export function openServicePanel(kind: EntityKind, entityId: number): void {
  const ui = useGame.getState();
  if (kind === "MarketTerminal") {
    if (ui.marketOpen) return void ui.set({ marketOpen: false });
    ui.set({ marketOpen: true });
    game.send?.({ t: "Market", d: { t: "Refresh" } });
    return;
  }
  if (STATION_KINDS.has(kind)) {
    if (ui.craftOpen) return void ui.set({ craftOpen: false });
    ui.set({ craftOpen: true });
    game.send?.({ t: "Interact", d: { entity_id: entityId } });
    return;
  }
  if (VENDOR_KINDS.has(kind)) {
    if (ui.vendorOpen) return void ui.set({ vendorOpen: false });
    ui.set({ vendorOpen: true });
    game.send?.({ t: "Interact", d: { entity_id: entityId } });
    return;
  }
  // Plain Building: the stash — open the backpack/inventory screen.
  if (kind === "Building") {
    const willOpen = !ui.inventoryOpen;
    ui.set({ inventoryOpen: willOpen });
    if (willOpen) game.send?.({ t: "Interact", d: { entity_id: entityId } });
  }
}
