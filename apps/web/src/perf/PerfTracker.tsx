// Frame-boundary driver for the perf registry. Mounts inside the Canvas.
//
// Three probes per frame:
//  - priority -1e9 (first): rotates the registry (previous frame's numbers
//    become visible) and opens the "cpu.scripts" section.
//  - priority 0.99 (after every gameplay useFrame, just before the
//    EffectComposer's render pass at priority 1): closes scripts, opens
//    "cpu.render" — the CPU cost of dispatching the scene + post passes.
//  - priority 1e9 (last): closes "cpu.render".
//
// Note: the >0 priorities imply manual render mode, which is already the
// case everywhere because Effects always mounts an EffectComposer.

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import { perf } from "./perf";

export function PerfTracker() {
  const gl = useThree((s) => s.gl);
  const last = useRef(0);

  useEffect(() => {
    perf.gl = gl;
    // Let renderer.info accumulate across all passes in a frame (scene,
    // reflections, post); the registry resets it manually at frame rotation.
    const prevAutoReset = gl.info.autoReset;
    gl.info.autoReset = false;
    return () => {
      gl.info.autoReset = prevAutoReset;
      if (perf.gl === gl) perf.gl = null;
    };
  }, [gl]);

  useFrame(() => {
    const now = performance.now();
    if (last.current > 0) perf.rotate(now - last.current);
    last.current = now;
    perf.begin("cpu.scripts");
  }, -1e9);

  useFrame(() => {
    perf.end("cpu.scripts");
    perf.begin("cpu.render");
  }, 0.99);

  useFrame(() => {
    perf.end("cpu.render");
  }, 1e9);

  return null;
}
