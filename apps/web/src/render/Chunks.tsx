// Renders streamed chunks: ground (Ground.tsx), buildings (Buildings.tsx),
// and street props (Props.tsx). Prop archetypes with promoted kit models are
// batched world-wide through InstancedKit instead of per-prop clones.

import { useMemo } from "react";
import { CHUNK_SIZE, ChunkData } from "../net/protocol";
import { game, useGame } from "../state/game";
import { collectBuildingKit } from "./building";
import { Building } from "./Buildings";
import { ChunkGround } from "./Ground";
import { InstancedKit } from "./InstancedKit";
import {
  collectInstancedProps,
  INSTANCED_PROP_FITS,
  isInstancedProp,
  LightPools,
  PropMesh,
} from "./Props";

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
    </group>
  );
}

export function Chunks() {
  // chunkVersion bumps whenever the streamed set changes.
  const chunkVersion = useGame((s) => s.chunkVersion);
  const chunks = [...game.chunks.chunks.values()];
  const kitEntries = useMemo(() => {
    const all = [...game.chunks.chunks.values()];
    return [...collectInstancedProps(all), ...collectBuildingKit(all)];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chunkVersion]);
  return (
    <>
      {chunks.map((chunk) => (
        <Chunk key={`${chunk.coord.x},${chunk.coord.z}`} chunk={chunk} />
      ))}
      <InstancedKit entries={kitEntries} fits={INSTANCED_PROP_FITS} />
    </>
  );
}
