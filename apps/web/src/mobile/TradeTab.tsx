// Mobile Trade tab, styled after the CoinMarketCap/CoinGecko mobile apps:
// a ranked markets list (MarketsSub) with category chips, expandable search,
// sortable # / price / 1h% / 24h% columns and per-row sparklines; tapping a
// row opens a coin-page drill-in (BookSub) with the price hero, candle chart
// (timeframe pills), stat cards, order-book ladder and trades tape.
// Order entry stays desktop-first — the mobile shell spectates, it doesn't
// stand at terminals.

import { ReactNode, useEffect, useMemo, useState } from "react";
import { GameConnection } from "../net/connection";
import { AssetMsg, MarketRow } from "../net/protocol";
import { useGame } from "../state/game";
import { fmtCompact, fmtMild, formatAge } from "../ui/format";
import { ITEM_INFO } from "../ui/ItemIcon";
import { TradeChart } from "../ui/TradeChart";
import { AssetGlyph, assetKey, assetLabel, assetTicker, assetTickColor } from "../ui/TradeScreen";

const UP = "#7be0c2";
const DOWN = "#ff6a7c";

// ---------------------------------------------------------------------------
// Percent helpers
// ---------------------------------------------------------------------------

/**
 * Client-side 1h change in basis points, derived from the row's 24h spark
 * series (48 close prices at ~30-minute slots, oldest first): compare the
 * last trade price to the close nearest one hour ago (two slots back).
 * Null when the market never traded or the series is too short — the cell
 * renders an em-dash instead of a fabricated number.
 */
function change1hBp(row: MarketRow): number | null {
  const s = row.spark;
  if (row.last <= 0 || s.length < 3) return null;
  const ref = s[s.length - 3];
  if (ref <= 0) return null;
  return Math.round(((row.last - ref) / ref) * 10000);
}

/** CMC-style percent cell: green ▲ up, red ▼ down, gray for flat/no data. */
function PctCell({ bp, strong }: { bp: number | null; strong?: boolean }) {
  const cls =
    bp === null ? "dim" : bp > 0 ? "up" : bp < 0 ? "down" : "flat";
  const text =
    bp === null
      ? "—"
      : `${bp > 0 ? "▲" : bp < 0 ? "▼" : ""}${(Math.abs(bp) / 100).toFixed(2)}%`;
  return (
    <span className={`m-tr-pct num ${cls}${strong ? " strong" : ""}`}>{text}</span>
  );
}

/** Tiny 7-point sparkline, downsampled from the row's 48-point 24h series. */
function TinySpark({ points, downBp }: { points: number[]; downBp: number }) {
  if (points.length < 2) return <span className="m-tr-spark" />;
  const n = Math.min(7, points.length);
  const pts: number[] = [];
  for (let i = 0; i < n; i++) {
    pts.push(points[Math.round((i * (points.length - 1)) / (n - 1))]);
  }
  const w = 38;
  const h = 18;
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const span = Math.max(1, max - min);
  const step = w / (n - 1);
  const path = pts
    .map((p, i) => `${(i * step).toFixed(1)},${(h - 2 - ((p - min) / span) * (h - 4)).toFixed(1)}`)
    .join(" ");
  return (
    <svg className="m-tr-spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
      <polyline
        points={path}
        fill="none"
        stroke={downBp < 0 ? DOWN : UP}
        strokeWidth="1.3"
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Category chips
// ---------------------------------------------------------------------------

type Cat = "all" | "resource" | "material" | "gear" | "currency";

const CATS: { id: Cat; label: string }[] = [
  { id: "all", label: "All" },
  { id: "resource", label: "Resources" },
  { id: "material", label: "Materials" },
  { id: "gear", label: "Gear" },
  { id: "currency", label: "Currency" },
];

function catOf(a: AssetMsg): Exclude<Cat, "all"> {
  if (a.t !== "Item") return "currency";
  const c = ITEM_INFO[a.d]?.category;
  if (c === "resource") return "resource";
  if (c === "material") return "material";
  if (c === "currency") return "currency";
  return "gear";
}

// ---------------------------------------------------------------------------
// Chart timeframes (persisted; subset of the server's BookSub allow-list)
// ---------------------------------------------------------------------------

const TIMEFRAMES: { label: string; secs: number }[] = [
  { label: "5s", secs: 5 },
  { label: "1m", secs: 60 },
  { label: "15m", secs: 900 },
  { label: "1h", secs: 3600 },
  { label: "4h", secs: 14400 },
  { label: "1d", secs: 86400 },
];

const TF_KEY = "wilder.mtrade.tf";

function loadTf(): number {
  if (typeof localStorage === "undefined") return 60;
  const secs = Number(localStorage.getItem(TF_KEY));
  return TIMEFRAMES.some((tf) => tf.secs === secs) ? secs : 60;
}

function saveTf(secs: number): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(TF_KEY, String(secs));
}

// ---------------------------------------------------------------------------
// Tab shell
// ---------------------------------------------------------------------------

interface Sel {
  asset: AssetMsg;
  venue: number;
}

export function TradeTab({ connection }: { connection: GameConnection }) {
  const joined = useGame((s) => s.joined);
  const appVisible = useGame((s) => s.appVisible);
  const markets = useGame((s) => s.markets);
  const tradeAsset = useGame((s) => s.tradeAsset);
  const [sel, setSel] = useState<Sel | null>(null);

  // Markets index stream while the tab is up (see EconomyTab for the
  // joined/appVisible gating rationale). Stays on under the drill-in so the
  // list is warm on back-out and the coin page can read its row.
  useEffect(() => {
    if (!joined || !appVisible) return;
    connection.send({ t: "MarketsSub", d: { on: true } });
    return () => {
      connection.send({ t: "MarketsSub", d: { on: false } });
    };
  }, [joined, appVisible, connection]);

  // Auto-drill to a market when arriving from the economy Supply list.
  useEffect(() => {
    if (tradeAsset === null || markets === null) return;
    const row = markets.rows.find((r) => r.asset.t === "Item" && r.asset.d === tradeAsset);
    if (row) {
      const v =
        [...row.venues].sort((a, b) => b.volume_24h_wild - a.volume_24h_wild)[0]?.venue ??
        markets.venues[0]?.venue;
      if (v !== undefined) setSel({ asset: row.asset, venue: v });
    }
    useGame.getState().set({ tradeAsset: null });
  }, [tradeAsset, markets]);

  if (sel !== null && markets !== null) {
    return (
      <MarketDetailPage
        connection={connection}
        sel={sel}
        setSel={setSel}
        onBack={() => setSel(null)}
      />
    );
  }

  return (
    <MarketsPage
      rows={markets?.rows ?? []}
      syncing={markets === null}
      onOpen={(row) => {
        const v =
          [...row.venues].sort((a, b) => b.volume_24h_wild - a.volume_24h_wild)[0]
            ?.venue ?? markets?.venues[0]?.venue;
        if (v !== undefined) setSel({ asset: row.asset, venue: v });
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Markets list
// ---------------------------------------------------------------------------

/** Sort keys: "rank" is the CMC default (market cap); tapping # flips it to
 * 24h-volume ranking, the liquidity view. */
type SortKey = "rank" | "volume" | "price" | "h1" | "h24";

function MarketsPage({
  rows,
  syncing,
  onOpen,
}: {
  rows: MarketRow[];
  syncing: boolean;
  onOpen: (row: MarketRow) => void;
}) {
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [cat, setCat] = useState<Cat>("all");
  const [sortKey, setSortKey] = useState<SortKey>("rank");
  const [sortDesc, setSortDesc] = useState(true);

  // Ranks are fixed by market cap no matter the active sort (CMC pattern).
  const rank = useMemo(() => {
    const byCap = [...rows].sort((a, b) => {
      const d = b.market_cap - a.market_cap;
      return d !== 0 ? d : b.volume_24h_wild - a.volume_24h_wild;
    });
    return new Map(byCap.map((r, i) => [assetKey(r.asset), i + 1]));
  }, [rows]);

  const h1 = useMemo(() => {
    return new Map(rows.map((r) => [assetKey(r.asset), change1hBp(r)]));
  }, [rows]);

  const tapSort = (key: SortKey) => {
    if (key === "rank") {
      // # header cycles rank (cap) <-> volume ranking.
      setSortKey((k) => (k === "rank" ? "volume" : "rank"));
      setSortDesc(true);
      return;
    }
    if (sortKey === key) setSortDesc((d) => !d);
    else {
      setSortKey(key);
      setSortDesc(true);
    }
  };

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = rows.filter((r) => {
      if (cat !== "all" && catOf(r.asset) !== cat) return false;
      if (q.length > 0) {
        const name = assetLabel(r.asset).toLowerCase();
        if (!r.ticker.toLowerCase().includes(q) && !name.includes(q)) return false;
      }
      return true;
    });
    const dir = sortDesc ? -1 : 1;
    const val = (r: MarketRow): number => {
      switch (sortKey) {
        case "rank":
          // Ascending rank = descending cap; negate so dir applies cleanly.
          return -(rank.get(assetKey(r.asset)) ?? Infinity);
        case "volume":
          return r.volume_24h_wild;
        case "price":
          return r.last;
        case "h1":
          return h1.get(assetKey(r.asset)) ?? -Infinity;
        case "h24":
          return r.change_24h_bp;
      }
    };
    return [...filtered].sort((a, b) => {
      const d = val(a) - val(b);
      if (d !== 0) return d * dir;
      return a.ticker.localeCompare(b.ticker);
    });
  }, [rows, search, cat, sortKey, sortDesc, rank, h1]);

  const mark = (key: SortKey) =>
    sortKey === key ? (sortDesc ? " ▾" : " ▴") : "";

  return (
    <div className="m-tr">
      <div className="m-tr-top">
        <span className="m-tr-title">MARKETS</span>
        <span className="m-tr-top-sub">
          {syncing ? "SYNCING…" : `${rows.length} tickers · MILD`}
        </span>
        <button
          type="button"
          className={`m-tr-search-btn${searchOpen ? " active" : ""}`}
          aria-label="Search markets"
          onClick={() => {
            setSearchOpen((o) => !o);
            if (searchOpen) setSearch("");
          }}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="7" />
            <line x1="16.5" y1="16.5" x2="21" y2="21" />
          </svg>
        </button>
      </div>

      {searchOpen && (
        <div className="m-tr-search-wrap">
          <input
            className="m-tr-search"
            placeholder="Search ticker or name…"
            value={search}
            autoFocus
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      )}

      <div className="m-tr-chips">
        {CATS.map((c) => (
          <button
            key={c.id}
            type="button"
            className={`m-tr-chip${cat === c.id ? " active" : ""}`}
            onClick={() => setCat(c.id)}
          >
            {c.label}
          </button>
        ))}
      </div>

      <div className="m-tr-grid m-tr-head">
        <span />
        <button type="button" className="m-tr-col" onClick={() => tapSort("rank")}>
          {sortKey === "volume" ? "VOL" : "#"}
          {sortKey === "rank" || sortKey === "volume" ? " ▾" : ""}
        </button>
        <span />
        <span className="m-tr-col-label">MARKET</span>
        <span />
        <button type="button" className="m-tr-col num" onClick={() => tapSort("price")}>
          PRICE{mark("price")}
        </button>
        <button type="button" className="m-tr-col num" onClick={() => tapSort("h1")}>
          1H%{mark("h1")}
        </button>
        <button type="button" className="m-tr-col num" onClick={() => tapSort("h24")}>
          24H%{mark("h24")}
        </button>
      </div>

      <div className="m-tr-list m-scroll">
        {shown.length === 0 && (
          <div className="m-ag-note">
            {syncing
              ? "Syncing markets…"
              : rows.length === 0
                ? "No markets are live yet."
                : "No markets match."}
          </div>
        )}
        {shown.map((r) => {
          const key = assetKey(r.asset);
          return (
            <button
              key={key}
              type="button"
              className="m-tr-grid m-tr-row"
              onClick={() => onOpen(r)}
            >
              <i className="econ-supply-tick" style={{ background: assetTickColor(r.asset) }} />
              <span className="m-tr-rank num">{rank.get(key)}</span>
              <AssetGlyph asset={r.asset} size={26} />
              <span className="m-tr-id">
                <span className="m-tr-name">{assetLabel(r.asset)}</span>
                <span className="m-tr-ticker">{r.ticker}</span>
              </span>
              <TinySpark points={r.spark} downBp={r.change_24h_bp} />
              <span className="m-tr-price num">
                {r.last > 0 ? fmtMild(r.last) : "—"}
              </span>
              <PctCell bp={r.last > 0 ? (h1.get(key) ?? null) : null} />
              <PctCell bp={r.last > 0 ? r.change_24h_bp : null} />
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Coin-page drill-in
// ---------------------------------------------------------------------------

/** Ticking clock for tape ages (1 Hz). */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function StatCard({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="m-tr-stat">
      <span className="m-tr-stat-label">{label}</span>
      <span className="m-tr-stat-value num">{value}</span>
    </div>
  );
}

function MarketDetailPage({
  connection,
  sel,
  setSel,
  onBack,
}: {
  connection: GameConnection;
  sel: Sel;
  setSel: (s: Sel) => void;
  onBack: () => void;
}) {
  const joined = useGame((s) => s.joined);
  const appVisible = useGame((s) => s.appVisible);
  const markets = useGame((s) => s.markets);
  const rawBook = useGame((s) => s.book);
  const selKey = assetKey(sel.asset);
  // The store keeps the previous market's snapshot until the new sub answers.
  const book =
    rawBook !== null && rawBook.venue === sel.venue && assetKey(rawBook.asset) === selKey
      ? rawBook
      : null;

  const [tfSecs, setTfSecs] = useState<number>(loadTf);
  const pickTf = (secs: number) => {
    setTfSecs(secs);
    saveTf(secs);
  };

  // One live book subscription per (venue, asset, timeframe); swapping
  // markets or frames re-subs, and `joined` re-sends after a reconnect.
  useEffect(() => {
    if (!joined || !appVisible) return;
    connection.send({
      t: "BookSub",
      d: { market: { venue: sel.venue, asset: sel.asset }, tf_secs: tfSecs },
    });
    return () => {
      connection.send({ t: "BookSub", d: { market: null, tf_secs: tfSecs } });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joined, appVisible, connection, sel.venue, selKey, tfSecs]);

  const now = useNow();
  const [tab, setTab] = useState<"book" | "trades">("book");

  const row = markets?.rows.find((r) => assetKey(r.asset) === selKey) ?? null;
  const venues = markets?.venues ?? [];
  const venueName =
    venues.find((v) => v.venue === sel.venue)?.name ?? `VENUE ${sel.venue}`;
  const stats = book?.stats ?? null;
  const last = book?.last ?? row?.last ?? 0;
  const changeBp = stats?.change_24h_bp ?? row?.change_24h_bp ?? 0;
  const bestBid = book?.bids[0]?.[0] ?? 0;
  const bestAsk = book?.asks[0]?.[0] ?? 0;
  const spread = bestBid > 0 && bestAsk > 0 ? bestAsk - bestBid : null;

  const asks = (book?.asks ?? []).slice(0, 10);
  const bids = (book?.bids ?? []).slice(0, 10);
  const maxQty = Math.max(...asks.map((l) => l[1]), ...bids.map((l) => l[1]), 1);

  return (
    <div className="m-tr">
      <div className="m-tr-top m-tr-detail-top">
        <button type="button" className="m-tr-back" onClick={onBack} aria-label="Back">
          ‹
        </button>
        <AssetGlyph asset={sel.asset} size={26} />
        <span className="m-tr-id m-tr-detail-id">
          <span className="m-tr-name">{assetLabel(sel.asset)}</span>
          <span className="m-tr-ticker">
            {row?.ticker ?? assetTicker(sel.asset)} / MILD
          </span>
        </span>
      </div>

      <div className="m-tr-body m-scroll">
        <div className="m-tr-hero">
          <span className="m-tr-hero-price num">
            {last > 0 ? fmtMild(last) : "—"}
            <span className="m-tr-hero-cur"> MILD</span>
          </span>
          <span
            className={`m-tr-hero-chip num ${changeBp > 0 ? "up" : changeBp < 0 ? "down" : "flat"}`}
          >
            {last > 0
              ? `${changeBp > 0 ? "▲" : changeBp < 0 ? "▼" : ""}${(Math.abs(changeBp) / 100).toFixed(2)}%`
              : "—"}
            <span className="m-tr-hero-chip-sub"> 24h</span>
          </span>
        </div>

        {venues.length > 1 && (
          <div className="m-tr-venues">
            {venues.map((v) => (
              <button
                key={v.venue}
                type="button"
                className={`m-tr-chip${v.venue === sel.venue ? " active" : ""}`}
                onClick={() => setSel({ asset: sel.asset, venue: v.venue })}
              >
                {v.name}
              </button>
            ))}
          </div>
        )}

        <div className="m-tr-tfs">
          {TIMEFRAMES.map((tf) => (
            <button
              key={tf.secs}
              type="button"
              className={`m-tr-tf${tf.secs === tfSecs ? " active" : ""}`}
              onClick={() => pickTf(tf.secs)}
            >
              {tf.label}
            </button>
          ))}
        </div>
        <div className="m-tr-chart">
          <TradeChart
            candles={book !== null && book.tf_secs === tfSecs ? book.candles : null}
            tfSecs={tfSecs}
            resetKey={`${sel.venue}:${selKey}:${tfSecs}`}
          />
        </div>

        <div className="m-tr-stats">
          <StatCard
            label="24H HIGH / LOW"
            value={
              stats && stats.high_24h > 0
                ? `${fmtMild(stats.high_24h)} / ${fmtMild(stats.low_24h)}`
                : "—"
            }
          />
          <StatCard
            label="24H VOLUME"
            value={
              stats
                ? `${fmtCompact(stats.volume_24h_wild)} MILD${
                    stats.volume_24h_units > 0
                      ? ` · ${fmtCompact(stats.volume_24h_units)}u`
                      : ""
                  }`
                : "—"
            }
          />
          <StatCard
            label="MARKET CAP"
            value={row && row.market_cap > 0 ? `${fmtCompact(row.market_cap)} MILD` : "—"}
          />
          <StatCard
            label="SUPPLY"
            value={
              row && row.supply > 0
                ? `${fmtCompact(row.supply)} ${row.ticker}`
                : "—"
            }
          />
          <StatCard
            label="BEST BID / ASK"
            value={
              <>
                <span style={{ color: bestBid > 0 ? UP : undefined }}>
                  {bestBid > 0 ? fmtMild(bestBid) : "—"}
                </span>
                {" / "}
                <span style={{ color: bestAsk > 0 ? DOWN : undefined }}>
                  {bestAsk > 0 ? fmtMild(bestAsk) : "—"}
                </span>
              </>
            }
          />
          <StatCard
            label="SPREAD"
            value={
              spread !== null
                ? `${fmtMild(spread)} (${((spread / bestAsk) * 100).toFixed(1)}%)`
                : "—"
            }
          />
        </div>

        <div className="m-tr-tabs">
          <button
            type="button"
            className={`m-tr-tab${tab === "book" ? " active" : ""}`}
            onClick={() => setTab("book")}
          >
            ORDER BOOK
          </button>
          <button
            type="button"
            className={`m-tr-tab${tab === "trades" ? " active" : ""}`}
            onClick={() => setTab("trades")}
          >
            TRADES
          </button>
          <span className="m-tr-tabs-venue">{venueName.toUpperCase()}</span>
        </div>

        {tab === "book" && (
          <div className="m-tr-ladder">
            {asks.length === 0 && bids.length === 0 && (
              <div className="m-ag-note">
                {book === null ? "Loading book…" : "Empty book at this venue."}
              </div>
            )}
            {[...asks].reverse().map(([price, qty]) => (
              <div key={`a${price}`} className="m-tr-level">
                <span
                  className="m-tr-level-bar ask"
                  style={{ width: `${(qty / maxQty) * 100}%` }}
                />
                <span className="num" style={{ color: DOWN }}>
                  {fmtMild(price)}
                </span>
                <span className="num">{fmtMild(qty)}</span>
              </div>
            ))}
            {spread !== null && (
              <div className="m-tr-spread num">
                SPREAD {fmtMild(spread)} ({((spread / bestAsk) * 100).toFixed(2)}%)
              </div>
            )}
            {bids.map(([price, qty]) => (
              <div key={`b${price}`} className="m-tr-level">
                <span
                  className="m-tr-level-bar bid"
                  style={{ width: `${(qty / maxQty) * 100}%` }}
                />
                <span className="num" style={{ color: UP }}>
                  {fmtMild(price)}
                </span>
                <span className="num">{fmtMild(qty)}</span>
              </div>
            ))}
          </div>
        )}

        {tab === "trades" && (
          <div className="m-tr-tape">
            {(book?.tape ?? []).length === 0 && (
              <div className="m-ag-note">
                {book === null ? "Loading trades…" : "No recent trades."}
              </div>
            )}
            {(book?.tape ?? []).map((t, i) => (
              <div key={`${t.t}-${i}`} className="m-tr-level m-tr-print">
                <span className="num m-tr-print-age">{formatAge(t.t, now)}</span>
                <span className="num" style={{ color: t.side === "Bid" ? UP : DOWN }}>
                  {fmtMild(t.price)}
                </span>
                <span className="num">{fmtMild(t.qty)}</span>
              </div>
            ))}
          </div>
        )}

        <div className="m-tr-desk-note">
          <span className="m-tr-desk-pill">TRADE ON DESKTOP</span>
          <span className="m-tr-desk-sub">
            Order entry is desk-side only — stand at a Market Terminal in game
            to place orders.
          </span>
        </div>
      </div>
    </div>
  );
}
