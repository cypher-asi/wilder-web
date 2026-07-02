// Night city atmosphere: lighting, fog, rain, and post-processing.

import { useFrame, useThree } from "@react-three/fiber";
import { Bloom, EffectComposer, Vignette } from "@react-three/postprocessing";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { game } from "../state/game";

export function Lighting() {
  const moonRef = useRef<THREE.DirectionalLight>(null);
  const playerLightRef = useRef<THREE.PointLight>(null);

  useFrame(() => {
    // Keep the shadow camera centered on the player so shadows stay crisp.
    const px = game.predicted.x;
    const pz = game.predicted.z;
    const light = moonRef.current;
    if (light) {
      light.position.set(px + 30, 55, pz + 20);
      light.target.position.set(px, 0, pz);
      light.target.updateMatrixWorld();
    }
    playerLightRef.current?.position.set(px, 2.6, pz);
  });

  return (
    <>
      {/* cool ambient night sky bounce */}
      <hemisphereLight args={["#28304a", "#0a0b10", 0.55]} />
      {/* moon */}
      <directionalLight
        ref={moonRef}
        color="#aebfff"
        intensity={0.85}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-60}
        shadow-camera-right={60}
        shadow-camera-top={60}
        shadow-camera-bottom={-60}
        shadow-camera-far={160}
        shadow-bias={-0.0004}
      />
      {/* warm city glow from below the skyline */}
      <ambientLight color="#3d2f28" intensity={0.25} />
      {/* soft light bubble around the player so the character reads */}
      <pointLight ref={playerLightRef} color="#9fb4d8" intensity={14} distance={9} decay={1.8} />
    </>
  );
}

const RAIN_COUNT = 900;
const RAIN_AREA = 70;
const RAIN_HEIGHT = 30;

export function Rain() {
  const ref = useRef<THREE.Points>(null);
  const { positions, speeds } = useMemo(() => {
    const positions = new Float32Array(RAIN_COUNT * 3);
    const speeds = new Float32Array(RAIN_COUNT);
    for (let i = 0; i < RAIN_COUNT; i++) {
      positions[i * 3] = (Math.random() - 0.5) * RAIN_AREA;
      positions[i * 3 + 1] = Math.random() * RAIN_HEIGHT;
      positions[i * 3 + 2] = (Math.random() - 0.5) * RAIN_AREA;
      speeds[i] = 18 + Math.random() * 14;
    }
    return { positions, speeds };
  }, []);

  useFrame((_, dt) => {
    const points = ref.current;
    if (!points) return;
    const attr = points.geometry.getAttribute("position") as THREE.BufferAttribute;
    const arr = attr.array as Float32Array;
    for (let i = 0; i < RAIN_COUNT; i++) {
      arr[i * 3 + 1] -= speeds[i] * dt;
      if (arr[i * 3 + 1] < 0) {
        arr[i * 3] = (Math.random() - 0.5) * RAIN_AREA;
        arr[i * 3 + 1] = RAIN_HEIGHT;
        arr[i * 3 + 2] = (Math.random() - 0.5) * RAIN_AREA;
      }
    }
    attr.needsUpdate = true;
    // Rain volume follows the player.
    points.position.set(game.predicted.x, 0, game.predicted.z);
  });

  return (
    <points ref={ref} frustumCulled={false}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <pointsMaterial
        color="#6a7f9a"
        size={0.08}
        transparent
        opacity={0.55}
        sizeAttenuation
        depthWrite={false}
      />
    </points>
  );
}

export function Effects() {
  return (
    <EffectComposer>
      <Bloom intensity={0.9} luminanceThreshold={0.65} luminanceSmoothing={0.3} mipmapBlur />
      <Vignette eskil={false} offset={0.18} darkness={0.78} />
    </EffectComposer>
  );
}

export function SceneSetup() {
  const { scene, gl } = useThree();
  useMemo(() => {
    scene.fog = new THREE.FogExp2("#0b0e16", 0.016);
    scene.background = new THREE.Color("#070a12");
    gl.toneMapping = THREE.ACESFilmicToneMapping;
    gl.toneMappingExposure = 1.15;
  }, [scene, gl]);
  return null;
}
