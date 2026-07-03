// Performance panel: closed by default, opened with F3 or the corner chip.
// Shows FPS + frame-time sparkline, renderer counters, and a live table of
// every instrumented per-frame system, sorted most-expensive first. Reads the
// perf registry at 4 Hz so the panel itself stays out of its own numbers.

import { useEffect, useState } from "react";
import { perf, type PerfSnapshot } from "../perf/perf";

const OPEN_KEY = "wilder.perfPanel";

function fmt(ms: number): string {
  return ms >= 10 ? ms.toFixed(1) : ms.toFixed(2);
}

function Sparkline({ frames }: { frames: number[] }) {
  const w = 220;
  const h = 34;
  if (frames.length < 2) return <svg width={w} height={h} />;
  // Fixed 0..33 ms scale so 60 fps sits at the lower third and spikes are
  // obvious; clamp instead of autoscale so the graph doesn't breathe.
  const points = frames
    .map((ms, i) => {
      const x = (i / (frames.length - 1)) * w;
      const y = h - (Math.min(ms, 33.3) / 33.3) * h;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const budgetY = h - (16.7 / 33.3) * h;
  return (
    <svg width={w} height={h} className="perf-spark">
      <line x1={0} y1={budgetY} x2={w} y2={budgetY} className="perf-spark-budget" />
      <polyline points={points} fill="none" className="perf-spark-line" />
    </svg>
  );
}

export function PerfPanel() {
  const [open, setOpen] = useState(
    () => typeof localStorage !== "undefined" && localStorage.getItem(OPEN_KEY) === "1",
  );
  const [snap, setSnap] = useState<PerfSnapshot | null>(null);

  useEffect(() => {
    perf.enabled = open;
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(OPEN_KEY, open ? "1" : "0");
    }
    return () => {
      perf.enabled = false;
    };
  }, [open]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.code === "F3") {
        event.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!open) return;
    setSnap(perf.snapshot());
    const timer = setInterval(() => setSnap(perf.snapshot()), 250);
    return () => clearInterval(timer);
  }, [open]);

  if (!open) {
    return (
      <button
        className="perf-chip"
        onClick={() => setOpen(true)}
        title="Performance panel (F3)"
      >
        FPS
      </button>
    );
  }

  return (
    <div className="perf-panel">
      <div className="perf-head">
        <span className="perf-title">PERFORMANCE</span>
        <span className="perf-key">F3</span>
        <button className="perf-close" onClick={() => setOpen(false)}>
          ×
        </button>
      </div>
      {snap && (
        <>
          <div className="perf-fps-row">
            <span className="perf-fps">{snap.fps.toFixed(0)}</span>
            <span className="perf-fps-unit">fps</span>
            <span className="perf-ms">
              {fmt(snap.avgMs)} ms · p95 {fmt(snap.p95Ms)}
            </span>
          </div>
          <Sparkline frames={snap.frames} />
          <div className="perf-stats">
            <span>draws {snap.drawCalls}</span>
            <span>tris {(snap.triangles / 1e6).toFixed(2)}M</span>
            <span>prog {snap.programs}</span>
            <span>tex {snap.textures}</span>
            <span>dpr {snap.dpr.toFixed(2)}</span>
            <span>tier {snap.qualityTier}</span>
          </div>
          <table className="perf-table">
            <tbody>
              {snap.sections.map((s) => (
                <tr key={s.name}>
                  <td className="perf-sec-name">{s.name}</td>
                  <td className="perf-sec-ms">{fmt(s.avgMs)}</td>
                  <td className="perf-sec-max">{fmt(s.maxMs)}</td>
                </tr>
              ))}
              {snap.sections.length === 0 && (
                <tr>
                  <td className="perf-sec-name">collecting…</td>
                </tr>
              )}
            </tbody>
          </table>
          <div className="perf-foot">section ms: avg / worst</div>
        </>
      )}
    </div>
  );
}
