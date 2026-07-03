// Golden-hour atmosphere, physically based: Bruneton precomputed atmospheric
// scattering for the sky, volumetric clouds, a transmittance-derived sun
// light, and post-processing. (Same stack as three.js PR #33292:
// @takram/three-atmosphere + @takram/three-clouds.)

import { useFrame, useThree } from "@react-three/fiber";
import {
  Bloom,
  BrightnessContrast,
  EffectComposer,
  HueSaturation,
  N8AO,
  SMAA,
  ToneMapping,
  Vignette,
} from "@react-three/postprocessing";
import { ToneMappingMode } from "postprocessing";
import type { SunDirectionalLight } from "@takram/three-atmosphere";
import {
  AerialPerspective,
  Atmosphere,
  Sky,
  SkyLight,
  SunLight,
  type AtmosphereApi,
} from "@takram/three-atmosphere/r3f";
import { Clouds } from "@takram/three-clouds/r3f";
import { Ellipsoid, Geodetic, radians } from "@takram/three-geospatial";
import { useCallback, useMemo, useRef, type ReactNode } from "react";
import * as THREE from "three";
import { game } from "../state/game";
import { tickFacades } from "./facade";

// ---------------------------------------------------------------------------
// Sun & world placement
// ---------------------------------------------------------------------------

/**
 * Golden-hour sun elevation. The physical sky model only produces sunset
 * colors when the sun is actually low, so this sits well under the old
 * hand-painted rig's ~39 deg.
 */
const SUN_ELEVATION = radians(6.5);

/**
 * Low western sun, placed to cross-light the default camera yaw so facades
 * model with warm/cool contrast instead of flat front-light. Shared by the
 * sun light, the physical sky, the clouds, and the PMREM environment.
 */
export const SUN_DIR = (() => {
  const azimuth = new THREE.Vector2(-0.72, 0.28).normalize();
  const cos = Math.cos(SUN_ELEVATION);
  return new THREE.Vector3(azimuth.x * cos, Math.sin(SUN_ELEVATION), azimuth.y * cos);
})();

/**
 * The atmosphere model works in ECEF coordinates, so anchor the flat game
 * world to a Miami-ish spot on the WGS84 ellipsoid (fits Wiami), with local
 * axes X: north, Y: up, Z: east.
 */
const WORLD_TO_ECEF = Ellipsoid.WGS84.getNorthUpEastFrame(
  new Geodetic(radians(-80.19), radians(25.77), 0).toECEF(),
);

const SUN_DIR_ECEF = SUN_DIR.clone().transformDirection(WORLD_TO_ECEF);

/**
 * Context provider for the atmosphere components (sky, clouds, aerial
 * perspective, sun light). Fixed sun direction: perpetual golden hour.
 */
export function SunsetAtmosphere({ children }: { children: ReactNode }) {
  const apiRef = useCallback((api: AtmosphereApi | null) => {
    if (api) {
      api.worldToECEFMatrix.copy(WORLD_TO_ECEF);
      api.sunDirection.copy(SUN_DIR_ECEF);
    }
  }, []);
  return <Atmosphere ref={apiRef}>{children}</Atmosphere>;
}

// ---------------------------------------------------------------------------
// Lighting
// ---------------------------------------------------------------------------

export function Lighting() {
  const sunRef = useRef<SunDirectionalLight>(null);

  useFrame(() => {
    // Keep the shadow camera centered on the player so shadows stay crisp.
    // SunLight recomputes its own position from target + sun direction.
    const sun = sunRef.current;
    if (sun) sun.target.position.set(game.predicted.x, 0, game.predicted.z);
  });

  return (
    <>
      {/* Sun radiance comes from the atmosphere's transmittance LUT, so the
          color/intensity is the physical warm low sun automatically. */}
      <SunLight
        ref={sunRef}
        distance={90}
        intensity={5}
        castShadow
        shadow-mapSize={[4096, 4096]}
        shadow-camera-left={-70}
        shadow-camera-right={70}
        shadow-camera-top={70}
        shadow-camera-bottom={-70}
        shadow-camera-far={260}
        shadow-bias={-0.0002}
        shadow-normalBias={0.5}
      />
      {/* Physical sky irradiance (dusk blue overhead) as a light probe.
          Slightly under 1 so the warm sun stays the dominant modeling light. */}
      <SkyLight intensity={0.9} />
      {/* Cool counter-fill opposite the sun so shadowed faces stay readable.
          Placed far out with the default (origin) target so its direction is
          effectively constant anywhere on the map. Intensities are in the
          physical luminance scale (see EXPOSURE below). */}
      <directionalLight color="#93a9e6" intensity={0.12} position={[3400, 2200, -2600]} />
      {/* faint warm ambient floor so nothing crushes to black */}
      <ambientLight color="#ffd9b0" intensity={0.06} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Sky
// ---------------------------------------------------------------------------

/**
 * Physical sky backdrop, rendered in the scene (a screen quad at far depth)
 * rather than in post so transparent effects blend against it correctly.
 */
export function SkyBackdrop() {
  // groundAlbedo tints the below-horizon ellipsoid (visible past the city
  // edge) so it reads as sunlit hazy ground instead of a black void.
  return <Sky groundAlbedo={GROUND_ALBEDO} />;
}

const GROUND_ALBEDO = new THREE.Color(0.45, 0.36, 0.27);

// ---------------------------------------------------------------------------
// Post-processing
// ---------------------------------------------------------------------------

const WEATHER_VELOCITY = new THREE.Vector2(0.001, 0);
const SHADOW_MAP_SIZE = new THREE.Vector2(256, 256);

export function Effects() {
  return (
    // MSAA off: SMAA handles the edges, which keeps the AO pass cheap.
    <EffectComposer multisampling={0}>
      <N8AO halfRes quality="performance" aoRadius={2.2} intensity={1.4} distanceFalloff={1.5} />
      {/* Volumetric clouds render into buffers here and are composited (with
          atmosphere overlay/shadow routing) by AerialPerspective below. */}
      <Clouds
        qualityPreset="medium"
        resolutionScale={0.75}
        coverage={0.27}
        localWeatherVelocity={WEATHER_VELOCITY}
        shadow-cascadeCount={1}
        shadow-mapSize={SHADOW_MAP_SIZE}
        localWeatherTexture="/clouds/local_weather.png"
        shapeTexture="/clouds/shape.bin"
        shapeDetailTexture="/clouds/shape_detail.bin"
        turbulenceTexture="/clouds/turbulence.png"
        stbnTexture="/clouds/stbn.bin"
      />
      <AerialPerspective stbnTexture="/clouds/stbn.bin" />
      <Bloom intensity={0.55} luminanceThreshold={0.85} luminanceSmoothing={0.3} mipmapBlur />
      {/* The composer disables the renderer's built-in tone mapping, so map
          the physical-luminance HDR buffer to display here (AgX, exposure
          from gl.toneMappingExposure). */}
      <ToneMapping mode={ToneMappingMode.AGX} />
      {/* light golden-hour grade: richer color, gentle contrast */}
      <HueSaturation saturation={0.22} />
      <BrightnessContrast brightness={0.0} contrast={0.1} />
      <SMAA />
      <Vignette eskil={false} offset={0.15} darkness={0.45} />
    </EffectComposer>
  );
}

// ---------------------------------------------------------------------------
// Scene setup: environment map, fog, tone mapping
// ---------------------------------------------------------------------------

/**
 * Scene radiance is in the atmosphere packages' physical luminance scale,
 * displayed through AgX at high exposure (the takram examples use ~10; a bit
 * lower here keeps the sun-facing sky from washing out). Display-referred
 * colors (fog, env gradient) are divided by this so they land at their
 * authored brightness.
 */
const EXPOSURE = 7;
const DISPLAY_TO_SCENE = 1 / EXPOSURE;

// Gradient dusk env: approximates the physical sky for IBL. Kept procedural
// (rather than capturing the real SkyMaterial into a cubemap) because PMREM
// only needs a plausible warm-west/cool-zenith gradient for reflections.
const envSkyMaterial = new THREE.ShaderMaterial({
  side: THREE.BackSide,
  depthWrite: false,
  fog: false,
  uniforms: { uSunDir: { value: SUN_DIR }, uLum: { value: DISPLAY_TO_SCENE } },
  vertexShader: /* glsl */ `
    varying vec3 vDir;
    void main() {
      vDir = normalize(position);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    varying vec3 vDir;
    uniform vec3 uSunDir;
    uniform float uLum;
    void main() {
      vec3 dir = normalize(vDir);
      float h = dir.y;
      vec3 zenith = vec3(0.15, 0.24, 0.44);
      vec3 mid = vec3(0.85, 0.47, 0.28);
      vec3 horizon = vec3(0.98, 0.65, 0.42);
      vec3 sky = mix(mid, zenith, smoothstep(0.08, 0.6, h));
      sky = mix(horizon, sky, smoothstep(-0.02, 0.16, h));
      float sunAmt = clamp(dot(dir, uSunDir), 0.0, 1.0);
      sky += vec3(1.0, 0.66, 0.38) * pow(sunAmt, 6.0) * 0.4;
      sky += vec3(1.0, 0.82, 0.55) * pow(sunAmt, 200.0) * 1.6;
      sky += vec3(1.0, 0.93, 0.8) * smoothstep(0.9994, 0.9998, sunAmt) * 4.0;
      gl_FragColor = vec4(sky * uLum, 1.0);
    }
  `,
});

/**
 * Procedural golden-hour environment map: sunset gradient, a hot sun ball,
 * and a warm ground bounce plane. PMREM-filtered and set as
 * scene.environment so asphalt, glass, and metal pick up warm reflections.
 */
function makeSunsetEnvironment(gl: THREE.WebGLRenderer): THREE.Texture {
  const envScene = new THREE.Scene();
  const sky = new THREE.Mesh(new THREE.SphereGeometry(100, 32, 16), envSkyMaterial);
  envScene.add(sky);

  // Bright sun ball (HDR values) so glossy surfaces get a hot highlight.
  const sun = new THREE.Mesh(
    new THREE.SphereGeometry(5, 16, 16),
    new THREE.MeshBasicMaterial({
      color: new THREE.Color(7.0, 4.0, 1.9).multiplyScalar(DISPLAY_TO_SCENE),
    }),
  );
  sun.position.copy(SUN_DIR).multiplyScalar(90);
  envScene.add(sun);

  // Warm street bounce from below.
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(90, 24).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({
      color: new THREE.Color("#5a4128").multiplyScalar(DISPLAY_TO_SCENE),
    }),
  );
  ground.position.y = -2;
  envScene.add(ground);

  const pmrem = new THREE.PMREMGenerator(gl);
  const env = pmrem.fromScene(envScene, 0.04).texture;
  pmrem.dispose();
  return env;
}

export function SceneSetup() {
  const { scene, gl } = useThree();
  useMemo(() => {
    // Fog color tracks the warm horizon; scaled into the physical range.
    scene.fog = new THREE.FogExp2(
      new THREE.Color("#e8a06a").multiplyScalar(DISPLAY_TO_SCENE),
      0.0035,
    );
    // No flat background color: the SkyBackdrop screen quad covers the sky.
    scene.background = null;
    scene.environment = makeSunsetEnvironment(gl);
    scene.environmentIntensity = 0.6;
    // The EffectComposer forces the renderer to NoToneMapping and the display
    // mapping happens in the ToneMapping effect (AgX), which reads the
    // exposure from here.
    gl.toneMapping = THREE.AgXToneMapping;
    gl.toneMappingExposure = EXPOSURE;
    if (import.meta.env.DEV) {
      (window as unknown as { __gl?: THREE.WebGLRenderer }).__gl = gl;
      (window as unknown as { __scene?: THREE.Scene }).__scene = scene;
    }
  }, [scene, gl]);

  // Drive time-varying facade shaders (window flicker/toggles).
  useFrame(({ clock }) => tickFacades(clock.elapsedTime));
  return null;
}
