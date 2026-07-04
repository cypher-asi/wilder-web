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
 * The local player's faction (all players are Rebels for now). `control`
 * values are FactionIds; anything non-neutral that isn't ours is hostile.
 */
export const MY_FACTION = 1;

/** control value keyed by "rx,rz" (only non-neutral regions are stored). */
const controlByRegion = new Map<string, number>();

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

/** Replace the cached control map from a server TerritoryState broadcast. */
export function setTerritory(cells: TerritoryCell[]): void {
  controlByRegion.clear();
  for (const c of cells) {
    if (c.control !== 0) controlByRegion.set(regionKey(c.rx, c.rz), c.control);
  }
  syncTerritoryUniforms();
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
  const cells = styleUniforms.uTerrCells.value as THREE.Vector3[];
  for (let i = 0; i < hostile.length; i++) {
    cells[i].set(hostile[i].rx, hostile[i].rz, hostile[i].control);
  }
  styleUniforms.uTerrCount.value = hostile.length;
}
