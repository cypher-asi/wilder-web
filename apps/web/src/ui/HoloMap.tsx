// Fullscreen holographic 3D city map (M key). Renders the whole baked city as
// glowing extruded buildings over a bright road network in a dedicated R3F
// canvas (the main game canvas is paused/hidden while this is open).
//
// Controls: drag pan, right-drag rotate, wheel continuous zoom, T toggles a
// straight top-down "2D" view, double-click recenters on the player.

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Bloom, EffectComposer } from "@react-three/postprocessing";
import { RefObject, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import {
  CITY_PARK,
  CITY_PLAZA,
  CITY_ROAD,
  CITY_ROAD_LINE,
  CITY_SIDEWALK,
  CITY_BUILDING,
  CityGeo,
  CityMapManifest,
  getCityGeo,
  getCityGrid,
  getCityMapManifest,
  onCityMapReady,
} from "../game/citymap";
import { CHUNK_SIZE, TILE_SIZE } from "../net/protocol";
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

export function HoloMap() {
  const mapOpen = useGame((s) => s.mapOpen);
  if (!mapOpen) return null;
  return <HoloMapView />;
}

function HoloMapView() {
  const view = useRef<HoloView>({
    tx: game.predicted.x,
    tz: game.predicted.z,
    dist: OPEN_DIST,
    yaw: Math.PI / 2, // camera south of target -> north (-Z) is up on screen
    topDown: false,
    follow: true,
    sTx: game.predicted.x,
    sTz: game.predicted.z,
    sDist: OPEN_DIST,
    sPitch: PITCH_3D,
    keys: {},
  });
  const [topDown, setTopDown] = useState(false);
  const drag = useRef<{ x: number; y: number; button: number } | null>(null);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      if (e.code === "Escape") useGame.getState().set({ mapOpen: false });
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
  }, []);

  return (
    <div
      className="map-overlay holo-map"
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
        dpr={[1, 1.5]}
        gl={{ antialias: false, powerPreference: "high-performance" }}
        camera={{ fov: FOV, near: 2, far: 90000 }}
        style={{ position: "absolute", inset: 0 }}
      >
        <HoloScene view={view} />
      </Canvas>
      <div className="map-overlay-title">WILDER CITY</div>
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
      <div className="map-overlay-hint">
        WASD / DRAG pan · RIGHT-DRAG rotate · WHEEL zoom · T view · DOUBLE-CLICK
        center on player · M / ESC close
      </div>
      <PositionBadge />
    </div>
  );
}

function HoloScene({ view }: { view: RefObject<HoloView> }) {
  return (
    <>
      <color attach="background" args={["#010409"]} />
      <HoloCamera view={view} />
      <HoloCity />
      <SafeZoneOutline />
      <PlayerMarker view={view} />
      <ExtractionMarkers view={view} />
      <DistrictLabels />
      <EffectComposer multisampling={0}>
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

interface CityAssets {
  ground: THREE.Mesh;
  buildings: THREE.Mesh;
  streets: THREE.Mesh;
  buildingMat: THREE.ShaderMaterial;
}

let cityAssetsPromise: Promise<CityAssets> | null = null;

function loadCityAssets(): Promise<CityAssets> {
  cityAssetsPromise ??= (async () => {
    const [geo] = await Promise.all([
      getCityGeo(),
      new Promise<void>((resolve) => onCityMapReady(resolve)),
    ]);
    const { mesh, mat } = buildBuildings(geo);
    return { ...buildGround(), buildings: mesh, streets: buildStreets(geo), buildingMat: mat };
  })();
  return cityAssetsPromise;
}

/** Faint land-fabric plane (sidewalks, plazas, parks, island silhouette):
 * half-res intensity texture from the tile grid. Roads come from the real
 * street mesh, so they stay dim here. */
function buildGround(): { ground: THREE.Mesh } {
  const g = getCityGrid()!;
  const lut = new Uint8Array(8);
  lut[CITY_ROAD] = 60;
  lut[CITY_ROAD_LINE] = 60;
  lut[CITY_SIDEWALK] = 78;
  lut[CITY_PLAZA] = 58;
  lut[CITY_BUILDING] = 30;
  lut[CITY_PARK] = 20;
  const w2 = g.width >> 1;
  const h2 = g.height >> 1;
  const data = new Uint8Array(w2 * h2);
  const t = g.tiles;
  for (let y = 0; y < h2; y++) {
    const r0 = y * 2 * g.width;
    const r1 = r0 + g.width;
    for (let x = 0; x < w2; x++) {
      const i0 = r0 + x * 2;
      const i1 = r1 + x * 2;
      // Max-pool 2x2 so 1-tile roads survive the downsample.
      data[y * w2 + x] = Math.max(lut[t[i0]], lut[t[i0 + 1]], lut[t[i1]], lut[t[i1 + 1]]);
    }
  }
  const tex = new THREE.DataTexture(data, w2, h2, THREE.RedFormat, THREE.UnsignedByteType);
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;

  const sizeX = g.width * TILE_SIZE;
  const sizeZ = g.height * TILE_SIZE;
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTex: { value: tex },
      uOrigin: { value: new THREE.Vector2(g.tileMinX * TILE_SIZE, g.tileMinZ * TILE_SIZE) },
      uSize: { value: new THREE.Vector2(sizeX, sizeZ) },
      uColor: { value: new THREE.Color(0.16, 0.6, 0.85) },
      uGain: { value: 1 },
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
      void main() {
        vec2 uv = (vWorld.xz - uOrigin) / uSize;
        float k = texture2D(uTex, uv).r;
        // Squared response keeps the land fabric faint; water stays black so
        // the island silhouette comes from the tiles, not the plane bounds.
        vec3 col = uColor * (k * k * 0.8 * uGain);
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
  return { ground: mesh };
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
      uGain: { value: 1 },
    },
    vertexShader: /* glsl */ `
      attribute float aRelH;
      attribute float aGlow;
      varying float vH;
      varying float vGlow;
      varying float vWorldY;
      void main() {
        vH = aRelH;
        vGlow = aGlow * 1.6;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldY = wp.y;
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
      void main() {
        // Story bands every 3 m give the stacked-floor hologram texture.
        float story = 0.65 + 0.35 * step(0.55, fract(vWorldY / 3.0));
        float grad = mix(0.12, 0.55, vH * vH);
        // Slow vertical scan pulse rolling up the skyline.
        float scan = 1.0 + 0.15 * sin(vWorldY * 0.12 - uTime * 1.6);
        float i = vGlow * story * grad * scan * uGain;
        gl_FragColor = vec4(uColor * i, 1.0);
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
  });
  const mesh = new THREE.Mesh(geo, mat);
  // Lift a touch above the ground plane so streets never z-fight with it.
  mesh.position.y = 0.5;
  mesh.frustumCulled = false;
  return mesh;
}

function HoloCity() {
  const [assets, setAssets] = useState<CityAssets | null>(null);
  useEffect(() => {
    let alive = true;
    void loadCityAssets().then((a) => alive && setAssets(a));
    return () => {
      alive = false;
    };
  }, []);
  useFrame(({ clock }) => {
    if (assets) assets.buildingMat.uniforms.uTime.value = clock.elapsedTime;
  });
  if (!assets) return null;
  return (
    <>
      <primitive object={assets.ground} dispose={null} />
      <primitive object={assets.streets} dispose={null} />
      <primitive object={assets.buildings} dispose={null} />
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
