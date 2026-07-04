// Fullscreen holographic 3D city map (M key). Renders the whole baked city as
// glowing extruded buildings over a bright road network in a dedicated R3F
// canvas (the main game canvas is paused/hidden while this is open).
//
// Controls: drag pan, right-drag rotate, wheel continuous zoom, T toggles a
// straight top-down "2D" view, double-click recenters on the player.

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Bloom, EffectComposer } from "@react-three/postprocessing";
import { RefObject, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import {
  CITY_PARK,
  CITY_PLAZA,
  CITY_ROAD,
  CITY_ROAD_LINE,
  CITY_SIDEWALK,
  CITY_BUILDING,
  CITY_WATER,
  CityGeo,
  CityMapManifest,
  getCityGeo,
  getCityGrid,
  getCityMapManifest,
  onCityMapReady,
} from "../game/citymap";
import { POI_STYLES, LEGEND_CATEGORIES, CATEGORY_COLOR, type LegendCategory } from "../game/poi";
import { allRegions, MY_FACTION, REGION_SIZE } from "../game/territory";
import { GameConnection } from "../net/connection";
import {
  AgentBlip,
  CHUNK_SIZE,
  DangerLevel,
  FactionId,
  FactionInfo,
  TILE_SIZE,
} from "../net/protocol";
import { cameraState } from "../render/CameraRig";
import { game, useGame } from "../state/game";

const FOV = 40;
const MIN_DIST = 60;
const MAX_DIST = 40000;
/** Opening zoom: most of the island in frame. */
const OPEN_DIST = 9000;
const PITCH_3D = 0.6; // ~34 deg, matches the tilted hologram look
const PITCH_TOP = 1.5; // ~86 deg: visually top-down, camera up stays stable

/** Camera view model (targets; smoothed actuals live alongside). */
interface HoloView {
  tx: number;
  tz: number;
  dist: number;
  yaw: number;
  topDown: boolean;
  follow: boolean;
  sTx: number;
  sTz: number;
  sDist: number;
  sPitch: number;
  /** Held WASD/arrow pan keys. */
  keys: Record<string, boolean>;
}

/** Map layer visibility toggles (the M-mode filter panel). */
interface MapFilters {
  /** Player blips from the intel stream. */
  players: boolean;
  /** Agent/Wape blips per faction id (Wapes are a registered faction). */
  factions: Record<FactionId, boolean>;
  /** Service building badges. */
  pois: boolean;
  /** Building volumes (the holographic city mass). */
  buildings: boolean;
  /** Resource zoning labels. */
  zones: boolean;
  /** Faction territory control overlay. */
  territory: boolean;
  /** District danger-level (intensity) overlay. */
  danger: boolean;
}

const DEFAULT_FILTERS: MapFilters = {
  players: true,
  factions: {},
  pois: true,
  buildings: true,
  zones: true,
  territory: true,
  danger: false,
};

/** Effective visibility for a faction's blips (default on). */
function factionOn(filters: MapFilters, id: FactionId): boolean {
  return filters.factions[id] ?? true;
}

export function HoloMap({ connection }: { connection: GameConnection }) {
  const mapOpen = useGame((s) => s.menuOpen && s.menuTab === "map");
  // Stay mounted after the first open: reopening then skips WebGL context
  // creation, shader compiles, and the whole React scene remount, so M is
  // instant. While closed the canvas is display:none with a stopped frameloop.
  const opened = useRef(false);
  if (mapOpen) opened.current = true;
  if (!opened.current) return null;
  return <HoloMapView open={mapOpen} connection={connection} />;
}

function HoloMapView({ open, connection }: { open: boolean; connection: GameConnection }) {
  const view = useRef<HoloView>({
    tx: game.predicted.x,
    tz: game.predicted.z,
    dist: OPEN_DIST,
    yaw: Math.PI, // camera west of target -> north (-Z) points left on screen
    topDown: false,
    follow: true,
    sTx: game.predicted.x,
    sTz: game.predicted.z,
    sDist: OPEN_DIST,
    sPitch: PITCH_3D,
    keys: {},
  });
  const [topDown, setTopDown] = useState(false);
  const [filters, setFilters] = useState<MapFilters>(DEFAULT_FILTERS);
  const drag = useRef<{ x: number; y: number; button: number } | null>(null);

  // Whole-map intel (actor blips) streams only while the map is open.
  useEffect(() => {
    if (!open) return;
    connection.send({ t: "MapIntelSub", d: { on: true } });
    return () => {
      connection.send({ t: "MapIntelSub", d: { on: false } });
    };
  }, [open, connection]);

  useEffect(() => {
    if (!open) return;
    // Each open starts fresh on the player, matching the old mount-per-open
    // behavior (the component now stays mounted across opens).
    const v = view.current;
    v.tx = v.sTx = game.predicted.x;
    v.tz = v.sTz = game.predicted.z;
    v.dist = v.sDist = OPEN_DIST;
    v.yaw = Math.PI;
    v.topDown = false;
    v.follow = true;
    v.sPitch = PITCH_3D;
    v.keys = {};
    setTopDown(false);
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      if (e.code === "Escape") {
        // Escape spent on closing the menu: don't let the relock/unlock
        // bounce read as an "open game menu" Escape (see CameraRig).
        cameraState.suppressMenuUntil = performance.now() + 1500;
        useGame.getState().closeMenu();
      }
      if (e.code === "KeyT") {
        setTopDown((t) => {
          view.current.topDown = !t;
          return !t;
        });
      }
      view.current.keys[e.code] = true;
    };
    const onKeyUp = (e: KeyboardEvent) => {
      view.current.keys[e.code] = false;
    };
    const onBlur = () => (view.current.keys = {});
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [open]);

  return (
    <div
      className="map-overlay holo-map"
      style={{ display: open ? undefined : "none" }}
      onContextMenu={(e) => e.preventDefault()}
      onPointerDown={(e) => {
        drag.current = { x: e.clientX, y: e.clientY, button: e.button };
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        const v = view.current;
        const dx = e.clientX - drag.current.x;
        const dy = e.clientY - drag.current.y;
        drag.current.x = e.clientX;
        drag.current.y = e.clientY;
        if (drag.current.button === 2) {
          v.yaw -= dx * 0.004;
          return;
        }
        v.follow = false;
        // Meters per screen pixel at the look-at plane.
        const mpp =
          (2 * v.sDist * Math.tan((FOV * Math.PI) / 360)) / window.innerHeight;
        // Screen right / screen up projected onto the ground.
        const rx = Math.sin(v.yaw);
        const rz = -Math.cos(v.yaw);
        const ux = -Math.cos(v.yaw);
        const uz = -Math.sin(v.yaw);
        v.tx += (-rx * dx + ux * dy) * mpp;
        v.tz += (-rz * dx + uz * dy) * mpp;
      }}
      onPointerUp={() => (drag.current = null)}
      onWheel={(e) => {
        const v = view.current;
        v.dist = Math.min(
          MAX_DIST,
          Math.max(MIN_DIST, v.dist * Math.exp(e.deltaY * 0.0012)),
        );
      }}
      onDoubleClick={() => (view.current.follow = true)}
    >
      <Canvas
        dpr={[1, 2]}
        gl={{ antialias: true, powerPreference: "high-performance" }}
        camera={{ fov: FOV, near: 2, far: 90000 }}
        style={{ position: "absolute", inset: 0 }}
        frameloop={open ? "always" : "never"}
      >
        <HoloScene view={view} filters={filters} />
      </Canvas>
      <MapFilterPanel filters={filters} setFilters={setFilters} />
      <MapLegend />
      <button
        className="map-view-toggle"
        onClick={() => {
          setTopDown((t) => {
            view.current.topDown = !t;
            return !t;
          });
        }}
      >
        {topDown ? "VIEW: TOP-DOWN" : "VIEW: 3D"} <span className="action-key">T</span>
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Territory recolor: enemy-held regions repaint the holographic geometry with
// the holder's faction color (instead of a translucent square overlay). One
// region-grid ownership texture feeds the ground, building, and street shaders;
// each samples it by world XZ and swaps the base blue holo color for the enemy
// hue, normalized to the base luminance so the glow reads the same in any color.
// ---------------------------------------------------------------------------

/** Shared uniforms referenced by all three holo materials, updated in place. */
const holoTerr = {
  uTerrTex: { value: null as THREE.DataTexture | null },
  uTerrOrigin: { value: new THREE.Vector2() },
  uTerrGrid: { value: new THREE.Vector2(1, 1) },
  uRegionSize: { value: REGION_SIZE },
  uTerrEnabled: { value: 1 },
};

function makeTerrTexture(w: number, h: number, data: Uint8Array): THREE.DataTexture {
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}
// Seed a 1x1 empty texture so the sampler uniform is never null before the
// first ownership update lands.
holoTerr.uTerrTex.value = makeTerrTexture(1, 1, new Uint8Array([0, 0, 0, 0]));

/** GLSL: uniform block + terrTint() helper injected into each holo shader. */
const TERR_TINT_GLSL = /* glsl */ `
uniform sampler2D uTerrTex;
uniform vec2 uTerrOrigin;
uniform vec2 uTerrGrid;
uniform float uRegionSize;
uniform float uTerrEnabled;
vec3 terrTint(vec3 base, vec2 wxz) {
  if (uTerrEnabled < 0.5) return base;
  vec2 uv = (floor(wxz / uRegionSize) - uTerrOrigin + 0.5) / uTerrGrid;
  vec4 t = texture2D(uTerrTex, uv);
  if (t.a < 0.5) return base;
  // Preserve the base holo luminance so the enemy hue glows/blooms the same.
  float bl = dot(base, vec3(0.2126, 0.7152, 0.0722));
  float fl = max(dot(t.rgb, vec3(0.2126, 0.7152, 0.0722)), 1e-3);
  return t.rgb * (bl / fl);
}
`;

/** Wire holoTerr's shared uniforms into a material's uniform map. */
function attachTerrUniforms(u: Record<string, THREE.IUniform>): void {
  u.uTerrTex = holoTerr.uTerrTex;
  u.uTerrOrigin = holoTerr.uTerrOrigin;
  u.uTerrGrid = holoTerr.uTerrGrid;
  u.uRegionSize = holoTerr.uRegionSize;
  u.uTerrEnabled = holoTerr.uTerrEnabled;
}

/** Rebuild the region-ownership texture from the current control map: one
 * texel per region across the whole city grid, RGB = enemy faction color and
 * alpha = 1 for hostile-held cells (the player's own faction stays blue). */
function updateHoloTerritoryTexture(factions: FactionInfo[]): void {
  const grid = getCityGrid();
  if (!grid) return;
  const minX = Math.floor((grid.tileMinX * TILE_SIZE) / REGION_SIZE);
  const maxX = Math.floor(((grid.tileMinX + grid.width) * TILE_SIZE) / REGION_SIZE);
  const minZ = Math.floor((grid.tileMinZ * TILE_SIZE) / REGION_SIZE);
  const maxZ = Math.floor(((grid.tileMinZ + grid.height) * TILE_SIZE) / REGION_SIZE);
  const w = maxX - minX + 1;
  const h = maxZ - minZ + 1;
  const data = new Uint8Array(w * h * 4);
  for (const { rx, rz, faction } of allRegions()) {
    if (faction === MY_FACTION) continue;
    if (rx < minX || rx > maxX || rz < minZ || rz > maxZ) continue;
    const color = factions.find((f) => f.id === faction)?.color ?? 0xff3860;
    const o = ((rz - minZ) * w + (rx - minX)) * 4;
    data[o] = (color >> 16) & 0xff;
    data[o + 1] = (color >> 8) & 0xff;
    data[o + 2] = color & 0xff;
    data[o + 3] = 255;
  }
  const prev = holoTerr.uTerrTex.value;
  holoTerr.uTerrTex.value = makeTerrTexture(w, h, data);
  prev?.dispose();
  holoTerr.uTerrOrigin.value.set(minX, minZ);
  holoTerr.uTerrGrid.value.set(w, h);
}

/** Keeps the ownership texture fresh (1 Hz poll) and drives the on/off toggle
 * from the TERRITORY filter row. Renders nothing. */
function TerritoryTint({ enabled }: { enabled: boolean }) {
  const factions = useGame((s) => s.factions);
  useEffect(() => {
    holoTerr.uTerrEnabled.value = enabled ? 1 : 0;
  }, [enabled]);
  useEffect(() => {
    let sig = "";
    const poll = () => {
      const next = allRegions()
        .filter((r) => r.faction !== MY_FACTION)
        .map((r) => `${r.rx},${r.rz},${r.faction}`)
        .sort()
        .join("|");
      if (next !== sig) {
        sig = next;
        updateHoloTerritoryTexture(factions);
      }
    };
    poll();
    const timer = setInterval(poll, 1000);
    return () => clearInterval(timer);
  }, [factions]);
  return null;
}

function HoloScene({ view, filters }: { view: RefObject<HoloView>; filters: MapFilters }) {
  return (
    <>
      <color attach="background" args={["#010409"]} />
      <HoloCamera view={view} />
      <HoloCity buildings={filters.buildings} />
      <TerritoryTint enabled={filters.territory} />
      {filters.danger && <DangerLayer />}
      <SafeZoneOutline />
      <PlayerMarker view={view} />
      <ExtractionMarkers view={view} />
      <AmmoMarkers view={view} />
      {filters.pois && <PoiMarkers view={view} />}
      <BlipLayer filters={filters} />
      {filters.zones && <ZoneLabels />}
      <DistrictLabels />
      <EffectComposer multisampling={8}>
        <Bloom
          intensity={0.55}
          luminanceThreshold={0.16}
          luminanceSmoothing={0.3}
          mipmapBlur
          radius={0.6}
        />
      </EffectComposer>
    </>
  );
}

/** Smoothed pan/zoom/pitch camera around a ground look-at target. */
function HoloCamera({ view }: { view: RefObject<HoloView> }) {
  const camera = useThree((s) => s.camera);
  useFrame((_, rawDt) => {
    const v = view.current;
    const dt = Math.min(rawDt, 0.1);
    // WASD/arrow pan across the ground plane, screen-relative, zoom-scaled:
    // W is screen-up (away from the camera), A/D strafe.
    const k = v.keys;
    let mx = 0;
    let mz = 0;
    if (k.KeyW || k.ArrowUp) mz -= 1;
    if (k.KeyS || k.ArrowDown) mz += 1;
    if (k.KeyA || k.ArrowLeft) mx -= 1;
    if (k.KeyD || k.ArrowRight) mx += 1;
    if (mx !== 0 || mz !== 0) {
      v.follow = false;
      const len = Math.hypot(mx, mz);
      const speed = (v.sDist * 0.9 * dt) / len;
      const rx = Math.sin(v.yaw);
      const rz = -Math.cos(v.yaw);
      const fx = -Math.cos(v.yaw);
      const fz = -Math.sin(v.yaw);
      v.tx += (rx * mx - fx * mz) * speed;
      v.tz += (rz * mx - fz * mz) * speed;
    }
    if (v.follow) {
      v.tx = game.predicted.x;
      v.tz = game.predicted.z;
    }
    const t = 1 - Math.exp(-dt * 10);
    v.sTx += (v.tx - v.sTx) * t;
    v.sTz += (v.tz - v.sTz) * t;
    v.sDist += (v.dist - v.sDist) * t;
    const pitch = v.topDown ? PITCH_TOP : PITCH_3D;
    v.sPitch += (pitch - v.sPitch) * t;
    const cosP = Math.cos(v.sPitch);
    camera.position.set(
      v.sTx + v.sDist * cosP * Math.cos(v.yaw),
      v.sDist * Math.sin(v.sPitch),
      v.sTz + v.sDist * cosP * Math.sin(v.yaw),
    );
    camera.lookAt(v.sTx, 0, v.sTz);
  });
  return null;
}

// ---------------------------------------------------------------------------
// City geometry (built once, cached across map opens)
// ---------------------------------------------------------------------------

interface GroundAsset {
  ground: THREE.Mesh;
  groundMat: THREE.ShaderMaterial;
}

interface GeoAssets {
  buildings: THREE.Mesh;
  streets: THREE.Mesh;
  buildingMat: THREE.ShaderMaterial;
  streetMat: THREE.MeshBasicMaterial;
}

let groundPromise: Promise<GroundAsset> | null = null;
let geoAssetsPromise: Promise<GeoAssets> | null = null;

/** Ground plane: the heavy per-tile texture bake runs in a worker so the main
 * thread never blocks; only the cheap texture/mesh creation happens here. */
function loadGroundAsset(): Promise<GroundAsset> {
  groundPromise ??= (async () => {
    await new Promise<void>((resolve) => onCityMapReady(resolve));
    const g = getCityGrid()!;
    const lut = new Uint8Array(8);
    lut[CITY_ROAD] = 60;
    lut[CITY_ROAD_LINE] = 60;
    lut[CITY_SIDEWALK] = 78;
    lut[CITY_PLAZA] = 58;
    lut[CITY_BUILDING] = 30;
    lut[CITY_PARK] = 20;
    const worker = new Worker(new URL("./holoGround.worker.ts", import.meta.url), {
      type: "module",
    });
    // Copy the tiles so transferring the buffer doesn't detach the shared grid.
    const tiles = g.tiles.slice();
    const data = await new Promise<Uint8Array>((resolve, reject) => {
      worker.onmessage = (e: MessageEvent<{ data: Uint8Array }>) => resolve(e.data.data);
      worker.onerror = (e) => reject(new Error(e.message));
      worker.postMessage(
        { tiles, width: g.width, height: g.height, lut, water: CITY_WATER },
        [tiles.buffer],
      );
    });
    worker.terminate();
    return buildGround(data);
  })();
  return groundPromise;
}

/** Buildings + streets (both need the ~12 MB geo.bin, so they resolve
 * together, independently of the ground texture). */
function loadGeoAssets(): Promise<GeoAssets> {
  geoAssetsPromise ??= getCityGeo().then((geo) => {
    const { mesh, mat } = buildBuildings(geo);
    const streets = buildStreets(geo);
    return {
      buildings: mesh,
      buildingMat: mat,
      streets,
      streetMat: streets.material as THREE.MeshBasicMaterial,
    };
  });
  return geoAssetsPromise;
}

/** Warm every map asset (geo.bin fetch, worker ground bake, meshes) so the
 * first M press finds everything already cached. Called after join. */
export function prefetchHoloMapAssets(): void {
  void loadGroundAsset().catch((e) => console.error("holo map ground prefetch failed", e));
  void loadGeoAssets().catch((e) => console.error("holo map geo prefetch failed", e));
}

/** Faint land-fabric plane (sidewalks, plazas, parks, island silhouette).
 * Roads come from the real street mesh, so they stay dim here.
 *
 * The island silhouette is cut with a signed distance field baked from the
 * tile grid (in holoGround.worker.ts). The SDF alone is not enough: a
 * diagonal coastline is stored as literal 1-tile stair-steps, and an exact
 * SDF faithfully reproduces those steps with crisp edges. So the field is
 * low-passed (small Gaussian-ish blur) before baking — the blurred zero
 * contour is the smooth line the staircase approximates — and the shader
 * then cuts it with a screen-space fwidth smoothstep for a ~1px anti-aliased
 * edge at any zoom. */
function buildGround(data: Uint8Array): GroundAsset {
  const g = getCityGrid()!;
  const w = g.width;
  const h = g.height;
  const tex = new THREE.DataTexture(data, w, h, THREE.RGFormat, THREE.UnsignedByteType);
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 8; // keep edges crisp at the tilted / grazing map angle
  tex.generateMipmaps = true;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;

  const sizeX = g.width * TILE_SIZE;
  const sizeZ = g.height * TILE_SIZE;
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTex: { value: tex },
      uOrigin: { value: new THREE.Vector2(g.tileMinX * TILE_SIZE, g.tileMinZ * TILE_SIZE) },
      uSize: { value: new THREE.Vector2(sizeX, sizeZ) },
      uColor: { value: new THREE.Color(0.16, 0.6, 0.85) },
      // Starts dark; HoloCity fades it in once the asset arrives.
      uGain: { value: 0 },
      uTerrTex: holoTerr.uTerrTex,
      uTerrOrigin: holoTerr.uTerrOrigin,
      uTerrGrid: holoTerr.uTerrGrid,
      uRegionSize: holoTerr.uRegionSize,
      uTerrEnabled: holoTerr.uTerrEnabled,
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uTex;
      uniform vec2 uOrigin;
      uniform vec2 uSize;
      uniform vec3 uColor;
      uniform float uGain;
      varying vec3 vWorld;
      ${TERR_TINT_GLSL}
      void main() {
        vec2 uv = (vWorld.xz - uOrigin) / uSize;
        vec2 s = texture2D(uTex, uv).rg;
        float k = s.r;
        // Signed distance to the coastline (0.0 at the coast, + inside land).
        float d = s.g - 128.0 / 255.0;
        // Screen-space anti-aliased cut: the smoothstep window tracks the
        // pixel footprint, so the coastline is a smooth curve exactly ~1px
        // wide at any zoom level.
        float aa = max(fwidth(d), 1e-5);
        float edge = smoothstep(-aa, aa, d);
        // Squared response keeps the land fabric faint; water (edge = 0)
        // contributes nothing, so the island silhouette comes from the SDF,
        // not the plane bounds.
        vec3 col = terrTint(uColor, vWorld.xz) * (k * k * 0.8 * uGain) * edge;
        gl_FragColor = vec4(col, 1.0);
      }
    `,
    // Additive: water (black) contributes nothing, so the plane's rectangular
    // bounds are invisible against the background.
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    transparent: true,
  });
  const geo = new THREE.PlaneGeometry(sizeX, sizeZ);
  geo.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(
    (g.tileMinX + g.width / 2) * TILE_SIZE,
    0,
    (g.tileMinZ + g.height / 2) * TILE_SIZE,
  );
  return { ground: mesh, groundMat: mat };
}

/** The actual city blockout building meshes as one additive-glow draw call. */
function buildBuildings(city: CityGeo): { mesh: THREE.Mesh; mat: THREE.ShaderMaterial } {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(city.buildingPos, 3));
  geo.setAttribute("aRelH", new THREE.BufferAttribute(city.buildingRelH, 1, true));
  geo.setAttribute("aGlow", new THREE.BufferAttribute(city.buildingGlow, 1, true));
  geo.setIndex(new THREE.BufferAttribute(city.buildingIdx, 1));

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(0.2, 0.66, 0.95) },
      uTime: { value: 0 },
      // Starts dark; HoloCity fades it in once the asset arrives.
      uGain: { value: 0 },
      uTerrTex: holoTerr.uTerrTex,
      uTerrOrigin: holoTerr.uTerrOrigin,
      uTerrGrid: holoTerr.uTerrGrid,
      uRegionSize: holoTerr.uRegionSize,
      uTerrEnabled: holoTerr.uTerrEnabled,
    },
    vertexShader: /* glsl */ `
      attribute float aRelH;
      attribute float aGlow;
      varying float vH;
      varying float vGlow;
      varying float vWorldY;
      varying vec2 vWorldXZ;
      void main() {
        vH = aRelH;
        vGlow = aGlow * 1.6;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldY = wp.y;
        vWorldXZ = wp.xz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uTime;
      uniform float uGain;
      varying float vH;
      varying float vGlow;
      varying float vWorldY;
      varying vec2 vWorldXZ;
      ${TERR_TINT_GLSL}
      void main() {
        // Story bands every 3 m give the stacked-floor hologram texture.
        // Anti-alias them in screen space with a symmetric triangle wave and
        // fwidth, then fade the pattern to flat where the floors compress below
        // a pixel (grazing / foreshortened walls) so it can't shimmer into
        // "brushed metal" streaks.
        float f = vWorldY / 3.0;
        float w = fwidth(f);
        float tri = abs(fract(f) - 0.5) * 2.0;
        float band = smoothstep(0.5 - w, 0.5 + w, tri);
        float fade = clamp(1.0 - w * 1.5, 0.0, 1.0);
        float story = 0.65 + 0.35 * mix(0.5, band, fade);
        float grad = mix(0.12, 0.55, vH * vH);
        // Very slow, subtle vertical scan (gentle so it never visibly blinks).
        float scan = 1.0 + 0.05 * sin(vWorldY * 0.12 - uTime * 1.2);
        float i = vGlow * story * grad * scan * uGain;
        gl_FragColor = vec4(terrTint(uColor, vWorldXZ) * i, 1.0);
      }
    `,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    transparent: true,
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  return { mesh, mat };
}

/** The actual street polygons (including elevated overpasses) as glow lines. */
function buildStreets(city: CityGeo): THREE.Mesh {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(city.streetPos, 3));
  const mat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(0.1, 0.38, 0.58),
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    transparent: true,
    side: THREE.DoubleSide,
    // Starts invisible; HoloCity fades it in once the asset arrives.
    opacity: 0,
  });
  // Enemy territory recolors the road grid too: inject a world-XZ varying and
  // run diffuse through terrTint. Opacity fade-in (streetMat.opacity) is
  // untouched, so this is a pure hue swap.
  mat.onBeforeCompile = (shader) => {
    attachTerrUniforms(shader.uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec2 vStreetXZ;")
      .replace(
        "#include <project_vertex>",
        "#include <project_vertex>\nvStreetXZ = (modelMatrix * vec4(transformed, 1.0)).xz;",
      );
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\nvarying vec2 vStreetXZ;\n${TERR_TINT_GLSL}`)
      .replace(
        "#include <color_fragment>",
        "#include <color_fragment>\ndiffuseColor.rgb = terrTint(diffuseColor.rgb, vStreetXZ);",
      );
  };
  mat.customProgramCacheKey = () => "holo-street-terr";
  const mesh = new THREE.Mesh(geo, mat);
  // Lift a touch above the ground plane so streets never z-fight with it.
  mesh.position.y = 0.5;
  mesh.frustumCulled = false;
  return mesh;
}

/** City fabric, rendered progressively: each piece (ground texture, building
 * + street meshes) mounts as soon as its own load resolves and fades in, so
 * the map overlay and markers are usable immediately even on a cold start. */
function HoloCity({ buildings = true }: { buildings?: boolean }) {
  const [ground, setGround] = useState<GroundAsset | null>(null);
  const [geoAssets, setGeoAssets] = useState<GeoAssets | null>(null);
  useEffect(() => {
    let alive = true;
    void loadGroundAsset()
      .then((a) => alive && setGround(a))
      .catch((e) => console.error("holo map ground failed", e));
    void loadGeoAssets()
      .then((a) => alive && setGeoAssets(a))
      .catch((e) => console.error("holo map geo failed", e));
    return () => {
      alive = false;
    };
  }, []);
  useFrame(({ clock }, dt) => {
    // ~0.4s fade-in per piece from the moment it shows up.
    const step = Math.min(dt, 0.1) * 2.5;
    if (ground) {
      const u = ground.groundMat.uniforms.uGain;
      u.value = Math.min(1, u.value + step);
    }
    if (geoAssets) {
      const u = geoAssets.buildingMat.uniforms.uGain;
      u.value = Math.min(1, u.value + step);
      geoAssets.streetMat.opacity = u.value;
      geoAssets.buildingMat.uniforms.uTime.value = clock.elapsedTime;
    }
  });
  return (
    <>
      {ground && <primitive object={ground.ground} dispose={null} />}
      {geoAssets && (
        <>
          <primitive object={geoAssets.streets} dispose={null} />
          <primitive object={geoAssets.buildings} visible={buildings} dispose={null} />
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Overlays: safe zone, player, extraction points, district labels
// ---------------------------------------------------------------------------

function SafeZoneOutline() {
  const points = [
    new THREE.Vector3(-CHUNK_SIZE, 2, -CHUNK_SIZE),
    new THREE.Vector3(CHUNK_SIZE * 2, 2, -CHUNK_SIZE),
    new THREE.Vector3(CHUNK_SIZE * 2, 2, CHUNK_SIZE * 2),
    new THREE.Vector3(-CHUNK_SIZE, 2, CHUNK_SIZE * 2),
    new THREE.Vector3(-CHUNK_SIZE, 2, -CHUNK_SIZE),
  ];
  const geo = new THREE.BufferGeometry().setFromPoints(points);
  return (
    <primitive
      object={new THREE.Line(geo, new THREE.LineBasicMaterial({ color: "#29d98c" }))}
    />
  );
}

/** Pulsing player wedge + ring, scaled with zoom so it's always visible. */
function PlayerMarker({ view }: { view: RefObject<HoloView> }) {
  const group = useRef<THREE.Group>(null);
  const ring = useRef<THREE.Mesh>(null);
  const wedge = useRef<THREE.ShapeGeometry | null>(null);
  if (!wedge.current) {
    const s = new THREE.Shape();
    s.moveTo(1.2, 0);
    s.lineTo(-0.7, 0.7);
    s.lineTo(-0.3, 0);
    s.lineTo(-0.7, -0.7);
    s.closePath();
    wedge.current = new THREE.ShapeGeometry(s);
  }
  useFrame(({ clock }) => {
    const g = group.current;
    if (!g) return;
    g.position.set(game.predicted.x, 3, game.predicted.z);
    const s = Math.min(Math.max(6, view.current.sDist * 0.014), 55);
    g.scale.setScalar(s);
    // Flat group: local +X = world +X, local +Y = world -Z (see AimRing).
    g.rotation.set(-Math.PI / 2, 0, -game.predicted.yaw);
    ring.current?.scale.setScalar(1 + 0.12 * Math.sin(clock.elapsedTime * 4));
  });
  return (
    <group ref={group}>
      <mesh geometry={wedge.current}>
        <meshBasicMaterial
          color={new THREE.Color(0.5, 2.4, 3.0)}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          transparent
        />
      </mesh>
      <mesh ref={ring}>
        <ringGeometry args={[1.35, 1.5, 40]} />
        <meshBasicMaterial
          color={new THREE.Color(0.25, 1.2, 1.5)}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          transparent
          opacity={0.8}
        />
      </mesh>
    </group>
  );
}

/** Amber diamonds on every replicated extraction point. */
function ExtractionMarkers({ view }: { view: RefObject<HoloView> }) {
  const [points, setPoints] = useState<{ id: number; x: number; z: number }[]>([]);
  useEffect(() => {
    const poll = () => {
      const next: { id: number; x: number; z: number }[] = [];
      for (const e of game.entities.values()) {
        if (e.kind === "ExtractionPoint") next.push({ id: e.id, x: e.x, z: e.z });
      }
      setPoints((prev) =>
        prev.length === next.length && prev.every((p, i) => p.id === next[i].id)
          ? prev
          : next,
      );
    };
    poll();
    const timer = setInterval(poll, 500);
    return () => clearInterval(timer);
  }, []);
  const group = useRef<THREE.Group>(null);
  useFrame(({ clock }) => {
    const g = group.current;
    if (!g) return;
    const s = Math.min(Math.max(5, view.current.sDist * 0.011), 45);
    const pulse = 1 + 0.15 * Math.sin(clock.elapsedTime * 3);
    for (const child of g.children) child.scale.setScalar(s * pulse);
  });
  return (
    <group ref={group}>
      {points.map((p) => (
        <mesh key={p.id} position={[p.x, 8, p.z]}>
          <octahedronGeometry args={[1]} />
          <meshBasicMaterial
            color={new THREE.Color(2.2, 1.6, 0.35)}
            blending={THREE.AdditiveBlending}
            depthWrite={false}
            transparent
          />
        </mesh>
      ))}
    </group>
  );
}

/** White markers on every replicated ammo cache so ammo is easy to locate. */
function AmmoMarkers({ view }: { view: RefObject<HoloView> }) {
  const [points, setPoints] = useState<{ id: number; x: number; z: number }[]>([]);
  useEffect(() => {
    const poll = () => {
      const next: { id: number; x: number; z: number }[] = [];
      for (const e of game.entities.values()) {
        if (e.kind === "LootContainer" && e.variant === 1) {
          next.push({ id: e.id, x: e.x, z: e.z });
        }
      }
      setPoints((prev) =>
        prev.length === next.length && prev.every((p, i) => p.id === next[i].id)
          ? prev
          : next,
      );
    };
    poll();
    const timer = setInterval(poll, 500);
    return () => clearInterval(timer);
  }, []);
  const group = useRef<THREE.Group>(null);
  useFrame(({ clock }) => {
    const g = group.current;
    if (!g) return;
    const s = Math.min(Math.max(4, view.current.sDist * 0.009), 36);
    const pulse = 1 + 0.2 * Math.sin(clock.elapsedTime * 4);
    for (const child of g.children) child.scale.setScalar(s * pulse);
  });
  return (
    <group ref={group}>
      {points.map((p) => (
        <mesh key={p.id} position={[p.x, 6, p.z]}>
          <octahedronGeometry args={[1]} />
          <meshBasicMaterial
            color={new THREE.Color(2.0, 2.0, 2.0)}
            blending={THREE.AdditiveBlending}
            depthWrite={false}
            transparent
          />
        </mesh>
      ))}
    </group>
  );
}

// ---------------------------------------------------------------------------
// Living-sim overlays: actor blips, territory control, danger intensity
// ---------------------------------------------------------------------------

/** Registry color for a faction id (fallback white). */
function factionCss(factions: FactionInfo[], id: FactionId): string {
  const f = factions.find((f) => f.id === id);
  return `#${(f?.color ?? 0xffffff).toString(16).padStart(6, "0")}`;
}

/** Players on the intel map: bright cyan-white (bloomed past 1.0). */
const PLAYER_BLIP_COLOR = new THREE.Color(0.7, 2.2, 2.6);

/** One tracked actor between intel snapshots: interpolate from (sx,sz) at t0
 * toward the latest target (tx,tz) over `dur` ms so the blip glides instead of
 * teleporting once a second. */
interface BlipTrack {
  kind: number;
  faction: FactionId;
  /** Actors behind this dot (>1 = server-side density cluster). */
  count: number;
  sx: number;
  sz: number;
  tx: number;
  tz: number;
  t0: number;
  dur: number;
  lastSeen: number;
}

/** Scratch color for per-blip brightness scaling (no per-frame allocs). */
const blipScratchColor = new THREE.Color();

/** Whole-map actor blips from the MapIntel stream, as one point cloud.
 * Players read bright cyan-white, agents their faction color, and wild Wapes
 * their faction color dimmed. Positions are interpolated between the ~1 Hz
 * intel snapshots (matched by stable blip id) so the dots visibly move.
 * Snapshots arrive through the `game.mapIntel` module cache (not Zustand):
 * ingest happens inside useFrame when the version bumps, so the ~5 Hz
 * stream never re-renders React. */
function BlipLayer({ filters }: { filters: MapFilters }) {
  const factions = useGame((s) => s.factions);

  const tracks = useRef<Map<number, BlipTrack>>(new Map());
  const lastSnapshot = useRef(0);
  const seenIntelVersion = useRef(-1);
  // Read the latest filters inside useFrame without re-subscribing.
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  // Per-kind blip colors, precomputed per faction registry (looking up and
  // parsing a CSS hex per blip per frame burned CPU on big populations).
  const palette = useMemo(() => {
    const agents = new Map<FactionId, THREE.Color>();
    const wild = new Map<FactionId, THREE.Color>();
    for (const f of factions) {
      const base = new THREE.Color(f.color);
      agents.set(f.id, base.clone().multiplyScalar(1.4));
      wild.set(f.id, base.clone().multiplyScalar(0.45));
    }
    return { agents, wild, fallback: new THREE.Color(0xffffff) };
  }, [factions]);
  const paletteRef = useRef(palette);
  paletteRef.current = palette;

  // Persistent buffers, grown as the actor count climbs.
  const capacity = useRef(0);
  const posAttr = useRef<THREE.BufferAttribute | null>(null);
  const colAttr = useRef<THREE.BufferAttribute | null>(null);

  const ensureCapacity = (n: number) => {
    if (n <= capacity.current) return;
    const cap = Math.max(64, 1 << Math.ceil(Math.log2(n)));
    capacity.current = cap;
    posAttr.current = new THREE.BufferAttribute(new Float32Array(cap * 3), 3);
    colAttr.current = new THREE.BufferAttribute(new Float32Array(cap * 3), 3);
    posAttr.current.setUsage(THREE.DynamicDrawUsage);
    colAttr.current.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("position", posAttr.current);
    geometry.setAttribute("color", colAttr.current);
  };

  const geometry = useMemo(() => {
    const geo = new THREE.BufferGeometry();
    geo.setDrawRange(0, 0);
    return geo;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Seed a base buffer so the first render has a valid (empty) position attr.
  if (capacity.current === 0) ensureCapacity(64);

  // Ingest a snapshot: retarget every tracked blip from where it currently
  // sits, spawn new ones, and drop any that vanished.
  const ingest = (blips: AgentBlip[]) => {
    const now = performance.now();
    const dur = lastSnapshot.current
      ? THREE.MathUtils.clamp(now - lastSnapshot.current, 100, 2000)
      : 0;
    lastSnapshot.current = now;
    const m = tracks.current;
    for (const b of blips) {
      const t = m.get(b.id);
      if (t) {
        const k = t.dur > 0 ? Math.min(1, (now - t.t0) / t.dur) : 1;
        t.sx = t.sx + (t.tx - t.sx) * k;
        t.sz = t.sz + (t.tz - t.sz) * k;
        t.tx = b.x;
        t.tz = b.z;
        t.t0 = now;
        t.dur = dur;
        t.kind = b.kind;
        t.faction = b.faction;
        t.count = b.count ?? 1;
        t.lastSeen = now;
      } else {
        m.set(b.id, {
          kind: b.kind,
          faction: b.faction,
          count: b.count ?? 1,
          sx: b.x,
          sz: b.z,
          tx: b.x,
          tz: b.z,
          t0: now,
          dur,
          lastSeen: now,
        });
      }
    }
    for (const [id, t] of m) {
      if (t.lastSeen !== now) m.delete(id);
    }
  };

  useFrame(() => {
    if (game.mapIntel.version !== seenIntelVersion.current) {
      seenIntelVersion.current = game.mapIntel.version;
      ingest(game.mapIntel.blips);
    }
    const p = posAttr.current;
    const co = colAttr.current;
    const f = filtersRef.current;
    const pal = paletteRef.current;
    const now = performance.now();
    let i = 0;
    // Pre-size for the worst case (all tracks visible) so the buffer never
    // reallocates mid-write.
    ensureCapacity(tracks.current.size);
    for (const t of tracks.current.values()) {
      // kind 0 = players, kind 1 = faction agents, kind 2 = wild Wapes.
      // Agents and Wapes are both gated by their faction filter row.
      const show = t.kind === 0 ? f.players : factionOn(f, t.faction);
      if (!show) continue;
      const k = t.dur > 0 ? Math.min(1, (now - t.t0) / t.dur) : 1;
      const x = t.sx + (t.tx - t.sx) * k;
      const z = t.sz + (t.tz - t.sz) * k;
      p!.setXYZ(i, x, 12, z);
      let c =
        t.kind === 0
          ? PLAYER_BLIP_COLOR
          : ((t.kind === 2 ? pal.wild : pal.agents).get(t.faction) ?? pal.fallback);
      if (t.count > 1) {
        // Density clusters glow hotter with population (additive blending
        // turns the brightness into apparent heat on the map).
        const heat = 1 + Math.min(3, Math.log2(t.count) * 0.5);
        c = blipScratchColor.copy(c).multiplyScalar(heat);
      }
      co!.setXYZ(i, c.r, c.g, c.b);
      i++;
    }
    if (p && co) {
      geometry.setDrawRange(0, i);
      p.needsUpdate = true;
      co.needsUpdate = true;
    }
  });

  useEffect(() => () => geometry.dispose(), [geometry]);

  return (
    <points geometry={geometry} frustumCulled={false} renderOrder={8}>
      <pointsMaterial
        size={5}
        sizeAttenuation={false}
        vertexColors
        transparent
        depthTest={false}
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </points>
  );
}

const DANGER_COLOR: Record<DangerLevel, string> = {
  Sanctuary: "#2de08c",
  Guarded: "#4fa8ff",
  Contested: "#ffb02e",
  Warzone: "#ff3860",
};

const DANGER_LABEL: Record<DangerLevel, string> = {
  Sanctuary: "SANCTUARY — no combat",
  Guarded: "GUARDED — home turf, defense only",
  Contested: "CONTESTED — open faction war",
  Warzone: "WARZONE — max risk, boosted yields",
};

/** District danger intensity: a translucent disc per district anchor, sized
 * to roughly half the gap to its nearest neighbor so the discs read as a
 * heat overlay without pretending to be exact Voronoi cells. */
function DangerLayer() {
  const districts = useGame((s) => s.districts);
  const discs = useMemo(() => {
    return districts.map((d) => {
      let nearest = Infinity;
      for (const o of districts) {
        if (o === d) continue;
        const dist = Math.hypot(o.x - d.x, o.z - d.z);
        if (dist < nearest) nearest = dist;
      }
      const radius = THREE.MathUtils.clamp(
        nearest === Infinity ? 600 : nearest * 0.48,
        250,
        1400,
      );
      return { ...d, radius };
    });
  }, [districts]);
  return (
    <group>
      {discs.map((d) => (
        <mesh
          key={d.name}
          position={[d.x, 1, d.z]}
          rotation={[-Math.PI / 2, 0, 0]}
          renderOrder={3}
        >
          <circleGeometry args={[d.radius, 48]} />
          <meshBasicMaterial
            color={DANGER_COLOR[d.danger]}
            transparent
            opacity={0.1}
            depthWrite={false}
            blending={THREE.AdditiveBlending}
            side={THREE.DoubleSide}
          />
        </mesh>
      ))}
      {discs.map((d) => (
        <mesh
          key={`${d.name}-ring`}
          position={[d.x, 1.2, d.z]}
          rotation={[-Math.PI / 2, 0, 0]}
          renderOrder={3}
        >
          <ringGeometry args={[d.radius * 0.985, d.radius, 64]} />
          <meshBasicMaterial
            color={DANGER_COLOR[d.danger]}
            transparent
            opacity={0.55}
            depthWrite={false}
            blending={THREE.AdditiveBlending}
            side={THREE.DoubleSide}
          />
        </mesh>
      ))}
    </group>
  );
}

// ---------------------------------------------------------------------------
// Filter panel (DOM)
// ---------------------------------------------------------------------------

function FilterRow({
  label,
  color,
  on,
  toggle,
}: {
  label: string;
  color?: string;
  on: boolean;
  toggle: () => void;
}) {
  return (
    <div className={`map-filter-row ${on ? "on" : ""}`} onClick={toggle}>
      <span
        className="map-filter-dot"
        style={{ background: on ? (color ?? "var(--accent)") : "transparent", borderColor: color ?? "var(--accent)" }}
      />
      <span className="map-filter-label">{label}</span>
    </div>
  );
}

/** Left-hand layer toggles: who's on the map and which overlays draw. */
function MapFilterPanel({
  filters,
  setFilters,
}: {
  filters: MapFilters;
  setFilters: (f: MapFilters) => void;
}) {
  const factions = useGame((s) => s.factions);
  const districts = useGame((s) => s.districts);
  const set = (patch: Partial<MapFilters>) => setFilters({ ...filters, ...patch });
  return (
    <div
      className="map-filters"
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <div className="map-legend-title">FILTERS</div>
      <div className="map-filter-section">ACTORS</div>
      <FilterRow
        label="PLAYERS"
        color="#9ff4ff"
        on={filters.players}
        toggle={() => set({ players: !filters.players })}
      />
      {factions.map((f) => (
        <FilterRow
          key={f.id}
          label={f.name.toUpperCase()}
          color={factionCss(factions, f.id)}
          on={factionOn(filters, f.id)}
          toggle={() =>
            set({ factions: { ...filters.factions, [f.id]: !factionOn(filters, f.id) } })
          }
        />
      ))}
      <div className="map-filter-section">LAYERS</div>
      <FilterRow
        label="LOCATIONS"
        on={filters.pois}
        toggle={() => set({ pois: !filters.pois })}
      />
      <FilterRow
        label="BUILDINGS"
        on={filters.buildings}
        toggle={() => set({ buildings: !filters.buildings })}
      />
      <FilterRow
        label="ZONING"
        color="#ffd696"
        on={filters.zones}
        toggle={() => set({ zones: !filters.zones })}
      />
      <FilterRow
        label="TERRITORY"
        color="#ff3860"
        on={filters.territory}
        toggle={() => set({ territory: !filters.territory })}
      />
      <FilterRow
        label="INTENSITY"
        color="#ffb02e"
        on={filters.danger}
        toggle={() => set({ danger: !filters.danger })}
      />
      {filters.danger && districts.length > 0 && (
        <div className="map-filter-danger-key">
          {(Object.keys(DANGER_COLOR) as DangerLevel[]).map((lvl) => (
            <div key={lvl} className="map-filter-row" title={DANGER_LABEL[lvl]}>
              <span className="map-filter-dot" style={{ background: DANGER_COLOR[lvl], borderColor: DANGER_COLOR[lvl] }} />
              <span className="map-filter-label">{lvl.toUpperCase()}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Service buildings (POIs) + resource zones + legend
// ---------------------------------------------------------------------------

/** One cached texture per building kind: a colored badge with its glyph. */
const poiBadgeCache = new Map<string, THREE.CanvasTexture>();

function poiBadgeTexture(kind: string, icon: string, color: string): THREE.CanvasTexture {
  let tex = poiBadgeCache.get(kind);
  if (tex) return tex;
  const s = 64;
  const canvas = document.createElement("canvas");
  canvas.width = s;
  canvas.height = s;
  const ctx = canvas.getContext("2d")!;
  // Diamond badge with the kind's accent color and its store icon.
  ctx.translate(s / 2, s / 2);
  ctx.rotate(Math.PI / 4);
  ctx.fillStyle = "rgba(6, 12, 20, 0.9)";
  ctx.fillRect(-19, -19, 38, 38);
  ctx.strokeStyle = color;
  ctx.lineWidth = 3.5;
  ctx.shadowColor = color;
  ctx.shadowBlur = 8;
  ctx.strokeRect(-19, -19, 38, 38);
  ctx.rotate(-Math.PI / 4);
  ctx.shadowBlur = 0;
  // Line icon drawn from the 24x24 viewBox path, centered and scaled to ~28px.
  const size = 28;
  const scale = size / 24;
  ctx.save();
  ctx.translate(-size / 2, -size / 2);
  ctx.scale(scale, scale);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2 / scale;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.stroke(new Path2D(icon));
  ctx.restore();
  tex = new THREE.CanvasTexture(canvas);
  poiBadgeCache.set(kind, tex);
  return tex;
}

/** Screen-fixed-size markers for every service building, from the join-time
 * POI list (visible map-wide, not just inside the streaming radius). */
function PoiMarkers({ view }: { view: RefObject<HoloView> }) {
  const pois = useGame((s) => s.pois);
  const group = useRef<THREE.Group>(null);
  useFrame(() => {
    const g = group.current;
    if (!g) return;
    // Shrink slightly as the camera zooms out so a packed district stays
    // readable without the badges swallowing the city.
    const k = THREE.MathUtils.clamp(0.055 - view.current.sDist * 0.000002, 0.03, 0.055);
    for (const child of g.children) {
      child.scale.set(k, k, 1);
    }
  });
  return (
    <group ref={group}>
      {pois.map((p) => {
        const style = POI_STYLES[p.kind];
        if (!style) return null;
        return (
          <sprite key={p.id} position={[p.x, 14, p.z]} renderOrder={9}>
            <spriteMaterial
              map={poiBadgeTexture(p.kind, style.icon, style.color)}
              transparent
              depthTest={false}
              sizeAttenuation={false}
            />
          </sprite>
        );
      })}
    </group>
  );
}

const zoneLabelCache = new Map<string, THREE.Sprite>();

/** Always-visible dim labels naming the resource zones around the hub. */
function makeZoneLabelSprite(name: string): THREE.Sprite {
  let sprite = zoneLabelCache.get(name);
  if (sprite) return sprite;
  const pad = 10;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  ctx.font = "700 30px system-ui, sans-serif";
  const text = name.toUpperCase();
  const tw = Math.ceil(ctx.measureText(text).width);
  canvas.width = tw + pad * 2;
  canvas.height = 44;
  ctx.font = "700 30px system-ui, sans-serif";
  ctx.textBaseline = "middle";
  ctx.shadowColor = "rgba(255, 176, 64, 0.5)";
  ctx.shadowBlur = 5;
  ctx.fillStyle = "rgba(255, 214, 150, 0.75)";
  ctx.fillText(text, pad, canvas.height / 2);
  const tex = new THREE.CanvasTexture(canvas);
  const mat = new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    depthTest: false,
    sizeAttenuation: false,
    opacity: 0.75,
  });
  sprite = new THREE.Sprite(mat);
  const k = 0.02;
  sprite.scale.set((canvas.width / canvas.height) * k, k, 1);
  sprite.renderOrder = 10;
  zoneLabelCache.set(name, sprite);
  return sprite;
}

function ZoneLabels() {
  const zones = useGame((s) => s.zones);
  return (
    <group>
      {zones.map((z) => (
        <primitive
          key={z.kind}
          object={makeZoneLabelSprite(z.name)}
          position={[z.x, 40, z.z]}
          dispose={null}
        />
      ))}
    </group>
  );
}

/** A single legend entry. `icon` is SVG path data (POIs); `glyph` is a literal
 *  character rendered in the badge (zones/markers without an icon path). */
interface LegendEntry {
  category: LegendCategory;
  label: string;
  desc: string;
  icon?: string;
  glyph?: string;
}

/** Non-POI markers (zones, extraction, ammo) folded into the same categories. */
const STATIC_LEGEND_ENTRIES: LegendEntry[] = [
  { category: "LOGISTICS", label: "EXTRACTION", desc: "Channel to bank loot", glyph: "◆" },
  { category: "COMBAT", label: "AMMO CACHE", desc: "Free 9mm rounds", glyph: "●" },
  { category: "SAFE", label: "SAFE ZONE", desc: "No hostiles, health regen", glyph: "▢" },
  { category: "DANGER", label: "ENEMY TERRITORY", desc: "25% tax on gather & extract", glyph: "▣" },
];

/** DOM legend panel: markers grouped by function under colored category headers. */
function MapLegend() {
  const pois = useGame((s) => s.pois);
  // Only list building kinds that actually exist in the world.
  const kinds = [...new Set(pois.map((p) => p.kind))];
  const entries: LegendEntry[] = [
    ...kinds.flatMap((kind) => {
      const style = POI_STYLES[kind];
      return style
        ? [{ category: style.category, label: style.label, desc: style.desc, icon: style.icon }]
        : [];
    }),
    ...STATIC_LEGEND_ENTRIES,
  ];

  return (
    <div className="map-legend">
      <div className="map-legend-title">LEGEND</div>
      {LEGEND_CATEGORIES.map((cat) => {
        const rows = entries.filter((e) => e.category === cat.id);
        if (rows.length === 0) return null;
        const color = CATEGORY_COLOR[cat.id];
        return (
          <div key={cat.id} className="map-legend-group">
            <div className="map-legend-group-title" style={{ color }}>
              {cat.label}
            </div>
            {rows.map((entry) => (
              <div key={entry.label} className="map-legend-row" title={entry.desc}>
                <span className="map-legend-badge" style={{ borderColor: color, color }}>
                  {entry.icon ? (
                    <svg
                      viewBox="0 0 24 24"
                      width="11"
                      height="11"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d={entry.icon} />
                    </svg>
                  ) : (
                    entry.glyph
                  )}
                </span>
                <span className="map-legend-label">{entry.label}</span>
                <span className="map-legend-desc">{entry.desc}</span>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

const labelCache = new Map<string, THREE.Sprite>();

function makeLabelSprite(name: string): THREE.Sprite {
  let sprite = labelCache.get(name);
  if (sprite) return sprite;
  const pad = 8;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  ctx.font = "700 34px system-ui, sans-serif";
  const tw = Math.ceil(ctx.measureText(name.toUpperCase()).width);
  canvas.width = tw + pad * 2;
  canvas.height = 48;
  ctx.font = "700 34px system-ui, sans-serif";
  ctx.textBaseline = "middle";
  ctx.shadowColor = "rgba(64, 232, 255, 0.6)";
  ctx.shadowBlur = 5;
  ctx.fillStyle = "rgba(190, 235, 255, 0.85)";
  ctx.fillText(name.toUpperCase(), pad, canvas.height / 2);
  const tex = new THREE.CanvasTexture(canvas);
  const mat = new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    depthTest: false,
    sizeAttenuation: false,
    opacity: 0, // revealed on hover
  });
  sprite = new THREE.Sprite(mat);
  const k = 0.024;
  sprite.scale.set((canvas.width / canvas.height) * k, k, 1);
  sprite.renderOrder = 10;
  labelCache.set(name, sprite);
  return sprite;
}

const HOVER_PX = 110;
const labelProj = new THREE.Vector3();

/** District name of the neighborhood under the cursor (nearest, only one). */
function DistrictLabels() {
  const [manifest, setManifest] = useState<CityMapManifest | null>(null);
  useEffect(() => {
    void getCityMapManifest().then(setManifest);
  }, []);
  const group = useRef<THREE.Group>(null);
  useFrame(({ camera, pointer, size }) => {
    const g = group.current;
    if (!g) return;
    // Closest label anchor to the cursor in screen space, within reach.
    let best = -1;
    let bestD = HOVER_PX;
    for (let i = 0; i < g.children.length; i++) {
      labelProj.copy(g.children[i].position).project(camera);
      if (labelProj.z >= 1) continue; // behind the camera
      const dx = ((labelProj.x - pointer.x) * size.width) / 2;
      const dy = ((labelProj.y - pointer.y) * size.height) / 2;
      const d = Math.hypot(dx, dy);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    for (let i = 0; i < g.children.length; i++) {
      const m = (g.children[i] as THREE.Sprite).material as THREE.SpriteMaterial;
      m.opacity += ((i === best ? 0.9 : 0) - m.opacity) * 0.25;
    }
  });
  if (!manifest) return null;
  return (
    <group ref={group}>
      {manifest.districts.map((d) => (
        <primitive
          key={d.name}
          object={makeLabelSprite(d.name)}
          position={[d.x, 60, d.z]}
          dispose={null}
        />
      ))}
    </group>
  );
}