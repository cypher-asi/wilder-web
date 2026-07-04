//! Market analytics fed by matching-engine fills: per-(venue, asset) minute
//! OHLCV candles, a recent-trades tape, rolling 24 h stats, plus cross-venue
//! aggregation per asset for the markets index.
//!
//! Fully deterministic: every entry point takes explicit ms timestamps (the
//! fill's `at_ms` or the caller's `now_ms`) — no system clock is read here.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use wilder_exchange_asset::{Asset, VenueId};
use wilder_exchange_book::{Fill, Side};

/// Candle bucket width in milliseconds (1 minute).
pub const CANDLE_MS: u64 = 60_000;
/// Candles kept per (venue, asset): 24 h of minutes. Sparse — only minutes
/// that traded exist, so quiet markets keep far longer than a day.
pub const CANDLE_CAP: usize = 1440;
/// Fills kept on the trade tape per (venue, asset), newest kept.
pub const TAPE_CAP: usize = 64;
/// The rolling stats window (24 h) in milliseconds.
pub const DAY_MS: u64 = 24 * 60 * 60 * 1000;

/// One minute of trading: classic OHLCV, prices in WILD per unit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Candle {
    /// Bucket index: unix ms / [`CANDLE_MS`].
    pub minute: u64,
    pub open: u32,
    pub high: u32,
    pub low: u32,
    pub close: u32,
    pub volume_units: u32,
    /// WILD volume (sum of price x qty), u64 to survive big minutes.
    pub volume_wild: u64,
}

/// One trade-tape entry (a fill as the ticker UI shows it).
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct TapeEntry {
    pub price: u32,
    pub qty: u32,
    /// The aggressor's side: `Bid` prints as a buy, `Ask` as a sell.
    pub taker_side: Side,
    pub at_ms: u64,
}

/// Point-in-time stats for one (venue, asset), computed over the trailing
/// 24 h from `now_ms`.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct MarketStats {
    /// Most recent trade price ever (not windowed); `None` if never traded.
    pub last_price: Option<u32>,
    /// Unix ms of the most recent trade.
    pub last_trade_ms: Option<u64>,
    /// Reference price from ~24 h ago (close of the newest candle at or
    /// before the window start, falling back to the oldest candle's open
    /// for young markets) — the denominator for "24h change".
    pub price_24h_ago: Option<u32>,
    pub volume_24h_units: u64,
    pub volume_24h_wild: u64,
    pub high_24h: Option<u32>,
    pub low_24h: Option<u32>,
}

/// Cross-venue rollup for one asset (the markets-index row).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AssetSummary {
    /// Price of the globally most recent trade across all venues.
    pub last_price: Option<u32>,
    pub last_trade_ms: Option<u64>,
    /// Reference price ~24 h ago at the venue of the most recent trade.
    pub price_24h_ago: Option<u32>,
    /// 24 h volume summed across venues.
    pub volume_24h_units: u64,
    pub volume_24h_wild: u64,
    /// Last trade price per venue that has ever traded this asset (sorted by
    /// venue id) — the arbitrage breakdown row.
    pub venue_prices: Vec<(VenueId, u32)>,
}

/// One (venue, asset) price series: candles + tape + last trade.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Series {
    /// Minute candles, oldest first, capped at [`CANDLE_CAP`].
    candles: Vec<Candle>,
    /// Trade tape, oldest first, capped at [`TAPE_CAP`].
    tape: Vec<TapeEntry>,
    last_price: u32,
    last_trade_ms: u64,
    traded: bool,
}

impl Series {
    fn record(&mut self, price: u32, qty: u32, taker_side: Side, at_ms: u64) {
        if qty == 0 {
            return;
        }
        let wild = price as u64 * qty as u64;
        self.last_price = price;
        self.last_trade_ms = at_ms;
        self.traded = true;

        if self.tape.len() >= TAPE_CAP {
            self.tape.remove(0);
        }
        self.tape.push(TapeEntry { price, qty, taker_side, at_ms });

        let minute = at_ms / CANDLE_MS;
        match self.candles.last_mut() {
            Some(c) if c.minute == minute => {
                c.high = c.high.max(price);
                c.low = c.low.min(price);
                c.close = price;
                c.volume_units = c.volume_units.saturating_add(qty);
                c.volume_wild += wild;
            }
            _ => {
                if self.candles.len() >= CANDLE_CAP {
                    self.candles.remove(0);
                }
                self.candles.push(Candle {
                    minute,
                    open: price,
                    high: price,
                    low: price,
                    close: price,
                    volume_units: qty,
                    volume_wild: wild,
                });
            }
        }
    }

    fn stats(&self, now_ms: u64) -> MarketStats {
        if !self.traded {
            return MarketStats::default();
        }
        let window_start_minute = now_ms.saturating_sub(DAY_MS) / CANDLE_MS;
        let mut stats = MarketStats {
            last_price: Some(self.last_price),
            last_trade_ms: Some(self.last_trade_ms),
            ..MarketStats::default()
        };
        // Reference price: close of the newest candle at or before the
        // window start; young markets fall back to their oldest open.
        for c in self.candles.iter().rev() {
            if c.minute <= window_start_minute {
                stats.price_24h_ago = Some(c.close);
                break;
            }
        }
        if stats.price_24h_ago.is_none() {
            stats.price_24h_ago = self.candles.first().map(|c| c.open);
        }
        for c in self.candles.iter().filter(|c| c.minute > window_start_minute) {
            stats.volume_24h_units += c.volume_units as u64;
            stats.volume_24h_wild += c.volume_wild;
            stats.high_24h = Some(stats.high_24h.map_or(c.high, |h| h.max(c.high)));
            stats.low_24h = Some(stats.low_24h.map_or(c.low, |l| l.min(c.low)));
        }
        stats
    }
}

/// Persisted form of [`MarketData`]: a sorted Vec keeps the JSON free of
/// non-string map keys (same pattern as `MarketStatsSave` in wilder-world).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MarketDataSave {
    entries: Vec<(VenueId, Asset, Series)>,
}

/// All price series, keyed by (venue, asset).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(from = "MarketDataSave", into = "MarketDataSave")]
pub struct MarketData {
    series: HashMap<(VenueId, Asset), Series>,
}

impl From<MarketDataSave> for MarketData {
    fn from(save: MarketDataSave) -> Self {
        Self {
            series: save.entries.into_iter().map(|(v, a, s)| ((v, a), s)).collect(),
        }
    }
}

impl From<MarketData> for MarketDataSave {
    fn from(data: MarketData) -> Self {
        let mut entries: Vec<(VenueId, Asset, Series)> =
            data.series.into_iter().map(|((v, a), s)| (v, a, s)).collect();
        entries.sort_by_key(|(v, a, _)| (*v, a.ticker()));
        Self { entries }
    }
}

impl MarketData {
    pub fn new() -> Self {
        Self::default()
    }

    /// Fold one fill into the (venue, asset) series. Time comes from the
    /// fill's `at_ms`.
    pub fn record_fill(&mut self, venue: VenueId, asset: Asset, fill: &Fill) {
        self.series
            .entry((venue, asset))
            .or_default()
            .record(fill.price, fill.qty, fill.taker_side, fill.at_ms);
    }

    /// 24 h snapshot for one (venue, asset) as of `now_ms`.
    pub fn stats(&self, venue: VenueId, asset: Asset, now_ms: u64) -> MarketStats {
        self.series
            .get(&(venue, asset))
            .map(|s| s.stats(now_ms))
            .unwrap_or_default()
    }

    /// Minute candles for one (venue, asset), oldest first.
    pub fn candles(&self, venue: VenueId, asset: Asset) -> &[Candle] {
        self.series.get(&(venue, asset)).map(|s| s.candles.as_slice()).unwrap_or(&[])
    }

    /// Recent trades for one (venue, asset), oldest first.
    pub fn tape(&self, venue: VenueId, asset: Asset) -> &[TapeEntry] {
        self.series.get(&(venue, asset)).map(|s| s.tape.as_slice()).unwrap_or(&[])
    }

    /// Cross-venue rollup for one asset as of `now_ms`.
    pub fn asset_summary(&self, asset: Asset, now_ms: u64) -> AssetSummary {
        let mut summary = AssetSummary::default();
        let mut newest: Option<(u64, VenueId)> = None;
        for (&(venue, a), series) in &self.series {
            if a != asset || !series.traded {
                continue;
            }
            let stats = series.stats(now_ms);
            summary.volume_24h_units += stats.volume_24h_units;
            summary.volume_24h_wild += stats.volume_24h_wild;
            summary.venue_prices.push((venue, series.last_price));
            if newest.is_none_or(|(t, _)| series.last_trade_ms > t) {
                newest = Some((series.last_trade_ms, venue));
                summary.last_price = Some(series.last_price);
                summary.last_trade_ms = Some(series.last_trade_ms);
                summary.price_24h_ago = stats.price_24h_ago;
            }
        }
        summary.venue_prices.sort_by_key(|(v, _)| *v);
        summary
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wilder_exchange_asset::OrderOwner;
    use wilder_types::{CharacterId, ItemKind};

    fn iron() -> Asset {
        Asset::Item(ItemKind::Iron)
    }

    fn fill(price: u32, qty: u32, at_ms: u64) -> Fill {
        let who = OrderOwner::Player(CharacterId::from_u128(1));
        Fill {
            taker_order: 0,
            maker_order: 1,
            taker: who,
            maker: OrderOwner::Player(CharacterId::from_u128(2)),
            taker_side: Side::Bid,
            price,
            qty,
            at_ms,
        }
    }

    #[test]
    fn candles_roll_across_minutes() {
        let mut data = MarketData::new();
        let v = VenueId(0);
        let t0 = 1_000 * CANDLE_MS;
        data.record_fill(v, iron(), &fill(10, 2, t0 + 1_000));
        data.record_fill(v, iron(), &fill(14, 3, t0 + 30_000));
        data.record_fill(v, iron(), &fill(8, 1, t0 + 59_000));
        data.record_fill(v, iron(), &fill(12, 4, t0 + CANDLE_MS + 5_000));

        let candles = data.candles(v, iron());
        assert_eq!(candles.len(), 2);
        let first = candles[0];
        assert_eq!(first.minute, 1_000);
        assert_eq!((first.open, first.high, first.low, first.close), (10, 14, 8, 8));
        assert_eq!(first.volume_units, 6);
        assert_eq!(first.volume_wild, 10 * 2 + 14 * 3 + 8);
        assert_eq!(candles[1].open, 12);
    }

    #[test]
    fn stats_over_24h_window() {
        let mut data = MarketData::new();
        let v = VenueId(0);
        let now = 100 * DAY_MS;
        // Old trade: outside the window, becomes the 24h-ago reference.
        data.record_fill(v, iron(), &fill(5, 10, now - DAY_MS - CANDLE_MS));
        // Recent trades inside the window.
        data.record_fill(v, iron(), &fill(9, 2, now - 2 * CANDLE_MS));
        data.record_fill(v, iron(), &fill(7, 3, now - CANDLE_MS));

        let stats = data.stats(v, iron(), now);
        assert_eq!(stats.last_price, Some(7));
        assert_eq!(stats.price_24h_ago, Some(5));
        assert_eq!(stats.volume_24h_units, 5);
        assert_eq!(stats.volume_24h_wild, 9 * 2 + 7 * 3);
        assert_eq!(stats.high_24h, Some(9));
        assert_eq!(stats.low_24h, Some(7));
    }

    #[test]
    fn young_market_uses_oldest_open_as_reference() {
        let mut data = MarketData::new();
        let v = VenueId(0);
        let now = 10 * CANDLE_MS;
        data.record_fill(v, iron(), &fill(4, 1, now - CANDLE_MS));
        data.record_fill(v, iron(), &fill(6, 1, now));
        assert_eq!(data.stats(v, iron(), now).price_24h_ago, Some(4));
    }

    #[test]
    fn candle_window_prunes() {
        let mut data = MarketData::new();
        let v = VenueId(0);
        for i in 0..(CANDLE_CAP as u64 + 10) {
            data.record_fill(v, iron(), &fill(3, 1, i * CANDLE_MS));
        }
        let candles = data.candles(v, iron());
        assert_eq!(candles.len(), CANDLE_CAP);
        assert_eq!(candles[0].minute, 10);
    }

    #[test]
    fn tape_caps_and_keeps_newest() {
        let mut data = MarketData::new();
        let v = VenueId(0);
        for i in 0..(TAPE_CAP as u64 + 5) {
            data.record_fill(v, iron(), &fill(3, 1, i));
        }
        let tape = data.tape(v, iron());
        assert_eq!(tape.len(), TAPE_CAP);
        assert_eq!(tape[0].at_ms, 5);
        assert_eq!(tape.last().map(|t| t.at_ms), Some(TAPE_CAP as u64 + 4));
    }

    #[test]
    fn asset_summary_aggregates_across_venues() {
        let mut data = MarketData::new();
        let (v0, v1) = (VenueId(0), VenueId(1));
        let now = 100 * DAY_MS;
        data.record_fill(v0, iron(), &fill(10, 5, now - 3 * CANDLE_MS));
        data.record_fill(v1, iron(), &fill(14, 2, now - CANDLE_MS)); // newest

        let summary = data.asset_summary(iron(), now);
        assert_eq!(summary.last_price, Some(14));
        assert_eq!(summary.volume_24h_units, 7);
        assert_eq!(summary.volume_24h_wild, 10 * 5 + 14 * 2);
        assert_eq!(summary.venue_prices, vec![(v0, 10), (v1, 14)]);

        // Untraded assets get an empty summary.
        let none = data.asset_summary(Asset::Shards, now);
        assert_eq!(none.last_price, None);
        assert!(none.venue_prices.is_empty());
    }

    #[test]
    fn save_roundtrip() {
        let mut data = MarketData::new();
        let v = VenueId(3);
        data.record_fill(v, iron(), &fill(10, 2, 5 * CANDLE_MS));
        let json = serde_json::to_string(&data).expect("serialize");
        let back: MarketData = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back.stats(v, iron(), 6 * CANDLE_MS).last_price, Some(10));
        assert_eq!(back.candles(v, iron()).len(), 1);
        assert_eq!(back.tape(v, iron()).len(), 1);
    }
}
