// Building rendering: procedural storefront base, textured upper facade, and
// dressed roof. Geometry comes from building.ts (merged per material key);
// materials are shared across buildings via facade.ts.

import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { useAssetModel } from "../assets/catalog";
import { BuildingInstance } from "../net/protocol";
import { buildBuildingModel, WaterTowerPlacement } from "./building";
import { getBuildingMaterial, getSharedMaterial } from "./facade";

// Sidewalk/building tiles are raised; buildings sit on top of them.
const GROUND_Y = 0.14;

// Material keys whose meshes are emissive/glass overlays, not solid massing.
const NO_SHADOW = new Set(["neon", "glass"]);

function WaterTower({ placement }: { placement: WaterTowerPlacement }) {
  const model = useAssetModel("prop_watertower");

  const node = useMemo(() => {
    if (!model) return null;
    const target = 5;
    const scale = target / Math.max(model.size.y, 0.001);
    model.scene.scale.setScalar(scale);
    model.scene.position.y = -model.minY * scale;
    return model.scene;
  }, [model]);

  return (
    <group
      position={[placement.x, placement.baseY, placement.z]}
      rotation={[0, placement.ry, 0]}
    >
      {node ? (
        <primitive object={node} />
      ) : (
        <ProceduralWaterTower />
      )}
    </group>
  );
}

/** Fallback tank-on-legs if the KayKit model is unavailable. */
function ProceduralWaterTower() {
  const legs = useMemo(() => [0, 1, 2, 3].map((i) => (i * Math.PI) / 2 + Math.PI / 4), []);
  const wood = getSharedMaterial("wood");
  const metal = getSharedMaterial("metalDark");
  return (
    <group>
      {legs.map((a, i) => (
        <mesh
          key={i}
          material={metal}
          position={[Math.cos(a) * 0.85, 1.1, Math.sin(a) * 0.85]}
          castShadow
        >
          <cylinderGeometry args={[0.06, 0.08, 2.2, 8]} />
        </mesh>
      ))}
      <mesh material={wood} position={[0, 3.1, 0]} castShadow>
        <cylinderGeometry args={[1.05, 1.05, 2.0, 14]} />
      </mesh>
      <mesh material={metal} position={[0, 4.45, 0]} castShadow>
        <coneGeometry args={[1.15, 0.7, 14]} />
      </mesh>
    </group>
  );
}

export function Building({ building }: { building: BuildingInstance }) {
  const model = useMemo(() => buildBuildingModel(building), [building]);

  // Dispose merged geometries when the chunk unloads (materials are shared).
  useEffect(() => {
    return () => {
      for (const [, geom] of model.geoms) geom.dispose();
    };
  }, [model]);

  return (
    <group position={[model.x, GROUND_Y, model.z]}>
      {model.geoms.map(([key, geom]) => (
        <mesh
          key={key}
          geometry={geom}
          material={getBuildingMaterial(key, building)}
          castShadow={!NO_SHADOW.has(key)}
          receiveShadow={!NO_SHADOW.has(key)}
        />
      ))}
      {model.waterTower && <WaterTower placement={model.waterTower} />}
    </group>
  );
}
