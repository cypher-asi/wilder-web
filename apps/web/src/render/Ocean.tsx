// Horizon ocean: one large camera-following plane using the three.js Water
// addon (planar reflections distorted by scrolling normal maps). It fills the
// view past the streamed chunks out beyond the far plane, and shows through
// the Water tiles that Ground.tsx skips, so the same surface serves both the
// distant horizon and the close-up shoreline.
//
// Adaptive quality: the expensive part of Water is re-rendering the scene
// into its reflection target every frame. Near the coast (water visible up
// close) we run a true 512px scene reflection every frame; deep in the city
// the visible water is distant and fogged, so the mirror instead renders a
// cheap proxy sky (the same gradient sphere the IBL env map uses) into a
// 256px target every 4th frame, making the steady-state cost one big quad.

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { Water } from "three/examples/jsm/objects/Water.js";
import { CITY_WATER, cityTileAt } from "../game/citymap";
import { TILE_SIZE } from "../net/protocol";
import { perf } from "../perf/perf";
import { game, useGame } from "../state/game";
import { DISPLAY_TO_SCENE, envSkyMaterial, SUN_DIR } from "./Atmosphere";
import { CAMERA_FAR } from "./CameraRig";
import { isTronStyle } from "./styles";

/** Slightly under road grade (0) so coast tiles read flush with the sea. */
const OCEAN_Y = -0.02;
/** Plane size; the far rim is what matters, see RIM_* below. */
const OCEAN_SIZE = 2400;
/** Camera far plane (GameCanvas); the water fades out just inside it. */
const CAM_FAR = CAMERA_FAR;
/**
 * Horizon rim: between these radii (meters from the camera) the plane curves
 * up to camera eye level, so the water's own edge is the visual horizon line
 * and the seam where the plane would clip at the far plane (revealing the
 * sky backdrop's below-horizon ellipsoid as a distinct band) never shows.
 * RIM_END + max camera height must stay inside CAM_FAR, and the rim must sit
 * past the fog-visible range of the CityProxy skyline so the distant city is
 * never occluded by the risen water edge.
 */
const RIM_START = 0.6 * CAM_FAR;
const RIM_END = 0.92 * CAM_FAR;

/** Enter the near (high-quality) tier when water is within this range... */
const NEAR_ENTER_M = 64;
/** ...and only leave it once no water is within this range (hysteresis). */
const NEAR_EXIT_M = 112;
/** Frames between full-scene reflection re-renders in the near tier. */
const NEAR_INTERVAL = 2;
/** Frames between near/far tier re-evaluations. */
const CHECK_INTERVAL = 20;

const waterNormals = new THREE.TextureLoader().load("/water/waternormals.jpg", (t) => {
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
});

function makeWater(geometry: THREE.PlaneGeometry, resolution: number): Water {
  const water = new Water(geometry, {
    textureWidth: resolution,
    textureHeight: resolution,
    waterNormals,
    sunDirection: SUN_DIR.clone(),
    // Colors live in the scene's physical luminance scale (see Atmosphere).
    sunColor: new THREE.Color("#ffd9b0").multiplyScalar(DISPLAY_TO_SCENE),
    waterColor: new THREE.Color("#0d2733").multiplyScalar(DISPLAY_TO_SCENE),
    distortionScale: 3.4,
    fog: true,
  });
  // Vertex: curve the rim of the plane up to camera eye level (uCamY) so the
  // water's silhouette is the horizon line itself, occluding the sky
  // backdrop's below-horizon ellipsoid band. Quadratic ease so the bend is
  // invisible where it starts. Local plane z maps to world y (rotation below).
  water.material.uniforms.uCamY = { value: 10 };
  water.material.vertexShader = water.material.vertexShader
    .replace("uniform float time;", "uniform float time;\nuniform float uCamY;")
    .replace(
      "void main() {",
      /* glsl */ `
      void main() {
        float rimT = smoothstep( ${RIM_START.toFixed(1)}, ${RIM_END.toFixed(1)}, length( position.xy ) );
        vec3 oceanPos = position + vec3( 0.0, 0.0, rimT * rimT * uCamY );
      `,
    )
    .replace(/vec4\( position, 1\.0 \)/g, "vec4( oceanPos, 1.0 )");
  // Fragment tweaks:
  // - The stock shader adds a flat vec3(0.1) floor to the reflective term.
  //   That's tuned for display-referred scenes; in this scene's luminance
  //   scale it reads as a gray wash, so drop it well below the sky level.
  // - Force the fog to fully saturate just inside the far plane so the rim
  //   (and everything approaching it) converges on the scene fog color,
  //   which is tuned to the sky's horizon haze -- water meets sky in the
  //   same color instead of a hard line.
  water.material.fragmentShader = water.material.fragmentShader
    .replace("vec3( 0.1 ) +", "vec3( 0.004 ) +")
    .replace(
      "#include <fog_fragment>",
      /* glsl */ `
      #ifdef USE_FOG
        float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
        fogFactor = max( fogFactor, smoothstep( 0.45, 0.92, vFogDepth / ${CAM_FAR.toFixed(1)} ) );
        gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
      #endif
      `,
    );
  water.rotation.x = -Math.PI / 2;
  water.position.y = OCEAN_Y;
  water.receiveShadow = true;
  // Never intercept the ground raycasts used for aiming/click-to-move.
  water.raycast = () => {};
  // The camera-following plane sorts as the nearest opaque object, which
  // would shade every covered pixel before the city draws over it. Drawing
  // it after the other opaques lets early-z reject all the fragments hidden
  // under the ground, so the ocean only pays for pixels it actually shows.
  water.renderOrder = 1;
  return water;
}

/** Is any city-map water tile within `radius` meters of (x, z)? Ring samples
 * densify with radius so large-range checks don't skip whole coastlines. */
function waterWithin(x: number, z: number, radius: number): boolean {
  for (let r = 0; r <= radius; r += TILE_SIZE * 4) {
    const steps = r === 0 ? 1 : Math.max(8, Math.ceil(r / 12));
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      const sx = x + Math.cos(a) * r;
      const sz = z + Math.sin(a) * r;
      if (cityTileAt(Math.floor(sx / TILE_SIZE), Math.floor(sz / TILE_SIZE)) === CITY_WATER) {
        return true;
      }
    }
  }
  return false;
}

export function Ocean() {
  const camera = useThree((s) => s.camera);
  const scene = useThree((s) => s.scene);
  const frame = useRef(0);
  const near = useRef(false);
  // False when no water tile sits within the fog-visible range: deep in the
  // city interior the whole plane would resolve to fog color behind opaque
  // ground, so skip its draw (and its reflection pass) entirely.
  const inRange = useRef(true);

  const { waters, geometry, proxySky } = useMemo(() => {
    // Segmented so the vertex-shader rim curve has vertices to bend
    // (~15 m spacing through the RIM_START..RIM_END band).
    const geo = new THREE.PlaneGeometry(OCEAN_SIZE, OCEAN_SIZE, 160, 160);

    // Far-tier mirror content: just the IBL gradient sky sphere, so the
    // reflection pass costs next to nothing. Sized to stay inside the mirror
    // camera's 400 m far plane even from a fully zoomed-out camera.
    const sky = new THREE.Mesh(new THREE.SphereGeometry(260, 32, 16), envSkyMaterial);
    const proxy = new THREE.Scene();
    proxy.add(sky);

    const make = (resolution: number, interval: number, mirrorScene?: THREE.Scene) => {
      const water = makeWater(geo, resolution);
      // onBeforeRender fires once per scene pass (color + the AO depth
      // pre-pass), so gate the mirror render to once per animation frame,
      // throttled to every `interval`-th frame (skipping simply reuses the
      // previous reflection texture).
      const render = water.onBeforeRender;
      let lastRendered = -1;
      water.onBeforeRender = (renderer, scene, cam, geom, mat, group) => {
        if (frame.current % interval !== 0) return;
        if (frame.current === lastRendered) return;
        lastRendered = frame.current;
        render(renderer, mirrorScene ?? scene, cam, geom, mat, group);
      };
      return water;
    };
    return {
      waters: { near: make(512, NEAR_INTERVAL), far: make(256, 1, proxy) },
      geometry: geo,
      proxySky: sky,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    return () => {
      geometry.dispose();
      proxySky.geometry.dispose();
      for (const w of [waters.near, waters.far]) w.material.dispose();
    };
  }, [waters, geometry, proxySky]);

  // Tron water: black glass with cold blue glints (default: warm sunset).
  const tron = useGame((s) => isTronStyle(s.visualStyle));
  useEffect(() => {
    for (const w of [waters.near, waters.far]) {
      const u = w.material.uniforms;
      if (tron) {
        (u.waterColor.value as THREE.Color).set("#031317");
        (u.sunColor.value as THREE.Color).set("#4fd0e0").multiplyScalar(0.35);
      } else {
        (u.waterColor.value as THREE.Color).set("#0d2733").multiplyScalar(DISPLAY_TO_SCENE);
        (u.sunColor.value as THREE.Color).set("#ffd9b0").multiplyScalar(DISPLAY_TO_SCENE);
      }
    }
  }, [tron, waters]);

  useFrame((_, delta) => {
    perf.begin("ocean.tick");
    frame.current++;

    if (frame.current % CHECK_INTERVAL === 0) {
      const { x, z } = game.predicted;
      near.current = near.current
        ? waterWithin(x, z, NEAR_EXIT_M)
        : waterWithin(x, z, NEAR_ENTER_M);
      // Visible range: where fog transmittance drops under ~2% (or the far
      // plane). Past that the plane is pure fog color and contributes
      // nothing, so a coastline further away means no ocean draw at all.
      const density = scene.fog instanceof THREE.FogExp2 ? scene.fog.density : 0.0035;
      const fogCut = Math.min(CAM_FAR, Math.sqrt(-Math.log(0.02)) / Math.max(density, 1e-5));
      inRange.current = waterWithin(x, z, fogCut);
    }

    const active = near.current ? waters.near : waters.far;
    const idle = near.current ? waters.far : waters.near;
    active.visible = inRange.current;
    idle.visible = false;

    // Follow the camera so the plane always fills the frustum. Wave noise is
    // sampled in world space, so a moving plane causes no texture swim.
    active.position.set(camera.position.x, OCEAN_Y, camera.position.z);
    // Rim rises to eye level so the water's edge sits exactly on the horizon.
    (active.material.uniforms.uCamY as THREE.IUniform<number>).value =
      camera.position.y - OCEAN_Y;
    const time = active.material.uniforms.time as THREE.IUniform<number>;
    time.value += delta * 0.6;
    // Keep the tiers in sync so swapping doesn't jump the wave phase.
    (idle.material.uniforms.time as THREE.IUniform<number>).value = time.value;
    perf.end("ocean.tick");
  });

  return (
    <>
      <primitive object={waters.near} />
      <primitive object={waters.far} />
    </>
  );
}
