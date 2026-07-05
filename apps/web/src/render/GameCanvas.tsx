import { Canvas, events, useThree } from "@react-three/fiber";
import { useEffect } from "react";
import { useIsMobile } from "../mobile/useIsMobile";
import { GameConnection } from "../net/connection";
import { AdaptiveQuality } from "../perf/AdaptiveQuality";
import { PerfTracker } from "../perf/PerfTracker";
import { DESKTOP_DPR_MAX, MOBILE_DPR_MAX } from "../perf/quality";
import { useGame } from "../state/game";
import {
  Effects,
  Lighting,
  MobileEffects,
  SceneSetup,
  SkyBackdrop,
  SunsetAtmosphere,
} from "./Atmosphere";
import { CAMERA_FAR, CameraRig, cameraState } from "./CameraRig";
import { Chunks } from "./Chunks";
import { CityProxy } from "./CityProxy";
import { CombatFx } from "./CombatFx";
import { Entities } from "./Entities";
import { FollowCamera } from "./FollowCamera";
import { Interiors } from "./Interior";
import { Ocean } from "./Ocean";
import { PlayerInput } from "./PlayerInput";

/**
 * R3F stops its global render loop while frameloop="never" and does NOT
 * restart it when the prop flips back to "always": setFrameloop only stores
 * the value, and invalidate() calls that arrived while paused were swallowed
 * by the frameloop === "never" guard. Without this kick the mobile Watch tab
 * (the only unpaused tab) stays frozen on whatever frame the pause left
 * behind. One invalidate per unpause restarts the loop; with frameloop back
 * on "always" it then self-sustains.
 */
function ResumeFrameloop({ paused }: { paused: boolean }) {
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    if (!paused) invalidate();
  }, [paused, invalidate]);
  return null;
}

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
  // Desktop live-watch: the spectate camera follows an owned agent instead of
  // the local avatar. Uses the same follow/explore rig as the mobile Watch tab
  // and, like mobile, replaces the player-driven CameraRig + input sender.
  const watchActive = useGame((s) => s.watchActive) && !mobile;
  const spectating = mobile || watchActive;
  // Backgrounded PWA (visibilitychange -> hidden): stop the frameloop too.
  // Only the mobile shell flips this flag; it stays true on desktop.
  const appVisible = useGame((s) => s.appVisible);
  const paused = mobile
    ? mobileTab !== "watch" || !appVisible
    : // Desktop keeps rendering while watching (menu is closed then anyway).
      !watchActive && (mapOpen || menuOpen);
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
      <ResumeFrameloop paused={paused} />
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
        {/* Mobile joins as a spectator: no local avatar exists, so the
            desktop rig (pointer lock, player follow) and the input sender
            are replaced by the Watch tab's agent follow camera. Desktop
            live-watch swaps to the same follow camera on top of the avatar
            session and suspends the input sender for the duration. */}
        {spectating ? <FollowCamera /> : <CameraRig />}
        {!spectating && <PlayerInput connection={connection} />}
        {/* Mobile gets a minimal post stack (bloom + tone mapping): the tron
            look leans on bloom to turn its thin emissive lines into neon —
            without it the whole style reads near-black. */}
        {mobile ? <MobileEffects /> : <Effects />}
      </SunsetAtmosphere>
    </Canvas>
  );
}
