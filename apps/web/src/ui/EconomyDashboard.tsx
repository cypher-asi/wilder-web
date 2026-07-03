// Fullscreen live economy ledger dashboard (K key). Shows aggregate economy
// KPIs, per-item supply counters (minted / burned / circulating), and the
// line-by-line transaction feed streamed from the server ledger.
//
// Opening subscribes to live updates (C2S EconomySub); the server answers
// with a full snapshot (EconomyState) and then pushes per-tick batches
// (EconomyTxs) while the screen stays open.

import { useEffect, useMemo, useState } from "react";
import { GameConnection } from "../net/connection";
import {
  EconTx,
  ItemKind,
  TxAmount,
  TxKind,
  TxParty,
} from "../net/protocol";
import { cameraState } from "../render/CameraRig";
import { useGame } from "../state/game";
import { ITEM_INFO, ItemCategory, ItemIcon, itemLabel } from "./ItemIcon";

// ---------------------------------------------------------------------------
// Labels / colors
// ---------------------------------------------------------------------------

const TX_KIND_LABEL: Record<TxKind, string> = {
  Mint: "MINT",
  Burn: "BURN",
  LootPickup: "LOOT",
  Drop: "DROP",
  VendorBuy: "VENDOR BUY",
  VendorSell: "VENDOR SELL",
  BankConvert: "BANK CONVERT",
  MarketList: "MARKET LIST",
  MarketBuy: "MARKET BUY",
  MarketCancel: "MARKET CANCEL",
  CraftConsume: "CRAFT IN",
  CraftProduce: "CRAFT OUT",
  Fee: "FEE",
  Extract: "EXTRACT",
};

// Cohesive blue / white / red scheme: creation reads light-blue, destruction and
// costs read red, ordinary flows stay mid/deep blue, and passive events fade to
// dim steel. Item-category hues (ECON_CAT_COLOR) are the only multi-hue accents.
const TX_KIND_COLOR: Record<TxKind, string> = {
  Mint: "#9fdcff",
  Burn: "#ff6a7c",
  LootPickup: "#eaf7ff",
  Drop: "#7f8ea0",
  VendorBuy: "#4fc3ff",
  VendorSell: "#4fc3ff",
  BankConvert: "#8fd6ff",
  MarketList: "#4fc3ff",
  MarketBuy: "#4fc3ff",
  MarketCancel: "#7f8ea0",
  CraftConsume: "#cfe4f5",
  CraftProduce: "#cfe4f5",
  Fee: "#e0808f",
  Extract: "#8fd6ff",
};

// Per-category color (dashboard-local so the shared inventory tick palette in
// ItemIcon stays untouched). Each item type reads with one consistent hue across
// the supply panel and the transaction feed's ITEM / AMOUNT column.
const ECON_CAT_COLOR: Record<ItemCategory, string> = {
  weapon: "#5ad1ff",
  armor: "#8fb4ff",
  ammo: "#ffb072",
  consumable: "#ffd75e",
  resource: "#6aa7e8",
  material: "#b79bff",
  gadget: "#7be0c2",
  currency: "#9fe07a",
};

function shortHash(hash: string): string {
  return hash.length > 14 ? `${hash.slice(0, 8)}…${hash.slice(-4)}` : hash;
}

// Compact relative age: seconds -> minutes -> hours -> days, then a short date
// once older than a week (e.g. "Jul 3").
function formatAge(atMs: number, now: number): string {
  const s = Math.max(0, Math.floor((now - atMs) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(atMs).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function Party({ party }: { party: TxParty }) {
  switch (party.t) {
    case "Player":
      return <span className="econ-party econ-party-player">{party.d.name}</span>;
    case "Agent":
      return <span className="econ-party econ-party-agent">{party.d.name}</span>;
    case "Mint":
      return <span className="econ-party econ-party-mint">MINT</span>;
    case "Burn":
      return <span className="econ-party econ-party-burn">BURN</span>;
  }
}

function Amount({ amount }: { amount: TxAmount }) {
  switch (amount.t) {
    case "Item":
      return (
        <span className="econ-amount">
          <i
            className="econ-supply-tick"
            style={{ background: ECON_CAT_COLOR[ITEM_INFO[amount.d.kind].category] }}
          />
          <ItemIcon kind={amount.d.kind} size={14} />
          {amount.d.count} {itemLabel(amount.d.kind)}
        </span>
      );
    case "Wild":
      return <span className="econ-amount econ-amount-wild">{amount.d.amount} WILD</span>;
    case "Shards":
      return <span className="econ-amount econ-amount-shards">{amount.d.amount} SHARDS</span>;
    case "Energy":
      return <span className="econ-amount econ-amount-energy">{amount.d.amount} ENERGY</span>;
    case "Blueprint":
      return <span className="econ-amount econ-amount-bp">BP: {amount.d.recipe}</span>;
  }
}

// ---------------------------------------------------------------------------
// Supply panel
// ---------------------------------------------------------------------------

const CATEGORY_ORDER: (ItemCategory | "all")[] = [
  "all",
  "resource",
  "material",
  "weapon",
  "armor",
  "ammo",
  "consumable",
  "gadget",
  "currency",
];

const CATEGORY_LABEL: Record<ItemCategory | "all", string> = {
  all: "ALL",
  resource: "RESOURCES",
  material: "MATERIALS",
  weapon: "WEAPONS",
  armor: "ARMOR",
  ammo: "AMMO",
  consumable: "CONSUMABLES",
  gadget: "GADGETS",
  currency: "CASH",
};

const ALL_KINDS = Object.keys(ITEM_INFO) as ItemKind[];

function SupplyPanel() {
  const economy = useGame((s) => s.economy);
  const [category, setCategory] = useState<ItemCategory | "all">("all");

  // Every catalog item always shows (zeroes included): the dashboard is the
  // audit surface, so "never issued" is signal too.
  const rows = useMemo(() => {
    const byKind = new Map(economy?.stats.items.map((s) => [s.kind, s]) ?? []);
    return ALL_KINDS.filter(
      (kind) => category === "all" || ITEM_INFO[kind].category === category,
    ).map((kind) => {
      const supply = byKind.get(kind);
      const minted = supply?.minted ?? 0;
      const burned = supply?.burned ?? 0;
      return { kind, minted, burned, circulating: minted - burned };
    });
  }, [economy, category]);

  return (
    <div className="econ-panel econ-supply">
      <div className="econ-panel-title">ITEM SUPPLY</div>
      <div className="econ-tabs">
        {CATEGORY_ORDER.map((c) => (
          <div
            key={c}
            className={`econ-tab ${category === c ? "active" : ""}`}
            onClick={() => setCategory(c)}
          >
            {CATEGORY_LABEL[c]}
          </div>
        ))}
      </div>
      <div className="econ-supply-head econ-supply-row">
        <span>ITEM</span>
        <span className="num">ISSUED</span>
        <span className="num">BURNED</span>
        <span className="num">LIVE</span>
      </div>
      <div className="econ-supply-list">
        {rows.map((r) => (
          <div key={r.kind} className="econ-supply-row">
            <span className="econ-supply-item">
              <i
                className="econ-supply-tick"
                style={{ background: ECON_CAT_COLOR[ITEM_INFO[r.kind].category] }}
              />
              <ItemIcon kind={r.kind} size={18} />
              {itemLabel(r.kind)}
            </span>
            <span className="num">{r.minted.toLocaleString()}</span>
            <span className="num econ-burned">{r.burned.toLocaleString()}</span>
            <span className="num econ-live">{r.circulating.toLocaleString()}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// KPI strip
// ---------------------------------------------------------------------------

function Kpi({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="econ-kpi">
      <div className="econ-kpi-label">{label}</div>
      <div className="econ-kpi-value" style={tone ? { color: tone } : undefined}>
        {value}
      </div>
    </div>
  );
}

function KpiStrip() {
  const economy = useGame((s) => s.economy);
  const s = economy?.stats;
  const n = (v: number | undefined) => (v ?? 0).toLocaleString();
  return (
    <div className="econ-kpis">
      <Kpi label="BLOCK" value={`#${n(s?.block)}`} />
      <Kpi label="TRANSACTIONS" value={n(s?.tx_count)} />
      <Kpi label="WILD CIRCULATING" value={n(s?.wild_circulating)} tone="#8fd6ff" />
      <Kpi label="WILD MINTED" value={n(s?.wild_minted)} tone="#9fdcff" />
      <Kpi label="WILD BURNED" value={n(s?.wild_burned)} tone="#ff6a7c" />
      <Kpi label="VENDOR FLOAT" value={n(s?.wild_agent_held)} />
      <Kpi label="PLAYERS" value={n(s?.players_online)} />
      <Kpi label="AGENTS" value={n(s?.agents_alive)} />
      <Kpi label="AGENT KILLS" value={n(s?.npc_kills)} />
      <Kpi label="PLAYER DEATHS" value={n(s?.deaths)} tone="#ff6a7c" />
      <Kpi label="MARKET TRADES" value={n(s?.trades)} />
      <Kpi label="BLUEPRINTS LEARNED" value={n(s?.blueprints_learned)} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Transaction feed
// ---------------------------------------------------------------------------

// Feed filter mirrors the supply panel's item categories, plus dedicated chips
// for the non-item amount kinds (WILD / Shards / Energy / Blueprint).
type FeedFilter = ItemCategory | "all" | "wild" | "shards" | "energy" | "blueprint";

const FEED_EXTRA: { id: FeedFilter; label: string }[] = [
  { id: "wild", label: "WILD" },
  { id: "shards", label: "SHARDS" },
  { id: "energy", label: "ENERGY" },
  { id: "blueprint", label: "BP" },
];

function matchesFeedFilter(tx: EconTx, f: FeedFilter): boolean {
  if (f === "all") return true;
  const a = tx.amount;
  switch (f) {
    case "wild":
      return a.t === "Wild";
    case "shards":
      return a.t === "Shards";
    case "energy":
      return a.t === "Energy";
    case "blueprint":
      return a.t === "Blueprint";
    default:
      return a.t === "Item" && ITEM_INFO[a.d.kind].category === f;
  }
}

function TxRow({ tx, now }: { tx: EconTx; now: number }) {
  return (
    <div className="econ-row">
      <span className="econ-hash" title={tx.hash}>
        {shortHash(tx.hash)}
      </span>
      <span className="econ-cell">
        <Party party={tx.from} />
      </span>
      <span className="econ-cell">
        <Party party={tx.to} />
      </span>
      <span className="econ-kind" style={{ color: TX_KIND_COLOR[tx.kind] }}>
        {TX_KIND_LABEL[tx.kind]}
      </span>
      <span className="econ-block num">{tx.block}</span>
      <span className="econ-age num" title={new Date(tx.at_ms).toLocaleString()}>
        {formatAge(tx.at_ms, now)}
      </span>
      <span className="econ-cell">
        <Amount amount={tx.amount} />
      </span>
      <span className="econ-fee num">{tx.fee > 0 ? `${tx.fee} WILD` : "—"}</span>
    </div>
  );
}

function TxFeed() {
  const economy = useGame((s) => s.economy);
  const feed = economy?.feed ?? [];
  const [filter, setFilter] = useState<FeedFilter>("all");
  // Tick once a second so on-screen ages count up without new ledger data.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const shown = useMemo(
    () => feed.filter((tx) => matchesFeedFilter(tx, filter)),
    [feed, filter],
  );

  return (
    <div className="econ-panel econ-feed">
      <div className="econ-panel-title">
        TRANSACTION FEED
        <span className="econ-panel-sub">{feed.length > 0 ? "LIVE" : "AWAITING ACTIVITY"}</span>
      </div>
      <div className="econ-tabs">
        {CATEGORY_ORDER.map((c) => (
          <div
            key={c}
            className={`econ-tab ${filter === c ? "active" : ""}`}
            onClick={() => setFilter(c)}
          >
            {CATEGORY_LABEL[c]}
          </div>
        ))}
        {FEED_EXTRA.map((e) => (
          <div
            key={e.id}
            className={`econ-tab ${filter === e.id ? "active" : ""}`}
            onClick={() => setFilter(e.id)}
          >
            {e.label}
          </div>
        ))}
      </div>
      <div className="econ-row econ-head">
        <span>HASH</span>
        <span>FROM</span>
        <span>TO</span>
        <span>TYPE</span>
        <span className="num">BLOCK</span>
        <span className="num">AGE</span>
        <span>ITEM / AMOUNT</span>
        <span className="num">FEE</span>
      </div>
      <div className="econ-feed-list">
        {feed.length === 0 && (
          <div className="econ-empty">No transactions yet — the ledger records every economic event.</div>
        )}
        {feed.length > 0 && shown.length === 0 && (
          <div className="econ-empty">No transactions match this filter.</div>
        )}
        {shown.map((tx) => (
          <TxRow key={tx.seq} tx={tx} now={now} />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dashboard shell
// ---------------------------------------------------------------------------

export function EconomyDashboard({ connection }: { connection: GameConnection }) {
  const open = useGame((s) => s.economyOpen);

  useEffect(() => {
    if (!open) return;
    connection.send({ t: "EconomySub", d: { on: true } });
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      if (e.code === "Escape") {
        // Escape spent on closing the dashboard: don't let the pointer-lock
        // bounce read as an "open game menu" Escape (see CameraRig).
        cameraState.suppressMenuUntil = performance.now() + 1500;
        useGame.getState().set({ economyOpen: false });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      connection.send({ t: "EconomySub", d: { on: false } });
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open, connection]);

  if (!open) return null;

  return (
    <div className="map-overlay econ-overlay">
      <div className="map-overlay-title">ECONOMY LEDGER</div>
      <KpiStrip />
      <div className="econ-body">
        <TxFeed />
        <SupplyPanel />
      </div>
      <div className="econ-footer">
        <span className="invx-keycap">K</span> / <span className="invx-keycap">ESC</span>
        <span className="invx-footer-hint">CLOSE</span>
      </div>
    </div>
  );
}
