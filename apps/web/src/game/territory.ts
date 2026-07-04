// Territory control state (mirror of the server's region grid). The server
// broadcasts every non-neutral region; we cache it here for the ground shader
// (red tron lines) and the minimap overlay. Region math must match
// `region_of` in crates/wilder-world and `wilder_protocol::REGION_CHUNKS`.

import * as THREE from "three";
import { CHUNK_SIZE, REGION_CHUNKS, TerritoryCell } from "../net/protocol";
import { styleUniforms, TERR_MAX } from "../render/styles";
import { game } from "../state/game";

/** Region edge length in world meters. */
export const REGION_SIZE = CHUNK_SIZE * REGION_CHUNKS;

/**
 * The local player's faction, set from the joined character on WorldJoined
 * (defaults to Rebels until then). `control` values are FactionIds; anything
 * non-neutral that isn't ours is hostile.
 */
export let MY_FACTION = 1;

/** Adopt the joined character's faction (WorldJoined handler). */
export function setMyFaction(faction: number): void {
  MY_FACTION = faction;
}

/** control value keyed by "rx,rz" (only non-neutral regions are stored). */
const controlByRegion = new Map<string, number>();

/**
 * Recent ownership flips keyed by "rx,rz": the wall-clock second (from
 * `performance.now()/1000`) the cell changed hands. Drives the ground shader's
 * blue->faction crossfade. Pruned lazily once the transition has fully played.
 */
const transitions = new Map<string, number>();
/** How long the ground crossfade runs after a flip (seconds). */
const TRANSITION_SECS = 0.9;

/** Current owner (FactionId) of each named neighborhood, by district index. */
let districtOwners: number[] = [];

/** A single cell that changed hands in the latest broadcast. */
export interface ZoneChange {
  rx: number;
  rz: number;
  from: number;
  to: number;
}

/** A neighborhood that changed owner in the latest broadcast. */
export interface DistrictChange {
  index: number;
  from: number;
  to: number;
}

/** What changed between the previous territory snapshot and the new one. */
export interface TerritoryUpdate {
  cells: ZoneChange[];
  districts: DistrictChange[];
}

// Debug handle for development tooling (mirrors window.__game in state/game).
if (typeof window !== "undefined" && import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__territory = {
    enemyRegions: () => enemyRegions(),
    allRegions: () => allRegions(),
  };
}

function regionKey(rx: number, rz: number): string {
  return `${rx},${rz}`;
}

/** Region coordinate containing a world (x, z) position. */
export function regionOf(x: number, z: number): [number, number] {
  return [Math.floor(x / REGION_SIZE), Math.floor(z / REGION_SIZE)];
}

/** Control state of a region: 0 neutral, else the holding FactionId. */
export function territoryControl(rx: number, rz: number): number {
  return controlByRegion.get(regionKey(rx, rz)) ?? 0;
}

/** Regions held by factions hostile to us, for the minimap overlay. */
export function enemyRegions(): { rx: number; rz: number }[] {
  const out: { rx: number; rz: number }[] = [];
  for (const [key, control] of controlByRegion) {
    if (control === 0 || control === MY_FACTION) continue;
    const comma = key.indexOf(",");
    out.push({
      rx: Number(key.slice(0, comma)),
      rz: Number(key.slice(comma + 1)),
    });
  }
  return out;
}

/** Every controlled region with its holding faction (map overlays). */
export function allRegions(): { rx: number; rz: number; faction: number }[] {
  const out: { rx: number; rz: number; faction: number }[] = [];
  for (const [key, control] of controlByRegion) {
    const comma = key.indexOf(",");
    out.push({
      rx: Number(key.slice(0, comma)),
      rz: Number(key.slice(comma + 1)),
      faction: control,
    });
  }
  return out;
}

/** Current owner (FactionId, 0 = neutral) of a neighborhood by district index. */
export function districtOwner(index: number): number {
  return districtOwners[index] ?? 0;
}

/**
 * 0..1 freshness of a region's most recent flip (1 = just changed, 0 = settled
 * or never). Lets map overlays pop newly captured cells before they settle.
 */
export function zoneFlipFreshness(rx: number, rz: number): number {
  const at = transitions.get(regionKey(rx, rz));
  if (at === undefined) return 0;
  const age = performance.now() / 1000 - at;
  return age < 0 ? 1 : Math.max(0, 1 - age / TRANSITION_SECS);
}

/**
 * Apply a server TerritoryState broadcast: diff it against the cached state to
 * find cells and neighborhoods that changed hands (for capture pulses, sounds
 * and gain/loss notifications), record flip timestamps for the ground
 * crossfade, then refresh the shader uniforms.
 */
export function applyTerritory(
  cells: TerritoryCell[],
  districts: number[],
): TerritoryUpdate {
  const now = performance.now() / 1000;
  const next = new Map<string, number>();
  for (const c of cells) {
    if (c.control !== 0) next.set(regionKey(c.rx, c.rz), c.control);
  }

  const changed: ZoneChange[] = [];
  // Cells that gained/changed a non-neutral holder.
  for (const [key, to] of next) {
    const from = controlByRegion.get(key) ?? 0;
    if (from !== to) {
      const comma = key.indexOf(",");
      changed.push({
        rx: Number(key.slice(0, comma)),
        rz: Number(key.slice(comma + 1)),
        from,
        to,
      });
      transitions.set(key, now);
    }
  }
  // Cells that went neutral (dropped from the map).
  for (const [key, from] of controlByRegion) {
    if (!next.has(key)) {
      const comma = key.indexOf(",");
      changed.push({
        rx: Number(key.slice(0, comma)),
        rz: Number(key.slice(comma + 1)),
        from,
        to: 0,
      });
      transitions.delete(key);
    }
  }

  controlByRegion.clear();
  for (const [key, control] of next) controlByRegion.set(key, control);

  // Prune stale crossfade timestamps.
  for (const [key, at] of transitions) {
    if (now - at > TRANSITION_SECS + 0.5) transitions.delete(key);
  }

  // Diff neighborhood ownership.
  const districtChanges: DistrictChange[] = [];
  for (let i = 0; i < districts.length; i++) {
    const from = districtOwners[i] ?? 0;
    const to = districts[i] ?? 0;
    if (from !== to) districtChanges.push({ index: i, from, to });
  }
  districtOwners = districts.slice();

  syncTerritoryUniforms();
  return { cells: changed, districts: districtChanges };
}

/** Replace the cached control map from a server TerritoryState broadcast. */
export function setTerritory(cells: TerritoryCell[]): void {
  applyTerritory(cells, districtOwners);
}

/**
 * Push the hostile regions into the ground shader's red-tint uniforms.
 *
 * The whole-map war can hold far more hostile regions than the shader's
 * TERR_MAX slots, so the closest regions to the player win the budget —
 * otherwise the tint you can actually see could get crowded out by regions
 * on the other side of the island. Re-synced on every TerritoryState
 * broadcast and periodically from the minimap redraw as the player moves.
 */
export function syncTerritoryUniforms(): void {
  const px = game.predicted.x;
  const pz = game.predicted.z;
  const hostile: { rx: number; rz: number; control: number; d2: number }[] = [];
  for (const [key, control] of controlByRegion) {
    if (control === 0 || control === MY_FACTION) continue;
    const comma = key.indexOf(",");
    const rx = Number(key.slice(0, comma));
    const rz = Number(key.slice(comma + 1));
    const cx = (rx + 0.5) * REGION_SIZE - px;
    const cz = (rz + 0.5) * REGION_SIZE - pz;
    hostile.push({ rx, rz, control, d2: cx * cx + cz * cz });
  }
  if (hostile.length > TERR_MAX) {
    hostile.sort((a, b) => a.d2 - b.d2);
    hostile.length = TERR_MAX;
  }
  const cells = styleUniforms.uTerrCells.value as THREE.Vector4[];
  for (let i = 0; i < hostile.length; i++) {
    const h = hostile[i];
    // .w = the flip timestamp (seconds) for the crossfade, 0 if settled.
    const at = transitions.get(regionKey(h.rx, h.rz)) ?? 0;
    cells[i].set(h.rx, h.rz, h.control, at);
  }
  styleUniforms.uTerrCount.value = hostile.length;
}
