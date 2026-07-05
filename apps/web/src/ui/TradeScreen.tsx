// Fullscreen exchange Trade screen (T key / Market Terminal), a menu tab like
// the economy dashboard. Two views:
//  - Markets: searchable/sortable cross-venue ticker table (MarketsSub) with
//    an expandable per-venue arbitrage breakdown per row.
//  - Market detail: one (venue, asset) book (BookSub) — candle chart, order
//    ladder, trades tape, and a venue-gated order entry panel, plus bottom
//    tabs for open orders / recent trades / settlement inboxes.
//
// Market data is viewable from anywhere; placing/cancelling orders and
// claiming settlement require standing at the venue's terminal (the server
// enforces it — the client gating is UX).

import { useEffect, useMemo, useRef, useState } from "react";
import { GameConnection } from "../net/connection";
import {
  AssetMsg,
  BookStateMsg,
  CandleMsg,
  ItemKind,
  MarketRow,
  OrderMsg,
  SideMsg,
  VenueInfo,
} from "../net/protocol";
import { cameraState } from "../render/CameraRig";
import { game, useGame } from "../state/game";
import { fmtCompact, fmtMild, formatAge } from "./format";
import { FeedIcon, ITEM_INFO, ItemIcon, itemLabel } from "./ItemIcon";
import { fmtUsd, useWildUsd } from "./useWildUsd";

// ---------------------------------------------------------------------------
// Shared constants / asset helpers
// ---------------------------------------------------------------------------

/** Taker fee (percent, mirror of the server's MARKET_FEE_PCT). */
const FEE_PCT = 5;
/** "At the venue terminal" radius (m) — mirrors the server interact range,
 * with a little slack for the anchor sitting proud of the counter. */
const AT_VENUE_M = 6;

const UP = "#7be0c2";
const DOWN = "#ff6a7c";

/** Stable identity key for an AssetMsg (map keys, effect deps). */
export function assetKey(a: AssetMsg): string {
  return a.t === "Item" ? `Item:${a.d}` : a.t;
}

export function assetLabel(a: AssetMsg): string {
  if (a.t === "Item") return itemLabel(a.d);
  return a.t === "Shards" ? "Shards" : "Energy";
}

/** Fallback ticker when a market row isn't at hand (server rows carry the
 * canonical one). */
export function assetTicker(a: AssetMsg): string {
  if (a.t === "Item") return ITEM_INFO[a.d]?.ticker ?? a.d.toUpperCase();
  return a.t === "Shards" ? "SHARD" : "NRG";
}

export function AssetGlyph({ asset, size = 18 }: { asset: AssetMsg; size?: number }) {
  if (asset.t === "Item") return <ItemIcon kind={asset.d} size={size} />;
  return <FeedIcon kind={asset.t === "Shards" ? "shards" : "energy"} size={size} />;
}

/** Coarse market categories for the filter chips. */
type MarketCat = "resource" | "material" | "gear" | "currency";

function marketCat(a: AssetMsg): MarketCat {
  if (a.t !== "Item") return "currency";
  const c = ITEM_INFO[a.d]?.category;
  if (c === "resource") return "resource";
  if (c === "material") return "material";
  if (c === "currency") return "currency";
  return "gear";
}

/** Basis points -> signed percent string ("+2.50%"). */
function fmtBp(bp: number): string {
  const pct = bp / 100;
  return `${pct > 0 ? "+" : ""}${pct.toFixed(2)}%`;
}

function changeColor(bp: number): string | undefined {
  if (bp > 0) return UP;
  if (bp < 0) return DOWN;
  return undefined;
}

/** "1,234 MILD" or an em-dash for empty book sides / never-traded markets. */
function priceOrDash(p: number): string {
  return p > 0 ? fmtMild(p) : "—";
}

// ---------------------------------------------------------------------------
// Favorites (persisted)
// ---------------------------------------------------------------------------

const FAVS_KEY = "wilder.trade.favs";

function loadFavs(): Set<string> {
  if (typeof localStorage === "undefined") return new Set();
  try {
    const raw = JSON.parse(localStorage.getItem(FAVS_KEY) ?? "[]");
    return new Set(Array.isArray(raw) ? (raw as string[]) : []);
  } catch {
    return new Set();
  }
}

function saveFavs(favs: Set<string>): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(FAVS_KEY, JSON.stringify([...favs]));
}

// ---------------------------------------------------------------------------
// Venue proximity: which venue terminal (if any) the player is standing at
// ---------------------------------------------------------------------------

interface VenueProximity {
  /** Venue the player counts as standing at, or null when away from all. */
  atId: number | null;
  /** Distance (m) to every venue anchor, by venue id. */
  dist: Record<number, number>;
}

/**
 * Polls the player's distance to every venue anchor (~2 Hz). Standing "at" a
 * venue means being within interact range of its terminal anchor — or inside
 * its walk-in room, which `nearMarket` (ProximityTracker) covers: the anchor
 * sits out on the sidewalk, so the interior check rides that flag as long as
 * this venue is the nearest one.
 */
function useVenueProximity(venues: VenueInfo[], active: boolean): VenueProximity {
  const nearMarket = useGame((s) => s.nearMarket);
  const [prox, setProx] = useState<VenueProximity>({ atId: null, dist: {} });
  useEffect(() => {
    if (!active) return;
    const read = () => {
      const dist: Record<number, number> = {};
      let nearest: number | null = null;
      let best = Infinity;
      for (const v of venues) {
        const d = Math.hypot(v.x - game.predicted.x, v.z - game.predicted.z);
        dist[v.venue] = d;
        if (d < best) {
          best = d;
          nearest = v.venue;
        }
      }
      const atId =
        nearest !== null && (best <= AT_VENUE_M || (nearMarket && best <= 30))
          ? nearest
          : null;
      setProx((prev) => {
        if (
          prev.atId === atId &&
          venues.every((v) => Math.round(prev.dist[v.venue] ?? -1) === Math.round(dist[v.venue]))
        ) {
          return prev;
        }
        return { atId, dist };
      });
    };
    read();
    const timer = setInterval(read, 500);
    return () => clearInterval(timer);
  }, [venues, nearMarket, active]);
  return prox;
}

// ---------------------------------------------------------------------------
// Screen shell
// ---------------------------------------------------------------------------

/** Selected market of the detail view. */
interface Selection {
  asset: AssetMsg;
  venue: number;
}

export function TradeScreen({ connection }: { connection: GameConnection }) {
  const open = useGame((s) => s.menuOpen && s.menuTab === "trade");
  const joined = useGame((s) => s.joined);
  const markets = useGame((s) => s.markets);
  const tradeVenue = useGame((s) => s.tradeVenue);
  const [sel, setSel] = useState<Selection | null>(null);
  const selRef = useRef(sel);
  selRef.current = sel;

  // Markets-index stream while the screen is up (gate on `joined` so the sub
  // is re-sent after a reconnect; see EconomyDashboard for the rationale).
  useEffect(() => {
    if (!open || !joined) return;
    connection.send({ t: "MarketsSub", d: { on: true } });
    return () => {
      connection.send({ t: "MarketsSub", d: { on: false } });
    };
  }, [open, joined, connection]);

  // Opening at a Market Terminal scopes the screen to that venue: a market
  // detail left open from a previous visit re-targets its book and order
  // entry to the terminal being used now.
  useEffect(() => {
    if (!open || tradeVenue === null) return;
    setSel((prev) =>
      prev && prev.venue !== tradeVenue ? { asset: prev.asset, venue: tradeVenue } : prev,
    );
  }, [open, tradeVenue]);

  // Closing spends the Escape/click: suppress the pointer-lock bounce so it
  // does not read as an "open game menu" Escape (see CameraRig).
  const close = () => {
    cameraState.suppressMenuUntil = performance.now() + 1500;
    useGame.getState().closeMenu();
  };

  // Escape backs out of the market detail first, then closes the menu.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      if (e.code === "Escape") {
        if (selRef.current) setSel(null);
        else close();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const venues = markets?.venues ?? [];
  const prox = useVenueProximity(venues, open);
  const wildUsd = useWildUsd();

  if (!open) return null;

  /** Open the detail view for an asset: prefer an explicitly clicked venue,
   * then the terminal the screen was scoped to, then the busiest venue. */
  const openMarket = (row: MarketRow, venue?: number) => {
    let v = venue ?? null;
    if (v === null && tradeVenue !== null && venues.some((x) => x.venue === tradeVenue)) {
      v = tradeVenue;
    }
    if (v === null && row.venues.length > 0) {
      v = [...row.venues].sort((a, b) => b.volume_24h_wild - a.volume_24h_wild)[0].venue;
    }
    if (v === null && venues.length > 0) v = venues[0].venue;
    if (v === null) return;
    setSel({ asset: row.asset, venue: v });
  };

  return (
    <div className="map-overlay trade-overlay">
      {markets === null ? (
        <div className="econ-empty trade-syncing">SYNCING MARKETS…</div>
      ) : sel === null ? (
        <MarketsView rows={markets.rows} venues={venues} onOpen={openMarket} wildUsd={wildUsd} />
      ) : (
        <MarketDetail
          connection={connection}
          sel={sel}
          setSel={setSel}
          rows={markets.rows}
          venues={venues}
          prox={prox}
          wildUsd={wildUsd}
          onBack={() => setSel(null)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Markets view
// ---------------------------------------------------------------------------

type SortKey = "cap" | "price" | "change" | "volume" | "supply";

const MARKET_CHIPS: { id: MarketCat | "all" | "fav"; label: string }[] = [
  { id: "fav", label: "★ FAVORITES" },
  { id: "all", label: "ALL" },
  { id: "resource", label: "RESOURCES" },
  { id: "material", label: "MATERIALS" },
  { id: "gear", label: "GEAR" },
  { id: "currency", label: "CURRENCY" },
];

/** CMC-style 24h sparkline: pure-SVG close-price polyline colored by the
 * row's 24h direction. */
function Spark({ points, changeBp }: { points: number[]; changeBp: number }) {
  if (points.length < 2) return <span className="trade-spark-empty">—</span>;
  const w = 104;
  const h = 30;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = Math.max(1, max - min);
  const step = w / (points.length - 1);
  const path = points
    .map((p, i) => `${(i * step).toFixed(1)},${(h - 3 - ((p - min) / span) * (h - 6)).toFixed(1)}`)
    .join(" ");
  const color = changeBp < 0 ? DOWN : UP;
  return (
    <svg className="trade-spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
      <polyline points={path} fill="none" stroke={color} strokeWidth="1.4" />
    </svg>
  );
}

function MarketsView({
  rows,
  venues,
  onOpen,
  wildUsd,
}: {
  rows: MarketRow[];
  venues: VenueInfo[];
  onOpen: (row: MarketRow, venue?: number) => void;
  wildUsd: number | null;
}) {
  const [search, setSearch] = useState("");
  const [chip, setChip] = useState<MarketCat | "all" | "fav">("all");
  const [favs, setFavs] = useState<Set<string>>(loadFavs);
  const [sortKey, setSortKey] = useState<SortKey>("cap");
  const [sortDesc, setSortDesc] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);

  const venueName = useMemo(
    () => new Map(venues.map((v) => [v.venue, v.name])),
    [venues],
  );

  // CMC-style ranks are fixed by market cap no matter the active sort.
  const rank = useMemo(() => {
    const byCap = [...rows].sort((a, b) => {
      const d = b.market_cap - a.market_cap;
      return d !== 0 ? d : a.ticker.localeCompare(b.ticker);
    });
    return new Map(byCap.map((r, i) => [assetKey(r.asset), i + 1]));
  }, [rows]);

  const toggleFav = (key: string) => {
    setFavs((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      saveFavs(next);
      return next;
    });
  };

  const setSort = (key: SortKey) => {
    if (sortKey === key) setSortDesc((d) => !d);
    else {
      setSortKey(key);
      setSortDesc(true);
    }
  };

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = rows.filter((r) => {
      if (chip === "fav" && !favs.has(assetKey(r.asset))) return false;
      if (chip !== "all" && chip !== "fav" && marketCat(r.asset) !== chip) return false;
      if (q.length > 0) {
        const name = assetLabel(r.asset).toLowerCase();
        if (!r.ticker.toLowerCase().includes(q) && !name.includes(q)) return false;
      }
      return true;
    });
    const dir = sortDesc ? -1 : 1;
    const val = (r: MarketRow) =>
      sortKey === "cap"
        ? r.market_cap
        : sortKey === "volume"
          ? r.volume_24h_wild
          : sortKey === "change"
            ? r.change_24h_bp
            : sortKey === "supply"
              ? r.supply
              : r.last;
    return [...filtered].sort((a, b) => {
      const d = val(a) - val(b);
      if (d !== 0) return d * dir;
      return a.ticker.localeCompare(b.ticker);
    });
  }, [rows, search, chip, favs, sortKey, sortDesc]);

  const sortMark = (key: SortKey) =>
    sortKey === key ? (sortDesc ? " ▼" : " ▲") : "";

  return (
    <div className="econ-panel trade-mkts">
      <div className="econ-panel-title">
        MARKETS
        <span className="econ-panel-sub">
          {rows.length} TICKERS · {venues.length} VENUES · QUOTED IN MILD
          {wildUsd !== null && ` · WILD ${fmtUsd(wildUsd)}`}
        </span>
      </div>
      <div className="trade-toolbar">
        <input
          className="trade-search"
          placeholder="Search ticker or name…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="econ-tabs trade-chips">
          {MARKET_CHIPS.map((c) => (
            <div
              key={c.id}
              className={`econ-tab ${chip === c.id ? "active" : ""}`}
              onClick={() => setChip(c.id)}
            >
              {c.label}
            </div>
          ))}
        </div>
      </div>
      <div className="trade-mkt-row trade-mkt-head">
        <span />
        <span className="num">#</span>
        <span>NAME</span>
        <span className="num trade-sort" onClick={() => setSort("price")}>
          PRICE{sortMark("price")}
        </span>
        <span className="num trade-sort" onClick={() => setSort("change")}>
          24H %{sortMark("change")}
        </span>
        <span className="num trade-sort" onClick={() => setSort("cap")}>
          MARKET CAP{sortMark("cap")}
        </span>
        <span className="num trade-sort" onClick={() => setSort("volume")}>
          VOLUME (24H){sortMark("volume")}
        </span>
        <span className="num trade-sort" onClick={() => setSort("supply")}>
          CIRCULATING SUPPLY{sortMark("supply")}
        </span>
        <span className="num">24H PRICE</span>
        <span />
      </div>
      <div className="trade-mkt-list">
        {shown.length === 0 && (
          <div className="econ-empty">
            {rows.length === 0 ? "No markets are live yet." : "No markets match."}
          </div>
        )}
        {shown.map((r) => {
          const key = assetKey(r.asset);
          const isExpanded = expanded === key;
          return (
            <div key={key} className="trade-mkt-group">
              <div className="trade-mkt-row trade-mkt-link" onClick={() => onOpen(r)}>
                <span
                  className={`trade-star${favs.has(key) ? " active" : ""}`}
                  title={favs.has(key) ? "Unfavorite" : "Favorite"}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleFav(key);
                  }}
                >
                  {favs.has(key) ? "★" : "☆"}
                </span>
                <span className="num trade-mkt-rank">{rank.get(key)}</span>
                <span className="trade-mkt-id">
                  <AssetGlyph asset={r.asset} size={20} />
                  <span className="trade-mkt-name">{assetLabel(r.asset)}</span>
                  <span className="trade-mkt-ticker">{r.ticker}</span>
                </span>
                <span className="num trade-cell-2l">
                  {wildUsd !== null && r.last > 0 ? (
                    <>
                      <span>{fmtUsd(r.last * wildUsd)}</span>
                      <span className="trade-cell-sub">{fmtMild(r.last)} MILD</span>
                    </>
                  ) : (
                    <span>{priceOrDash(r.last)}</span>
                  )}
                </span>
                <span className="num" style={{ color: changeColor(r.change_24h_bp) }}>
                  {r.last > 0 ? fmtBp(r.change_24h_bp) : "—"}
                </span>
                <span className="num trade-cell-2l">
                  <span>{r.market_cap > 0 ? `${fmtCompact(r.market_cap)} WILD` : "—"}</span>
                  {wildUsd !== null && r.market_cap > 0 && (
                    <span className="trade-cell-sub">{fmtUsd(r.market_cap * wildUsd)}</span>
                  )}
                </span>
                <span className="num trade-cell-2l">
                  <span>{fmtCompact(r.volume_24h_wild)} MILD</span>
                  {wildUsd !== null && r.volume_24h_wild > 0 && (
                    <span className="trade-cell-sub">{fmtUsd(r.volume_24h_wild * wildUsd)}</span>
                  )}
                </span>
                <span className="num">
                  {r.supply > 0 ? `${fmtCompact(r.supply)} ${r.ticker}` : "—"}
                </span>
                <span className="num trade-spark-cell">
                  <Spark points={r.spark} changeBp={r.change_24h_bp} />
                </span>
                <span
                  className={`trade-chevron${isExpanded ? " open" : ""}`}
                  title="Per-venue breakdown"
                  onClick={(e) => {
                    e.stopPropagation();
                    setExpanded(isExpanded ? null : key);
                  }}
                >
                  ▾
                </span>
              </div>
              {isExpanded && (
                <div className="trade-venues-sub">
                  {r.venues.length === 0 && (
                    <div className="econ-empty">No venue has a live book for this asset yet.</div>
                  )}
                  {r.venues.length > 0 && (
                    <div className="trade-venue-row trade-venue-head">
                      <span>VENUE</span>
                      <span className="num">LAST</span>
                      <span className="num">BEST BID</span>
                      <span className="num">BEST ASK</span>
                      <span className="num">24H VOLUME</span>
                      <span />
                    </div>
                  )}
                  {r.venues.map((v) => (
                    <div
                      key={v.venue}
                      className="trade-venue-row"
                      onClick={() => onOpen(r, v.venue)}
                      title={`Trade ${r.ticker} at ${venueName.get(v.venue) ?? `Venue ${v.venue}`}`}
                    >
                      <span className="trade-venue-name">
                        {venueName.get(v.venue) ?? `VENUE ${v.venue}`}
                      </span>
                      <span className="num">{priceOrDash(v.last)}</span>
                      <span className="num" style={{ color: v.best_bid > 0 ? UP : undefined }}>
                        {priceOrDash(v.best_bid)}
                      </span>
                      <span className="num" style={{ color: v.best_ask > 0 ? DOWN : undefined }}>
                        {priceOrDash(v.best_ask)}
                      </span>
                      <span className="num">{fmtCompact(v.volume_24h_wild)} MILD</span>
                      <span className="trade-venue-go">TRADE ›</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Market detail
// ---------------------------------------------------------------------------

function MarketDetail({
  connection,
  sel,
  setSel,
  rows,
  venues,
  prox,
  wildUsd,
  onBack,
}: {
  connection: GameConnection;
  sel: Selection;
  setSel: (s: Selection) => void;
  rows: MarketRow[];
  venues: VenueInfo[];
  prox: VenueProximity;
  wildUsd: number | null;
  onBack: () => void;
}) {
  const joined = useGame((s) => s.joined);
  const rawBook = useGame((s) => s.book);
  const selKey = assetKey(sel.asset);
  // The store keeps the previous market's snapshot until the new sub answers.
  const book =
    rawBook !== null && rawBook.venue === sel.venue && assetKey(rawBook.asset) === selKey
      ? rawBook
      : null;

  const row = rows.find((r) => assetKey(r.asset) === selKey) ?? null;
  const venue = venues.find((v) => v.venue === sel.venue) ?? null;
  const venueName = venue?.name ?? `VENUE ${sel.venue}`;

  // One live book subscription per (venue, asset); swapping markets re-subs.
  useEffect(() => {
    if (!joined) return;
    connection.send({
      t: "BookSub",
      d: { market: { venue: sel.venue, asset: sel.asset } },
    });
    return () => {
      connection.send({ t: "BookSub", d: { market: null } });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joined, connection, sel.venue, selKey]);

  // Order entry prefill from the ladder (click a level).
  const [prefillPrice, setPrefillPrice] = useState<number | null>(null);

  const bestBid = book?.bids[0]?.[0] ?? 0;
  const bestAsk = book?.asks[0]?.[0] ?? 0;
  const spread = bestBid > 0 && bestAsk > 0 ? bestAsk - bestBid : null;
  const stats = book?.stats ?? null;
  const atVenue = prox.atId === sel.venue;
  const distToVenue = prox.dist[sel.venue];

  const perVenueLast = useMemo(() => {
    const map = new Map<number, number>();
    for (const v of row?.venues ?? []) map.set(v.venue, v.last);
    return map;
  }, [row]);

  return (
    <div className="trade-detail">
      <div className="trade-detail-head">
        <button className="trade-back" onClick={onBack} title="Back to markets (ESC)">
          ‹
        </button>
        <span className="trade-mkt-id trade-detail-id">
          <AssetGlyph asset={sel.asset} size={24} />
          <span className="trade-mkt-ticker">{row?.ticker ?? assetTicker(sel.asset)}</span>
          <span className="trade-mkt-name">{assetLabel(sel.asset)}</span>
        </span>
        <div className="trade-venue-pills">
          {venues.map((v) => {
            const last = perVenueLast.get(v.venue) ?? 0;
            return (
              <div
                key={v.venue}
                className={`trade-venue-pill${v.venue === sel.venue ? " active" : ""}`}
                onClick={() => setSel({ asset: sel.asset, venue: v.venue })}
                title={`${v.name}${prox.atId === v.venue ? " (you are here)" : ""}`}
              >
                <span className="trade-venue-pill-name">
                  {prox.atId === v.venue ? "◉ " : ""}
                  {v.name}
                </span>
                <span className="trade-venue-pill-last num">{priceOrDash(last)}</span>
              </div>
            );
          })}
        </div>
        <div className="trade-stats">
          <div className="trade-stat trade-stat-last">
            <span className="trade-stat-label">LAST</span>
            <span
              className="trade-stat-value trade-last num"
              style={{ color: changeColor(stats?.change_24h_bp ?? 0) }}
            >
              {priceOrDash(book?.last ?? 0)}
            </span>
            {wildUsd !== null && (book?.last ?? 0) > 0 && (
              <span className="trade-stat-usd num">{fmtUsd((book?.last ?? 0) * wildUsd)}</span>
            )}
          </div>
          <div className="trade-stat">
            <span className="trade-stat-label">24H CHANGE</span>
            <span
              className="trade-stat-value num"
              style={{ color: changeColor(stats?.change_24h_bp ?? 0) }}
            >
              {stats ? fmtBp(stats.change_24h_bp) : "—"}
            </span>
          </div>
          <div className="trade-stat">
            <span className="trade-stat-label">24H HIGH / LOW</span>
            <span className="trade-stat-value num">
              {stats && stats.high_24h > 0
                ? `${fmtMild(stats.high_24h)} / ${fmtMild(stats.low_24h)}`
                : "—"}
            </span>
          </div>
          <div className="trade-stat">
            <span className="trade-stat-label">24H VOLUME</span>
            <span className="trade-stat-value num">
              {stats ? `${fmtCompact(stats.volume_24h_wild)} MILD` : "—"}
              {stats && stats.volume_24h_units > 0 && (
                <span className="trade-stat-sub"> · {fmtCompact(stats.volume_24h_units)} u</span>
              )}
            </span>
          </div>
          <div className="trade-stat">
            <span className="trade-stat-label">BID / ASK</span>
            <span className="trade-stat-value num">
              <span style={{ color: bestBid > 0 ? UP : undefined }}>{priceOrDash(bestBid)}</span>
              {" / "}
              <span style={{ color: bestAsk > 0 ? DOWN : undefined }}>{priceOrDash(bestAsk)}</span>
            </span>
          </div>
          <div className="trade-stat">
            <span className="trade-stat-label">SPREAD</span>
            <span className="trade-stat-value num">
              {spread !== null
                ? `${fmtMild(spread)} (${((spread / bestAsk) * 100).toFixed(1)}%)`
                : "—"}
            </span>
          </div>
        </div>
      </div>

      <div className="trade-detail-grid">
        <div className="trade-panel trade-chart-panel">
          <div className="trade-panel-title">
            PRICE — {venueName.toUpperCase()}
            <span className="econ-panel-sub">1M CANDLES · ~3H</span>
          </div>
          <CandleChart candles={book?.candles ?? []} last={book?.last ?? 0} />
        </div>
        <BookAndTape book={book} onPickPrice={(p) => setPrefillPrice(p)} />
        <OrderPanel
          connection={connection}
          sel={sel}
          book={book}
          row={row}
          venueName={venueName}
          atVenue={atVenue}
          distToVenue={distToVenue}
          prefillPrice={prefillPrice}
        />
      </div>

      <BottomStrip
        connection={connection}
        book={book}
        rows={rows}
        venues={venues}
        prox={prox}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Candle chart (pure SVG, sibling of EconomyDashboard's PriceChart)
// ---------------------------------------------------------------------------

function candleClock(t: number): string {
  return new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/**
 * Minute OHLCV candles with a volume strip beneath and a dashed last-price
 * line. Index-scaled x (candles are contiguous minutes), fixed virtual canvas
 * scaled to its container. No chart library.
 */
function CandleChart({ candles, last }: { candles: CandleMsg[]; last: number }) {
  const [hover, setHover] = useState<number | null>(null);

  const W = 760;
  const H = 340;
  const PAD_T = 12;
  const PAD_R = 58;
  const VOL_H = 42;
  const AXIS_H = 18;
  const plotW = W - PAD_R;
  const plotH = H - PAD_T - VOL_H - AXIS_H - 10;
  const volTop = PAD_T + plotH + 6;

  if (candles.length === 0) {
    return (
      <div className="econ-empty econ-chart-empty">No trades at this venue yet.</div>
    );
  }

  let yMin = Infinity;
  let yMax = -Infinity;
  for (const c of candles) {
    yMin = Math.min(yMin, c.low);
    yMax = Math.max(yMax, c.high);
  }
  if (last > 0) {
    yMin = Math.min(yMin, last);
    yMax = Math.max(yMax, last);
  }
  const pad = Math.max((yMax - yMin) * 0.1, Math.max(1, yMax * 0.04));
  yMin = Math.max(0, yMin - pad);
  yMax = yMax + pad;

  const n = candles.length;
  const step = plotW / Math.max(n, 30);
  const x = (i: number) => plotW - (n - i - 0.5) * step;
  const y = (v: number) => PAD_T + (1 - (v - yMin) / Math.max(1e-6, yMax - yMin)) * plotH;
  const bodyW = Math.max(1.5, Math.min(10, step * 0.62));

  const maxVol = Math.max(...candles.map((c) => c.volume_wild), 1);
  const gridLevels = [0, 1 / 3, 2 / 3, 1].map((f) => yMin + f * (yMax - yMin));
  const timeMarks = [0, 0.5, 1]
    .map((f) => Math.min(n - 1, Math.round(f * (n - 1))))
    .filter((v, i, arr) => arr.indexOf(v) === i);
  const h = hover !== null ? candles[hover] : null;

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const vx = ((e.clientX - rect.left) / rect.width) * W;
    // Invert x(i) = plotW - (n - i - 0.5) * step for the nearest index.
    const i = Math.round(n - 0.5 - (plotW - vx) / step);
    setHover(Math.max(0, Math.min(n - 1, i)));
  };

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="econ-chart trade-chart"
      onMouseMove={onMove}
      onMouseLeave={() => setHover(null)}
    >
      {gridLevels.map((v, i) => (
        <g key={i}>
          <line
            x1={0}
            y1={y(v)}
            x2={plotW}
            y2={y(v)}
            stroke="rgba(159,180,200,0.14)"
            strokeWidth="1"
          />
          <text x={plotW + 8} y={y(v) + 3.5} fill="#7f8ea0" fontSize="11">
            {Math.round(v).toLocaleString()}
          </text>
        </g>
      ))}

      {/* last-price marker */}
      {last > 0 && (
        <g>
          <line
            x1={0}
            y1={y(last)}
            x2={plotW}
            y2={y(last)}
            stroke="rgba(79,195,255,0.5)"
            strokeWidth="1"
            strokeDasharray="4 4"
          />
          <rect x={plotW + 2} y={y(last) - 8} width={PAD_R - 4} height={16} fill="rgba(8,14,20,0.92)" stroke="rgba(79,195,255,0.5)" strokeWidth="1" />
          <text x={plotW + 8} y={y(last) + 3.5} fill="#cdeeff" fontSize="11" fontWeight="700">
            {Math.round(last).toLocaleString()}
          </text>
        </g>
      )}

      {/* candles */}
      {candles.map((c, i) => {
        const up = c.close >= c.open;
        const color = up ? UP : DOWN;
        const cx = x(i);
        const top = y(Math.max(c.open, c.close));
        const bot = y(Math.min(c.open, c.close));
        return (
          <g key={c.t} opacity={hover === null || hover === i ? 1 : 0.55}>
            <line x1={cx} y1={y(c.high)} x2={cx} y2={y(c.low)} stroke={color} strokeWidth="1" />
            <rect
              x={cx - bodyW / 2}
              y={top}
              width={bodyW}
              height={Math.max(1, bot - top)}
              fill={color}
            />
            <rect
              x={cx - bodyW / 2}
              y={volTop + (1 - c.volume_wild / maxVol) * VOL_H}
              width={bodyW}
              height={Math.max(1, (c.volume_wild / maxVol) * VOL_H)}
              fill={color}
              opacity="0.45"
            />
          </g>
        );
      })}

      {/* time axis */}
      {timeMarks.map((i, k) => (
        <text
          key={i}
          x={Math.min(Math.max(x(i), 4), plotW - 4)}
          y={H - 4}
          fill="#7f8ea0"
          fontSize="11"
          textAnchor={k === 0 ? "start" : k === timeMarks.length - 1 ? "end" : "middle"}
        >
          {candleClock(candles[i].t)}
        </text>
      ))}

      {/* hover crosshair + OHLCV readout */}
      {h && hover !== null && (
        <g pointerEvents="none">
          <line
            x1={x(hover)}
            y1={PAD_T}
            x2={x(hover)}
            y2={volTop + VOL_H}
            stroke="rgba(234,247,255,0.35)"
            strokeWidth="1"
            strokeDasharray="3 3"
          />
          <g transform={`translate(${Math.min(Math.max(x(hover) - 105, 2), plotW - 214)}, ${PAD_T})`}>
            <rect width="212" height="34" rx="2" fill="rgba(8,14,20,0.92)" stroke="rgba(79,195,255,0.35)" strokeWidth="1" />
            <text x="8" y="14" fill="#eaf7ff" fontSize="11.5" fontWeight="700">
              O {fmtMild(h.open)}  H {fmtMild(h.high)}  L {fmtMild(h.low)}  C {fmtMild(h.close)}
            </text>
            <text x="8" y="27" fill="#7f8ea0" fontSize="10.5">
              {fmtMild(h.volume_units)} units · {fmtMild(h.volume_wild)} MILD · {candleClock(h.t)}
            </text>
          </g>
        </g>
      )}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Order book ladder + trades tape (middle column, tabbed)
// ---------------------------------------------------------------------------

const LADDER_LEVELS = 12;

function BookAndTape({
  book,
  onPickPrice,
}: {
  book: BookStateMsg | null;
  onPickPrice: (price: number) => void;
}) {
  const [tab, setTab] = useState<"book" | "trades">("book");
  return (
    <div className="trade-panel trade-book-panel">
      <div className="econ-tabs trade-book-tabs">
        <div
          className={`econ-tab ${tab === "book" ? "active" : ""}`}
          onClick={() => setTab("book")}
        >
          ORDER BOOK
        </div>
        <div
          className={`econ-tab ${tab === "trades" ? "active" : ""}`}
          onClick={() => setTab("trades")}
        >
          TRADES
        </div>
      </div>
      {tab === "book" ? (
        <BookLadder book={book} onPickPrice={onPickPrice} />
      ) : (
        <TapeList book={book} />
      )}
    </div>
  );
}

function BookLadder({
  book,
  onPickPrice,
}: {
  book: BookStateMsg | null;
  onPickPrice: (price: number) => void;
}) {
  if (!book) return <div className="econ-empty">Loading book…</div>;

  // Best-first slices; cumulative size accumulates away from the spread.
  const asks = book.asks.slice(0, LADDER_LEVELS);
  const bids = book.bids.slice(0, LADDER_LEVELS);
  let cum = 0;
  const askRows = asks.map(([price, qty]) => ({ price, qty, cum: (cum += qty) }));
  cum = 0;
  const bidRows = bids.map(([price, qty]) => ({ price, qty, cum: (cum += qty) }));
  const maxCum = Math.max(
    askRows[askRows.length - 1]?.cum ?? 0,
    bidRows[bidRows.length - 1]?.cum ?? 0,
    1,
  );

  const bestBid = bids[0]?.[0] ?? 0;
  const bestAsk = asks[0]?.[0] ?? 0;
  const spread = bestBid > 0 && bestAsk > 0 ? bestAsk - bestBid : null;

  return (
    <div className="trade-ladder">
      <div className="trade-book-row trade-book-head">
        <span>PRICE</span>
        <span className="num">SIZE</span>
        <span className="num">TOTAL</span>
      </div>
      <div className="trade-ladder-side asks">
        {askRows.length === 0 && <div className="trade-ladder-empty">No asks</div>}
        {/* Worst ask on top, best ask adjacent to the spread row. */}
        {[...askRows].reverse().map((r) => (
          <div
            key={r.price}
            className="trade-book-row trade-book-level ask"
            onClick={() => onPickPrice(r.price)}
            title="Set limit price"
          >
            <span
              className="trade-book-bar ask"
              style={{ width: `${(r.cum / maxCum) * 100}%` }}
            />
            <span className="trade-book-price num">{fmtMild(r.price)}</span>
            <span className="num">{fmtMild(r.qty)}</span>
            <span className="num trade-book-cum">{fmtMild(r.cum)}</span>
          </div>
        ))}
      </div>
      <div className="trade-spread-row">
        {spread !== null ? (
          <>
            <span>SPREAD</span>
            <span className="num">{fmtMild(spread)}</span>
            <span className="num">{((spread / bestAsk) * 100).toFixed(2)}%</span>
          </>
        ) : (
          <span>{book.last > 0 ? `LAST ${fmtMild(book.last)}` : "NO MARKET"}</span>
        )}
      </div>
      <div className="trade-ladder-side bids">
        {bidRows.length === 0 && <div className="trade-ladder-empty">No bids</div>}
        {bidRows.map((r) => (
          <div
            key={r.price}
            className="trade-book-row trade-book-level bid"
            onClick={() => onPickPrice(r.price)}
            title="Set limit price"
          >
            <span
              className="trade-book-bar bid"
              style={{ width: `${(r.cum / maxCum) * 100}%` }}
            />
            <span className="trade-book-price num">{fmtMild(r.price)}</span>
            <span className="num">{fmtMild(r.qty)}</span>
            <span className="num trade-book-cum">{fmtMild(r.cum)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Ticking clock shared by the tape/order ages (1 Hz). */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function TapeList({ book }: { book: BookStateMsg | null }) {
  const now = useNow();
  if (!book) return <div className="econ-empty">Loading trades…</div>;
  return (
    <div className="trade-tape">
      <div className="trade-book-row trade-book-head">
        <span>PRICE</span>
        <span className="num">SIZE</span>
        <span className="num">AGE</span>
      </div>
      {book.tape.length === 0 && <div className="econ-empty">No recent trades.</div>}
      {book.tape.map((t, i) => (
        <div key={`${t.t}-${i}`} className="trade-book-row trade-tape-row">
          <span className="num" style={{ color: t.side === "Bid" ? UP : DOWN }}>
            {fmtMild(t.price)}
          </span>
          <span className="num">{fmtMild(t.qty)}</span>
          <span className="num trade-tape-age">{formatAge(t.t, now)}</span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Order entry panel
// ---------------------------------------------------------------------------

/** Cost of taking `qty` units from `levels` (asks for buys, bids for sells). */
function walkDepth(
  levels: [number, number][],
  qty: number,
): { cost: number; filled: number } {
  let remaining = qty;
  let cost = 0;
  let filled = 0;
  for (const [price, size] of levels) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, size);
    cost += take * price;
    filled += take;
    remaining -= take;
  }
  return { cost, filled };
}

function OrderPanel({
  connection,
  sel,
  book,
  row,
  venueName,
  atVenue,
  distToVenue,
  prefillPrice,
}: {
  connection: GameConnection;
  sel: Selection;
  book: BookStateMsg | null;
  row: MarketRow | null;
  venueName: string;
  atVenue: boolean;
  distToVenue: number | undefined;
  prefillPrice: number | null;
}) {
  const wallet = useGame((s) => s.wallet);
  const inventory = useGame((s) => s.inventory);
  const [side, setSide] = useState<SideMsg>("Bid");
  const [kind, setKind] = useState<"Limit" | "Market">("Limit");
  const [priceText, setPriceText] = useState("");
  const [qtyText, setQtyText] = useState("");

  const selKey = assetKey(sel.asset);
  const bestBid = book?.bids[0]?.[0] ?? 0;
  const bestAsk = book?.asks[0]?.[0] ?? 0;

  // Reset the ticket when the market changes.
  useEffect(() => {
    setPriceText("");
    setQtyText("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selKey, sel.venue]);

  // Clicking a ladder level prefills the limit price.
  useEffect(() => {
    if (prefillPrice === null) return;
    setKind("Limit");
    setPriceText(String(prefillPrice));
  }, [prefillPrice]);

  // First book snapshot (or side flip) seeds an empty price from the touch.
  useEffect(() => {
    if (kind !== "Limit" || priceText !== "") return;
    const seed = side === "Bid" ? bestBid || book?.last || bestAsk : bestAsk || book?.last || bestBid;
    if (seed > 0) setPriceText(String(seed));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [side, kind, book !== null]);

  const price = Math.max(0, Math.floor(Number(priceText) || 0));
  const qty = Math.max(0, Math.floor(Number(qtyText) || 0));

  const carriedMild = wallet?.wild ?? 0;

  /** Units of the asset the player carries (sell-side max). */
  const holdings = useMemo(() => {
    if (sel.asset.t === "Shards") return wallet?.shards ?? 0;
    if (sel.asset.t === "Energy") return wallet?.energy ?? 0;
    const itemKind = sel.asset.d as ItemKind;
    return (inventory?.slots ?? []).reduce(
      (n, s) => n + (s?.kind === itemKind ? s.count : 0),
      0,
    );
  }, [sel.asset, wallet, inventory]);

  const isBuy = side === "Bid";
  // Marketable = pays the 5% taker fee: market orders always; limit orders
  // when they cross the touch.
  const marketable =
    kind === "Market" ||
    (isBuy ? bestAsk > 0 && price >= bestAsk : bestBid > 0 && price <= bestBid);

  // Cost estimate: limit uses the limit price; market walks the book depth.
  const est = useMemo(() => {
    if (qty <= 0) return { subtotal: 0, filled: 0 };
    if (kind === "Limit") return { subtotal: price * qty, filled: qty };
    const levels = isBuy ? book?.asks ?? [] : book?.bids ?? [];
    const { cost, filled } = walkDepth(levels, qty);
    return { subtotal: cost, filled };
  }, [kind, price, qty, isBuy, book]);

  const fee = marketable ? Math.ceil((est.subtotal * FEE_PCT) / 100) : 0;
  const total = isBuy ? est.subtotal + fee : Math.max(0, est.subtotal - fee);

  /** Max affordable/available qty for the Max helper. */
  const maxQty = useMemo(() => {
    if (!isBuy) return holdings;
    const budget = carriedMild;
    if (kind === "Limit") {
      if (price <= 0) return 0;
      // Bid escrow debits price*qty + fee up front (mirror the server rule).
      return Math.floor(budget / (price * (1 + FEE_PCT / 100)));
    }
    // Market buy: walk the asks accumulating while the (fee-buffered) cost fits.
    const levels = book?.asks ?? [];
    let cost = 0;
    let got = 0;
    for (const [p, size] of levels) {
      const unit = p * (1 + FEE_PCT / 100);
      const afford = Math.floor((budget - cost * (1 + FEE_PCT / 100)) / unit);
      const take = Math.min(size, Math.max(0, afford));
      got += take;
      cost += take * p;
      if (take < size) break;
    }
    return got;
  }, [isBuy, holdings, carriedMild, kind, price, book]);

  const submitDisabled =
    !atVenue ||
    qty <= 0 ||
    (kind === "Limit" && price <= 0) ||
    (kind === "Market" && est.filled <= 0) ||
    (isBuy && total > carriedMild) ||
    (!isBuy && qty > holdings);

  const submit = () => {
    if (submitDisabled) return;
    // Market bids need a MILD budget: the fee-buffered cost preview, ceiled.
    const maxSpend =
      isBuy && kind === "Market" ? Math.ceil(est.subtotal * (1 + FEE_PCT / 100)) : null;
    connection.send({
      t: "Exchange",
      d: {
        t: "Place",
        d: {
          venue: sel.venue,
          asset: sel.asset,
          side,
          order: kind === "Limit" ? { t: "Limit", d: { price } } : { t: "Market" },
          qty,
          max_spend: maxSpend,
        },
      },
    });
    setQtyText("");
  };

  const ticker = row?.ticker ?? assetTicker(sel.asset);

  return (
    <div className={`trade-panel trade-order-panel${atVenue ? "" : " away"}`}>
      <div className="trade-side-toggle">
        <button
          className={`trade-side-btn buy${isBuy ? " active" : ""}`}
          onClick={() => setSide("Bid")}
        >
          BUY
        </button>
        <button
          className={`trade-side-btn sell${!isBuy ? " active" : ""}`}
          onClick={() => setSide("Ask")}
        >
          SELL
        </button>
      </div>
      <div className="trade-type-toggle">
        <button
          className={`trade-type-btn${kind === "Market" ? " active" : ""}`}
          onClick={() => setKind("Market")}
        >
          MARKET
        </button>
        <button
          className={`trade-type-btn${kind === "Limit" ? " active" : ""}`}
          onClick={() => setKind("Limit")}
        >
          LIMIT
        </button>
      </div>

      <div className="trade-balance-row">
        <span>CARRIED</span>
        <span className="num">{fmtMild(carriedMild)} MILD</span>
      </div>
      <div className="trade-balance-row">
        <span>{ticker} HELD</span>
        <span className="num">{fmtMild(holdings)}</span>
      </div>

      {kind === "Limit" && (
        <label className="trade-field">
          <span>PRICE (MILD)</span>
          <input
            type="text"
            inputMode="numeric"
            value={priceText}
            disabled={!atVenue}
            onChange={(e) => setPriceText(e.target.value.replace(/[^\d]/g, ""))}
            placeholder={isBuy ? String(bestBid || "") : String(bestAsk || "")}
          />
        </label>
      )}
      <label className="trade-field">
        <span>QUANTITY</span>
        <div className="trade-qty-wrap">
          <input
            type="text"
            inputMode="numeric"
            value={qtyText}
            disabled={!atVenue}
            onChange={(e) => setQtyText(e.target.value.replace(/[^\d]/g, ""))}
            placeholder="0"
          />
          <button
            className="trade-max-btn"
            disabled={!atVenue || maxQty <= 0}
            onClick={() => setQtyText(String(maxQty))}
            title={isBuy ? "Max affordable with carried MILD" : "All units held"}
          >
            MAX {maxQty > 0 ? fmtCompact(maxQty) : ""}
          </button>
        </div>
      </label>

      <div className="trade-summary">
        {kind === "Market" && qty > 0 && est.filled < qty && (
          <div className="trade-summary-row trade-warn">
            <span>BOOK DEPTH</span>
            <span className="num">fills {fmtMild(est.filled)} / {fmtMild(qty)}</span>
          </div>
        )}
        <div className="trade-summary-row">
          <span>{kind === "Market" ? "EST. SUBTOTAL" : "SUBTOTAL"}</span>
          <span className="num">{fmtMild(est.subtotal)} MILD</span>
        </div>
        <div className="trade-summary-row">
          <span>TAKER FEE ({FEE_PCT}%)</span>
          <span className="num">{marketable ? `${fmtMild(fee)} MILD` : "— (maker)"}</span>
        </div>
        <div className="trade-summary-row trade-summary-total">
          <span>{isBuy ? "TOTAL COST" : "EST. PROCEEDS"}</span>
          <span className="num">{fmtMild(total)} MILD</span>
        </div>
      </div>

      {atVenue ? (
        <button
          className={`trade-submit ${isBuy ? "buy" : "sell"}`}
          disabled={submitDisabled}
          onClick={submit}
        >
          {isBuy ? "BUY" : "SELL"} {ticker}
          {kind === "Market" ? " AT MARKET" : ""}
        </button>
      ) : (
        <div className="trade-gate">
          <div className="trade-gate-title">ORDER ENTRY OFFLINE</div>
          <div>
            Travel to <b>{venueName}</b> to trade
            {distToVenue !== undefined && Number.isFinite(distToVenue)
              ? ` — ${Math.round(distToVenue)}m away`
              : ""}
            .
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bottom strip: open orders / recent trades / settlement inboxes
// ---------------------------------------------------------------------------

type StripTab = "orders" | "history" | "settlement";

function BottomStrip({
  connection,
  book,
  rows,
  venues,
  prox,
}: {
  connection: GameConnection;
  book: BookStateMsg | null;
  rows: MarketRow[];
  venues: VenueInfo[];
  prox: VenueProximity;
}) {
  const myExchange = useGame((s) => s.myExchange);
  const [tab, setTab] = useState<StripTab>("orders");
  const now = useNow();

  const venueName = useMemo(
    () => new Map(venues.map((v) => [v.venue, v.name])),
    [venues],
  );
  const tickerOf = useMemo(() => {
    const map = new Map(rows.map((r) => [assetKey(r.asset), r.ticker]));
    return (a: AssetMsg) => map.get(assetKey(a)) ?? assetTicker(a);
  }, [rows]);

  // MyExchangeState arrives on terminal interaction + order events; the
  // book's own my_orders fills the gap for the watched market meanwhile.
  const orders: OrderMsg[] = myExchange?.orders ?? book?.my_orders ?? [];
  const inboxes = (myExchange?.inboxes ?? []).filter(
    (i) => i.inbox.mild > 0 || i.inbox.assets.length > 0,
  );

  return (
    <div className="trade-panel trade-bottom">
      <div className="econ-tabs trade-bottom-tabs">
        <div
          className={`econ-tab ${tab === "orders" ? "active" : ""}`}
          onClick={() => setTab("orders")}
        >
          OPEN ORDERS ({orders.length})
        </div>
        <div
          className={`econ-tab ${tab === "history" ? "active" : ""}`}
          onClick={() => setTab("history")}
        >
          RECENT TRADES
        </div>
        <div
          className={`econ-tab ${tab === "settlement" ? "active" : ""}`}
          onClick={() => setTab("settlement")}
        >
          SETTLEMENT ({inboxes.length})
        </div>
      </div>

      {tab === "orders" && (
        <div className="trade-bottom-list">
          <div className="trade-orders-row trade-bottom-head">
            <span>MARKET</span>
            <span>VENUE</span>
            <span>SIDE</span>
            <span className="num">PRICE</span>
            <span className="num">FILLED / QTY</span>
            <span className="num">AGE</span>
            <span />
          </div>
          {orders.length === 0 && (
            <div className="econ-empty">No open orders anywhere.</div>
          )}
          {orders.map((o) => {
            const atOrderVenue = prox.atId === o.venue;
            return (
              <div key={o.id} className="trade-orders-row">
                <span className="trade-mkt-ticker">{tickerOf(o.asset)}</span>
                <span>{venueName.get(o.venue) ?? `VENUE ${o.venue}`}</span>
                <span style={{ color: o.side === "Bid" ? UP : DOWN }}>
                  {o.side === "Bid" ? "BUY" : "SELL"}
                </span>
                <span className="num">{o.price > 0 ? fmtMild(o.price) : "MKT"}</span>
                <span className="num">
                  {fmtMild(o.filled)} / {fmtMild(o.qty)}
                </span>
                <span className="num">{formatAge(o.placed_ms, now)}</span>
                <button
                  className="trade-cancel-btn"
                  disabled={!atOrderVenue}
                  title={
                    atOrderVenue
                      ? "Cancel order (escrow refunds here)"
                      : `Cancel requires standing at ${venueName.get(o.venue) ?? "the venue"}'s terminal`
                  }
                  onClick={() =>
                    connection.send({
                      t: "Exchange",
                      d: { t: "Cancel", d: { order_id: o.id } },
                    })
                  }
                >
                  CANCEL
                </button>
              </div>
            );
          })}
        </div>
      )}

      {tab === "history" && (
        <div className="trade-bottom-list">
          <div className="trade-history-row trade-bottom-head">
            <span className="num">PRICE</span>
            <span className="num">SIZE</span>
            <span>TAKER</span>
            <span className="num">AGE</span>
          </div>
          {(book?.tape ?? []).length === 0 && (
            <div className="econ-empty">No trades at this venue yet.</div>
          )}
          {(book?.tape ?? []).map((t, i) => (
            <div key={`${t.t}-${i}`} className="trade-history-row">
              <span className="num" style={{ color: t.side === "Bid" ? UP : DOWN }}>
                {fmtMild(t.price)}
              </span>
              <span className="num">{fmtMild(t.qty)}</span>
              <span style={{ color: t.side === "Bid" ? UP : DOWN }}>
                {t.side === "Bid" ? "BUY" : "SELL"}
              </span>
              <span className="num">{formatAge(t.t, now)}</span>
            </div>
          ))}
        </div>
      )}

      {tab === "settlement" && (
        <div className="trade-bottom-list">
          {inboxes.length === 0 && (
            <div className="econ-empty">
              Nothing awaiting settlement. Fills credit an inbox at their venue —
              claim them at that terminal.
            </div>
          )}
          {inboxes.map((i) => {
            const atInboxVenue = prox.atId === i.venue;
            return (
              <div key={i.venue} className="trade-inbox-row">
                <span className="trade-inbox-venue">
                  {venueName.get(i.venue) ?? `VENUE ${i.venue}`}
                </span>
                <span className="trade-inbox-contents">
                  {i.inbox.mild > 0 && (
                    <span className="trade-inbox-chip num">{fmtMild(i.inbox.mild)} MILD</span>
                  )}
                  {i.inbox.assets.map((a) => (
                    <span key={assetKey(a.asset)} className="trade-inbox-chip">
                      <AssetGlyph asset={a.asset} size={14} />
                      {fmtMild(a.qty)} {tickerOf(a.asset)}
                    </span>
                  ))}
                </span>
                <button
                  className="trade-claim-btn"
                  disabled={!atInboxVenue}
                  title={
                    atInboxVenue
                      ? "Claim into your backpack/wallet"
                      : `Claim requires standing at ${venueName.get(i.venue) ?? "the venue"}'s terminal`
                  }
                  onClick={() =>
                    connection.send({
                      t: "Exchange",
                      d: { t: "Claim", d: { venue: i.venue } },
                    })
                  }
                >
                  CLAIM
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
