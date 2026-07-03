// Full inventory screen (B / I / Tab): Equipped loadout + Backpack grid, plus
// a Stash panel when standing at any storage terminal. Layout and styling
// follow the reference art: near-black cards, monochrome item silhouettes,
// small category ticks, locked placeholder slots for systems that don't
// exist yet (attachments, clothing, gadgets).

import {
  PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { GameConnection } from "../net/connection";
import { InventoryActionMsg, ItemKind, ItemStack } from "../net/protocol";
import { useGame } from "../state/game";
import { CATEGORY_TICK, ITEM_INFO, ItemIcon, itemLabel } from "./ItemIcon";

const BACKPACK_COLS = 4;

type StashFilter = "all" | "weapons" | "gear";

function matchesFilter(kind: ItemKind, filter: StashFilter, search: string): boolean {
  if (search && !itemLabel(kind).toLowerCase().includes(search.toLowerCase())) {
    return false;
  }
  const cat = ITEM_INFO[kind]?.category;
  if (filter === "weapons") return cat === "weapon" || cat === "ammo";
  if (filter === "gear") return cat === "armor" || cat === "consumable" || cat === "gadget";
  return true;
}

// ---------------------------------------------------------------------------
// Drag & drop (pointer-based, additive to the click interactions).

type DragZone = "backpack" | "stash" | "weapon1" | "weapon2" | "armor";

interface DragOrigin {
  zone: DragZone;
  /** Slot index within backpack/stash; 0 for equip cards. */
  index: number;
}

const DRAG_THRESHOLD_PX = 4;
const GHOST_RETURN_MS = 180;

/** Find the data-drop key under the cursor (slots, equip cards, panels). */
function hitTest(x: number, y: number): string | null {
  const hit = document.elementFromPoint(x, y)?.closest("[data-drop]");
  return hit?.getAttribute("data-drop") ?? null;
}

/** Map the data-drop target under the cursor to the action for this drag.
 * Returns "noop" for valid-but-inert spots (origin slot, own panel
 * background) and null for invalid targets (shows the denied badge). */
function resolveDrop(
  origin: DragOrigin,
  kind: ItemKind,
  target: string | null,
): InventoryActionMsg | "noop" | null {
  if (!target) return null;
  const [zone, arg] = target.split(":");
  const cat = ITEM_INFO[kind]?.category;

  if (origin.zone === "backpack") {
    if (zone === "backpack") {
      const to = Number(arg);
      if (to === origin.index) return "noop";
      return { t: "MoveSlot", d: { from: origin.index, to } };
    }
    if (zone === "backpack-panel") return "noop";
    if (zone === "weapon") {
      if (cat !== "weapon") return null;
      return { t: "Equip", d: { slot: origin.index, weapon_slot: Number(arg) } };
    }
    if (zone === "armor") {
      if (cat !== "armor") return null;
      return { t: "Equip", d: { slot: origin.index } };
    }
    if (zone === "stash" || zone === "stash-panel") {
      return { t: "Deposit", d: { slot: origin.index } };
    }
    return null;
  }

  if (origin.zone === "stash") {
    if (zone === "backpack" || zone === "backpack-panel") {
      return { t: "Withdraw", d: { stash_slot: origin.index } };
    }
    // Stash -> stash isn't a thing; dropping back where it started is inert.
    if (zone === "stash" && Number(arg) === origin.index) return "noop";
    if (zone === "stash-panel") return "noop";
    return null;
  }

  // Equipped card origins: only unequipping into the backpack is valid.
  if (zone === "backpack" || zone === "backpack-panel") {
    if (origin.zone === "armor") return { t: "Unequip", d: { weapon: false } };
    return {
      t: "Unequip",
      d: { weapon: true, weapon_slot: origin.zone === "weapon1" ? 0 : 1 },
    };
  }
  // Hovering the card the drag started from is inert, not "denied".
  if (origin.zone === "weapon1" && target === "weapon:0") return "noop";
  if (origin.zone === "weapon2" && target === "weapon:1") return "noop";
  if (origin.zone === "armor" && target === "armor") return "noop";
  return null;
}

/** Swallow the synthetic click that follows the pointerup ending a drag, so
 * drags don't also trigger select/withdraw/unequip click behavior. */
function suppressNextClick() {
  const stop = (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
  };
  window.addEventListener("click", stop, { capture: true, once: true });
  // The click (if any) fires before timeouts; drop the guard right after.
  window.setTimeout(() => window.removeEventListener("click", stop, { capture: true }), 0);
}

function useInventoryDrag(onDrop: (action: InventoryActionMsg) => void) {
  const [drag, setDrag] = useState<{ kind: ItemKind; origin: DragOrigin } | null>(null);
  const [denied, setDenied] = useState(false);
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const ghostRef = useRef<HTMLDivElement | null>(null);
  const posRef = useRef({ x: 0, y: 0 });
  const cleanupRef = useRef<(() => void) | null>(null);
  const returningRef = useRef(false);

  // Drop the document listeners if the screen unmounts mid-drag.
  useEffect(() => () => cleanupRef.current?.(), []);

  function flyBack(originEl: HTMLElement) {
    setDenied(false);
    setHoverKey(null);
    const ghost = ghostRef.current;
    const rect = originEl.isConnected ? originEl.getBoundingClientRect() : null;
    if (!ghost || !rect) {
      setDrag(null);
      return;
    }
    returningRef.current = true;
    ghost.style.transition = `left ${GHOST_RETURN_MS}ms ease, top ${GHOST_RETURN_MS}ms ease`;
    ghost.style.left = `${rect.left + rect.width / 2}px`;
    ghost.style.top = `${rect.top + rect.height / 2}px`;
    window.setTimeout(() => {
      returningRef.current = false;
      setDrag(null);
    }, GHOST_RETURN_MS + 30);
  }

  /** Pointer-down on a filled slot/card: arms a potential drag. A plain
   * click (release within the threshold) is left for the click handlers. */
  function startDrag(e: ReactPointerEvent, origin: DragOrigin, kind: ItemKind) {
    if (e.button !== 0 || cleanupRef.current || returningRef.current) return;
    const originEl = e.currentTarget as HTMLElement;
    const pointerId = e.pointerId;
    const startX = e.clientX;
    const startY = e.clientY;
    let active = false;

    const finish = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onCancel);
      cleanupRef.current = null;
    };

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      posRef.current = { x: ev.clientX, y: ev.clientY };
      if (!active) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) <= DRAG_THRESHOLD_PX) return;
        active = true;
        setDrag({ kind, origin });
      }
      const ghost = ghostRef.current;
      if (ghost) {
        ghost.style.left = `${ev.clientX}px`;
        ghost.style.top = `${ev.clientY}px`;
      }
      const target = hitTest(ev.clientX, ev.clientY);
      const res = resolveDrop(origin, kind, target);
      setHoverKey(res !== null && res !== "noop" ? target : null);
      setDenied(res === null);
    };

    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      finish();
      if (!active) return; // Never crossed the threshold: it's a click.
      suppressNextClick();
      setHoverKey(null);
      const res = resolveDrop(origin, kind, hitTest(ev.clientX, ev.clientY));
      if (res === null) {
        flyBack(originEl);
      } else {
        if (res !== "noop") onDrop(res);
        setDrag(null);
        setDenied(false);
      }
    };

    const onCancel = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      finish();
      if (active) {
        setDrag(null);
        setDenied(false);
        setHoverKey(null);
      }
    };

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onCancel);
    cleanupRef.current = finish;
  }

  const isOrigin = (zone: DragZone, index = 0) =>
    drag !== null && drag.origin.zone === zone && drag.origin.index === index;

  return { drag, denied, hoverKey, ghostRef, posRef, startDrag, isOrigin };
}

/** One square item card: icon, category tick, count badge. */
function ItemCard({
  stack,
  selected,
  dimmed,
  dragSource,
  dropOk,
  dataDrop,
  onPointerDown,
  onClick,
  onDoubleClick,
  title,
}: {
  stack: ItemStack | null;
  selected?: boolean;
  dimmed?: boolean;
  dragSource?: boolean;
  dropOk?: boolean;
  dataDrop?: string;
  onPointerDown?: (e: ReactPointerEvent) => void;
  onClick?: () => void;
  onDoubleClick?: () => void;
  title?: string;
}) {
  const cat = stack ? ITEM_INFO[stack.kind]?.category : null;
  return (
    <div
      className={
        "invx-slot" +
        (stack ? " filled" : "") +
        (selected ? " selected" : "") +
        (dimmed ? " dimmed" : "") +
        (dragSource ? " drag-source" : "") +
        (dropOk ? " drop-ok" : "")
      }
      data-drop={dataDrop}
      onPointerDown={onPointerDown}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      title={title ?? (stack ? `${itemLabel(stack.kind)} x${stack.count}` : "")}
    >
      {stack && (
        <>
          <span className="invx-tick" style={{ background: cat ? CATEGORY_TICK[cat] : "#888" }} />
          <ItemIcon kind={stack.kind} size={34} />
          <span className="invx-count">x{stack.count}</span>
        </>
      )}
    </div>
  );
}

/** Small placeholder slot for systems that don't exist yet. */
function LockedSlot({ size = "sm" }: { size?: "sm" | "lg" }) {
  return (
    <div className={`invx-slot locked ${size === "lg" ? "invx-lg" : "invx-sm"}`} title="Locked">
      <svg viewBox="0 0 24 24" width={14} height={14} className="invx-lock">
        <rect x="5" y="10" width="14" height="10" rx="2" fill="currentColor" />
        <path d="M8 10 v-3 a4 4 0 0 1 8 0 v3" stroke="currentColor" strokeWidth="2.2" fill="none" />
      </svg>
    </div>
  );
}

/** Large equip card (weapon / equipment) with attachment placeholders. */
function WeaponRow({
  label,
  kind,
  active,
  highlight,
  dragSource,
  dropOk,
  dataDrop,
  onPointerDown,
  onCardClick,
}: {
  label: string;
  kind: ItemKind | null;
  active: boolean;
  highlight: boolean;
  dragSource?: boolean;
  dropOk?: boolean;
  dataDrop?: string;
  onPointerDown?: (e: ReactPointerEvent) => void;
  onCardClick: () => void;
}) {
  return (
    <div className="invx-section">
      <div className="invx-section-label">{label}</div>
      <div className="invx-weapon-row">
        <div
          className={
            "invx-slot invx-weapon-card" +
            (kind ? " filled" : "") +
            (active ? " active" : "") +
            (highlight ? " highlight" : "") +
            (dragSource ? " drag-source" : "") +
            (dropOk ? " drop-ok" : "")
          }
          data-drop={dataDrop}
          onPointerDown={onPointerDown}
          onClick={onCardClick}
          title={
            kind
              ? `${itemLabel(kind)}${active ? " (in hand)" : ""} — click to unequip`
              : highlight
                ? "Equip selected weapon here"
                : "Empty weapon slot"
          }
        >
          {kind && (
            <>
              <ItemIcon kind={kind} size={72} />
              <span className="invx-corner-glyph">
                <ItemIcon kind={kind} size={16} />
              </span>
            </>
          )}
        </div>
        {/* Attachment slots: not a real system yet, rendered as placeholders. */}
        <div className="invx-attach-grid">
          <LockedSlot />
          <LockedSlot />
          <LockedSlot />
          <LockedSlot />
          <LockedSlot />
        </div>
      </div>
    </div>
  );
}

export function InventoryScreen({ connection }: { connection: GameConnection }) {
  const inventory = useGame((s) => s.inventory);
  const stash = useGame((s) => s.stash);
  const nearStash = useGame((s) => s.nearStash);
  const [selected, setSelected] = useState<number | null>(null);
  const [tab, setTab] = useState<"loadout" | "clothing">("loadout");
  const [stashFilter, setStashFilter] = useState<StashFilter>("all");
  const [search, setSearch] = useState("");

  const selectedStack = useMemo(
    () => (selected !== null ? (inventory?.slots[selected] ?? null) : null),
    [inventory, selected],
  );
  const selectedIsWeapon = selectedStack !== null && ITEM_INFO[selectedStack.kind]?.category === "weapon";
  const selectedIsArmor = selectedStack !== null && ITEM_INFO[selectedStack.kind]?.category === "armor";

  const dnd = useInventoryDrag((d) => {
    connection.send({ t: "InventoryAction", d });
    setSelected(null);
  });

  if (!inventory) return null;

  const used = inventory.slots.filter((s) => s !== null).length;
  const stashUsed = (stash ?? []).filter((s) => s !== null).length;
  const showStash = nearStash && stash !== null;

  const send = (d: import("../net/protocol").InventoryActionMsg) =>
    connection.send({ t: "InventoryAction", d });

  /** Click a Weapon 1/2 card: equip the selected backpack weapon into it,
   * otherwise unequip whatever it holds. */
  function onWeaponCard(weaponSlot: number, kind: ItemKind | null) {
    if (selected !== null && selectedIsWeapon) {
      send({ t: "Equip", d: { slot: selected, weapon_slot: weaponSlot } });
      setSelected(null);
    } else if (kind) {
      send({ t: "Unequip", d: { weapon: true, weapon_slot: weaponSlot } });
    }
  }

  function onArmorCard() {
    if (selected !== null && selectedIsArmor) {
      send({ t: "Equip", d: { slot: selected } });
      setSelected(null);
    } else if (inventory!.equipped_armor) {
      send({ t: "Unequip", d: { weapon: false } });
    }
  }

  function onBackpackClick(index: number) {
    const slot = inventory!.slots[index];
    if (selected === null) {
      if (slot) setSelected(index);
    } else if (selected === index) {
      setSelected(null);
    } else {
      send({ t: "MoveSlot", d: { from: selected, to: index } });
      setSelected(null);
    }
  }

  /** Double click: use / equip / deposit, depending on the item + context. */
  function onBackpackDouble(index: number) {
    const slot = inventory!.slots[index];
    if (!slot) return;
    const cat = ITEM_INFO[slot.kind]?.category;
    if (slot.kind === "Medkit") {
      connection.send({ t: "UseItem", d: { slot: index } });
    } else if (cat === "weapon") {
      // First empty weapon slot; both full -> replace the one in hand.
      const ws =
        inventory!.equipped_weapon === null
          ? 0
          : inventory!.equipped_weapon2 === null
            ? 1
            : inventory!.active_weapon;
      send({ t: "Equip", d: { slot: index, weapon_slot: ws } });
    } else if (cat === "armor") {
      send({ t: "Equip", d: { slot: index } });
    } else if (showStash) {
      send({ t: "Deposit", d: { slot: index } });
    }
    setSelected(null);
  }

  return (
    <div className="invx-screen">
      <div className="invx-panels">
        {/* ------------------------------------------------ Equipped panel */}
        <div className="invx-panel invx-equipped">
          <div className="invx-header">
            <h2>Equipped</h2>
          </div>
          <div className="invx-tabs">
            <span
              className={`invx-tab${tab === "loadout" ? " active" : ""}`}
              onClick={() => setTab("loadout")}
            >
              LOADOUT
            </span>
            <span
              className={`invx-tab${tab === "clothing" ? " active" : ""}`}
              onClick={() => setTab("clothing")}
            >
              CLOTHING
            </span>
          </div>

          {tab === "loadout" ? (
            <>
              <WeaponRow
                label="Weapon 1"
                kind={inventory.equipped_weapon}
                active={inventory.active_weapon === 0}
                highlight={selectedIsWeapon}
                dragSource={dnd.isOrigin("weapon1")}
                dropOk={dnd.hoverKey === "weapon:0"}
                dataDrop="weapon:0"
                onPointerDown={
                  inventory.equipped_weapon
                    ? (e) =>
                        dnd.startDrag(e, { zone: "weapon1", index: 0 }, inventory.equipped_weapon!)
                    : undefined
                }
                onCardClick={() => onWeaponCard(0, inventory.equipped_weapon)}
              />
              <WeaponRow
                label="Weapon 2"
                kind={inventory.equipped_weapon2}
                active={inventory.active_weapon === 1}
                highlight={selectedIsWeapon}
                dragSource={dnd.isOrigin("weapon2")}
                dropOk={dnd.hoverKey === "weapon:1"}
                dataDrop="weapon:1"
                onPointerDown={
                  inventory.equipped_weapon2
                    ? (e) =>
                        dnd.startDrag(e, { zone: "weapon2", index: 0 }, inventory.equipped_weapon2!)
                    : undefined
                }
                onCardClick={() => onWeaponCard(1, inventory.equipped_weapon2)}
              />
              <div className="invx-section">
                <div className="invx-section-label">Equipment</div>
                <div className="invx-weapon-row">
                  <div
                    className={
                      "invx-slot invx-equip-card" +
                      (inventory.equipped_armor ? " filled" : "") +
                      (selectedIsArmor ? " highlight" : "") +
                      (dnd.isOrigin("armor") ? " drag-source" : "") +
                      (dnd.hoverKey === "armor" ? " drop-ok" : "")
                    }
                    data-drop="armor"
                    onPointerDown={
                      inventory.equipped_armor
                        ? (e) =>
                            dnd.startDrag(e, { zone: "armor", index: 0 }, inventory.equipped_armor!)
                        : undefined
                    }
                    onClick={onArmorCard}
                    title={
                      inventory.equipped_armor
                        ? `${itemLabel(inventory.equipped_armor)} — click to unequip`
                        : selectedIsArmor
                          ? "Equip selected armor"
                          : "Empty armor slot"
                    }
                  >
                    {inventory.equipped_armor && (
                      <ItemIcon kind={inventory.equipped_armor} size={56} />
                    )}
                  </div>
                  <div className="invx-attach-grid invx-attach-col">
                    <LockedSlot />
                    <LockedSlot />
                  </div>
                </div>
              </div>
            </>
          ) : (
            // Clothing: system doesn't exist yet; whole tab is locked slots.
            <div className="invx-section">
              <div className="invx-section-label">Clothing</div>
              <div className="invx-clothing-grid">
                {Array.from({ length: 6 }, (_, i) => (
                  <LockedSlot key={i} size="lg" />
                ))}
              </div>
            </div>
          )}
        </div>

        {/* ------------------------------------------------ Backpack panel */}
        <div
          className={
            "invx-panel invx-backpack" + (dnd.hoverKey === "backpack-panel" ? " drop-ok" : "")
          }
          data-drop="backpack-panel"
        >
          <div className="invx-header">
            <h2>Backpack</h2>
            <span className="invx-cap">
              {used}/{inventory.slots.length}
            </span>
          </div>
          <div className="invx-grid">
            {inventory.slots.map((slot, i) => (
              <ItemCard
                key={i}
                stack={slot}
                selected={selected === i}
                dragSource={dnd.isOrigin("backpack", i)}
                dropOk={dnd.hoverKey === `backpack:${i}`}
                dataDrop={`backpack:${i}`}
                onPointerDown={
                  slot
                    ? (e) => dnd.startDrag(e, { zone: "backpack", index: i }, slot.kind)
                    : undefined
                }
                onClick={() => onBackpackClick(i)}
                onDoubleClick={() => onBackpackDouble(i)}
                title={
                  slot
                    ? `${itemLabel(slot.kind)} x${slot.count} — double-click to ${
                        slot.kind === "Medkit"
                          ? "use"
                          : ITEM_INFO[slot.kind]?.category === "weapon" ||
                              ITEM_INFO[slot.kind]?.category === "armor"
                            ? "equip"
                            : showStash
                              ? "deposit"
                              : "…"
                      }`
                    : ""
                }
              />
            ))}
          </div>
        </div>

        {/* ------------------------------------------------ Stash panel */}
        {showStash && (
          <div
            className={
              "invx-panel invx-stash" + (dnd.hoverKey === "stash-panel" ? " drop-ok" : "")
            }
            data-drop="stash-panel"
          >
            <div className="invx-header">
              <h2>Stash</h2>
              <span className="invx-cap">
                {stashUsed}/{stash!.length}
              </span>
              <input
                className="invx-search"
                placeholder="Search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <div className="invx-filters">
              {(
                [
                  ["all", "ALL"],
                  ["weapons", "WEAPONS"],
                  ["gear", "GEAR"],
                ] as [StashFilter, string][]
              ).map(([id, label]) => (
                <span
                  key={id}
                  className={`invx-tab${stashFilter === id ? " active" : ""}`}
                  onClick={() => setStashFilter(id)}
                >
                  {label}
                </span>
              ))}
              <span className="invx-tab invx-tab-right" title="Not available yet">
                RARITY
              </span>
            </div>
            <div className="invx-grid invx-stash-grid">
              {stash!.map((slot, i) => {
                const match = !slot || matchesFilter(slot.kind, stashFilter, search);
                return (
                  <ItemCard
                    key={i}
                    stack={slot}
                    dimmed={!match}
                    dragSource={dnd.isOrigin("stash", i)}
                    dropOk={dnd.hoverKey === `stash:${i}`}
                    dataDrop={`stash:${i}`}
                    onPointerDown={
                      slot && match
                        ? (e) => dnd.startDrag(e, { zone: "stash", index: i }, slot.kind)
                        : undefined
                    }
                    onClick={() => {
                      if (slot && match) send({ t: "Withdraw", d: { stash_slot: i } });
                    }}
                    title={slot ? `${itemLabel(slot.kind)} x${slot.count} — click to withdraw` : ""}
                  />
                );
              })}
            </div>
            <div className="invx-pager">
              <span className="invx-pager-arrow">‹</span>
              <span>1/1</span>
              <span className="invx-pager-arrow">›</span>
            </div>
          </div>
        )}
      </div>

      {/* Floating drag ghost: follows the cursor; flies back on invalid drop.
          Positioned imperatively (not via the style prop) so re-renders never
          clobber the pointermove updates or the fly-back transition. */}
      {dnd.drag && (
        <div
          ref={(el) => {
            dnd.ghostRef.current = el;
            if (el && !el.style.left) {
              el.style.left = `${dnd.posRef.current.x}px`;
              el.style.top = `${dnd.posRef.current.y}px`;
            }
          }}
          className="invx-ghost"
        >
          <ItemIcon kind={dnd.drag.kind} size={40} />
          {dnd.denied && (
            <svg className="invx-ghost-denied" viewBox="0 0 24 24" width={22} height={22}>
              <circle cx="12" cy="12" r="9.5" fill="rgba(0,0,0,0.55)" stroke="#ff4d5e" strokeWidth="2.4" />
              <line x1="5.6" y1="5.6" x2="18.4" y2="18.4" stroke="#ff4d5e" strokeWidth="2.4" />
            </svg>
          )}
        </div>
      )}

      <div className="invx-footer">
        <span className="invx-keycap">B</span> : Close Backpack
        {showStash && (
          <span className="invx-footer-hint">
            double-click backpack item : deposit · click stash item : withdraw
          </span>
        )}
      </div>
    </div>
  );
}
