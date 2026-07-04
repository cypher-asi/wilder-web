// Corner minimap (top-right): a live north-up crop of the city tile grid
// centered on the player, with entity blips (NPCs, players, service
// buildings) and the safe-zone outline. Click (or M) opens the fullscreen map.
//
// The base layer is drawn from the raw tile grid (not the baked image):
// dark streets with buildings as glowing outlined shapes, holo-map style.
// It renders into a padded offscreen canvas and only re-renders when the
// player drifts near its edge; per-frame work is a single blit + blips.

import { useEffect, useRef } from "react";
import {
  CITY_BUILDING,
  CITY_PARK,
  CITY_PLAZA,
  CITY_ROAD,
  CITY_ROAD_LINE,
  CITY_SIDEWALK,
  cityMapReady,
  cityTileAt,
  onCityMapReady,
} from "../game/citymap";
import { POI_STYLES } from "../game/poi";
import {
  allRegions,
  MY_FACTION,
  REGION_SIZE,
  syncTerritoryUniforms,
  zoneFlipFreshness,
} from "../game/territory";
import { CHUNK_SIZE, TILE_SIZE } from "../net/protocol";
import { perf } from "../perf/perf";
import { game, useGame } from "../state/game";
import { RED_HEX } from "./colors";

/** Canvas size in CSS px (square panel with notched corners). */
const SIZE = 276;
/** Screen px per world meter. */
const SCALE = 1.62;
/** Extra px margin around the view in the cached base layer. */
const PAD = 28;
const BSIZE = SIZE + PAD * 2;

/** Ground fills: streets and open ground stay dark and slightly transparent so
 *  the world shows through faintly; buildings stay fully opaque. */
const TILE_FILL: Record<number, string> = {
  [CITY_ROAD]: "rgba(3, 7, 16, 0.62)",
  [CITY_ROAD_LINE]: "rgba(7, 16, 34, 0.62)",
  [CITY_SIDEWALK]: "rgba(5, 13, 26, 0.62)",
  [CITY_PLAZA]: "rgba(6, 16, 32, 0.62)",
  [CITY_PARK]: "rgba(4, 16, 26, 0.62)",
  [CITY_BUILDING]: "rgba(6, 12, 22, 0.82)",
};
const WATER_FILL = "rgba(1, 4, 10, 0.62)";

/**
 * RGB triple for a faction's registry color (from the PoiList sent on join);
 * falls back to hostile red for unknown ids.
 */
function factionRgb(id: number): [number, number, number] {
  const info = useGame.getState().factions.find((f) => f.id === id);
  if (!info) return [255, 56, 96];
  return [(info.color >> 16) & 0xff, (info.color >> 8) & 0xff, info.color & 0xff];
}

export function Minimap() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const toggleMap = useGame((s) => s.toggleMap);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let raf = 0;

    // Cached base layer (tiles + building outlines) centered on baseC.
    const base = document.createElement("canvas");
    const bctx = base.getContext("2d")!;
    let baseCx = Infinity;
    let baseCz = Infinity;
    let baseDpr = 0;
    let gridReady = cityMapReady();
    onCityMapReady(() => {
      gridReady = true;
      baseCx = Infinity; // force re-render
    });

    const renderBase = (cx: number, cz: number, dpr: number) => {
      if (base.width !== BSIZE * dpr) {
        base.width = BSIZE * dpr;
        base.height = BSIZE * dpr;
      }
      bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      bctx.clearRect(0, 0, BSIZE, BSIZE);
      if (!gridReady) return;

      const toBase = (wx: number, wz: number): [number, number] => [
        BSIZE / 2 + (wx - cx) * SCALE,
        BSIZE / 2 + (wz - cz) * SCALE,
      ];
      const t = TILE_SIZE;
      const s = t * SCALE;
      const tx0 = Math.floor((cx - BSIZE / 2 / SCALE) / t) - 1;
      const tz0 = Math.floor((cz - BSIZE / 2 / SCALE) / t) - 1;
      const tiles = Math.ceil(BSIZE / s) + 2;

      // Ground fills.
      for (let gz = 0; gz < tiles; gz++) {
        for (let gx = 0; gx < tiles; gx++) {
          const kind = cityTileAt(tx0 + gx, tz0 + gz);
          const [x, y] = toBase((tx0 + gx) * t, (tz0 + gz) * t);
          bctx.fillStyle = TILE_FILL[kind] ?? WATER_FILL;
          bctx.fillRect(x, y, s + 0.5, s + 0.5);
        }
      }

      // Building outlines: stroke every edge where a building tile meets a
      // non-building tile, as one glowing path.
      bctx.beginPath();
      for (let gz = 0; gz < tiles; gz++) {
        for (let gx = 0; gx < tiles; gx++) {
          const tx = tx0 + gx;
          const tz = tz0 + gz;
          if (cityTileAt(tx, tz) !== CITY_BUILDING) continue;
          const [x, y] = toBase(tx * t, tz * t);
          if (cityTileAt(tx, tz - 1) !== CITY_BUILDING) {
            bctx.moveTo(x, y);
            bctx.lineTo(x + s, y);
          }
          if (cityTileAt(tx, tz + 1) !== CITY_BUILDING) {
            bctx.moveTo(x, y + s);
            bctx.lineTo(x + s, y + s);
          }
          if (cityTileAt(tx - 1, tz) !== CITY_BUILDING) {
            bctx.moveTo(x, y);
            bctx.lineTo(x, y + s);
          }
          if (cityTileAt(tx + 1, tz) !== CITY_BUILDING) {
            bctx.moveTo(x + s, y);
            bctx.lineTo(x + s, y + s);
          }
        }
      }
      bctx.strokeStyle = "rgba(255, 255, 255, 0.95)";
      bctx.lineWidth = 1;
      bctx.shadowColor = "rgba(255, 255, 255, 0.9)";
      bctx.shadowBlur = 6;
      bctx.stroke();
      // Second pass without blur sharpens the line over its own glow.
      bctx.shadowBlur = 0;
      bctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
      bctx.stroke();

      baseCx = cx;
      baseCz = cz;
    };

    let lastTerrSync = 0;
    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      perf.begin("ui.minimap");
      // The ground shader's red-tint budget follows the player: re-pick the
      // nearest hostile regions once a second as they move across the map.
      if (now - lastTerrSync > 1000) {
        lastTerrSync = now;
        syncTerritoryUniforms();
      }
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== SIZE * dpr) {
        canvas.width = SIZE * dpr;
        canvas.height = SIZE * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, SIZE, SIZE);

      const px = game.predicted.x;
      const pz = game.predicted.z;

      // Re-render the cached base when the view nears its padded edge.
      const drift = Math.max(Math.abs(px - baseCx), Math.abs(pz - baseCz)) * SCALE;
      if (drift > PAD - 6 || baseDpr !== dpr) {
        renderBase(px, pz, dpr);
        baseDpr = dpr;
      }
      ctx.drawImage(
        base,
        SIZE / 2 - BSIZE / 2 + (baseCx - px) * SCALE,
        SIZE / 2 - BSIZE / 2 + (baseCz - pz) * SCALE,
        BSIZE,
        BSIZE,
      );

      const toScreen = (x: number, z: number): [number, number] => [
        SIZE / 2 + (x - px) * SCALE,
        SIZE / 2 + (z - pz) * SCALE,
      ];

      // Safe-zone outline (chunks |x|,|z| <= 1).
      {
        const [x0, y0] = toScreen(-CHUNK_SIZE, -CHUNK_SIZE);
        const [x1, y1] = toScreen(CHUNK_SIZE * 2, CHUNK_SIZE * 2);
        ctx.strokeStyle = "rgba(79, 195, 255, 0.8)";
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 4]);
        ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
        ctx.setLineDash([]);
      }

      // Controlled territory: translucent cells in the holding faction's
      // registry color (Rebels blue, Forum red, Wapes violet). Allied ground
      // renders too — fainter, so hostile cells still pop — which keeps the
      // map honest against the leaderboard's territory counts.
      for (const { rx, rz, faction } of allRegions()) {
        const [rx0, ry0] = toScreen(rx * REGION_SIZE, rz * REGION_SIZE);
        const [rx1, ry1] = toScreen((rx + 1) * REGION_SIZE, (rz + 1) * REGION_SIZE);
        if (rx1 < 0 || ry1 < 0 || rx0 > SIZE || ry0 > SIZE) continue;
        const [r, g, b] = factionRgb(faction);
        const mine = faction === MY_FACTION;
        // Freshly flipped cells flash brighter before settling to base alpha.
        const fresh = zoneFlipFreshness(rx, rz);
        const fill = (mine ? 0.1 : 0.14) + fresh * 0.4;
        const stroke = (mine ? 0.4 : 0.6) + fresh * 0.4;
        ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${fill})`;
        ctx.fillRect(rx0, ry0, rx1 - rx0, ry1 - ry0);
        ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${stroke})`;
        ctx.lineWidth = 1.5 + fresh * 1.5;
        ctx.strokeRect(rx0, ry0, rx1 - rx0, ry1 - ry0);
      }

      // Entity blips.
      for (const entity of game.entities.values()) {
        if (entity.id === game.localEntityId) continue;
        const [sx, sy] = toScreen(entity.x, entity.z);
        if (sx < -8 || sy < -8 || sx > SIZE + 8 || sy > SIZE + 8) continue;
        if (entity.kind === "Npc" || entity.kind === "Agent") {
          // Faction blip: agents and wild Wapes both use their faction tint
          // (Rebels blue, Forum red, Wapes violet).
          const color =
            entity.tint > 0
              ? `#${entity.tint.toString(16).padStart(6, "0")}`
              : RED_HEX;
          ctx.save();
          ctx.shadowColor = color;
          ctx.shadowBlur = entity.kind === "Npc" ? 6 : 5;
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(sx, sy, 2.38, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        } else if (entity.kind === "Player") {
          // Other players are Rebels: same neon blue as your character.
          ctx.fillStyle = "#40e8ff";
          ctx.beginPath();
          ctx.arc(sx, sy, 3.5, 0, Math.PI * 2);
          ctx.fill();
        } else if (entity.kind === "LootContainer" && entity.variant === 1) {
          // Ammo cache: bright white blip so ammo is easy to find.
          ctx.save();
          ctx.shadowColor = "rgba(255, 255, 255, 0.9)";
          ctx.shadowBlur = 6;
          ctx.fillStyle = "#ffffff";
          ctx.beginPath();
          ctx.arc(sx, sy, 2.6, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        } else if (entity.kind !== "LootContainer" && entity.kind !== "ResourceNode") {
          // Service buildings, each in its taxonomy color (see game/poi.ts).
          ctx.fillStyle = POI_STYLES[entity.kind]?.color ?? "rgba(79, 195, 255, 0.9)";
          ctx.fillRect(sx - 2.5, sy - 2.5, 5, 5);
        }
      }

      // Player marker: a wide FOV cone opening in the facing direction with a
      // bright dot at the player's position, always centered.
      {
        const sx = SIZE / 2;
        const sy = SIZE / 2;
        const halfFov = (80 * Math.PI) / 180 / 2; // ~80 deg field of view
        const range = 34; // cone reach in px
        ctx.save();
        ctx.translate(sx, sy);
        ctx.rotate(game.predicted.yaw);

        // FOV cone: filled translucent wedge + soft edge lines.
        const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, range);
        grad.addColorStop(0, "rgba(140, 210, 255, 0.34)");
        grad.addColorStop(1, "rgba(140, 210, 255, 0)");
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.arc(0, 0, range, -halfFov, halfFov);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = "rgba(180, 230, 255, 0.5)";
        ctx.lineWidth = 1;
        ctx.stroke();

        // Center dot.
        const pulse = 2.8 + Math.sin(now / 260) * 0.5;
        ctx.fillStyle = "#eaf7ff";
        ctx.shadowColor = "rgba(180, 230, 255, 0.9)";
        ctx.shadowBlur = 6;
        ctx.beginPath();
        ctx.arc(0, 0, pulse, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      // North marker.
      ctx.fillStyle = "rgba(234, 247, 255, 0.85)";
      ctx.font = "700 10px dDin, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("N", SIZE / 2, 13);
      perf.end("ui.minimap");
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="minimap-ring" onClick={toggleMap} title="Open map (M)">
      <canvas ref={canvasRef} className="minimap-canvas" style={{ width: SIZE, height: SIZE }} />
      <span className="minimap-key">M</span>
    </div>
  );
}
