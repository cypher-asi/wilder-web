//! Simplified market: per-good price with supply/demand pressure, executed
//! through a clearing pass each simulated hour. A percentage of every trade
//! is burned (the MILD sink that fights inflation).

use rand::Rng;
use rand_pcg::Pcg64Mcg;
use std::collections::HashMap;
use wilder_types::ItemKind;

use crate::report::Report;

/// Market fee burned on every executed trade.
pub const TRADE_BURN: f32 = 0.08;

#[derive(Default, Clone, Copy)]
pub struct GoodState {
    pub price: f32,
    pub base_price: f32,
    /// Units offered for sale this hour.
    pub supply: f32,
    /// Units wanted this hour.
    pub demand: f32,
    pub traded_today: f32,
}

pub struct Market {
    goods: HashMap<ItemKind, GoodState>,
    /// Cash held by the clearing house. Buys pay in; sells pay out. Money is
    /// conserved: only raid bounties mint MILD and only fees burn it.
    pub cash: f32,
}

pub fn base_price(kind: ItemKind) -> f32 {
    match kind {
        ItemKind::Iron | ItemKind::Biomass => 2.0,
        ItemKind::Copper | ItemKind::Chemicals => 3.0,
        ItemKind::Electronics => 5.0,
        ItemKind::SteelPlate => 10.0,
        ItemKind::CopperWire => 6.0,
        ItemKind::Polymer => 12.0,
        ItemKind::CircuitBoard => 22.0,
        ItemKind::BioGel => 11.0,
        ItemKind::Ammo9mm => 1.0,
        ItemKind::Medkit => 30.0,
        ItemKind::Pipe => 25.0,
        ItemKind::Knife => 28.0,
        ItemKind::Pistol => 90.0,
        ItemKind::Smg => 200.0,
        ItemKind::JacketArmor => 60.0,
        ItemKind::PlateArmor => 150.0,
        _ => 10.0,
    }
}

impl Market {
    pub fn new() -> Self {
        // Small NPC-vendor float so trading can bootstrap.
        Self { goods: HashMap::new(), cash: 50_000.0 }
    }

    fn good(&mut self, kind: ItemKind) -> &mut GoodState {
        self.goods.entry(kind).or_insert_with(|| GoodState {
            price: base_price(kind),
            base_price: base_price(kind),
            ..Default::default()
        })
    }

    pub fn price(&self, kind: ItemKind) -> f32 {
        self.goods
            .get(&kind)
            .map(|g| g.price)
            .unwrap_or_else(|| base_price(kind))
    }

    /// Offer `count` units for sale; returns MILD received (after burn).
    /// Payout is limited by clearing-house cash, so sell income ultimately
    /// comes from other players' buys — money is conserved.
    pub fn sell(&mut self, kind: ItemKind, count: u32, report: &mut Report) -> f32 {
        let cash = self.cash;
        let good = self.good(kind);
        good.supply += count as f32;
        let gross = good.price * count as f32;
        // Never drain the house entirely; unfilled listings just expire.
        let payable = gross.min(cash * 0.05);
        if payable <= 0.0 {
            return 0.0;
        }
        let filled = payable / gross;
        let burn = payable * TRADE_BURN;
        good.traded_today += count as f32 * filled;
        report.wild_burned += burn;
        report.trades += (count as f32 * filled) as u64;
        self.cash -= payable;
        payable - burn
    }

    /// Try to buy `count` units; returns cost, or None if unaffordable at
    /// current price with `budget`. Payment (minus burn) funds the house.
    pub fn buy(&mut self, kind: ItemKind, count: u32, budget: f32, report: &mut Report) -> Option<f32> {
        let good = self.good(kind);
        good.demand += count as f32;
        let cost = good.price * count as f32;
        if cost > budget {
            return None;
        }
        good.traded_today += count as f32;
        report.trades += count as u64;
        let burn = cost * TRADE_BURN;
        report.wild_burned += burn;
        self.cash += cost - burn;
        Some(cost)
    }

    /// Hourly price adjustment from supply/demand imbalance.
    pub fn clear_hour(&mut self, _report: &mut Report, rng: &mut Pcg64Mcg) {
        for good in self.goods.values_mut() {
            let s = good.supply.max(0.5);
            let d = good.demand.max(0.5);
            let imbalance = (d - s) / (d + s); // -1..1
            let drift: f32 = rng.random_range(-0.002..0.002);
            good.price *= 1.0 + imbalance * 0.02 + drift;
            // Clamp to sane band around base so runaway spirals are visible
            // but bounded.
            good.price = good.price.clamp(good.base_price * 0.2, good.base_price * 8.0);
            good.supply = 0.0;
            good.demand = 0.0;
        }
    }

    /// Mild mean-reversion at day boundaries (stale listings expire, NPC
    /// vendors nudge extremes back).
    pub fn decay_prices(&mut self) {
        for good in self.goods.values_mut() {
            good.price += (good.base_price - good.price) * 0.01;
            good.traded_today = 0.0;
        }
    }

    pub fn price_index(&self) -> f32 {
        if self.goods.is_empty() {
            return 1.0;
        }
        let sum: f32 = self
            .goods
            .values()
            .map(|g| g.price / g.base_price)
            .sum();
        sum / self.goods.len() as f32
    }

    pub fn snapshot_prices(&self) -> Vec<(ItemKind, f32)> {
        let mut v: Vec<(ItemKind, f32)> = self.goods.iter().map(|(k, g)| (*k, g.price)).collect();
        v.sort_by_key(|(k, _)| format!("{k:?}"));
        v
    }
}
