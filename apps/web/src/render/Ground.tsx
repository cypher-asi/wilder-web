// Ground rendering for a chunk: roads, sidewalks, plazas, parks.
// Phase B will replace the flat vertex-colored plane with curb geometry and
// a textured ground shader.

import { useMemo } from "react";
import * as THREE from "three";
import { ChunkData, TILE_SIZE, TILES_PER_CHUNK } from "../net/protocol";

const TILE_COLORS: Record<string, THREE.Color> = {
  Road: new THREE.Color("#17181d"),
  RoadLine: new THREE.Color("#3a3a30"),
  Sidewalk: new THREE.Color("#26282e"),
  Plaza: new THREE.Color("#202227"),
  Building: new THREE.Color("#101114"),
  Park: new THREE.Color("#15231a"),
  Water: new THREE.Color("#0a1420"),
};

function buildGroundGeometry(chunk: ChunkData): THREE.BufferGeometry {
  const n = TILES_PER_CHUNK;
  const positions: number[] = [];
  const colors: number[] = [];
  const normals: number[] = [];

  for (let tz = 0; tz < n; tz++) {
    for (let tx = 0; tx < n; tx++) {
      const kind = chunk.tiles[tz * n + tx];
      const color = TILE_COLORS[kind] ?? TILE_COLORS.Plaza;
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

const groundMaterial = new THREE.MeshStandardMaterial({
  vertexColors: true,
  roughness: 0.25,
  metalness: 0.35,
  envMapIntensity: 1.2,
});

/**
 * Visual ground height (meters) at a world position, e.g. raised sidewalks.
 * Kept in one place so entities and props can sit on the same surface.
 */
export function groundHeightAt(_x: number, _z: number): number {
  return 0;
}

export function ChunkGround({ chunk }: { chunk: ChunkData }) {
  const geometry = useMemo(() => buildGroundGeometry(chunk), [chunk]);
  return <mesh geometry={geometry} material={groundMaterial} receiveShadow />;
}
