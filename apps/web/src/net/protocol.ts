// TypeScript mirror of shared/wilder-protocol (serde JSON with {t, d} tagging).
// Must stay in sync with the Rust definitions.

/** glam::Vec3 serializes as a [x, y, z] tuple. */
export type Vec3 = [number, number, number];

export interface ChunkCoord {
  x: number;
  z: number;
}

export const CHUNK_SIZE = 32;
export const TILE_SIZE = 2;
export const TILES_PER_CHUNK = 16;
/** Territory zone = square block of this many chunks (mirror of wilder-protocol). */
export const REGION_CHUNKS = 2;

export type TileKind =
  | "Road"
  | "RoadLine"
  | "Sidewalk"
  | "Plaza"
  | "Building"
  | "Park"
  | "Water";

export interface Appearance {
  body: number;
  tint: number;
}

export interface CharacterSummary {
  id: string;
  name: string;
  appearance: Appearance;
  level: number;
}

export interface Character {
  id: string;
  account_id: string;
  name: string;
  appearance: Appearance;
  position: Vec3;
  yaw: number;
  level: number;
  /** Progress into the current level (resets each level-up). */
  xp: number;
  health: number;
  max_health: number;
  /** Energy shield granted by equipped armor. Absorbs damage before health. */
  shield: number;
  max_shield: number;
}

/** Active player abilities (hotbar Q/E/R), resolved server-side. */
export type AbilityKind = "Shockwave" | "Stim" | "Overcharge";

export const ABILITIES: AbilityKind[] = ["Shockwave", "Stim", "Overcharge"];

export type ItemKind =
  | "Medkit"
  | "Flashlight"
  | "Pipe"
  | "Knife"
  | "Pistol"
  | "Smg"
  | "JacketArmor"
  | "PlateArmor"
  | "Ammo9mm"
  | "Iron"
  | "Copper"
  | "Chemicals"
  | "Electronics"
  | "Biomass"
  | "SteelPlate"
  | "CopperWire"
  | "Polymer"
  | "CircuitBoard"
  | "BioGel"
  | "BlueprintFragment"
  | "PowerCell"
  | "Cash";

export interface ItemStack {
  kind: ItemKind;
  count: number;
}

export interface Inventory {
  slots: (ItemStack | null)[];
  /** Weapon 1 equip slot. */
  equipped_weapon: ItemKind | null;
  /** Weapon 2 equip slot. */
  equipped_weapon2: ItemKind | null;
  /** Which weapon slot is in hand: 0 = Weapon 1, 1 = Weapon 2. */
  active_weapon: number;
  equipped_armor: ItemKind | null;
}

export type EntityKind =
  | "Player"
  | "Npc"
  | "LootContainer"
  | "ExtractionPoint"
  | "ResourceNode"
  | "Building"
  | "Refinery"
  | "Factory"
  | "Laboratory"
  | "MarketTerminal"
  | "Armory"
  | "Bank"
  | "Bodega"
  | "Dealership"
  | "Safehouse";

/** Resource-bias zone around the spawn district. */
export type ZoneKind =
  | "BlownUp"
  | "Mining"
  | "Industrial"
  | "TechRuins"
  | "Overgrowth"
  | "ChemPlant"
  | "Scrapyard"
  | "Mixed";

export type AnimState =
  | "Idle"
  | "Walk"
  | "Run"
  | "Attack"
  | "Death"
  | "Gather"
  | "Roll"
  | "Crouch"
  | "CrouchWalk";

export interface EntitySnapshot {
  id: number;
  position: Vec3;
  yaw: number;
  anim: AnimState;
  health_pct: number;
  /** Shield fraction (0-1 of max shield); 0 for entities without shields. */
  shield_pct: number;
}

export interface EntitySpawnData {
  id: number;
  kind: EntityKind;
  name: string;
  appearance: Appearance;
  position: Vec3;
  yaw: number;
  anim: AnimState;
  health_pct: number;
  variant: number;
  /** Loot containers: primary contained item (floating icon); null otherwise. */
  item?: ItemKind | null;
}

export interface PropInstance {
  archetype: number;
  x: number;
  z: number;
  rotation: number;
}

export interface BuildingInstance {
  archetype: number;
  tx0: number;
  tz0: number;
  tx1: number;
  tz1: number;
  stories: number;
  style: number;
}

export interface ChunkData {
  coord: ChunkCoord;
  tiles: TileKind[];
  buildings: BuildingInstance[];
  props: PropInstance[];
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

type Tagged<T extends string, D> = { t: T; d: D };
type TaggedUnit<T extends string> = { t: T };

export type InventoryActionMsg =
  | Tagged<"MoveSlot", { from: number; to: number }>
  | Tagged<"Equip", { slot: number; weapon_slot?: number | null }>
  | Tagged<"Unequip", { weapon: boolean; weapon_slot?: number | null }>
  | Tagged<"SelectWeapon", { weapon_slot: number }>
  | Tagged<"Drop", { slot: number }>
  | Tagged<"Deposit", { slot: number }>
  | Tagged<"Withdraw", { stash_slot: number }>;

export type MarketActionMsg =
  | Tagged<"List", { kind: ItemKind; count: number; price_each: number }>
  | Tagged<"Buy", { listing_id: number; count: number }>
  | Tagged<"Cancel", { listing_id: number }>
  | TaggedUnit<"Refresh">;

export type VendorActionMsg =
  | Tagged<"Buy", { kind: ItemKind; count: number }>
  | Tagged<"Sell", { kind: ItemKind; count: number }>
  | Tagged<"Convert", { count: number }>
  | TaggedUnit<"Refresh">;

export type C2S =
  | Tagged<"Authenticate", { token: string }>
  | Tagged<"JoinWorld", { character_id: string }>
  | Tagged<
      "MoveInput",
      { seq: number; dx: number; dz: number; yaw: number; run: boolean }
    >
  | Tagged<"MoveTo", { seq: number; x: number; z: number }>
  | Tagged<"StopMove", { seq: number }>
  | Tagged<"Roll", { seq: number; dx: number; dz: number }>
  | Tagged<"SetCrouch", { on: boolean }>
  | Tagged<"Interact", { entity_id: number }>
  | Tagged<"InventoryAction", InventoryActionMsg>
  | Tagged<"Attack", { seq: number; tx: number; tz: number }>
  | Tagged<"UseAbility", { seq: number; ability: AbilityKind }>
  | Tagged<"UseItem", { slot: number }>
  | Tagged<"Craft", { recipe: string; station: number | null }>
  | Tagged<"QueueProduction", { building: number; recipe: string; count: number }>
  | Tagged<"Market", MarketActionMsg>
  | Tagged<"Vendor", { vendor: number; action: VendorActionMsg }>
  | Tagged<"EconomySub", { on: boolean }>
  | Tagged<"Chat", { text: string }>
  | Tagged<"Pong", { nonce: number }>;

export interface ProductionJob {
  id: number;
  recipe: string;
  count: number;
  done: number;
  /** Seconds remaining for the current unit. */
  remaining: number;
  powered: boolean;
}

export interface MarketListing {
  id: number;
  seller: string;
  kind: ItemKind;
  count: number;
  price_each: number;
}

/** One controlled region: control 1 = player-held, 2 = enemy-held. */
export interface TerritoryCell {
  rx: number;
  rz: number;
  control: number;
}

/** A vendor's price line: buy = player pays, sell = vendor pays; 0 = n/a. */
export interface VendorOffer {
  kind: ItemKind;
  buy: number;
  sell: number;
}

/** A persistent point of interest (service building) for map/legend UI. */
export interface PoiInfo {
  id: number;
  kind: EntityKind;
  name: string;
  x: number;
  z: number;
}

/** A named resource-bias zone with its label anchor (world meters). */
export interface ZoneInfo {
  kind: ZoneKind;
  name: string;
  x: number;
  z: number;
}

// ---------------------------------------------------------------------------
// Economy ledger (K dashboard)
// ---------------------------------------------------------------------------

/** One side of an economy transaction (mirror of wilder-types TxParty). */
export type TxParty =
  | Tagged<"Player", { id: string; name: string }>
  | Tagged<"Agent", { id: string; name: string }>
  | TaggedUnit<"Mint">
  | TaggedUnit<"Burn">;

/** What a transaction is denominated in. */
export type TxAmount =
  | Tagged<"Item", { kind: ItemKind; count: number }>
  | Tagged<"Wild", { amount: number }>
  | Tagged<"Blueprint", { recipe: string }>;

export type TxKind =
  | "Mint"
  | "Burn"
  | "LootPickup"
  | "Drop"
  | "VendorBuy"
  | "VendorSell"
  | "BankConvert"
  | "MarketList"
  | "MarketBuy"
  | "MarketCancel"
  | "CraftConsume"
  | "CraftProduce"
  | "Fee"
  | "Extract";

/** A ledger entry. hash/block are mock values until the chain is real. */
export interface EconTx {
  seq: number;
  hash: string;
  block: number;
  at_ms: number;
  kind: TxKind;
  from: TxParty;
  to: TxParty;
  amount: TxAmount;
  fee: number;
}

/** Live supply counters for one item kind. */
export interface ItemSupply {
  kind: ItemKind;
  minted: number;
  burned: number;
}

/** Aggregate economy snapshot pushed to dashboard subscribers. */
export interface EconomyStats {
  block: number;
  tx_count: number;
  wild_minted: number;
  wild_burned: number;
  wild_circulating: number;
  wild_agent_held: number;
  items: ItemSupply[];
  blueprints_learned: number;
  players_online: number;
  agents_alive: number;
  deaths: number;
  npc_kills: number;
  trades: number;
}

export type CombatEvent =
  | Tagged<
      "Hit",
      { attacker: number; target: number; damage: number; x: number; y: number; z: number }
    >
  | Tagged<"Miss", { attacker: number; x: number; z: number }>
  | Tagged<"MuzzleFlash", { attacker: number; tx: number; tz: number }>
  | Tagged<"EntityDied", { id: number }>
  | Tagged<"Shockwave", { source: number }>;

export type S2C =
  | Tagged<"AuthResult", { ok: boolean; error: string | null }>
  | Tagged<
      "WorldJoined",
      {
        entity_id: number;
        character: Character;
        inventory: Inventory;
        server_tick: number;
        world_seed: number;
      }
    >
  | Tagged<"ChunkData", ChunkData>
  | Tagged<"ChunkUnload", { coord: ChunkCoord }>
  | Tagged<"EntitySpawn", EntitySpawnData>
  | Tagged<
      "Snapshot",
      { server_tick: number; last_input_seq: number; entities: EntitySnapshot[] }
    >
  | Tagged<"EntityDespawn", { id: number }>
  | Tagged<"InventoryUpdate", Inventory>
  | Tagged<"StashUpdate", { slots: (ItemStack | null)[] }>
  | Tagged<"CombatEvent", CombatEvent>
  | Tagged<
      "XpUpdate",
      { xp: number; level: number; next_level_xp: number; gained: number }
    >
  | Tagged<
      "AbilityUpdate",
      { ability: AbilityKind; cooldown: number; active: number }
    >
  | Tagged<"Died", { by: string | null; lost_items: boolean }>
  | Tagged<"ExtractStart", { seconds: number }>
  | TaggedUnit<"ExtractCancel">
  | Tagged<"ExtractResult", { success: boolean; banked: ItemStack[] }>
  | Tagged<"GatherResult", { gained: ItemStack[]; denied: boolean }>
  | Tagged<
      "CraftResult",
      { ok: boolean; error: string | null; produced: ItemStack | null }
    >
  | Tagged<"ProductionState", { building: number; jobs: ProductionJob[] }>
  | Tagged<"MarketState", { listings: MarketListing[]; wallet: number }>
  | Tagged<"MarketResult", { ok: boolean; error: string | null }>
  | Tagged<
      "VendorState",
      { vendor: number; kind: EntityKind; offers: VendorOffer[]; wallet: number }
    >
  | Tagged<"VendorResult", { ok: boolean; error: string | null }>
  | Tagged<"PoiList", { pois: PoiInfo[]; zones: ZoneInfo[] }>
  | Tagged<"TerritoryState", { cells: TerritoryCell[] }>
  | Tagged<"BlueprintsUpdate", { known: string[] }>
  | Tagged<"EconomyState", { stats: EconomyStats; recent: EconTx[] }>
  | Tagged<"EconomyTxs", { txs: EconTx[]; stats: EconomyStats }>
  | Tagged<"Chat", { from: string; text: string }>
  | Tagged<"Ping", { nonce: number }>
  | Tagged<"Error", { message: string }>;

export function encode(msg: C2S): string {
  return JSON.stringify(msg);
}

export function decode(text: string): S2C {
  return JSON.parse(text) as S2C;
}
