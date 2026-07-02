// Procedural building facade material: emissive window grid + subtle
// night shading. One shared shader; per-building uniforms.

import * as THREE from "three";

const vertex = /* glsl */ `
  varying vec3 vLocal;
  varying vec3 vNormal2;
  void main() {
    vLocal = position;
    vNormal2 = normalMatrix * normal;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragment = /* glsl */ `
  uniform vec3 uSize;        // building dimensions (w, h, d)
  uniform vec3 uBaseColor;
  uniform vec3 uWindowColor;
  uniform float uSeed;
  uniform float uLitRatio;
  varying vec3 vLocal;
  varying vec3 vNormal2;

  float hash(vec2 p) {
    return fract(sin(dot(p + uSeed, vec2(127.1, 311.7))) * 43758.5453);
  }

  void main() {
    vec3 n = normalize(vNormal2);
    // Base facade with vertical gradient (grime near street level).
    float heightFrac = clamp((vLocal.y + uSize.y * 0.5) / uSize.y, 0.0, 1.0);
    vec3 base = uBaseColor * (0.35 + 0.65 * heightFrac);

    // Cheap directional shading from a cool moon light.
    vec3 moonDir = normalize(vec3(0.4, 0.8, 0.3));
    float ndl = max(dot(normalize(cross(dFdx(vLocal), dFdy(vLocal))), moonDir), 0.0);
    base *= 0.6 + 0.5 * ndl;

    // Window grid on vertical faces only (skip roof/floor).
    float facing = abs(dot(normalize(cross(dFdx(vLocal), dFdy(vLocal))), vec3(0.0, 1.0, 0.0)));
    vec3 emissive = vec3(0.0);
    if (facing < 0.5) {
      // Pick facade axis: whichever horizontal axis this face spans.
      vec3 fdx = dFdx(vLocal);
      float useX = step(abs(fdx.x), abs(fdx.z));
      float u = mix(vLocal.x, vLocal.z, useX);
      float v = vLocal.y + uSize.y * 0.5;

      // Window cells: 1.4m wide, 3m per story.
      vec2 cell = vec2(floor(u / 1.4), floor(v / 3.0));
      vec2 f = vec2(fract(u / 1.4), fract(v / 3.0));
      float inWindow = step(0.28, f.x) * step(f.x, 0.72) * step(0.3, f.y) * step(f.y, 0.68);

      float lit = step(1.0 - uLitRatio, hash(cell));
      float flicker = 0.8 + 0.2 * hash(cell + 7.0);
      // Vary per-window warmth and brightness so facades feel inhabited.
      vec3 warm = mix(uWindowColor, vec3(1.0, 0.82, 0.55), hash(cell + 3.0) * 0.7);
      float brightness = 0.5 + 0.9 * hash(cell + 11.0);
      emissive = warm * inWindow * lit * flicker * brightness;
      // Dark glass for unlit windows.
      base = mix(base, base * 0.4, inWindow * (1.0 - lit));
    } else {
      base *= 0.5; // roof
    }

    gl_FragColor = vec4(base + emissive, 1.0);
  }
`;

export interface FacadeParams {
  width: number;
  height: number;
  depth: number;
  style: number;
}

const WINDOW_PALETTES = [
  new THREE.Color("#ffd9a0"), // warm tungsten
  new THREE.Color("#bfe3ff"), // cool fluorescent
  new THREE.Color("#ffe9c9"),
  new THREE.Color("#d8f6ff"),
];

const BASE_PALETTES = [
  new THREE.Color("#2a2d36"),
  new THREE.Color("#33302f"),
  new THREE.Color("#23283a"),
  new THREE.Color("#3a3436"),
  new THREE.Color("#2c3330"),
];

export function makeFacadeMaterial(params: FacadeParams): THREE.ShaderMaterial {
  const rng = mulberry(params.style);
  const windowColor = WINDOW_PALETTES[Math.floor(rng() * WINDOW_PALETTES.length)];
  const baseColor = BASE_PALETTES[Math.floor(rng() * BASE_PALETTES.length)];
  return new THREE.ShaderMaterial({
    vertexShader: vertex,
    fragmentShader: fragment,
    uniforms: {
      uSize: { value: new THREE.Vector3(params.width, params.height, params.depth) },
      uBaseColor: { value: baseColor },
      uWindowColor: { value: windowColor },
      uSeed: { value: (params.style % 1000) * 0.13 },
      uLitRatio: { value: 0.18 + rng() * 0.25 },
    },
  });
}

export const NEON_COLORS = [
  "#ff2d78",
  "#00e5ff",
  "#b64dff",
  "#ffe14d",
  "#39ff8e",
  "#ff6a00",
];

export function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
