//! Per-item market price history: every player-market fill (player or agent
//! buyer) is recorded at its actual `price_each` and aggregated into
//! per-minute buckets, giving each item kind a real price-over-time series
//! plus running trade totals. The economy dashboard's item drill-in charts
//! this data; agent pricing reads the last fill as its market reference.
//!
//! Vendor trades are *not* recorded here — vendor tables are fixed reference
//! prices, not a floating market.

use std::collections::{HashMap, HashSet, VecDeque};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use wilder_types::{ItemKind, PriceBucket};

/// Fill prices aggregate into buckets of this many milliseconds (1 minute).
pub const BUCKET_MS: u64 = 60_000;
/// Buckets kept per item: 24 h of minutes. Sparse — only traded minutes are
/// stored, so quiet items keep far longer than a day of history.
pub const BUCKET_CAP: usize = 1440;

/// One item kind's price history + lifetime totals.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ItemHistory {
    /// Fill-price buckets, oldest first.
    pub buckets: VecDeque<PriceBucket>,
    pub total_fills: u64,
    pub total_units: u64,
    /// Lifetime MILD volume across all fills.
    pub total_wild: u64,
    /// Most recent fill price (MILD per unit).
    pub last_price: u32,
    /// Unix ms of the most recent fill.
    pub last_trade_ms: u64,
}

/// Persisted form: a Vec keeps the JSON free of enum map keys (same pattern
/// as `LedgerSave.items`).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MarketStatsSave {
    pub items: Vec<(ItemKind, ItemHistory)>,
}

#[derive(Debug, Default)]
pub struct MarketStats {
    items: HashMap<ItemKind, ItemHistory>,
    /// Kinds with new fills since the last dashboard push.
    dirty: HashSet<ItemKind>,
}

fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl MarketStats {
    pub fn new(save: MarketStatsSave) -> Self {
        Self {
            items: save.items.into_iter().collect(),
            dirty: HashSet::new(),
        }
    }

    pub fn save(&self) -> MarketStatsSave {
        let mut items: Vec<(ItemKind, ItemHistory)> =
            self.items.iter().map(|(&k, h)| (k, h.clone())).collect();
        items.sort_by_key(|(k, _)| format!("{k:?}"));
        MarketStatsSave { items }
    }

    /// Record one market fill at the current wall clock.
    pub fn record_fill(&mut self, kind: ItemKind, price_each: u32, count: u32) {
        self.record_fill_at(kind, price_each, count, unix_ms());
    }

    /// Record one market fill at an explicit timestamp (tests).
    pub fn record_fill_at(&mut self, kind: ItemKind, price_each: u32, count: u32, now_ms: u64) {
        if count == 0 {
            return;
        }
        let wild = price_each as u64 * count as u64;
        let h = self.items.entry(kind).or_default();
        h.total_fills += 1;
        h.total_units += count as u64;
        h.total_wild += wild;
        h.last_price = price_each;
        h.last_trade_ms = now_ms;

        let bucket_t = now_ms / BUCKET_MS * BUCKET_MS;
        match h.buckets.back_mut() {
            Some(b) if b.t == bucket_t => {
                b.units += count;
                b.wild += wild;
                b.min = b.min.min(price_each);
                b.max = b.max.max(price_each);
                b.fills += 1;
                b.avg = (b.wild / b.units.max(1) as u64) as u32;
            }
            _ => {
                if h.buckets.len() >= BUCKET_CAP {
                    h.buckets.pop_front();
                }
                h.buckets.push_back(PriceBucket {
                    t: bucket_t,
                    avg: price_each,
                    min: price_each,
                    max: price_each,
                    units: count,
                    wild,
                    fills: 1,
                });
            }
        }
        self.dirty.insert(kind);
    }

    pub fn history(&self, kind: ItemKind) -> Option<&ItemHistory> {
        self.items.get(&kind)
    }

    /// The most recent fill price for a kind, if it has ever traded.
    pub fn last_price(&self, kind: ItemKind) -> Option<u32> {
        self.items.get(&kind).filter(|h| h.total_fills > 0).map(|h| h.last_price)
    }

    /// Mark a kind dirty without a fill (its order book changed, e.g. ask
    /// decay), so watchers get a refreshed snapshot.
    pub fn mark_dirty(&mut self, kind: ItemKind) {
        self.dirty.insert(kind);
    }

    /// Kinds with fills since the last call (drives throttled dashboard pushes).
    pub fn take_dirty(&mut self) -> HashSet<ItemKind> {
        std::mem::take(&mut self.dirty)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fills_aggregate_into_buckets() {
        let mut stats = MarketStats::default();
        let t0 = 1_000_000 * BUCKET_MS; // aligned bucket start

        // Two fills in the same minute merge; a later fill opens a new bucket.
        stats.record_fill_at(ItemKind::Iron, 2, 10, t0 + 5_000);
        stats.record_fill_at(ItemKind::Iron, 4, 10, t0 + 30_000);
        stats.record_fill_at(ItemKind::Iron, 3, 5, t0 + BUCKET_MS + 1_000);

        let h = stats.history(ItemKind::Iron).unwrap();
        assert_eq!(h.buckets.len(), 2);
        let first = h.buckets[0];
        assert_eq!(first.t, t0);
        assert_eq!(first.units, 20);
        assert_eq!(first.wild, 2 * 10 + 4 * 10);
        assert_eq!(first.avg, 3); // (20 + 40) / 20
        assert_eq!(first.min, 2);
        assert_eq!(first.max, 4);
        assert_eq!(first.fills, 2);
        assert_eq!(h.total_fills, 3);
        assert_eq!(h.total_units, 25);
        assert_eq!(h.last_price, 3);
        assert_eq!(stats.last_price(ItemKind::Iron), Some(3));
        assert_eq!(stats.last_price(ItemKind::Copper), None);

        // Dirty set drains once.
        let dirty = stats.take_dirty();
        assert!(dirty.contains(&ItemKind::Iron));
        assert!(stats.take_dirty().is_empty());
    }

    #[test]
    fn bucket_ring_caps() {
        let mut stats = MarketStats::default();
        for i in 0..(BUCKET_CAP as u64 + 10) {
            stats.record_fill_at(ItemKind::Copper, 2, 1, i * BUCKET_MS);
        }
        let h = stats.history(ItemKind::Copper).unwrap();
        assert_eq!(h.buckets.len(), BUCKET_CAP);
        // Oldest buckets fell off the front; totals keep the full count.
        assert_eq!(h.buckets.front().unwrap().t, 10 * BUCKET_MS);
        assert_eq!(h.total_fills, BUCKET_CAP as u64 + 10);
    }

    #[test]
    fn save_roundtrip() {
        let mut stats = MarketStats::default();
        stats.record_fill_at(ItemKind::Pistol, 120, 1, 42 * BUCKET_MS);
        stats.record_fill_at(ItemKind::Iron, 3, 7, 43 * BUCKET_MS);

        let reloaded = MarketStats::new(stats.save());
        let h = reloaded.history(ItemKind::Pistol).unwrap();
        assert_eq!(h.last_price, 120);
        assert_eq!(h.buckets.len(), 1);
        assert_eq!(reloaded.history(ItemKind::Iron).unwrap().total_units, 7);
    }
}
