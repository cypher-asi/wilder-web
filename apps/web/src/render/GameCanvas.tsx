import { Canvas, events } from "@react-three/fiber";
import { useIsMobile } from "../mobile/useIsMobile";
import { GameConnection } from "../net/connection";
import { AdaptiveQuality } from "../perf/AdaptiveQuality";
import { PerfTracker } from "../perf/PerfTracker";
import { DESKTOP_DPR_MAX, MOBILE_DPR_MAX } from "../perf/quality";
import { useGame } from "../state/game";
import { Effects, Lighting, SceneSetup, SkyBackdrop, SunsetAtmosphere } from "./Atmosphere";
import { CAMERA_FAR, CameraRig, cameraState } from "./CameraRig";
import { Chunks } from "./Chunks";
import { CityProxy } from "./CityProxy";
import { CombatFx } from "./CombatFx";
import { Entities } from "./Entities";
import { Interiors } from "./Interior";
import { Ocean } from "./Ocean";
import { PlayerInput } from "./PlayerInput";

/**
 * While the canvas holds pointer lock the OS cursor is gone and mouse events
 * report frozen coordinates, so all scene picking (enemy hover, interactable
 * clicks) is recomputed from the center crosshair instead of the event
 * position. Unlocked, this matches the default r3f compute.
 */
const pointerLockEvents: typeof events = (store) => ({
  ...events(store),
  compute(event, state) {
    if (cameraState.locked) {
      state.pointer.set(0, 0);
    } else {
      state.pointer.set(
        (event.offsetX / state.size.width) * 2 - 1,
        -(event.offsetY / state.size.height) * 2 + 1,
      );
    }
    state.raycaster.setFromCamera(state.pointer, state.camera);
  },
});

export function GameCanvas({ connection }: { connection: GameConnection }) {
  // While the central menu is open, stop rendering the world entirely (the
  // scene stays mounted so closing it resumes instantly). On the Map tab the
  // canvas is hidden because the map draws its own canvas; the other tabs keep
  // the last frozen frame visible behind their overlays.
  const menuOpen = useGame((s) => s.menuOpen);
  const mapOpen = useGame((s) => s.menuOpen && s.menuTab === "map");
  // Mobile preset: the shell covers the canvas except on the Watch tab, so
  // rendering pauses on the other tabs (world/network stays alive). Lower DPR
  // cap, no shadows, no postprocessing.
  const mobile = useIsMobile();
  const mobileTab = useGame((s) => s.mobileTab);
  const paused = mobile ? mobileTab !== "watch" : mapOpen || menuOpen;
  return (
    <Canvas
      shadows={!mobile}
      dpr={mobile ? [1, MOBILE_DPR_MAX] : [1, DESKTOP_DPR_MAX]}
      camera={{ fov: 34, near: 0.5, far: CAMERA_FAR }}
      // No MSAA: every style composites through the EffectComposer (which
      // renders into non-multisampled targets) and SMAA handles the edges,
      // so default-framebuffer multisampling is pure overhead at high DPR.
      gl={{ antialias: false, powerPreference: "high-performance" }}
      events={pointerLockEvents}
      frameloop={paused ? "never" : "always"}
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
      <AdaptiveQuality maxDpr={mobile ? MOBILE_DPR_MAX : DESKTOP_DPR_MAX} />
      <SunsetAtmosphere>
        <SceneSetup />
        <Lighting />
        <SkyBackdrop />
        <Ocean />
        <CityProxy />
        <Chunks />
        <Interiors />
        <Entities />
        <CombatFx />
        <CameraRig />
        <PlayerInput connection={connection} />
        {!mobile && <Effects />}
      </SunsetAtmosphere>
    </Canvas>
  );
}
