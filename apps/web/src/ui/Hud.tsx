import { FormEvent, useEffect, useState } from "react";
import { ROLL_COOLDOWN } from "../game/collision";
import { RECIPES, RESEARCH_FRAGMENTS, RESEARCH_RESOURCES } from "../game/recipes";
import { GameConnection } from "../net/connection";
import { AbilityKind, ItemKind } from "../net/protocol";
import { STYLES, VISUAL_STYLE_IDS, type VisualStyleId } from "../render/styles";
import { consumableHotbar, game, useGame } from "../state/game";
import { ChatWindow } from "./ChatWindow";
import { HoloMap } from "./HoloMap";
import { Minimap } from "./Minimap";

export function Hud({ connection }: { connection: GameConnection }) {
  const connected = useGame((s) => s.connected);
  const joined = useGame((s) => s.joined);
  const inventoryOpen = useGame((s) => s.inventoryOpen);

  return (
    <div className="hud">
      {!connected && <div className="disconnect-banner">RECONNECTING…</div>}
      {joined && (
        <>
          <VitalsPanel />
          <div className="minimap-panel">
            <Minimap />
            <PositionReadout />
            <StylePicker />
          </div>
          <ExtractionBar />
          <ExtractHint />
          <ActionBar connection={connection} />
          <WeaponDock connection={connection} />
          <BackpackBar />
          <ChatWindow connection={connection} />
          {inventoryOpen && <InventoryPanel connection={connection} />}
          <CraftingPanel connection={connection} />
          <MarketPanel connection={connection} />
          <HoloMap />
        </>
      )}
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

const WEAPON_LABEL: Record<string, string> = {
  Pistol: "PISTOL",
  Smg: "SMG",
  Pipe: "PIPE",
  Knife: "KNIFE",
};
const RANGED_WEAPONS = new Set(["Pistol", "Smg"]);

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
      <div className="vitals-name">
        {characterName}
        <span className="vitals-level">LV {level}</span>
      </div>
      <div className={`vital-bar shield${maxShield === 0 ? " depleted" : ""}`}>
        <div
          className="vital-fill shield"
          style={{ width: `${maxShield > 0 ? (shield / maxShield) * 100 : 0}%` }}
        />
        <span className="vital-num">
          {maxShield > 0 ? `${Math.round(shield)} / ${Math.round(maxShield)}` : "NO SHIELD"}
        </span>
      </div>
      <div className="vital-bar health">
        <div
          className="vital-fill health"
          style={{ width: `${(health / Math.max(maxHealth, 1)) * 100}%` }}
        />
        <span className="vital-num">
          {Math.round(health)} / {Math.round(maxHealth)}
        </span>
      </div>
    </div>
  );
}

const ABILITY_DEF: Record<AbilityKind, { glyph: string; label: string; keybind: string }> = {
  Shockwave: { glyph: "◎", label: "Shockwave — AoE pulse", keybind: "Q" },
  Stim: { glyph: "✚", label: "Stim — heal + speed", keybind: "E" },
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
          keybind={`${i + 1}`}
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

  const weapon = inventory?.equipped_weapon ?? null;
  const label = weapon ? (WEAPON_LABEL[weapon] ?? weapon.toUpperCase()) : "FISTS";
  const ranged = weapon !== null && RANGED_WEAPONS.has(weapon);
  const ammo = invCount(inventory, "Ammo9mm");
  const xpPct = Math.min((xp / Math.max(nextLevelXp, 1)) * 100, 100);

  // Other weapons carried in the backpack (click to equip).
  const carried = (inventory?.slots ?? [])
    .map((stack, slot) => ({ stack, slot }))
    .filter((e) => e.stack && WEAPONS.includes(e.stack.kind))
    .slice(0, 4);

  return (
    <div className="weapon-dock">
      <div className="weapon-dock-main">
        <div className="weapon-dock-slot" title={weapon ?? "Unarmed"}>
          <span className="weapon-dock-glyph">{ranged ? "▙" : "▟"}</span>
        </div>
        <div className="weapon-dock-info">
          <div className="weapon-dock-name">{label}</div>
          {ranged ? (
            <div className={`weapon-dock-ammo${ammo === 0 ? " empty" : ""}`}>
              {ammo}
              <span className="weapon-dock-ammo-label">9MM</span>
            </div>
          ) : (
            <div className="weapon-dock-ammo-label">MELEE</div>
          )}
        </div>
        <div className="weapon-dock-swaps">
          {carried.map(({ stack, slot }) => (
            <div
              key={slot}
              className="weapon-swap-slot"
              title={`Equip ${stack!.kind}`}
              onClick={() =>
                connection.send({ t: "InventoryAction", d: { t: "Equip", d: { slot } } })
              }
            >
              {WEAPON_LABEL[stack!.kind]?.slice(0, 3) ?? stack!.kind.slice(0, 3).toUpperCase()}
            </div>
          ))}
        </div>
      </div>
      <div className="weapon-dock-xp">
        <span className="weapon-dock-level">LVL {level}</span>
        <div className="xp-bar">
          <div className="xp-fill" style={{ width: `${xpPct}%` }} />
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
  const used = slots.filter((s) => s !== null).length;

  return (
    <div className="backpack">
      <div className="backpack-grid" onClick={toggleInventory} title="Open inventory (I)">
        {slots.slice(0, 12).map((slot, i) => (
          <div key={i} className={`backpack-slot${slot ? " filled" : ""}`}>
            {slot && (
              <>
                <span className="backpack-abbrev">{slot.kind.slice(0, 2).toUpperCase()}</span>
                {slot.count > 1 && <span className="inv-count">{slot.count}</span>}
              </>
            )}
          </div>
        ))}
      </div>
      <div
        className={`backpack-btn${inventoryOpen ? " open" : ""}`}
        onClick={toggleInventory}
        title="Open inventory (I)"
      >
        <span className="backpack-btn-glyph">▤</span>
        <span className="backpack-btn-count">
          {used}/{slots.length || 24}
        </span>
        <span className="action-key">I</span>
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
          bottom: 128,
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
        {nearStation.kind.toUpperCase()} — {isLab ? "CLICK TO RESEARCH" : "CLICK TO PRODUCE"}
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
          bottom: 160,
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
        MARKET — CLICK TO TRADE
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

const STATION_KINDS = ["Refinery", "Factory", "Laboratory"] as const;

function PositionReadout() {
  const [pos, setPos] = useState({ x: 0, z: 0 });
  useEffect(() => {
    const timer = setInterval(() => {
      setPos({ x: game.predicted.x, z: game.predicted.z });
      // Track stash/station/market proximity for context UIs.
      let near = false;
      let nearMarket = false;
      let station: { kind: (typeof STATION_KINDS)[number]; id: number } | null = null;
      let stationDist = 3.5;
      for (const entity of game.entities.values()) {
        const d = Math.hypot(entity.x - game.predicted.x, entity.z - game.predicted.z);
        if (entity.kind === "Building" && d < 3.5) {
          near = true;
        }
        if (entity.kind === "MarketTerminal" && d < 3.5) {
          nearMarket = true;
        }
        const kind = entity.kind as (typeof STATION_KINDS)[number];
        if (STATION_KINDS.includes(kind) && d < stationDist) {
          station = { kind, id: entity.id };
          stationDist = d;
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

const WEAPONS = ["Pipe", "Knife", "Pistol", "Smg"];
const ARMOR = ["JacketArmor", "PlateArmor"];

function InventoryPanel({ connection }: { connection: GameConnection }) {
  const inventory = useGame((s) => s.inventory);
  const stash = useGame((s) => s.stash);
  const nearStash = useGame((s) => s.nearStash);
  const [selected, setSelected] = useState<number | null>(null);
  if (!inventory) return null;

  function onSlotClick(index: number) {
    const slot = inventory!.slots[index];
    if (selected === null) {
      if (slot) setSelected(index);
    } else if (selected === index) {
      // Second click on the same slot: contextual action.
      const kind = slot?.kind ?? "";
      if (kind === "Medkit") {
        connection.send({ t: "UseItem", d: { slot: selected } });
      } else if (WEAPONS.includes(kind) || ARMOR.includes(kind)) {
        connection.send({ t: "InventoryAction", d: { t: "Equip", d: { slot: selected } } });
      } else if (nearStash) {
        connection.send({ t: "InventoryAction", d: { t: "Deposit", d: { slot: selected } } });
      }
      setSelected(null);
    } else {
      connection.send({
        t: "InventoryAction",
        d: { t: "MoveSlot", d: { from: selected, to: index } },
      });
      setSelected(null);
    }
  }

  return (
    <div className="inventory">
      <h3>Inventory</h3>
      <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 10 }}>
        Weapon: {inventory.equipped_weapon ?? "—"} · Armor: {inventory.equipped_armor ?? "—"}
      </div>
      <div className="inv-grid">
        {inventory.slots.map((slot, i) => (
          <div
            key={i}
            className="inv-slot"
            style={selected === i ? { borderColor: "var(--accent)", background: "var(--hatch)" } : undefined}
            onClick={() => onSlotClick(i)}
            title={slot ? `${slot.kind} x${slot.count}` : ""}
          >
            {slot && (
              <>
                <span>{shortName(slot.kind)}</span>
                {slot.count > 1 && <span className="inv-count">{slot.count}</span>}
              </>
            )}
          </div>
        ))}
      </div>
      <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 8 }}>
        Click item, click again: equip / use{nearStash ? " / deposit" : ""}. Click two
        slots to move.
      </div>
      {nearStash && stash && (
        <>
          <h3 style={{ marginTop: 16 }}>Stash</h3>
          <div className="inv-grid">
            {stash.map((slot, i) => (
              <div
                key={i}
                className="inv-slot"
                onClick={() => {
                  if (slot) {
                    connection.send({
                      t: "InventoryAction",
                      d: { t: "Withdraw", d: { stash_slot: i } },
                    });
                  }
                }}
                title={slot ? `${slot.kind} x${slot.count} (click to withdraw)` : ""}
              >
                {slot && (
                  <>
                    <span>{shortName(slot.kind)}</span>
                    {slot.count > 1 && <span className="inv-count">{slot.count}</span>}
                  </>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function shortName(kind: string): string {
  return kind.replace(/([a-z])([A-Z])/g, "$1 $2").slice(0, 12);
}
