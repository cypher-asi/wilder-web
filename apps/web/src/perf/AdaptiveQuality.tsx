// Adaptive resolution + quality tier. drei's PerformanceMonitor samples the
// frame rate and walks a 0..1 factor up or down; we map it onto the render
// DPR (1.0 .. 1.75, quarter steps so canvas resizes stay rare) and a coarse
// tier that expensive systems (shadow maps, reflections, post) subscribe to.

import { PerformanceMonitor } from "@react-three/drei";
import { useThree } from "@react-three/fiber";
import { useCallback } from "react";
import { perf } from "./perf";
import { DESKTOP_DPR_MAX, useQuality, type QualityTier } from "./quality";

const DPR_MIN = 1;

function tierFor(factor: number): QualityTier {
  return factor >= 0.6 ? "high" : factor >= 0.3 ? "medium" : "low";
}

export function AdaptiveQuality({ maxDpr = DESKTOP_DPR_MAX }: { maxDpr?: number }) {
  const setDpr = useThree((s) => s.setDpr);

  const apply = useCallback(
    (factor: number) => {
      const raw = DPR_MIN + (maxDpr - DPR_MIN) * factor;
      const dpr = Math.min(
        Math.round(raw * 4) / 4,
        typeof window !== "undefined" ? window.devicePixelRatio : maxDpr,
      );
      setDpr(dpr);
      const tier = tierFor(factor);
      perf.qualityTier = tier;
      useQuality.getState().setTier(tier);
    },
    [setDpr, maxDpr],
  );

  return (
    <PerformanceMonitor
      // Start at full quality; degrade only when the frame rate says so.
      factor={1}
      ms={250}
      iterations={8}
      step={0.15}
      flipflops={6}
      onChange={({ factor }) => apply(factor)}
      // Too much oscillation: settle on the middle rung permanently.
      onFallback={() => apply(0.5)}
    />
  );
}
