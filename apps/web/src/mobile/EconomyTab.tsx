// Mobile Economy tab: phone-first relayout of the desktop economy dashboard.
// Swipeable KPI cards, the item-supply list and the live transaction feed.
// Owns the EconomySub lifecycle while mounted. The per-item drill-in page
// rode the retired ItemMarketSub protocol; Phase 4 rebuilds it on exchange
// data (MarketsState/BookState) in the mobile Trade tab.

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
  // Gate on `joined` (not `connected`): after a reconnect the socket opens
  // before the JoinWorld handshake completes, and the gateway drops game
  // messages from unjoined connections — a sub sent in that window is lost.
  // `joined` flips on WorldJoined, so it also re-runs these effects (fresh
  // subscribe) after every reconnect. `appVisible` pauses the streams while
  // the app is backgrounded.
  const joined = useGame((s) => s.joined);
  const appVisible = useGame((s) => s.appVisible);
  const [section, setSection] = useState<Section>("supply");

  // Live ledger stream while the tab is up (snapshot + per-tick batches).
  useEffect(() => {
    if (!joined || !appVisible) return;
    connection.send({ t: "EconomySub", d: { on: true } });
    return () => {
      connection.send({ t: "EconomySub", d: { on: false } });
    };
  }, [joined, appVisible, connection]);

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
      {section === "supply" ? <SupplyList /> : <MobileTxFeed />}
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

function SupplyList() {
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
        {/* Tapping a row jumps to its market on the Trade tab. */}
        {rows.map((r) => (
          <div
            key={r.kind}
            className="m-econ-item-row"
            role="button"
            onClick={() => useGame.getState().openTradeForItem(r.kind)}
          >
            <i
              className="econ-supply-tick"
              style={{ background: ECON_CAT_COLOR[ITEM_INFO[r.kind].category] }}
            />
            <ItemIcon kind={r.kind} size={22} coin />
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
          </div>
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
          {tx.amount.t === "Item" && <ItemIcon kind={tx.amount.d.kind} size={13} coin />}
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

// The stacked item drill-in page (MiniPriceChart / ItemDetailPage /
// RecentFills) was deleted with the ItemMarketSub protocol; Phase 4 rebuilds
// the per-asset view on exchange BookState data.
