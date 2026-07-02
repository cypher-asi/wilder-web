// Building rendering. Phase C will replace the single box with a procedural
// storefront base, detailed upper facades, and a dressed roof.

import { useMemo } from "react";
import * as THREE from "three";
import { BuildingInstance, TILE_SIZE } from "../net/protocol";
import { makeFacadeMaterial, mulberry, NEON_COLORS } from "./facade";

export function Building({ building }: { building: BuildingInstance }) {
  const width = (building.tx1 - building.tx0) * TILE_SIZE;
  const depth = (building.tz1 - building.tz0) * TILE_SIZE;
  // 4.5m ground floor (storefront) + 3m per upper story.
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
