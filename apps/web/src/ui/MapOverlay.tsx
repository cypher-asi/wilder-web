// Fullscreen city map (M key): the baked minimap with a live player marker,
// district labels, safe-zone outline, and extraction beacons. Drag to pan,
// wheel to zoom; opens centered on the player.

import { useEffect, useRef, useState } from "react";
import { CityMapManifest, getCityMapManifest } from "../game/citymap";
import { CHUNK_SIZE, TILE_SIZE } from "../net/protocol";
import { game, useGame } from "../state/game";

/** View transform: world meters -> screen px. */
interface View {
  /** World position at the screen center. */
  cx: number;
  cz: number;
  /** Screen pixels per world meter. */
  scale: number;
}

const MIN_SCALE = 0.02;
const MAX_SCALE = 6;

export function MapOverlay() {
  const mapOpen = useGame((s) => s.mapOpen);
  if (!mapOpen) return null;
  return <MapCanvas />;
}

function MapCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [manifest, setManifest] = useState<CityMapManifest | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const viewRef = useRef<View>({ cx: game.predicted.x, cz: game.predicted.z, scale: 1.2 });
  const followRef = useRef(true);
  const drag = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    void getCityMapManifest().then(setManifest);
    const img = new Image();
    img.src = "/citymap/minimap.png";
    img.onload = () => (imageRef.current = img);

    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Escape") useGame.getState().set({ mapOpen: false });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let raf = 0;

    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const view = viewRef.current;
      if (followRef.current) {
        view.cx = game.predicted.x;
        view.cz = game.predicted.z;
      }
      const toScreen = (x: number, z: number): [number, number] => [
        w / 2 + (x - view.cx) * view.scale,
        h / 2 + (z - view.cz) * view.scale,
      ];

      // City image: world meters -> image px via the manifest transform.
      const img = imageRef.current;
      const man = manifest;
      if (img && man) {
        // Image pixel (0,0) is world tile (tileMinX, tileMinZ).
        const originX = man.tileMinX * man.tileSize;
        const originZ = man.tileMinZ * man.tileSize;
        const metersPerPx = man.tileSize / man.pxPerTile;
        const [sx, sy] = toScreen(originX, originZ);
        const s = view.scale * metersPerPx;
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(img, sx, sy, img.width * s, img.height * s);
      }

      // Safe-zone outline: chunks |x|,|z| <= 1.
      {
        const [x0, y0] = toScreen(-CHUNK_SIZE, -CHUNK_SIZE);
        const [x1, y1] = toScreen(CHUNK_SIZE * 2, CHUNK_SIZE * 2);
        ctx.strokeStyle = "rgba(41, 217, 140, 0.9)";
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 4]);
        ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
        ctx.setLineDash([]);
        if (view.scale > 0.35) {
          ctx.fillStyle = "rgba(41, 217, 140, 0.9)";
          ctx.font = "600 11px system-ui, sans-serif";
          ctx.textAlign = "center";
          ctx.fillText("SAFE ZONE", (x0 + x1) / 2, y0 - 6);
        }
      }

      // District labels.
      if (man && view.scale < 1.5) {
        ctx.font = "600 12px system-ui, sans-serif";
        ctx.textAlign = "center";
        for (const d of man.districts) {
          const [sx, sy] = toScreen(d.x, d.z);
          if (sx < -80 || sy < -20 || sx > w + 80 || sy > h + 20) continue;
          ctx.fillStyle = "rgba(255,255,255,0.55)";
          ctx.fillText(d.name, sx, sy);
        }
      }

      // Extraction beacons + hub stations (from replicated entities in view).
      for (const entity of game.entities.values()) {
        if (entity.kind !== "ExtractionPoint") continue;
        const [sx, sy] = toScreen(entity.x, entity.z);
        ctx.fillStyle = "#ffd24a";
        ctx.beginPath();
        ctx.moveTo(sx, sy - 5);
        ctx.lineTo(sx + 5, sy);
        ctx.lineTo(sx, sy + 5);
        ctx.lineTo(sx - 5, sy);
        ctx.closePath();
        ctx.fill();
      }

      // Player marker: pulsing dot + facing wedge.
      {
        const [sx, sy] = toScreen(game.predicted.x, game.predicted.z);
        const pulse = 6 + Math.sin(now / 260) * 1.5;
        ctx.fillStyle = "rgba(64, 232, 255, 0.25)";
        ctx.beginPath();
        ctx.arc(sx, sy, pulse + 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.save();
        ctx.translate(sx, sy);
        ctx.rotate(game.predicted.yaw);
        ctx.fillStyle = "#40e8ff";
        ctx.beginPath();
        ctx.moveTo(pulse + 2, 0);
        ctx.lineTo(-pulse * 0.6, pulse * 0.62);
        ctx.lineTo(-pulse * 0.25, 0);
        ctx.lineTo(-pulse * 0.6, -pulse * 0.62);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [manifest]);

  return (
    <div className="map-overlay">
      <canvas
        ref={canvasRef}
        className="map-canvas"
        onPointerDown={(e) => {
          drag.current = { x: e.clientX, y: e.clientY };
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          const view = viewRef.current;
          followRef.current = false;
          view.cx -= (e.clientX - drag.current.x) / view.scale;
          view.cz -= (e.clientY - drag.current.y) / view.scale;
          drag.current = { x: e.clientX, y: e.clientY };
        }}
        onPointerUp={() => (drag.current = null)}
        onWheel={(e) => {
          const view = viewRef.current;
          const factor = Math.exp(-e.deltaY * 0.0012);
          view.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale * factor));
        }}
        onDoubleClick={() => {
          followRef.current = true;
        }}
      />
      <div className="map-overlay-title">WILDER CITY</div>
      <div className="map-overlay-hint">
        DRAG pan · WHEEL zoom · DOUBLE-CLICK center on player · M / ESC close
      </div>
      <PositionBadge />
    </div>
  );
}

/** Small live readout of the player's world position on the map. */
function PositionBadge() {
  const [pos, setPos] = useState({ x: 0, z: 0 });
  useEffect(() => {
    const timer = setInterval(
      () => setPos({ x: game.predicted.x, z: game.predicted.z }),
      250,
    );
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="map-overlay-pos">
      {pos.x.toFixed(0)}, {pos.z.toFixed(0)} · tile {Math.floor(pos.x / TILE_SIZE)},{" "}
      {Math.floor(pos.z / TILE_SIZE)}
    </div>
  );
}
