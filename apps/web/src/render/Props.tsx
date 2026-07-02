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
export const TRAFFIC_LIGHT = 10;
export const STOP_SIGN = 11;

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
      <mesh material={poleMat} position={[0, 3.5, 0]} castShadow>
        <cylinderGeometry args={[0.06, 0.1, 7.0, 6]} />
      </mesh>
      <mesh material={poleMat} position={[0.55, 6.85, 0]}>
        <boxGeometry args={[1.2, 0.08, 0.08]} />
      </mesh>
      <mesh material={lampGlow} position={[1.1, 6.77, 0]}>
        <boxGeometry args={[0.4, 0.1, 0.18]} />
      </mesh>
      {/* Fake light pool on the ground. */}
      <mesh position={[1.1, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[1.8, 20]} />
        <meshBasicMaterial color="#7a6038" transparent opacity={0.07} depthWrite={false} />
      </mesh>
    </group>
  );
}

const trafficRed = new THREE.MeshStandardMaterial({
  color: "#3a0d0d",
  emissive: "#ff2a1e",
  emissiveIntensity: 2.5,
});
const trafficAmber = new THREE.MeshStandardMaterial({
  color: "#3a2a0d",
  emissive: "#ffab1e",
  emissiveIntensity: 1.2,
});
const trafficGreen = new THREE.MeshStandardMaterial({
  color: "#0d3a1a",
  emissive: "#2aff6e",
  emissiveIntensity: 1.2,
});

function TrafficLight() {
  return (
    <group>
      <mesh material={poleMat} position={[0, 2.6, 0]} castShadow>
        <cylinderGeometry args={[0.06, 0.1, 5.2, 6]} />
      </mesh>
      {/* 3-lamp head near the top of the pole. */}
      <mesh material={darkMetal} position={[0, 4.55, 0]} castShadow>
        <boxGeometry args={[0.32, 0.95, 0.26]} />
      </mesh>
      {[
        { y: 4.85, mat: trafficRed },
        { y: 4.55, mat: trafficAmber },
        { y: 4.25, mat: trafficGreen },
      ].map(({ y, mat }) => (
        <mesh key={y} material={mat} position={[0, y, -0.135]} rotation={[0, Math.PI, 0]}>
          <circleGeometry args={[0.09, 12]} />
        </mesh>
      ))}
    </group>
  );
}

const stopSignFace = new THREE.MeshStandardMaterial({
  color: "#7a1418",
  emissive: "#c01a20",
  emissiveIntensity: 0.35,
  roughness: 0.4,
});

function StopSign() {
  return (
    <group>
      <mesh material={poleMat} position={[0, 1.05, 0]} castShadow>
        <cylinderGeometry args={[0.04, 0.05, 2.1, 6]} />
      </mesh>
      {/* Octagonal plate at the top of the pole. */}
      <mesh material={stopSignFace} position={[0, 2.1, 0]} rotation={[Math.PI / 2, 0, 0]} castShadow>
        <cylinderGeometry args={[0.38, 0.38, 0.04, 8]} />
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
    case TRAFFIC_LIGHT:
      return <TrafficLight />;
    case STOP_SIGN:
      return <StopSign />;
    default:
      return (
        <mesh material={darkMetal} position={[0, 0.3, 0]}>
          <boxGeometry args={[0.6, 0.6, 0.6]} />
        </mesh>
      );
  }
}

/**
 * Real-world target dimension per archetype, used to normalize loaded models
 * of unknown authoring scale. "height" measures the bbox Y extent; "length"
 * measures the longest horizontal bbox axis (max of X/Z).
 */
const PROP_TARGETS: Record<number, { size: number; axis: "height" | "length" }> = {
  [STREETLIGHT]: { size: 7.0, axis: "height" },
  [BENCH]: { size: 1.8, axis: "length" },
  [TRASH]: { size: 1.1, axis: "height" },
  [HYDRANT]: { size: 0.75, axis: "height" },
  [VENT]: { size: 1.3, axis: "height" }, // dumpster model
  [CAR]: { size: 4.5, axis: "length" },
  [KIOSK]: { size: 2.4, axis: "height" },
  [TRAFFIC_LIGHT]: { size: 5.2, axis: "height" },
};

export function PropMesh({ prop }: { prop: PropInstance }) {
  const assetId =
    prop.archetype === CAR
      ? CAR_MODELS[Math.abs(Math.floor(prop.x * 7 + prop.z * 13)) % CAR_MODELS.length]
      : PROP_MODELS[prop.archetype];
  const model = useAssetModel(assetId);

  // Uniform scale from measured bbox -> real-world target, plus a Y offset
  // that snaps the (scaled) model bottom to ground level.
  const { scale, yOffset } = useMemo(() => {
    if (!model) return { scale: 1, yOffset: 0 };
    const target = PROP_TARGETS[prop.archetype];
    let scale = 1;
    if (target) {
      const measured =
        target.axis === "height" ? model.size.y : Math.max(model.size.x, model.size.z);
      if (measured > 1e-4) scale = target.size / measured;
    }
    return { scale, yOffset: -model.minY * scale };
  }, [model, prop.archetype]);

  return (
    <group position={[prop.x, 0, prop.z]} rotation={[0, prop.rotation, 0]}>
      {model ? (
        <primitive object={model.scene} scale={scale} position={[0, yOffset, 0]} />
      ) : (
        <Fallback prop={prop} />
      )}
    </group>
  );
}
