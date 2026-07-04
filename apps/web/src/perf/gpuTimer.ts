// Whole-frame GPU timing via EXT_disjoint_timer_query_webgl2.
//
// The extension forbids nested TIME_ELAPSED queries, so this measures the
// full frame (scene + post passes) as one number — enough to tell "the GPU
// is the bottleneck" apart from CPU-side cost. Results resolve a few frames
// late, so a small pool of queries stays in flight and resolved times are
// pushed into the perf registry's EMA as they become available.
//
// Driven by PerfTracker: beginFrame() at the first probe, endFrame() +
// poll() at the last. All calls are cheap no-ops when unsupported.

import type * as THREE from "three";
import { perf } from "./perf";

interface TimerExt {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
}

const POOL_SIZE = 4;

class GpuTimer {
  private gl: WebGL2RenderingContext | null = null;
  private ext: TimerExt | null = null;
  private pool: WebGLQuery[] = [];
  /** Queries submitted and awaiting results, oldest first. */
  private pending: WebGLQuery[] = [];
  private active = false;

  init(renderer: THREE.WebGLRenderer): void {
    this.dispose();
    const ctx = renderer.getContext();
    if (!(ctx instanceof WebGL2RenderingContext)) return;
    const ext = ctx.getExtension("EXT_disjoint_timer_query_webgl2") as TimerExt | null;
    if (!ext) return;
    this.gl = ctx;
    this.ext = ext;
    perf.gpuSupported = true;
  }

  dispose(): void {
    if (this.gl) {
      for (const q of this.pool) this.gl.deleteQuery(q);
      for (const q of this.pending) this.gl.deleteQuery(q);
    }
    this.pool = [];
    this.pending = [];
    this.gl = null;
    this.ext = null;
    this.active = false;
    perf.gpuSupported = false;
  }

  beginFrame(): void {
    const { gl, ext } = this;
    if (!gl || !ext || this.active) return;
    // Cap in-flight queries; skip frames rather than growing the pool.
    if (this.pending.length >= POOL_SIZE) return;
    const query = this.pool.pop() ?? gl.createQuery();
    if (!query) return;
    gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
    this.active = true;
    this.pending.push(query);
  }

  endFrame(): void {
    const { gl, ext } = this;
    if (!gl || !ext || !this.active) return;
    gl.endQuery(ext.TIME_ELAPSED_EXT);
    this.active = false;
    this.poll();
  }

  private poll(): void {
    const { gl, ext } = this;
    if (!gl || !ext) return;
    // A disjoint event (context switch, throttling) invalidates everything
    // currently in flight.
    if (gl.getParameter(ext.GPU_DISJOINT_EXT)) {
      for (const q of this.pending) this.pool.push(q);
      this.pending = [];
      return;
    }
    // Results arrive in submission order; stop at the first unresolved one.
    while (this.pending.length > 0) {
      const query = this.pending[0];
      if (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) break;
      const ns = gl.getQueryParameter(query, gl.QUERY_RESULT) as number;
      perf.pushGpu(ns / 1e6);
      this.pending.shift();
      this.pool.push(query);
    }
  }
}

export const gpuTimer = new GpuTimer();
