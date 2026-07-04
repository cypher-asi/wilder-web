// Mobile Economy tab: phone-first relayout of the desktop economy dashboard.
// Swipeable KPI cards, the item-supply list with a stacked item drill-in page
// (price chart + market details + recent fills), and the live transaction
// feed. Owns the EconomySub lifecycle while mounted; the drill-in page owns
// its ItemMarketSub, mirroring the desktop dashboard's plumbing.

import { useEffect, useMemo, useRef, useState } from "react";
import { GameConnection } from "../net/connection";
import {
  EconomyStats,
  EconTx,
  ItemKind,
  TxAmount,
  TxParty,
} from "../net/protocol";
import { useGame } from "../state/game";
import {
  CATEGORY_LABEL,
  CATEGORY_ORDER,
  ECON_CAT_COLOR,
  TX_KIND_COLOR,
  TX_KIND_LABEL,
} from "../ui/EconomyDashboard";
import { fmtMild, formatAge } from "../ui/format";
import { ITEM_INFO, ItemCategory, ItemIcon, itemLabel } from "../ui/ItemIcon";
import { useFactionMeta } from "../ui/useAgents";

/** Max transaction rows rendered (the store feed itself holds more). */
const TX_RENDER_CAP = 50;

type Section = "supply" | "activity";

export function EconomyTab({ connection }: { connection: GameConnection }) {
  const connected = useGame((s) => s.connected);
  const [selected, setSelected] = useState<ItemKind | null>(null);
  const [section, setSection] = useState<Section>("supply");

  // Live ledger stream while the tab is up (snapshot + per-tick batches).
  useEffect(() => {
    if (!connected) return;
    connection.send({ t: "EconomySub", d: { on: true } });
    return () => {
      connection.send({ t: "EconomySub", d: { on: false } });
    };
  }, [connected, connection]);

  // Item drill-in stream follows the open detail page.
  useEffect(() => {
    if (!selected || !connected) return;
    connection.send({ t: "ItemMarketSub", d: { kind: selected } });
    return () => {
      connection.send({ t: "ItemMarketSub", d: { kind: null } });
      useGame.getState().set({ itemMarket: null });
    };
  }, [selected, connected, connection]);

  if (selected) {
    return <ItemDetailPage kind={selected} onBack={() => setSelected(null)} />;
  }

  return (
    <div className="m-econ">
      <div className="m-econ-head">
        <span className="m-ag-title">ECONOMY</span>
      </div>
      <KpiRow />
      <div className="m-econ-sections">
        <button
          type="button"
          className={`m-econ-section-btn${section === "supply" ? " active" : ""}`}
          onClick={() => setSection("supply")}
        >
          SUPPLY
        </button>
        <button
          type="button"
          className={`m-econ-section-btn${section === "activity" ? " active" : ""}`}
          onClick={() => setSection("activity")}
        >
          ACTIVITY
        </button>
      </div>
      {section === "supply" ? <SupplyList onSelect={setSelected} /> : <MobileTxFeed />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// KPI cards (horizontal scroll-snap row)
// ---------------------------------------------------------------------------

interface KpiDef {
  label: string;
  value: (s: EconomyStats) => number;
  tone?: string;
}

const KPI_DEFS: KpiDef[] = [
  { label: "MILD CIRCULATING", value: (s) => s.wild_circulating, tone: "#8fd6ff" },
  { label: "MILD MINTED", value: (s) => s.wild_minted, tone: "#9fdcff" },
  { label: "MILD BURNED", value: (s) => s.wild_burned, tone: "#ff6a7c" },
  { label: "SHARDS", value: (s) => s.shards_minted - s.shards_burned, tone: "#b79bff" },
  { label: "ENERGY", value: (s) => s.energy_minted - s.energy_burned, tone: "#ffd75e" },
  { label: "AGENTS ALIVE", value: (s) => s.agents_alive },
  { label: "PLAYERS ONLINE", value: (s) => s.players_online },
  { label: "MARKET TRADES", value: (s) => s.trades },
  { label: "PLAYER DEATHS", value: (s) => s.deaths, tone: "#ff6a7c" },
];

function KpiRow() {
  const stats = useGame((s) => s.economy?.stats ?? null);
  // Delta between consecutive economy pushes, per card (0 rows hidden).
  const prevRef = useRef<EconomyStats | null>(null);
  const deltas = useMemo(() => {
    const prev = prevRef.current;
    if (!prev || !stats) return KPI_DEFS.map(() => 0);
    return KPI_DEFS.map((k) => k.value(stats) - k.value(prev));
  }, [stats]);
  useEffect(() => {
    if (stats) prevRef.current = stats;
  }, [stats]);

  return (
    <div className="m-econ-kpis">
      {KPI_DEFS.map((k, i) => (
        <div key={k.label} className="m-econ-kpi">
          <div className="m-econ-kpi-value" style={k.tone ? { color: k.tone } : undefined}>
            {stats ? fmtMild(k.value(stats)) : "—"}
          </div>
          <div className="m-econ-kpi-label">{k.label}</div>
          {deltas[i] !== 0 && (
            <div className={`m-econ-kpi-delta${deltas[i] > 0 ? " up" : " down"}`}>
              {deltas[i] > 0 ? "▲" : "▼"} {fmtMild(Math.abs(deltas[i]))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Item supply list
// ---------------------------------------------------------------------------

const ALL_KINDS = Object.keys(ITEM_INFO) as ItemKind[];

function SupplyList({ onSelect }: { onSelect: (kind: ItemKind) => void }) {
  const economy = useGame((s) => s.economy);
  const [category, setCategory] = useState<ItemCategory | "all">("all");

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
    <>
      <div className="m-econ-cats">
        {CATEGORY_ORDER.map((c) => (
          <button
            key={c}
            type="button"
            className={`m-econ-cat${category === c ? " active" : ""}`}
            onClick={() => setCategory(c)}
          >
            {CATEGORY_LABEL[c]}
          </button>
        ))}
      </div>
      <div className="m-econ-list m-scroll">
        {rows.map((r) => (
          <button
            key={r.kind}
            type="button"
            className="m-econ-item-row"
            onClick={() => onSelect(r.kind)}
          >
            <i
              className="econ-supply-tick"
              style={{ background: ECON_CAT_COLOR[ITEM_INFO[r.kind].category] }}
            />
            <ItemIcon kind={r.kind} size={22} />
            <span className="m-econ-item-name">
              {itemLabel(r.kind)}
              <span className="m-econ-item-ticker">{ITEM_INFO[r.kind].ticker}</span>
            </span>
            <span className="m-econ-item-supply">
              <span className="m-econ-item-live num">{fmtMild(r.circulating)}</span>
              <span className="m-econ-item-sub num">
                {fmtMild(r.minted)} issued · {fmtMild(r.burned)} burned
              </span>
            </span>
            <span className="m-econ-item-chev">›</span>
          </button>
        ))}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Live transaction feed
// ---------------------------------------------------------------------------

function PartyName({ party }: { party: TxParty }) {
  const factionMeta = useFactionMeta();
  switch (party.t) {
    case "Player":
    case "Agent":
      return (
        <span style={{ color: factionMeta(party.d.faction).color }}>{party.d.name}</span>
      );
    case "Mint":
    case "Burn":
      return <span className="m-econ-tx-kernel">GIBSON</span>;
  }
}

function amountText(amount: TxAmount): string {
  switch (amount.t) {
    case "Item":
      return `${amount.d.count} ${itemLabel(amount.d.kind)}`;
    case "Wild":
      return `${fmtMild(amount.d.amount)} MILD`;
    case "Shards":
      return `${fmtMild(amount.d.amount)} SHARDS`;
    case "Energy":
      return `${fmtMild(amount.d.amount)} ENERGY`;
    case "Blueprint":
      return `BP: ${amount.d.recipe}`;
  }
}

function TxFeedRow({ tx, now }: { tx: EconTx; now: number }) {
  return (
    <div className="m-econ-tx">
      <div className="m-econ-tx-top">
        <span className="m-econ-tx-kind" style={{ color: TX_KIND_COLOR[tx.kind] }}>
          {TX_KIND_LABEL[tx.kind]}
        </span>
        <span className="m-econ-tx-amount">
          {tx.amount.t === "Item" && <ItemIcon kind={tx.amount.d.kind} size={13} />}
          {amountText(tx.amount)}
        </span>
        <span className="m-econ-tx-age num">{formatAge(tx.at_ms, now)}</span>
      </div>
      <div className="m-econ-tx-parties">
        <PartyName party={tx.from} />
        <span className="m-econ-tx-arrow">→</span>
        <PartyName party={tx.to} />
      </div>
    </div>
  );
}

function MobileTxFeed() {
  const feed = useGame((s) => s.economy?.feed ?? null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const shown = useMemo(() => feed?.slice(0, TX_RENDER_CAP) ?? [], [feed]);

  return (
    <div className="m-econ-list m-scroll">
      {shown.length === 0 && (
        <div className="m-ag-note">
          {feed === null ? "SYNCING LEDGER…" : "No transactions yet."}
        </div>
      )}
      {shown.map((tx) => (
        <TxFeedRow key={tx.seq} tx={tx} now={now} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Item drill-in page (stacked navigation, like the Agents tab detail)
// ---------------------------------------------------------------------------

/** Simple inline-SVG price chart: avg-price polyline with an area fill.
 * Deliberately lighter than the desktop PriceChart (no hover/crosshair). */
function MiniPriceChart({ series }: { series: { t: number; avg: number }[] }) {
  if (series.length === 0) {
    return <div className="m-ag-note">No trades recorded yet.</div>;
  }
  const W = 320;
  const H = 120;
  const PAD = 6;
  let yMin = Infinity;
  let yMax = -Infinity;
  for (const b of series) {
    yMin = Math.min(yMin, b.avg);
    yMax = Math.max(yMax, b.avg);
  }
  const spread = Math.max(yMax - yMin, Math.max(1, yMax * 0.05));
  yMin = Math.max(0, yMin - spread * 0.1);
  yMax = yMax + spread * 0.1;
  const t0 = series[0].t;
  const t1 = series[series.length - 1].t;
  const x = (t: number) =>
    PAD + ((t - t0) / Math.max(1, t1 - t0)) * (W - PAD * 2);
  const y = (v: number) =>
    PAD + (1 - (v - yMin) / Math.max(1e-6, yMax - yMin)) * (H - PAD * 2);
  const points = series.map((b) => `${x(b.t).toFixed(1)},${y(b.avg).toFixed(1)}`).join(" ");
  const rising = series[series.length - 1].avg >= series[0].avg;
  const color = series.length > 1 ? (rising ? "#7be0c2" : "#ff6a7c") : "#4fc3ff";
  const area = `${points} ${x(t1).toFixed(1)},${H - PAD} ${x(t0).toFixed(1)},${H - PAD}`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="m-econ-chart">
      <polygon points={area} fill={color} opacity="0.12" />
      <polyline points={points} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" />
      {series.length === 1 && (
        <circle cx={x(series[0].t)} cy={y(series[0].avg)} r="3" fill={color} />
      )}
      <text x={W - PAD} y={y(yMax) + 10} textAnchor="end" fill="#7f8ea0" fontSize="10">
        {fmtMild(Math.round(yMax))}
      </text>
      <text x={W - PAD} y={H - PAD - 3} textAnchor="end" fill="#7f8ea0" fontSize="10">
        {fmtMild(Math.round(yMin))}
      </text>
    </svg>
  );
}

function DetailStat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="m-econ-stat">
      <span className="m-econ-stat-label">{label}</span>
      <span className="m-econ-stat-value num" style={tone ? { color: tone } : undefined}>
        {value}
      </span>
    </div>
  );
}

function ItemDetailPage({ kind, onBack }: { kind: ItemKind; onBack: () => void }) {
  const data = useGame((s) => (s.itemMarket?.kind === kind ? s.itemMarket : null));
  const info = ITEM_INFO[kind];
  const wildOrDash = (v: number | undefined) => (v ? `${fmtMild(v)} MILD` : "—");
  const n = (v: number | undefined) => fmtMild(v ?? 0);
  const series = data?.series ?? [];
  const change =
    series.length >= 2 && series[0].avg > 0
      ? ((series[series.length - 1].avg - series[0].avg) / series[0].avg) * 100
      : null;
  const circulating = (data?.supply.minted ?? 0) - (data?.supply.burned ?? 0);

  return (
    <div className="m-econ m-econ-detail m-scroll">
      <div className="m-ag-detail-nav">
        <button type="button" className="m-ag-back" onClick={onBack}>
          ‹ ECONOMY
        </button>
      </div>

      <div className="m-econ-detail-head">
        <span
          className="m-econ-detail-glyph"
          style={{ borderColor: ECON_CAT_COLOR[info.category] }}
        >
          <ItemIcon kind={kind} size={34} />
        </span>
        <div className="m-econ-detail-id">
          <div className="m-econ-detail-name">
            {info.label}
            <span className="m-econ-item-ticker">{info.ticker}</span>
          </div>
          <div className="m-econ-detail-cat" style={{ color: ECON_CAT_COLOR[info.category] }}>
            {CATEGORY_LABEL[info.category]}
          </div>
        </div>
        <div className="m-econ-detail-price">
          <div className="m-econ-detail-price-value">
            {data === null ? "…" : data.last_price > 0 ? `${fmtMild(data.last_price)}` : "NO TRADES"}
          </div>
          {data !== null && data.last_price > 0 && (
            <div className="m-econ-detail-price-cur">MILD</div>
          )}
          {change !== null && (
            <div
              className="m-econ-detail-change"
              style={{ color: change >= 0 ? "#7be0c2" : "#ff6a7c" }}
            >
              {change >= 0 ? "▲" : "▼"} {Math.abs(change).toFixed(1)}%
            </div>
          )}
        </div>
      </div>

      <div className="m-econ-detail-desc">{info.desc}</div>

      <div className="m-ag-sec">
        <div className="ag-sec-title">PRICE · MARKET FILLS</div>
        {data === null ? <div className="m-ag-note">LOADING MARKET…</div> : <MiniPriceChart series={series} />}
      </div>

      <div className="m-ag-sec">
        <div className="ag-sec-title">MARKET DETAILS</div>
        <div className="m-econ-stats">
          <DetailStat label="LAST PRICE" value={wildOrDash(data?.last_price)} tone="#8fd6ff" />
          <DetailStat label="BEST ASK" value={wildOrDash(data?.best_ask)} />
          <DetailStat label="LISTED ON BOOK" value={`${n(data?.listed_units)} units`} />
          <DetailStat label="TRADES (ALL TIME)" value={n(data?.total_fills)} />
          <DetailStat label="UNITS TRADED" value={n(data?.total_units)} />
          <DetailStat label="MILD VOLUME" value={`${n(data?.total_wild)} MILD`} />
          <DetailStat label="ISSUED" value={n(data?.supply.minted)} />
          <DetailStat label="BURNED" value={n(data?.supply.burned)} tone="#ff6a7c" />
          <DetailStat label="CIRCULATING" value={fmtMild(circulating)} tone="#7be0c2" />
          <DetailStat label="VENDOR SELLS AT" value={wildOrDash(data?.vendor_buy)} />
          <DetailStat label="VENDOR PAYS" value={wildOrDash(data?.vendor_sell)} />
        </div>
      </div>

      <div className="m-ag-sec">
        <div className="ag-sec-title">RECENT FILLS</div>
        <RecentFills fills={data?.recent_fills ?? []} />
      </div>
    </div>
  );
}

function RecentFills({ fills }: { fills: { t: number; price_each: number; count: number; buyer: string; seller: string }[] }) {
  if (fills.length === 0) {
    return <div className="m-ag-note">No fills yet.</div>;
  }
  return (
    <div className="m-econ-fills">
      {fills.map((f, i) => (
        <div key={`${f.t}-${i}`} className="m-econ-fill">
          <span className="m-econ-fill-time num">
            {new Date(f.t).toLocaleTimeString(undefined, {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
          <span className="m-econ-fill-price num">{fmtMild(f.price_each)} MILD</span>
          <span className="m-econ-fill-qty num">×{fmtMild(f.count)}</span>
          <span className="m-econ-fill-names">
            {f.seller} → {f.buyer}
          </span>
        </div>
      ))}
    </div>
  );
}
