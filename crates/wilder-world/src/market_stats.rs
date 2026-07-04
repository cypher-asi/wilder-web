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
use wilder_types::{ItemKind, MarketFill, PriceBucket};

/// Fill prices aggregate into buckets of this many milliseconds (1 minute).
pub const BUCKET_MS: u64 = 60_000;
/// Buckets kept per item: 24 h of minutes. Sparse — only traded minutes are
/// stored, so quiet items keep far longer than a day of history.
pub const BUCKET_CAP: usize = 1440;
/// Individual fills kept per item for the trade tape (newest kept, oldest
/// dropped) — enough for a live "recent trades" panel without bloating saves.
pub const FILL_CAP: usize = 64;

/// One item kind's price history + lifetime totals.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ItemHistory {
    /// Fill-price buckets, oldest first.
    pub buckets: VecDeque<PriceBucket>,
    /// Individual fills, oldest first (trade tape; capped at [`FILL_CAP`]).
    /// Default keeps pre-tape saves loading.
    #[serde(default)]
    pub recent: VecDeque<MarketFill>,
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
    pub fn record_fill(
        &mut self,
        kind: ItemKind,
        price_each: u32,
        count: u32,
        buyer: String,
        seller: String,
    ) {
        self.record_fill_at(kind, price_each, count, buyer, seller, unix_ms());
    }

    /// Record one market fill at an explicit timestamp (tests).
    pub fn record_fill_at(
        &mut self,
        kind: ItemKind,
        price_each: u32,
        count: u32,
        buyer: String,
        seller: String,
        now_ms: u64,
    ) {
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
        if h.recent.len() >= FILL_CAP {
            h.recent.pop_front();
        }
        h.recent.push_back(MarketFill { t: now_ms, price_each, count, buyer, seller });

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

    /// Lifetime `(fills, units, wild)` across every item kind (bench/debug).
    pub fn totals(&self) -> (u64, u64, u64) {
        self.items.values().fold((0, 0, 0), |(f, u, w), h| {
            (f + h.total_fills, u + h.total_units, w + h.total_wild)
        })
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

    /// Test shorthand: record a fill with placeholder counterparties.
    fn fill(stats: &mut MarketStats, kind: ItemKind, price: u32, count: u32, t: u64) {
        stats.record_fill_at(kind, price, count, "BUYER".into(), "SELLER".into(), t);
    }

    #[test]
    fn fills_aggregate_into_buckets() {
        let mut stats = MarketStats::default();
        let t0 = 1_000_000 * BUCKET_MS; // aligned bucket start

        // Two fills in the same minute merge; a later fill opens a new bucket.
        fill(&mut stats, ItemKind::Iron, 2, 10, t0 + 5_000);
        fill(&mut stats, ItemKind::Iron, 4, 10, t0 + 30_000);
        fill(&mut stats, ItemKind::Iron, 3, 5, t0 + BUCKET_MS + 1_000);

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
        // The trade tape keeps each fill individually, oldest first.
        assert_eq!(h.recent.len(), 3);
        assert_eq!(h.recent.back().unwrap().price_each, 3);
        assert_eq!(h.recent.back().unwrap().buyer, "BUYER");
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
            fill(&mut stats, ItemKind::Copper, 2, 1, i * BUCKET_MS);
        }
        let h = stats.history(ItemKind::Copper).unwrap();
        assert_eq!(h.buckets.len(), BUCKET_CAP);
        // Oldest buckets fell off the front; totals keep the full count.
        assert_eq!(h.buckets.front().unwrap().t, 10 * BUCKET_MS);
        assert_eq!(h.total_fills, BUCKET_CAP as u64 + 10);
        // The tape ring capped too, keeping the newest fills.
        assert_eq!(h.recent.len(), FILL_CAP);
        assert_eq!(h.recent.back().unwrap().t, (BUCKET_CAP as u64 + 9) * BUCKET_MS);
    }

    #[test]
    fn save_roundtrip() {
        let mut stats = MarketStats::default();
        stats.record_fill_at(ItemKind::Pistol, 120, 1, "V-1".into(), "K-9".into(), 42 * BUCKET_MS);
        fill(&mut stats, ItemKind::Iron, 3, 7, 43 * BUCKET_MS);

        let reloaded = MarketStats::new(stats.save());
        let h = reloaded.history(ItemKind::Pistol).unwrap();
        assert_eq!(h.last_price, 120);
        assert_eq!(h.buckets.len(), 1);
        // The tape survives the round trip with both counterparties.
        assert_eq!(h.recent.len(), 1);
        assert_eq!(h.recent[0].buyer, "V-1");
        assert_eq!(h.recent[0].seller, "K-9");
        assert_eq!(reloaded.history(ItemKind::Iron).unwrap().total_units, 7);
    }

    #[test]
    fn pre_tape_saves_load_with_empty_tape() {
        // Saves written before the `recent` tape existed must still load.
        let json = r#"{"items":[["Iron",{
            "buckets":[{"t":0,"avg":2,"min":2,"max":2,"units":5,"wild":10,"fills":1}],
            "total_fills":1,"total_units":5,"total_wild":10,
            "last_price":2,"last_trade_ms":0}]]}"#;
        let save: MarketStatsSave = serde_json::from_str(json).unwrap();
        let stats = MarketStats::new(save);
        let h = stats.history(ItemKind::Iron).unwrap();
        assert_eq!(h.total_units, 5);
        assert!(h.recent.is_empty());
    }
}
