// Territory control state (mirror of the server's region grid). The server
// broadcasts every non-neutral region; we cache it here for the ground shader
// (red tron lines) and the minimap overlay. Region math must match
// `region_of` in crates/wilder-world and `wilder_protocol::REGION_CHUNKS`.

import * as THREE from "three";
import { CHUNK_SIZE, REGION_CHUNKS, TerritoryCell } from "../net/protocol";
import { styleUniforms, TERR_MAX } from "../render/styles";

/** Region edge length in world meters. */
export const REGION_SIZE = CHUNK_SIZE * REGION_CHUNKS;

export const CONTROL_PLAYER = 1;
export const CONTROL_ENEMY = 2;

/** control value keyed by "rx,rz" (only non-neutral regions are stored). */
const controlByRegion = new Map<string, number>();

function regionKey(rx: number, rz: number): string {
  return `${rx},${rz}`;
}

/** Region coordinate containing a world (x, z) position. */
export function regionOf(x: number, z: number): [number, number] {
  return [Math.floor(x / REGION_SIZE), Math.floor(z / REGION_SIZE)];
}

/** Control state of a region: 0 neutral, 1 player-held, 2 enemy-held. */
export function territoryControl(rx: number, rz: number): number {
  return controlByRegion.get(regionKey(rx, rz)) ?? 0;
}

/** Enemy-controlled regions, for the minimap overlay. */
export function enemyRegions(): { rx: number; rz: number }[] {
  const out: { rx: number; rz: number }[] = [];
  for (const [key, control] of controlByRegion) {
    if (control !== CONTROL_ENEMY) continue;
    const comma = key.indexOf(",");
    out.push({
      rx: Number(key.slice(0, comma)),
      rz: Number(key.slice(comma + 1)),
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

/** Push the enemy regions into the ground shader's red-tint uniforms. */
function syncTerritoryUniforms(): void {
  const cells = styleUniforms.uTerrCells.value as THREE.Vector3[];
  let n = 0;
  for (const [key, control] of controlByRegion) {
    if (control !== CONTROL_ENEMY) continue;
    if (n >= TERR_MAX) break;
    const comma = key.indexOf(",");
    cells[n].set(Number(key.slice(0, comma)), Number(key.slice(comma + 1)), control);
    n++;
  }
  styleUniforms.uTerrCount.value = n;
}
