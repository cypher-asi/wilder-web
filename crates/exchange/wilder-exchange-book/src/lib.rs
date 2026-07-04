//! Pure order-book matching engine: price-time priority, limit + IOC market
//! orders. Emits [`Fill`] events only — it knows nothing about inventories,
//! purses or escrow (that's `wilder-exchange-settle`), and never reads a
//! clock (timestamps come in on the order).
//!
//! # Matching rules
//!
//! - Resting orders match in **price-time priority**: best price first, and
//!   within one price level the order that arrived first fills first.
//! - The execution price of every fill is the **maker's** limit price — a
//!   taker crossing the spread gets the resting order's price, never worse.
//! - **Limit** orders cross while the opposite best price satisfies their
//!   limit, then any remainder rests on the book.
//! - **Market** orders are IOC: they sweep the opposite side at maker prices
//!   until the qty is exhausted or the book runs dry; the unfilled remainder
//!   cancels and never rests.
//! - **Self-match prevention**: a taker never fills against their own
//!   resting order. Their own orders are skipped in place (left resting)
//!   and matching continues at the next order, which may be at a worse
//!   price.

use serde::{Deserialize, Serialize};
use wilder_exchange_asset::{Asset, OrderOwner, VenueId};

/// Which side of the book an order sits on: bids buy the asset with WILD,
/// asks sell the asset for WILD.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Side {
    Bid,
    Ask,
}

impl Side {
    pub fn opposite(&self) -> Side {
        match self {
            Side::Bid => Side::Ask,
            Side::Ask => Side::Bid,
        }
    }
}

/// Order pricing: limit orders carry a WILD-per-unit price; market orders
/// take whatever the book offers (IOC).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum OrderKind {
    Limit { price: u32 },
    Market,
}

/// One order, resting or in flight. `filled` accumulates as fills execute;
/// `qty` is the original size.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Order {
    pub id: u64,
    pub owner: OrderOwner,
    pub venue: VenueId,
    pub asset: Asset,
    pub side: Side,
    pub kind: OrderKind,
    pub qty: u32,
    pub filled: u32,
    /// Unix ms when the order was placed (passed in by the caller).
    pub placed_ms: u64,
}

impl Order {
    /// Units still unfilled.
    pub fn remaining(&self) -> u32 {
        self.qty.saturating_sub(self.filled)
    }

    /// The limit price, if any (market orders have none). Every *resting*
    /// order is a limit order, so this is always `Some` for book residents.
    pub fn limit_price(&self) -> Option<u32> {
        match self.kind {
            OrderKind::Limit { price } => Some(price),
            OrderKind::Market => None,
        }
    }
}

/// One execution between a taker (incoming order) and a maker (resting
/// order). `price` is always the maker's limit price.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Fill {
    pub taker_order: u64,
    pub maker_order: u64,
    pub taker: OrderOwner,
    pub maker: OrderOwner,
    /// The side of the *taker*: `Bid` means the taker bought from a resting
    /// ask, `Ask` means the taker sold into a resting bid.
    pub taker_side: Side,
    /// Execution price, WILD per unit (the maker's limit).
    pub price: u32,
    pub qty: u32,
    pub at_ms: u64,
}

/// What happened to the incoming order after matching.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Placement {
    /// Fully filled; nothing rests.
    Filled,
    /// Limit remainder (possibly the whole order) now rests on the book.
    Rested,
    /// Market-order (IOC) remainder cancelled; `remaining` units never
    /// executed and their escrow should be refunded.
    IocCancelled { remaining: u32 },
}

/// Result of [`OrderBook::place`]: the fills that executed plus the final
/// state of the incoming order.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlaceResult {
    pub fills: Vec<Fill>,
    pub placement: Placement,
}

/// One (venue, asset) order book. Bids are kept sorted by descending price,
/// asks by ascending price; within a price level, earlier orders come first
/// (FIFO), giving price-time priority.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct OrderBook {
    bids: Vec<Order>,
    asks: Vec<Order>,
}

impl OrderBook {
    pub fn new() -> Self {
        Self::default()
    }

    /// Match an incoming order against the book, then rest any limit
    /// remainder. See the module docs for the exact matching rules.
    pub fn place(&mut self, mut order: Order) -> PlaceResult {
        let mut fills = Vec::new();
        let limit = order.limit_price();
        let taker_side = order.side;
        let opposite = match taker_side {
            Side::Bid => &mut self.asks,
            Side::Ask => &mut self.bids,
        };

        let mut i = 0;
        while order.remaining() > 0 && i < opposite.len() {
            let maker_price = match opposite[i].limit_price() {
                Some(p) => p,
                None => break, // unreachable: market orders never rest
            };
            let price_ok = match (taker_side, limit) {
                (_, None) => true,
                (Side::Bid, Some(l)) => maker_price <= l,
                (Side::Ask, Some(l)) => maker_price >= l,
            };
            if !price_ok {
                break; // book is sorted; no better price further in
            }
            if opposite[i].owner == order.owner {
                // Self-match prevention: leave own order resting, keep going.
                i += 1;
                continue;
            }
            let maker = &mut opposite[i];
            let qty = order.remaining().min(maker.remaining());
            maker.filled += qty;
            order.filled += qty;
            fills.push(Fill {
                taker_order: order.id,
                maker_order: maker.id,
                taker: order.owner,
                maker: maker.owner,
                taker_side,
                price: maker_price,
                qty,
                at_ms: order.placed_ms,
            });
            if maker.remaining() == 0 {
                opposite.remove(i);
            } else {
                i += 1;
            }
        }

        let placement = if order.remaining() == 0 {
            Placement::Filled
        } else if limit.is_some() {
            self.rest(order);
            Placement::Rested
        } else {
            Placement::IocCancelled { remaining: order.remaining() }
        };
        PlaceResult { fills, placement }
    }

    /// Insert a limit remainder at its price level, behind existing orders
    /// at the same price (FIFO).
    fn rest(&mut self, order: Order) {
        let price = match order.limit_price() {
            Some(p) => p,
            None => return, // market orders never rest
        };
        match order.side {
            Side::Bid => {
                let at = self
                    .bids
                    .iter()
                    .position(|o| o.limit_price().unwrap_or(0) < price)
                    .unwrap_or(self.bids.len());
                self.bids.insert(at, order);
            }
            Side::Ask => {
                let at = self
                    .asks
                    .iter()
                    .position(|o| o.limit_price().unwrap_or(u32::MAX) > price)
                    .unwrap_or(self.asks.len());
                self.asks.insert(at, order);
            }
        }
    }

    /// Remove a resting order, returning it (with `remaining()` still
    /// unfilled) so the caller can refund its escrow.
    pub fn cancel(&mut self, order_id: u64) -> Option<Order> {
        if let Some(at) = self.bids.iter().position(|o| o.id == order_id) {
            return Some(self.bids.remove(at));
        }
        if let Some(at) = self.asks.iter().position(|o| o.id == order_id) {
            return Some(self.asks.remove(at));
        }
        None
    }

    /// Highest resting bid price.
    pub fn best_bid(&self) -> Option<u32> {
        self.bids.first().and_then(|o| o.limit_price())
    }

    /// Lowest resting ask price.
    pub fn best_ask(&self) -> Option<u32> {
        self.asks.first().and_then(|o| o.limit_price())
    }

    /// Top `n` price levels per side as `(price, total qty)`, bids best
    /// (highest) first, asks best (lowest) first.
    pub fn depth(&self, n: usize) -> (Vec<(u32, u32)>, Vec<(u32, u32)>) {
        (Self::aggregate(&self.bids, n), Self::aggregate(&self.asks, n))
    }

    fn aggregate(side: &[Order], n: usize) -> Vec<(u32, u32)> {
        let mut levels: Vec<(u32, u32)> = Vec::new();
        for order in side {
            let price = match order.limit_price() {
                Some(p) => p,
                None => continue,
            };
            match levels.last_mut() {
                Some((p, q)) if *p == price => *q += order.remaining(),
                _ => {
                    if levels.len() >= n {
                        break;
                    }
                    levels.push((price, order.remaining()));
                }
            }
        }
        levels
    }

    /// All resting orders belonging to one owner (bids then asks).
    pub fn orders_for(&self, owner: OrderOwner) -> Vec<&Order> {
        self.iter().filter(|o| o.owner == owner).collect()
    }

    /// Iterate every resting order (bids best-first, then asks best-first).
    pub fn iter(&self) -> impl Iterator<Item = &Order> {
        self.bids.iter().chain(self.asks.iter())
    }

    /// True when nothing rests on either side.
    pub fn is_empty(&self) -> bool {
        self.bids.is_empty() && self.asks.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wilder_types::CharacterId;

    fn owner(n: u128) -> OrderOwner {
        OrderOwner::Player(CharacterId::from_u128(n))
    }

    fn venue() -> VenueId {
        VenueId(0)
    }

    fn asset() -> Asset {
        Asset::Item(wilder_types::ItemKind::Iron)
    }

    fn limit(id: u64, who: OrderOwner, side: Side, price: u32, qty: u32, t: u64) -> Order {
        Order {
            id,
            owner: who,
            venue: venue(),
            asset: asset(),
            side,
            kind: OrderKind::Limit { price },
            qty,
            filled: 0,
            placed_ms: t,
        }
    }

    fn market(id: u64, who: OrderOwner, side: Side, qty: u32, t: u64) -> Order {
        Order {
            id,
            owner: who,
            venue: venue(),
            asset: asset(),
            side,
            kind: OrderKind::Market,
            qty,
            filled: 0,
            placed_ms: t,
        }
    }

    #[test]
    fn limit_rests_when_no_cross() {
        let mut book = OrderBook::new();
        let r = book.place(limit(1, owner(1), Side::Bid, 10, 5, 0));
        assert!(r.fills.is_empty());
        assert_eq!(r.placement, Placement::Rested);
        assert_eq!(book.best_bid(), Some(10));
        assert_eq!(book.best_ask(), None);
    }

    #[test]
    fn price_time_priority_fifo_within_level() {
        let mut book = OrderBook::new();
        book.place(limit(1, owner(1), Side::Ask, 10, 5, 0));
        book.place(limit(2, owner(2), Side::Ask, 10, 5, 1));

        // Taker for 5 fills the earlier order (id 1) entirely, not id 2.
        let r = book.place(limit(3, owner(3), Side::Bid, 10, 5, 2));
        assert_eq!(r.fills.len(), 1);
        assert_eq!(r.fills[0].maker_order, 1);
        assert_eq!(r.placement, Placement::Filled);
        // Order 2 still rests untouched.
        let rest: Vec<u64> = book.iter().map(|o| o.id).collect();
        assert_eq!(rest, vec![2]);
    }

    #[test]
    fn better_price_fills_before_earlier_time() {
        let mut book = OrderBook::new();
        book.place(limit(1, owner(1), Side::Ask, 12, 5, 0)); // earlier, worse
        book.place(limit(2, owner(2), Side::Ask, 10, 5, 1)); // later, better

        let r = book.place(limit(3, owner(3), Side::Bid, 12, 5, 2));
        assert_eq!(r.fills.len(), 1);
        assert_eq!(r.fills[0].maker_order, 2);
        assert_eq!(r.fills[0].price, 10);
    }

    #[test]
    fn partial_fills_across_levels() {
        let mut book = OrderBook::new();
        book.place(limit(1, owner(1), Side::Ask, 10, 3, 0));
        book.place(limit(2, owner(2), Side::Ask, 12, 4, 1));

        let r = book.place(limit(3, owner(3), Side::Bid, 12, 6, 2));
        assert_eq!(r.fills.len(), 2);
        assert_eq!((r.fills[0].price, r.fills[0].qty), (10, 3));
        assert_eq!((r.fills[1].price, r.fills[1].qty), (12, 3));
        assert_eq!(r.placement, Placement::Filled);
        // One unit of order 2 still rests.
        let leftovers: Vec<(u64, u32)> = book.iter().map(|o| (o.id, o.remaining())).collect();
        assert_eq!(leftovers, vec![(2, 1)]);
    }

    #[test]
    fn limit_crosses_then_rests_remainder() {
        let mut book = OrderBook::new();
        book.place(limit(1, owner(1), Side::Ask, 10, 3, 0));

        let r = book.place(limit(2, owner(2), Side::Bid, 11, 8, 1));
        assert_eq!(r.fills.len(), 1);
        assert_eq!((r.fills[0].price, r.fills[0].qty), (10, 3));
        assert_eq!(r.placement, Placement::Rested);
        assert_eq!(book.best_bid(), Some(11));
        assert_eq!(book.orders_for(owner(2))[0].remaining(), 5);
    }

    #[test]
    fn market_ioc_remainder_cancels() {
        let mut book = OrderBook::new();
        book.place(limit(1, owner(1), Side::Ask, 10, 3, 0));

        let r = book.place(market(2, owner(2), Side::Bid, 10, 1));
        assert_eq!(r.fills.len(), 1);
        assert_eq!(r.fills[0].qty, 3);
        assert_eq!(r.placement, Placement::IocCancelled { remaining: 7 });
        // Nothing rested: the market remainder is gone.
        assert!(book.is_empty());
    }

    #[test]
    fn market_into_empty_book_cancels_whole_qty() {
        let mut book = OrderBook::new();
        let r = book.place(market(1, owner(1), Side::Ask, 5, 0));
        assert!(r.fills.is_empty());
        assert_eq!(r.placement, Placement::IocCancelled { remaining: 5 });
    }

    #[test]
    fn execution_at_maker_price() {
        let mut book = OrderBook::new();
        book.place(limit(1, owner(1), Side::Bid, 20, 5, 0));

        // Taker asks 15 but the resting bid pays 20: fill at 20 (maker).
        let r = book.place(limit(2, owner(2), Side::Ask, 15, 5, 1));
        assert_eq!(r.fills[0].price, 20);
        assert_eq!(r.fills[0].taker_side, Side::Ask);
    }

    #[test]
    fn self_match_prevented_and_matching_continues() {
        let mut book = OrderBook::new();
        book.place(limit(1, owner(1), Side::Ask, 10, 5, 0)); // own, best price
        book.place(limit(2, owner(2), Side::Ask, 11, 5, 1)); // other, worse

        let r = book.place(limit(3, owner(1), Side::Bid, 11, 5, 2));
        // Skipped own ask at 10, filled other's ask at 11.
        assert_eq!(r.fills.len(), 1);
        assert_eq!(r.fills[0].maker_order, 2);
        assert_eq!(r.fills[0].price, 11);
        // Own ask still rests untouched.
        assert_eq!(book.orders_for(owner(1)).len(), 1);
        assert_eq!(book.orders_for(owner(1))[0].id, 1);
    }

    #[test]
    fn self_match_only_own_orders_rests_remainder() {
        let mut book = OrderBook::new();
        book.place(limit(1, owner(1), Side::Ask, 10, 5, 0));

        // Same owner bids across their own ask: no fill, bid rests.
        let r = book.place(limit(2, owner(1), Side::Bid, 10, 5, 1));
        assert!(r.fills.is_empty());
        assert_eq!(r.placement, Placement::Rested);
        assert_eq!(book.best_bid(), Some(10));
        assert_eq!(book.best_ask(), Some(10));
    }

    #[test]
    fn cancel_returns_remaining_qty() {
        let mut book = OrderBook::new();
        book.place(limit(1, owner(1), Side::Ask, 10, 8, 0));
        book.place(market(2, owner(2), Side::Bid, 3, 1)); // partially fills 1

        let cancelled = book.cancel(1).expect("order should rest");
        assert_eq!(cancelled.remaining(), 5);
        assert!(book.is_empty());
        assert!(book.cancel(1).is_none());
    }

    #[test]
    fn depth_aggregates_levels() {
        let mut book = OrderBook::new();
        book.place(limit(1, owner(1), Side::Bid, 10, 3, 0));
        book.place(limit(2, owner(2), Side::Bid, 10, 4, 1));
        book.place(limit(3, owner(3), Side::Bid, 9, 2, 2));
        book.place(limit(4, owner(1), Side::Ask, 12, 5, 3));
        book.place(limit(5, owner(2), Side::Ask, 13, 1, 4));

        let (bids, asks) = book.depth(10);
        assert_eq!(bids, vec![(10, 7), (9, 2)]);
        assert_eq!(asks, vec![(12, 5), (13, 1)]);

        // n limits the number of levels, not orders.
        let (bids, _) = book.depth(1);
        assert_eq!(bids, vec![(10, 7)]);
    }

    #[test]
    fn serde_roundtrip_preserves_book() {
        let mut book = OrderBook::new();
        book.place(limit(1, owner(1), Side::Bid, 10, 3, 0));
        book.place(limit(2, owner(2), Side::Ask, 12, 4, 1));

        let json = serde_json::to_string(&book).expect("serialize");
        let back: OrderBook = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back.best_bid(), Some(10));
        assert_eq!(back.best_ask(), Some(12));
        assert_eq!(back.iter().count(), 2);
    }
}
