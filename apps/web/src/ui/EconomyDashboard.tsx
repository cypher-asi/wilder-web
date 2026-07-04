// Fullscreen live economy ledger dashboard (K key). Shows aggregate economy
// KPIs, per-item supply counters (minted / burned / circulating), and the
// line-by-line transaction feed streamed from the server ledger.
//
// Opening subscribes to live updates (C2S EconomySub); the server answers
// with a full snapshot (EconomyState) and then pushes per-tick batches
// (EconomyTxs) while the screen stays open.

import { useEffect, useMemo, useRef, useState } from "react";
import { GameConnection } from "../net/connection";
import {
  Board,
  EconTx,
  FactionId,
  FactionInfo,
  ItemKind,
  MarketFill,
  PriceBucket,
  TxAmount,
  TxKind,
  TxParty,
} from "../net/protocol";
import { cameraState } from "../render/CameraRig";
import { allRegions, MY_FACTION } from "../game/territory";
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
  AgentHire: "AGENT HIRE",
  OwnerShare: "OWNER SHARE",
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
  AgentHire: "#e0808f",
  OwnerShare: "#9fdcff",
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
      return <span className="econ-party econ-party-kernel">GIBSON</span>;
    case "Burn":
      return <span className="econ-party econ-party-kernel">GIBSON</span>;
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
      return <span className="econ-amount econ-amount-wild">{amount.d.amount} MILD</span>;
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

function SupplyPanel({ onSelect }: { onSelect: (kind: ItemKind) => void }) {
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
      <div className="econ-panel-title">
        ITEM SUPPLY
        <span className="econ-panel-sub">CLICK AN ITEM FOR ITS MARKET</span>
      </div>
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
          <div
            key={r.kind}
            className="econ-supply-row econ-supply-row-link"
            role="button"
            onClick={() => onSelect(r.kind)}
            title={`View the ${itemLabel(r.kind)} market`}
          >
            <span className="econ-supply-item">
              <i
                className="econ-supply-tick"
                style={{ background: ECON_CAT_COLOR[ITEM_INFO[r.kind].category] }}
              />
              <ItemIcon kind={r.kind} size={18} />
              {itemLabel(r.kind)}
              <span className="econ-supply-ticker">{ITEM_INFO[r.kind].ticker}</span>
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
      <Kpi label="MILD CIRCULATING" value={n(s?.wild_circulating)} tone="#8fd6ff" />
      <Kpi label="MILD MINTED" value={n(s?.wild_minted)} tone="#9fdcff" />
      <Kpi label="MILD BURNED" value={n(s?.wild_burned)} tone="#ff6a7c" />
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
// for the non-item amount kinds (MILD / Shards / Energy / Blueprint).
type FeedFilter = ItemCategory | "all" | "wild" | "shards" | "energy" | "blueprint";

const FEED_EXTRA: { id: FeedFilter; label: string }[] = [
  { id: "wild", label: "MILD" },
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
    <div className="econ-row" data-seq={tx.seq}>
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
      <span className="econ-fee num">{tx.fee > 0 ? `${tx.fee} MILD` : "—"}</span>
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

  // The ledger can stream hundreds of transactions per second, and the feed is
  // capped, so anything scrolled into view is quickly evicted — trying to
  // compensate scrollTop as rows prepend is a losing battle. Instead we freeze
  // the rendered list the moment the user scrolls away from the top: new rows
  // are held back (buffered in `shown`) so nothing under the cursor moves, and
  // are revealed again once the user returns to the top. A pill surfaces how
  // many transactions are waiting and jumps back to live on click.
  const listRef = useRef<HTMLDivElement>(null);
  const [atTop, setAtTop] = useState(true);
  const frozenRef = useRef<EconTx[]>(shown);
  if (atTop) frozenRef.current = shown;
  const display = atTop ? shown : frozenRef.current;
  const frozenTopSeq = frozenRef.current[0]?.seq ?? -1;
  const pending = atTop ? 0 : shown.reduce((n, tx) => (tx.seq > frozenTopSeq ? n + 1 : n), 0);

  const onScroll = () => {
    const el = listRef.current;
    if (el) setAtTop(el.scrollTop <= 4);
  };
  const jumpToLive = () => {
    const el = listRef.current;
    if (el) el.scrollTop = 0;
    setAtTop(true);
  };

  return (
    <div className="econ-panel econ-feed">
      <div className="econ-panel-title">
        TRANSACTION FEED
        <span className="econ-panel-sub">
          {feed.length === 0 ? "AWAITING ACTIVITY" : atTop ? "LIVE" : "PAUSED"}
        </span>
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
      {pending > 0 && (
        <div className="econ-feed-new" onClick={jumpToLive}>
          ▲ {pending.toLocaleString()} NEW {pending === 1 ? "TRANSACTION" : "TRANSACTIONS"}
        </div>
      )}
      <div className="econ-feed-list" ref={listRef} onScroll={onScroll}>
        {feed.length === 0 && (
          <div className="econ-empty">No transactions yet — the ledger records every economic event.</div>
        )}
        {feed.length > 0 && display.length === 0 && (
          <div className="econ-empty">No transactions match this filter.</div>
        )}
        {display.map((tx) => (
          <TxRow key={tx.seq} tx={tx} now={now} />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Item market drill-in (ItemMarketSub / ItemMarketState)
// ---------------------------------------------------------------------------

type RangeId = "1h" | "6h" | "24h" | "all";

const RANGES: { id: RangeId; label: string; ms: number | null }[] = [
  { id: "1h", label: "1H", ms: 60 * 60 * 1000 },
  { id: "6h", label: "6H", ms: 6 * 60 * 60 * 1000 },
  { id: "24h", label: "24H", ms: 24 * 60 * 60 * 1000 },
  { id: "all", label: "ALL", ms: null },
];

const CHART_UP = "#7be0c2";
const CHART_DOWN = "#ff6a7c";
const CHART_LINE = "#4fc3ff";
const CHART_DIM = "#7f8ea0";

function formatClock(t: number, longRange: boolean): string {
  const d = new Date(t);
  if (longRange) {
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/**
 * Custom SVG price chart: volume-weighted average line with a min/max fill
 * band, volume bars along the bottom, price gridlines and a hover crosshair.
 * No chart library — pure SVG on the dashboard palette.
 */
function PriceChart({ buckets, rangeMs }: { buckets: PriceBucket[]; rangeMs: number | null }) {
  const [hover, setHover] = useState<number | null>(null);

  // Fixed virtual canvas; the SVG scales to its container.
  const W = 760;
  const H = 300;
  const PAD_T = 12;
  const PAD_R = 56;
  const VOL_H = 36;
  const AXIS_H = 20;
  const plotW = W - PAD_R;
  const plotH = H - PAD_T - VOL_H - AXIS_H - 8;
  const volTop = PAD_T + plotH + 6;

  const now = Date.now();
  const t1 = now;
  const t0 = rangeMs !== null ? now - rangeMs : Math.min(buckets[0]?.t ?? now - 3_600_000, now - 60_000);
  const pts = useMemo(() => buckets.filter((b) => b.t >= t0), [buckets, t0]);

  if (pts.length === 0) {
    return <div className="econ-empty econ-chart-empty">No trades in this window yet.</div>;
  }

  let yMin = Infinity;
  let yMax = -Infinity;
  for (const b of pts) {
    yMin = Math.min(yMin, b.min);
    yMax = Math.max(yMax, b.max);
  }
  const pad = Math.max((yMax - yMin) * 0.12, Math.max(1, yMax * 0.06));
  yMin = Math.max(0, yMin - pad);
  yMax = yMax + pad;

  const x = (t: number) => ((t - t0) / Math.max(1, t1 - t0)) * plotW;
  const y = (v: number) => PAD_T + (1 - (v - yMin) / Math.max(1e-6, yMax - yMin)) * plotH;

  const line = pts.map((b, i) => `${i === 0 ? "M" : "L"}${x(b.t).toFixed(1)},${y(b.avg).toFixed(1)}`).join(" ");
  const area = `${line} L${x(pts[pts.length - 1].t).toFixed(1)},${(PAD_T + plotH).toFixed(1)} L${x(pts[0].t).toFixed(1)},${(PAD_T + plotH).toFixed(1)} Z`;
  const band =
    pts.map((b, i) => `${i === 0 ? "M" : "L"}${x(b.t).toFixed(1)},${y(b.max).toFixed(1)}`).join(" ") +
    " " +
    [...pts].reverse().map((b) => `L${x(b.t).toFixed(1)},${y(b.min).toFixed(1)}`).join(" ") +
    " Z";

  const maxVol = Math.max(...pts.map((b) => b.wild), 1);
  const barW = Math.min(14, Math.max(2, (plotW / pts.length) * 0.6));

  // 4 horizontal price gridlines.
  const gridLevels = [0, 1 / 3, 2 / 3, 1].map((f) => yMin + f * (yMax - yMin));
  // 4 time axis labels.
  const longRange = t1 - t0 > 24 * 60 * 60 * 1000;
  const timeMarks = [0, 1 / 3, 2 / 3, 1].map((f) => t0 + f * (t1 - t0));

  const rising = pts[pts.length - 1].avg >= pts[0].avg;
  const lineColor = pts.length > 1 ? (rising ? CHART_UP : CHART_DOWN) : CHART_LINE;
  const h = hover !== null ? pts[hover] : null;

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const vx = ((e.clientX - rect.left) / rect.width) * W;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const d = Math.abs(x(pts[i].t) - vx);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    setHover(best);
  };

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="econ-chart"
      onMouseMove={onMove}
      onMouseLeave={() => setHover(null)}
    >
      <defs>
        <linearGradient id="econ-chart-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={lineColor} stopOpacity="0.28" />
          <stop offset="100%" stopColor={lineColor} stopOpacity="0.02" />
        </linearGradient>
      </defs>

      {gridLevels.map((v, i) => (
        <g key={i}>
          <line x1={0} y1={y(v)} x2={plotW} y2={y(v)} stroke="rgba(159,180,200,0.14)" strokeWidth="1" />
          <text x={plotW + 8} y={y(v) + 3.5} fill={CHART_DIM} fontSize="11" fontFamily="inherit">
            {Math.round(v).toLocaleString()}
          </text>
        </g>
      ))}

      {/* min/max fill band under the average line */}
      <path d={band} fill={lineColor} opacity="0.10" />
      <path d={area} fill="url(#econ-chart-fill)" />
      <path d={line} fill="none" stroke={lineColor} strokeWidth="2" strokeLinejoin="round" />
      {pts.length === 1 && <circle cx={x(pts[0].t)} cy={y(pts[0].avg)} r="3.5" fill={lineColor} />}

      {/* volume bars */}
      {pts.map((b, i) => (
        <rect
          key={b.t}
          x={Math.min(Math.max(x(b.t) - barW / 2, 0), plotW - barW)}
          y={volTop + (1 - b.wild / maxVol) * VOL_H}
          width={barW}
          height={Math.max(1.5, (b.wild / maxVol) * VOL_H)}
          fill={hover === i ? lineColor : "rgba(79,195,255,0.30)"}
        />
      ))}

      {/* time axis */}
      {timeMarks.map((t, i) => (
        <text
          key={i}
          x={Math.min(x(t), plotW - 4)}
          y={H - 5}
          fill={CHART_DIM}
          fontSize="11"
          textAnchor={i === 0 ? "start" : i === timeMarks.length - 1 ? "end" : "middle"}
        >
          {formatClock(t, longRange)}
        </text>
      ))}

      {/* hover crosshair + readout */}
      {h && (
        <g pointerEvents="none">
          <line x1={x(h.t)} y1={PAD_T} x2={x(h.t)} y2={volTop + VOL_H} stroke="rgba(234,247,255,0.35)" strokeWidth="1" strokeDasharray="3 3" />
          <circle cx={x(h.t)} cy={y(h.avg)} r="4" fill={lineColor} stroke="#0a1118" strokeWidth="1.5" />
          <g transform={`translate(${Math.min(Math.max(x(h.t) - 92, 2), plotW - 186)}, ${PAD_T})`}>
            <rect width="184" height="34" rx="2" fill="rgba(8,14,20,0.92)" stroke="rgba(79,195,255,0.35)" strokeWidth="1" />
            <text x="8" y="14" fill="#eaf7ff" fontSize="11.5" fontWeight="700">
              {h.avg.toLocaleString()} MILD
              {h.min !== h.max ? `  (${h.min.toLocaleString()}–${h.max.toLocaleString()})` : ""}
            </text>
            <text x="8" y="27" fill={CHART_DIM} fontSize="10.5">
              {h.units.toLocaleString()} units · {h.fills} fill{h.fills === 1 ? "" : "s"} · {formatClock(h.t, longRange)}
            </text>
          </g>
        </g>
      )}
    </svg>
  );
}

/**
 * Live per-trade tape: each executed fill (time, price, size, seller and
 * buyer), newest first, streamed with ItemMarketState while the page is open.
 */
function TradeTape({ fills }: { fills: MarketFill[] }) {
  if (fills.length === 0) {
    return <div className="econ-empty">No trades recorded yet.</div>;
  }
  return (
    <div className="econ-tape">
      <div className="econ-tape-row econ-tape-head">
        <span>TIME</span>
        <span>PRICE</span>
        <span>QTY</span>
        <span>SELLER</span>
        <span>BUYER</span>
      </div>
      <div className="econ-tape-scroll">
        {fills.map((f, i) => (
          <div className="econ-tape-row" key={`${f.t}-${i}`}>
            <span className="econ-tape-time">
              {new Date(f.t).toLocaleTimeString(undefined, {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              })}
            </span>
            <span className="num econ-tape-price">{f.price_each.toLocaleString()} MILD</span>
            <span className="num">{f.count.toLocaleString()}</span>
            <span className="econ-tape-name">{f.seller}</span>
            <span className="econ-tape-name">{f.buyer}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ItemStat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="econ-item-stat">
      <span className="econ-item-stat-label">{label}</span>
      <span className="num econ-item-stat-value" style={tone ? { color: tone } : undefined}>
        {value}
      </span>
    </div>
  );
}

/**
 * CoinMarketCap-style drill-in for one item kind: header (icon, name, ticker,
 * description, live price + range change), the price/volume chart and the
 * market detail stats. Data streams via ItemMarketSub while open.
 */
function ItemMarketView({ kind, onBack }: { kind: ItemKind; onBack: () => void }) {
  const data = useGame((s) => (s.itemMarket?.kind === kind ? s.itemMarket : null));
  const [range, setRange] = useState<RangeId>("6h");
  const info = ITEM_INFO[kind];
  const rangeMs = RANGES.find((r) => r.id === range)?.ms ?? null;

  const series = data?.series ?? [];
  const inRange = useMemo(() => {
    if (rangeMs === null) return series;
    const t0 = Date.now() - rangeMs;
    return series.filter((b) => b.t >= t0);
  }, [series, rangeMs]);

  // Change over the visible window (first vs last bucket average).
  const change =
    inRange.length >= 2 && inRange[0].avg > 0
      ? ((inRange[inRange.length - 1].avg - inRange[0].avg) / inRange[0].avg) * 100
      : null;
  const rangeVolume = inRange.reduce((n, b) => n + b.wild, 0);
  const rangeUnits = inRange.reduce((n, b) => n + b.units, 0);
  const rangeFills = inRange.reduce((n, b) => n + b.fills, 0);

  const n = (v: number | undefined) => (v ?? 0).toLocaleString();
  const wildOrDash = (v: number | undefined) => (v ? `${v.toLocaleString()} MILD` : "—");
  const circulating = (data?.supply.minted ?? 0) - (data?.supply.burned ?? 0);

  return (
    <div className="econ-item">
      <div className="econ-item-head">
        <div className="econ-tab econ-item-back" role="button" onClick={onBack}>
          ◀ ALL ITEMS
        </div>
        <span
          className="econ-item-glyph"
          style={{ borderColor: ECON_CAT_COLOR[info.category] }}
        >
          <ItemIcon kind={kind} size={40} />
        </span>
        <div className="econ-item-id">
          <div className="econ-item-name">
            {info.label}
            <span className="econ-item-ticker">{info.ticker}</span>
            <span className="econ-item-cat" style={{ color: ECON_CAT_COLOR[info.category] }}>
              {CATEGORY_LABEL[info.category]}
            </span>
          </div>
          <div className="econ-item-desc">{info.desc}</div>
        </div>
        <div className="econ-item-price">
          <div className="econ-item-price-value">
            {data && data.last_price > 0 ? `${n(data.last_price)} MILD` : "NO TRADES"}
          </div>
          {change !== null && (
            <div
              className="econ-item-change"
              style={{ color: change >= 0 ? CHART_UP : CHART_DOWN }}
            >
              {change >= 0 ? "▲" : "▼"} {Math.abs(change).toFixed(1)}% ({RANGES.find((r) => r.id === range)?.label})
            </div>
          )}
        </div>
      </div>

      <div className="econ-item-body">
        <div className="econ-panel econ-item-chart-panel">
          <div className="econ-panel-title">
            PRICE
            <span className="econ-panel-sub">
              {data === null ? "LOADING…" : `MARKET FILLS · ${n(rangeFills)} IN WINDOW`}
            </span>
          </div>
          <div className="econ-tabs">
            {RANGES.map((r) => (
              <div
                key={r.id}
                className={`econ-tab ${range === r.id ? "active" : ""}`}
                onClick={() => setRange(r.id)}
              >
                {r.label}
              </div>
            ))}
          </div>
          <PriceChart buckets={series} rangeMs={rangeMs} />
        </div>

        <div className="econ-panel econ-item-tape-panel">
          <div className="econ-panel-title">
            RECENT TRADES
            <span className="econ-panel-sub">
              {data === null ? "LOADING…" : `LAST ${n(data.recent_fills.length)} FILLS`}
            </span>
          </div>
          <TradeTape fills={data?.recent_fills ?? []} />
        </div>

        <div className="econ-panel econ-item-stats">
          <div className="econ-panel-title">MARKET DETAILS</div>
          <ItemStat label="LAST PRICE" value={wildOrDash(data?.last_price)} tone="#8fd6ff" />
          <ItemStat label="BEST ASK" value={wildOrDash(data?.best_ask)} />
          <ItemStat label="LISTED ON BOOK" value={`${n(data?.listed_units)} units`} />
          <ItemStat
            label={`VOLUME (${RANGES.find((r) => r.id === range)?.label})`}
            value={`${n(rangeVolume)} MILD`}
          />
          <ItemStat label={`UNITS (${RANGES.find((r) => r.id === range)?.label})`} value={n(rangeUnits)} />
          <div className="econ-item-stat-gap" />
          <ItemStat label="TRADES (ALL TIME)" value={n(data?.total_fills)} />
          <ItemStat label="UNITS TRADED" value={n(data?.total_units)} />
          <ItemStat label="MILD VOLUME" value={`${n(data?.total_wild)} MILD`} />
          <div className="econ-item-stat-gap" />
          <ItemStat label="ISSUED" value={n(data?.supply.minted)} />
          <ItemStat label="BURNED" value={n(data?.supply.burned)} tone="#ff6a7c" />
          <ItemStat label="CIRCULATING" value={circulating.toLocaleString()} tone="#7be0c2" />
          <div className="econ-item-stat-gap" />
          <ItemStat label="VENDOR SELLS AT" value={wildOrDash(data?.vendor_buy)} />
          <ItemStat label="VENDOR PAYS" value={wildOrDash(data?.vendor_sell)} />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Leaderboards (LeaderboardState pushes while subscribed)
// ---------------------------------------------------------------------------

/** Registry color for a faction id as a CSS hex string (white if unknown). */
function factionColor(factions: FactionInfo[], id: FactionId): string {
  const f = factions.find((f) => f.id === id);
  return `#${(f?.color ?? 0xffffff).toString(16).padStart(6, "0")}`;
}

function factionName(factions: FactionInfo[], id: FactionId): string {
  return factions.find((f) => f.id === id)?.name ?? "Unaligned";
}

/** Value formatting per board category. */
function boardValue(category: string, value: number): string {
  return category === "Wealth" ? `${value.toLocaleString()} MILD` : value.toLocaleString();
}

function FactionStandingsStrip() {
  const leaderboard = useGame((s) => s.leaderboard);
  const factions = useGame((s) => s.factions);
  if (!leaderboard) return null;
  return (
    <div className="econ-lb-factions">
      {leaderboard.factions.map((f) => {
        const color = factionColor(factions, f.faction);
        return (
          <div key={f.faction} className="econ-lb-faction" style={{ borderColor: color }}>
            <div className="econ-lb-faction-name" style={{ color }}>
              {factionName(factions, f.faction).toUpperCase()}
            </div>
            <div className="econ-lb-faction-grid">
              <span className="econ-lb-stat-label">MEMBERS</span>
              <span className="num">{f.members.toLocaleString()}</span>
              <span className="econ-lb-stat-label">KILLS</span>
              <span className="num">{f.kills.toLocaleString()}</span>
              <span className="econ-lb-stat-label">DEATHS</span>
              <span className="num econ-burned">{f.deaths.toLocaleString()}</span>
              <span className="econ-lb-stat-label">TREASURY</span>
              <span className="num econ-live">{f.treasury.toLocaleString()} MILD</span>
              <span className="econ-lb-stat-label">REGIONS</span>
              <span className="num">{f.regions_held.toLocaleString()}</span>
              <span className="econ-lb-stat-label">DISTRICTS</span>
              <span className="num">{f.districts_held.toLocaleString()}</span>
              <span className="econ-lb-stat-label">ZONE PTS</span>
              <span className="num econ-live">
                {(f.zone_points ?? 0).toLocaleString()}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function BoardPanel({ board }: { board: Board }) {
  const factions = useGame((s) => s.factions);
  const [factionFilter, setFactionFilter] = useState<FactionId | "all">("all");
  const rows = board.rows.filter(
    (r) => factionFilter === "all" || r.faction === factionFilter,
  );
  return (
    <div className="econ-panel econ-lb-board">
      <div className="econ-panel-title">
        {board.category.toUpperCase()}
        <span className="econ-panel-sub">TOP {board.rows.length}</span>
      </div>
      <div className="econ-tabs">
        <div
          className={`econ-tab ${factionFilter === "all" ? "active" : ""}`}
          onClick={() => setFactionFilter("all")}
        >
          ALL
        </div>
        {factions.map((f) => (
          <div
            key={f.id}
            className={`econ-tab ${factionFilter === f.id ? "active" : ""}`}
            onClick={() => setFactionFilter(f.id)}
          >
            {f.name.toUpperCase()}
          </div>
        ))}
      </div>
      <div className="econ-lb-row econ-lb-head">
        <span className="num">#</span>
        <span>NAME</span>
        <span>GUILD</span>
        <span className="num">{board.category === "Wealth" ? "WEALTH" : board.category.toUpperCase()}</span>
      </div>
      <div className="econ-lb-list">
        {rows.length === 0 && <div className="econ-empty">No competitors yet.</div>}
        {rows.map((r, i) => (
          <div key={`${r.name}-${i}`} className="econ-lb-row">
            <span className="num econ-lb-rank">{i + 1}</span>
            <span
              className="econ-lb-name"
              style={{ color: factionColor(factions, r.faction) }}
            >
              {r.name}
            </span>
            <span className="econ-lb-guild">{r.guild ?? "—"}</span>
            <span className="num">{boardValue(board.category, r.value)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function GuildStandings() {
  const leaderboard = useGame((s) => s.leaderboard);
  const factions = useGame((s) => s.factions);
  if (!leaderboard) return null;
  return (
    <div className="econ-panel econ-lb-guilds">
      <div className="econ-panel-title">
        GUILD STANDINGS
        <span className="econ-panel-sub">{leaderboard.guilds.length} GUILDS</span>
      </div>
      <div className="econ-lb-guild-row econ-lb-head">
        <span>GUILD</span>
        <span>FACTION</span>
        <span className="num">MEMBERS</span>
        <span className="num">KILLS</span>
        <span className="num">WEALTH</span>
      </div>
      <div className="econ-lb-list">
        {leaderboard.guilds.length === 0 && (
          <div className="econ-empty">No guild activity recorded yet.</div>
        )}
        {leaderboard.guilds.map((g) => (
          <div key={g.name} className="econ-lb-guild-row">
            <span className="econ-lb-name">{g.name}</span>
            <span style={{ color: factionColor(factions, g.faction) }}>
              {factionName(factions, g.faction)}
            </span>
            <span className="num">{g.members.toLocaleString()}</span>
            <span className="num">{g.kills.toLocaleString()}</span>
            <span className="num econ-live">{g.wealth.toLocaleString()} MILD</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Rolling zone-seconds formatted compactly (e.g. "45s", "12m", "1h04m"). */
function formatZoneSeconds(s: number): string {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

/**
 * Per-neighborhood territory standings: current owner plus a rolling
 * seconds-held bar split by faction (the momentum window from the server).
 */
function ZoneStandings() {
  const leaderboard = useGame((s) => s.leaderboard);
  const factions = useGame((s) => s.factions);
  if (!leaderboard) return null;
  const zones = leaderboard.zones ?? [];
  return (
    <div className="econ-panel econ-lb-zones">
      <div className="econ-panel-title">
        TERRITORY
        <span className="econ-panel-sub">OWNERS · LIVE CONTROL</span>
      </div>
      <div className="econ-lb-terr-cols">
        <div className="econ-lb-terr-col">
          <div className="econ-lb-terr-subhead">OWNERS · ZONE SECONDS (60 MIN)</div>
          <div className="econ-lb-list">
            {zones.length === 0 && (
              <div className="econ-empty">No territory held yet.</div>
            )}
            {zones.map((z) => {
              const total = z.seconds.reduce((a, s) => a + s.seconds, 0);
              const color = factionColor(factions, z.control);
              return (
                <div key={z.district} className="econ-lb-zone">
                  <div className="econ-lb-zone-head">
                    <span className="econ-lb-zone-name">{z.district}</span>
                    <span className="econ-lb-zone-owner" style={{ color }}>
                      {z.control === 0
                        ? "UNCLAIMED"
                        : factionName(factions, z.control).toUpperCase()}
                    </span>
                  </div>
                  <div className="econ-lb-zone-bar">
                    {z.seconds
                      .filter((s) => s.seconds > 0)
                      .map((s) => (
                        <span
                          key={s.faction}
                          className="econ-lb-zone-seg"
                          style={{
                            width: total > 0 ? `${(s.seconds / total) * 100}%` : "0%",
                            background: factionColor(factions, s.faction),
                          }}
                          title={`${factionName(factions, s.faction)}: ${formatZoneSeconds(s.seconds)}`}
                        />
                      ))}
                    {total === 0 && <span className="econ-lb-zone-empty" />}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        <div className="econ-lb-terr-col">
          <div className="econ-lb-terr-subhead">LIVE CONTROL · EVERY SQUARE</div>
          <LiveSquaresGrid factions={factions} />
        </div>
      </div>
    </div>
  );
}

/**
 * Spatial grid of every controlled region ("square"), colored by the faction
 * that holds it right now. Polls the client-side territory cache (`allRegions`)
 * on an interval, since control state lives outside the reactive store.
 */
function LiveSquaresGrid({ factions }: { factions: FactionInfo[] }) {
  const [cells, setCells] = useState(() => allRegions());
  useEffect(() => {
    const poll = () => {
      const next = allRegions();
      setCells((prev) =>
        prev.length === next.length &&
        prev.every(
          (p, i) => p.rx === next[i].rx && p.rz === next[i].rz && p.faction === next[i].faction,
        )
          ? prev
          : next,
      );
    };
    poll();
    const timer = setInterval(poll, 1000);
    return () => clearInterval(timer);
  }, []);

  const grid = useMemo(() => {
    if (cells.length === 0) return null;
    let minRx = Infinity;
    let maxRx = -Infinity;
    let minRz = Infinity;
    let maxRz = -Infinity;
    for (const c of cells) {
      if (c.rx < minRx) minRx = c.rx;
      if (c.rx > maxRx) maxRx = c.rx;
      if (c.rz < minRz) minRz = c.rz;
      if (c.rz > maxRz) maxRz = c.rz;
    }
    const cols = maxRx - minRx + 1;
    const rows = maxRz - minRz + 1;
    const byKey = new Map<number, number>();
    for (const c of cells) byKey.set((c.rz - minRz) * cols + (c.rx - minRx), c.faction);
    return { cols, rows, byKey, minRx, minRz };
  }, [cells]);

  if (!grid) return <div className="econ-empty">No territory held yet.</div>;

  const squares = [];
  for (let i = 0; i < grid.cols * grid.rows; i++) {
    const faction = grid.byKey.get(i);
    const rx = grid.minRx + (i % grid.cols);
    const rz = grid.minRz + Math.floor(i / grid.cols);
    squares.push(
      <span
        key={i}
        className={faction ? "econ-lb-sq held" : "econ-lb-sq"}
        style={faction ? { background: factionColor(factions, faction) } : undefined}
        title={
          faction
            ? `${rx},${rz} — ${factionName(factions, faction)}`
            : `${rx},${rz} — unclaimed`
        }
      />,
    );
  }
  return (
    <div
      className="econ-lb-terr-grid"
      style={{ gridTemplateColumns: `repeat(${grid.cols}, 1fr)` }}
    >
      {squares}
    </div>
  );
}

function LeaderboardView() {
  const leaderboard = useGame((s) => s.leaderboard);
  const [category, setCategory] = useState("Wealth");
  if (!leaderboard) {
    return <div className="econ-empty">Awaiting leaderboard data…</div>;
  }
  const board =
    leaderboard.boards.find((b) => b.category === category) ?? leaderboard.boards[0];
  return (
    <div className="econ-lb">
      <FactionStandingsStrip />
      <div className="econ-tabs econ-lb-cats">
        {leaderboard.boards.map((b) => (
          <div
            key={b.category}
            className={`econ-tab ${board?.category === b.category ? "active" : ""}`}
            onClick={() => setCategory(b.category)}
          >
            {b.category.toUpperCase()}
          </div>
        ))}
      </div>
      <div className="econ-lb-body">
        {board && <BoardPanel key={board.category} board={board} />}
        <GuildStandings />
        <ZoneStandings />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dashboard shell
// ---------------------------------------------------------------------------

export function EconomyDashboard({ connection }: { connection: GameConnection }) {
  // The ledger and the leaderboards are now two top-level tabs of the central
  // menu; both share the same live EconomySub subscription (the server pushes
  // LeaderboardState alongside the economy snapshot while subscribed).
  const open = useGame((s) => s.menuOpen && (s.menuTab === "economy" || s.menuTab === "leaderboard"));
  const isLedger = useGame((s) => s.menuTab === "economy");
  // Item market drill-in: which kind's detail page is showing (ledger tab).
  const [selected, setSelected] = useState<ItemKind | null>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  // Closing spends the Escape/click: suppress the pointer-lock bounce so it does
  // not read as an "open game menu" Escape (see CameraRig).
  const close = () => {
    cameraState.suppressMenuUntil = performance.now() + 1500;
    useGame.getState().closeMenu();
  };

  useEffect(() => {
    if (!open) return;
    connection.send({ t: "EconomySub", d: { on: true } });
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      // Escape backs out of an item detail page first, then closes the menu.
      if (e.code === "Escape") {
        if (selectedRef.current) setSelected(null);
        else close();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      connection.send({ t: "EconomySub", d: { on: false } });
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open, connection]);

  // Watch the selected item's market while its detail page is up: the server
  // answers with a full ItemMarketState and re-pushes on new fills.
  useEffect(() => {
    if (!open || !isLedger || !selected) return;
    connection.send({ t: "ItemMarketSub", d: { kind: selected } });
    return () => {
      connection.send({ t: "ItemMarketSub", d: { kind: null } });
      useGame.getState().set({ itemMarket: null });
    };
  }, [open, isLedger, selected, connection]);

  if (!open) return null;

  return (
    <div className="map-overlay econ-overlay">
      <KpiStrip />
      {isLedger ? (
        selected ? (
          <ItemMarketView kind={selected} onBack={() => setSelected(null)} />
        ) : (
          <div className="econ-body">
            <TxFeed />
            <SupplyPanel onSelect={setSelected} />
          </div>
        )
      ) : (
        <LeaderboardView />
      )}
    </div>
  );
}
