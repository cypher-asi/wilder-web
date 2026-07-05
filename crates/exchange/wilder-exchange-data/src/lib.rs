//! Market analytics fed by matching-engine fills: per-(venue, asset) OHLCV
//! candles at two base resolutions (1 s ticks for intraday frames, 1 min for
//! daily history), a recent-trades tape, rolling 24 h stats, plus cross-venue
//! aggregation per asset for the markets index.
//!
//! # Candle time convention
//!
//! Every [`Candle`] carries `start_secs`: the unix **second** its bucket
//! starts at, regardless of the series' resolution (a 1 s tick, a minute
//! candle, or a [`MarketData::candles_tf`] aggregate all use the same unit).
//! Saves from before the tick series existed stored minute candles with a
//! `minute` bucket index; deserialization converts those to `start_secs`
//! transparently (see [`CandleWire`]).
//!
//! Fully deterministic: every entry point takes explicit ms timestamps (the
//! fill's `at_ms` or the caller's `now_ms`) — no system clock is read here.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use wilder_exchange_asset::{Asset, VenueId};
use wilder_exchange_book::{Fill, Side};

/// Seconds per minute-candle bucket.
pub const MINUTE_SECS: u64 = 60;
/// 1 s tick candles kept per (venue, asset): 1 h of trading seconds. Sparse —
/// only seconds that traded exist, so quiet markets keep far longer.
pub const TICK_CAP: usize = 3600;
/// Minute candles kept per (venue, asset): 24 h of trading minutes.
pub const CANDLE_CAP: usize = 1440;
/// Fills kept on the trade tape per (venue, asset), newest kept.
pub const TAPE_CAP: usize = 64;
/// The rolling stats window (24 h) in milliseconds.
pub const DAY_MS: u64 = 24 * 60 * 60 * 1000;
/// Most aggregated buckets [`MarketData::candles_tf`] returns.
pub const CANDLES_TF_MAX: usize = 200;

/// One bucket of trading: classic OHLCV, prices in WILD per unit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(from = "CandleWire")]
pub struct Candle {
    /// Bucket start, unix **seconds** (same unit at every resolution).
    pub start_secs: u64,
    pub open: u32,
    pub high: u32,
    pub low: u32,
    pub close: u32,
    pub volume_units: u32,
    /// WILD volume (sum of price x qty), u64 to survive big buckets.
    pub volume_wild: u64,
}

/// Deserialization shim: current saves carry `start_secs`; pre-tick saves
/// carried `minute` (a minute bucket index), which converts as `minute * 60`.
#[derive(Deserialize)]
struct CandleWire {
    #[serde(default)]
    start_secs: Option<u64>,
    #[serde(default)]
    minute: Option<u64>,
    open: u32,
    high: u32,
    low: u32,
    close: u32,
    volume_units: u32,
    volume_wild: u64,
}

impl From<CandleWire> for Candle {
    fn from(w: CandleWire) -> Self {
        Candle {
            start_secs: w
                .start_secs
                .or(w.minute.map(|m| m * MINUTE_SECS))
                .unwrap_or_default(),
            open: w.open,
            high: w.high,
            low: w.low,
            close: w.close,
            volume_units: w.volume_units,
            volume_wild: w.volume_wild,
        }
    }
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
    /// Venue of the globally most recent trade (candle source for rollup
    /// sparklines); `None` if never traded.
    pub last_venue: Option<VenueId>,
}

/// One (venue, asset) price series: candles at both resolutions + tape +
/// last trade.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Series {
    /// 1 s tick candles, oldest first, capped at [`TICK_CAP`]. Defaults
    /// empty so pre-tick saves still load (their intraday history simply
    /// starts fresh).
    #[serde(default)]
    ticks: Vec<Candle>,
    /// Minute candles, oldest first, capped at [`CANDLE_CAP`]. Old saves
    /// stored this field as `candles`.
    #[serde(alias = "candles")]
    minutes: Vec<Candle>,
    /// Trade tape, oldest first, capped at [`TAPE_CAP`].
    tape: Vec<TapeEntry>,
    last_price: u32,
    last_trade_ms: u64,
    traded: bool,
}

/// Fold one print into the series' last candle, or open a new bucket
/// (pruning the oldest past `cap`). `bucket_start` is unix seconds.
fn record_bucket(
    candles: &mut Vec<Candle>,
    bucket_start: u64,
    cap: usize,
    price: u32,
    qty: u32,
    wild: u64,
) {
    match candles.last_mut() {
        Some(c) if c.start_secs == bucket_start => {
            c.high = c.high.max(price);
            c.low = c.low.min(price);
            c.close = price;
            c.volume_units = c.volume_units.saturating_add(qty);
            c.volume_wild += wild;
        }
        _ => {
            if candles.len() >= cap {
                candles.remove(0);
            }
            candles.push(Candle {
                start_secs: bucket_start,
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

/// Roll a base-resolution series up into `tf`-second buckets, oldest first,
/// skipping buckets that start before `min_start` (unix seconds, `tf`-
/// aligned). Open = first open, close = last close, high/low = extremes,
/// volumes summed.
fn aggregate(source: &[Candle], tf: u64, min_start: u64) -> Vec<Candle> {
    let mut out: Vec<Candle> = Vec::new();
    for c in source {
        if c.start_secs < min_start {
            continue;
        }
        let bucket = c.start_secs / tf * tf;
        match out.last_mut() {
            Some(b) if b.start_secs == bucket => {
                b.high = b.high.max(c.high);
                b.low = b.low.min(c.low);
                b.close = c.close;
                b.volume_units = b.volume_units.saturating_add(c.volume_units);
                b.volume_wild += c.volume_wild;
            }
            _ => out.push(Candle { start_secs: bucket, ..*c }),
        }
    }
    out
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

        let secs = at_ms / 1000;
        record_bucket(&mut self.ticks, secs, TICK_CAP, price, qty, wild);
        let minute_start = secs / MINUTE_SECS * MINUTE_SECS;
        record_bucket(&mut self.minutes, minute_start, CANDLE_CAP, price, qty, wild);
    }

    fn stats(&self, now_ms: u64) -> MarketStats {
        if !self.traded {
            return MarketStats::default();
        }
        let window_start_secs = now_ms.saturating_sub(DAY_MS) / 1000;
        let mut stats = MarketStats {
            last_price: Some(self.last_price),
            last_trade_ms: Some(self.last_trade_ms),
            ..MarketStats::default()
        };
        // Reference price: close of the newest minute candle at or before
        // the window start; young markets fall back to their oldest open.
        for c in self.minutes.iter().rev() {
            if c.start_secs <= window_start_secs {
                stats.price_24h_ago = Some(c.close);
                break;
            }
        }
        if stats.price_24h_ago.is_none() {
            stats.price_24h_ago = self.minutes.first().map(|c| c.open);
        }
        for c in self.minutes.iter().filter(|c| c.start_secs > window_start_secs) {
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

    /// Fold one fill into the (venue, asset) series (both the 1 s tick and
    /// the minute candle). Time comes from the fill's `at_ms`.
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

    /// Minute candles for one (venue, asset), oldest first (24 h stats and
    /// sparkline source).
    pub fn candles(&self, venue: VenueId, asset: Asset) -> &[Candle] {
        self.series.get(&(venue, asset)).map(|s| s.minutes.as_slice()).unwrap_or(&[])
    }

    /// OHLCV candles aggregated to `tf_secs`-second buckets, oldest first,
    /// bounded to the [`CANDLES_TF_MAX`] most recent buckets before
    /// `now_ms`. Frames under a minute roll up from the 1 s tick series
    /// (~1 h of history); minute-and-up frames roll up from the minute
    /// series (~24 h of history).
    pub fn candles_tf(
        &self,
        venue: VenueId,
        asset: Asset,
        tf_secs: u32,
        now_ms: u64,
    ) -> Vec<Candle> {
        let Some(series) = self.series.get(&(venue, asset)) else {
            return Vec::new();
        };
        let tf = tf_secs.max(1) as u64;
        let source = if tf < MINUTE_SECS { &series.ticks } else { &series.minutes };
        // Oldest bucket allowed: CANDLES_TF_MAX buckets back from now's.
        let min_start =
            (now_ms / 1000 / tf).saturating_sub(CANDLES_TF_MAX as u64 - 1) * tf;
        let mut out = aggregate(source, tf, min_start);
        if out.len() > CANDLES_TF_MAX {
            out.drain(..out.len() - CANDLES_TF_MAX);
        }
        out
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
                summary.last_venue = Some(venue);
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

    const MINUTE_MS: u64 = MINUTE_SECS * 1000;

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
        let t0 = 1_000 * MINUTE_MS;
        data.record_fill(v, iron(), &fill(10, 2, t0 + 1_000));
        data.record_fill(v, iron(), &fill(14, 3, t0 + 30_000));
        data.record_fill(v, iron(), &fill(8, 1, t0 + 59_000));
        data.record_fill(v, iron(), &fill(12, 4, t0 + MINUTE_MS + 5_000));

        let candles = data.candles(v, iron());
        assert_eq!(candles.len(), 2);
        let first = candles[0];
        assert_eq!(first.start_secs, 1_000 * MINUTE_SECS);
        assert_eq!((first.open, first.high, first.low, first.close), (10, 14, 8, 8));
        assert_eq!(first.volume_units, 6);
        assert_eq!(first.volume_wild, 10 * 2 + 14 * 3 + 8);
        assert_eq!(candles[1].open, 12);
    }

    #[test]
    fn ticks_roll_across_seconds() {
        let mut data = MarketData::new();
        let v = VenueId(0);
        let t0 = 5_000_000; // 5000 s
        data.record_fill(v, iron(), &fill(10, 2, t0 + 100));
        data.record_fill(v, iron(), &fill(14, 3, t0 + 900)); // same second
        data.record_fill(v, iron(), &fill(8, 1, t0 + 1_500)); // next second

        let ticks = data.candles_tf(v, iron(), 1, t0 + 2_000);
        assert_eq!(ticks.len(), 2);
        assert_eq!(ticks[0].start_secs, 5_000);
        assert_eq!((ticks[0].open, ticks[0].high, ticks[0].close), (10, 14, 14));
        assert_eq!(ticks[0].volume_units, 5);
        assert_eq!(ticks[1].start_secs, 5_001);
        assert_eq!(ticks[1].close, 8);
    }

    #[test]
    fn candles_tf_aggregates_ticks_into_5s_buckets() {
        let mut data = MarketData::new();
        let v = VenueId(0);
        let t0 = 100_000_000; // 100000 s, 5s-aligned
        // Seconds 0,1,4 land in bucket 0; second 7 in bucket 5.
        data.record_fill(v, iron(), &fill(10, 1, t0));
        data.record_fill(v, iron(), &fill(15, 2, t0 + 1_000));
        data.record_fill(v, iron(), &fill(7, 1, t0 + 4_000));
        data.record_fill(v, iron(), &fill(12, 3, t0 + 7_000));

        let out = data.candles_tf(v, iron(), 5, t0 + 8_000);
        assert_eq!(out.len(), 2);
        let b0 = out[0];
        assert_eq!(b0.start_secs, 100_000);
        assert_eq!((b0.open, b0.high, b0.low, b0.close), (10, 15, 7, 7));
        assert_eq!(b0.volume_units, 4);
        assert_eq!(b0.volume_wild, 10 + 15 * 2 + 7);
        let b1 = out[1];
        assert_eq!(b1.start_secs, 100_005);
        assert_eq!((b1.open, b1.close, b1.volume_units), (12, 12, 3));
    }

    #[test]
    fn candles_tf_aggregates_minutes_into_hours() {
        let mut data = MarketData::new();
        let v = VenueId(0);
        let hour_ms = 3_600_000;
        let t0 = 240 * hour_ms; // hour-aligned
        data.record_fill(v, iron(), &fill(10, 1, t0 + 5 * MINUTE_MS));
        data.record_fill(v, iron(), &fill(20, 2, t0 + 42 * MINUTE_MS));
        data.record_fill(v, iron(), &fill(15, 1, t0 + 61 * MINUTE_MS)); // next hour

        let out = data.candles_tf(v, iron(), 3600, t0 + 62 * MINUTE_MS);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].start_secs, 240 * 3600);
        assert_eq!((out[0].open, out[0].high, out[0].close), (10, 20, 20));
        assert_eq!(out[0].volume_units, 3);
        assert_eq!(out[1].start_secs, 241 * 3600);
        assert_eq!(out[1].open, 15);
    }

    #[test]
    fn candles_tf_bounds_output_window() {
        let mut data = MarketData::new();
        let v = VenueId(0);
        // 300 trading seconds, one per second.
        for i in 0..300u64 {
            data.record_fill(v, iron(), &fill(5, 1, i * 1_000));
        }
        // now sits in second 299 (the last traded bucket): exactly the 200
        // most recent buckets come back.
        let now = 299 * 1_000;
        let out = data.candles_tf(v, iron(), 1, now);
        assert_eq!(out.len(), CANDLES_TF_MAX);
        assert_eq!(out.last().map(|c| c.start_secs), Some(299));
        assert_eq!(out[0].start_secs, 299 - (CANDLES_TF_MAX as u64 - 1));
        // A later now slides the window forward past old buckets.
        let later = data.candles_tf(v, iron(), 1, now + 50_000);
        assert_eq!(later[0].start_secs, 349 - (CANDLES_TF_MAX as u64 - 1));
        assert_eq!(later.len(), CANDLES_TF_MAX - 50);
    }

    #[test]
    fn stats_over_24h_window() {
        let mut data = MarketData::new();
        let v = VenueId(0);
        let now = 100 * DAY_MS;
        // Old trade: outside the window, becomes the 24h-ago reference.
        data.record_fill(v, iron(), &fill(5, 10, now - DAY_MS - MINUTE_MS));
        // Recent trades inside the window.
        data.record_fill(v, iron(), &fill(9, 2, now - 2 * MINUTE_MS));
        data.record_fill(v, iron(), &fill(7, 3, now - MINUTE_MS));

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
        let now = 10 * MINUTE_MS;
        data.record_fill(v, iron(), &fill(4, 1, now - MINUTE_MS));
        data.record_fill(v, iron(), &fill(6, 1, now));
        assert_eq!(data.stats(v, iron(), now).price_24h_ago, Some(4));
    }

    #[test]
    fn candle_window_prunes() {
        let mut data = MarketData::new();
        let v = VenueId(0);
        for i in 0..(CANDLE_CAP as u64 + 10) {
            data.record_fill(v, iron(), &fill(3, 1, i * MINUTE_MS));
        }
        let candles = data.candles(v, iron());
        assert_eq!(candles.len(), CANDLE_CAP);
        assert_eq!(candles[0].start_secs, 10 * MINUTE_SECS);
    }

    #[test]
    fn tick_window_prunes() {
        let mut data = MarketData::new();
        let v = VenueId(0);
        for i in 0..(TICK_CAP as u64 + 10) {
            data.record_fill(v, iron(), &fill(3, 1, i * 1_000));
        }
        let last = TICK_CAP as u64 + 9; // newest traded second
        let now = last * 1_000;
        // The tick series kept the newest TICK_CAP seconds: 10..=last. The
        // 1 s view is then bounded to the CANDLES_TF_MAX most recent.
        let ticks = data.candles_tf(v, iron(), 1, now);
        assert_eq!(ticks.len(), CANDLES_TF_MAX);
        assert_eq!(ticks.last().map(|c| c.start_secs), Some(last));
        assert_eq!(ticks[0].start_secs, last - (CANDLES_TF_MAX as u64 - 1));
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
        data.record_fill(v0, iron(), &fill(10, 5, now - 3 * MINUTE_MS));
        data.record_fill(v1, iron(), &fill(14, 2, now - MINUTE_MS)); // newest

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
        data.record_fill(v, iron(), &fill(10, 2, 5 * MINUTE_MS));
        let json = serde_json::to_string(&data).expect("serialize");
        let back: MarketData = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back.stats(v, iron(), 6 * MINUTE_MS).last_price, Some(10));
        assert_eq!(back.candles(v, iron()).len(), 1);
        assert_eq!(back.candles_tf(v, iron(), 1, 6 * MINUTE_MS).len(), 1);
        assert_eq!(back.tape(v, iron()).len(), 1);
    }

    /// A save written before the tick series existed (`Series.candles` with
    /// `Candle.minute` bucket indices) must load: minute candles land in the
    /// minute series with `start_secs = minute * 60`, ticks default empty.
    #[test]
    fn old_save_shape_still_loads() {
        let v = VenueId(3);
        let old_json = serde_json::json!({
            "entries": [[
                serde_json::to_value(v).unwrap(),
                serde_json::to_value(iron()).unwrap(),
                {
                    "candles": [{
                        "minute": 1_000,
                        "open": 10, "high": 14, "low": 9, "close": 12,
                        "volume_units": 6, "volume_wild": 66
                    }],
                    "tape": [{
                        "price": 12, "qty": 1,
                        "taker_side": serde_json::to_value(Side::Bid).unwrap(),
                        "at_ms": 60_000_000u64
                    }],
                    "last_price": 12,
                    "last_trade_ms": 60_000_000u64,
                    "traded": true
                }
            ]]
        })
        .to_string();

        let data: MarketData = serde_json::from_str(&old_json).expect("old save loads");
        let minutes = data.candles(v, iron());
        assert_eq!(minutes.len(), 1);
        assert_eq!(minutes[0].start_secs, 1_000 * MINUTE_SECS);
        assert_eq!((minutes[0].open, minutes[0].close), (10, 12));
        // Tick series starts empty; sub-minute frames have no history yet.
        assert!(data.candles_tf(v, iron(), 1, 60_001_000).is_empty());
        // Minute-and-up frames still see the migrated candle.
        let hours = data.candles_tf(v, iron(), 3600, 60_060_000);
        assert_eq!(hours.len(), 1);
        assert_eq!(hours[0].start_secs, 1_000 * MINUTE_SECS / 3600 * 3600);
        // Stats keep working off the minute series.
        assert_eq!(data.stats(v, iron(), 60_060_000).last_price, Some(12));
        assert_eq!(data.stats(v, iron(), 60_060_000).volume_24h_units, 6);
    }
}
