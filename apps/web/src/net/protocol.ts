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
  health: number;
  max_health: number;
}

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
  | "PowerCell";

export interface ItemStack {
  kind: ItemKind;
  count: number;
}

export interface Inventory {
  slots: (ItemStack | null)[];
  equipped_weapon: ItemKind | null;
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
  | "MarketTerminal";

export type AnimState = "Idle" | "Walk" | "Run" | "Attack" | "Death" | "Gather";

export interface EntitySnapshot {
  id: number;
  position: Vec3;
  yaw: number;
  anim: AnimState;
  health_pct: number;
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
  | Tagged<"Equip", { slot: number }>
  | Tagged<"Unequip", { weapon: boolean }>
  | Tagged<"Drop", { slot: number }>
  | Tagged<"Deposit", { slot: number }>
  | Tagged<"Withdraw", { stash_slot: number }>;

export type C2S =
  | Tagged<"Authenticate", { token: string }>
  | Tagged<"JoinWorld", { character_id: string }>
  | Tagged<"MoveInput", { seq: number; dx: number; dz: number; run: boolean }>
  | Tagged<"MoveTo", { seq: number; x: number; z: number }>
  | Tagged<"StopMove", { seq: number }>
  | Tagged<"Interact", { entity_id: number }>
  | Tagged<"InventoryAction", InventoryActionMsg>
  | Tagged<"Attack", { seq: number; tx: number; tz: number }>
  | Tagged<"UseItem", { slot: number }>
  | Tagged<"Craft", { recipe: string; station: number | null }>
  | Tagged<"QueueProduction", { building: number; recipe: string; count: number }>
  | Tagged<"Chat", { text: string }>
  | Tagged<"Pong", { nonce: number }>;

export type CombatEvent =
  | Tagged<"Hit", { attacker: number; target: number; damage: number }>
  | Tagged<"Miss", { attacker: number }>
  | Tagged<"MuzzleFlash", { attacker: number; tx: number; tz: number }>
  | Tagged<"EntityDied", { id: number }>;

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
  | Tagged<"Died", { by: string | null; lost_items: boolean }>
  | Tagged<"ExtractStart", { seconds: number }>
  | TaggedUnit<"ExtractCancel">
  | Tagged<"ExtractResult", { success: boolean; banked: ItemStack[] }>
  | Tagged<"GatherResult", { gained: ItemStack | null }>
  | Tagged<
      "CraftResult",
      { ok: boolean; error: string | null; produced: ItemStack | null }
    >
  | Tagged<"Chat", { from: string; text: string }>
  | Tagged<"Ping", { nonce: number }>
  | Tagged<"Error", { message: string }>;

export function encode(msg: C2S): string {
  return JSON.stringify(msg);
}

export function decode(text: string): S2C {
  return JSON.parse(text) as S2C;
}
