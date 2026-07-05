//! The economy ledger: every economic mutation in the sim is recorded as a
//! typed transaction between two parties (players, agents, or the Mint/Burn
//! system endpoints). The ledger keeps a ring buffer of recent transactions
//! for the live dashboard feed plus running supply counters per item kind,
//! so total supply stays auditable: circulating = minted - burned.
//!
//! `hash` and `block` are mock values (derived from the tx sequence and the
//! server tick) until the ledger gets a real chain.

use std::collections::{HashMap, VecDeque};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use wilder_types::{EconTx, EconomyStats, ItemKind, ItemSupply, TxAmount, TxKind, TxParty};

/// How many recent transactions the server keeps for dashboard snapshots.
const RECENT_CAP: usize = 512;
/// Server ticks per mock block (20 Hz -> ~5 s blocks).
pub const TICKS_PER_BLOCK: u64 = 100;

/// How a transaction affects item/MILD supply counters.
///
/// `Auto` derives the effect from the parties (`Mint` source mints, `Burn`
/// sink burns, anything else is a neutral transfer). Vendor stock needs the
/// explicit overrides: an Armory sale is a real `Agent -> Player` transfer in
/// the feed, but the item enters supply from the vendor's bottomless stock.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SupplyEffect {
    Auto,
    Mint,
    Burn,
}

/// Aggregates persisted across restarts (the tx feed itself is in-memory).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct LedgerSave {
    pub seq: u64,
    pub tx_count: u64,
    pub items: Vec<ItemSupply>,
    pub wild_minted: u64,
    pub wild_burned: u64,
    pub wild_agent_held: i64,
    #[serde(default)]
    pub shards_minted: u64,
    #[serde(default)]
    pub shards_burned: u64,
    #[serde(default)]
    pub energy_minted: u64,
    #[serde(default)]
    pub energy_burned: u64,
    pub blueprints_learned: u64,
    #[serde(default)]
    pub items_extracted: u64,
    #[serde(default)]
    pub items_withdrawn: u64,
    pub deaths: u64,
    pub npc_kills: u64,
    pub trades: u64,
}

pub struct Ledger {
    seq: u64,
    /// Current mock block height (fed by the world each tick).
    block: u64,
    /// Ring buffer of the latest transactions (oldest first).
    recent: VecDeque<EconTx>,
    /// Transactions recorded since the last flush to subscribers.
    pending: Vec<EconTx>,
    /// Per-item (minted, burned) counters.
    items: HashMap<ItemKind, (u64, u64)>,
    wild_minted: u64,
    wild_burned: u64,
    /// Net MILD sitting on agent balances (vendor takings minus payouts).
    wild_agent_held: i64,
    shards_minted: u64,
    shards_burned: u64,
    energy_minted: u64,
    energy_burned: u64,
    pub blueprints_learned: u64,
    /// Items stashed (Extract forward leg) / pulled back out (reverse leg).
    pub items_extracted: u64,
    pub items_withdrawn: u64,
    pub deaths: u64,
    pub npc_kills: u64,
    pub trades: u64,
    tx_count: u64,
}

/// splitmix64: cheap deterministic 64-bit scramble for mock tx hashes.
fn mock_hash(seq: u64) -> String {
    let mut z = seq.wrapping_add(0x9E37_79B9_7F4A_7C15);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^= z >> 31;
    format!("0x{z:016x}")
}

pub(crate) fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl Ledger {
    pub fn new(save: LedgerSave) -> Self {
        Self {
            seq: save.seq,
            block: 0,
            recent: VecDeque::with_capacity(RECENT_CAP),
            pending: Vec::new(),
            items: save
                .items
                .into_iter()
                .map(|s| (s.kind, (s.minted, s.burned)))
                .collect(),
            wild_minted: save.wild_minted,
            wild_burned: save.wild_burned,
            wild_agent_held: save.wild_agent_held,
            shards_minted: save.shards_minted,
            shards_burned: save.shards_burned,
            energy_minted: save.energy_minted,
            energy_burned: save.energy_burned,
            blueprints_learned: save.blueprints_learned,
            items_extracted: save.items_extracted,
            items_withdrawn: save.items_withdrawn,
            deaths: save.deaths,
            npc_kills: save.npc_kills,
            trades: save.trades,
            tx_count: save.tx_count,
        }
    }

    pub fn save(&self) -> LedgerSave {
        LedgerSave {
            seq: self.seq,
            tx_count: self.tx_count,
            items: self.item_supplies(),
            wild_minted: self.wild_minted,
            wild_burned: self.wild_burned,
            wild_agent_held: self.wild_agent_held,
            shards_minted: self.shards_minted,
            shards_burned: self.shards_burned,
            energy_minted: self.energy_minted,
            energy_burned: self.energy_burned,
            blueprints_learned: self.blueprints_learned,
            items_extracted: self.items_extracted,
            items_withdrawn: self.items_withdrawn,
            deaths: self.deaths,
            npc_kills: self.npc_kills,
            trades: self.trades,
        }
    }

    /// Advance the mock block height (call once per world tick).
    pub fn set_tick(&mut self, tick: u64) {
        self.block = tick / TICKS_PER_BLOCK;
    }

    /// Record a transaction with the supply effect derived from its parties.
    pub fn record(&mut self, kind: TxKind, from: TxParty, to: TxParty, amount: TxAmount, fee: u32) {
        self.record_ex(kind, from, to, amount, fee, SupplyEffect::Auto);
    }

    /// Record a transaction with an explicit supply effect (vendor stock).
    pub fn record_ex(
        &mut self,
        kind: TxKind,
        from: TxParty,
        to: TxParty,
        amount: TxAmount,
        fee: u32,
        effect: SupplyEffect,
    ) {
        let effect = match effect {
            SupplyEffect::Auto => match (&from, &to) {
                (TxParty::Mint, _) => Some(true),
                (_, TxParty::Burn) => Some(false),
                _ => None,
            },
            SupplyEffect::Mint => Some(true),
            SupplyEffect::Burn => Some(false),
        };
        match &amount {
            TxAmount::Item { kind, count } => {
                let entry = self.items.entry(*kind).or_insert((0, 0));
                match effect {
                    Some(true) => entry.0 += *count as u64,
                    Some(false) => entry.1 += *count as u64,
                    None => {}
                }
            }
            TxAmount::Wild { amount } => {
                match effect {
                    Some(true) => self.wild_minted += *amount as u64,
                    Some(false) => self.wild_burned += *amount as u64,
                    None => {}
                }
                // Agent balance tracking: vendors/market accumulate takings
                // and pay out proceeds from the same pool. Minted MILD leaves
                // an agent's books untouched (created, not paid out) and only
                // lands on an agent when the agent is the recipient; burns
                // mirror that on the source side.
                if effect != Some(true) {
                    if let TxParty::Agent { .. } = from {
                        self.wild_agent_held -= *amount as i64;
                    }
                }
                if effect != Some(false) {
                    if let TxParty::Agent { .. } = to {
                        self.wild_agent_held += *amount as i64;
                    }
                }
            }
            TxAmount::Shards { amount } => match effect {
                Some(true) => self.shards_minted += *amount as u64,
                Some(false) => self.shards_burned += *amount as u64,
                None => {}
            },
            TxAmount::Energy { amount } => match effect {
                Some(true) => self.energy_minted += *amount as u64,
                Some(false) => self.energy_burned += *amount as u64,
                None => {}
            },
            TxAmount::Blueprint { .. } => {}
        }

        self.seq += 1;
        self.tx_count += 1;
        let tx = EconTx {
            seq: self.seq,
            hash: mock_hash(self.seq),
            block: self.block,
            at_ms: unix_ms(),
            kind,
            from,
            to,
            amount,
            fee,
        };
        if self.recent.len() >= RECENT_CAP {
            self.recent.pop_front();
        }
        self.recent.push_back(tx.clone());
        self.pending.push(tx);
    }

    /// Drain transactions recorded since the last flush (per-tick batch).
    pub fn take_pending(&mut self) -> Vec<EconTx> {
        std::mem::take(&mut self.pending)
    }

    pub fn has_pending(&self) -> bool {
        !self.pending.is_empty()
    }

    /// The recent-transaction ring, oldest first (dashboard snapshot).
    pub fn recent(&self) -> Vec<EconTx> {
        self.recent.iter().cloned().collect()
    }

    /// Supply counters for one kind (zeroes when it never saw activity).
    /// Only tests read single kinds; the dashboard ships the full list.
    #[cfg(test)]
    pub fn item_supply(&self, kind: ItemKind) -> ItemSupply {
        let (minted, burned) = self.items.get(&kind).copied().unwrap_or((0, 0));
        ItemSupply { kind, minted, burned }
    }

    /// Circulating units of one item kind: minted - burned, floored at zero
    /// (market-cap denominator on the Trade screen).
    pub fn item_circulating(&self, kind: ItemKind) -> u64 {
        let (minted, burned) = self.items.get(&kind).copied().unwrap_or((0, 0));
        minted.saturating_sub(burned)
    }

    /// Circulating Shards supply (minted - burned).
    pub fn shards_circulating(&self) -> u64 {
        self.shards_minted.saturating_sub(self.shards_burned)
    }

    /// Circulating Energy supply (minted - burned).
    pub fn energy_circulating(&self) -> u64 {
        self.energy_minted.saturating_sub(self.energy_burned)
    }

    fn item_supplies(&self) -> Vec<ItemSupply> {
        let mut items: Vec<ItemSupply> = self
            .items
            .iter()
            .map(|(&kind, &(minted, burned))| ItemSupply { kind, minted, burned })
            .collect();
        items.sort_by_key(|s| format!("{:?}", s.kind));
        items
    }

    pub fn stats(&self, players_online: u32, agents_alive: u32) -> EconomyStats {
        EconomyStats {
            block: self.block,
            tx_count: self.tx_count,
            wild_minted: self.wild_minted,
            wild_burned: self.wild_burned,
            wild_circulating: self.wild_minted as i64 - self.wild_burned as i64,
            wild_agent_held: self.wild_agent_held,
            shards_minted: self.shards_minted,
            shards_burned: self.shards_burned,
            energy_minted: self.energy_minted,
            energy_burned: self.energy_burned,
            items: self.item_supplies(),
            blueprints_learned: self.blueprints_learned,
            items_extracted: self.items_extracted,
            items_withdrawn: self.items_withdrawn,
            players_online,
            agents_alive,
            deaths: self.deaths,
            npc_kills: self.npc_kills,
            trades: self.trades,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wilder_types::{FACTION_NEUTRAL, FACTION_REBELS};

    fn player() -> TxParty {
        TxParty::Player { id: uuid::Uuid::nil(), name: "Runner".into(), faction: FACTION_REBELS }
    }

    fn agent() -> TxParty {
        TxParty::Agent { id: uuid::Uuid::nil(), name: "Armory".into(), faction: FACTION_NEUTRAL }
    }

    #[test]
    fn supply_tracks_mint_transfer_burn() {
        let mut ledger = Ledger::new(LedgerSave::default());
        ledger.set_tick(250);
        let iron = |count| TxAmount::Item { kind: ItemKind::Iron, count };

        ledger.record(TxKind::Mint, TxParty::Mint, player(), iron(10), 0);
        ledger.record(TxKind::LootPickup, agent(), player(), iron(5), 0);
        ledger.record(TxKind::Burn, player(), TxParty::Burn, iron(3), 0);

        let stats = ledger.stats(1, 1);
        let iron_supply = stats.items.iter().find(|s| s.kind == ItemKind::Iron).unwrap();
        assert_eq!(iron_supply.minted, 10);
        assert_eq!(iron_supply.burned, 3);
        assert_eq!(stats.tx_count, 3);
        assert_eq!(stats.block, 2);
        // Transactions carry mock hashes and the current block.
        let recent = ledger.recent();
        assert_eq!(recent.len(), 3);
        assert!(recent[0].hash.starts_with("0x"));
        assert_eq!(recent[2].block, 2);
    }

    #[test]
    fn wild_and_agent_balances() {
        let mut ledger = Ledger::new(LedgerSave::default());
        let wild = |amount| TxAmount::Wild { amount };

        // Grant mints, vendor purchase moves MILD onto the agent, vendor
        // payout moves it back off.
        ledger.record(TxKind::Mint, TxParty::Mint, player(), wild(200), 0);
        ledger.record(TxKind::VendorBuy, player(), agent(), wild(50), 5);
        ledger.record(TxKind::VendorSell, agent(), player(), wild(20), 2);

        let stats = ledger.stats(1, 0);
        assert_eq!(stats.wild_minted, 200);
        assert_eq!(stats.wild_burned, 0);
        assert_eq!(stats.wild_circulating, 200);
        assert_eq!(stats.wild_agent_held, 30);
    }

    #[test]
    fn vendor_stock_effects_and_persistence_roundtrip() {
        let mut ledger = Ledger::new(LedgerSave::default());
        let ammo = |count| TxAmount::Item { kind: ItemKind::Ammo9mm, count };

        // Vendor sale: Agent -> Player in the feed, but stock is issuance.
        ledger.record_ex(TxKind::VendorBuy, agent(), player(), ammo(30), 0, SupplyEffect::Mint);
        // Selling to the vendor absorbs the items out of supply.
        ledger.record_ex(TxKind::VendorSell, player(), agent(), ammo(10), 0, SupplyEffect::Burn);
        ledger.deaths += 1;

        let reloaded = Ledger::new(ledger.save());
        let stats = reloaded.stats(0, 0);
        let supply = stats.items.iter().find(|s| s.kind == ItemKind::Ammo9mm).unwrap();
        assert_eq!(supply.minted, 30);
        assert_eq!(supply.burned, 10);
        assert_eq!(stats.deaths, 1);
        assert_eq!(stats.tx_count, 2);
    }
}
