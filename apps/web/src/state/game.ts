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

  reset() {
    this.chunks.clear();
    this.entities.clear();
    this.localEntityId = 0;
    this.pendingInputs = [];
    this.nextSeq = 1;
    this.moveMarker = null;
  },
};

export function spawnEntity(data: EntitySpawnData): GameEntity {
  const entity: GameEntity = {
    id: data.id,
    kind: data.kind,
    name: data.name,
    variant: data.variant,
    tint: data.appearance?.tint ?? 0xffffff,
    healthPct: data.health_pct,
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
  position: Vec3;
  inventory: Inventory | null;
  stash: (ItemStack | null)[] | null;
  inventoryOpen: boolean;
  chat: ChatLine[];
  chatOpen: boolean;
  lastError: string | null;
  /** bumped when chunk set changes (drives chunk re-render) */
  chunkVersion: number;

  set: (partial: Partial<UiState>) => void;
  pushChat: (line: ChatLine) => void;
  toggleInventory: () => void;
}

export const useGame = create<UiState>((set) => ({
  connected: false,
  joined: false,
  characterName: "",
  health: 100,
  maxHealth: 100,
  position: [0, 0, 0],
  inventory: null,
  stash: null,
  inventoryOpen: false,
  chat: [],
  chatOpen: false,
  lastError: null,
  chunkVersion: 0,

  set: (partial) => set(partial),
  pushChat: (line) =>
    set((s) => ({ chat: [...s.chat.slice(-99), line] })),
  toggleInventory: () => set((s) => ({ inventoryOpen: !s.inventoryOpen })),
}));
