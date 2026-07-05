// Atmosphere with switchable visual styles.
//
// "golden" is the physically based golden-hour stack: Bruneton precomputed
// atmospheric scattering for the sky, volumetric clouds, a transmittance-
// derived sun light, and post-processing (same stack as three.js PR #33292:
// @takram/three-atmosphere + @takram/three-clouds).
//
// The anime styles replace all of that with a hand-painted sky dome shader
// (gradient + painterly FBM clouds + stars/moon/sun), a simple three-light
// rig, and a lighter post stack (no AO, no volumetric clouds) so they render
// meaningfully faster.

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
import { BloomEffect, ToneMappingMode } from "postprocessing";
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
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type ComponentProps,
  type ReactNode,
} from "react";
import * as THREE from "three";
import { perf } from "../perf/perf";
import { animeShadowSize, goldenShadowSize, useQuality } from "../perf/quality";
import { game, useGame } from "../state/game";
import { tickFacades } from "./facade";
import {
  applyStyle,
  STYLES,
  styleUniforms,
  type AnimeSkySpec,
  type VisualStyle,
} from "./styles";

// ---------------------------------------------------------------------------
// Sun & world placement (golden style)
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

function useVisualStyle(): VisualStyle {
  return STYLES[useGame((s) => s.visualStyle)];
}

/**
 * Context provider for the physical atmosphere components (sky, clouds,
 * aerial perspective, sun light). Fixed sun direction: perpetual golden hour.
 * Always mounted so switching styles doesn't remount the whole scene graph;
 * the physical consumers (Sky/SunLight/Clouds/AerialPerspective) mount only
 * in the golden style.
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

function GoldenLighting() {
  const sunRef = useRef<SunDirectionalLight>(null);
  // 2048 reads the same as the old 4096 through the soft golden light and
  // normalBias, at a quarter of the shadow-pass fill; low tier halves again.
  // Keyed remount on tier change so the map is rebuilt at the new size.
  const shadowSize = goldenShadowSize(useQuality((s) => s.tier));

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
        key={shadowSize}
        ref={sunRef}
        distance={90}
        intensity={3}
        castShadow
        shadow-mapSize={[shadowSize, shadowSize]}
        shadow-camera-left={-70}
        shadow-camera-right={70}
        shadow-camera-top={70}
        shadow-camera-bottom={-70}
        shadow-camera-far={260}
        shadow-bias={-0.0002}
        shadow-normalBias={0.5}
      />
      {/* Physical sky irradiance (dusk blue overhead) as a light probe. */}
      <SkyLight intensity={1.0} />
      {/* Cool counter-fill opposite the sun so shadowed faces stay readable.
          Placed far out with the default (origin) target so its direction is
          effectively constant anywhere on the map. Intensities are in the
          physical luminance scale (see the golden style's exposure). */}
      <directionalLight color="#93a9e6" intensity={0.12} position={[3400, 2200, -2600]} />
      {/* faint warm ambient floor so nothing crushes to black */}
      <ambientLight color="#ffd9b0" intensity={0.08} />
    </>
  );
}

/**
 * Anime light rig: one shadowed key light (moon or low sun per style) plus a
 * strong hemisphere and warm ambient. Half the shadow map of the golden rig;
 * soft painterly lighting hides the resolution loss.
 */
function AnimeLighting({ style }: { style: VisualStyle }) {
  const lights = style.lights!;
  const keyRef = useRef<THREE.DirectionalLight>(null);
  const target = useMemo(() => new THREE.Object3D(), []);
  // Painterly lighting hides shadow resolution well; 1024 is enough (512 on
  // the low tier). Keyed remount rebuilds the map on tier change.
  const shadowSize = animeShadowSize(useQuality((s) => s.tier));

  useFrame(() => {
    const key = keyRef.current;
    if (!key) return;
    target.position.set(game.predicted.x, 0, game.predicted.z);
    key.position.set(
      game.predicted.x + lights.sunDir.x * 120,
      lights.sunDir.y * 120,
      game.predicted.z + lights.sunDir.z * 120,
    );
  });

  return (
    <>
      <primitive object={target} />
      <directionalLight
        key={shadowSize}
        ref={keyRef}
        color={lights.sunColor}
        intensity={lights.sunIntensity}
        target={target}
        castShadow
        shadow-mapSize={[shadowSize, shadowSize]}
        shadow-camera-left={-70}
        shadow-camera-right={70}
        shadow-camera-top={70}
        shadow-camera-bottom={-70}
        shadow-camera-far={260}
        shadow-bias={-0.0002}
        shadow-normalBias={0.5}
      />
      <hemisphereLight args={[lights.hemiSky, lights.hemiGround, lights.hemiIntensity]} />
      <ambientLight color={lights.ambient} intensity={lights.ambientIntensity} />
    </>
  );
}

export function Lighting() {
  const style = useVisualStyle();
  return style.physicalSky ? (
    <GoldenLighting />
  ) : (
    <AnimeLighting key={style.id} style={style} />
  );
}

// ---------------------------------------------------------------------------
// Sky
// ---------------------------------------------------------------------------

/** Hand-painted anime sky dome shader: gradient, painterly FBM clouds with
 * sun underlighting, hash star field, moon disc, and a sun halo/disc. */
export function makeAnimeSkyMaterial(
  spec: AnimeSkySpec,
  lum: number,
  { stars = true }: { stars?: boolean } = {},
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      uZenith: { value: new THREE.Color(spec.zenith) },
      uMid: { value: new THREE.Color(spec.mid) },
      uHorizon: { value: new THREE.Color(spec.horizon) },
      uSunDir: { value: spec.sunDir },
      uSunColor: { value: new THREE.Color(spec.sunColor) },
      uSunHalo: { value: spec.sunHalo },
      uSunDisc: { value: spec.sunDisc },
      uMoonDir: { value: spec.moonDir },
      uMoonColor: { value: new THREE.Color(spec.moonColor) },
      uMoonAmt: { value: spec.moonAmt },
      uStars: { value: stars ? spec.stars : 0 },
      uCloudCover: { value: spec.cloudCover },
      uCloudLit: { value: new THREE.Color(spec.cloudLit) },
      uCloudShade: { value: new THREE.Color(spec.cloudShade) },
      uCloudSharp: { value: spec.cloudSharp },
      uLum: { value: lum },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vDir;
      uniform vec3 uZenith;
      uniform vec3 uMid;
      uniform vec3 uHorizon;
      uniform vec3 uSunDir;
      uniform vec3 uSunColor;
      uniform float uSunHalo;
      uniform float uSunDisc;
      uniform vec3 uMoonDir;
      uniform vec3 uMoonColor;
      uniform float uMoonAmt;
      uniform float uStars;
      uniform float uCloudCover;
      uniform vec3 uCloudLit;
      uniform vec3 uCloudShade;
      uniform float uCloudSharp;
      uniform float uLum;

      float shash(vec2 p) {
        vec3 q = fract(vec3(p.xyx) * 0.1031);
        q += dot(q, q.yzx + 33.33);
        return fract((q.x + q.y) * q.z);
      }
      float shash3(vec3 p) {
        p = fract(p * 0.1031);
        p += dot(p, p.zyx + 31.32);
        return fract((p.x + p.y) * p.z);
      }
      float snoise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(
          mix(shash(i), shash(i + vec2(1.0, 0.0)), u.x),
          mix(shash(i + vec2(0.0, 1.0)), shash(i + vec2(1.0, 1.0)), u.x),
          u.y);
      }
      float sfbm(vec2 p) {
        float a = 0.5;
        float s = 0.0;
        for (int i = 0; i < 4; i++) { s += a * snoise(p); p *= 2.13; a *= 0.5; }
        return s;
      }

      void main() {
        vec3 dir = normalize(vDir);
        float h = dir.y;

        // Base gradient: horizon band -> mid -> zenith.
        vec3 sky = mix(uMid, uZenith, smoothstep(0.06, 0.55, h));
        sky = mix(uHorizon, sky, smoothstep(-0.04, 0.14, h));

        // Warm halo around the sun direction (behind the clouds).
        float sunAmt = clamp(dot(dir, uSunDir), 0.0, 1.0);
        sky += uSunColor * pow(sunAmt, 8.0) * uSunHalo;

        // Painterly clouds: planar-projected FBM with a hard-ish coverage
        // edge; lit face picks up the sun color (underlighting), shaded face
        // sinks toward the cool shade color.
        float cloud = 0.0;
        if (uCloudCover > 0.001 && h > 0.015) {
          vec2 cuv = dir.xz / (h + 0.22);
          float n = sfbm(cuv * 1.35 + vec2(3.7, 9.1));
          float cov = uCloudCover * (0.75 + 0.5 * (1.0 - h));
          cloud = smoothstep(1.0 - cov - uCloudSharp, 1.0 - cov + uCloudSharp, n);
          cloud *= smoothstep(0.015, 0.12, h);
          float n2 = sfbm(cuv * 2.7 + 40.0);
          float lit = clamp(0.3 + 1.1 * (n2 - 0.4) + 0.9 * pow(sunAmt, 3.0), 0.0, 1.0);
          vec3 ccol = mix(uCloudShade, uCloudLit, lit);
          // Bright rim where the coverage edge faces the sun.
          float edge = cloud * (1.0 - cloud) * 4.0;
          ccol += uSunColor * edge * pow(sunAmt, 4.0) * 0.55;
          sky = mix(sky, ccol, cloud * 0.94);
        }

        // Hash star field, masked by clouds and faded near the horizon.
        if (uStars > 0.001) {
          vec3 g = dir * 70.0;
          vec3 cell = floor(g);
          float rnd = shash3(cell);
          vec3 jit = vec3(shash3(cell + 17.0), shash3(cell + 29.0), shash3(cell + 43.0));
          float d = length(fract(g) - 0.2 - 0.6 * jit);
          float star = step(0.978, rnd) * smoothstep(0.12, 0.02, d)
            * (0.35 + 0.65 * shash3(cell + 7.0));
          sky += vec3(1.0, 0.97, 0.9) * star * uStars
            * smoothstep(0.05, 0.35, h) * (1.0 - cloud);
        }

        // Moon: big soft disc plus a wide glow.
        if (uMoonAmt > 0.001) {
          float mAmt = clamp(dot(dir, uMoonDir), 0.0, 1.0);
          float disc = smoothstep(0.99875, 0.99925, mAmt);
          float glow = pow(mAmt, 40.0) * 0.3;
          sky += uMoonColor * (disc * 1.5 + glow) * uMoonAmt * (1.0 - cloud * 0.9);
        }

        // Hot sun disc (sunset style), occluded by clouds.
        sky += uSunColor * smoothstep(0.99915, 0.99965, sunAmt) * uSunDisc * (1.0 - cloud);

        gl_FragColor = vec4(sky * uLum, 1.0);
      }
    `,
  });
}

/** Anime sky dome: a back-side sphere that follows the camera on XZ. Radius
 * stays inside the 400 m far plane at the highest camera position. */
function AnimeSky({ style }: { style: VisualStyle }) {
  const meshRef = useRef<THREE.Mesh>(null);
  const material = useMemo(
    () => makeAnimeSkyMaterial(style.sky!, 1 / style.exposure),
    [style],
  );
  useEffect(() => () => material.dispose(), [material]);
  useFrame(({ camera }) => {
    meshRef.current?.position.set(camera.position.x, 0, camera.position.z);
  });
  return (
    <mesh ref={meshRef} renderOrder={-1} frustumCulled={false}>
      <sphereGeometry args={[250, 48, 24]} />
      <primitive object={material} attach="material" />
    </mesh>
  );
}

/**
 * Sky backdrop. Golden: physical sky rendered in the scene (a screen quad at
 * far depth) rather than in post so transparent effects blend against it
 * correctly. Anime: hand-painted dome.
 */
export function SkyBackdrop() {
  const style = useVisualStyle();
  if (!style.physicalSky) return <AnimeSky key={style.id} style={style} />;
  // groundAlbedo tints the below-horizon ellipsoid (visible past the city
  // edge and past the Ocean plane's far clip) so it reads as distant hazy
  // sea, handing off from the animated ocean plane at the far plane.
  //
  // sun={false} disables the physical solar disk. Its radiance
  // (transmittance * GetSolarRadiance()) is astronomically large and would
  // clip a huge patch of sky to white; the warm scattering near the sun
  // (orders of magnitude dimmer) still reads as golden hour, and the
  // SunLight directional still models the scene.
  return <Sky groundAlbedo={GROUND_ALBEDO} sun={false} />;
}

const GROUND_ALBEDO = new THREE.Color(0.1, 0.16, 0.18);

// ---------------------------------------------------------------------------
// Post-processing
// ---------------------------------------------------------------------------

const WEATHER_VELOCITY = new THREE.Vector2(0.001, 0);
const SHADOW_MAP_SIZE = new THREE.Vector2(256, 256);

/**
 * Bloom pyramid base height. Bloom is inherently low-frequency (mip blur
 * spreads everything anyway), so building the luminance + mip chain from
 * 360p instead of canvas resolution is visually indistinguishable while
 * cutting the bloom pass cost by ~5-10x at dpr 1.75. This matters most in
 * tron, whose look leans on a strong full-screen bloom.
 */
const BLOOM_HEIGHT = 360;

/**
 * Bloom with the pyramid capped at BLOOM_HEIGHT. postprocessing's BloomEffect
 * ignores its `resolution` for the luminance + mipmap passes (setSize hands
 * them the raw base size), so cap by intercepting setSize on the instance.
 */
function CappedBloom(props: ComponentProps<typeof Bloom>) {
  const gl = useThree((s) => s.gl);
  const attach = useCallback(
    (bloom: BloomEffect | null) => {
      if (!bloom || (bloom as { __capped?: boolean }).__capped) return;
      (bloom as { __capped?: boolean }).__capped = true;
      const setSize = bloom.setSize.bind(bloom);
      bloom.setSize = (width: number, height: number) => {
        const scale = Math.min(1, BLOOM_HEIGHT / Math.max(1, height));
        setSize(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)));
      };
      // The composer sizes effects before refs attach; re-apply immediately.
      const size = gl.getDrawingBufferSize(bloomSizeScratch);
      bloom.setSize(size.x, size.y);
    },
    [gl],
  );
  return <Bloom ref={attach} {...props} />;
}

const bloomSizeScratch = new THREE.Vector2();

function GoldenEffects() {
  const tier = useQuality((s) => s.tier);
  const effects = [
    /* Volumetric clouds render into buffers here and are composited (with
       atmosphere overlay/shadow routing) by AerialPerspective below. The
       ray-march resolution follows the quality tier. */
    <Clouds
      key={`clouds-${tier}`}
      qualityPreset={tier === "high" ? "medium" : "low"}
      resolutionScale={tier === "high" ? 0.75 : 0.5}
      coverage={0.27}
      localWeatherVelocity={WEATHER_VELOCITY}
      shadow-cascadeCount={1}
      shadow-mapSize={SHADOW_MAP_SIZE}
      localWeatherTexture="/clouds/local_weather.png"
      shapeTexture="/clouds/shape.bin"
      shapeDetailTexture="/clouds/shape_detail.bin"
      turbulenceTexture="/clouds/turbulence.png"
      stbnTexture="/clouds/stbn.bin"
    />,
    <AerialPerspective key="aerial" stbnTexture="/clouds/stbn.bin" />,
    /* The composer disables the renderer's built-in tone mapping, so map
       the physical-luminance HDR buffer to display here (AgX, exposure
       from gl.toneMappingExposure). */
    <ToneMapping key="tm" mode={ToneMappingMode.AGX} />,
    /* Bloom runs AFTER tone mapping on display-referred [0,1] values, so
       its energy is bounded: an HDR sun glint on the ground or the sky's
       forward-scattering halo (orders of magnitude above any pre-tonemap
       threshold) can no longer smear a screen-filling glare. Near-white
       pixels (neon, emissives, the sun's core glow) still get a halo.
       Capped at 360p: the mip chain starts small, so the halo cost stays
       flat as the canvas grows. */
    <CappedBloom
      key="bloom"
      intensity={0.25}
      luminanceThreshold={0.92}
      luminanceSmoothing={0.08}
      mipmapBlur
    />,
    /* light golden-hour grade: richer color, gentle contrast */
    <HueSaturation key="hs" saturation={0.18} />,
    <BrightnessContrast key="bc" brightness={0} contrast={0.15} />,
    <SMAA key="smaa" />,
    <Vignette key="vig" eskil={false} offset={0.15} darkness={0.5} />,
  ];
  if (tier !== "low") {
    // Low tier: skip the AO pass entirely; the soft golden light hides its
    // absence far better than the frame-time cost hides itself.
    effects.unshift(
      <N8AO
        key="ao"
        halfRes
        quality="performance"
        aoRadius={1.9}
        intensity={1.8}
        distanceFalloff={1.5}
      />,
    );
  }
  // MSAA off: SMAA handles the edges, which keeps the AO pass cheap.
  return <EffectComposer multisampling={0}>{effects}</EffectComposer>;
}

/** Post stack for the painted-sky styles: no volumetric clouds — bloom for
 * the glowing windows/neon, a neutral tone map (preserves the authored
 * palette), and a per-style grade. AO is opt-in per style (blue hour wants
 * the grounded contact darkening; the painterly styles skip it for speed). */
function AnimeEffects({ style }: { style: VisualStyle }) {
  const post = style.post!;
  const tier = useQuality((s) => s.tier);
  const effects = [
    <CappedBloom
      key="bloom"
      intensity={post.bloom}
      luminanceThreshold={post.bloomThreshold}
      luminanceSmoothing={0.3}
      mipmapBlur
    />,
    <ToneMapping key="tm" mode={ToneMappingMode.NEUTRAL} />,
    <HueSaturation key="hs" saturation={post.saturation} />,
    <BrightnessContrast key="bc" brightness={post.brightness} contrast={post.contrast} />,
    <SMAA key="smaa" />,
    <Vignette key="vig" eskil={false} offset={0.15} darkness={post.vignette} />,
  ];
  if (post.ao && tier !== "low") {
    effects.unshift(
      <N8AO
        key="ao"
        halfRes
        quality="performance"
        aoRadius={1.9}
        intensity={1.8}
        distanceFalloff={1.5}
      />,
    );
  }
  return <EffectComposer multisampling={0}>{effects}</EffectComposer>;
}

export function Effects() {
  const style = useVisualStyle();
  return style.physicalSky ? (
    <GoldenEffects />
  ) : (
    <AnimeEffects key={style.id} style={style} />
  );
}

/**
 * Minimal mobile post stack: bloom (360p-capped pyramid) + tone mapping,
 * nothing else — no AO, no SMAA, no vignette. The tron style's look depends
 * on bloom (its emissive hairlines are authored thin, expecting the glow to
 * come from post), so skipping post entirely left the mobile Watch tab
 * reading near-black. The composer disables the renderer's built-in tone
 * mapping, so the display mapping must be re-added here as an effect.
 */
export function MobileEffects() {
  const style = useVisualStyle();
  const post = style.post;
  return (
    <EffectComposer key={style.id} multisampling={0}>
      <CappedBloom
        intensity={post?.bloom ?? 0.25}
        luminanceThreshold={post?.bloomThreshold ?? 0.9}
        luminanceSmoothing={0.3}
        mipmapBlur
      />
      <ToneMapping
        mode={style.physicalSky ? ToneMappingMode.AGX : ToneMappingMode.NEUTRAL}
      />
    </EffectComposer>
  );
}

// ---------------------------------------------------------------------------
// Scene setup: environment map, fog, tone mapping
// ---------------------------------------------------------------------------

/**
 * Scene radiance in the golden style is in the atmosphere packages' physical
 * luminance scale, displayed through AgX at high exposure (the takram
 * examples use ~10; a bit lower here keeps the sun-facing sky from washing
 * out). Display-referred colors (fog, env gradient) are divided by the
 * active exposure so they land at their authored brightness. Anime styles
 * use a near-1 exposure with the same convention.
 */
const GOLDEN_EXPOSURE = STYLES.golden.exposure;
export const DISPLAY_TO_SCENE = 1 / GOLDEN_EXPOSURE;

// Gradient dusk env: approximates the physical sky for IBL. Kept procedural
// (rather than capturing the real SkyMaterial into a cubemap) because PMREM
// only needs a plausible warm-west/cool-zenith gradient for reflections.
export const envSkyMaterial = new THREE.ShaderMaterial({
  side: THREE.BackSide,
  depthWrite: false,
  fog: false,
  uniforms: {
    uSunDir: { value: SUN_DIR },
    uLum: { value: DISPLAY_TO_SCENE },
    // Shared style uniform: the ocean's far-tier mirror uses this material,
    // so tron swaps its sunset gradient for a black/blue one live.
    uTron: styleUniforms.uTron,
  },
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
    uniform float uTron;
    void main() {
      vec3 dir = normalize(vDir);
      float h = dir.y;
      if (uTron > 0.5) {
        // Tron reflection sky: black zenith, deep teal horizon band.
        vec3 tSky = mix(vec3(0.04, 0.24, 0.28), vec3(0.001, 0.004, 0.005),
          smoothstep(-0.02, 0.35, h));
        gl_FragColor = vec4(tSky, 1.0);
        return;
      }
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

/**
 * Anime environment map: the style's painted sky (stars off — they'd sparkle
 * in reflections) plus a matching ground bounce. This is what makes glass,
 * metal, and street puddles mirror the pink/red anime sky.
 */
function makeAnimeEnvironment(gl: THREE.WebGLRenderer, style: VisualStyle): THREE.Texture {
  const spec = style.sky!;
  const envScene = new THREE.Scene();
  const material = makeAnimeSkyMaterial(spec, 1 / style.exposure, { stars: false });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(100, 32, 16), material);
  envScene.add(sky);

  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(90, 24).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({
      color: new THREE.Color(spec.envGround).multiplyScalar(1 / style.exposure),
    }),
  );
  ground.position.y = -2;
  envScene.add(ground);

  const pmrem = new THREE.PMREMGenerator(gl);
  const env = pmrem.fromScene(envScene, 0.04).texture;
  pmrem.dispose();
  material.dispose();
  return env;
}

export function SceneSetup() {
  const { scene, gl, camera } = useThree();
  const style = useVisualStyle();

  useEffect(() => {
    // Push style values into the shared ground/facade shader uniforms and
    // the runtime knobs (fog density base for CameraRig).
    applyStyle(style);

    // Fog color tracks the horizon; scaled into the active radiance range.
    scene.fog = new THREE.FogExp2(
      new THREE.Color(style.fogColor).multiplyScalar(1 / style.exposure),
      style.fogDensity,
    );
    // No flat background color: the sky (physical quad or painted dome)
    // covers the whole view.
    scene.background = null;
    const env = style.physicalSky
      ? makeSunsetEnvironment(gl)
      : makeAnimeEnvironment(gl, style);
    scene.environment = env;
    scene.environmentIntensity = style.envIntensity;
    // The EffectComposer forces the renderer to NoToneMapping and the display
    // mapping happens in the ToneMapping effect, which reads exposure here.
    gl.toneMapping = style.physicalSky ? THREE.AgXToneMapping : THREE.NeutralToneMapping;
    gl.toneMappingExposure = style.exposure;
    return () => {
      env.dispose();
    };
  }, [scene, gl, style]);

  useEffect(() => {
    if (import.meta.env.DEV) {
      (window as unknown as { __gl?: THREE.WebGLRenderer }).__gl = gl;
      (window as unknown as { __scene?: THREE.Scene }).__scene = scene;
      (window as unknown as { __camera?: THREE.Camera }).__camera = camera;
    }
  }, [scene, gl, camera]);

  // Drive time-varying facade shaders (window flicker/toggles).
  useFrame(({ clock }) => {
    perf.begin("facades");
    tickFacades(clock.elapsedTime);
    // Player XZ drives the tron floor-grid proximity fade (see groundShader).
    styleUniforms.uPlayerPos.value.set(game.rendered.x, game.rendered.z);
    // Seconds clock for the territory capture crossfade (matches the flip
    // timestamps recorded in game/territory.ts).
    styleUniforms.uTerrTime.value = performance.now() / 1000;
    perf.end("facades");
  });
  return null;
}
