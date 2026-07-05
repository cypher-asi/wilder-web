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
/**
 * How far a building's storefront ground floor is rendered proud of its
 * footprint lot line, toward the street (-z face). Collision blocks this band
 * so the player disc stops flush with the visual wall. Must match `proud` in
 * render/building.ts and BUILDING_FRONT_PROUD in crates/wilder-physics.
 */
export const BUILDING_FRONT_PROUD = 0.3;
/** Territory zone = square block of this many chunks (mirror of wilder-protocol). */
export const REGION_CHUNKS = 2;

// ---------------------------------------------------------------------------
// Factions (mirror of wilder-types)
// ---------------------------------------------------------------------------

/** Faction identity (u8). Factions are data: see FactionInfo registry. */
export type FactionId = number;
export const FACTION_NEUTRAL: FactionId = 0;
export const FACTION_REBELS: FactionId = 1;
export const FACTION_FORUM: FactionId = 2;

/** One faction's registry entry, sent in PoiList on join. */
export interface FactionInfo {
  id: FactionId;
  name: string;
  tagline: string;
  /** Faction color (RGB packed). */
  color: number;
  /** Factions this one attacks on sight (symmetric). */
  hostile_to: FactionId[];
}

/**
 * Per-district combat/capture intensity:
 * Sanctuary = no combat/capture; Guarded = home turf, no capture, outsider
 * aggression blocked; Contested = full faction war; Warzone = frontier with
 * boosted yields.
 */
export type DangerLevel = "Sanctuary" | "Guarded" | "Contested" | "Warzone";

/** A named neighborhood: label anchor, danger level, home faction. */
export interface DistrictInfo {
  name: string;
  x: number;
  z: number;
  danger: DangerLevel;
  home_faction: FactionId;
}

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
  /** Chosen faction (optional for older gateways; treat missing as Rebels). */
  faction?: FactionId;
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
  /** Faction allegiance (players default to Rebels). */
  faction: FactionId;
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
  | "Agent"
  | "LootContainer"
  | "CurrencyPickup"
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
  | "Hit"
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
  /** Faction allegiance (drives tint/nameplate/hostility). */
  faction: FactionId;
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
  | Tagged<"Destroy", { slot: number }>
  | Tagged<"Deposit", { slot: number }>
  | Tagged<"Withdraw", { stash_slot: number }>;

// ---------------------------------------------------------------------------
// Exchange (order-book spot market)
// ---------------------------------------------------------------------------

/**
 * One tradeable exchange asset: every item kind plus the Shards and Energy
 * currencies. WILD is the quote currency and is never an asset.
 */
export type AssetMsg =
  | Tagged<"Item", ItemKind>
  | TaggedUnit<"Shards">
  | TaggedUnit<"Energy">;

/** Order side: Bid buys the asset with MILD, Ask sells it. */
export type SideMsg = "Bid" | "Ask";

/**
 * Order pricing: limit orders carry a WILD-per-unit price and may rest on
 * the book; market orders take whatever the book offers (IOC).
 */
export type OrderKindMsg = Tagged<"Limit", { price: number }> | TaggedUnit<"Market">;

/** One (venue, asset) order book — the BookSub target. */
export interface BookTarget {
  venue: number;
  asset: AssetMsg;
}

export type ExchangeActionMsg =
  | Tagged<
      "Place",
      {
        venue: number;
        asset: AssetMsg;
        side: SideMsg;
        order: OrderKindMsg;
        qty: number;
        /** MILD budget for market bids (required there, ignored elsewhere). */
        max_spend: number | null;
      }
    >
  | Tagged<"Cancel", { order_id: number }>
  | Tagged<"Claim", { venue: number }>;

/** A bankable currency (at-risk when carried, safe when banked). */
export type Currency = "Mild" | "Shards" | "Energy";

export type VendorActionMsg =
  | Tagged<"Buy", { kind: ItemKind; count: number }>
  | Tagged<"Sell", { kind: ItemKind; count: number }>
  | Tagged<"Convert", { count: number }>
  | Tagged<"Deposit", { currency: Currency; amount: number }>
  | Tagged<"Withdraw", { currency: Currency; amount: number }>
  | TaggedUnit<"Refresh">;

export type C2S =
  | Tagged<"Authenticate", { token: string }>
  | Tagged<"JoinWorld", { character_id: string; spectate?: boolean }>
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
  | Tagged<"CollectProduction", { building: number }>
  | Tagged<"CancelProduction", { building: number; job_id: number }>
  | Tagged<"Exchange", ExchangeActionMsg>
  | Tagged<"MarketsSub", { on: boolean }>
  | Tagged<"BookSub", { market: BookTarget | null }>
  | Tagged<"Vendor", { vendor: number; action: VendorActionMsg }>
  | Tagged<"EconomySub", { on: boolean }>
  | Tagged<"MapIntelSub", { on: boolean }>
  | Tagged<"HireAgent", { agent_id: string }>
  | Tagged<"DismissAgent", { agent_id: string }>
  | TaggedUnit<"AgentHireList">
  | Tagged<"AgentSub", { on: boolean }>
  | Tagged<"AgentDetailSub", { agent_id: string | null }>
  | Tagged<"WatchAgent", { agent_id: string | null }>
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
  /** True when this job belongs to the receiving player (cancelable). */
  mine?: boolean;
  /** Short owner label on other actors' jobs ("AGENT"/"PLAYER"). */
  owner?: string;
}

/** One markets-index row: an asset's cross-venue rollup (MarketsState). */
export interface MarketRow {
  asset: AssetMsg;
  /** Short uppercase ticker ("IRON", "SHRD", "NRG", ...). */
  ticker: string;
  /** Most recent trade price across every venue (0 = never traded). */
  last: number;
  /** 24h change in basis points (+250 = +2.50%); 0 with no reference. */
  change_24h_bp: number;
  /** 24h volume summed across venues. */
  volume_24h_wild: number;
  volume_24h_units: number;
  /** Best bid/ask across every venue's book (0 = side empty everywhere). */
  best_bid: number;
  best_ask: number;
  /** Per-venue breakdown (venues with a trade or a live book only). */
  venues: VenuePrice[];
}

/** One venue's line in a market row's arbitrage breakdown. */
export interface VenuePrice {
  venue: number;
  /** Last trade price at this venue (0 = never traded here). */
  last: number;
  best_bid: number;
  best_ask: number;
  volume_24h_wild: number;
}

/** Venue metadata: names the venue rows, anchors distance computations. */
export interface VenueInfo {
  venue: number;
  name: string;
  /** World-space anchor of the venue's Market Terminal (meters). */
  x: number;
  z: number;
}

/** Trailing 24h stats for one (venue, asset) book. */
export interface BookStatsMsg {
  /** 24h high/low (0 = no trades in the window). */
  high_24h: number;
  low_24h: number;
  volume_24h_wild: number;
  volume_24h_units: number;
  /** 24h change in basis points (see MarketRow.change_24h_bp). */
  change_24h_bp: number;
}

/** One minute OHLCV candle for the price chart. */
export interface CandleMsg {
  /** Bucket start, unix milliseconds. */
  t: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume_units: number;
  volume_wild: number;
}

/** One trade-tape print. */
export interface TapeMsg {
  /** Unix milliseconds when the fill executed. */
  t: number;
  price: number;
  qty: number;
  /** The aggressor's side: Bid prints as a buy, Ask as a sell. */
  side: SideMsg;
}

/** One of the receiving player's own exchange orders. */
export interface OrderMsg {
  id: number;
  venue: number;
  asset: AssetMsg;
  side: SideMsg;
  /** Limit price; 0 for market orders (which never rest). */
  price: number;
  qty: number;
  filled: number;
  /** Unix milliseconds when the order was placed. */
  placed_ms: number;
}

/** Un-claimed settlement contents at one venue (claim at its terminal). */
export interface InboxMsg {
  mild: number;
  assets: AssetQty[];
}

/** One asset quantity line in a settlement inbox. */
export interface AssetQty {
  asset: AssetMsg;
  qty: number;
}

/** A settlement inbox tagged with its venue (MyExchangeState). */
export interface VenueInbox {
  venue: number;
  inbox: InboxMsg;
}

/** What happened to a resting order (OrderUpdate.kind). */
export type OrderUpdateKind = "Placed" | "Filled" | "Partial" | "Cancelled";

/** Full snapshot of one (venue, asset) book (S2C BookState payload). */
export interface BookStateMsg {
  venue: number;
  asset: AssetMsg;
  /** Bid levels as [price, qty], best (highest) first, top ~20. */
  bids: [number, number][];
  /** Ask levels as [price, qty], best (lowest) first, top ~20. */
  asks: [number, number][];
  /** Most recent trade price here (0 = never traded). */
  last: number;
  stats: BookStatsMsg;
  /** Minute candles, oldest first (bounded chart window, ~3h). */
  candles: CandleMsg[];
  /** Recent prints, newest first (last ~30). */
  tape: TapeMsg[];
  /** The receiving player's open orders on THIS book only. */
  my_orders: OrderMsg[];
  /** The receiving player's settlement inbox at this venue. */
  my_inbox: InboxMsg;
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
  /** Units the vendor holds (stock-backed shelves): 0 on a buy line = sold out. */
  stock: number;
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

/**
 * One actor on the whole-map intel overlay. Coordinates are quantized to
 * whole meters (i16).
 */
export interface AgentBlip {
  id: number;
  faction: FactionId;
  /** 0 = player, 1 = agent, 2 = wild Wape. */
  kind: number;
  x: number;
  z: number;
  /**
   * Actors this blip stands for: omitted/1 for an individual, >1 for a
   * density cluster (large agent populations are aggregated server-side).
   */
  count?: number;
}

/** One leaderboard category (e.g. "Wealth", "Kills") with its ranked rows. */
export interface Board {
  category: string;
  rows: BoardRow[];
}

export interface BoardRow {
  name: string;
  faction: FactionId;
  /** Guild name; null for guildless competitors (all players for now). */
  guild: string | null;
  value: number;
}

/** Rolled-up standing for one faction. */
export interface FactionStanding {
  faction: FactionId;
  members: number;
  kills: number;
  deaths: number;
  treasury: number;
  regions_held: number;
  districts_held: number;
  /** Rolling "zone points": total cell-seconds held over the recent window. */
  zone_points: number;
}

/** One faction's rolling seconds-held in a neighborhood. */
export interface ZoneSeconds {
  faction: FactionId;
  seconds: number;
}

/** Rolling territory standing for one named neighborhood. */
export interface ZoneStanding {
  district: string;
  /** Faction holding the most cells in the neighborhood right now. */
  control: FactionId;
  /** Rolling seconds each faction has held cells here. */
  seconds: ZoneSeconds[];
}

/** Rolled-up standing for one guild (agent squad). */
export interface GuildStanding {
  name: string;
  faction: FactionId;
  members: number;
  kills: number;
  wealth: number;
}

/** Leaderboards payload: top-N boards + faction/guild standings. */
export interface LeaderboardData {
  boards: Board[];
  factions: FactionStanding[];
  guilds: GuildStanding[];
  /** Per-neighborhood territory standings (rolling zone-seconds by faction). */
  zones: ZoneStanding[];
}

// ---------------------------------------------------------------------------
// Economy ledger (K dashboard)
// ---------------------------------------------------------------------------

/** One side of an economy transaction (mirror of wilder-types TxParty). */
export type TxParty =
  | Tagged<"Player", { id: string; name: string; faction: FactionId }>
  | Tagged<"Agent", { id: string; name: string; faction: FactionId }>
  | TaggedUnit<"Mint">
  | TaggedUnit<"Burn">;

/** What a transaction is denominated in. */
export type TxAmount =
  | Tagged<"Item", { kind: ItemKind; count: number }>
  | Tagged<"Wild", { amount: number }>
  | Tagged<"Shards", { amount: number }>
  | Tagged<"Energy", { amount: number }>
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
  | "Extract"
  | "AgentHire"
  | "OwnerShare";

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
  shards_minted: number;
  shards_burned: number;
  energy_minted: number;
  energy_burned: number;
  items: ItemSupply[];
  blueprints_learned: number;
  players_online: number;
  agents_alive: number;
  deaths: number;
  npc_kills: number;
  trades: number;
}

// ---------------------------------------------------------------------------
// Owned agents (hire/dismiss + roster/detail subscriptions)
// ---------------------------------------------------------------------------

/**
 * One agent's roster line (mirror of wilder-protocol AgentSummary).
 * hire_cost is only filled on AgentHireOffers candidates.
 */
export interface AgentSummary {
  agent_id: string;
  /** Live replicated entity id of this agent's body (fresh per respawn). */
  entity_id: number;
  name: string;
  faction: FactionId;
  guild: string;
  /** Label of the dominant learned activity ("Trader", "Scavenger", ...). */
  archetype: string;
  /** Short human label of the current goal ("Gathering", "Banking", ...). */
  activity: string;
  health: number;
  max_health: number;
  x: number;
  z: number;
  carried_wild: number;
  banked_wild: number;
  /** Total MILD this agent has paid its owner (15% bank-deposit share). */
  lifetime_owner_earnings: number;
  /** MILD to hire this agent (only set on AgentHireOffers candidates). */
  hire_cost?: number | null;
}

/** Per-identity competition counters surfaced in AgentDetail. */
export interface AgentStats {
  kills: number;
  deaths: number;
  resources: number;
  trades: number;
  crafted: number;
}

/** One line of an owned agent's live activity log. */
export interface AgentLogEntry {
  /** Unix milliseconds when the event happened. */
  at_ms: number;
  text: string;
}

/** Full drill-in view of one owned agent (AgentDetailSub). */
export interface AgentDetail {
  summary: AgentSummary;
  /** Fuller description of the current goal, including its target. */
  goal: string;
  /** Learned payoff EMA per activity, as [activity name, MILD/min] pairs. */
  traits: [string, number][];
  stats: AgentStats;
  inventory: Inventory;
  /** Known blueprint recipe ids, sorted. */
  blueprints: string[];
  /** Carried balances indexed [MILD, Shards, Energy]. */
  carried: [number, number, number];
  /** Banked balances indexed [MILD, Shards, Energy]. */
  banked: [number, number, number];
  /** Recent activity log, oldest first (ring of the last ~64 events). */
  activity_log: AgentLogEntry[];
  /** Recent ledger transactions touching this agent, newest first. */
  recent_txs: EconTx[];
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
      "WalletUpdate",
      {
        wild: number;
        bank: number;
        shards: number;
        bank_shards: number;
        energy: number;
        bank_energy: number;
      }
    >
  | Tagged<
      "AbilityUpdate",
      { ability: AbilityKind; cooldown: number; active: number }
    >
  | Tagged<"Died", { by: string | null; lost_items: boolean }>
  | Tagged<"GatherResult", { gained: ItemStack[]; denied: boolean }>
  | Tagged<
      "CraftResult",
      { ok: boolean; error: string | null; produced: ItemStack | null }
    >
  | Tagged<
      "ProductionState",
      {
        building: number;
        jobs: ProductionJob[];
        buffered?: ItemStack[];
        /** Building energy throughput cap (max summed running job energy). */
        energy_cap?: number;
        /** Summed energy of currently powered jobs. */
        energy_used?: number;
      }
    >
  | Tagged<"MarketsState", { rows: MarketRow[]; venues: VenueInfo[] }>
  | Tagged<"BookState", BookStateMsg>
  | Tagged<"OrderResult", { ok: boolean; error: string | null }>
  | Tagged<
      "OrderUpdate",
      {
        order_id: number;
        kind: OrderUpdateKind;
        /** Execution price/units of the fill that triggered this (fills only). */
        fill_price: number | null;
        fill_qty: number | null;
      }
    >
  | Tagged<"MyExchangeState", { orders: OrderMsg[]; inboxes: VenueInbox[] }>
  | Tagged<
      "VendorState",
      {
        vendor: number;
        kind: EntityKind;
        offers: VendorOffer[];
        wallet: number;
        bank: number;
        shards: number;
        bank_shards: number;
        energy: number;
        bank_energy: number;
      }
    >
  | Tagged<"VendorResult", { ok: boolean; error: string | null }>
  | Tagged<
      "PoiList",
      {
        pois: PoiInfo[];
        zones: ZoneInfo[];
        factions: FactionInfo[];
        districts: DistrictInfo[];
      }
    >
  | Tagged<"TerritoryState", { cells: TerritoryCell[]; districts: FactionId[] }>
  | Tagged<"BlueprintsUpdate", { known: string[] }>
  | Tagged<"EconomyState", { stats: EconomyStats; recent: EconTx[] }>
  | Tagged<"EconomyTxs", { txs: EconTx[]; stats: EconomyStats }>
  | Tagged<"MapIntel", { blips: AgentBlip[] }>
  | Tagged<"MapCensus", { blips: AgentBlip[] }>
  | Tagged<"AgentDots", { blips: AgentBlip[] }>
  | Tagged<"AgentRoster", { agents: AgentSummary[] }>
  | Tagged<"AgentDetail", AgentDetail>
  | Tagged<"AgentHireOffers", { offers: AgentSummary[] }>
  | Tagged<"AgentResult", { ok: boolean; error: string | null }>
  | Tagged<"LeaderboardState", LeaderboardData>
  | Tagged<"Chat", { from: string; text: string }>
  | Tagged<"Ping", { nonce: number }>
  | Tagged<"Error", { message: string }>;

export function encode(msg: C2S): string {
  return JSON.stringify(msg);
}

export function decode(text: string): S2C {
  return JSON.parse(text) as S2C;
}

// ---------------------------------------------------------------------------
// Binary frames for the hot per-tick messages
// ---------------------------------------------------------------------------
//
// Snapshot (20 Hz) and MapIntel (~1 Hz whole map) arrive as compact
// little-endian binary WebSocket frames; everything else stays JSON text.
// Layouts mirror `encode_binary` in `shared/wilder-protocol/src/lib.rs` and
// must stay in sync with it.

/** Animation states by wire code (must match `anim_code` on the server). */
const BIN_ANIMS: AnimState[] = [
  "Idle",
  "Walk",
  "Run",
  "Attack",
  "Hit",
  "Death",
  "Gather",
  "Roll",
  "Crouch",
  "CrouchWalk",
];

/** Bytes per entity in a binary Snapshot. */
const SNAP_ENTITY_BYTES = 25;
/** Bytes per blip in a binary MapIntel. */
const INTEL_BLIP_BYTES = 16;
/** Bytes per blip in a binary MapCensus (u8 faction, u8 kind, i16 x/z). */
const CENSUS_BLIP_BYTES = 6;

/** Entity/blip ids fit in 2^53, so two u32 reads beat BigInt conversion. */
function readId(view: DataView, offset: number): number {
  return view.getUint32(offset + 4, true) * 0x1_0000_0000 + view.getUint32(offset, true);
}

/**
 * Decode a binary server frame into the same message shape as the JSON
 * path, or null for an unknown tag. Positions arrive as centimeter i32s and
 * yaw as centiradian i16 (the server quantizes to that anyway).
 */
export function decodeBinary(buf: ArrayBuffer): S2C | null {
  const view = new DataView(buf);
  const tag = view.getUint8(0);
  if (tag === 1) {
    // Snapshot: u64 tick, u32 input ack, u32 count, then packed entities.
    const server_tick = Number(view.getBigUint64(1, true));
    const last_input_seq = view.getUint32(9, true);
    const count = view.getUint32(13, true);
    const entities: EntitySnapshot[] = new Array(count);
    let o = 17;
    for (let i = 0; i < count; i++) {
      entities[i] = {
        id: readId(view, o),
        position: [
          view.getInt32(o + 8, true) / 100,
          view.getInt32(o + 12, true) / 100,
          view.getInt32(o + 16, true) / 100,
        ],
        yaw: view.getInt16(o + 20, true) / 100,
        anim: BIN_ANIMS[view.getUint8(o + 22)] ?? "Idle",
        health_pct: view.getUint8(o + 23) / 255,
        shield_pct: view.getUint8(o + 24) / 255,
      };
      o += SNAP_ENTITY_BYTES;
    }
    return { t: "Snapshot", d: { server_tick, last_input_seq, entities } };
  }
  if (tag === 2) {
    // MapIntel: u32 count, then packed blips.
    const count = view.getUint32(1, true);
    const blips: AgentBlip[] = new Array(count);
    let o = 5;
    for (let i = 0; i < count; i++) {
      blips[i] = {
        id: readId(view, o),
        faction: view.getUint8(o + 8),
        kind: view.getUint8(o + 9),
        x: view.getInt16(o + 10, true),
        z: view.getInt16(o + 12, true),
        count: view.getUint16(o + 14, true),
      };
      o += INTEL_BLIP_BYTES;
    }
    return { t: "MapIntel", d: { blips } };
  }
  if (tag === 3) {
    // MapCensus: u32 count, then packed static blips (no id/count on wire).
    const count = view.getUint32(1, true);
    const blips: AgentBlip[] = new Array(count);
    let o = 5;
    for (let i = 0; i < count; i++) {
      blips[i] = {
        id: 0,
        faction: view.getUint8(o),
        kind: view.getUint8(o + 1),
        x: view.getInt16(o + 2, true),
        z: view.getInt16(o + 4, true),
        count: 1,
      };
      o += CENSUS_BLIP_BYTES;
    }
    return { t: "MapCensus", d: { blips } };
  }
  if (tag === 4) {
    // AgentDots: same compact static layout as MapCensus (no id/count).
    const count = view.getUint32(1, true);
    const blips: AgentBlip[] = new Array(count);
    let o = 5;
    for (let i = 0; i < count; i++) {
      blips[i] = {
        id: 0,
        faction: view.getUint8(o),
        kind: view.getUint8(o + 1),
        x: view.getInt16(o + 2, true),
        z: view.getInt16(o + 4, true),
        count: 1,
      };
      o += CENSUS_BLIP_BYTES;
    }
    return { t: "AgentDots", d: { blips } };
  }
  return null;
}
