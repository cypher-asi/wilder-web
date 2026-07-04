import { FormEvent, useEffect, useRef, useState } from "react";
import { playGlitch } from "../assets/audio";
import { ROLL_COOLDOWN } from "../game/collision";
import { isVendorKind, POI_STYLES } from "../game/poi";
import { RECIPES, RESEARCH_FRAGMENTS, RESEARCH_RESOURCES } from "../game/recipes";
import { GameConnection } from "../net/connection";
import { AbilityKind, ItemKind } from "../net/protocol";
import { cameraState } from "../render/CameraRig";
import { STYLES, VISUAL_STYLE_IDS, type VisualStyleId } from "../render/styles";
import { activeWeaponKind, consumableHotbar, game, useGame } from "../state/game";
import { ChatWindow } from "./ChatWindow";
import { RED_HEX } from "./colors";
import { EconomyDashboard } from "./EconomyDashboard";
import { GameMenu } from "./GameMenu";
import { HoloMap, prefetchHoloMapAssets } from "./HoloMap";
import { InventoryScreen } from "./InventoryScreen";
import { ItemIcon, itemLabel, usedVolume } from "./ItemIcon";
import { Minimap } from "./Minimap";
import { PerfPanel } from "./PerfPanel";

export function Hud({ connection }: { connection: GameConnection }) {
  const connected = useGame((s) => s.connected);
  const joined = useGame((s) => s.joined);
  const inventoryOpen = useGame((s) => s.inventoryOpen);

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
            <PositionReadout />
          </div>
          <div className="comms-panel">
            <div className="comms-controls">
              <StylePicker />
              <MusicToggle />
            </div>
            <ChatWindow connection={connection} />
          </div>
          <ExtractionBar />
          <ExtractHint />
          <PickupFeed />
          <WalletToasts />
          <LevelUpBanner />
          <ActionBar connection={connection} />
          <WeaponDock connection={connection} />
          <BackpackBar />
          {inventoryOpen && <InventoryScreen connection={connection} />}
          <CraftingPanel connection={connection} />
          <MarketPanel connection={connection} />
          <VendorPanel connection={connection} />
          <HoloMap />
          <EconomyDashboard connection={connection} />
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

/** Visual style dropdown: switches the whole render look live. */
function StylePicker() {
  const visualStyle = useGame((s) => s.visualStyle);
  const setVisualStyle = useGame((s) => s.setVisualStyle);
  return (
    <select
      className="style-picker"
      value={visualStyle}
      onChange={(e) => setVisualStyle(e.target.value as VisualStyleId)}
      title="Visual style"
    >
      {VISUAL_STYLE_IDS.map((id) => (
        <option key={id} value={id}>
          {STYLES[id].label}
        </option>
      ))}
    </select>
  );
}

/** Persistent HUD button toggling the main music on/off. */
function MusicToggle() {
  const musicOn = useGame((s) => s.musicOn);
  const setMusicOn = useGame((s) => s.setMusicOn);
  return (
    <button
      className={`music-toggle${musicOn ? " on" : ""}`}
      onClick={() => setMusicOn(!musicOn)}
      title={musicOn ? "Music on — click to mute" : "Music off — click to play"}
    >
      ♪
    </button>
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

/** Currency chips under the vitals: WILD / Shards / Energy balances. */
function CurrencyPanel() {
  const wallet = useGame((s) => s.wallet);
  return (
    <div className="currency-panel">
      <div className="currency-chip wild" title="WILD — soft currency (market, vendors)">
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
        <span className="currency-name">WILD</span>
      </div>
      <div className="currency-chip shards" title="Shards — salvage from destroyed items">
        <svg viewBox="0 0 20 20" width={14} height={14} aria-hidden="true">
          <path d="M10 1.5 L14.5 8 L10 18.5 L5.5 8 Z" fill="currentColor" opacity="0.85" />
          <path d="M10 1.5 L14.5 8 L10 10.5 L5.5 8 Z" fill="currentColor" />
        </svg>
        <span className="currency-value">{(wallet?.shards ?? 0).toLocaleString("en-US")}</span>
        <span className="currency-name">SHARDS</span>
      </div>
      <div className="currency-chip energy" title="Energy — charge from extractions and ammo caches">
        <svg viewBox="0 0 20 20" width={14} height={14} aria-hidden="true">
          <path d="M11.5 1.5 L4.5 11.5 h4 L8 18.5 L15.5 8.5 h-4 Z" fill="currentColor" />
        </svg>
        <span className="currency-value">{(wallet?.energy ?? 0).toLocaleString("en-US")}</span>
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
  const inventoryOpen = useGame((s) => s.inventoryOpen);
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

  const header = (
    <h3>
      {nearStation.kind}
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
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {locked.length === 0 && (
            <div style={{ fontSize: 12, color: "var(--accent)" }}>
              All blueprints researched.
            </div>
          )}
          {locked.map((r) => {
            const canResearch =
              fragments >= RESEARCH_FRAGMENTS &&
              RESEARCH_RESOURCES.every(([k, n]) => count(k) >= n);
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
                title={canResearch ? "Click to research" : "Missing fragments/resources"}
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
          <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 4 }}>QUEUE</div>
          {jobs.map((job, i) => {
            const recipe = RECIPES.find((r) => r.id === job.recipe);
            const seconds = recipe?.seconds ?? 1;
            const head = i === 0;
            // Interpolate the head job's countdown between server updates.
            const elapsed = head && job.powered ? (now - (queueState?.at ?? now)) / 1000 : 0;
            const remaining = Math.max(0, Math.min(job.remaining - elapsed, seconds));
            const unitPct = head ? 1 - remaining / seconds : 0;
            const pct = (job.done + unitPct) / job.count;
            return (
              <div key={job.id} style={{ marginBottom: 6 }}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    fontSize: 11,
                    color: "var(--text)",
                  }}
                >
                  <span>
                    {recipe ? shortName(recipe.output[0]) : job.recipe} {job.done}/{job.count}
                  </span>
                  <span style={{ color: job.powered || !head ? "var(--accent)" : "var(--alert)" }}>
                    {head ? (job.powered ? "POWERED" : "NO POWER — WAITING") : "QUEUED"}
                  </span>
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
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {recipes.map((r) => {
          const known = blueprints.includes(r.id);
          const canQueue = known && r.inputs.every(([kind, n]) => count(kind) >= n);
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
                  : canQueue
                    ? "Queue production"
                    : "Missing inputs"
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
                </div>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                {[1, 5].map((n) => (
                  <div
                    key={n}
                    onClick={() => {
                      if (!canQueue) return;
                      connection.send({
                        t: "QueueProduction",
                        d: { building: nearStation.id, recipe: r.id, count: n },
                      });
                    }}
                    style={{
                      fontSize: 10,
                      color: canQueue ? "var(--accent)" : "var(--text-dim)",
                      border: `1px solid ${canQueue ? "var(--accent-dim)" : "var(--steel-border)"}`,
                      padding: "2px 6px",
                      cursor: canQueue ? "pointer" : "default",
                    }}
                  >
                    x{n}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MarketPanel({ connection }: { connection: GameConnection }) {
  const nearMarket = useGame((s) => s.nearMarket);
  const marketOpen = useGame((s) => s.marketOpen);
  const market = useGame((s) => s.market);
  const inventory = useGame((s) => s.inventory);
  const characterName = useGame((s) => s.characterName);
  const set = useGame((s) => s.set);
  const [listKind, setListKind] = useState<string>("");
  const [listCount, setListCount] = useState("1");
  const [listPrice, setListPrice] = useState("10");

  if (!nearMarket) return null;
  if (!marketOpen) {
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
          set({ marketOpen: true });
          connection.send({ t: "Market", d: { t: "Refresh" } });
        }}
      >
        MARKET — [E] TRADE
      </div>
    );
  }

  // Distinct sellable kinds currently in the inventory.
  const kinds = [
    ...new Set(
      (inventory?.slots ?? []).filter((s) => s !== null).map((s) => s!.kind),
    ),
  ];
  const selectedKind = kinds.includes(listKind as ItemKind) ? listKind : (kinds[0] ?? "");
  const have = invCount(inventory, selectedKind);

  function submitListing(event: FormEvent) {
    event.preventDefault();
    const count = Math.max(1, parseInt(listCount, 10) || 1);
    const price = Math.max(1, parseInt(listPrice, 10) || 1);
    if (!selectedKind) return;
    connection.send({
      t: "Market",
      d: {
        t: "List",
        d: { kind: selectedKind as ItemKind, count, price_each: price },
      },
    });
  }

  return (
    <div className="inventory" style={{ right: "auto", left: 16, maxWidth: 420, bottom: 16, top: "auto" }}>
      <h3>
        Market
        <span style={{ float: "right", cursor: "pointer", color: "var(--text-dim)" }} onClick={() => set({ marketOpen: false })}>
          ✕
        </span>
      </h3>
      <div style={{ fontSize: 12, color: "var(--accent-bright)", marginBottom: 10 }}>
        Wallet: {market?.wallet ?? 0} WILD
      </div>

      <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 4 }}>LISTINGS</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 220, overflowY: "auto", marginBottom: 12 }}>
        {(market?.listings ?? []).length === 0 && (
          <div style={{ fontSize: 11, color: "var(--text-dim)" }}>No listings.</div>
        )}
        {(market?.listings ?? []).map((l) => {
          const mine = l.seller === characterName;
          const cost = l.price_each * l.count;
          const canBuy = (market?.wallet ?? 0) >= cost;
          return (
            <div
              key={l.id}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 8,
                padding: "4px 8px",
                border: "1px solid var(--steel-border)",
                fontSize: 11,
              }}
            >
              <span style={{ color: "var(--text)" }}>
                {shortName(l.kind)} x{l.count}
              </span>
              <span style={{ color: "var(--text-dim)" }}>
                {l.price_each} ea · {mine ? "you" : l.seller}
              </span>
              <span style={{ display: "flex", gap: 8 }}>
                <span
                  style={{
                    color: canBuy ? "var(--accent)" : "var(--text-dim)",
                    cursor: canBuy ? "pointer" : "default",
                  }}
                  onClick={() => {
                    if (!canBuy) return;
                    connection.send({
                      t: "Market",
                      d: { t: "Buy", d: { listing_id: l.id, count: l.count } },
                    });
                  }}
                >
                  BUY {cost}
                </span>
                {mine && (
                  <span
                    style={{ color: "var(--alert)", cursor: "pointer" }}
                    onClick={() =>
                      connection.send({
                        t: "Market",
                        d: { t: "Cancel", d: { listing_id: l.id } },
                      })
                    }
                  >
                    CANCEL
                  </span>
                )}
              </span>
            </div>
          );
        })}
      </div>

      <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 4 }}>
        SELL AN ITEM {selectedKind ? `(${have} held)` : ""}
      </div>
      <form onSubmit={submitListing} style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <select
          value={selectedKind}
          onChange={(e) => setListKind(e.target.value)}
          style={{ background: "#0b121c", color: "var(--text)", border: "1px solid var(--steel-border)", fontSize: 11, padding: "3px 4px", flex: 1 }}
        >
          {kinds.map((k) => (
            <option key={k} value={k}>
              {shortName(k)}
            </option>
          ))}
        </select>
        <input
          value={listCount}
          onChange={(e) => setListCount(e.target.value)}
          style={{ width: 40, background: "#0b121c", color: "var(--text)", border: "1px solid var(--steel-border)", fontSize: 11, padding: "3px 4px" }}
          title="Count"
        />
        <input
          value={listPrice}
          onChange={(e) => setListPrice(e.target.value)}
          style={{ width: 50, background: "#0b121c", color: "var(--text)", border: "1px solid var(--steel-border)", fontSize: 11, padding: "3px 4px" }}
          title="Price each (WILD)"
        />
        <button
          type="submit"
          disabled={!selectedKind}
          style={{ background: "var(--accent-faint)", color: "var(--accent)", border: "1px solid var(--accent-dim)", fontSize: 11, padding: "3px 10px", cursor: "pointer" }}
        >
          LIST
        </button>
      </form>
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
        {label} — {isBank ? "[E] CONVERT CASH" : "[E] TRADE"}
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
    return (
      <div className="inventory" style={{ right: "auto", left: 16, maxWidth: 360 }}>
        {header}
        <div style={{ fontSize: 12, color: "var(--accent-bright)", marginBottom: 6 }}>
          Wallet: {wallet ?? "…"} WILD
        </div>
        <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 10 }}>
          Cash converts 1:1 into WILD minus a 10% handling fee. Whoever holds
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
              → {cash - Math.floor((cash * 10) / 100)} WILD after fee
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
        Wallet: {wallet ?? "…"} WILD
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {offers.length === 0 && (
          <div style={{ fontSize: 11, color: "var(--text-dim)" }}>Nothing on offer.</div>
        )}
        {offers.map((offer) => {
          const held = invCount(inventory, offer.kind);
          const canBuy = offer.buy > 0 && (wallet ?? 0) >= offer.buy;
          const canSell = offer.sell > 0 && held > 0;
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
                  {offer.buy > 0 ? `buy ${offer.buy}` : ""}
                  {offer.buy > 0 && offer.sell > 0 ? " · " : ""}
                  {offer.sell > 0 ? `sell ${offer.sell}` : ""}
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
                    style={{
                      fontSize: 10,
                      color: canSell ? "#ffcc66" : "var(--text-dim)",
                      border: `1px solid ${canSell ? "#8a6d2a" : "var(--steel-border)"}`,
                      padding: "2px 6px",
                      cursor: canSell ? "pointer" : "default",
                    }}
                  >
                    SELL ALL
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

function ExtractionBar() {
  const extracting = useGame((s) => s.extracting);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    if (!extracting) return;
    const timer = setInterval(() => {
      const elapsed = (performance.now() - extracting.startedAt) / 1000;
      setProgress(Math.min(elapsed / extracting.seconds, 1));
    }, 50);
    return () => clearInterval(timer);
  }, [extracting]);

  if (!extracting) return null;
  return (
    <div
      style={{
        position: "absolute",
        top: "38%",
        left: "50%",
        transform: "translateX(-50%)",
        width: 320,
        textAlign: "center",
      }}
    >
      <div
        style={{
          fontSize: 13,
          letterSpacing: "0.25em",
          color: "var(--accent)",
          marginBottom: 8,
          textShadow: "0 0 12px rgba(79,195,255,0.6)",
        }}
      >
        EXTRACTING…
      </div>
      <div className="hp-bar" style={{ height: 10 }}>
        <div
          className="hp-fill"
          style={{
            width: `${progress * 100}%`,
            background: "linear-gradient(90deg, #1f7fc4, var(--accent))",
            transition: "none",
          }}
        />
      </div>
    </div>
  );
}

/** Compass hint to the nearest extraction point while in the hostile zone. */
function ExtractHint() {
  const [hint, setHint] = useState<{ dist: number; dir: string } | null>(null);
  useEffect(() => {
    const timer = setInterval(() => {
      const px = game.predicted.x;
      const pz = game.predicted.z;
      const cx = Math.floor(px / 32);
      const cz = Math.floor(pz / 32);
      const safe = Math.abs(cx) <= 1 && Math.abs(cz) <= 1;
      if (safe) {
        setHint(null);
        return;
      }
      let best: { dist: number; dir: string } | null = null;
      for (const e of game.entities.values()) {
        if (e.kind !== "ExtractionPoint") continue;
        const dx = e.x - px;
        const dz = e.z - pz;
        const dist = Math.hypot(dx, dz);
        if (!best || dist < best.dist) {
          const ns = dz < -3 ? "N" : dz > 3 ? "S" : "";
          const ew = dx > 3 ? "E" : dx < -3 ? "W" : "";
          best = { dist, dir: ns + ew || "HERE" };
        }
      }
      setHint(best);
    }, 500);
    return () => clearInterval(timer);
  }, []);
  if (!hint) return null;
  return (
    <div
      style={{
        position: "absolute",
        top: 96,
        left: "50%",
        transform: "translateX(-50%)",
        fontSize: 12,
        letterSpacing: "0.2em",
        color: "var(--accent)",
        textShadow: "0 0 10px rgba(79,195,255,0.5)",
        pointerEvents: "none",
      }}
    >
      {hint.dist < 4
        ? "◆ EXTRACTION POINT — CLICK IT, THEN STAND STILL"
        : `◆ EXTRACT ${Math.round(hint.dist)}m ${hint.dir}`}
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
      {entry.kind && <ItemIcon kind={entry.kind} size={22} />}
      <span>{entry.text}</span>
    </div>
  );
}

/** Bouncy "+N WILD" coin toasts stacked above the bottom-right dock. */
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
 * Windows-BSOD-inspired death screen: a full-screen blue overlay in a
 * typewriter font that inventories the assets THE GIBSON just seized, shows a
 * fake STOP code, and dismisses on any key (the server already respawned us).
 * The "WILDER GIBSON" title glitches (CSS RGB-split + a JS character scramble
 * on entry) and the screen keeps stuttering the synthesized glitch cue.
 */
function DeathScreen() {
  const death = useGame((s) => s.death);
  const [title, setTitle] = useState(TITLE_TEXT);
  const [shown, setShown] = useState(0);

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
    const timer = setInterval(() => {
      setShown((n) => {
        if (n >= body.length) {
          clearInterval(timer);
          return n;
        }
        return n + 1;
      });
    }, 12);
    return () => clearInterval(timer);
  }, [death?.at]);

  // Keep the screen audibly unstable: re-stutter the glitch cue while it's up.
  useEffect(() => {
    if (!death) return;
    let timeout: number;
    const loop = () => {
      playGlitch(0.28);
      timeout = window.setTimeout(loop, 900 + Math.random() * 1600);
    };
    timeout = window.setTimeout(loop, 900 + Math.random() * 1600);
    return () => window.clearTimeout(timeout);
  }, [death?.at]);

  // Any key / click respawns: first press finishes the typewriter, the next
  // dismisses. Clicking always dismisses so the overlay can't get stuck.
  useEffect(() => {
    if (!death) return;
    const dismiss = () => useGame.getState().set({ death: null });
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (shown < body.length) setShown(body.length);
      else dismiss();
    };
    const onPointer = (e: PointerEvent) => {
      e.preventDefault();
      dismiss();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onPointer, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onPointer, true);
    };
  }, [death, shown, body.length]);

  if (!death) return null;

  const done = shown >= body.length;
  return (
    <div className="bsod" key={death.at}>
      <div className="bsod-inner">
        <div className="bsod-title" data-text={TITLE_TEXT}>
          {title}
        </div>
        <pre className="bsod-body">
          {body.slice(0, shown)}
          {done && <span className="bsod-cursor">_</span>}
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
    "* Press any key to respawn.",
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

const STATION_KINDS = ["Refinery", "Factory", "Laboratory"] as const;

function PositionReadout() {
  const [pos, setPos] = useState({ x: 0, z: 0 });
  useEffect(() => {
    const timer = setInterval(() => {
      setPos({ x: game.predicted.x, z: game.predicted.z });
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
        state.set({
          nearMarket,
          // Leaving the terminal closes the panel.
          ...(nearMarket ? {} : { marketOpen: false }),
        });
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
  const cx = Math.floor(pos.x / 32);
  const cz = Math.floor(pos.z / 32);
  const safe = Math.abs(cx) <= 1 && Math.abs(cz) <= 1;
  return (
    <div className="hud-pos">
      {pos.x.toFixed(1)}, {pos.z.toFixed(1)} · chunk {cx}, {cz} ·{" "}
      <span style={{ color: safe ? "var(--accent)" : "var(--alert)" }}>
        {safe ? "SAFE ZONE" : "HOSTILE"}
      </span>
    </div>
  );
}

function shortName(kind: string): string {
  return kind.replace(/([a-z])([A-Z])/g, "$1 $2").slice(0, 12);
}
