// Renders streamed chunks: ground tiles, buildings with lit facades, neon
// signs, and street props. Procedural meshes serve as the base kit; GLB
// archetypes from the asset manifest replace props where available.

import { useMemo } from "react";
import * as THREE from "three";
import {
  BuildingInstance,
  CHUNK_SIZE,
  ChunkData,
  TILE_SIZE,
  TILES_PER_CHUNK,
} from "../net/protocol";
import { game, useGame } from "../state/game";
import { makeFacadeMaterial, mulberry, NEON_COLORS } from "./facade";
import { PropMesh } from "./Props";

const TILE_COLORS: Record<string, THREE.Color> = {
  Road: new THREE.Color("#17181d"),
  RoadLine: new THREE.Color("#3a3a30"),
  Sidewalk: new THREE.Color("#26282e"),
  Plaza: new THREE.Color("#202227"),
  Building: new THREE.Color("#101114"),
  Park: new THREE.Color("#15231a"),
  Water: new THREE.Color("#0a1420"),
};

const ROUGHNESS: Record<string, number> = {
  Road: 0.18, // wet asphalt
  RoadLine: 0.2,
  Sidewalk: 0.5,
  Plaza: 0.4,
  Building: 0.8,
  Park: 0.9,
  Water: 0.05,
};

function buildGroundGeometry(chunk: ChunkData): THREE.BufferGeometry {
  const n = TILES_PER_CHUNK;
  const positions: number[] = [];
  const colors: number[] = [];
  const roughness: number[] = [];
  const normals: number[] = [];

  for (let tz = 0; tz < n; tz++) {
    for (let tx = 0; tx < n; tx++) {
      const kind = chunk.tiles[tz * n + tx];
      const color = TILE_COLORS[kind] ?? TILE_COLORS.Plaza;
      const rough = ROUGHNESS[kind] ?? 0.5;
      const x0 = tx * TILE_SIZE;
      const z0 = tz * TILE_SIZE;
      const x1 = x0 + TILE_SIZE;
      const z1 = z0 + TILE_SIZE;
      // Two triangles.
      const quad = [
        [x0, z0], [x0, z1], [x1, z1],
        [x0, z0], [x1, z1], [x1, z0],
      ];
      for (const [x, z] of quad) {
        positions.push(x, 0, z);
        colors.push(color.r, color.g, color.b);
        roughness.push(rough);
        normals.push(0, 1, 0);
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  return geometry;
}

function Building({ building }: { building: BuildingInstance }) {
  const width = (building.tx1 - building.tx0) * TILE_SIZE;
  const depth = (building.tz1 - building.tz0) * TILE_SIZE;
  // 4.5m ground floor (future storefront) + 3m per upper story.
  const height = 4.5 + (building.stories - 1) * 3;
  const x = building.tx0 * TILE_SIZE + width / 2;
  const z = building.tz0 * TILE_SIZE + depth / 2;

  const material = useMemo(
    () => makeFacadeMaterial({ width, height, depth, style: building.style }),
    [width, height, depth, building.style],
  );

  const neon = useMemo(() => {
    const rng = mulberry(building.style ^ 0x9e3779b9);
    if (rng() > 0.45) return null;
    const color = NEON_COLORS[Math.floor(rng() * NEON_COLORS.length)];
    const signH = 1.2 + rng() * 2.5;
    const signY = 2.5 + rng() * Math.max(1, height - 5);
    // Stick the sign on the -z face (usually street facing).
    return { color, signH, signY };
  }, [building.style, height]);

  return (
    <group position={[x, height / 2, z]}>
      <mesh material={material} castShadow>
        <boxGeometry args={[width, height, depth]} />
      </mesh>
      {neon && (
        <mesh position={[width * 0.25, neon.signY - height / 2, -depth / 2 - 0.08]}>
          <planeGeometry args={[0.35, neon.signH]} />
          <meshStandardMaterial
            color={neon.color}
            emissive={neon.color}
            emissiveIntensity={3.2}
            side={THREE.DoubleSide}
          />
        </mesh>
      )}
    </group>
  );
}

const groundMaterial = new THREE.MeshStandardMaterial({
  vertexColors: true,
  roughness: 0.25,
  metalness: 0.35,
  envMapIntensity: 1.2,
});

function Chunk({ chunk }: { chunk: ChunkData }) {
  const geometry = useMemo(() => buildGroundGeometry(chunk), [chunk]);
  const origin: [number, number, number] = [
    chunk.coord.x * CHUNK_SIZE,
    0,
    chunk.coord.z * CHUNK_SIZE,
  ];

  return (
    <group position={origin}>
      <mesh geometry={geometry} material={groundMaterial} receiveShadow />
      {chunk.buildings.map((b, i) => (
        <Building key={i} building={b} />
      ))}
      {chunk.props.map((p, i) => (
        <PropMesh key={`p${i}`} prop={p} />
      ))}
    </group>
  );
}

export function Chunks() {
  // chunkVersion bumps whenever the streamed set changes.
  useGame((s) => s.chunkVersion);
  const chunks = [...game.chunks.chunks.values()];
  return (
    <>
      {chunks.map((chunk) => (
        <Chunk key={`${chunk.coord.x},${chunk.coord.z}`} chunk={chunk} />
      ))}
    </>
  );
}
