// Center 3D viewport: orbit around the selected asset's GLB with a studio
// grid. Supports meshopt-compressed GLBs (game-ready output).
import { Canvas } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { useEffect, useMemo, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";

const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);

interface LoadedScene {
  scene: THREE.Group;
  size: THREE.Vector3;
  center: THREE.Vector3;
}

function useGlbScene(url: string | null): {
  loaded: LoadedScene | null;
  error: string | null;
} {
  const [loaded, setLoaded] = useState<LoadedScene | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setLoaded(null);
    setError(null);
    if (!url) return;
    let alive = true;
    loader
      .loadAsync(url)
      .then((gltf) => {
        if (!alive) return;
        const bbox = new THREE.Box3().setFromObject(gltf.scene);
        setLoaded({
          scene: gltf.scene,
          size: bbox.getSize(new THREE.Vector3()),
          center: bbox.getCenter(new THREE.Vector3()),
        });
      })
      .catch((err) => {
        if (alive) setError(String(err?.message ?? err));
      });
    return () => {
      alive = false;
    };
  }, [url]);
  return { loaded, error };
}

function WireframeToggle({ root, wireframe }: { root: THREE.Group; wireframe: boolean }) {
  useEffect(() => {
    root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mat of mats) {
        (mat as THREE.MeshStandardMaterial).wireframe = wireframe;
      }
    });
  }, [root, wireframe]);
  return <primitive object={root} />;
}

export function AssetViewport({
  url,
  wireframe,
}: {
  url: string | null;
  wireframe: boolean;
}) {
  const { loaded, error } = useGlbScene(url);

  // Frame the camera to the asset bounds whenever a new model loads.
  const camera = useMemo(() => {
    const radius = loaded ? Math.max(loaded.size.length() / 2, 0.5) : 5;
    const c = loaded?.center ?? new THREE.Vector3();
    return {
      position: [c.x + radius * 1.6, c.y + radius * 1.1, c.z + radius * 1.6] as [
        number,
        number,
        number,
      ],
      near: 0.01,
      far: Math.max(2000, radius * 30),
      fov: 45,
    };
  }, [loaded]);

  const gridSize = loaded ? Math.max(10, Math.ceil(loaded.size.length() * 2)) : 10;

  return (
    <div className="lab-viewport">
      {url === null ? (
        <div className="lab-viewport-empty">Select an imported asset to inspect it</div>
      ) : error ? (
        <div className="lab-viewport-empty">Failed to load model: {error}</div>
      ) : !loaded ? (
        <div className="lab-viewport-empty">Loading model…</div>
      ) : (
        <Canvas key={url} camera={camera} gl={{ antialias: true }}>
          <color attach="background" args={["#0a0d14"]} />
          <hemisphereLight args={["#cfe8ff", "#20242e", 0.9]} />
          <directionalLight position={[8, 12, 6]} intensity={2.2} />
          <directionalLight position={[-6, 4, -8]} intensity={0.6} color="#7fb8ff" />
          <gridHelper args={[gridSize, gridSize, "#2b3a4a", "#151c26"]} />
          <axesHelper args={[1]} />
          <WireframeToggle root={loaded.scene} wireframe={wireframe} />
          <OrbitControls target={loaded.center.toArray()} makeDefault />
        </Canvas>
      )}
    </div>
  );
}
