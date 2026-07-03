// Renders streamed chunks: ground (Ground.tsx), buildings (Buildings.tsx),
// and street props (Props.tsx). Prop archetypes with promoted kit models are
// batched world-wide through InstancedKit instead of per-prop clones.
//
// Streamed ChunkData does not mount directly: chunkBuilder.ts amortizes the
// procedural building merges over frames and reveals chunks in batches, so
// crossing a chunk boundary never lands a burst of geometry work on one
// frame. Until a chunk is revealed the CityProxy far-field layer covers it.

import { useMemo, useReducer } from "react";
import { useFrame } from "@react-three/fiber";
import { CHUNK_SIZE, ChunkData } from "../net/protocol";
import { perf } from "../perf/perf";
import { game, useGame } from "../state/game";
import { collectBuildingKit, KIT_AC } from "./building";
import { Building } from "./Buildings";
import { mountedChunks, processChunkBuilds, revealedChunks } from "./chunkBuilder";
import { ChunkGround } from "./Ground";
import { InstancedKit } from "./InstancedKit";
import { isTronStyle } from "./styles";
import {
  collectInstancedProps,
  INSTANCED_PROP_FITS,
  isInstancedProp,
  LightPools,
  PropMesh,
  SteamVents,
} from "./Props";

/** Per-frame budget (ms) for building chunk models off the streamed queue. */
const BUILD_BUDGET_MS = 3;
/** Bigger budget while nothing is revealed yet (initial join / teleport):
 * the join veil hides the burst, so spend the frame getting ground up fast. */
const INITIAL_BUILD_BUDGET_MS = 10;

function Chunk({ chunk }: { chunk: ChunkData }) {
  const origin: [number, number, number] = [
    chunk.coord.x * CHUNK_SIZE,
    0,
    chunk.coord.z * CHUNK_SIZE,
  ];

  return (
    <group position={origin}>
      <ChunkGround chunk={chunk} />
      {chunk.buildings.map((b, i) => (
        <Building key={i} building={b} />
      ))}
      {chunk.props.map((p, i) =>
        isInstancedProp(p.archetype) ? null : <PropMesh key={`p${i}`} prop={p} chunk={chunk} />,
      )}
      <LightPools chunk={chunk} />
      <SteamVents chunk={chunk} />
    </group>
  );
}

export function Chunks() {
  // Bumped only when the *mounted* chunk set changes (batched reveals and
  // retire expiries), not on every streamed network message.
  const [mountVersion, bumpMounted] = useReducer((n: number) => n + 1, 0);

  useFrame(({ gl, scene, camera }) => {
    perf.begin("chunks.build");
    const p = game.rendered;
    const budget = revealedChunks.size === 0 ? INITIAL_BUILD_BUDGET_MS : BUILD_BUDGET_MS;
    if (processChunkBuilds(p.x, p.z, budget, gl, scene, camera)) bumpMounted();
    perf.end("chunks.build");
  });

  const chunks = useMemo(() => mountedChunks(), [mountVersion]);
  // TRON drops the building AC-unit HVAC clutter (building-only kit assets).
  const tron = useGame((s) => isTronStyle(s.visualStyle));
  const kitEntries = useMemo(() => {
    const all = [...collectInstancedProps(chunks), ...collectBuildingKit(chunks)];
    if (!tron) return all;
    const acIds = new Set(KIT_AC);
    return all.filter((e) => !acIds.has(e.assetId));
  }, [chunks, tron]);

  return (
    <>
      {chunks.map((chunk) => (
        <Chunk key={`${chunk.coord.x},${chunk.coord.z}`} chunk={chunk} />
      ))}
      <InstancedKit entries={kitEntries} fits={INSTANCED_PROP_FITS} />
    </>
  );
}
