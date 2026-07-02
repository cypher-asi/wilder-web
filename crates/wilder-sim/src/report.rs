//! Balance reporting: daily snapshots -> CSV (spreadsheet-friendly) and JSON
//! (tooling-friendly).

use serde::Serialize;
use std::io::Write;
use wilder_types::ItemKind;

use crate::agents::Agent;
use crate::market::Market;
use crate::Config;

#[derive(Serialize, Clone)]
pub struct DaySnapshot {
    pub day: u32,
    pub price_index: f32,
    pub money_per_agent: f32,
    pub wild_minted: f32,
    pub wild_burned: f32,
    pub total_deaths: u64,
    pub items_destroyed: u64,
    pub trades: u64,
    pub crafted: u64,
    pub prices: Vec<(String, f32)>,
}

pub struct Report {
    pub wild_minted: f32,
    pub wild_burned: f32,
    pub total_deaths: u64,
    pub items_destroyed: u64,
    pub trades: u64,
    pub crafted: u64,
    pub days: Vec<DaySnapshot>,
}

impl Report {
    pub fn new() -> Self {
        Self {
            wild_minted: 0.0,
            wild_burned: 0.0,
            total_deaths: 0,
            items_destroyed: 0,
            trades: 0,
            crafted: 0,
            days: Vec::new(),
        }
    }

    pub fn snapshot_day(&mut self, day: u32, agents: &[Agent], market: &Market) {
        let money: f32 = agents.iter().map(|a| a.wild).sum();
        self.days.push(DaySnapshot {
            day,
            price_index: market.price_index(),
            money_per_agent: money / agents.len().max(1) as f32,
            wild_minted: self.wild_minted,
            wild_burned: self.wild_burned,
            total_deaths: self.total_deaths,
            items_destroyed: self.items_destroyed,
            trades: self.trades,
            crafted: self.crafted,
            prices: market
                .snapshot_prices()
                .into_iter()
                .map(|(k, p)| (format!("{k:?}"), p))
                .collect(),
        });
    }

    pub fn write_csv(&self, dir: &str) -> std::io::Result<()> {
        // Summary series.
        let mut f = std::fs::File::create(format!("{dir}/summary.csv"))?;
        writeln!(
            f,
            "day,price_index,money_per_agent,wild_minted,wild_burned,deaths,items_destroyed,trades,crafted"
        )?;
        for d in &self.days {
            writeln!(
                f,
                "{},{:.4},{:.2},{:.0},{:.0},{},{},{},{}",
                d.day,
                d.price_index,
                d.money_per_agent,
                d.wild_minted,
                d.wild_burned,
                d.total_deaths,
                d.items_destroyed,
                d.trades,
                d.crafted
            )?;
        }

        // Price series per good.
        let mut f = std::fs::File::create(format!("{dir}/prices.csv"))?;
        let goods: Vec<String> = self
            .days
            .last()
            .map(|d| d.prices.iter().map(|(k, _)| k.clone()).collect())
            .unwrap_or_default();
        writeln!(f, "day,{}", goods.join(","))?;
        for d in &self.days {
            let row: Vec<String> = goods
                .iter()
                .map(|g| {
                    d.prices
                        .iter()
                        .find(|(k, _)| k == g)
                        .map(|(_, p)| format!("{p:.2}"))
                        .unwrap_or_default()
                })
                .collect();
            writeln!(f, "{},{}", d.day, row.join(","))?;
        }
        Ok(())
    }

    pub fn write_json(&self, dir: &str, config: &Config) -> std::io::Result<()> {
        #[derive(Serialize)]
        struct Output<'a> {
            agents: usize,
            days: u32,
            seed: u64,
            snapshots: &'a [DaySnapshot],
        }
        let out = Output {
            agents: config.agents,
            days: config.days,
            seed: config.seed,
            snapshots: &self.days,
        };
        std::fs::write(
            format!("{dir}/report.json"),
            serde_json::to_string_pretty(&out)?,
        )
    }
}

/// Convenience for printing.
#[allow(dead_code)]
pub fn kind_name(kind: ItemKind) -> String {
    format!("{kind:?}")
}
