// Street props. Each archetype renders a real GLB from the asset manifest
// when available, with a procedural stand-in otherwise (useAsset handles it).

import { useMemo } from "react";
import * as THREE from "three";
import { PropInstance } from "../net/protocol";
import { CAR_MODELS, PROP_MODELS, useAssetModel } from "../assets/catalog";
import { mulberry, NEON_COLORS } from "./facade";

// Archetype ids from wilder-terrain.
export const STREETLIGHT = 0;
export const BENCH = 1;
export const TRASH = 2;
export const HYDRANT = 3;
export const NEON_SIGN = 4;
export const VENT = 5;
export const TREE = 6;
export const CAR = 7;
export const BARRIER = 8;
export const KIOSK = 9;

const lampGlow = new THREE.MeshStandardMaterial({
  color: "#ffd9a0",
  emissive: "#ffb45e",
  emissiveIntensity: 4,
});
const poleMat = new THREE.MeshStandardMaterial({ color: "#1a1c20", roughness: 0.6, metalness: 0.7 });
const darkMetal = new THREE.MeshStandardMaterial({ color: "#22252b", roughness: 0.5, metalness: 0.5 });
const treeTrunk = new THREE.MeshStandardMaterial({ color: "#3a2d22", roughness: 0.9 });
const treeCrown = new THREE.MeshStandardMaterial({ color: "#1c3524", roughness: 0.9 });

function Streetlight() {
  return (
    <group>
      <mesh material={poleMat} position={[0, 2.4, 0]} castShadow>
        <cylinderGeometry args={[0.06, 0.09, 4.8, 6]} />
      </mesh>
      <mesh material={poleMat} position={[0.45, 4.7, 0]}>
        <boxGeometry args={[1.0, 0.08, 0.08]} />
      </mesh>
      <mesh material={lampGlow} position={[0.9, 4.62, 0]}>
        <boxGeometry args={[0.35, 0.1, 0.16]} />
      </mesh>
      {/* Fake light pool on the ground. */}
      <mesh position={[0.9, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[1.5, 20]} />
        <meshBasicMaterial color="#7a6038" transparent opacity={0.07} depthWrite={false} />
      </mesh>
    </group>
  );
}

function Car({ seed }: { seed: number }) {
  const color = useMemo(() => {
    const rng = mulberry(seed);
    const palette = ["#3d4756", "#4a3540", "#2f4038", "#43413a", "#2e3a52"];
    return palette[Math.floor(rng() * palette.length)];
  }, [seed]);
  return (
    <group>
      <mesh position={[0, 0.42, 0]} castShadow>
        <boxGeometry args={[4.2, 0.75, 1.8]} />
        <meshStandardMaterial color={color} roughness={0.25} metalness={0.7} />
      </mesh>
      <mesh position={[-0.2, 1.02, 0]} castShadow>
        <boxGeometry args={[2.2, 0.55, 1.6]} />
        <meshStandardMaterial color="#11151c" roughness={0.1} metalness={0.6} />
      </mesh>
      {[-1.4, 1.4].map((wx) =>
        [-0.85, 0.85].map((wz) => (
          <mesh key={`${wx}${wz}`} position={[wx, 0.3, wz]} rotation={[Math.PI / 2, 0, 0]}>
            <cylinderGeometry args={[0.3, 0.3, 0.22, 12]} />
            <meshStandardMaterial color="#0a0a0c" roughness={0.9} />
          </mesh>
        )),
      )}
    </group>
  );
}

function Tree() {
  return (
    <group>
      <mesh material={treeTrunk} position={[0, 1.1, 0]} castShadow>
        <cylinderGeometry args={[0.12, 0.2, 2.2, 6]} />
      </mesh>
      <mesh material={treeCrown} position={[0, 2.8, 0]} castShadow>
        <icosahedronGeometry args={[1.3, 1]} />
      </mesh>
    </group>
  );
}

function Kiosk({ seed }: { seed: number }) {
  const neon = useMemo(() => {
    const rng = mulberry(seed);
    return NEON_COLORS[Math.floor(rng() * NEON_COLORS.length)];
  }, [seed]);
  return (
    <group>
      <mesh material={darkMetal} position={[0, 1.1, 0]} castShadow>
        <boxGeometry args={[1.8, 2.2, 1.4]} />
      </mesh>
      <mesh position={[0, 2.0, 0.71]}>
        <planeGeometry args={[1.5, 0.35]} />
        <meshStandardMaterial color={neon} emissive={neon} emissiveIntensity={2.8} />
      </mesh>
    </group>
  );
}

function Fallback({ prop }: { prop: PropInstance }) {
  switch (prop.archetype) {
    case STREETLIGHT:
      return <Streetlight />;
    case BENCH:
      return (
        <mesh material={darkMetal} position={[0, 0.25, 0]} castShadow>
          <boxGeometry args={[1.8, 0.5, 0.55]} />
        </mesh>
      );
    case TRASH:
      return (
        <mesh material={darkMetal} position={[0, 0.45, 0]} castShadow>
          <cylinderGeometry args={[0.32, 0.28, 0.9, 8]} />
        </mesh>
      );
    case HYDRANT:
      return (
        <mesh position={[0, 0.35, 0]} castShadow>
          <cylinderGeometry args={[0.16, 0.2, 0.7, 8]} />
          <meshStandardMaterial color="#5a1f22" roughness={0.6} metalness={0.3} />
        </mesh>
      );
    case VENT:
      return (
        <mesh material={darkMetal} position={[0, 0.2, 0]}>
          <boxGeometry args={[1.0, 0.4, 1.0]} />
        </mesh>
      );
    case TREE:
      return <Tree />;
    case CAR:
      return <Car seed={Math.floor(prop.x * 31 + prop.z * 17)} />;
    case KIOSK:
      return <Kiosk seed={Math.floor(prop.x * 13 + prop.z * 7)} />;
    default:
      return (
        <mesh material={darkMetal} position={[0, 0.3, 0]}>
          <boxGeometry args={[0.6, 0.6, 0.6]} />
        </mesh>
      );
  }
}

/** KayKit city bits are authored at half our street scale; upscale. */
const PROP_SCALE: Record<number, number> = {
  [STREETLIGHT]: 2.0,
  [BENCH]: 1.6,
  [TRASH]: 1.6,
  [HYDRANT]: 1.6,
  [VENT]: 1.6,
  [CAR]: 2.0,
  [KIOSK]: 1.6,
};

export function PropMesh({ prop }: { prop: PropInstance }) {
  const assetId =
    prop.archetype === CAR
      ? CAR_MODELS[Math.abs(Math.floor(prop.x * 7 + prop.z * 13)) % CAR_MODELS.length]
      : PROP_MODELS[prop.archetype];
  const model = useAssetModel(assetId);
  const scale = PROP_SCALE[prop.archetype] ?? 1.5;
  return (
    <group position={[prop.x, 0, prop.z]} rotation={[0, prop.rotation, 0]}>
      {model ? (
        <primitive object={model.scene} scale={scale} />
      ) : (
        <Fallback prop={prop} />
      )}
    </group>
  );
}
