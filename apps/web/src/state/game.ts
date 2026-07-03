// Game runtime state.
//
// Two layers:
//  - `game` (module singleton): mutable per-frame data read by R3F (entity
//    transforms, snapshot buffers, chunk store). Not reactive on purpose.
//  - `useGame` (zustand): UI-reactive state (inventory, chat, connection).

import { create } from "zustand";
import { setMusicEnabled } from "../assets/audio";
import { ChunkStore } from "../game/collision";
import { VISUAL_STYLE_IDS, type VisualStyleId } from "../render/styles";
import {
  AbilityKind,
  AnimState,
  EconTx,
  EconomyStats,
  EntityKind,
  EntitySpawnData,
  Inventory,
  ItemKind,
  ItemStack,
  MarketListing,
  PoiInfo,
  ProductionJob,
  Vec3,
  VendorOffer,
  ZoneInfo,
} from "../net/protocol";

export interface RemoteSample {
  time: number; // client receive time, ms
  x: number;
  z: number;
  yaw: number;
  anim: AnimState;
}

export interface GameEntity {
  id: number;
  kind: EntityKind;
  name: string;
  variant: number;
  /** Loot containers: primary contained item (drives the floating icon). */
  item: import("../net/protocol").ItemKind | null;
  tint: number;
  healthPct: number;
  /** ms timestamp of the last combat hit taken (drives health bar reveal). */
  lastHitAt: number;
  /** ms timestamp of the last hit taken (drives flinch anim + red flash). */
  hitReactAt: number;
  /** ms timestamp of this entity's last ranged shot (drives remote shoot anim). */
  lastShotAt: number;
  /** Interpolation buffer of recent server samples. */
  samples: RemoteSample[];
  /** Current render transform (written by interpolation/prediction). */
  x: number;
  y: number;
  z: number;
  yaw: number;
  anim: AnimState;
  /** Smoothed world-space XZ velocity (m/s), drives directional locomotion. */
  vx: number;
  vz: number;
}

export interface PendingInput {
  seq: number;
  dx: number;
  dz: number;
  /** Speed used for local prediction (run/walk/crouch), for replay. */
  speed: number;
  dt: number;
}

/** Short-lived combat visual events, consumed by the CombatFx renderer. */
export type CombatFxEvent =
  | {
      type: "tracer";
      fx: number;
      fy: number;
      fz: number;
      tx: number;
      ty: number;
      tz: number;
      at: number;
    }
  | { type: "hit"; x: number; y: number; z: number; damage: number; at: number }
  | { type: "death"; x: number; y: number; z: number; at: number }
  | { type: "shockwave"; x: number; y: number; z: number; at: number }
  | { type: "flash"; x: number; y: number; z: number; yaw: number; at: number }
  | {
      type: "impact";
      x: number;
      y: number;
      z: number;
      /** Incoming shot direction on XZ (sparks fly back along it). */
      dirX: number;
      dirZ: number;
      kind: "flesh" | "dust";
      at: number;
    }
  | {
      type: "shell";
      x: number;
      y: number;
      z: number;
      /** Ejection direction on XZ (shooter's right side). */
      dirX: number;
      dirZ: number;
      at: number;
    }
  | {
      type: "lootPop";
      x: number;
      y: number;
      z: number;
      /** Icon that pops out of the collected crate (null: sparkle only). */
      item: import("../net/protocol").ItemKind | null;
      at: number;
    };

/** Weapon mount registered per character entity (muzzle FX + recoil kick). */
export interface GunMount {
  /** Group parented to the hand bone (kicked on recoil). */
  holder: import("three").Group;
  /** Empty at the barrel tip; world position used for flash/tracer origin. */
  muzzle: import("three").Object3D;
}

/** Non-reactive game world (read from useFrame). */
export const game = {
  chunks: new ChunkStore(),
  entities: new Map<number, GameEntity>(),
  localEntityId: 0,
  worldSeed: 0,
  /** Local prediction state (advances in discrete 20 Hz sim steps). */
  predicted: { x: 0, z: 0, yaw: 0 },
  /**
   * Per-frame smoothed copy of `predicted` used for everything visual (mesh,
   * aim ring, camera target); keeps the 20 Hz sim from stepping on screen.
   */
  rendered: { x: 0, z: 0, yaw: 0 },
  /** Live WASD state this frame (drives the local player's anim locally). */
  input: { moving: false, run: false, dx: 0, dz: 0 },
  pendingInputs: [] as PendingInput[],
  nextSeq: 1,
  /** ms timestamp of the last direct (WASD) input; used to pick predict vs follow. */
  lastDirectInputAt: 0,
  /** Click-to-move marker (world position + time set). */
  moveMarker: null as { x: number; z: number; at: number } | null,
  /** Mouse aim: cursor projected onto the ground plane (twin-stick facing). */
  aim: { x: 0, z: 0, yaw: 0, active: false },
  /** Raw cursor in normalized device coords (drives on-target reticle placement). */
  pointer: { ndcX: 0, ndcY: 0, inside: false },
  /** Entity id of the enemy currently under the cursor (soft target lock). */
  hoverTargetId: null as number | null,
  /** Gun mounts (muzzle + recoil holder) keyed by character entity id. */
  gunMounts: new Map<number, GunMount>(),
  /** Crouch toggle (mirrored to the server via SetCrouch). */
  crouching: false,
  /** Active dodge roll (local prediction; matches the server dash). */
  roll: null as { until: number; dx: number; dz: number } | null,
  /** ms timestamp when the next roll is allowed. */
  rollReadyAt: 0,
  /** Gun draw state: LMB draws first, then shoots; auto-holsters when idle. */
  gun: { drawn: false, readyAt: 0, lastShotAt: 0, shotSeq: 0 },
  /** Pending combat FX events (drained each frame by CombatFx). */
  fx: [] as CombatFxEvent[],
  /** Active connection sender (set by GameConnection.connect). */
  send: null as ((msg: import("../net/protocol").C2S) => void) | null,

  reset() {
    this.chunks.clear();
    this.entities.clear();
    bumpEntityRoster();
    this.localEntityId = 0;
    this.input.moving = false;
    this.input.run = false;
    this.input.dx = 0;
    this.input.dz = 0;
    this.pendingInputs = [];
    this.nextSeq = 1;
    this.moveMarker = null;
    this.aim.active = false;
    this.pointer.inside = false;
    this.hoverTargetId = null;
    this.gunMounts.clear();
    this.crouching = false;
    this.roll = null;
    this.rollReadyAt = 0;
    this.gun = { drawn: false, readyAt: 0, lastShotAt: 0, shotSeq: 0 };
    this.fx = [];
    // Note: `send` is intentionally preserved; it is replaced on reconnect.
  },
};

// Debug handle for development tooling.
declare global {
  interface Window {
    __game?: typeof game;
    __ui?: unknown;
  }
}
if (typeof window !== "undefined" && import.meta.env.DEV) {
  window.__game = game;
}

export function spawnEntity(data: EntitySpawnData): GameEntity {
  const entity: GameEntity = {
    id: data.id,
    kind: data.kind,
    name: data.name,
    variant: data.variant,
    item: data.item ?? null,
    tint: data.appearance?.tint ?? 0xffffff,
    healthPct: data.health_pct,
    lastHitAt: 0,
    hitReactAt: 0,
    lastShotAt: 0,
    samples: [],
    x: data.position[0],
    y: data.position[1],
    z: data.position[2],
    yaw: data.yaw,
    anim: data.anim,
    vx: 0,
    vz: 0,
  };
  game.entities.set(data.id, entity);
  bumpEntityRoster();
  return entity;
}

// ---------------------------------------------------------------------------
// Entity roster signal: `game.entities` is intentionally non-reactive, but the
// Entities renderer needs to mount/unmount views the moment spawns/despawns
// arrive (a polling interval adds up to its period in visible latency).
// Minimal external-store contract for useSyncExternalStore.
// ---------------------------------------------------------------------------

let entityRosterVersion = 0;
const entityRosterListeners = new Set<() => void>();

export function bumpEntityRoster(): void {
  entityRosterVersion++;
  for (const listener of entityRosterListeners) listener();
}

export function subscribeEntityRoster(listener: () => void): () => void {
  entityRosterListeners.add(listener);
  return () => entityRosterListeners.delete(listener);
}

export function getEntityRosterVersion(): number {
  return entityRosterVersion;
}

export interface ChatLine {
  from: string;
  text: string;
  system?: boolean;
}

/** One line in the left-side pickup feed ("+3 Iron", "Backpack full"). */
export interface PickupFeedEntry {
  id: number;
  /** Item glyph to show; null for text-only notices (e.g. denial). */
  kind: import("../net/protocol").ItemKind | null;
  text: string;
  /** Alert styling + deny semantics (red, no glyph pop). */
  alert?: boolean;
}

let nextPickupId = 1;

/** Per-ability hotbar state (ms timestamps from performance.now()). */
export interface AbilityUiState {
  /** When the ability comes off cooldown. */
  readyAt: number;
  /** Full cooldown length (seconds) for the sweep animation. */
  cooldown: number;
  /** When the active effect (buff) ends; 0 when instant/inactive. */
  activeUntil: number;
}

/** Item kinds usable from the consumable hotbar (sent as UseItem). */
export const CONSUMABLE_KINDS: import("../net/protocol").ItemKind[] = ["Medkit"];

/**
 * Map inventory contents to the 4 consumable hotbar slots (keys 1-4): first
 * occurrence of each consumable kind, in inventory order.
 */
export function consumableHotbar(
  inv: Inventory | null,
): ({ slot: number; stack: ItemStack } | null)[] {
  const out: ({ slot: number; stack: ItemStack } | null)[] = [null, null, null, null];
  if (!inv) return out;
  let i = 0;
  const seen = new Set<string>();
  inv.slots.forEach((stack, slot) => {
    if (i >= 4 || !stack || !CONSUMABLE_KINDS.includes(stack.kind) || seen.has(stack.kind))
      return;
    seen.add(stack.kind);
    out[i++] = { slot, stack };
  });
  return out;
}

/** The weapon currently in hand (per `active_weapon`), or null for fists. */
export function activeWeaponKind(inv: Inventory | null): ItemKind | null {
  if (!inv) return null;
  return inv.active_weapon === 1 ? inv.equipped_weapon2 : inv.equipped_weapon;
}

/** Both weapon equip slots in order (Weapon 1, Weapon 2). */
export function equippedWeapons(inv: Inventory | null): (ItemKind | null)[] {
  return [inv?.equipped_weapon ?? null, inv?.equipped_weapon2 ?? null];
}

/** Client mirror of wilder-combat::armor_shield (shield capacity per armor). */
export function armorShield(armor: import("../net/protocol").ItemKind | null): number {
  if (armor === "JacketArmor") return 25;
  if (armor === "PlateArmor") return 50;
  return 0;
}

export const initialAbilities = (): Record<AbilityKind, AbilityUiState> => ({
  Shockwave: { readyAt: 0, cooldown: 0, activeUntil: 0 },
  Stim: { readyAt: 0, cooldown: 0, activeUntil: 0 },
  Overcharge: { readyAt: 0, cooldown: 0, activeUntil: 0 },
});

interface UiState {
  connected: boolean;
  joined: boolean;
  /** First chunk reveal flush happened; the world has visible ground. */
  worldReady: boolean;
  characterName: string;
  health: number;
  maxHealth: number;
  /** Energy shield from equipped armor (absorbs damage before health). */
  shield: number;
  maxShield: number;
  /** Ability cooldowns / active buffs (server-authoritative). */
  abilities: Record<AbilityKind, AbilityUiState>;
  level: number;
  /** XP progress into the current level. */
  xp: number;
  /** XP required to reach the next level. */
  nextLevelXp: number;
  position: Vec3;
  inventory: Inventory | null;
  stash: (ItemStack | null)[] | null;
  inventoryOpen: boolean;
  chat: ChatLine[];
  chatOpen: boolean;
  lastError: string | null;
  /** bumped when chunk set changes (drives chunk re-render) */
  chunkVersion: number;
  /** Active extraction channel (seconds total + start time). */
  extracting: { seconds: number; startedAt: number } | null;
  /** Near a stash terminal (enables deposit/withdraw UI). */
  nearStash: boolean;
  /** Nearest crafting station in interact range, if any. */
  nearStation: { kind: "Refinery" | "Factory" | "Laboratory"; id: number } | null;
  /** Crafting panel visibility (auto-closes when leaving the station). */
  craftOpen: boolean;
  /** Known blueprint recipe ids (server-authoritative). */
  blueprints: string[];
  /** Production queues per building entity id (+ receive time for interpolation). */
  production: Record<number, { jobs: ProductionJob[]; at: number }>;
  /** Market snapshot (listings + wallet), refreshed by the server. */
  market: { listings: MarketListing[]; wallet: number } | null;
  /** Near the market terminal (enables the market panel). */
  nearMarket: boolean;
  /** Market panel visibility (auto-closes when leaving the terminal). */
  marketOpen: boolean;
  /** Persistent points of interest (service buildings), sent once on join. */
  pois: PoiInfo[];
  /** Named resource-bias zones ringing the spawn district. */
  zones: ZoneInfo[];
  /** Latest vendor snapshot (offers + wallet) from the server. */
  vendor: { id: number; kind: EntityKind; offers: VendorOffer[]; wallet: number } | null;
  /** Nearest vendor building in interact range, if any. */
  nearVendor: { kind: EntityKind; id: number } | null;
  /** Vendor panel visibility (auto-closes when leaving the vendor). */
  vendorOpen: boolean;
  /** Fullscreen city map overlay (M key). */
  mapOpen: boolean;
  /** Fullscreen economy ledger dashboard (K key). */
  economyOpen: boolean;
  /** Live ledger snapshot: aggregate stats + tx feed (newest first). */
  economy: { stats: EconomyStats; feed: EconTx[] } | null;
  /** Pause/game menu overlay (Escape). */
  menuOpen: boolean;
  /** Active visual style preset (persisted to localStorage). */
  visualStyle: VisualStyleId;
  /** Main-music on/off (persisted to localStorage). */
  musicOn: boolean;
  /** Left-side pickup feed entries (newest last); expired by the HUD. */
  pickupFeed: PickupFeedEntry[];

  set: (partial: Partial<UiState>) => void;
  pushChat: (line: ChatLine) => void;
  pushPickup: (entry: Omit<PickupFeedEntry, "id">) => void;
  expirePickup: (id: number) => void;
  toggleInventory: () => void;
  toggleMap: () => void;
  toggleEconomy: () => void;
  toggleMenu: () => void;
  /** Close every overlay/panel (used when leaving the game screen). */
  closeOverlays: () => void;
  setVisualStyle: (style: VisualStyleId) => void;
  setMusicOn: (on: boolean) => void;
}

// v2: tron became the default; the key bump intentionally resets everyone's
// saved style once so the new default takes effect (picker still persists).
const STYLE_STORAGE_KEY = "wilder.visualStyle.v2";

function loadVisualStyle(): VisualStyleId {
  if (typeof localStorage !== "undefined") {
    const saved = localStorage.getItem(STYLE_STORAGE_KEY) as VisualStyleId | null;
    if (saved && VISUAL_STYLE_IDS.includes(saved)) return saved;
  }
  return "tron";
}

const MUSIC_STORAGE_KEY = "wilder.musicOn";

function loadMusicOn(): boolean {
  if (typeof localStorage !== "undefined") {
    return localStorage.getItem(MUSIC_STORAGE_KEY) !== "false";
  }
  return true;
}

export const useGame: import("zustand").UseBoundStore<
  import("zustand").StoreApi<UiState>
> = create<UiState>((set) => ({
  connected: false,
  joined: false,
  worldReady: false,
  characterName: "",
  health: 100,
  maxHealth: 100,
  shield: 0,
  maxShield: 0,
  abilities: initialAbilities(),
  level: 1,
  xp: 0,
  nextLevelXp: 100,
  position: [0, 0, 0],
  inventory: null,
  stash: null,
  inventoryOpen: false,
  chat: [],
  chatOpen: false,
  lastError: null,
  chunkVersion: 0,
  extracting: null,
  nearStash: false,
  nearStation: null,
  craftOpen: false,
  blueprints: [],
  production: {},
  market: null,
  nearMarket: false,
  marketOpen: false,
  pois: [],
  zones: [],
  vendor: null,
  nearVendor: null,
  vendorOpen: false,
  mapOpen: false,
  economyOpen: false,
  economy: null,
  menuOpen: false,
  visualStyle: loadVisualStyle(),
  musicOn: loadMusicOn(),
  pickupFeed: [],

  set: (partial) => set(partial),
  pushChat: (line) =>
    set((s) => ({ chat: [...s.chat.slice(-99), line] })),
  pushPickup: (entry) =>
    set((s) => ({
      pickupFeed: [...s.pickupFeed.slice(-5), { ...entry, id: nextPickupId++ }],
    })),
  expirePickup: (id) =>
    set((s) => ({ pickupFeed: s.pickupFeed.filter((e) => e.id !== id) })),
  toggleInventory: () => set((s) => ({ inventoryOpen: !s.inventoryOpen })),
  toggleMap: () => set((s) => ({ mapOpen: !s.mapOpen })),
  toggleEconomy: () => set((s) => ({ economyOpen: !s.economyOpen })),
  toggleMenu: () => set((s) => ({ menuOpen: !s.menuOpen })),
  closeOverlays: () =>
    set({
      menuOpen: false,
      mapOpen: false,
      economyOpen: false,
      chatOpen: false,
      inventoryOpen: false,
      craftOpen: false,
      marketOpen: false,
      vendorOpen: false,
    }),
  setVisualStyle: (style) => {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STYLE_STORAGE_KEY, style);
    }
    set({ visualStyle: style });
  },
  setMusicOn: (on) => {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(MUSIC_STORAGE_KEY, String(on));
    }
    setMusicEnabled(on);
    set({ musicOn: on });
  },
}));

if (typeof window !== "undefined" && import.meta.env.DEV) {
  window.__ui = useGame;
}
