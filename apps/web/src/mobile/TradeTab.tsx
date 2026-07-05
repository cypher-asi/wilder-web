// Mobile Trade tab: read-only exchange market data. A compact markets list
// (MarketsSub) with search, and a per-market drill-in (BookSub) showing the
// stat strip, order-book ladder and recent-trades tape. Order entry is
// desktop-first — the mobile shell spectates, it doesn't stand at terminals.

import { useEffect, useMemo, useState } from "react";
import { GameConnection } from "../net/connection";
import { AssetMsg, MarketRow } from "../net/protocol";
import { useGame } from "../state/game";
import { fmtCompact, fmtMild, formatAge } from "../ui/format";
import { AssetGlyph, assetKey, assetLabel, assetTicker } from "../ui/TradeScreen";

const UP = "#7be0c2";
const DOWN = "#ff6a7c";

function fmtBp(bp: number): string {
  const pct = bp / 100;
  return `${pct > 0 ? "+" : ""}${pct.toFixed(2)}%`;
}

function changeColor(bp: number): string | undefined {
  if (bp > 0) return UP;
  if (bp < 0) return DOWN;
  return undefined;
}

interface Sel {
  asset: AssetMsg;
  venue: number;
}

export function TradeTab({ connection }: { connection: GameConnection }) {
  const joined = useGame((s) => s.joined);
  const appVisible = useGame((s) => s.appVisible);
  const markets = useGame((s) => s.markets);
  const [sel, setSel] = useState<Sel | null>(null);

  // Markets index stream while the tab is up (see EconomyTab for the
  // joined/appVisible gating rationale).
  useEffect(() => {
    if (!joined || !appVisible) return;
    connection.send({ t: "MarketsSub", d: { on: true } });
    return () => {
      connection.send({ t: "MarketsSub", d: { on: false } });
    };
  }, [joined, appVisible, connection]);

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
    <div className="m-trade2">
      <div className="m-econ-head">
        <span className="m-ag-title">MARKETS</span>
        <span className="m-ag-count">
          {markets ? `${markets.rows.length} TICKERS · MILD` : "SYNCING…"}
        </span>
      </div>
      <MarketList
        rows={markets?.rows ?? []}
        onOpen={(row) => {
          const v =
            [...row.venues].sort((a, b) => b.volume_24h_wild - a.volume_24h_wild)[0]
              ?.venue ?? markets?.venues[0]?.venue;
          if (v !== undefined) setSel({ asset: row.asset, venue: v });
        }}
      />
    </div>
  );
}

function MarketList({
  rows,
  onOpen,
}: {
  rows: MarketRow[];
  onOpen: (row: MarketRow) => void;
}) {
  const [search, setSearch] = useState("");

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows
      .filter(
        (r) =>
          q.length === 0 ||
          r.ticker.toLowerCase().includes(q) ||
          assetLabel(r.asset).toLowerCase().includes(q),
      )
      .sort((a, b) => b.volume_24h_wild - a.volume_24h_wild);
  }, [rows, search]);

  return (
    <>
      <div className="m-trade2-search-wrap">
        <input
          className="m-trade2-search"
          placeholder="Search ticker or name…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <div className="m-econ-list m-scroll">
        {shown.length === 0 && (
          <div className="m-ag-note">
            {rows.length === 0 ? "No markets are live yet." : "No markets match."}
          </div>
        )}
        {shown.map((r) => (
          <button
            key={assetKey(r.asset)}
            type="button"
            className="m-econ-item-row"
            onClick={() => onOpen(r)}
          >
            <AssetGlyph asset={r.asset} size={22} />
            <span className="m-trade2-id">
              <span className="m-trade2-ticker">{r.ticker}</span>
              <span className="m-trade2-name">{assetLabel(r.asset)}</span>
            </span>
            <span className="m-trade2-numbers">
              <span className="m-trade2-last num">
                {r.last > 0 ? fmtMild(r.last) : "—"}
              </span>
              <span className="m-trade2-sub num">
                <span style={{ color: changeColor(r.change_24h_bp) }}>
                  {r.last > 0 ? fmtBp(r.change_24h_bp) : "—"}
                </span>
                {" · "}
                {fmtCompact(r.volume_24h_wild)} MILD · {r.venues.length}v
              </span>
            </span>
          </button>
        ))}
      </div>
    </>
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
  const book =
    rawBook !== null && rawBook.venue === sel.venue && assetKey(rawBook.asset) === selKey
      ? rawBook
      : null;

  useEffect(() => {
    if (!joined || !appVisible) return;
    connection.send({
      t: "BookSub",
      d: { market: { venue: sel.venue, asset: sel.asset } },
    });
    return () => {
      connection.send({ t: "BookSub", d: { market: null } });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joined, appVisible, connection, sel.venue, selKey]);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const row = markets?.rows.find((r) => assetKey(r.asset) === selKey) ?? null;
  const venues = markets?.venues ?? [];
  const venueName =
    venues.find((v) => v.venue === sel.venue)?.name ?? `VENUE ${sel.venue}`;
  const stats = book?.stats ?? null;
  const bestBid = book?.bids[0]?.[0] ?? 0;
  const bestAsk = book?.asks[0]?.[0] ?? 0;

  const asks = (book?.asks ?? []).slice(0, 8);
  const bids = (book?.bids ?? []).slice(0, 8);
  const maxQty = Math.max(...asks.map((l) => l[1]), ...bids.map((l) => l[1]), 1);

  return (
    <div className="m-trade2">
      <div className="m-econ-head m-trade2-detail-head">
        <button type="button" className="m-trade2-back" onClick={onBack}>
          ‹
        </button>
        <AssetGlyph asset={sel.asset} size={22} />
        <span className="m-trade2-id">
          <span className="m-trade2-ticker">
            {row?.ticker ?? assetTicker(sel.asset)}
          </span>
          <span className="m-trade2-name">{assetLabel(sel.asset)}</span>
        </span>
        <span className="m-trade2-headline num">
          <span style={{ color: changeColor(stats?.change_24h_bp ?? 0) }}>
            {book && book.last > 0 ? fmtMild(book.last) : "—"}
          </span>
          <span className="m-trade2-sub" style={{ color: changeColor(stats?.change_24h_bp ?? 0) }}>
            {stats ? fmtBp(stats.change_24h_bp) : ""}
          </span>
        </span>
      </div>

      <div className="m-trade2-venues">
        {venues.map((v) => (
          <button
            key={v.venue}
            type="button"
            className={`m-econ-cat${v.venue === sel.venue ? " active" : ""}`}
            onClick={() => setSel({ asset: sel.asset, venue: v.venue })}
          >
            {v.name}
          </button>
        ))}
      </div>

      <div className="m-trade2-stats">
        <span>
          24H {stats && stats.high_24h > 0 ? `${fmtMild(stats.high_24h)} / ${fmtMild(stats.low_24h)}` : "—"}
        </span>
        <span>VOL {stats ? `${fmtCompact(stats.volume_24h_wild)} MILD` : "—"}</span>
        <span>
          <b style={{ color: UP }}>{bestBid > 0 ? fmtMild(bestBid) : "—"}</b>
          {" / "}
          <b style={{ color: DOWN }}>{bestAsk > 0 ? fmtMild(bestAsk) : "—"}</b>
        </span>
      </div>

      <div className="m-scroll m-trade2-body">
        <div className="m-trade2-section">ORDER BOOK — {venueName.toUpperCase()}</div>
        {asks.length === 0 && bids.length === 0 && (
          <div className="m-ag-note">Empty book at this venue.</div>
        )}
        {[...asks].reverse().map(([price, qty]) => (
          <div key={`a${price}`} className="m-trade2-level">
            <span className="m-trade2-level-bar ask" style={{ width: `${(qty / maxQty) * 100}%` }} />
            <span className="num" style={{ color: DOWN }}>{fmtMild(price)}</span>
            <span className="num">{fmtMild(qty)}</span>
          </div>
        ))}
        {bids.map(([price, qty]) => (
          <div key={`b${price}`} className="m-trade2-level">
            <span className="m-trade2-level-bar bid" style={{ width: `${(qty / maxQty) * 100}%` }} />
            <span className="num" style={{ color: UP }}>{fmtMild(price)}</span>
            <span className="num">{fmtMild(qty)}</span>
          </div>
        ))}

        <div className="m-trade2-section">RECENT TRADES</div>
        {(book?.tape ?? []).length === 0 && (
          <div className="m-ag-note">No recent trades.</div>
        )}
        {(book?.tape ?? []).map((t, i) => (
          <div key={`${t.t}-${i}`} className="m-trade2-level">
            <span className="num" style={{ color: t.side === "Bid" ? UP : DOWN }}>
              {fmtMild(t.price)}
            </span>
            <span className="num">{fmtMild(t.qty)}</span>
            <span className="num m-trade2-sub">{formatAge(t.t, now)}</span>
          </div>
        ))}
        <div className="m-trade2-footnote">
          Trading is desk-side only — stand at a Market Terminal in game to
          place orders.
        </div>
      </div>
    </div>
  );
}
