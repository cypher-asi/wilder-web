// Amortized chunk model building + reveal scheduling.
//
// Streamed ChunkData used to mount straight into React, which meant a burst
// of synchronous mergeGeometries work (5-20 buildings x ~10 merged material
// groups) landing on a single frame every time the player crossed a chunk
// boundary. Instead, chunks now pass through this module:
//
//   streamed -> [build queue, ~few ms/frame, nearest first] -> built
//           -> [async shader prewarm via renderer.compileAsync] -> prewarmed
//           -> [batched reveal flush] -> revealed (mounted full fidelity)
//           -> [on server unload: retiring for FADE_MS] -> unmounted
//
// The CityProxy far-field layer reads `proxyCovers` to decide where the
// low-fidelity city blockout should be visible: everywhere except revealed
// chunks, so the proxy dissolves out only once full fidelity can actually
// draw, and dissolves back in while a chunk retires.

import * as THREE from "three";
import { CHUNK_SIZE, ChunkData } from "../net/protocol";
import { chunkKey } from "../game/collision";
import { game, useGame } from "../state/game";
import { getBuildingModel, GROUND_Y } from "./building";
import { getBuildingMaterial } from "./facade";
import { getImportedBuilding } from "./importedBuilding";
import { propPrewarmObjects } from "./Props";

/** Proxy dissolve length; retiring chunks stay mounted this long. */
export const REVEAL_FADE_MS = 300;

/** Max reveal-flush latency while the build queue is still busy. */
const FLUSH_INTERVAL_MS = 150;

/** Chunks whose models are built but not yet revealed (awaiting a flush). */
const built = new Set<string>();

/** Chunks handed to the renderer for shader prewarm (key -> deadline ms). */
const prewarming = new Map<string, number>();

/** Prewarm finished; eligible for the next reveal flush. */
const prewarmed = new Set<string>();

/**
 * If parallel compile stalls, reveal anyway after this long. Purely an
 * anti-hang guard: revealing before the compile finishes trades the wait for
 * a synchronous link stall on the reveal frame, so this must comfortably
 * exceed the slowest real compile (software GL in CI takes many seconds).
 */
const PREWARM_TIMEOUT_MS = 20_000;

/**
 * Compile the shader programs a chunk's buildings will need, off the render
 * path (KHR_parallel_shader_compile under the hood). Most materials are
 * shared so this resolves instantly once the first few chunks are in; its
 * job is soaking up the first-seen program compiles that otherwise land as
 * one multi-hundred-ms hitch on the reveal frame.
 */
function startPrewarm(
  key: string,
  chunk: ChunkData,
  gl: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
): void {
  prewarming.set(key, performance.now() + PREWARM_TIMEOUT_MS);
  const group = new THREE.Group();
  for (const obj of propPrewarmObjects()) group.add(obj);
  for (const b of chunk.buildings) {
    if (getImportedBuilding(b)) continue;
    const model = getBuildingModel(b);
    for (const [matKey, geom] of model.geoms) {
      const mesh = new THREE.Mesh(geom, getBuildingMaterial(matKey, b));
      mesh.position.set(
        chunk.coord.x * CHUNK_SIZE + model.x,
        GROUND_Y,
        chunk.coord.z * CHUNK_SIZE + model.z,
      );
      group.add(mesh);
    }
  }
  gl.compileAsync(group, camera, scene)
    .catch(() => undefined)
    .then(() => {
      if (prewarming.delete(key)) prewarmed.add(key);
    });
}

/** Revealed chunks: mounted at full fidelity. Read-only outside this module. */
export const revealedChunks = new Map<string, ChunkData>();

/** Unloaded by the server but kept mounted while the proxy fades back in. */
const retiring = new Map<string, { chunk: ChunkData; until: number }>();

let lastFlush = 0;

/** Should the low-fidelity city proxy cover this chunk? */
export function proxyCovers(cx: number, cz: number): boolean {
  return !revealedChunks.has(chunkKey(cx, cz));
}

/**
 * Advance the build queue for up to `budgetMs`. Returns true when the set of
 * mounted chunks changed (callers re-render). Called once per frame.
 */
export function processChunkBuilds(
  px: number,
  pz: number,
  budgetMs: number,
  gl: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
): boolean {
  const start = performance.now();
  const store = game.chunks.chunks;
  let changed = false;

  // Server unloads: revealed -> retiring (kept mounted through the fade).
  // A re-sent chunk (new ChunkData object under the same key) goes back
  // through the build queue so its fresh building instances get models.
  for (const [key, chunk] of revealedChunks) {
    const current = store.get(key);
    if (!current) {
      revealedChunks.delete(key);
      retiring.set(key, { chunk, until: start + REVEAL_FADE_MS + 50 });
    } else if (current !== chunk) {
      revealedChunks.delete(key);
      changed = true;
    }
  }
  for (const key of built) {
    if (!store.has(key)) built.delete(key);
  }
  for (const key of prewarmed) {
    if (!store.has(key)) prewarmed.delete(key);
  }
  for (const [key, deadline] of prewarming) {
    if (!store.has(key)) prewarming.delete(key);
    else if (start > deadline) {
      // Compile stalled; reveal anyway rather than holding the chunk hostage.
      prewarming.delete(key);
      prewarmed.add(key);
    }
  }
  for (const [key, r] of retiring) {
    if (start > r.until) {
      retiring.delete(key);
      changed = true;
    }
  }

  // Pending chunks, nearest to the player first so their surroundings
  // upgrade before the horizon does.
  const inPipeline = (key: string) =>
    built.has(key) || prewarming.has(key) || prewarmed.has(key) || revealedChunks.has(key);
  const pending: ChunkData[] = [];
  for (const [key, chunk] of store) {
    if (!inPipeline(key)) pending.push(chunk);
  }
  if (pending.length > 0) {
    const pcx = Math.floor(px / CHUNK_SIZE);
    const pcz = Math.floor(pz / CHUNK_SIZE);
    pending.sort(
      (a, b) =>
        Math.max(Math.abs(a.coord.x - pcx), Math.abs(a.coord.z - pcz)) -
        Math.max(Math.abs(b.coord.x - pcx), Math.abs(b.coord.z - pcz)),
    );
    for (const chunk of pending) {
      if (performance.now() - start > budgetMs) break;
      // Build every model in the chunk, re-checking the budget between
      // buildings. getBuildingModel caches per instance, so a chunk cut off
      // mid-way resumes for free next frame and is only marked built once
      // all of its buildings are done.
      let done = true;
      for (let i = 0; i < chunk.buildings.length; i++) {
        const b = chunk.buildings[i];
        if (!getImportedBuilding(b)) getBuildingModel(b);
        if (i < chunk.buildings.length - 1 && performance.now() - start > budgetMs) {
          done = false;
          break;
        }
      }
      if (done) built.add(chunkKey(chunk.coord.x, chunk.coord.z));
      else break;
    }
  }

  // Built chunks move to the async shader prewarm before they may reveal.
  for (const key of built) {
    const chunk = store.get(key);
    if (chunk) startPrewarm(key, chunk, gl, scene, camera);
  }
  built.clear();

  // Reveal in batches: immediately when the pipeline drains (so the first
  // chunks after a teleport appear fast) and at most every FLUSH_INTERVAL_MS
  // while it is still working, keeping InstancedKit rebuilds off the
  // per-network-message path.
  let remaining = 0;
  for (const key of store.keys()) {
    if (!prewarmed.has(key) && !revealedChunks.has(key)) remaining++;
  }
  const queueDrained = remaining === 0;
  if (prewarmed.size > 0 && (queueDrained || start - lastFlush > FLUSH_INTERVAL_MS)) {
    for (const key of prewarmed) {
      const chunk = store.get(key);
      if (chunk) {
        revealedChunks.set(key, chunk);
        retiring.delete(key);
        changed = true;
      }
    }
    prewarmed.clear();
    lastFlush = start;
    // First flush with visible ground: the join veil can fade out now.
    if (revealedChunks.size > 0 && !useGame.getState().worldReady) {
      useGame.getState().set({ worldReady: true });
    }
  }

  return changed;
}

/** Chunks the renderer should mount right now (revealed + retiring). */
export function mountedChunks(): ChunkData[] {
  const out = [...revealedChunks.values()];
  for (const r of retiring.values()) out.push(r.chunk);
  return out;
}

// Debug handle for the dev probes.
if (typeof window !== "undefined" && import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__chunkPipeline = {
    revealed: revealedChunks,
    built,
    prewarming,
    prewarmed,
    retiring,
  };
}
