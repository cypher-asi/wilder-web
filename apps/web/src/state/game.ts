// Game runtime state.
//
// Two layers:
//  - `game` (module singleton): mutable per-frame data read by R3F (entity
//    transforms, snapshot buffers, chunk store). Not reactive on purpose.
//  - `useGame` (zustand): UI-reactive state (inventory, chat, connection).

import { create } from "zustand";
import { ChunkStore } from "../game/collision";
import {
  AnimState,
  EntityKind,
  EntitySpawnData,
  Inventory,
  ItemStack,
  MarketListing,
  ProductionJob,
  Vec3,
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
  tint: number;
  healthPct: number;
  /** ms timestamp of the last combat hit taken (drives health bar reveal). */
  lastHitAt: number;
  /** Interpolation buffer of recent server samples. */
  samples: RemoteSample[];
  /** Current render transform (written by interpolation/prediction). */
  x: number;
  y: number;
  z: number;
  yaw: number;
  anim: AnimState;
}

export interface PendingInput {
  seq: number;
  dx: number;
  dz: number;
  run: boolean;
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
  | { type: "death"; x: number; y: number; z: number; at: number };

/** Non-reactive game world (read from useFrame). */
export const game = {
  chunks: new ChunkStore(),
  entities: new Map<number, GameEntity>(),
  localEntityId: 0,
  worldSeed: 0,
  /** Local prediction state. */
  predicted: { x: 0, z: 0, yaw: 0 },
  pendingInputs: [] as PendingInput[],
  nextSeq: 1,
  /** ms timestamp of the last direct (WASD) input; used to pick predict vs follow. */
  lastDirectInputAt: 0,
  /** Click-to-move marker (world position + time set). */
  moveMarker: null as { x: number; z: number; at: number } | null,
  /** Mouse aim: cursor projected onto the ground plane (twin-stick facing). */
  aim: { x: 0, z: 0, yaw: 0, active: false },
  /** Pending combat FX events (drained each frame by CombatFx). */
  fx: [] as CombatFxEvent[],
  /** Active connection sender (set by GameConnection.connect). */
  send: null as ((msg: import("../net/protocol").C2S) => void) | null,

  reset() {
    this.chunks.clear();
    this.entities.clear();
    this.localEntityId = 0;
    this.pendingInputs = [];
    this.nextSeq = 1;
    this.moveMarker = null;
    this.aim.active = false;
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
    tint: data.appearance?.tint ?? 0xffffff,
    healthPct: data.health_pct,
    lastHitAt: 0,
    samples: [],
    x: data.position[0],
    y: data.position[1],
    z: data.position[2],
    yaw: data.yaw,
    anim: data.anim,
  };
  game.entities.set(data.id, entity);
  return entity;
}

export interface ChatLine {
  from: string;
  text: string;
  system?: boolean;
}

interface UiState {
  connected: boolean;
  joined: boolean;
  characterName: string;
  health: number;
  maxHealth: number;
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
  /** Fullscreen city map overlay (M key). */
  mapOpen: boolean;

  set: (partial: Partial<UiState>) => void;
  pushChat: (line: ChatLine) => void;
  toggleInventory: () => void;
  toggleMap: () => void;
}

export const useGame: import("zustand").UseBoundStore<
  import("zustand").StoreApi<UiState>
> = create<UiState>((set) => ({
  connected: false,
  joined: false,
  characterName: "",
  health: 100,
  maxHealth: 100,
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
  mapOpen: false,

  set: (partial) => set(partial),
  pushChat: (line) =>
    set((s) => ({ chat: [...s.chat.slice(-99), line] })),
  toggleInventory: () => set((s) => ({ inventoryOpen: !s.inventoryOpen })),
  toggleMap: () => set((s) => ({ mapOpen: !s.mapOpen })),
}));

if (typeof window !== "undefined" && import.meta.env.DEV) {
  window.__ui = useGame;
}
