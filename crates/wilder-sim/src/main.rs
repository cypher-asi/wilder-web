//! Wilder economy simulator (Phase 0.5).
//!
//! Simulates thousands of agents playing the full economic loop — raiding for
//! resources, refining, manufacturing, trading, dying — at far faster than
//! real time, and emits CSV/JSON balance reports used to tune recipes, sinks,
//! and resource generation before they ship.
//!
//! Usage:
//!   cargo run -p wilder-sim --release -- [--agents 10000] [--days 30] [--seed 42] [--out sim_out]

mod agents;
mod market;
mod report;

use agents::{Agent, Role};
use market::Market;
use rand::{Rng, SeedableRng};
use rand_pcg::Pcg64Mcg;
use report::Report;
use std::time::Instant;
use wilder_types::ItemKind;

pub const HOURS_PER_DAY: u32 = 24;

pub struct Config {
    pub agents: usize,
    pub days: u32,
    pub seed: u64,
    pub out_dir: String,
}

fn parse_args() -> Config {
    let mut config = Config {
        agents: 10_000,
        days: 30,
        seed: 42,
        out_dir: "sim_out".into(),
    };
    let args: Vec<String> = std::env::args().collect();
    let mut i = 1;
    while i + 1 < args.len() {
        match args[i].as_str() {
            "--agents" => config.agents = args[i + 1].parse().unwrap_or(config.agents),
            "--days" => config.days = args[i + 1].parse().unwrap_or(config.days),
            "--seed" => config.seed = args[i + 1].parse().unwrap_or(config.seed),
            "--out" => config.out_dir = args[i + 1].clone(),
            _ => {}
        }
        i += 2;
    }
    config
}

fn main() {
    let config = parse_args();
    println!(
        "wilder-sim: {} agents, {} days, seed {}",
        config.agents, config.days, config.seed
    );

    let start = Instant::now();
    let mut rng = Pcg64Mcg::seed_from_u64(config.seed);
    let mut market = Market::new();
    let mut report = Report::new();

    // Population split: most players raid; industry roles are rarer.
    let mut agents: Vec<Agent> = (0..config.agents)
        .map(|i| {
            let roll = rng.random::<f32>();
            let role = if roll < 0.60 {
                Role::Raider
            } else if roll < 0.80 {
                Role::Refiner
            } else if roll < 0.95 {
                Role::Crafter
            } else {
                Role::Trader
            };
            Agent::new(i as u32, role, &mut rng)
        })
        .collect();

    for day in 0..config.days {
        for _hour in 0..HOURS_PER_DAY {
            for agent in agents.iter_mut() {
                agent.act(&mut market, &mut report, &mut rng);
            }
            market.clear_hour(&mut report, &mut rng);
        }
        market.decay_prices();
        report.snapshot_day(day, &agents, &market);
        if day % 5 == 0 || day == config.days - 1 {
            let p = &report.days.last().unwrap();
            println!(
                "day {:>3}: price_index {:.2} | money/agent {:>7.0} | deaths {:>6} | burned {:>9.0}",
                day, p.price_index, p.money_per_agent, p.total_deaths, p.wild_burned
            );
        }
    }

    std::fs::create_dir_all(&config.out_dir).expect("create out dir");
    report.write_csv(&config.out_dir).expect("write csv");
    report.write_json(&config.out_dir, &config).expect("write json");

    println!(
        "simulated {} agent-days in {:.1}s -> {}/",
        config.agents as u64 * config.days as u64,
        start.elapsed().as_secs_f32(),
        config.out_dir
    );

    // Sanity summary for tuning.
    let last = report.days.last().unwrap();
    println!("--- final state ---");
    println!("price index:      {:.2} (1.0 = baseline)", last.price_index);
    println!("money per agent:  {:.0} MILD", last.money_per_agent);
    println!("faucet total:     {:.0} MILD", last.wild_minted);
    println!("burned total:     {:.0} MILD ({:.0}%)", last.wild_burned, 100.0 * last.wild_burned / last.wild_minted.max(1.0));
    println!("deaths:           {}", last.total_deaths);
    println!("items destroyed:  {}", last.items_destroyed);
    for kind in [ItemKind::Iron, ItemKind::SteelPlate, ItemKind::Pistol] {
        println!("price {:?}: {:.1}", kind, market.price(kind));
    }
}
