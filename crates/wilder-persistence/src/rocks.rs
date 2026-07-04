//! RocksDB-backed implementation of the storage traits.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rocksdb::{ColumnFamilyDescriptor, DBCompressionType, IteratorMode, Options, WriteBatch, DB};
use serde::{de::DeserializeOwned, Serialize};
use uuid::Uuid;
use wilder_types::*;

use crate::{
    Account, CharacterStore, PurgeReport, SessionStore, Stash, StoreError, StoreResult, WorldStore,
};

const CF_ACCOUNTS: &str = "accounts";
const CF_USERNAME_INDEX: &str = "username_index";
const CF_CHARACTERS: &str = "characters";
const CF_ACCOUNT_CHARACTERS: &str = "account_characters";
const CF_INVENTORY: &str = "inventory";
const CF_STASH: &str = "stash";
const CF_BLUEPRINTS: &str = "blueprints";
const CF_WORLD_CHUNKS: &str = "world_chunks";
const CF_WORLD_META: &str = "world_meta";
const CF_SESSIONS: &str = "sessions";

const ALL_CFS: &[&str] = &[
    CF_ACCOUNTS,
    CF_USERNAME_INDEX,
    CF_CHARACTERS,
    CF_ACCOUNT_CHARACTERS,
    CF_INVENTORY,
    CF_STASH,
    CF_BLUEPRINTS,
    CF_WORLD_CHUNKS,
    CF_WORLD_META,
    CF_SESSIONS,
];

pub struct RocksStore {
    db: DB,
    path: PathBuf,
}

/// Tuned RocksDB options shared by the base DB and every column family.
///
/// The world re-serializes bounded JSON blobs (ledger, market stats, agent
/// shards, ...) on a tight cadence, so the raw write volume dwarfs the live
/// data set. Left on defaults RocksDB stores it all uncompressed and lets WAL
/// + churned SSTs pile up, which is how a 10 GB disk filled. These settings
/// keep on-disk size proportional to *live* data:
///   - Lz4 on hot levels (cheap) + Zstd on the bottommost level (best ratio;
///     JSON compresses ~5-10x). Transparent: old uncompressed blocks still
///     read fine and get recompressed as they compact down.
///   - A hard WAL ceiling so write-ahead logs can't grow without bound.
///   - Periodic compaction so churned/obsolete data is reclaimed even when a
///     key is rewritten in place forever.
///   - Bounded LOG files so RocksDB's own logging can't eat the disk.
fn tuned_options() -> Options {
    let mut opts = Options::default();
    opts.set_compression_type(DBCompressionType::Lz4);
    opts.set_bottommost_compression_type(DBCompressionType::Zstd);
    opts.set_level_compaction_dynamic_level_bytes(true);
    // Recompact anything untouched for a day so stale/uncompressed blocks and
    // tombstones are reclaimed even under steady in-place overwrites.
    opts.set_periodic_compaction_seconds(24 * 60 * 60);
    opts.set_write_buffer_size(64 * 1024 * 1024);
    opts.set_max_write_buffer_number(3);
    opts
}

impl RocksStore {
    pub fn open(path: impl AsRef<Path>) -> anyhow::Result<Self> {
        let path = path.as_ref().to_path_buf();
        let mut opts = tuned_options();
        opts.create_if_missing(true);
        opts.create_missing_column_families(true);
        opts.increase_parallelism(num_cpus_hint());
        opts.set_max_background_jobs(4);
        // Bound total WAL and RocksDB's own LOG files (both live on the disk).
        opts.set_max_total_wal_size(256 * 1024 * 1024);
        opts.set_keep_log_file_num(5);
        opts.set_max_log_file_size(16 * 1024 * 1024);
        let cfs: Vec<ColumnFamilyDescriptor> = ALL_CFS
            .iter()
            .map(|name| ColumnFamilyDescriptor::new(*name, tuned_options()))
            .collect();
        let db = DB::open_cf_descriptors(&opts, &path, cfs)?;
        Ok(Self { db, path })
    }

    fn cf(&self, name: &str) -> &rocksdb::ColumnFamily {
        self.db.cf_handle(name).expect("column family exists")
    }

    /// Directory this store lives in (the persistent disk mount).
    pub fn data_dir(&self) -> &Path {
        &self.path
    }

    /// Total bytes the store occupies on disk (SSTs + WAL + LOG + manifests).
    /// Walks the data directory so it reflects real disk pressure, not just
    /// RocksDB's live-data estimate. Returns 0 if the dir can't be read.
    pub fn on_disk_bytes(&self) -> u64 {
        fn walk(dir: &Path) -> u64 {
            let mut total = 0;
            let Ok(entries) = std::fs::read_dir(dir) else {
                return 0;
            };
            for entry in entries.flatten() {
                let Ok(meta) = entry.metadata() else { continue };
                if meta.is_dir() {
                    total += walk(&entry.path());
                } else {
                    total += meta.len();
                }
            }
            total
        }
        walk(&self.path)
    }

    /// Force a full compaction of every column family. Reclaims space from
    /// obsolete versions/tombstones (e.g. right after a purge) and applies the
    /// current compression settings to older SSTs.
    pub fn compact(&self) {
        self.db.compact_range(None::<&[u8]>, None::<&[u8]>);
        for name in ALL_CFS {
            self.db
                .compact_range_cf(self.cf(name), None::<&[u8]>, None::<&[u8]>);
        }
    }

    /// Reclaim space by deleting throwaway guest accounts and their data.
    ///
    /// A guest (username starts with `guest_prefix`, e.g. `runner_`) is eligible
    /// when it was created before `older_than_unix` and is **not** in `active`
    /// (the set of accounts currently connected). For each victim this cascades
    /// through the character rows it owns (character + inventory + stash +
    /// blueprints), then the account/username-index entries, then any sessions
    /// pointing at it — all in one atomic write batch. At most `max_delete`
    /// accounts are removed per call so a big backlog drains across several
    /// passes instead of stalling the caller.
    ///
    /// Returns the character ids that were removed (so callers can prune their
    /// in-memory leaderboard/stats rows) plus counts. Does NOT compact; call
    /// [`RocksStore::compact`] afterwards to actually release disk.
    pub fn purge_stale_guests(
        &self,
        active: &HashSet<AccountId>,
        guest_prefix: &str,
        older_than_unix: u64,
        max_delete: usize,
    ) -> StoreResult<PurgeReport> {
        let prefix = guest_prefix.to_lowercase();
        let mut victims: Vec<Account> = Vec::new();
        for item in self.db.iterator_cf(self.cf(CF_ACCOUNTS), IteratorMode::Start) {
            let (_key, value) = item.map_err(|e| StoreError::Backend(e.to_string()))?;
            let Ok(account) = serde_json::from_slice::<Account>(&value) else {
                continue;
            };
            if account.created_unix > older_than_unix
                || active.contains(&account.id)
                || !account.username.to_lowercase().starts_with(&prefix)
            {
                continue;
            }
            victims.push(account);
            if victims.len() >= max_delete {
                break;
            }
        }

        if victims.is_empty() {
            return Ok(PurgeReport::default());
        }

        let victim_ids: HashSet<AccountId> = victims.iter().map(|a| a.id).collect();
        let mut batch = WriteBatch::default();
        let mut character_ids: Vec<CharacterId> = Vec::new();

        for account in &victims {
            let char_ids: Vec<CharacterId> = self
                .get_json(CF_ACCOUNT_CHARACTERS, account.id.as_bytes())?
                .unwrap_or_default();
            for cid in &char_ids {
                batch.delete_cf(self.cf(CF_CHARACTERS), cid.as_bytes());
                batch.delete_cf(self.cf(CF_INVENTORY), cid.as_bytes());
                batch.delete_cf(self.cf(CF_STASH), cid.as_bytes());
                batch.delete_cf(self.cf(CF_BLUEPRINTS), cid.as_bytes());
            }
            character_ids.extend(char_ids);
            batch.delete_cf(self.cf(CF_ACCOUNT_CHARACTERS), account.id.as_bytes());
            batch.delete_cf(self.cf(CF_ACCOUNTS), account.id.as_bytes());
            batch.delete_cf(
                self.cf(CF_USERNAME_INDEX),
                account.username.to_lowercase().as_bytes(),
            );
        }

        // One sweep over the session table drops every token that pointed at a
        // purged account (cheaper than re-scanning per account).
        let mut sessions_deleted = 0usize;
        for item in self.db.iterator_cf(self.cf(CF_SESSIONS), IteratorMode::Start) {
            let (key, value) = item.map_err(|e| StoreError::Backend(e.to_string()))?;
            if let Ok(account) = serde_json::from_slice::<AccountId>(&value) {
                if victim_ids.contains(&account) {
                    batch.delete_cf(self.cf(CF_SESSIONS), &key);
                    sessions_deleted += 1;
                }
            }
        }

        self.db
            .write(batch)
            .map_err(|e| StoreError::Backend(e.to_string()))?;

        Ok(PurgeReport {
            accounts_deleted: victims.len(),
            character_ids,
            sessions_deleted,
        })
    }

    fn get_json<T: DeserializeOwned>(&self, cf: &str, key: &[u8]) -> StoreResult<Option<T>> {
        match self.db.get_cf(self.cf(cf), key) {
            Ok(Some(bytes)) => serde_json::from_slice(&bytes)
                .map(Some)
                .map_err(|e| StoreError::Backend(e.to_string())),
            Ok(None) => Ok(None),
            Err(e) => Err(StoreError::Backend(e.to_string())),
        }
    }

    fn put_json<T: Serialize>(&self, cf: &str, key: &[u8], value: &T) -> StoreResult<()> {
        let bytes = serde_json::to_vec(value).map_err(|e| StoreError::Backend(e.to_string()))?;
        self.db
            .put_cf(self.cf(cf), key, bytes)
            .map_err(|e| StoreError::Backend(e.to_string()))
    }
}

/// Available CPU parallelism for RocksDB background work, clamped so a big
/// host doesn't spin up an absurd number of compaction threads.
fn num_cpus_hint() -> i32 {
    std::thread::available_parallelism()
        .map(|n| n.get().min(8) as i32)
        .unwrap_or(2)
}

fn chunk_key(coord: ChunkCoord) -> Vec<u8> {
    let mut key = Vec::with_capacity(8);
    key.extend_from_slice(&coord.x.to_be_bytes());
    key.extend_from_slice(&coord.z.to_be_bytes());
    key
}

impl CharacterStore for RocksStore {
    fn create_account(&self, username: &str, password_hash: &str) -> StoreResult<Account> {
        let key = username.to_lowercase();
        if self
            .get_json::<AccountId>(CF_USERNAME_INDEX, key.as_bytes())?
            .is_some()
        {
            return Err(StoreError::Conflict("username taken".into()));
        }
        let account = Account {
            id: Uuid::new_v4(),
            username: username.to_string(),
            password_hash: password_hash.to_string(),
            created_unix: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs(),
            wallet: 0,
            bank: 0,
            shards: 0,
            bank_shards: 0,
            energy: 0,
            bank_energy: 0,
        };
        self.put_json(CF_ACCOUNTS, account.id.as_bytes(), &account)?;
        self.put_json(CF_USERNAME_INDEX, key.as_bytes(), &account.id)?;
        Ok(account)
    }

    fn account_by_username(&self, username: &str) -> StoreResult<Account> {
        let key = username.to_lowercase();
        let id: AccountId = self
            .get_json(CF_USERNAME_INDEX, key.as_bytes())?
            .ok_or(StoreError::NotFound)?;
        self.account_by_id(id)
    }

    fn account_by_id(&self, id: AccountId) -> StoreResult<Account> {
        self.get_json(CF_ACCOUNTS, id.as_bytes())?
            .ok_or(StoreError::NotFound)
    }

    fn update_wallet(&self, id: AccountId, wallet: u32) -> StoreResult<()> {
        let mut account = self.account_by_id(id)?;
        account.wallet = wallet;
        self.put_json(CF_ACCOUNTS, id.as_bytes(), &account)
    }

    fn update_bank(&self, id: AccountId, bank: u32) -> StoreResult<()> {
        let mut account = self.account_by_id(id)?;
        account.bank = bank;
        self.put_json(CF_ACCOUNTS, id.as_bytes(), &account)
    }

    fn update_currencies(&self, id: AccountId, shards: u32, energy: u32) -> StoreResult<()> {
        let mut account = self.account_by_id(id)?;
        account.shards = shards;
        account.energy = energy;
        self.put_json(CF_ACCOUNTS, id.as_bytes(), &account)
    }

    fn update_bank_currencies(
        &self,
        id: AccountId,
        bank_shards: u32,
        bank_energy: u32,
    ) -> StoreResult<()> {
        let mut account = self.account_by_id(id)?;
        account.bank_shards = bank_shards;
        account.bank_energy = bank_energy;
        self.put_json(CF_ACCOUNTS, id.as_bytes(), &account)
    }

    fn create_character(&self, character: &Character) -> StoreResult<()> {
        self.put_json(CF_CHARACTERS, character.id.as_bytes(), character)?;
        let mut ids: Vec<CharacterId> = self
            .get_json(CF_ACCOUNT_CHARACTERS, character.account_id.as_bytes())?
            .unwrap_or_default();
        if !ids.contains(&character.id) {
            ids.push(character.id);
        }
        self.put_json(CF_ACCOUNT_CHARACTERS, character.account_id.as_bytes(), &ids)
    }

    fn character(&self, id: CharacterId) -> StoreResult<Character> {
        self.get_json(CF_CHARACTERS, id.as_bytes())?
            .ok_or(StoreError::NotFound)
    }

    fn characters_for_account(&self, account: AccountId) -> StoreResult<Vec<Character>> {
        let ids: Vec<CharacterId> = self
            .get_json(CF_ACCOUNT_CHARACTERS, account.as_bytes())?
            .unwrap_or_default();
        ids.into_iter().map(|id| self.character(id)).collect()
    }

    fn save_character(&self, character: &Character) -> StoreResult<()> {
        self.put_json(CF_CHARACTERS, character.id.as_bytes(), character)
    }

    fn inventory(&self, character: CharacterId) -> StoreResult<Inventory> {
        Ok(self
            .get_json(CF_INVENTORY, character.as_bytes())?
            .unwrap_or_default())
    }

    fn save_inventory(&self, character: CharacterId, inv: &Inventory) -> StoreResult<()> {
        self.put_json(CF_INVENTORY, character.as_bytes(), inv)
    }

    fn stash(&self, character: CharacterId) -> StoreResult<Stash> {
        Ok(self
            .get_json(CF_STASH, character.as_bytes())?
            .unwrap_or_else(Stash::new))
    }

    fn save_stash(&self, character: CharacterId, stash: &Stash) -> StoreResult<()> {
        self.put_json(CF_STASH, character.as_bytes(), stash)
    }

    fn blueprints(&self, character: CharacterId) -> StoreResult<Vec<String>> {
        Ok(self
            .get_json(CF_BLUEPRINTS, character.as_bytes())?
            .unwrap_or_default())
    }

    fn save_blueprints(&self, character: CharacterId, known: &[String]) -> StoreResult<()> {
        self.put_json(CF_BLUEPRINTS, character.as_bytes(), &known.to_vec())
    }
}

impl WorldStore for RocksStore {
    fn chunk(&self, coord: ChunkCoord) -> StoreResult<Option<ChunkData>> {
        self.get_json(CF_WORLD_CHUNKS, &chunk_key(coord))
    }

    fn save_chunk(&self, chunk: &ChunkData) -> StoreResult<()> {
        self.put_json(CF_WORLD_CHUNKS, &chunk_key(chunk.coord), chunk)
    }

    fn meta<T: DeserializeOwned>(&self, key: &str) -> StoreResult<Option<T>> {
        self.get_json(CF_WORLD_META, key.as_bytes())
    }

    fn save_meta<T: Serialize>(&self, key: &str, value: &T) -> StoreResult<()> {
        self.put_json(CF_WORLD_META, key.as_bytes(), value)
    }
}

impl SessionStore for RocksStore {
    fn create_session(&self, account: AccountId) -> StoreResult<String> {
        let token = crate::new_token();
        self.put_json(CF_SESSIONS, token.as_bytes(), &account)?;
        Ok(token)
    }

    fn account_for_token(&self, token: &str) -> StoreResult<AccountId> {
        self.get_json(CF_SESSIONS, token.as_bytes())?
            .ok_or(StoreError::NotFound)
    }

    fn revoke(&self, token: &str) -> StoreResult<()> {
        self.db
            .delete_cf(self.cf(CF_SESSIONS), token.as_bytes())
            .map_err(|e| StoreError::Backend(e.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (tempfile::TempDir, RocksStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = RocksStore::open(dir.path()).unwrap();
        (dir, store)
    }

    #[test]
    fn account_roundtrip() {
        let (_dir, s) = store();
        let a = s.create_account("Neo", "hash").unwrap();
        assert_eq!(s.account_by_username("neo").unwrap().id, a.id);
        assert!(matches!(
            s.create_account("NEO", "other"),
            Err(StoreError::Conflict(_))
        ));
    }

    #[test]
    fn banked_balances_roundtrip() {
        let (_dir, s) = store();
        let a = s.create_account("Vault", "h").unwrap();
        assert_eq!((a.bank, a.bank_shards, a.bank_energy), (0, 0, 0));
        s.update_wallet(a.id, 900).unwrap();
        s.update_bank(a.id, 400).unwrap();
        s.update_currencies(a.id, 12, 7).unwrap();
        s.update_bank_currencies(a.id, 3, 5).unwrap();
        let got = s.account_by_id(a.id).unwrap();
        assert_eq!(got.wallet, 900);
        assert_eq!(got.bank, 400);
        assert_eq!((got.shards, got.energy), (12, 7));
        assert_eq!((got.bank_shards, got.bank_energy), (3, 5));
    }

    #[test]
    fn character_and_inventory_roundtrip() {
        let (_dir, s) = store();
        let a = s.create_account("p1", "h").unwrap();
        let c = Character {
            id: Uuid::new_v4(),
            account_id: a.id,
            name: "Runner".into(),
            appearance: Appearance::default(),
            position: Vec3::new(5.0, 0.0, -3.0),
            yaw: 1.0,
            level: 1,
            xp: 0,
            health: 100.0,
            max_health: 100.0,
            shield: 0.0,
            max_shield: 0.0,
            faction: FACTION_REBELS,
        };
        s.create_character(&c).unwrap();
        let chars = s.characters_for_account(a.id).unwrap();
        assert_eq!(chars.len(), 1);
        assert_eq!(chars[0].name, "Runner");

        let mut inv = Inventory::new();
        inv.slots[0] = Some(ItemStack { kind: ItemKind::Medkit, count: 2 });
        s.save_inventory(c.id, &inv).unwrap();
        let loaded = s.inventory(c.id).unwrap();
        assert_eq!(loaded.slots[0].unwrap().count, 2);
    }

    #[test]
    fn session_roundtrip() {
        let (_dir, s) = store();
        let a = s.create_account("p2", "h").unwrap();
        let token = s.create_session(a.id).unwrap();
        assert_eq!(s.account_for_token(&token).unwrap(), a.id);
        s.revoke(&token).unwrap();
        assert!(matches!(
            s.account_for_token(&token),
            Err(StoreError::NotFound)
        ));
    }

    #[test]
    fn chunk_roundtrip() {
        let (_dir, s) = store();
        let coord = ChunkCoord::new(-2, 7);
        assert!(s.chunk(coord).unwrap().is_none());
        let chunk = ChunkData {
            coord,
            tiles: vec![TileKind::Road; TILES_PER_CHUNK * TILES_PER_CHUNK],
            buildings: vec![],
            props: vec![],
        };
        s.save_chunk(&chunk).unwrap();
        assert!(s.chunk(coord).unwrap().is_some());
    }

    fn guest_char(s: &RocksStore, account: AccountId) -> CharacterId {
        let c = Character {
            id: Uuid::new_v4(),
            account_id: account,
            name: "Runner".into(),
            appearance: Appearance::default(),
            position: Vec3::new(0.0, 0.0, 0.0),
            yaw: 0.0,
            level: 1,
            xp: 0,
            health: 100.0,
            max_health: 100.0,
            shield: 0.0,
            max_shield: 0.0,
            faction: FACTION_REBELS,
        };
        s.create_character(&c).unwrap();
        s.save_inventory(c.id, &Inventory::new()).unwrap();
        s.save_stash(c.id, &Stash::new()).unwrap();
        c.id
    }

    #[test]
    fn purge_removes_stale_guests_only() {
        let (_dir, s) = store();
        // Two guests + one real account, each with a character + a session.
        let g1 = s.create_account("runner_aaaa", "h").unwrap();
        let g2 = s.create_account("runner_bbbb", "h").unwrap();
        let real = s.create_account("Neo", "h").unwrap();
        let g1_char = guest_char(&s, g1.id);
        let g2_char = guest_char(&s, g2.id);
        let real_char = guest_char(&s, real.id);
        let g1_token = s.create_session(g1.id).unwrap();
        let g2_token = s.create_session(g2.id).unwrap();
        let real_token = s.create_session(real.id).unwrap();

        // g2 is "connected" (active) so it must survive; cutoff is in the far
        // future so age never spares anyone.
        let active: HashSet<AccountId> = [g2.id].into_iter().collect();
        let report = s
            .purge_stale_guests(&active, "runner_", u64::MAX, 100)
            .unwrap();

        assert_eq!(report.accounts_deleted, 1);
        assert_eq!(report.sessions_deleted, 1);
        assert_eq!(report.character_ids, vec![g1_char]);

        // g1 fully gone (account, username index, character, inventory, session).
        assert!(matches!(s.account_by_id(g1.id), Err(StoreError::NotFound)));
        assert!(matches!(
            s.account_by_username("runner_aaaa"),
            Err(StoreError::NotFound)
        ));
        assert!(matches!(s.character(g1_char), Err(StoreError::NotFound)));
        assert!(matches!(
            s.account_for_token(&g1_token),
            Err(StoreError::NotFound)
        ));

        // g2 (active) and the real account are untouched.
        assert_eq!(s.account_by_id(g2.id).unwrap().id, g2.id);
        assert_eq!(s.account_for_token(&g2_token).unwrap(), g2.id);
        assert!(s.character(g2_char).is_ok());
        assert_eq!(s.account_by_id(real.id).unwrap().id, real.id);
        assert_eq!(s.account_for_token(&real_token).unwrap(), real.id);
        assert!(s.character(real_char).is_ok());
    }

    #[test]
    fn purge_respects_min_age() {
        let (_dir, s) = store();
        let g = s.create_account("runner_young", "h").unwrap();
        guest_char(&s, g.id);
        // Cutoff of 0 => nothing is old enough, so a brand-new guest is spared.
        let report = s
            .purge_stale_guests(&HashSet::new(), "runner_", 0, 100)
            .unwrap();
        assert!(report.is_empty());
        assert!(s.account_by_id(g.id).is_ok());
    }

    #[test]
    fn compact_and_disk_size_work() {
        let (_dir, s) = store();
        s.create_account("runner_x", "h").unwrap();
        s.compact();
        assert!(s.on_disk_bytes() > 0);
    }
}
