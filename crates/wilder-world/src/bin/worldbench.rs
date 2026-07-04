//! Headless world-sim benchmark. Steps a fully seeded world as fast as it
//! will go and prints tick percentiles + the per-phase breakdown.
//!
//! Usage:
//!   cargo run -p wilder-world --release --bin worldbench -- \
//!       [--agents 5000] [--players 4] [--ticks 1200]

use wilder_world::bench::{run, BenchConfig};

fn main() {
    let mut cfg = BenchConfig { agents: 500, players: 4, ticks: 1200 };
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        let value = args.next();
        let parse = |v: Option<String>| -> u64 {
            v.and_then(|v| v.parse().ok()).unwrap_or_else(|| {
                eprintln!("bad or missing value for {arg}");
                std::process::exit(2);
            })
        };
        match arg.as_str() {
            "--agents" => cfg.agents = parse(value) as usize,
            "--players" => cfg.players = parse(value) as usize,
            "--ticks" => cfg.ticks = parse(value),
            other => {
                eprintln!("unknown flag {other}");
                std::process::exit(2);
            }
        }
    }
    run(cfg);
}
