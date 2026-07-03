// Lightweight frame instrumentation for the in-game performance panel.
//
// Two layers, both allocation-free in steady state:
//  - Frame stats (fps / frame ms / renderer counters): always on; one ring
//    buffer write per frame.
//  - Named CPU sections (perf.begin/end around hot per-frame code): gated by
//    `perf.enabled` (the panel toggles it) so closed-panel cost is a single
//    boolean check per call site.
//
// The PerfTracker component inside the Canvas drives frame rotation; the
// PerfPanel HUD overlay polls snapshot() a few times a second.

import type * as THREE from "three";

/** Rolling window used for avg / p95 frame stats (~2 s at 60 fps). */
const FRAME_WINDOW = 120;
/** EMA factor for per-section smoothed ms (~=20-frame half life). */
const SECTION_SMOOTH = 0.94;

interface Section {
  /** ms accumulated during the in-flight frame (multiple begin/end pairs sum). */
  acc: number;
  /** pending begin() timestamp, 0 when closed. */
  openedAt: number;
  /** smoothed ms/frame for display. */
  avg: number;
  /** worst single frame in the last second-ish (decays). */
  max: number;
}

export interface PerfSectionSnapshot {
  name: string;
  avgMs: number;
  maxMs: number;
}

export interface PerfSnapshot {
  fps: number;
  avgMs: number;
  p95Ms: number;
  /** most recent frame times, oldest first (for the sparkline). */
  frames: number[];
  drawCalls: number;
  triangles: number;
  programs: number;
  geometries: number;
  textures: number;
  dpr: number;
  qualityTier: string;
  sections: PerfSectionSnapshot[];
  sectionsEnabled: boolean;
}

class Perf {
  /** Section timing on/off (driven by the panel; snapshot always works). */
  enabled = false;
  /** Renderer handle, set by PerfTracker on mount. */
  gl: THREE.WebGLRenderer | null = null;
  /** Quality tier label, written by the adaptive-quality system. */
  qualityTier = "high";

  private frames = new Float32Array(FRAME_WINDOW);
  private frameCount = 0;
  private frameCursor = 0;
  private sections = new Map<string, Section>();
  // Renderer counters captured at the last frame rotation (info accumulates
  // across all passes because PerfTracker disables autoReset).
  private drawCalls = 0;
  private triangles = 0;

  begin(name: string): void {
    if (!this.enabled) return;
    let s = this.sections.get(name);
    if (!s) {
      s = { acc: 0, openedAt: 0, avg: 0, max: 0 };
      this.sections.set(name, s);
    }
    s.openedAt = performance.now();
  }

  end(name: string): void {
    if (!this.enabled) return;
    const s = this.sections.get(name);
    if (s && s.openedAt > 0) {
      s.acc += performance.now() - s.openedAt;
      s.openedAt = 0;
    }
  }

  /**
   * Called by PerfTracker at the very start of each frame: folds the previous
   * frame's section accumulators into their displayed averages and captures
   * the renderer counters for the frame that just finished.
   */
  rotate(frameDeltaMs: number): void {
    this.frames[this.frameCursor] = frameDeltaMs;
    this.frameCursor = (this.frameCursor + 1) % FRAME_WINDOW;
    this.frameCount++;

    const info = this.gl?.info;
    if (info) {
      this.drawCalls = info.render.calls;
      this.triangles = info.render.triangles;
      info.reset();
    }

    if (!this.enabled) return;
    for (const s of this.sections.values()) {
      s.avg = s.avg * SECTION_SMOOTH + s.acc * (1 - SECTION_SMOOTH);
      s.max = Math.max(s.acc, s.max * 0.98);
      s.acc = 0;
      s.openedAt = 0;
    }
  }

  snapshot(): PerfSnapshot {
    const n = Math.min(this.frameCount, FRAME_WINDOW);
    const frames: number[] = new Array(n);
    let sum = 0;
    for (let i = 0; i < n; i++) {
      // Oldest first: walk forward from the cursor.
      const v = this.frames[(this.frameCursor + FRAME_WINDOW - n + i) % FRAME_WINDOW];
      frames[i] = v;
      sum += v;
    }
    const sorted = [...frames].sort((a, b) => a - b);
    const avgMs = n > 0 ? sum / n : 0;
    const p95Ms = n > 0 ? sorted[Math.min(n - 1, Math.floor(n * 0.95))] : 0;

    const sections: PerfSectionSnapshot[] = [];
    for (const [name, s] of this.sections) {
      if (s.avg > 0.001 || s.max > 0.001) {
        sections.push({ name, avgMs: s.avg, maxMs: s.max });
      }
    }
    sections.sort((a, b) => b.avgMs - a.avgMs);

    const info = this.gl?.info;
    return {
      fps: avgMs > 0 ? 1000 / avgMs : 0,
      avgMs,
      p95Ms,
      frames,
      drawCalls: this.drawCalls,
      triangles: this.triangles,
      programs: info?.programs?.length ?? 0,
      geometries: info?.memory.geometries ?? 0,
      textures: info?.memory.textures ?? 0,
      dpr: this.gl?.getPixelRatio() ?? 0,
      qualityTier: this.qualityTier,
      sections,
      sectionsEnabled: this.enabled,
    };
  }
}

export const perf = new Perf();

// Handle for dev tooling (tools/probe-perf.mjs reads window.__perf).
declare global {
  interface Window {
    __perf?: Perf;
  }
}
if (typeof window !== "undefined") {
  window.__perf = perf;
}
