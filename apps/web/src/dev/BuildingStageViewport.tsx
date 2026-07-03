// Building Stage 3D viewport: renders one configured prefab building through
// the real game pipeline (buildBuildingModel geometry + facade materials +
// InstancedKit modules), so the staged result matches what ships in-level.
import { Canvas } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { TILE_SIZE } from "../net/protocol";
import { useAssetModel } from "../assets/catalog";
import {
  BuildingModel,
  buildBuildingModel,
  GROUND_Y,
  WaterTowerPlacement,
} from "../render/building";
import { getBuildingMaterial } from "../render/facade";
import { InstancedKit, KitEntry } from "../render/InstancedKit";
import { BuildingPrefab } from "./labApi";
import { prefabInstance } from "./stagePrefabs";

// Same emissive/glass overlay set as Buildings.tsx.
const NO_SHADOW = new Set(["neon", "glass"]);

function StageWaterTower({ placement }: { placement: WaterTowerPlacement }) {
  const model = useAssetModel("prop_watertower");
  const node = useMemo(() => {
    if (!model) return null;
    const target = 5;
    const scale = target / Math.max(model.size.y, 0.001);
    model.scene.scale.setScalar(scale);
    model.scene.position.y = -model.minY * scale;
    return model.scene;
  }, [model]);
  if (!node) return null;
  return (
    <group position={[placement.x, placement.baseY, placement.z]} rotation={[0, placement.ry, 0]}>
      <primitive object={node} />
    </group>
  );
}

export interface StageStats {
  widthM: number;
  depthM: number;
  heightM: number;
  panelCount: number;
  rows: number;
  /** Vertical stretch applied to panel rows (1 = authored height). */
  stretchY: number;
  kitCount: number;
}

export function computeStageStats(prefab: BuildingPrefab, model: BuildingModel): StageStats {
  const panelIds = new Set(prefab.kit.panels.map((p) => p.assetId));
  const panels = model.kit.filter((k) => panelIds.has(k.assetId));
  const rowYs = new Set(panels.map((k) => k.y.toFixed(3)));
  const first = panels[0]?.scale;
  return {
    widthM: model.width,
    depthM: model.depth,
    heightM: model.height,
    panelCount: panels.length,
    rows: rowYs.size,
    stretchY: Array.isArray(first) ? first[1] : 1,
    kitCount: model.kit.length,
  };
}

function StagedBuilding({ prefab, model }: { prefab: BuildingPrefab; model: BuildingModel }) {
  const instance = useMemo(() => prefabInstance(prefab), [prefab]);

  useEffect(() => {
    return () => {
      for (const [, geom] of model.geoms) geom.dispose();
    };
  }, [model]);

  // Building-local kit placements -> world, with the footprint centered on
  // the scene origin (the model's own center is at model.x/model.z).
  const kitEntries = useMemo<KitEntry[]>(
    () =>
      model.kit.map((pl) => ({
        assetId: pl.assetId,
        x: pl.x,
        y: GROUND_Y + pl.y,
        z: pl.z,
        rotationY: pl.ry,
        scale: pl.scale,
      })),
    [model],
  );

  return (
    <>
      <group position={[0, GROUND_Y, 0]}>
        {model.geoms.map(([key, geom]) => (
          <mesh
            key={key}
            geometry={geom}
            material={getBuildingMaterial(key, instance)}
            castShadow={!NO_SHADOW.has(key)}
            receiveShadow={!NO_SHADOW.has(key)}
          />
        ))}
        {model.waterTower && <StageWaterTower placement={model.waterTower} />}
      </group>
      <InstancedKit entries={kitEntries} />
    </>
  );
}

export function BuildingStageViewport({ prefab }: { prefab: BuildingPrefab | null }) {
  const model = useMemo(() => (prefab ? buildBuildingModel(prefabInstance(prefab), prefab.kit) : null), [prefab]);

  const camera = useMemo(() => {
    const radius = model
      ? Math.max(Math.hypot(model.width, model.depth, model.height) / 2, 4)
      : 20;
    const cy = model ? model.height / 2 : 5;
    return {
      position: [radius * 1.5, cy + radius * 0.9, radius * 1.5] as [number, number, number],
      near: 0.1,
      far: Math.max(2000, radius * 30),
      fov: 45,
    };
  }, [model]);

  const stats = prefab && model ? computeStageStats(prefab, model) : null;
  // Grid sized in whole tiles so the footprint reads in 2 m tile units.
  const gridTiles = model
    ? Math.ceil((Math.max(model.width, model.depth) / TILE_SIZE) * 2) + 4
    : 20;

  if (!prefab || !model) {
    return (
      <div className="lab-viewport">
        <div className="lab-viewport-empty">Select or create a building prefab</div>
      </div>
    );
  }

  return (
    <div className="lab-viewport">
      <Canvas key={prefab.id} camera={camera} gl={{ antialias: true }} shadows>
        <color attach="background" args={["#0a0d14"]} />
        <hemisphereLight args={["#cfe8ff", "#20242e", 0.9]} />
        <directionalLight position={[40, 60, 30]} intensity={2.0} castShadow />
        <directionalLight position={[-30, 20, -40]} intensity={0.5} color="#7fb8ff" />
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, GROUND_Y - 0.01, 0]} receiveShadow>
          <planeGeometry args={[gridTiles * TILE_SIZE, gridTiles * TILE_SIZE]} />
          <meshStandardMaterial color="#141920" roughness={0.95} />
        </mesh>
        <gridHelper
          args={[gridTiles * TILE_SIZE, gridTiles, "#2b3a4a", "#1a2330"]}
          position={[0, GROUND_Y + 0.005, 0]}
        />
        <StagedBuilding prefab={prefab} model={model} />
        <OrbitControls target={[0, model.height / 2, 0]} makeDefault />
      </Canvas>
      {stats && (
        <div className="stage-stats">
          <span>
            {stats.widthM}m × {stats.depthM}m × {stats.heightM.toFixed(1)}m
          </span>
          <span>
            {stats.panelCount} panels · {stats.rows} rows · stretch {stats.stretchY.toFixed(2)}x
          </span>
          <span>{stats.kitCount} kit placements</span>
        </div>
      )}
    </div>
  );
}
