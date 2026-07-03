// Building rendering: procedural storefront base, textured upper facade, and
// dressed roof. Geometry comes from building.ts (merged per material key);
// materials are shared across buildings via facade.ts.

import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { useAssetModel } from "../assets/catalog";
import { BuildingInstance } from "../net/protocol";
import { useGame } from "../state/game";
import { getBuildingModel, GROUND_Y, WaterTowerPlacement } from "./building";
import { getBuildingMaterial, getSharedMaterial } from "./facade";
import { getImportedBuilding, ImportedBuildingPlacement } from "./importedBuilding";
import { isTronStyle } from "./styles";

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

/** A footprint rendered as a single authored GLB; no procedural geometry. */
function ImportedBuilding({ placement }: { placement: ImportedBuildingPlacement }) {
  const model = useAssetModel(placement.spec.assetId);

  const node = useMemo(() => {
    if (!model) return null;
    // Bottom-center pivot from the Asset Lab; snap the base to the ground
    // (the offset is in model space, the parent group applies the scale).
    model.scene.position.y = -model.minY;
    return model.scene;
  }, [model]);

  if (!node) return null;
  return (
    <group
      position={[placement.x, GROUND_Y, placement.z]}
      rotation={[0, placement.ry, 0]}
      scale={[placement.sx, placement.sy, placement.sz]}
    >
      <primitive object={node} />
    </group>
  );
}

export function Building({ building }: { building: BuildingInstance }) {
  const imported = getImportedBuilding(building);
  if (imported) return <ImportedBuilding placement={imported} />;
  return <ProceduralBuilding building={building} />;
}

function ProceduralBuilding({ building }: { building: BuildingInstance }) {
  const model = useMemo(() => getBuildingModel(building), [building]);
  // TRON strips decorative "#hide" parts (fire escapes, window glass/mullions,
  // HVAC/vent/pipe/antenna/billboard/awning clutter): the tagged meshes are
  // dropped entirely so neither color nor shadow remains.
  const tron = useGame((s) => isTronStyle(s.visualStyle));

  // Dispose merged geometries when the chunk unloads (materials are shared).
  // The model cache is keyed weakly on the streamed BuildingInstance, which
  // is dropped with its chunk, so a disposed model is never reused.
  useEffect(() => {
    return () => {
      for (const [, geom] of model.geoms) geom.dispose();
    };
  }, [model]);

  return (
    <group position={[model.x, GROUND_Y, model.z]}>
      {model.geoms.map(([key, geom]) => {
        if (tron && key.endsWith("#hide")) return null;
        const base = key.split("#")[0];
        return (
          <mesh
            key={key}
            geometry={geom}
            material={getBuildingMaterial(key, building)}
            castShadow={!NO_SHADOW.has(base)}
            receiveShadow={!NO_SHADOW.has(base)}
          />
        );
      })}
      {model.waterTower && <WaterTower placement={model.waterTower} />}
    </group>
  );
}
