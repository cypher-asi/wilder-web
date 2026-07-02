import { Canvas } from "@react-three/fiber";
import { GameConnection } from "../net/connection";
import { Effects, Lighting, Rain, SceneSetup } from "./Atmosphere";
import { CameraRig } from "./CameraRig";
import { Chunks } from "./Chunks";
import { Entities } from "./Entities";
import { PlayerInput } from "./PlayerInput";

export function GameCanvas({ connection }: { connection: GameConnection }) {
  return (
    <Canvas
      shadows
      dpr={[1, 1.75]}
      camera={{ fov: 38, near: 0.5, far: 400 }}
      gl={{ antialias: true, powerPreference: "high-performance" }}
      style={{ position: "absolute", inset: 0 }}
    >
      <SceneSetup />
      <Lighting />
      <Chunks />
      <Entities />
      <Rain />
      <CameraRig />
      <PlayerInput connection={connection} />
      <Effects />
    </Canvas>
  );
}
