import { Canvas } from "@react-three/fiber";
import { GameConnection } from "../net/connection";
import { PerfTracker } from "../perf/PerfTracker";
import { useGame } from "../state/game";
import { Effects, Lighting, SceneSetup, SkyBackdrop, SunsetAtmosphere } from "./Atmosphere";
import { CAMERA_FAR, CameraRig } from "./CameraRig";
import { Chunks } from "./Chunks";
import { CityProxy } from "./CityProxy";
import { CombatFx } from "./CombatFx";
import { Entities } from "./Entities";
import { Ocean } from "./Ocean";
import { PlayerInput } from "./PlayerInput";

export function GameCanvas({ connection }: { connection: GameConnection }) {
  // While the fullscreen map is open, stop rendering the world entirely (the
  // scene stays mounted so closing the map resumes instantly). The game menu
  // pauses rendering too but keeps the last frame visible behind its dim
  // backdrop.
  const mapOpen = useGame((s) => s.mapOpen);
  const menuOpen = useGame((s) => s.menuOpen);
  return (
    <Canvas
      shadows
      dpr={[1, 1.75]}
      camera={{ fov: 34, near: 0.5, far: CAMERA_FAR }}
      gl={{ antialias: true, powerPreference: "high-performance" }}
      frameloop={mapOpen || menuOpen ? "never" : "always"}
      style={{ position: "absolute", inset: 0, visibility: mapOpen ? "hidden" : "visible" }}
      onCreated={({ gl, scene }) => {
        // three's post-link getProgramInfoLog query forces a synchronous
        // join on shader compilation, defeating the KHR_parallel_shader_
        // compile pipeline that chunk prewarm relies on (multi-second stalls
        // on software GL). Flip this back on locally when debugging a new
        // shader; compile failures still throw, just with less detail.
        gl.debug.checkShaderErrors = false;
        // Dev-only hook for the screenshot/validation tooling.
        if (import.meta.env.DEV) {
          (window as unknown as Record<string, unknown>).__wilderGl = { gl, scene };
        }
      }}
    >
      <PerfTracker />
      <SunsetAtmosphere>
        <SceneSetup />
        <Lighting />
        <SkyBackdrop />
        <Ocean />
        <CityProxy />
        <Chunks />
        <Entities />
        <CombatFx />
        <CameraRig />
        <PlayerInput connection={connection} />
        <Effects />
      </SunsetAtmosphere>
    </Canvas>
  );
}
