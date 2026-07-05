//! The exchange facade: one `Exchange` composes the per-(venue, asset)
//! order books, market data, and escrow/settlement into the single API
//! `wilder-world` calls. This is the only exchange crate the world imports.
//!
//! # The contract with `wilder-world` (Phase 2)
//!
//! Placing an order:
//!
//! 1. The world computes the escrow the order needs (the same rule
//!    [`Exchange::place`] applies): limit bid `price * qty` MILD, market
//!    bid the caller-chosen `max_spend` budget, any ask `qty` asset units —
//!    and checks the actor can afford it.
//! 2. It calls [`Exchange::place`] and gets a [`PlaceOutcome`].
//! 3. It debits `escrow_taken` from the actor, immediately credits
//!    `refund` back (IOC remainder / unspent market budget / limit-bid
//!    price improvement), routes each fill's `fee_mild`, and leaves inbox
//!    credits inside the exchange until the owner claims at the venue.
//!
//! Fills land in per-(venue, owner) settlement inboxes; [`Exchange::claim`]
//! drains one and the world materializes the contents into the actor's
//! inventory/purse. [`Exchange::cancel`] returns the escrow to refund.
//!
//! All entry points take explicit `now_ms` timestamps — the exchange never
//! reads a clock, so replays and tests are deterministic.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

pub use wilder_exchange_asset::{Asset, OrderOwner, Venue, VenueId};
pub use wilder_exchange_book::{Fill, Order, OrderBook, OrderKind, Placement, Side};
pub use wilder_exchange_data::{AssetSummary, Candle, MarketData, MarketStats, TapeEntry};
pub use wilder_exchange_settle::{Escrow, FillEffect, Inbox, Settlement};

/// Why an order was rejected. The world relays these to the client as the
/// `OrderResult` error string.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ExchangeError {
    UnknownVenue,
    /// Order qty must be at least 1.
    InvalidQty,
    /// Limit price must be at least 1 WILD.
    InvalidPrice,
    /// Market bids need a `max_spend` MILD budget.
    MissingMaxSpend,
    UnknownOrder,
    /// Only the owner may cancel an order.
    NotYourOrder,
}

impl std::fmt::Display for ExchangeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let msg = match self {
            ExchangeError::UnknownVenue => "unknown venue",
            ExchangeError::InvalidQty => "quantity must be at least 1",
            ExchangeError::InvalidPrice => "price must be at least 1 MILD",
            ExchangeError::MissingMaxSpend => "market buys need a spend budget",
            ExchangeError::UnknownOrder => "no such order",
            ExchangeError::NotYourOrder => "not your order",
        };
        f.write_str(msg)
    }
}

impl std::error::Error for ExchangeError {}

/// Everything the world needs to apply one successful `place`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlaceOutcome {
    pub order_id: u64,
    /// What the world must debit from the actor (checked affordable before
    /// calling `place`). Limit bid: `price * qty` MILD. Market bid:
    /// `max_spend` MILD. Ask: `qty` asset units.
    pub escrow_taken: Escrow,
    /// Executions in match order, each with its settlement effect (fee,
    /// proceeds, inbox credits already applied inside the exchange).
    pub fills: Vec<(Fill, FillEffect)>,
    /// True when a limit remainder now rests on the book.
    pub resting: bool,
    /// Hand this straight back to the actor: market-order IOC remainder,
    /// unspent market-bid budget, and limit-bid price improvement. `None`
    /// when nothing refunds.
    pub refund: Option<Escrow>,
}

/// One markets-index row: an asset plus its cross-venue rollup.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MarketRow {
    pub asset: Asset,
    pub summary: AssetSummary,
}

/// Full serializable snapshot for RocksDB persistence.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ExchangeSave {
    pub venues: Vec<Venue>,
    pub next_order_id: u64,
    /// Sorted by (venue, ticker) so saves are byte-stable.
    pub books: Vec<(VenueId, Asset, OrderBook)>,
    pub data: MarketData,
    pub settlement: Settlement,
}

/// The whole exchange: books per (venue, asset), market data, settlement.
#[derive(Debug, Default)]
pub struct Exchange {
    books: HashMap<(VenueId, Asset), OrderBook>,
    next_order_id: u64,
    data: MarketData,
    settlement: Settlement,
    venues: Vec<Venue>,
}

impl Exchange {
    pub fn new(venues: Vec<Venue>) -> Self {
        Self {
            books: HashMap::new(),
            next_order_id: 1,
            data: MarketData::new(),
            settlement: Settlement::new(),
            venues,
        }
    }

    pub fn venues(&self) -> &[Venue] {
        &self.venues
    }

    pub fn venue(&self, id: VenueId) -> Option<&Venue> {
        self.venues.iter().find(|v| v.id == id)
    }

    /// Place an order. `max_spend` is the MILD budget for market bids
    /// (required there, ignored elsewhere); `fee_pct` is the taker fee in
    /// whole percent. See the module docs for the world-side flow.
    #[allow(clippy::too_many_arguments)]
    pub fn place(
        &mut self,
        owner: OrderOwner,
        venue: VenueId,
        asset: Asset,
        side: Side,
        kind: OrderKind,
        qty: u32,
        max_spend: Option<u64>,
        fee_pct: u32,
        now_ms: u64,
    ) -> Result<PlaceOutcome, ExchangeError> {
        if self.venue(venue).is_none() {
            return Err(ExchangeError::UnknownVenue);
        }
        if qty == 0 {
            return Err(ExchangeError::InvalidQty);
        }
        let limit_price = match kind {
            OrderKind::Limit { price } => {
                if price == 0 {
                    return Err(ExchangeError::InvalidPrice);
                }
                Some(price)
            }
            OrderKind::Market => None,
        };

        // Escrow: what the actor locks up-front (world already checked
        // affordability against this same rule).
        let is_market_bid = side == Side::Bid && limit_price.is_none();
        let escrow_taken = match (side, limit_price) {
            (Side::Bid, Some(price)) => Escrow::Mild(price as u64 * qty as u64),
            (Side::Bid, None) => {
                Escrow::Mild(max_spend.ok_or(ExchangeError::MissingMaxSpend)?)
            }
            (Side::Ask, _) => Escrow::Asset { asset, qty },
        };

        let order_id = self.next_order_id;
        self.next_order_id += 1;
        self.settlement.lock(order_id, escrow_taken);

        let book = self.books.entry((venue, asset)).or_default();
        // A market bid can only sweep what its budget affords: cap the qty
        // at the units purchasable against the current book (skipping own
        // orders, best price first) so the match never overspends the lock.
        let effective_qty = if is_market_bid {
            let budget = match escrow_taken {
                Escrow::Mild(m) => m,
                Escrow::Asset { .. } => 0,
            };
            qty.min(affordable_units(book, owner, budget, qty))
        } else {
            qty
        };

        let (fills, placement) = if effective_qty == 0 {
            // Budget affords nothing: the whole order IOC-cancels.
            (Vec::new(), Placement::IocCancelled { remaining: qty })
        } else {
            let result = book.place(Order {
                id: order_id,
                owner,
                venue,
                asset,
                side,
                kind,
                qty: effective_qty,
                filled: 0,
                placed_ms: now_ms,
            });
            (result.fills, result.placement)
        };

        // Settle each fill: locks debited, inboxes credited, fee carved.
        let taker_limit = if side == Side::Bid { limit_price } else { None };
        let mut refund_mild = 0u64;
        let mut settled = Vec::with_capacity(fills.len());
        for fill in fills {
            let effect = self.settlement.on_fill(venue, asset, &fill, taker_limit, fee_pct);
            refund_mild += effect.taker_bid_refund;
            self.data.record_fill(venue, asset, &fill);
            settled.push((fill, effect));
        }

        // Anything not resting releases its leftover lock as an immediate
        // refund (IOC remainder, unspent market budget).
        let resting = placement == Placement::Rested;
        let mut refund_asset = 0u32;
        if !resting {
            match self.settlement.on_cancel(order_id) {
                Some(Escrow::Mild(m)) => refund_mild += m,
                Some(Escrow::Asset { qty, .. }) => refund_asset += qty,
                None => {}
            }
        }
        let refund = if refund_asset > 0 {
            Some(Escrow::Asset { asset, qty: refund_asset })
        } else if refund_mild > 0 {
            Some(Escrow::Mild(refund_mild))
        } else {
            None
        };

        Ok(PlaceOutcome { order_id, escrow_taken, fills: settled, resting, refund })
    }

    /// Cancel a resting order (owners only). Returns the escrow to refund
    /// for the unfilled remainder.
    pub fn cancel(&mut self, owner: OrderOwner, order_id: u64) -> Result<Escrow, ExchangeError> {
        let mut found: Option<((VenueId, Asset), Order)> = None;
        for (key, book) in &self.books {
            if let Some(order) = book.iter().find(|o| o.id == order_id) {
                found = Some((*key, *order));
                break;
            }
        }
        let (key, order) = found.ok_or(ExchangeError::UnknownOrder)?;
        if order.owner != owner {
            return Err(ExchangeError::NotYourOrder);
        }
        if let Some(book) = self.books.get_mut(&key) {
            book.cancel(order_id);
        }
        // A resting order always has a live lock (price and qty are >= 1);
        // fall back to an empty refund rather than panicking if not.
        Ok(self.settlement.on_cancel(order_id).unwrap_or(match order.side {
            Side::Bid => Escrow::Mild(0),
            Side::Ask => Escrow::Asset { asset: order.asset, qty: 0 },
        }))
    }

    /// Drain the owner's settlement inbox at one venue. The world
    /// materializes the returned MILD/assets into the actor's purse and
    /// inventory.
    pub fn claim(&mut self, owner: OrderOwner, venue: VenueId) -> Inbox {
        self.settlement.claim(venue, owner)
    }

    /// Read-only inbox view (for the UI's settlement tab).
    pub fn inbox(&self, owner: OrderOwner, venue: VenueId) -> Option<&Inbox> {
        self.settlement.inbox(venue, owner)
    }

    /// Merge inbox contents back after a partial claim (the actor's pack
    /// couldn't hold everything the claim drained).
    pub fn return_to_inbox(&mut self, owner: OrderOwner, venue: VenueId, inbox: Inbox) {
        self.settlement.restore(venue, owner, inbox);
    }

    /// Total resting orders across every book (diagnostics).
    pub fn resting_order_count(&self) -> usize {
        self.books.values().map(|b| b.iter().count()).sum()
    }

    /// All of an owner's resting orders across every venue and asset.
    pub fn open_orders(&self, owner: OrderOwner) -> Vec<Order> {
        let mut orders: Vec<Order> = self
            .books
            .values()
            .flat_map(|b| b.orders_for(owner))
            .copied()
            .collect();
        orders.sort_by_key(|o| o.id);
        orders
    }

    /// Aggregated depth: top `n` (price, qty) levels per side.
    pub fn depth(&self, venue: VenueId, asset: Asset, n: usize) -> (Vec<(u32, u32)>, Vec<(u32, u32)>) {
        self.books
            .get(&(venue, asset))
            .map(|b| b.depth(n))
            .unwrap_or_default()
    }

    pub fn best_bid(&self, venue: VenueId, asset: Asset) -> Option<u32> {
        self.books.get(&(venue, asset)).and_then(|b| b.best_bid())
    }

    pub fn best_ask(&self, venue: VenueId, asset: Asset) -> Option<u32> {
        self.books.get(&(venue, asset)).and_then(|b| b.best_ask())
    }

    /// 24 h trailing stats for one (venue, asset).
    pub fn stats(&self, venue: VenueId, asset: Asset, now_ms: u64) -> MarketStats {
        self.data.stats(venue, asset, now_ms)
    }

    /// Minute OHLCV candles, oldest first (24 h stats / sparkline source).
    pub fn candles(&self, venue: VenueId, asset: Asset) -> &[Candle] {
        self.data.candles(venue, asset)
    }

    /// OHLCV candles aggregated to `tf_secs`-second buckets, oldest first,
    /// bounded to the most recent ~200 buckets before `now_ms`. Sub-minute
    /// frames come from the 1 s tick series (~1 h of history), minute-and-up
    /// frames from the minute series (~24 h).
    pub fn candles_tf(
        &self,
        venue: VenueId,
        asset: Asset,
        tf_secs: u32,
        now_ms: u64,
    ) -> Vec<Candle> {
        self.data.candles_tf(venue, asset, tf_secs, now_ms)
    }

    /// Recent trades, oldest first.
    pub fn tape(&self, venue: VenueId, asset: Asset) -> &[TapeEntry] {
        self.data.tape(venue, asset)
    }

    /// Cross-venue rollup for one asset.
    pub fn asset_summary(&self, asset: Asset, now_ms: u64) -> AssetSummary {
        self.data.asset_summary(asset, now_ms)
    }

    /// Record a synthetic market-data print — candles, tape and last price
    /// only; no book, escrow or settlement involvement. The world's market
    /// desk uses it to mark an opening price on a (venue, asset) nothing
    /// has ever crossed, so the ticker has a live quote from day one.
    pub fn record_print(&mut self, venue: VenueId, asset: Asset, price: u32, qty: u32, now_ms: u64) {
        if self.venue(venue).is_none() || price == 0 || qty == 0 {
            return;
        }
        let fill = Fill {
            taker_order: 0,
            maker_order: 0,
            taker: OrderOwner::Desk,
            maker: OrderOwner::Desk,
            taker_side: Side::Bid,
            price,
            qty,
            at_ms: now_ms,
        };
        self.data.record_fill(venue, asset, &fill);
    }

    /// One row per listable asset (traded or not) — the markets table.
    pub fn markets_index(&self, now_ms: u64) -> Vec<MarketRow> {
        Asset::all()
            .into_iter()
            .map(|asset| MarketRow { summary: self.data.asset_summary(asset, now_ms), asset })
            .collect()
    }

    /// Total fee MILD carved from fills so far (audit counter).
    pub fn fees_collected(&self) -> u64 {
        self.settlement.fees_collected()
    }

    /// Snapshot everything for persistence.
    pub fn save(&self) -> ExchangeSave {
        let mut books: Vec<(VenueId, Asset, OrderBook)> = self
            .books
            .iter()
            .map(|(&(v, a), b)| (v, a, b.clone()))
            .collect();
        books.sort_by_key(|(v, a, _)| (*v, a.ticker()));
        ExchangeSave {
            venues: self.venues.clone(),
            next_order_id: self.next_order_id,
            books,
            data: self.data.clone(),
            settlement: self.settlement.clone(),
        }
    }

    /// Rebuild from a snapshot.
    pub fn load(save: ExchangeSave) -> Self {
        Self {
            books: save.books.into_iter().map(|(v, a, b)| ((v, a), b)).collect(),
            next_order_id: save.next_order_id.max(1),
            data: save.data,
            settlement: save.settlement,
            venues: save.venues,
        }
    }
}

/// How many units a MILD budget buys off the book right now: walk the asks
/// best-first, skipping `owner`'s own orders (self-match prevention), taking
/// whole units until the budget or `want` runs out. Mirrors the matching
/// walk exactly, so a market bid capped to this qty can never overspend.
fn affordable_units(book: &OrderBook, owner: OrderOwner, budget: u64, want: u32) -> u32 {
    let mut budget = budget;
    let mut units = 0u32;
    for order in book.iter().filter(|o| o.side == Side::Ask && o.owner != owner) {
        if units >= want {
            break;
        }
        let price = match order.limit_price() {
            Some(p) => p.max(1) as u64,
            None => continue,
        };
        let by_budget = (budget / price) as u32;
        let take = order.remaining().min(want - units).min(by_budget);
        units += take;
        budget -= take as u64 * price;
        if by_budget <= take {
            break; // budget exhausted at this price level
        }
    }
    units
}

#[cfg(test)]
mod tests {
    use super::*;
    use wilder_types::{CharacterId, ItemKind};

    fn iron() -> Asset {
        Asset::Item(ItemKind::Iron)
    }

    fn copper() -> Asset {
        Asset::Item(ItemKind::Copper)
    }

    fn player(n: u128) -> OrderOwner {
        OrderOwner::Player(CharacterId::from_u128(n))
    }

    fn two_venues() -> Vec<Venue> {
        vec![
            Venue { id: VenueId(0), name: "Hub Market".into(), x: 0.0, z: 0.0 },
            Venue { id: VenueId(1), name: "Docks Market".into(), x: 500.0, z: -80.0 },
        ]
    }

    fn exchange() -> Exchange {
        Exchange::new(two_venues())
    }

    const FEE: u32 = 5;

    #[test]
    fn rejects_bad_input() {
        let mut ex = exchange();
        let who = player(1);
        let limit = OrderKind::Limit { price: 5 };
        assert_eq!(
            ex.place(who, VenueId(9), iron(), Side::Bid, limit, 1, None, FEE, 0),
            Err(ExchangeError::UnknownVenue)
        );
        assert_eq!(
            ex.place(who, VenueId(0), iron(), Side::Bid, limit, 0, None, FEE, 0),
            Err(ExchangeError::InvalidQty)
        );
        assert_eq!(
            ex.place(who, VenueId(0), iron(), Side::Bid, OrderKind::Limit { price: 0 }, 1, None, FEE, 0),
            Err(ExchangeError::InvalidPrice)
        );
        assert_eq!(
            ex.place(who, VenueId(0), iron(), Side::Bid, OrderKind::Market, 1, None, FEE, 0),
            Err(ExchangeError::MissingMaxSpend)
        );
    }

    /// Full scenario: two owners trade limit vs market at one venue and
    /// every MILD/unit is accounted for across escrow, inboxes, refunds and
    /// fees.
    #[test]
    fn limit_vs_market_conserves_value() {
        let mut ex = exchange();
        let (seller, buyer) = (player(1), player(2));
        let v = VenueId(0);

        // Seller lists 10 Iron at 5 MILD.
        let ask = ex
            .place(seller, v, iron(), Side::Ask, OrderKind::Limit { price: 5 }, 10, None, FEE, 1_000)
            .expect("ask");
        assert_eq!(ask.escrow_taken, Escrow::Asset { asset: iron(), qty: 10 });
        assert!(ask.resting);
        assert!(ask.fills.is_empty() && ask.refund.is_none());

        // Buyer market-buys 6 with a 100 MILD budget.
        let buy = ex
            .place(buyer, v, iron(), Side::Bid, OrderKind::Market, 6, Some(100), FEE, 2_000)
            .expect("buy");
        assert_eq!(buy.escrow_taken, Escrow::Mild(100));
        assert!(!buy.resting);
        assert_eq!(buy.fills.len(), 1);
        let (fill, effect) = &buy.fills[0];
        assert_eq!((fill.price, fill.qty), (5, 6));
        assert_eq!(effect.fee_mild, 1); // floor(30 * 5%)
        assert_eq!(effect.seller_proceeds, 29);
        // Unspent budget comes straight back.
        assert_eq!(buy.refund, Some(Escrow::Mild(70)));

        // Inboxes: seller has proceeds, buyer has units.
        assert_eq!(ex.inbox(seller, v).map(|i| i.mild), Some(29));
        assert_eq!(ex.claim(buyer, v).assets, vec![(iron(), 6)]);

        // Seller cancels the remainder: 4 units back.
        let orders = ex.open_orders(seller);
        assert_eq!(orders.len(), 1);
        assert_eq!(orders[0].remaining(), 4);
        let refund = ex.cancel(seller, orders[0].id).expect("cancel");
        assert_eq!(refund, Escrow::Asset { asset: iron(), qty: 4 });

        // Conservation. MILD: buyer escrowed 100 = 70 refund + 29 seller
        // proceeds + 1 fee. Units: seller escrowed 10 = 6 bought + 4 back.
        let seller_inbox = ex.claim(seller, v);
        assert_eq!(seller_inbox.mild, 29);
        assert_eq!(100, 70 + seller_inbox.mild + ex.fees_collected());
        assert!(ex.open_orders(seller).is_empty());
        assert!(ex.open_orders(buyer).is_empty());
    }

    #[test]
    fn limit_bid_price_improvement_refunds() {
        let mut ex = exchange();
        let v = VenueId(0);
        ex.place(player(1), v, iron(), Side::Ask, OrderKind::Limit { price: 5 }, 5, None, 0, 0)
            .expect("ask");
        // Bid at 8 crosses; executes at the maker's 5. Escrow was 8*5=40,
        // spend 25, improvement 15 refunds immediately.
        let bid = ex
            .place(player(2), v, iron(), Side::Bid, OrderKind::Limit { price: 8 }, 5, None, 0, 1)
            .expect("bid");
        assert_eq!(bid.escrow_taken, Escrow::Mild(40));
        assert_eq!(bid.refund, Some(Escrow::Mild(15)));
        assert!(!bid.resting);
    }

    #[test]
    fn market_bid_budget_caps_fills() {
        let mut ex = exchange();
        let v = VenueId(0);
        ex.place(player(1), v, iron(), Side::Ask, OrderKind::Limit { price: 7 }, 10, None, 0, 0)
            .expect("ask");
        // Budget 20 affords only 2 units at 7 (spend 14, 6 back).
        let buy = ex
            .place(player(2), v, iron(), Side::Bid, OrderKind::Market, 10, Some(20), 0, 1)
            .expect("buy");
        assert_eq!(buy.fills.len(), 1);
        assert_eq!(buy.fills[0].0.qty, 2);
        assert_eq!(buy.refund, Some(Escrow::Mild(6)));
        // The remaining 8 asked units still rest.
        assert_eq!(ex.depth(v, iron(), 5).1, vec![(7, 8)]);
    }

    #[test]
    fn market_ask_ioc_refunds_unfilled_units() {
        let mut ex = exchange();
        let v = VenueId(0);
        ex.place(player(1), v, iron(), Side::Bid, OrderKind::Limit { price: 4 }, 3, None, 0, 0)
            .expect("bid");
        // Sell 10 into a 3-unit bid: 7 units come back immediately.
        let sell = ex
            .place(player(2), v, iron(), Side::Ask, OrderKind::Market, 10, None, 0, 1)
            .expect("sell");
        assert_eq!(sell.fills.len(), 1);
        assert_eq!(sell.fills[0].0.qty, 3);
        assert_eq!(sell.refund, Some(Escrow::Asset { asset: iron(), qty: 7 }));
    }

    #[test]
    fn venues_have_independent_books_and_prices() {
        let mut ex = exchange();
        let (v0, v1) = (VenueId(0), VenueId(1));
        let now = 10 * 60_000;
        ex.place(player(1), v0, iron(), Side::Ask, OrderKind::Limit { price: 5 }, 5, None, FEE, now)
            .expect("v0 ask");
        ex.place(player(1), v1, iron(), Side::Ask, OrderKind::Limit { price: 9 }, 5, None, FEE, now)
            .expect("v1 ask");
        ex.place(player(2), v0, iron(), Side::Bid, OrderKind::Market, 2, Some(50), FEE, now + 1)
            .expect("v0 buy");
        ex.place(player(2), v1, iron(), Side::Bid, OrderKind::Market, 2, Some(50), FEE, now + 2)
            .expect("v1 buy");

        assert_eq!(ex.best_ask(v0, iron()), Some(5));
        assert_eq!(ex.best_ask(v1, iron()), Some(9));
        assert_eq!(ex.stats(v0, iron(), now + 3).last_price, Some(5));
        assert_eq!(ex.stats(v1, iron(), now + 3).last_price, Some(9));

        // The index row rolls both venues up (arbitrage visible).
        let summary = ex.asset_summary(iron(), now + 3);
        assert_eq!(summary.venue_prices, vec![(v0, 5), (v1, 9)]);
        assert_eq!(summary.last_price, Some(9)); // newest trade was at v1
        assert_eq!(summary.volume_24h_units, 4);

        let rows = ex.markets_index(now + 3);
        assert_eq!(rows.len(), Asset::all().len());
        let iron_row = rows.iter().find(|r| r.asset == iron()).expect("iron row");
        assert_eq!(iron_row.summary.venue_prices.len(), 2);
    }

    #[test]
    fn cancel_enforces_ownership() {
        let mut ex = exchange();
        let v = VenueId(0);
        let placed = ex
            .place(player(1), v, iron(), Side::Ask, OrderKind::Limit { price: 5 }, 5, None, FEE, 0)
            .expect("ask");
        assert_eq!(ex.cancel(player(2), placed.order_id), Err(ExchangeError::NotYourOrder));
        assert_eq!(ex.cancel(player(2), 999), Err(ExchangeError::UnknownOrder));
        assert!(ex.cancel(player(1), placed.order_id).is_ok());
    }

    #[test]
    fn save_load_roundtrip_preserves_everything() {
        let mut ex = exchange();
        let (a, b) = (player(1), player(2));
        let (v0, v1) = (VenueId(0), VenueId(1));
        let now = 42 * 60_000;

        ex.place(a, v0, iron(), Side::Ask, OrderKind::Limit { price: 5 }, 10, None, FEE, now)
            .expect("ask");
        ex.place(b, v0, iron(), Side::Bid, OrderKind::Market, 4, Some(50), FEE, now + 1)
            .expect("buy");
        ex.place(a, v1, copper(), Side::Bid, OrderKind::Limit { price: 3 }, 6, None, FEE, now + 2)
            .expect("bid");

        let json = serde_json::to_string(&ex.save()).expect("serialize");
        let save: ExchangeSave = serde_json::from_str(&json).expect("deserialize");
        let mut back = Exchange::load(save);

        // Books survive: the ask remainder and the copper bid still rest.
        assert_eq!(back.depth(v0, iron(), 5).1, vec![(5, 6)]);
        assert_eq!(back.depth(v1, copper(), 5).0, vec![(3, 6)]);
        assert_eq!(back.open_orders(a).len(), 2);

        // Inboxes survive: seller proceeds (20 gross - 1 fee) and buyer
        // units are still claimable.
        assert_eq!(back.inbox(a, v0).map(|i| i.mild), Some(19));
        assert_eq!(back.claim(b, v0).assets, vec![(iron(), 4)]);

        // Candles/tape/stats survive.
        assert_eq!(back.candles(v0, iron()).len(), 1);
        assert_eq!(back.candles_tf(v0, iron(), 1, now + 3).len(), 1);
        assert_eq!(back.candles_tf(v0, iron(), 300, now + 3).len(), 1);
        assert_eq!(back.tape(v0, iron()).len(), 1);
        assert_eq!(back.stats(v0, iron(), now + 3).last_price, Some(5));
        assert_eq!(back.fees_collected(), 1);
        assert_eq!(back.venues().len(), 2);

        // New orders after load keep ids unique.
        let next = back
            .place(b, v0, iron(), Side::Bid, OrderKind::Limit { price: 2 }, 1, None, FEE, now + 4)
            .expect("place after load");
        let mut ids: Vec<u64> = back.open_orders(a).iter().map(|o| o.id).collect();
        ids.extend(back.open_orders(b).iter().map(|o| o.id));
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), 3);
        assert!(ids.contains(&next.order_id));
    }
}
