import { useEffect, useRef, useState } from "react";
import { playGlitch } from "../assets/audio";
import { ROLL_COOLDOWN } from "../game/collision";
import { openServicePanel } from "../game/interact";
import { interiorRegistry } from "../game/interiors";
import { isVendorKind, POI_STYLES } from "../game/poi";
import { nearestDoor } from "../render/Interior";
import {
  RECIPES,
  RESEARCH_ENERGY,
  RESEARCH_FRAGMENTS,
  RESEARCH_RESOURCES,
  STATION_ENERGY_CAPS,
} from "../game/recipes";
import { allRegions, MY_FACTION, regionOf, territoryControl } from "../game/territory";
import { GameConnection } from "../net/connection";
import { AbilityKind, Currency, ItemKind } from "../net/protocol";
import { cameraState } from "../render/CameraRig";
import { activeWeaponKind, consumableHotbar, game, useGame } from "../state/game";
import { AgentsScreen } from "./AgentsScreen";
import { ChatWindow } from "./ChatWindow";
import { RED_HEX } from "./colors";
import { EconomyDashboard } from "./EconomyDashboard";
import { GameMenu } from "./GameMenu";
import { HoloMap, prefetchHoloMapAssets } from "./HoloMap";
import { InventoryScreen } from "./InventoryScreen";
import { FeedIcon, ItemIcon, itemLabel, usedVolume } from "./ItemIcon";
import { Minimap } from "./Minimap";
import { PerfPanel } from "./PerfPanel";
import { TradeScreen } from "./TradeScreen";

export function Hud({ connection }: { connection: GameConnection }) {
  const connected = useGame((s) => s.connected);
  const joined = useGame((s) => s.joined);

  // Warm the fullscreen map's assets (geo fetch + worker ground bake) once
  // the world has spawned in, so the first M press is instant. Idle-deferred
  // so it never competes with join-time streaming.
  useEffect(() => {
    if (!joined) return;
    if ("requestIdleCallback" in window) {
      const id = requestIdleCallback(() => prefetchHoloMapAssets());
      return () => cancelIdleCallback(id);
    }
    const id = setTimeout(() => prefetchHoloMapAssets(), 1500);
    return () => clearTimeout(id);
  }, [joined]);

  return (
    <div className="hud">
      {!connected && <div className="disconnect-banner">RECONNECTING…</div>}
      {joined && (
        <>
          <Crosshair />
          <VitalsPanel />
          <CurrencyPanel />
          <div className="minimap-panel">
            <Minimap />
            <ZoneReadout />
            <TerritoryTally />
            <ProximityTracker />
          </div>
          <div className="comms-panel">
            <ChatWindow connection={connection} />
          </div>
          <PickupFeed />
          <WalletToasts />
          <LevelUpBanner />
          <ActionBar connection={connection} />
          <WeaponDock connection={connection} />
          <BackpackBar />
          <InventoryScreen connection={connection} />
          <CraftingPanel connection={connection} />
          <MarketPrompt />
          <VendorPanel connection={connection} />
          <TradeScreen connection={connection} />
          <DoorPrompt />
          <HoloMap connection={connection} />
          <EconomyDashboard connection={connection} />
          <AgentsScreen connection={connection} />
          <PerfPanel />
          <DeathScreen />
        </>
      )}
      {/* Outside the joined gate so exit/logout stay reachable mid-reconnect. */}
      <GameMenu />
    </div>
  );
}

/** Custom game pointer (themed arrow) shown when the gun is holstered. */
const POINTER_SVG =
  "<svg xmlns='http://www.w3.org/2000/svg' width='26' height='26' viewBox='0 0 26 26'>" +
  "<path d='M3 2 L3 19 L7.5 14.5 L11 22 L14 20.7 L10.6 13.6 L17 13.6 Z' " +
  "fill='#eafcff' stroke='#0a2730' stroke-width='1.3' stroke-linejoin='round'/></svg>";
const POINTER_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(
  POINTER_SVG,
)}") 3 2, auto`;

/**
 * Aiming crosshair. While the canvas holds pointer lock (mouse-look) it sits
 * fixed at screen center — the only aiming reference, shown whether or not
 * the gun is drawn. Unlocked (UI open / legacy twin-stick fallback) it tracks
 * the raw cursor whenever the gun is drawn. Also owns the page cursor: hidden
 * while the crosshair stands in, a themed pointer arrow otherwise, so there's
 * never a default arrow layered under the reticle.
 */
function Crosshair() {
  const el = useRef<HTMLDivElement>(null);
  const inside = useRef(false);

  useEffect(() => {
    let raf = 0;
    let cursor = "";
    const pos = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    const onMove = (e: PointerEvent) => {
      pos.x = e.clientX;
      pos.y = e.clientY;
      inside.current = true;
    };
    const onLeave = () => (inside.current = false);
    window.addEventListener("pointermove", onMove);
    document.documentElement.addEventListener("pointerleave", onLeave);
    // The crosshair should get out of the way over any interactive HUD widget
    // (minimap, FPS/perf chip, panels, buttons…). The `.hud` root is
    // pointer-events:none while its interactive children opt back in, so any
    // element hit-tested inside `.hud` is a real UI target. The crosshair and
    // reticles are themselves pointer-events:none, so they're skipped here.
    const overUi = () => {
      const hit = document.elementFromPoint(pos.x, pos.y);
      return !!hit && hit.closest(".hud") != null;
    };
    const tick = () => {
      const node = el.current;
      const drawn = game.gun.drawn;
      const locked = cameraState.locked;
      const onUi = !locked && overUi();
      if (node) {
        // Mouse-look pins the crosshair to screen center — it's the only
        // aiming reference, shown whether or not the gun is drawn. Unlocked
        // (UI open / twin-stick fallback) it rides the cursor while aiming.
        const show = locked || (drawn && inside.current && !onUi);
        node.style.opacity = show ? "1" : "0";
        if (show) {
          const x = locked ? window.innerWidth / 2 : pos.x;
          const y = locked ? window.innerHeight / 2 : pos.y;
          node.style.transform = `translate(${x - 16}px, ${y - 16}px)`;
          // Red only when locked onto a live enemy, white otherwise.
          const t =
            game.hoverTargetId != null
              ? game.entities.get(game.hoverTargetId)
              : undefined;
          const onEnemy = !!t && t.healthPct > 0 && t.anim !== "Death";
          node.style.color = onEnemy ? RED_HEX : "#ffffff";
        }
      }
      // Aiming hides the OS cursor (the crosshair stands in for it; pointer
      // lock hides it natively anyway); otherwise a themed pointer replaces
      // the default arrow. Over a UI widget the crosshair is suppressed, so
      // keep the pointer visible there even while aiming so clickable widgets
      // still have a cursor.
      const want = locked || (drawn && !onUi) ? "none" : POINTER_CURSOR;
      if (want !== cursor) {
        cursor = want;
        document.body.style.cursor = want;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onMove);
      document.documentElement.removeEventListener("pointerleave", onLeave);
      document.body.style.cursor = "";
    };
  }, []);

  return (
    <div ref={el} className="crosshair" style={{ opacity: 0, color: "#ffffff" }}>
      <svg viewBox="-16 -16 32 32" width={32} height={32}>
        <g fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">
          <line x1={0} y1={-14} x2={0} y2={-5} />
          <line x1={0} y1={5} x2={0} y2={14} />
          <line x1={-14} y1={0} x2={-5} y2={0} />
          <line x1={5} y1={0} x2={14} y2={0} />
        </g>
        <circle cx={0} cy={0} r={1.4} fill="currentColor" />
      </svg>
    </div>
  );
}

const WEAPON_LABEL: Record<string, string> = {
  Pistol: "PISTOL",
  Smg: "SMG",
  Pipe: "PIPE",
  Knife: "KNIFE",
};
const RANGED_WEAPONS = new Set(["Pistol", "Smg"]);
/** Display-only ammo cap for the dock bar fill (no real magazine system). */
const AMMO_DISPLAY_CAP = 60;

/** Top-middle vitals: shield bar over health bar with numeric overlays. */
function VitalsPanel() {
  const characterName = useGame((s) => s.characterName);
  const health = useGame((s) => s.health);
  const maxHealth = useGame((s) => s.maxHealth);
  const shield = useGame((s) => s.shield);
  const maxShield = useGame((s) => s.maxShield);
  const level = useGame((s) => s.level);

  return (
    <div className="vitals">
      <div className="vitals-top">
        <span className="vitals-badge">{level}</span>
        <span className="vitals-name">{characterName}</span>
      </div>
      <div className="vitals-row">
        <span className="vital-label">:: HP</span>
        <div className="vital-bar health">
          <div
            className="vital-fill health"
            style={{ width: `${(health / Math.max(maxHealth, 1)) * 100}%` }}
          />
        </div>
        <span className="vital-big health">
          {Math.round(health)}
          <span className="vital-max">/{Math.round(maxHealth)}</span>
        </span>
      </div>
      <div className="vitals-row">
        <span className="vital-label">:: SH</span>
        <div className={`vital-bar shield${maxShield === 0 ? " depleted" : ""}`}>
          <div
            className="vital-fill shield"
            style={{ width: `${maxShield > 0 ? (shield / maxShield) * 100 : 0}%` }}
          />
        </div>
        <span className="vital-big shield">
          {maxShield > 0 ? (
            <>
              {Math.round(shield)}
              <span className="vital-max">/{Math.round(maxShield)}</span>
            </>
          ) : (
            "NO SHIELD"
          )}
        </span>
      </div>
    </div>
  );
}

/** A small dim "+N" badge showing the death-safe banked portion of a currency. */
function BankedBadge({ amount }: { amount: number }) {
  if (amount <= 0) return null;
  return (
    <span
      title="Banked — safe from death (withdraw at a Bank)"
      style={{ fontSize: 9, color: "var(--text-dim)", marginLeft: 3 }}
    >
      +{amount.toLocaleString("en-US")}▪
    </span>
  );
}

/** Currency chips under the vitals: MILD / Shards / Energy. The plain value is
 * the at-risk carried amount (lost on death); the dim "+N" badge is banked. */
function CurrencyPanel() {
  const wallet = useGame((s) => s.wallet);
  return (
    <div className="currency-panel">
      <div
        className="currency-chip wild"
        title="MILD — soft currency (market, vendors). Carried MILD is lost on death; bank it to keep it."
      >
        <svg viewBox="0 0 20 20" width={14} height={14} aria-hidden="true">
          <path
            d="M10 1.5 L17.5 6 v8 L10 18.5 L2.5 14 v-8 Z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
          />
          <path
            d="M6 7 l1.5 6 L10 9.5 L12.5 13 L14 7"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span className="currency-value">{(wallet?.wild ?? 0).toLocaleString("en-US")}</span>
        <BankedBadge amount={wallet?.bank ?? 0} />
        <span className="currency-name">MILD</span>
      </div>
      <div
        className="currency-chip shards"
        title="Shards — salvage from destroyed items. Carried Shards are lost on death; bank them to keep them."
      >
        <svg viewBox="0 0 20 20" width={14} height={14} aria-hidden="true">
          <path d="M10 1.5 L14.5 8 L10 18.5 L5.5 8 Z" fill="currentColor" opacity="0.85" />
          <path d="M10 1.5 L14.5 8 L10 10.5 L5.5 8 Z" fill="currentColor" />
        </svg>
        <span className="currency-value">{(wallet?.shards ?? 0).toLocaleString("en-US")}</span>
        <BankedBadge amount={wallet?.bank_shards ?? 0} />
        <span className="currency-name">SHARDS</span>
      </div>
      <div
        className="currency-chip energy"
        title="Energy — charge from extractions and ammo caches. Carried Energy is lost on death; bank it to keep it."
      >
        <svg viewBox="0 0 20 20" width={14} height={14} aria-hidden="true">
          <path d="M11.5 1.5 L4.5 11.5 h4 L8 18.5 L15.5 8.5 h-4 Z" fill="currentColor" />
        </svg>
        <span className="currency-value">{(wallet?.energy ?? 0).toLocaleString("en-US")}</span>
        <BankedBadge amount={wallet?.bank_energy ?? 0} />
        <span className="currency-name">ENERGY</span>
      </div>
    </div>
  );
}

const ABILITY_DEF: Record<AbilityKind, { glyph: string; label: string; keybind: string }> = {
  Shockwave: { glyph: "◎", label: "Shockwave — AoE pulse", keybind: "G" },
  Stim: { glyph: "✚", label: "Stim — heal + speed", keybind: "Q" },
  Overcharge: { glyph: "↯", label: "Overcharge — weapon damage", keybind: "R" },
};

/** Bottom-center action bar: roll + abilities + consumable slots 1-4. */
function ActionBar({ connection }: { connection: GameConnection }) {
  const abilities = useGame((s) => s.abilities);
  const inventory = useGame((s) => s.inventory);
  const [, force] = useState(0);

  // Tick cooldown sweeps (~10 Hz is plenty for a radial wipe).
  useEffect(() => {
    const timer = setInterval(() => force((n) => n + 1), 100);
    return () => clearInterval(timer);
  }, []);

  const now = performance.now();
  const consumables = consumableHotbar(inventory);

  function fireAbility(kind: AbilityKind) {
    if (now < abilities[kind].readyAt) return;
    const seq = game.nextSeq++;
    connection.send({ t: "UseAbility", d: { seq, ability: kind } });
  }

  return (
    <div className="action-bar">
      <ActionSlot
        glyph="↻"
        label="Dodge roll"
        keybind="␣"
        remaining={Math.max(0, game.rollReadyAt - now) / 1000}
        total={ROLL_COOLDOWN}
      />
      {(Object.keys(ABILITY_DEF) as AbilityKind[]).map((kind) => {
        const def = ABILITY_DEF[kind];
        const state = abilities[kind];
        return (
          <ActionSlot
            key={kind}
            glyph={def.glyph}
            label={def.label}
            keybind={def.keybind}
            remaining={Math.max(0, state.readyAt - now) / 1000}
            total={state.cooldown}
            active={state.activeUntil > now}
            onClick={() => fireAbility(kind)}
          />
        );
      })}
      <div className="action-sep" />
      {consumables.map((entry, i) => (
        <ActionSlot
          key={i}
          glyph={entry ? "▣" : ""}
          label={entry ? `${shortName(entry.stack.kind)} x${entry.stack.count}` : "Empty"}
          keybind=""
          remaining={0}
          total={0}
          count={entry?.stack.count}
          empty={!entry}
          onClick={() => {
            if (entry) connection.send({ t: "UseItem", d: { slot: entry.slot } });
          }}
        />
      ))}
    </div>
  );
}

function ActionSlot({
  glyph,
  label,
  keybind,
  remaining,
  total,
  active,
  count,
  empty,
  onClick,
}: {
  glyph: string;
  label: string;
  keybind: string;
  remaining: number;
  total: number;
  active?: boolean;
  count?: number;
  empty?: boolean;
  onClick?: () => void;
}) {
  const sweep = total > 0 ? Math.min(remaining / total, 1) : 0;
  return (
    <div
      className={`action-slot${active ? " active" : ""}${empty ? " empty" : ""}`}
      onClick={onClick}
      title={label}
    >
      <span className="action-glyph">{glyph}</span>
      {count !== undefined && count > 1 && <span className="action-count">{count}</span>}
      {remaining > 0 && (
        <>
          <div
            className="action-cd"
            style={{
              background: `conic-gradient(rgba(5, 9, 15, 0.85) ${sweep * 360}deg, transparent 0deg)`,
            }}
          />
          <span className="action-cd-num">
            {remaining >= 10 ? Math.ceil(remaining) : remaining.toFixed(1)}
          </span>
        </>
      )}
      <span className="action-key">{keybind}</span>
    </div>
  );
}

/** Bottom-left weapon dock: equipped weapon, ammo, swappable weapons, XP. */
function WeaponDock({ connection }: { connection: GameConnection }) {
  const inventory = useGame((s) => s.inventory);
  const level = useGame((s) => s.level);
  const xp = useGame((s) => s.xp);
  const nextLevelXp = useGame((s) => s.nextLevelXp);

  const weapon = activeWeaponKind(inventory);
  const label = weapon ? (WEAPON_LABEL[weapon] ?? weapon.toUpperCase()) : "FISTS";
  const ranged = weapon !== null && RANGED_WEAPONS.has(weapon);
  const ammo = invCount(inventory, "Ammo9mm");
  const ammoPct = Math.min(ammo / AMMO_DISPLAY_CAP, 1) * 100;
  const xpPct = Math.min((xp / Math.max(nextLevelXp, 1)) * 100, 100);

  // The two weapon equip slots mapped to keys 1/2; 0 holsters to fists.
  const weaponSlots: (ItemKind | null)[] = [
    inventory?.equipped_weapon ?? null,
    inventory?.equipped_weapon2 ?? null,
  ];
  const activeSlot = inventory?.active_weapon ?? 0;

  return (
    <div className="weapon-dock">
      <div className="weapon-dock-main">
        <div className="weapon-dock-info">
          <div className="weapon-dock-ammo-tag" title={weapon ?? "Unarmed"}>
            <span className="ammo-chevron">»</span>
            {`:: ${label}`}
          </div>
          {ranged && (
            <div className="weapon-dock-ammo-row">
              <div className="vital-bar ammo">
                <div
                  className={`vital-fill ammo${ammo === 0 ? " empty" : ""}`}
                  style={{ width: `${ammoPct}%` }}
                />
              </div>
              <div className={`weapon-dock-ammo${ammo === 0 ? " empty" : ""}`}>
                {Math.min(ammo, 999)}
                <span className="weapon-dock-ammo-label">/ {AMMO_DISPLAY_CAP}</span>
              </div>
            </div>
          )}
        </div>
        <div className="weapon-dock-swaps">
          {weaponSlots.map((kind, i) => {
            const inHand = kind !== null && activeSlot === i;
            return (
              <div
                key={i}
                className={`weapon-swap-slot${inHand ? " equipped" : ""}`}
                title={
                  kind
                    ? inHand
                      ? `${kind} (in hand)`
                      : `Draw ${kind}  [${i + 1}]`
                    : `Weapon ${i + 1} — empty (equip via inventory)`
                }
                onClick={() => {
                  if (kind && !inHand)
                    connection.send({
                      t: "InventoryAction",
                      d: { t: "SelectWeapon", d: { weapon_slot: i } },
                    });
                }}
              >
                <span className="weapon-swap-key">{i + 1}</span>
                {kind
                  ? (WEAPON_LABEL[kind]?.slice(0, 3) ?? kind.slice(0, 3).toUpperCase())
                  : "—"}
              </div>
            );
          })}
          <div
            className={`weapon-swap-slot${weapon === null ? " equipped" : ""}`}
            title={weapon === null ? "Fists (equipped)" : "Fists / melee  [0]"}
            onClick={() => {
              if (weapon !== null)
                connection.send({
                  t: "InventoryAction",
                  d: { t: "Unequip", d: { weapon: true, weapon_slot: activeSlot } },
                });
            }}
          >
            <span className="weapon-swap-key">0</span>
            FST
          </div>
        </div>
      </div>
      <div className="weapon-dock-xp">
        <span key={level} className="weapon-dock-level badge-pop">
          LVL {level}
        </span>
        <div className="xp-bar">
          <div className="xp-fill" style={{ width: `${xpPct}%` }} />
          <div key={xp} className="xp-flash" />
        </div>
        <span className="weapon-dock-xp-num">
          {xp}/{nextLevelXp}
        </span>
      </div>
    </div>
  );
}

/** Bottom-right backpack: quick-glance grid + button to the full inventory. */
function BackpackBar() {
  const inventory = useGame((s) => s.inventory);
  const inventoryOpen = useGame((s) => s.menuOpen && s.menuTab === "inventory");
  const toggleInventory = useGame((s) => s.toggleInventory);

  const slots = inventory?.slots ?? [];
  const used = usedVolume(slots);

  return (
    <div className="backpack">
      <div className="backpack-grid" onClick={toggleInventory} title="Open backpack (B)">
        {slots.slice(0, 12).map((slot, i) => (
          <div
            key={i}
            className={`backpack-slot${slot ? " filled" : ""}`}
            title={slot ? itemLabel(slot.kind) : undefined}
          >
            {slot && (
              <>
                <ItemIcon kind={slot.kind} size={32} />
                {slot.count > 1 && <span className="inv-count">{slot.count}</span>}
              </>
            )}
          </div>
        ))}
      </div>
      <div
        className={`backpack-btn${inventoryOpen ? " open" : ""}`}
        onClick={toggleInventory}
        title="Open backpack (B)"
      >
        <span className="backpack-btn-glyph">▤</span>
        <span className="backpack-btn-count">
          {used}/{slots.length || 36}
        </span>
        <span className="action-key">B</span>
      </div>
    </div>
  );
}

/** Sum of an item kind across inventory slots. */
function invCount(
  inventory: { slots: ({ kind: string; count: number } | null)[] } | null,
  kind: string,
): number {
  return (inventory?.slots ?? [])
    .filter((s) => s && s.kind === kind)
    .reduce((n, s) => n + s!.count, 0);
}

function CraftingPanel({ connection }: { connection: GameConnection }) {
  const nearStation = useGame((s) => s.nearStation);
  const craftOpen = useGame((s) => s.craftOpen);
  const inventory = useGame((s) => s.inventory);
  const blueprints = useGame((s) => s.blueprints);
  const production = useGame((s) => s.production);
  const wallet = useGame((s) => s.wallet);
  const set = useGame((s) => s.set);
  const [, force] = useState(0);

  // Animate queue progress between (sparse) server updates.
  useEffect(() => {
    if (!craftOpen) return;
    const timer = setInterval(() => force((n) => n + 1), 200);
    return () => clearInterval(timer);
  }, [craftOpen]);

  if (!nearStation) return null;
  const isLab = nearStation.kind === "Laboratory";

  if (!craftOpen) {
    return (
      <div
        style={{
          position: "absolute",
          top: 120,
          left: "50%",
          transform: "translateX(-50%)",
          fontSize: 12,
          letterSpacing: "0.15em",
          color: "var(--accent)",
          textShadow: "0 0 10px rgba(79,195,255,0.5)",
          cursor: "pointer",
          pointerEvents: "auto",
          background: "rgba(9,15,24,0.7)",
          border: "1px solid var(--accent-dim)",
          padding: "6px 14px",
        }}
        onClick={() => {
          set({ craftOpen: true });
          // Ask the server for this station's queue state.
          connection.send({ t: "Interact", d: { entity_id: nearStation.id } });
        }}
      >
        {nearStation.kind.toUpperCase()} — {isLab ? "[E] RESEARCH" : "[E] PRODUCE"}
      </div>
    );
  }

  const count = (kind: string) => invCount(inventory, kind);
  const queueState = production[nearStation.id];
  const jobs = queueState?.jobs ?? [];
  const buffered = queueState?.buffered ?? [];
  const carriedEnergy = wallet?.energy ?? 0;
  const energyCap = queueState?.energyCap || STATION_ENERGY_CAPS[nearStation.kind];
  const energyUsed = queueState?.energyUsed ?? 0;

  const header = (
    <h3>
      {nearStation.kind}
      {!isLab && (
        <span
          style={{ marginLeft: 10, fontSize: 10, color: "var(--accent)", letterSpacing: "0.1em" }}
          title="Building energy throughput: summed Energy of running jobs / cap. Jobs past the cap wait unpowered."
        >
          ⚡ POWER {energyUsed}/{energyCap}
        </span>
      )}
      <span
        style={{ float: "right", cursor: "pointer", color: "var(--text-dim)" }}
        onClick={() => set({ craftOpen: false })}
      >
        ✕
      </span>
    </h3>
  );

  if (isLab) {
    const locked = RECIPES.filter((r) => !blueprints.includes(r.id));
    const fragments = count("BlueprintFragment");
    return (
      <div className="inventory" style={{ right: "auto", left: 16, maxWidth: 360 }}>
        {header}
        <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 10 }}>
          Research unlocks blueprints. Cost per unlock: {RESEARCH_FRAGMENTS}x Blueprint
          Fragment ({fragments} held)
          {RESEARCH_RESOURCES.map(([k, n]) => ` · ${n}x ${shortName(k)}`).join("")}
          {` · ${RESEARCH_ENERGY} Energy (${carriedEnergy} carried)`}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {locked.length === 0 && (
            <div style={{ fontSize: 12, color: "var(--accent)" }}>
              All blueprints researched.
            </div>
          )}
          {locked.map((r) => {
            const missing: string[] = [];
            if (fragments < RESEARCH_FRAGMENTS) missing.push("fragments");
            for (const [k, n] of RESEARCH_RESOURCES) {
              if (count(k) < n) missing.push(shortName(k).toLowerCase());
            }
            if (carriedEnergy < RESEARCH_ENERGY) missing.push("Energy");
            const canResearch = missing.length === 0;
            return (
              <div
                key={r.id}
                onClick={() => {
                  if (!canResearch) return;
                  connection.send({
                    t: "Craft",
                    d: { recipe: `research_${r.id}`, station: nearStation.id },
                  });
                }}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: 10,
                  padding: "6px 8px",
                  border: `1px solid ${canResearch ? "var(--accent-dim)" : "var(--steel-border)"}`,
                  cursor: canResearch ? "pointer" : "default",
                  opacity: canResearch ? 1 : 0.55,
                }}
                title={canResearch ? "Click to research" : `Missing: ${missing.join(", ")}`}
              >
                <div>
                  <div style={{ fontSize: 12, color: "var(--text)" }}>{shortName(r.output[0])}</div>
                  <div style={{ fontSize: 10, color: "var(--text-dim)" }}>
                    {r.station} blueprint
                  </div>
                </div>
                <div style={{ fontSize: 10, color: canResearch ? "var(--accent)" : "var(--text-dim)" }}>
                  {canResearch ? "RESEARCH" : "—"}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  const recipes = RECIPES.filter((r) => r.station === nearStation.kind);
  const now = performance.now();

  return (
    <div className="inventory" style={{ right: "auto", left: 16, maxWidth: 360 }}>
      {header}
      {jobs.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 4 }}>
            QUEUE — SHARED
          </div>
          {jobs.map((job) => {
            const recipe = RECIPES.find((r) => r.id === job.recipe);
            const seconds = recipe?.seconds ?? 1;
            const mine = job.mine ?? true;
            // Interpolate powered jobs' countdowns between server updates.
            const elapsed = job.powered ? (now - (queueState?.at ?? now)) / 1000 : 0;
            const remaining = Math.max(0, Math.min(job.remaining - elapsed, seconds));
            const unitPct = job.powered ? 1 - remaining / seconds : 0;
            const pct = (job.done + unitPct) / job.count;
            const label = recipe ? shortName(recipe.output[0]) : job.recipe;
            return (
              <div key={job.id} style={{ marginBottom: 6, opacity: mine ? 1 : 0.55 }}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: 6,
                    fontSize: 11,
                    color: "var(--text)",
                  }}
                >
                  <span>
                    {mine ? label : `${job.owner || "OTHER"} job — ${label}`} {job.done}/
                    {job.count}
                  </span>
                  <span
                    style={{
                      marginLeft: "auto",
                      color: job.powered ? "var(--accent)" : "var(--alert)",
                    }}
                  >
                    {job.powered ? "POWERED" : "WAITING FOR POWER"}
                  </span>
                  {mine && (
                    <span
                      title="Cancel — refunds inputs + Energy for uncompleted units"
                      style={{ color: "var(--alert)", cursor: "pointer", padding: "0 2px" }}
                      onClick={() =>
                        connection.send({
                          t: "CancelProduction",
                          d: { building: nearStation.id, job_id: job.id },
                        })
                      }
                    >
                      ✕
                    </span>
                  )}
                </div>
                <div className="hp-bar" style={{ height: 6 }}>
                  <div
                    className="hp-fill"
                    style={{
                      width: `${pct * 100}%`,
                      background: job.powered
                        ? "linear-gradient(90deg, #1f7fc4, var(--accent))"
                        : "linear-gradient(90deg, #7a2530, var(--alert))",
                      transition: "none",
                    }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
      {buffered.length > 0 && (
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 10,
            padding: "6px 8px",
            marginBottom: 12,
            border: "1px solid var(--accent-dim)",
          }}
        >
          <div>
            <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 2 }}>
              OUTPUT BUFFER
            </div>
            <div style={{ fontSize: 12, color: "var(--text)" }}>
              {buffered.map((s) => `${s.count}x ${shortName(s.kind)}`).join(" · ")}
            </div>
          </div>
          <div
            title="Collect finished goods into your backpack"
            style={{
              fontSize: 10,
              color: "var(--accent)",
              border: "1px solid var(--accent-dim)",
              padding: "2px 8px",
              cursor: "pointer",
            }}
            onClick={() =>
              connection.send({ t: "CollectProduction", d: { building: nearStation.id } })
            }
          >
            COLLECT
          </div>
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {recipes.map((r) => {
          const known = blueprints.includes(r.id);
          const hasInputs = r.inputs.every(([kind, n]) => count(kind) >= n);
          const hasEnergy = carriedEnergy >= r.energy;
          const canQueue = known && hasInputs && hasEnergy;
          return (
            <div
              key={r.id}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 10,
                padding: "6px 8px",
                border: `1px solid ${canQueue ? "var(--accent-dim)" : "var(--steel-border)"}`,
                opacity: known ? (canQueue ? 1 : 0.7) : 0.4,
              }}
              title={
                !known
                  ? "Blueprint not researched (Laboratory)"
                  : !hasInputs
                    ? "Missing inputs"
                    : !hasEnergy
                      ? `Not enough Energy (${carriedEnergy}/${r.energy} carried)`
                      : "Queue production"
              }
            >
              <div>
                <div style={{ fontSize: 12, color: canQueue ? "var(--text)" : "var(--text-dim)" }}>
                  {shortName(r.output[0])}
                  {r.output[1] > 1 ? ` x${r.output[1]}` : ""}
                  {!known && " 🔒"}
                </div>
                <div style={{ fontSize: 10, color: "var(--text-dim)" }}>
                  {r.inputs
                    .map(([kind, n]) => `${shortName(kind)} ${count(kind)}/${n}`)
                    .join(" · ")}
                  {` · ${r.seconds}s`}
                  <span style={{ color: hasEnergy ? "var(--text-dim)" : "var(--alert)" }}>
                    {` · ⚡${r.energy}/unit`}
                  </span>
                </div>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                {[1, 5].map((n) => {
                  const batchOk =
                    canQueue &&
                    carriedEnergy >= r.energy * n &&
                    r.inputs.every(([kind, c]) => count(kind) >= c * n);
                  return (
                    <div
                      key={n}
                      onClick={() => {
                        if (!batchOk) return;
                        connection.send({
                          t: "QueueProduction",
                          d: { building: nearStation.id, recipe: r.id, count: n },
                        });
                      }}
                      title={
                        batchOk
                          ? `Queue x${n} (${r.energy * n} Energy)`
                          : `Need inputs + ${r.energy * n} Energy for x${n}`
                      }
                      style={{
                        fontSize: 10,
                        color: batchOk ? "var(--accent)" : "var(--text-dim)",
                        border: `1px solid ${batchOk ? "var(--accent-dim)" : "var(--steel-border)"}`,
                        padding: "2px 6px",
                        cursor: batchOk ? "pointer" : "default",
                      }}
                    >
                      x{n}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** "[E] TRADE" chip near a Market Terminal: opens the exchange Trade screen
 * scoped to this terminal's venue (same path as pressing E on it). */
function MarketPrompt() {
  const nearMarket = useGame((s) => s.nearMarket);
  const menuOpen = useGame((s) => s.menuOpen);
  if (!nearMarket || menuOpen) return null;
  return (
    <div
      className="station-prompt"
      onClick={() => {
        // Same resolution as the E key: nearest terminal in interact range.
        let best: number | null = null;
        let bestD = Infinity;
        for (const e of game.entities.values()) {
          if (e.kind !== "MarketTerminal") continue;
          const d = Math.hypot(e.x - game.predicted.x, e.z - game.predicted.z);
          if (d < bestD) {
            bestD = d;
            best = e.id;
          }
        }
        if (best !== null) openServicePanel("MarketTerminal", best);
      }}
    >
      MARKET TERMINAL — [E] TRADE
    </div>
  );
}

/** Shared NPC-vendor panel: Armory/Bodega buy-sell, Bank cash conversion,
 * Dealership stub. Opens from the prompt shown when standing near a vendor. */
function VendorPanel({ connection }: { connection: GameConnection }) {
  const nearVendor = useGame((s) => s.nearVendor);
  const vendorOpen = useGame((s) => s.vendorOpen);
  const vendor = useGame((s) => s.vendor);
  const inventory = useGame((s) => s.inventory);
  const set = useGame((s) => s.set);
  const [bankAmount, setBankAmount] = useState("");
  const [bankCurrency, setBankCurrency] = useState<Currency>("Mild");

  if (!nearVendor) return null;
  const style = POI_STYLES[nearVendor.kind];
  const label = style?.label ?? nearVendor.kind.toUpperCase();
  const isBank = nearVendor.kind === "Bank";
  const isDealership = nearVendor.kind === "Dealership";

  if (isDealership) {
    // No trade flow yet: a static prompt keeps the location legible.
    return (
      <div className="station-prompt" style={{ cursor: "default", color: style?.color }}>
        {label} — VEHICLES COMING SOON
      </div>
    );
  }

  if (!vendorOpen) {
    return (
      <div
        className="station-prompt"
        style={{ color: style?.color }}
        onClick={() => {
          set({ vendorOpen: true });
          // Ask the server for this vendor's offers + wallet.
          connection.send({ t: "Interact", d: { entity_id: nearVendor.id } });
        }}
      >
        {label} — {isBank ? "[E] BANK" : "[E] TRADE"}
      </div>
    );
  }

  const wallet = vendor?.id === nearVendor.id ? vendor.wallet : null;
  const cash = invCount(inventory, "Cash");

  const sendVendor = (action: import("../net/protocol").VendorActionMsg) =>
    connection.send({ t: "Vendor", d: { vendor: nearVendor.id, action } });

  const header = (
    <h3>
      {label}
      <span
        style={{ float: "right", cursor: "pointer", color: "var(--text-dim)" }}
        onClick={() => set({ vendorOpen: false })}
      >
        ✕
      </span>
    </h3>
  );

  if (isBank) {
    const v = vendor?.id === nearVendor.id ? vendor : null;
    const CURRENCIES: { id: Currency; label: string }[] = [
      { id: "Mild", label: "MILD" },
      { id: "Shards", label: "SHARDS" },
      { id: "Energy", label: "ENERGY" },
    ];
    const carried =
      v == null
        ? null
        : bankCurrency === "Mild"
          ? v.wallet
          : bankCurrency === "Shards"
            ? v.shards
            : v.energy;
    const banked =
      v == null
        ? null
        : bankCurrency === "Mild"
          ? v.bank
          : bankCurrency === "Shards"
            ? v.bank_shards
            : v.bank_energy;
    const amt = Math.max(0, Math.floor(Number(bankAmount) || 0));
    const canDeposit = amt > 0 && (carried ?? 0) >= amt;
    const canWithdraw = amt > 0 && (banked ?? 0) >= amt;
    const label = CURRENCIES.find((c) => c.id === bankCurrency)?.label ?? "";
    const actionStyle = (enabled: boolean) => ({
      fontSize: 10,
      textAlign: "center" as const,
      color: enabled ? "var(--accent)" : "var(--text-dim)",
      border: `1px solid ${enabled ? "var(--accent-dim)" : "var(--steel-border)"}`,
      padding: "4px 8px",
      cursor: enabled ? "pointer" : "default",
      flex: 1,
    });
    return (
      <div className="inventory" style={{ right: "auto", left: 16, maxWidth: 360 }}>
        {header}
        <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 8 }}>
          Carried currency is lost when you die — only banked balances are safe.
        </div>
        <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
          {CURRENCIES.map((c) => (
            <div
              key={c.id}
              onClick={() => {
                setBankCurrency(c.id);
                setBankAmount("");
              }}
              style={{
                flex: 1,
                textAlign: "center",
                fontSize: 10,
                padding: "4px 6px",
                cursor: "pointer",
                color: bankCurrency === c.id ? "var(--accent-bright)" : "var(--text-dim)",
                borderBottom: `2px solid ${
                  bankCurrency === c.id ? "var(--accent)" : "transparent"
                }`,
              }}
            >
              {c.label}
            </div>
          ))}
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontSize: 12,
            marginBottom: 8,
          }}
        >
          <span style={{ color: "var(--accent-bright)" }}>
            Carried: {carried ?? "…"} {label}
          </span>
          <span style={{ color: "var(--text)" }}>Vault: {banked ?? "…"}</span>
        </div>
        <input
          type="number"
          min={0}
          value={bankAmount}
          onChange={(e) => setBankAmount(e.target.value)}
          placeholder="amount"
          style={{
            width: "100%",
            boxSizing: "border-box",
            background: "var(--panel-bg, #0a0f14)",
            border: "1px solid var(--steel-border)",
            color: "var(--text)",
            padding: "4px 8px",
            fontSize: 12,
            marginBottom: 6,
          }}
        />
        <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
          <div
            style={actionStyle(canDeposit)}
            onClick={() => {
              if (canDeposit) {
                sendVendor({ t: "Deposit", d: { currency: bankCurrency, amount: amt } });
                setBankAmount("");
              }
            }}
          >
            DEPOSIT
          </div>
          <div
            style={actionStyle(canWithdraw)}
            onClick={() => {
              if (canWithdraw) {
                sendVendor({ t: "Withdraw", d: { currency: bankCurrency, amount: amt } });
                setBankAmount("");
              }
            }}
          >
            WITHDRAW
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
          <div
            style={actionStyle((carried ?? 0) > 0)}
            onClick={() => {
              if ((carried ?? 0) > 0)
                sendVendor({ t: "Deposit", d: { currency: bankCurrency, amount: carried ?? 0 } });
            }}
          >
            DEPOSIT ALL
          </div>
          <div
            style={actionStyle((banked ?? 0) > 0)}
            onClick={() => {
              if ((banked ?? 0) > 0)
                sendVendor({ t: "Withdraw", d: { currency: bankCurrency, amount: banked ?? 0 } });
            }}
          >
            WITHDRAW ALL
          </div>
        </div>
        <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 10 }}>
          Cash converts 1:1 into MILD minus a 10% handling fee. Whoever holds
          this territory takes a cut of every conversion.
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 10,
            padding: "6px 8px",
            border: `1px solid ${cash > 0 ? "var(--accent-dim)" : "var(--steel-border)"}`,
            opacity: cash > 0 ? 1 : 0.55,
          }}
        >
          <div>
            <div style={{ fontSize: 12, color: "var(--text)" }}>Cash x{cash}</div>
            <div style={{ fontSize: 10, color: "var(--text-dim)" }}>
              → {cash - Math.floor((cash * 10) / 100)} MILD after fee
            </div>
          </div>
          <div
            style={{
              fontSize: 10,
              color: cash > 0 ? "var(--accent)" : "var(--text-dim)",
              border: `1px solid ${cash > 0 ? "var(--accent-dim)" : "var(--steel-border)"}`,
              padding: "2px 8px",
              cursor: cash > 0 ? "pointer" : "default",
            }}
            onClick={() => {
              if (cash > 0) sendVendor({ t: "Convert", d: { count: cash } });
            }}
          >
            CONVERT ALL
          </div>
        </div>
      </div>
    );
  }

  const offers = vendor?.id === nearVendor.id ? vendor.offers : [];
  return (
    <div className="inventory" style={{ right: "auto", left: 16, maxWidth: 380 }}>
      {header}
      <div style={{ fontSize: 12, color: "var(--accent-bright)", marginBottom: 10 }}>
        Wallet: {wallet ?? "…"} MILD
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {offers.length === 0 && (
          <div style={{ fontSize: 11, color: "var(--text-dim)" }}>Nothing on offer.</div>
        )}
        {offers.map((offer) => {
          const held = invCount(inventory, offer.kind);
          const canBuy = offer.buy > 0 && offer.stock > 0 && (wallet ?? 0) >= offer.buy;
          // Mirror of wilder-economy VENDOR_STOCK_CAP: full shelves refuse buys.
          const shelfFull = offer.stock >= 200;
          const canSell = offer.sell > 0 && held > 0 && !shelfFull;
          return (
            <div
              key={offer.kind}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 10,
                padding: "6px 8px",
                border: "1px solid var(--steel-border)",
              }}
            >
              <div>
                <div style={{ fontSize: 12, color: "var(--text)" }}>
                  {shortName(offer.kind)}
                </div>
                <div style={{ fontSize: 10, color: "var(--text-dim)" }}>
                  {offer.buy > 0
                    ? offer.stock > 0
                      ? `buy ${offer.buy} · ${offer.stock} in stock`
                      : "sold out"
                    : ""}
                  {offer.buy > 0 && offer.sell > 0 ? " · " : ""}
                  {offer.sell > 0
                    ? shelfFull
                      ? `sell ${offer.sell} · vendor full`
                      : `sell ${offer.sell}`
                    : ""}
                  {offer.buy === 0 && offer.sell > 0 && !shelfFull && offer.stock > 0
                    ? ` · ${offer.stock} on shelf`
                    : ""}
                  {held > 0 ? ` · ${held} held` : ""}
                </div>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                {offer.buy > 0 &&
                  [1, 5].map((n) => (
                    <div
                      key={`b${n}`}
                      onClick={() => {
                        if (canBuy) sendVendor({ t: "Buy", d: { kind: offer.kind, count: n } });
                      }}
                      style={{
                        fontSize: 10,
                        color: canBuy ? "var(--accent)" : "var(--text-dim)",
                        border: `1px solid ${canBuy ? "var(--accent-dim)" : "var(--steel-border)"}`,
                        padding: "2px 6px",
                        cursor: canBuy ? "pointer" : "default",
                      }}
                    >
                      BUY x{n}
                    </div>
                  ))}
                {offer.sell > 0 && (
                  <div
                    onClick={() => {
                      if (canSell) sendVendor({ t: "Sell", d: { kind: offer.kind, count: held } });
                    }}
                    title={shelfFull ? "Vendor shelf is full — sell elsewhere" : undefined}
                    style={{
                      fontSize: 10,
                      color: canSell ? "#ffcc66" : "var(--text-dim)",
                      border: `1px solid ${canSell ? "#8a6d2a" : "var(--steel-border)"}`,
                      padding: "2px 6px",
                      cursor: canSell ? "pointer" : "default",
                    }}
                  >
                    {shelfFull ? "FULL" : "SELL ALL"}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Left-side pickup feed: stacked "+N Item" lines with the item glyph, plus
 * red "Backpack full" denials. Entries slide in and self-expire. */
function PickupFeed() {
  const feed = useGame((s) => s.pickupFeed);
  return (
    <div className="pickup-feed">
      {feed.map((entry) => (
        <PickupFeedLine key={entry.id} entry={entry} />
      ))}
    </div>
  );
}

function PickupFeedLine({
  entry,
}: {
  entry: import("../state/game").PickupFeedEntry;
}) {
  useEffect(() => {
    const timer = setTimeout(
      () => useGame.getState().expirePickup(entry.id),
      2600,
    );
    return () => clearTimeout(timer);
  }, [entry.id]);
  return (
    <div className={`pickup-line${entry.alert ? " alert" : ""}`}>
      {entry.kind ? (
        <ItemIcon kind={entry.kind} size={22} />
      ) : entry.icon ? (
        <FeedIcon kind={entry.icon} size={22} />
      ) : null}
      <span>{entry.text}</span>
    </div>
  );
}

/** Bouncy "+N MILD" coin toasts stacked above the bottom-right dock. */
function WalletToasts() {
  const toasts = useGame((s) => s.walletToasts);
  return (
    <div className="wallet-toasts">
      {toasts.map((t) => (
        <WalletToastLine key={t.id} id={t.id} text={t.text} />
      ))}
    </div>
  );
}

function WalletToastLine({ id, text }: { id: number; text: string }) {
  useEffect(() => {
    const timer = setTimeout(() => useGame.getState().expireWalletToast(id), 1600);
    return () => clearTimeout(timer);
  }, [id]);
  return (
    <div className="wallet-toast">
      <span className="wallet-toast-coin">●</span>
      {text}
    </div>
  );
}

/** Full-width level-up celebration banner: fanfare-timed bounce + sparkles. */
function LevelUpBanner() {
  const levelUp = useGame((s) => s.levelUp);
  const [shown, setShown] = useState<import("../state/game").LevelUpEvent | null>(
    null,
  );
  useEffect(() => {
    if (!levelUp) return;
    setShown(levelUp);
    const timer = setTimeout(() => setShown(null), 2400);
    return () => clearTimeout(timer);
  }, [levelUp?.at]);
  if (!shown) return null;
  return (
    <div className="levelup-banner" key={shown.at}>
      <div className="levelup-star levelup-star-l">✦</div>
      <div className="levelup-text">
        <span className="levelup-title">LEVEL UP</span>
        <span className="levelup-sub">LVL {shown.level}</span>
      </div>
      <div className="levelup-star levelup-star-r">✦</div>
    </div>
  );
}

const TITLE_TEXT = "WILDER GIBSON";
const SCRAMBLE_CHARS = "!<>-_\\/[]{}#%$&*+=?";

/**
 * Windows-BSOD-inspired death screen: a mostly-black overlay laced with blue
 * CCTV scanlines, in a typewriter font that inventories the assets THE GIBSON
 * just seized, shows a fake STOP code, and dismisses on any key (the server
 * already respawned us). The "WILDER GIBSON" title glitches once on entry
 * (CSS RGB-split + a JS character scramble) and the glitch cue plays a single
 * time - subtle, not repetitive.
 */
const RESPAWN_LOCKOUT_MS = 5000;

function DeathScreen() {
  const death = useGame((s) => s.death);
  const [title, setTitle] = useState(TITLE_TEXT);
  const [shown, setShown] = useState(0);
  const [remainingMs, setRemainingMs] = useState(RESPAWN_LOCKOUT_MS);

  // Assemble the BSOD body as one string; the typewriter reveals a prefix.
  const body = death ? buildDeathBody(death) : "";

  // Character scramble on the title for the first ~0.6s, then settle.
  useEffect(() => {
    if (!death) return;
    setTitle(scramble(TITLE_TEXT, 0));
    let frame = 0;
    const frames = 15;
    const timer = setInterval(() => {
      frame++;
      if (frame >= frames) {
        setTitle(TITLE_TEXT);
        clearInterval(timer);
        return;
      }
      setTitle(scramble(TITLE_TEXT, frame / frames));
    }, 40);
    return () => clearInterval(timer);
  }, [death?.at]);

  // Typewriter reveal of the body text.
  useEffect(() => {
    if (!death) return;
    setShown(0);
    const CHARS_PER_TICK = 8;
    const timer = setInterval(() => {
      setShown((n) => {
        if (n >= body.length) {
          clearInterval(timer);
          return n;
        }
        return n + CHARS_PER_TICK;
      });
    }, 8);
    return () => clearInterval(timer);
  }, [death?.at]);

  // Play the glitch cue exactly once on death - subtle, not repetitive.
  useEffect(() => {
    if (!death) return;
    playGlitch(0.28);
  }, [death?.at]);

  // Respawn lockout: a 5s countdown must elapse before any key will reboot us.
  // This prevents a mashed key from instantly skipping the death screen and
  // gives the moment room to land.
  useEffect(() => {
    if (!death) return;
    const start = performance.now();
    setRemainingMs(RESPAWN_LOCKOUT_MS);
    const timer = setInterval(() => {
      const left = Math.max(0, RESPAWN_LOCKOUT_MS - (performance.now() - start));
      setRemainingMs(left);
      if (left <= 0) clearInterval(timer);
    }, 100);
    return () => clearInterval(timer);
  }, [death?.at]);

  // A keyboard key respawns: first press finishes the typewriter, the next
  // dismisses - but only once the lockout countdown has elapsed. Mouse clicks
  // are intentionally ignored so a stray click during combat can't skip the
  // death screen - the player must reboot deliberately.
  useEffect(() => {
    if (!death) return;
    const dismiss = () => useGame.getState().set({ death: null });
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (shown < body.length) setShown(body.length);
      else if (remainingMs <= 0) dismiss();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
    };
  }, [death, shown, body.length, remainingMs]);

  if (!death) return null;

  const done = shown >= body.length;
  const locked = remainingMs > 0;
  const secondsLeft = Math.ceil(remainingMs / 1000);
  return (
    <div className="bsod" key={death.at}>
      <div className="bsod-inner">
        <div className="bsod-title" data-text={TITLE_TEXT}>
          {title}
        </div>
        <pre className="bsod-body">
          {body.slice(0, shown)}
          {done && (
            <>
              {"\n\n"}
              {locked ? (
                <span className="bsod-lockout">
                  {`* Rebooting in ${secondsLeft}\u2026`}
                </span>
              ) : (
                <span className="bsod-ready">* Press any key to respawn.</span>
              )}
              <span className="bsod-cursor">_</span>
            </>
          )}
        </pre>
      </div>
    </div>
  );
}

/** Build the BSOD body text for a death, item inventory included. */
function buildDeathBody(death: import("../state/game").DeathInfo): string {
  const killer = death.by
    ? `The process was terminated by ${death.by}.`
    : "The process was terminated by an unknown hostile.";
  const itemLines =
    death.lostItems.length > 0
      ? death.lostItems.map((s) => `   - ${s.count}x ${itemLabel(s.kind)}`)
      : ["   - (no unsecured assets - equipped gear retained)"];
  return [
    "A fatal exception 0x0000DEAD has occurred in WILDER_GIBSON.",
    killer,
    "",
    "The following assets have been flushed from your local cache",
    "and permanently seized by THE GIBSON:",
    "",
    ...itemLines,
    "",
    death.errorCode,
    "",
    "* If this screen reappears, the extraction network is down.",
  ].join("\n");
}

/**
 * Return `text` with a left-to-right settled prefix (proportional to
 * `progress`) and the remaining characters randomized from the glitch set.
 * Spaces are preserved so the word shape stays legible.
 */
function scramble(text: string, progress: number): string {
  const settled = Math.floor(text.length * progress);
  let out = "";
  for (let i = 0; i < text.length; i++) {
    if (text[i] === " ") out += " ";
    else if (i < settled) out += text[i];
    else out += SCRAMBLE_CHARS[Math.floor(Math.random() * SCRAMBLE_CHARS.length)];
  }
  return out;
}

/**
 * "[E] ENTER <STORE>" chip while standing near a walk-in store doorway from
 * the street. Hidden once inside (the service panels take over there).
 */
function DoorPrompt() {
  const [label, setLabel] = useState<string | null>(null);
  useEffect(() => {
    const timer = setInterval(() => {
      const px = game.predicted.x;
      const pz = game.predicted.z;
      const inside = interiorRegistry.roomAt(px, pz) !== null;
      const door = inside ? null : nearestDoor(px, pz);
      const next = door
        ? (POI_STYLES[door.spec.doors[door.doorIndex].kind]?.label ??
          door.spec.doors[door.doorIndex].kind.toUpperCase())
        : null;
      setLabel((prev) => (prev === next ? prev : next));
    }, 200);
    return () => clearInterval(timer);
  }, []);
  if (!label) return null;
  return (
    <div
      style={{
        position: "absolute",
        top: 160,
        left: "50%",
        transform: "translateX(-50%)",
        fontSize: 12,
        letterSpacing: "0.15em",
        color: "var(--accent)",
        textShadow: "0 0 10px rgba(79,195,255,0.5)",
        background: "rgba(9,15,24,0.7)",
        border: "1px solid var(--accent-dim)",
        padding: "6px 14px",
        pointerEvents: "none",
      }}
    >
      [E] ENTER {label}
    </div>
  );
}

/** Hub combat-ring radius (m); mirror of `HUB_COMBAT_RING_M` in districts.rs. */
const HUB_RING_M = 900;

/**
 * Zone strip under the minimap: the neighborhood the player is standing in
 * plus which faction currently controls the local territory region.
 */
function ZoneReadout() {
  const districts = useGame((s) => s.districts);
  const factions = useGame((s) => s.factions);
  const [state, setState] = useState({ zone: "—", control: 0, safe: false });
  useEffect(() => {
    const read = () => {
      const px = game.predicted.x;
      const pz = game.predicted.z;
      // Zone name: the spawn hub's playfield overrides Voronoi — its nearest
      // district anchor is ~1.5 km away and reads wrong on the ground.
      let zone = "SPAWN HUB";
      if (Math.hypot(px, pz) >= HUB_RING_M) {
        let bestD = Infinity;
        for (const d of districts) {
          const dd = (d.x - px) ** 2 + (d.z - pz) ** 2;
          if (dd < bestD) {
            bestD = dd;
            zone = d.name;
          }
        }
      }
      const [rx, rz] = regionOf(px, pz);
      const control = territoryControl(rx, rz);
      // Same central-chunk safe zone the position readout reports.
      const safe = Math.abs(Math.floor(px / 32)) <= 1 && Math.abs(Math.floor(pz / 32)) <= 1;
      setState((prev) =>
        prev.zone === zone && prev.control === control && prev.safe === safe
          ? prev
          : { zone, control, safe },
      );
    };
    read();
    const timer = setInterval(read, 500);
    return () => clearInterval(timer);
  }, [districts]);
  const faction = factions.find((f) => f.id === state.control);
  const color = state.safe
    ? "var(--accent)"
    : faction
      ? `#${faction.color.toString(16).padStart(6, "0")}`
      : "var(--text-dim)";
  return (
    <div className="hud-zone">
      <span className="hud-zone-name">{state.zone}</span>
      <span className="hud-zone-owner" style={{ color }}>
        {state.safe
          ? "SAFE ZONE"
          : faction
            ? faction.name.toUpperCase()
            : "UNCLAIMED"}
      </span>
    </div>
  );
}

/**
 * Live territory tally under the minimap: how many squares (regions) your
 * faction holds, then a per-faction breakdown sorted by who is holding the
 * most, for an at-a-glance read on who is winning. Counts come from the
 * client-side control cache (`allRegions`), so no menu/subscription needed.
 */
function TerritoryTally() {
  const factions = useGame((s) => s.factions);
  const mine = useGame((s) => s.zonesSecured);
  const [counts, setCounts] = useState<Record<number, number>>({});
  useEffect(() => {
    const read = () => {
      const next: Record<number, number> = {};
      for (const r of allRegions()) next[r.faction] = (next[r.faction] ?? 0) + 1;
      setCounts((prev) => {
        const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
        for (const k of keys) {
          if (prev[Number(k)] !== next[Number(k)]) return next;
        }
        return prev;
      });
    };
    read();
    const timer = setInterval(read, 1000);
    return () => clearInterval(timer);
  }, []);

  const total = Object.values(counts).reduce((a, n) => a + n, 0);
  const rows = Object.entries(counts)
    .map(([id, n]) => ({ id: Number(id), n }))
    .filter((r) => r.n > 0)
    .sort((a, b) => b.n - a.n);

  return (
    <div className="hud-terr">
      {rows.length === 0 ? (
        <div className="hud-terr-empty">No territory held</div>
      ) : (
        <div className="hud-terr-list">
          {rows.map((r) => {
            const faction = factions.find((f) => f.id === r.id);
            const color = faction
              ? `#${faction.color.toString(16).padStart(6, "0")}`
              : "var(--text-dim)";
            const pct = total > 0 ? (r.n / total) * 100 : 0;
            return (
              <div
                key={r.id}
                className={r.id === MY_FACTION ? "hud-terr-row you" : "hud-terr-row"}
              >
                <span className="hud-terr-dot" style={{ background: color }} />
                <span className="hud-terr-name" style={{ color }}>
                  {faction ? faction.name.toUpperCase() : "UNALIGNED"}
                </span>
                <span className="hud-terr-bar">
                  <span
                    className="hud-terr-bar-fill"
                    style={{ width: `${pct}%`, background: color }}
                  />
                </span>
                <span className="hud-terr-count">{r.n}</span>
              </div>
            );
          })}
        </div>
      )}
      <div className="hud-terr-you">
        <span className="hud-terr-label">SECURED BY YOU</span>
        <span className="hud-terr-count">{mine}</span>
      </div>
    </div>
  );
}

const STATION_KINDS = ["Refinery", "Factory", "Laboratory"] as const;

/**
 * Invisible proximity tracker mounted under the minimap. It polls the player's
 * distance to stashes/markets/stations/vendors and flips the matching `near*`
 * game-state flags that drive the context panels. (It formerly also rendered a
 * position/chunk/SAFE-ZONE readout, which duplicated the ZoneReadout above.)
 */
function ProximityTracker() {
  useEffect(() => {
    const timer = setInterval(() => {
      // Track stash/station/market proximity for context UIs. The 5 m range
      // matches the server's interact range for service storefronts; standing
      // inside a service's walk-in room counts as distance 0 (the entity
      // anchor is out on the sidewalk, further than 5 m from the counter).
      const room = interiorRegistry.roomAt(game.predicted.x, game.predicted.z);
      let near = false;
      let nearMarket = false;
      let station: { kind: (typeof STATION_KINDS)[number]; id: number } | null = null;
      let stationDist = 5.0;
      let vendor: { kind: import("../net/protocol").EntityKind; id: number } | null = null;
      let vendorDist = 5.0;
      for (const entity of game.entities.values()) {
        const inRoom = room !== null && room.doors.some((dr) => dr.entity === entity.id);
        const d = inRoom
          ? 0
          : Math.hypot(entity.x - game.predicted.x, entity.z - game.predicted.z);
        if (entity.kind === "Building" && d < 5.0) {
          near = true;
        }
        if (entity.kind === "MarketTerminal" && d < 5.0) {
          nearMarket = true;
        }
        const kind = entity.kind as (typeof STATION_KINDS)[number];
        if (STATION_KINDS.includes(kind) && d < stationDist) {
          station = { kind, id: entity.id };
          stationDist = d;
        }
        if (isVendorKind(entity.kind) && d < vendorDist) {
          vendor = { kind: entity.kind, id: entity.id };
          vendorDist = d;
        }
      }
      const state = useGame.getState();
      if (near !== state.nearStash) {
        state.set({ nearStash: near });
      }
      if (nearMarket !== state.nearMarket) {
        state.set({ nearMarket });
      }
      if ((station?.id ?? null) !== (state.nearStation?.id ?? null)) {
        state.set({
          nearStation: station,
          // Leaving the station closes the panel.
          ...(station ? {} : { craftOpen: false }),
        });
      }
      if ((vendor?.id ?? null) !== (state.nearVendor?.id ?? null)) {
        state.set({
          nearVendor: vendor,
          // Leaving the vendor closes the panel.
          ...(vendor ? {} : { vendorOpen: false }),
        });
      }
    }, 300);
    return () => clearInterval(timer);
  }, []);
  return null;
}

function shortName(kind: string): string {
  return kind.replace(/([a-z])([A-Z])/g, "$1 $2").slice(0, 12);
}
