//! Agent behaviors: raiders gather, refiners refine, crafters manufacture,
//! traders arbitrage. Death and gear destruction are the item sinks; NPC
//! bounties are the WILD faucet; market/crafting fees are the WILD burns.

use rand::Rng;
use rand_pcg::Pcg64Mcg;
use std::collections::HashMap;
use wilder_crafting::{Station, RECIPES};
use wilder_types::ItemKind;

use crate::market::Market;
use crate::report::Report;

/// WILD minted per successful raid (NPC bounty faucet).
const RAID_BOUNTY: f32 = 4.0;
/// Chance a raid requires burning a medkit (consumable demand + sink).
const MEDKIT_USE_CHANCE: f64 = 0.3;
/// Chance a raid ends in death (full carried-loot loss).
const RAID_DEATH_CHANCE: f64 = 0.04;
/// Chance equipped gear breaks on death.
const GEAR_BREAK_ON_DEATH: f64 = 0.5;
/// Per-raid chance the weapon wears out (durability sink).
const WEAPON_WEAR_CHANCE: f64 = 0.02;
/// Crafting station fee (burned WILD) per craft, scaled by output value.
const CRAFT_FEE_RATIO: f32 = 0.05;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Role {
    Raider,
    Refiner,
    Crafter,
    Trader,
}

pub struct Agent {
    pub id: u32,
    pub role: Role,
    pub wild: f32,
    pub items: HashMap<ItemKind, u32>,
    pub has_weapon: bool,
    pub has_armor: bool,
    /// Hours until this agent acts again (activity pacing).
    cooldown: u32,
    pub deaths: u32,
}

impl Agent {
    pub fn new(id: u32, role: Role, rng: &mut Pcg64Mcg) -> Self {
        Self {
            id,
            role,
            wild: rng.random_range(20.0..80.0),
            items: HashMap::new(),
            has_weapon: false,
            has_armor: false,
            cooldown: rng.random_range(0..6),
            deaths: 0,
        }
    }

    fn add(&mut self, kind: ItemKind, count: u32) {
        *self.items.entry(kind).or_insert(0) += count;
    }

    fn take(&mut self, kind: ItemKind, count: u32) -> bool {
        match self.items.get_mut(&kind) {
            Some(have) if *have >= count => {
                *have -= count;
                true
            }
            _ => false,
        }
    }

    fn count(&self, kind: ItemKind) -> u32 {
        self.items.get(&kind).copied().unwrap_or(0)
    }

    pub fn act(&mut self, market: &mut Market, report: &mut Report, rng: &mut Pcg64Mcg) {
        if self.cooldown > 0 {
            self.cooldown -= 1;
            return;
        }
        match self.role {
            Role::Raider => self.act_raider(market, report, rng),
            Role::Refiner => self.act_industry(market, report, rng, Station::Refinery),
            Role::Crafter => self.act_industry(market, report, rng, Station::Factory),
            Role::Trader => self.act_trader(market, report, rng),
        }
    }

    fn act_raider(&mut self, market: &mut Market, report: &mut Report, rng: &mut Pcg64Mcg) {
        // Gear up first: weapon greatly improves yield.
        if !self.has_weapon {
            let want = if self.wild > market.price(ItemKind::Pistol) * 1.2 {
                ItemKind::Pistol
            } else {
                ItemKind::Pipe
            };
            if let Some(cost) = market.buy(want, 1, self.wild, report) {
                self.wild -= cost;
                self.has_weapon = true;
            }
        }
        if !self.has_armor && self.wild > market.price(ItemKind::JacketArmor) * 2.0 {
            if let Some(cost) = market.buy(ItemKind::JacketArmor, 1, self.wild, report) {
                self.wild -= cost;
                self.has_armor = true;
            }
        }

        // Raid.
        let death_chance = if self.has_armor {
            RAID_DEATH_CHANCE * 0.6
        } else {
            RAID_DEATH_CHANCE
        };
        if rng.random_bool(death_chance) {
            // Death: lose all carried resources; maybe gear.
            let lost: u32 = self.items.values().sum();
            report.items_destroyed += lost as u64;
            self.items.clear();
            if rng.random_bool(GEAR_BREAK_ON_DEATH) {
                if self.has_weapon {
                    self.has_weapon = false;
                    report.items_destroyed += 1;
                }
            }
            self.deaths += 1;
            report.total_deaths += 1;
            self.cooldown = rng.random_range(2..6);
            return;
        }

        // Loot: resources, better with a weapon.
        let pulls = if self.has_weapon { 3 } else { 1 };
        for _ in 0..pulls {
            let kind = match rng.random_range(0..10u32) {
                0..=3 => ItemKind::Iron,
                4..=5 => ItemKind::Copper,
                6..=7 => ItemKind::Biomass,
                8 => ItemKind::Chemicals,
                _ => ItemKind::Electronics,
            };
            self.add(kind, rng.random_range(2..6));
        }
        self.wild += RAID_BOUNTY;
        report.wild_minted += RAID_BOUNTY;

        // Weapon wear sink.
        if self.has_weapon && rng.random_bool(WEAPON_WEAR_CHANCE) {
            self.has_weapon = false;
            report.items_destroyed += 1;
        }

        // Consumable demand: medkits get used up (finished-good sink that
        // scales with raid activity).
        if rng.random_bool(MEDKIT_USE_CHANCE) {
            if self.count(ItemKind::Medkit) > 0 {
                self.take(ItemKind::Medkit, 1);
                report.items_destroyed += 1;
            } else if let Some(cost) = market.buy(ItemKind::Medkit, 1, self.wild, report) {
                self.wild -= cost;
                report.items_destroyed += 1;
            }
        }

        // Sell everything gathered.
        let inventory: Vec<(ItemKind, u32)> = self.items.iter().map(|(k, v)| (*k, *v)).collect();
        for (kind, count) in inventory {
            if count > 0 && self.take(kind, count) {
                self.wild += market.sell(kind, count, report);
            }
        }
        self.cooldown = rng.random_range(1..4);
    }

    fn act_industry(
        &mut self,
        market: &mut Market,
        report: &mut Report,
        rng: &mut Pcg64Mcg,
        station: Station,
    ) {
        // Pick the recipe at this station with the best margin at current prices.
        let mut best: Option<(&'static wilder_crafting::Recipe, f32)> = None;
        for recipe in RECIPES.iter().filter(|r| r.station == station) {
            let input_cost: f32 = recipe
                .inputs
                .iter()
                .map(|(k, n)| market.price(*k) * *n as f32)
                .sum();
            let output_value = market.price(recipe.output.0) * recipe.output.1 as f32;
            let margin = output_value - input_cost;
            if margin > 0.0 && best.map(|(_, m)| margin > m).unwrap_or(true) {
                best = Some((recipe, margin));
            }
        }
        let Some((recipe, _)) = best else {
            self.cooldown = 2;
            return;
        };

        // Buy inputs (from stock first, market otherwise).
        for (kind, need) in recipe.inputs {
            let have = self.count(*kind);
            if have < *need {
                let missing = need - have;
                match market.buy(*kind, missing, self.wild, report) {
                    Some(cost) => {
                        self.wild -= cost;
                        self.add(*kind, missing);
                    }
                    None => {
                        self.cooldown = 2;
                        return;
                    }
                }
            }
        }
        for (kind, need) in recipe.inputs {
            self.take(*kind, *need);
        }

        // Craft: pay the station fee (WILD burn).
        let fee = market.price(recipe.output.0) * recipe.output.1 as f32 * CRAFT_FEE_RATIO;
        if self.wild >= fee {
            self.wild -= fee;
            report.wild_burned += fee;
        }
        self.add(recipe.output.0, recipe.output.1);
        report.crafted += recipe.output.1 as u64;

        // Sell output.
        let out = self.count(recipe.output.0);
        if out > 0 && self.take(recipe.output.0, out) {
            self.wild += market.sell(recipe.output.0, out, report);
        }
        // Production time scales with recipe.
        self.cooldown = 1 + (recipe.seconds / 8.0) as u32 + rng.random_range(0..2);
    }

    fn act_trader(&mut self, market: &mut Market, report: &mut Report, rng: &mut Pcg64Mcg) {
        // Traders buy under-priced goods and re-list them, adding liquidity
        // (and paying burn twice, which is another sink).
        let candidates = [
            ItemKind::Iron,
            ItemKind::Copper,
            ItemKind::Chemicals,
            ItemKind::Electronics,
            ItemKind::Biomass,
            ItemKind::SteelPlate,
            ItemKind::Polymer,
        ];
        let kind = candidates[rng.random_range(0..candidates.len())];
        let price = market.price(kind);
        let base = crate::market::base_price(kind);
        if price < base * 0.8 {
            let count = rng.random_range(3..10);
            if let Some(cost) = market.buy(kind, count, self.wild, report) {
                self.wild -= cost;
                self.add(kind, count);
            }
        } else if price > base * 1.1 {
            let have = self.count(kind);
            if have > 0 && self.take(kind, have) {
                self.wild += market.sell(kind, have, report);
            }
        }
        self.cooldown = rng.random_range(1..3);
    }
}
