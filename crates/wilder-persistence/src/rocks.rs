//! RocksDB-backed implementation of the storage traits.

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use rocksdb::{ColumnFamilyDescriptor, Options, DB};
use serde::{de::DeserializeOwned, Serialize};
use uuid::Uuid;
use wilder_types::*;

use crate::{
    Account, CharacterStore, SessionStore, Stash, StoreError, StoreResult, WorldStore,
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
}

impl RocksStore {
    pub fn open(path: impl AsRef<Path>) -> anyhow::Result<Self> {
        let mut opts = Options::default();
        opts.create_if_missing(true);
        opts.create_missing_column_families(true);
        let cfs: Vec<ColumnFamilyDescriptor> = ALL_CFS
            .iter()
            .map(|name| ColumnFamilyDescriptor::new(*name, Options::default()))
            .collect();
        let db = DB::open_cf_descriptors(&opts, path, cfs)?;
        Ok(Self { db })
    }

    fn cf(&self, name: &str) -> &rocksdb::ColumnFamily {
        self.db.cf_handle(name).expect("column family exists")
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
            shards: 0,
            energy: 0,
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

    fn update_currencies(&self, id: AccountId, shards: u32, energy: u32) -> StoreResult<()> {
        let mut account = self.account_by_id(id)?;
        account.shards = shards;
        account.energy = energy;
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
}
