//! Escrow + settlement as pure state machines. The exchange never touches
//! real inventories or purses: `wilder-world` debits the [`Escrow`] this
//! crate says an order locks, and later applies the [`Inbox`] credits and
//! refunds it reports. Everything here is bookkeeping over those promises.
//!
//! # Escrow rules (Phase 2 must follow these exactly)
//!
//! What placing an order locks (debited from the actor before `place`):
//!
//! - **Limit bid**: `price * qty` MILD.
//! - **Market bid**: a caller-chosen `max_spend` MILD budget (the order can
//!   never spend more than the lock).
//! - **Ask (limit or market)**: `qty` units of the asset.
//!
//! Refunds (returned to the actor *immediately*, not via the inbox):
//!
//! - A cancelled order refunds its full remaining lock
//!   ([`Settlement::on_cancel`]).
//! - A market order's IOC remainder — unfilled units for asks, unspent MILD
//!   for bids — refunds right after the match (the facade releases the
//!   leftover lock via [`Settlement::on_cancel`] once matching ends).
//! - A limit bid that fills below its limit (price improvement: execution
//!   is always at the maker's price) refunds `(limit - fill_price) * qty`
//!   per fill, reported as [`FillEffect::taker_bid_refund`].
//!
//! # Fee rule
//!
//! The fee is charged on each fill, carved out of the MILD leg — the taker's
//! payment when the taker buys, the taker's proceeds when the taker sells.
//! It is **never pre-locked**: `fee = gross * fee_pct / 100` (rounding
//! down, `gross = price * qty`), and the ask-side owner's inbox is credited
//! `gross - fee` while the bid side pays exactly `gross` from its lock.
//! Fees accumulate in [`Settlement::fees_collected`] for the world to route
//! (territory holder or burn), matching the old market's seller-side net.
//!
//! # Settlement inboxes
//!
//! Fill proceeds land in a per-(venue, owner) [`Inbox`]: MILD for filled
//! asks, assets for filled bids. The owner claims by interacting at that
//! venue's terminal ([`Settlement::claim`]), which drains the inbox.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use wilder_exchange_asset::{Asset, OrderOwner, VenueId};
use wilder_exchange_book::{Fill, Side};

/// What one open order has locked away from its owner.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Escrow {
    /// MILD held for a bid (limit: `price * qty`; market: `max_spend`).
    Mild(u64),
    /// Asset units held for an ask.
    Asset { asset: Asset, qty: u32 },
}

/// Un-claimed fill proceeds for one (venue, owner): MILD from filled asks,
/// assets from filled bids. Claimed at the venue's terminal.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Inbox {
    pub mild: u64,
    pub assets: Vec<(Asset, u32)>,
}

impl Inbox {
    pub fn credit_mild(&mut self, amount: u64) {
        self.mild = self.mild.saturating_add(amount);
    }

    pub fn credit_asset(&mut self, asset: Asset, qty: u32) {
        if qty == 0 {
            return;
        }
        match self.assets.iter_mut().find(|(a, _)| *a == asset) {
            Some((_, q)) => *q = q.saturating_add(qty),
            None => self.assets.push((asset, qty)),
        }
    }

    /// Drain everything, leaving the inbox empty (the claim operation).
    pub fn take_all(&mut self) -> Inbox {
        std::mem::take(self)
    }

    pub fn is_empty(&self) -> bool {
        self.mild == 0 && self.assets.iter().all(|(_, q)| *q == 0)
    }
}

/// Per-fill settlement effects: what moved where, for the facade to report
/// and the world to apply (inbox credits are already applied internally).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct FillEffect {
    /// Fee carved from the MILD leg (world routes it: territory or burn).
    pub fee_mild: u64,
    /// MILD credited to the ask-side owner's inbox (`gross - fee`).
    pub seller_proceeds: u64,
    /// Asset units credited to the bid-side owner's inbox.
    pub buyer_assets: (Asset, u32),
    /// Price-improvement MILD owed back to a limit-bid *taker* immediately
    /// (their lock was at their limit, the fill executed cheaper). Zero for
    /// market bids and for all makers.
    pub taker_bid_refund: u64,
}

/// Persisted form: Vecs keep the JSON free of non-string map keys.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SettlementSave {
    locks: Vec<(u64, Escrow)>,
    inboxes: Vec<(VenueId, OrderOwner, Inbox)>,
    fees_collected: u64,
}

/// The escrow ledger: remaining lock per open order, un-claimed inbox per
/// (venue, owner), and the running fee total.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(from = "SettlementSave", into = "SettlementSave")]
pub struct Settlement {
    locks: HashMap<u64, Escrow>,
    inboxes: HashMap<(VenueId, OrderOwner), Inbox>,
    fees_collected: u64,
}

impl From<SettlementSave> for Settlement {
    fn from(save: SettlementSave) -> Self {
        Self {
            locks: save.locks.into_iter().collect(),
            inboxes: save.inboxes.into_iter().map(|(v, o, i)| ((v, o), i)).collect(),
            fees_collected: save.fees_collected,
        }
    }
}

impl From<Settlement> for SettlementSave {
    fn from(s: Settlement) -> Self {
        let mut locks: Vec<(u64, Escrow)> = s.locks.into_iter().collect();
        locks.sort_by_key(|(id, _)| *id);
        let mut inboxes: Vec<(VenueId, OrderOwner, Inbox)> =
            s.inboxes.into_iter().map(|((v, o), i)| (v, o, i)).collect();
        inboxes.sort_by_key(|(v, o, _)| (*v, *o));
        Self { locks, inboxes, fees_collected: s.fees_collected }
    }
}

impl Settlement {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record what a freshly placed order has locked. The world must have
    /// already debited this from the owner.
    pub fn lock(&mut self, order_id: u64, escrow: Escrow) {
        self.locks.insert(order_id, escrow);
    }

    /// The remaining lock of an open order, if any.
    pub fn locked(&self, order_id: u64) -> Option<&Escrow> {
        self.locks.get(&order_id)
    }

    /// Settle one fill: debit both sides' locks, credit both inboxes, carve
    /// the fee from the MILD leg. `taker_limit_price` is the incoming
    /// order's limit when the taker is a *limit bid* (drives the
    /// price-improvement refund); `None` for market takers and ask takers.
    ///
    /// A lock that hits zero (or an asset lock that hits zero qty) is
    /// removed; the facade releases any market-order leftover afterwards
    /// via [`Self::on_cancel`].
    pub fn on_fill(
        &mut self,
        venue: VenueId,
        asset: Asset,
        fill: &Fill,
        taker_limit_price: Option<u32>,
        fee_pct: u32,
    ) -> FillEffect {
        let gross = fill.price as u64 * fill.qty as u64;
        let fee = gross * fee_pct.min(100) as u64 / 100;
        let (buyer, seller) = match fill.taker_side {
            Side::Bid => (fill.taker, fill.maker),
            Side::Ask => (fill.maker, fill.taker),
        };

        // Bid side pays MILD from its lock. Takers with a limit above the
        // execution price locked at their limit rate, so the difference
        // comes back to them as an immediate refund.
        let mut taker_bid_refund = 0u64;
        let bid_is_taker = fill.taker_side == Side::Bid;
        let bid_debit = match (bid_is_taker, taker_limit_price) {
            (true, Some(limit)) => {
                let locked_rate = limit.max(fill.price) as u64;
                taker_bid_refund = (locked_rate - fill.price as u64) * fill.qty as u64;
                locked_rate * fill.qty as u64
            }
            // Market-bid taker or resting maker bid (whose limit *is* the
            // execution price): pay exactly gross.
            _ => gross,
        };
        self.debit_mild(bid_order_id(fill), bid_debit);
        self.debit_asset(ask_order_id(fill), fill.qty);

        // Credits: seller nets the MILD leg minus the fee, buyer gets units.
        let seller_proceeds = gross - fee;
        self.inbox_mut(venue, seller).credit_mild(seller_proceeds);
        self.inbox_mut(venue, buyer).credit_asset(asset, fill.qty);
        self.fees_collected += fee;

        FillEffect {
            fee_mild: fee,
            seller_proceeds,
            buyer_assets: (asset, fill.qty),
            taker_bid_refund,
        }
    }

    /// Release an order's remaining lock (cancel, or the IOC remainder of a
    /// market order after matching). Returns the escrow the world must
    /// refund to the owner; `None` when nothing (left) is locked.
    pub fn on_cancel(&mut self, order_id: u64) -> Option<Escrow> {
        match self.locks.remove(&order_id) {
            Some(Escrow::Mild(0)) => None,
            Some(Escrow::Asset { qty: 0, .. }) => None,
            other => other,
        }
    }

    /// Read-only inbox view for one (venue, owner).
    pub fn inbox(&self, venue: VenueId, owner: OrderOwner) -> Option<&Inbox> {
        self.inboxes.get(&(venue, owner))
    }

    /// Drain the (venue, owner) inbox — the terminal "claim" interaction.
    pub fn claim(&mut self, venue: VenueId, owner: OrderOwner) -> Inbox {
        self.inboxes
            .get_mut(&(venue, owner))
            .map(|i| i.take_all())
            .unwrap_or_default()
    }

    /// Merge `inbox` back into the (venue, owner) inbox. The partial-claim
    /// path: the world claims, materializes what fits the actor's pack, and
    /// restores the remainder here so nothing is lost.
    pub fn restore(&mut self, venue: VenueId, owner: OrderOwner, inbox: Inbox) {
        if inbox.is_empty() {
            return;
        }
        let slot = self.inbox_mut(venue, owner);
        slot.credit_mild(inbox.mild);
        for (asset, qty) in inbox.assets {
            slot.credit_asset(asset, qty);
        }
    }

    /// Total fee MILD carved from fills so far (the world routes/burns it
    /// as it sees fit; this is the audit counter).
    pub fn fees_collected(&self) -> u64 {
        self.fees_collected
    }

    /// Sum of all MILD still locked (audit/tests).
    pub fn total_locked_mild(&self) -> u64 {
        self.locks
            .values()
            .map(|e| match e {
                Escrow::Mild(m) => *m,
                Escrow::Asset { .. } => 0,
            })
            .sum()
    }

    fn inbox_mut(&mut self, venue: VenueId, owner: OrderOwner) -> &mut Inbox {
        self.inboxes.entry((venue, owner)).or_default()
    }

    fn debit_mild(&mut self, order_id: u64, amount: u64) {
        if let Some(Escrow::Mild(locked)) = self.locks.get_mut(&order_id) {
            *locked = locked.saturating_sub(amount);
            if *locked == 0 {
                self.locks.remove(&order_id);
            }
        }
    }

    fn debit_asset(&mut self, order_id: u64, qty: u32) {
        if let Some(Escrow::Asset { qty: locked, .. }) = self.locks.get_mut(&order_id) {
            *locked = locked.saturating_sub(qty);
            if *locked == 0 {
                self.locks.remove(&order_id);
            }
        }
    }
}

/// The order id on the bid side of a fill.
fn bid_order_id(fill: &Fill) -> u64 {
    match fill.taker_side {
        Side::Bid => fill.taker_order,
        Side::Ask => fill.maker_order,
    }
}

/// The order id on the ask side of a fill.
fn ask_order_id(fill: &Fill) -> u64 {
    match fill.taker_side {
        Side::Bid => fill.maker_order,
        Side::Ask => fill.taker_order,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wilder_types::{CharacterId, ItemKind};

    fn iron() -> Asset {
        Asset::Item(ItemKind::Iron)
    }

    fn owner(n: u128) -> OrderOwner {
        OrderOwner::Player(CharacterId::from_u128(n))
    }

    fn venue() -> VenueId {
        VenueId(0)
    }

    fn fill(
        taker_order: u64,
        maker_order: u64,
        taker: OrderOwner,
        maker: OrderOwner,
        taker_side: Side,
        price: u32,
        qty: u32,
    ) -> Fill {
        Fill { taker_order, maker_order, taker, maker, taker_side, price, qty, at_ms: 0 }
    }

    #[test]
    fn lock_and_cancel_roundtrip() {
        let mut s = Settlement::new();
        s.lock(1, Escrow::Mild(100));
        s.lock(2, Escrow::Asset { asset: iron(), qty: 7 });

        assert_eq!(s.on_cancel(1), Some(Escrow::Mild(100)));
        assert_eq!(s.on_cancel(1), None);
        assert_eq!(s.on_cancel(2), Some(Escrow::Asset { asset: iron(), qty: 7 }));
    }

    #[test]
    fn fill_moves_value_and_carves_fee() {
        let mut s = Settlement::new();
        let (buyer, seller) = (owner(1), owner(2));
        // Maker ask: 10 units locked. Taker limit bid at 6, locked 6*10.
        s.lock(1, Escrow::Asset { asset: iron(), qty: 10 });
        s.lock(2, Escrow::Mild(60));

        // Executes at the maker's price 5 for all 10 units (5% fee).
        let f = fill(2, 1, buyer, seller, Side::Bid, 5, 10);
        let effect = s.on_fill(venue(), iron(), &f, Some(6), 5);

        assert_eq!(effect.fee_mild, 2); // floor(50 * 5%)
        assert_eq!(effect.seller_proceeds, 48);
        assert_eq!(effect.buyer_assets, (iron(), 10));
        assert_eq!(effect.taker_bid_refund, 10); // (6 - 5) * 10

        // Both locks fully consumed: 6*10 debited from the bid (refund is
        // part of the debit), 10 units from the ask.
        assert_eq!(s.locked(1), None);
        assert_eq!(s.locked(2), None);
        assert_eq!(s.inbox(venue(), seller).map(|i| i.mild), Some(48));
        assert_eq!(
            s.inbox(venue(), buyer).map(|i| i.assets.clone()),
            Some(vec![(iron(), 10)])
        );
        assert_eq!(s.fees_collected(), 2);
    }

    #[test]
    fn partial_fill_then_cancel_refunds_remainder() {
        let mut s = Settlement::new();
        let (buyer, seller) = (owner(1), owner(2));
        // Maker limit bid at 4 for 10 units: locks 40 MILD.
        s.lock(1, Escrow::Mild(40));
        // Taker market ask sells 3 units into it (asset lock of 3).
        s.lock(2, Escrow::Asset { asset: iron(), qty: 3 });

        let f = fill(2, 1, seller, buyer, Side::Ask, 4, 3);
        let effect = s.on_fill(venue(), iron(), &f, None, 5);
        assert_eq!(effect.taker_bid_refund, 0); // maker bid pays its own price
        assert_eq!(effect.seller_proceeds, 12); // floor(12 * 5%) = 0 fee
        assert_eq!(effect.fee_mild, 0);

        // Bid keeps 40 - 12 = 28 locked for the 7 unfilled units.
        assert_eq!(s.locked(1), Some(&Escrow::Mild(28)));
        assert_eq!(s.on_cancel(1), Some(Escrow::Mild(28)));
    }

    #[test]
    fn market_bid_leftover_releases_after_match() {
        let mut s = Settlement::new();
        // Market bid with max_spend 100 fills 6 units at 9 = 54 spent.
        s.lock(1, Escrow::Mild(100));
        s.lock(2, Escrow::Asset { asset: iron(), qty: 6 });
        let f = fill(1, 2, owner(1), owner(2), Side::Bid, 9, 6);
        let effect = s.on_fill(venue(), iron(), &f, None, 5);
        assert_eq!(effect.taker_bid_refund, 0);
        // The facade releases the unspent budget as the IOC refund.
        assert_eq!(s.on_cancel(1), Some(Escrow::Mild(46)));
    }

    #[test]
    fn claim_drains_inbox_once() {
        let mut s = Settlement::new();
        let who = owner(1);
        s.inbox_mut(venue(), who).credit_mild(30);
        s.inbox_mut(venue(), who).credit_asset(iron(), 4);
        s.inbox_mut(venue(), who).credit_asset(iron(), 2);

        let claimed = s.claim(venue(), who);
        assert_eq!(claimed.mild, 30);
        assert_eq!(claimed.assets, vec![(iron(), 6)]);
        assert!(s.claim(venue(), who).is_empty());
        // Other venues are untouched buckets.
        assert!(s.claim(VenueId(9), who).is_empty());
    }

    #[test]
    fn fee_math_rounds_down() {
        let mut s = Settlement::new();
        s.lock(1, Escrow::Mild(1000));
        s.lock(2, Escrow::Asset { asset: iron(), qty: 3 });
        // gross = 33, 5% = 1.65 -> fee 1.
        let f = fill(1, 2, owner(1), owner(2), Side::Bid, 11, 3);
        let effect = s.on_fill(venue(), iron(), &f, None, 5);
        assert_eq!(effect.fee_mild, 1);
        assert_eq!(effect.seller_proceeds, 32);
    }

    /// Conservation over random order sequences run through a real book:
    /// every MILD/asset unit locked in is either still locked, sitting in
    /// an inbox, collected as a fee, or refunded — nothing leaks.
    #[test]
    fn conservation_invariant_over_random_sequences() {
        use wilder_exchange_book::{Order, OrderBook, OrderKind, Placement};

        // Tiny deterministic PRNG (xorshift64*) — no rand dependency.
        struct Rng(u64);
        impl Rng {
            fn next(&mut self) -> u64 {
                let mut x = self.0;
                x ^= x >> 12;
                x ^= x << 25;
                x ^= x >> 27;
                self.0 = x;
                x.wrapping_mul(0x2545_f491_4f6c_dd1d)
            }
            fn below(&mut self, n: u64) -> u64 {
                self.next() % n
            }
        }

        for seed in 1..6u64 {
            let mut rng = Rng(seed.wrapping_mul(0x9e37_79b9_7f4a_7c15));
            let mut book = OrderBook::new();
            let mut settle = Settlement::new();
            let owners: Vec<OrderOwner> = (1..5).map(owner).collect();
            let fee_pct = 5;

            // Value entering the system (locks) vs leaving (refunds/claims).
            let mut mild_in = 0u64;
            let mut units_in = 0u64;
            let mut mild_out = 0u64; // refunds + claimed inbox MILD
            let mut units_out = 0u64; // refunds + claimed inbox units
            let mut resting: Vec<u64> = Vec::new();

            for step in 0..400u64 {
                let id = step + 1;
                let who = owners[rng.below(owners.len() as u64) as usize];
                let side = if rng.below(2) == 0 { Side::Bid } else { Side::Ask };
                let qty = 1 + rng.below(9) as u32;
                let is_market = rng.below(4) == 0;
                let (kind, limit_price) = if is_market {
                    (OrderKind::Market, None)
                } else {
                    let p = 5 + rng.below(10) as u32;
                    (OrderKind::Limit { price: p }, Some(p))
                };

                // Lock escrow exactly as the facade will.
                let escrow = match side {
                    Side::Bid => {
                        let budget = match limit_price {
                            Some(p) => p as u64 * qty as u64,
                            None => 20 * qty as u64, // market max_spend
                        };
                        mild_in += budget;
                        Escrow::Mild(budget)
                    }
                    Side::Ask => {
                        units_in += qty as u64;
                        Escrow::Asset { asset: iron(), qty }
                    }
                };
                settle.lock(id, escrow);

                let order = Order {
                    id,
                    owner: who,
                    venue: venue(),
                    asset: iron(),
                    side,
                    kind,
                    qty,
                    filled: 0,
                    placed_ms: step,
                };
                let result = book.place(order);
                for f in &result.fills {
                    let taker_limit =
                        if side == Side::Bid { limit_price } else { None };
                    let effect = settle.on_fill(venue(), iron(), f, taker_limit, fee_pct);
                    mild_out += effect.taker_bid_refund;
                }
                match result.placement {
                    Placement::Rested => resting.push(id),
                    // Filled or IOC-cancelled: release any leftover lock.
                    _ => match settle.on_cancel(id) {
                        Some(Escrow::Mild(m)) => mild_out += m,
                        Some(Escrow::Asset { qty, .. }) => units_out += qty as u64,
                        None => {}
                    },
                }
                // Sometimes a maker fully fills: its lock self-cleans, but
                // drop it from the resting set when the book no longer has
                // it.
                resting.retain(|rid| book.iter().any(|o| o.id == *rid));

                // Occasionally cancel a random resting order.
                if !resting.is_empty() && rng.below(5) == 0 {
                    let victim = resting.remove(rng.below(resting.len() as u64) as usize);
                    let cancelled = book.cancel(victim);
                    assert!(cancelled.is_some());
                    match settle.on_cancel(victim) {
                        Some(Escrow::Mild(m)) => mild_out += m,
                        Some(Escrow::Asset { qty, .. }) => units_out += qty as u64,
                        None => {}
                    }
                }

                // Occasionally claim an inbox.
                if rng.below(7) == 0 {
                    let claimed = settle.claim(venue(), who);
                    mild_out += claimed.mild;
                    units_out += claimed.assets.iter().map(|(_, q)| *q as u64).sum::<u64>();
                }
            }

            // Drain what's left: cancel every resting order, claim every
            // inbox.
            for rid in resting {
                if book.cancel(rid).is_some() {
                    match settle.on_cancel(rid) {
                        Some(Escrow::Mild(m)) => mild_out += m,
                        Some(Escrow::Asset { qty, .. }) => units_out += qty as u64,
                        None => {}
                    }
                }
            }
            for who in &owners {
                let claimed = settle.claim(venue(), *who);
                mild_out += claimed.mild;
                units_out += claimed.assets.iter().map(|(_, q)| *q as u64).sum::<u64>();
            }

            assert_eq!(
                mild_in,
                mild_out + settle.fees_collected(),
                "seed {seed}: MILD leaked (in {mild_in}, out {mild_out}, fees {})",
                settle.fees_collected()
            );
            assert_eq!(units_in, units_out, "seed {seed}: asset units leaked");
            assert_eq!(settle.total_locked_mild(), 0);
        }
    }

    #[test]
    fn save_roundtrip() {
        let mut s = Settlement::new();
        s.lock(1, Escrow::Mild(50));
        s.lock(2, Escrow::Asset { asset: iron(), qty: 3 });
        s.inbox_mut(venue(), owner(1)).credit_mild(12);
        s.inbox_mut(venue(), owner(1)).credit_asset(iron(), 2);

        let json = serde_json::to_string(&s).expect("serialize");
        let back: Settlement = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back.locked(1), Some(&Escrow::Mild(50)));
        assert_eq!(back.locked(2), Some(&Escrow::Asset { asset: iron(), qty: 3 }));
        assert_eq!(back.inbox(venue(), owner(1)).map(|i| i.mild), Some(12));
    }
}
