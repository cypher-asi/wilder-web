//! Competition stats and leaderboards.
//!
//! `StatsBook` keeps one [`ActorStats`] row per competing identity (player
//! characters and living agent identities) plus lifetime faction/guild
//! aggregates, persisted in world meta (`stats_book`). Wealth is never stored
//! here — it's computed live from wallets when a board is built, so the
//! Wealth board always reflects the actual economy.
//!
//! Agent identities are mortal: when an agent dies and respawns as a fresh
//! identity, its per-identity row retires off the boards, but everything it
//! contributed stays in the faction/guild lifetime totals. Player rows
//! persist forever.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use uuid::Uuid;
use wilder_protocol::{
    Board, BoardRow, FactionStanding, GuildStanding, LeaderboardData, ZoneStanding,
};
use wilder_types::{FactionId, FactionInfo};

/// Rows per leaderboard category.
pub const BOARD_ROWS: usize = 10;

/// Identity of one competitor, resolved by the world at each hook site.
#[derive(Debug, Clone)]
pub struct ActorRef {
    pub id: Uuid,
    pub name: String,
    pub faction: FactionId,
    pub guild: Option<String>,
    pub is_player: bool,
}

/// Accumulated stats for one competing identity.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ActorStats {
    pub name: String,
    pub faction: FactionId,
    pub guild: Option<String>,
    pub is_player: bool,
    pub kills: u64,
    pub deaths: u64,
    /// Units of resources gathered from the field.
    pub resources: u64,
    /// Market trades participated in (either side).
    pub trades: u64,
    /// Units crafted/produced.
    pub crafted: u64,
}

/// Lifetime rollup per faction (survives member identity churn).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct FactionTotals {
    pub kills: u64,
    pub deaths: u64,
}

/// Lifetime rollup per guild.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct GuildTotals {
    pub faction: FactionId,
    pub kills: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct StatsBook {
    pub actors: HashMap<Uuid, ActorStats>,
    pub factions: HashMap<FactionId, FactionTotals>,
    pub guilds: HashMap<String, GuildTotals>,
}

impl StatsBook {
    /// Upsert the actor row, refreshing its display identity (names and
    /// guilds can change; the uuid is the key). A `None` guild never wipes a
    /// known one — some hook sites resolve identities without guild info.
    fn actor(&mut self, r: &ActorRef) -> &mut ActorStats {
        let row = self.actors.entry(r.id).or_default();
        row.name = r.name.clone();
        row.faction = r.faction;
        if r.guild.is_some() {
            row.guild = r.guild.clone();
        }
        row.is_player = r.is_player;
        row
    }

    /// Record a kill: credits the killer (when known) and debits the victim,
    /// updating faction/guild lifetime totals alongside.
    pub fn record_kill(&mut self, killer: Option<&ActorRef>, victim: &ActorRef) {
        if let Some(k) = killer {
            self.actor(k).kills += 1;
            self.factions.entry(k.faction).or_default().kills += 1;
            if let Some(guild) = &k.guild {
                let g = self.guilds.entry(guild.clone()).or_default();
                g.faction = k.faction;
                g.kills += 1;
            }
        }
        self.actor(victim).deaths += 1;
        self.factions.entry(victim.faction).or_default().deaths += 1;
    }

    pub fn add_resources(&mut self, r: &ActorRef, count: u64) {
        self.actor(r).resources += count;
    }

    pub fn add_trade(&mut self, r: &ActorRef) {
        self.actor(r).trades += 1;
    }

    pub fn add_crafted(&mut self, r: &ActorRef, count: u64) {
        self.actor(r).crafted += count;
    }

    /// An agent identity died for good (respawn mints a new one): drop its
    /// row from the boards. Lifetime faction/guild totals keep its legacy.
    pub fn retire(&mut self, id: Uuid) {
        self.actors.remove(&id);
    }
}

/// One live competitor with its current wealth (wallet + carried value),
/// gathered by the world when a leaderboard snapshot is built.
#[derive(Debug, Clone)]
pub struct LiveActor {
    pub id: Uuid,
    pub name: String,
    pub faction: FactionId,
    pub guild: Option<String>,
    pub wealth: i64,
}

/// Build the full leaderboard payload from the persistent book plus a live
/// snapshot of competitors, region control and district control.
pub fn build_leaderboard(
    book: &StatsBook,
    live: &[LiveActor],
    registry: &[FactionInfo],
    regions_by_faction: &HashMap<FactionId, u32>,
    districts_by_faction: &HashMap<FactionId, u32>,
    zones: Vec<ZoneStanding>,
) -> LeaderboardData {
    // Rolling "zone points" per faction: total cell-seconds held across every
    // neighborhood in the recent window.
    let mut zone_points_by_faction: HashMap<FactionId, u64> = HashMap::new();
    for z in &zones {
        for s in &z.seconds {
            *zone_points_by_faction.entry(s.faction).or_default() += s.seconds;
        }
    }
    // Wealth: live wallets, richest first.
    let mut by_wealth: Vec<&LiveActor> = live.iter().collect();
    by_wealth.sort_by(|a, b| b.wealth.cmp(&a.wealth).then_with(|| a.name.cmp(&b.name)));
    let wealth_board = Board {
        category: "Wealth".into(),
        rows: by_wealth
            .iter()
            .take(BOARD_ROWS)
            .map(|a| BoardRow {
                name: a.name.clone(),
                faction: a.faction,
                guild: a.guild.clone(),
                value: a.wealth,
            })
            .collect(),
    };

    // Stat boards from the book (kills / resources / trades / industry).
    let stat_board = |category: &str, pick: fn(&ActorStats) -> u64| -> Board {
        let mut rows: Vec<&ActorStats> = book.actors.values().filter(|a| pick(a) > 0).collect();
        rows.sort_by(|a, b| pick(b).cmp(&pick(a)).then_with(|| a.name.cmp(&b.name)));
        Board {
            category: category.into(),
            rows: rows
                .into_iter()
                .take(BOARD_ROWS)
                .map(|a| BoardRow {
                    name: a.name.clone(),
                    faction: a.faction,
                    guild: a.guild.clone(),
                    value: pick(a) as i64,
                })
                .collect(),
        }
    };
    let boards = vec![
        wealth_board,
        stat_board("Kills", |a| a.kills),
        stat_board("Resources", |a| a.resources),
        stat_board("Trades", |a| a.trades),
        stat_board("Industry", |a| a.crafted),
    ];

    // Faction standings: lifetime totals + live membership/treasury/turf.
    let factions = registry
        .iter()
        .map(|f| {
            let totals = book.factions.get(&f.id).cloned().unwrap_or_default();
            let members = live.iter().filter(|a| a.faction == f.id).count() as u32;
            let treasury: i64 =
                live.iter().filter(|a| a.faction == f.id).map(|a| a.wealth).sum();
            FactionStanding {
                faction: f.id,
                members,
                kills: totals.kills,
                deaths: totals.deaths,
                treasury,
                regions_held: regions_by_faction.get(&f.id).copied().unwrap_or(0),
                districts_held: districts_by_faction.get(&f.id).copied().unwrap_or(0),
                zone_points: zone_points_by_faction.get(&f.id).copied().unwrap_or(0),
            }
        })
        .collect();

    // Guild standings: every guild with living members (membership + pooled
    // wealth from the live snapshot) merged with lifetime kill totals, so
    // guilds rank from their first day even before they draw blood.
    let mut guild_rows: HashMap<&str, GuildStanding> = HashMap::new();
    for a in live {
        let Some(guild) = a.guild.as_deref() else { continue };
        let row = guild_rows.entry(guild).or_insert_with(|| GuildStanding {
            name: guild.to_string(),
            faction: a.faction,
            members: 0,
            kills: 0,
            wealth: 0,
        });
        row.members += 1;
        row.wealth += a.wealth;
    }
    for (name, totals) in &book.guilds {
        let row = guild_rows.entry(name.as_str()).or_insert_with(|| GuildStanding {
            name: name.clone(),
            faction: totals.faction,
            members: 0,
            kills: 0,
            wealth: 0,
        });
        row.faction = totals.faction;
        row.kills = totals.kills;
    }
    let mut guilds: Vec<GuildStanding> = guild_rows.into_values().collect();
    guilds.sort_by(|a, b| b.kills.cmp(&a.kills).then_with(|| b.wealth.cmp(&a.wealth)));

    LeaderboardData { boards, factions, guilds, zones }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wilder_types::{FACTION_FORUM, FACTION_REBELS};

    fn actor(name: &str, faction: FactionId, guild: Option<&str>, player: bool) -> ActorRef {
        ActorRef {
            id: Uuid::new_v4(),
            name: name.into(),
            faction,
            guild: guild.map(Into::into),
            is_player: player,
        }
    }

    fn registry() -> Vec<FactionInfo> {
        crate::factions::faction_registry()
    }

    #[test]
    fn kills_roll_up_to_faction_and_guild() {
        let mut book = StatsBook::default();
        let killer = actor("REBEL-AAAA", FACTION_REBELS, Some("Dead Signal"), false);
        let victim = actor("FORUM-BBBB", FACTION_FORUM, Some("The Moderators"), false);
        book.record_kill(Some(&killer), &victim);
        book.record_kill(Some(&killer), &victim);
        assert_eq!(book.actors[&killer.id].kills, 2);
        assert_eq!(book.actors[&victim.id].deaths, 2);
        assert_eq!(book.factions[&FACTION_REBELS].kills, 2);
        assert_eq!(book.factions[&FACTION_FORUM].deaths, 2);
        assert_eq!(book.guilds["Dead Signal"].kills, 2);
    }

    #[test]
    fn retiring_an_identity_keeps_lifetime_totals() {
        let mut book = StatsBook::default();
        let killer = actor("REBEL-AAAA", FACTION_REBELS, Some("Dead Signal"), false);
        let victim = actor("FORUM-BBBB", FACTION_FORUM, None, false);
        book.record_kill(Some(&killer), &victim);
        book.retire(killer.id);
        assert!(!book.actors.contains_key(&killer.id));
        assert_eq!(book.factions[&FACTION_REBELS].kills, 1);
        assert_eq!(book.guilds["Dead Signal"].kills, 1);
    }

    #[test]
    fn boards_rank_and_cap() {
        let mut book = StatsBook::default();
        let mut live = Vec::new();
        for i in 0..15 {
            let a = actor(&format!("A{i:02}"), FACTION_REBELS, None, false);
            for _ in 0..i {
                book.add_trade(&a);
            }
            book.add_resources(&a, (i * 10) as u64);
            live.push(LiveActor {
                id: a.id,
                name: a.name.clone(),
                faction: a.faction,
                guild: None,
                wealth: 1000 - i as i64,
            });
        }
        let data =
            build_leaderboard(&book, &live, &registry(), &HashMap::new(), &HashMap::new(), vec![]);
        let wealth = data.boards.iter().find(|b| b.category == "Wealth").unwrap();
        assert_eq!(wealth.rows.len(), BOARD_ROWS);
        assert_eq!(wealth.rows[0].name, "A00");
        assert_eq!(wealth.rows[0].value, 1000);
        let trades = data.boards.iter().find(|b| b.category == "Trades").unwrap();
        assert_eq!(trades.rows[0].name, "A14");
        assert_eq!(trades.rows[0].value, 14);
        // Zero-stat actors never pad a stat board.
        assert!(trades.rows.iter().all(|r| r.value > 0));
    }

    #[test]
    fn faction_standings_report_turf_and_treasury() {
        let book = StatsBook::default();
        let live = vec![
            LiveActor {
                id: Uuid::new_v4(),
                name: "REBEL-AAAA".into(),
                faction: FACTION_REBELS,
                guild: None,
                wealth: 300,
            },
            LiveActor {
                id: Uuid::new_v4(),
                name: "REBEL-CCCC".into(),
                faction: FACTION_REBELS,
                guild: None,
                wealth: 200,
            },
        ];
        let regions = HashMap::from([(FACTION_REBELS, 4u32)]);
        let districts = HashMap::from([(FACTION_REBELS, 1u32)]);
        let data = build_leaderboard(&book, &live, &registry(), &regions, &districts, vec![]);
        let rebels =
            data.factions.iter().find(|f| f.faction == FACTION_REBELS).unwrap();
        assert_eq!(rebels.members, 2);
        assert_eq!(rebels.treasury, 500);
        assert_eq!(rebels.regions_held, 4);
        assert_eq!(rebels.districts_held, 1);
    }

    #[test]
    fn guild_standings_exist_before_first_blood() {
        let book = StatsBook::default();
        let live = vec![
            LiveActor {
                id: Uuid::new_v4(),
                name: "REBEL-AAAA".into(),
                faction: FACTION_REBELS,
                guild: Some("Dead Signal".into()),
                wealth: 120,
            },
            LiveActor {
                id: Uuid::new_v4(),
                name: "REBEL-BBBB".into(),
                faction: FACTION_REBELS,
                guild: Some("Dead Signal".into()),
                wealth: 80,
            },
        ];
        let data =
            build_leaderboard(&book, &live, &registry(), &HashMap::new(), &HashMap::new(), vec![]);
        let guild = data.guilds.iter().find(|g| g.name == "Dead Signal").unwrap();
        assert_eq!(guild.members, 2);
        assert_eq!(guild.wealth, 200);
        assert_eq!(guild.kills, 0);
        assert_eq!(guild.faction, FACTION_REBELS);
    }

    #[test]
    fn book_persists_through_json() {
        let mut book = StatsBook::default();
        let killer = actor("REBEL-AAAA", FACTION_REBELS, Some("Dead Signal"), false);
        let victim = actor("FORUM-BBBB", FACTION_FORUM, None, false);
        book.record_kill(Some(&killer), &victim);
        let json = serde_json::to_string(&book).unwrap();
        let back: StatsBook = serde_json::from_str(&json).unwrap();
        assert_eq!(back.actors[&killer.id].kills, 1);
        assert_eq!(back.factions[&FACTION_REBELS].kills, 1);
    }
}
