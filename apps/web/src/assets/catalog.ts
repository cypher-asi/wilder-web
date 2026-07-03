// Asset catalog: maps archetype ids -> manifest asset ids, loads GLBs from the
// gateway-served /assets tree, and exposes graceful fallbacks (null) when an
// asset is missing so procedural stand-ins render instead.

import { useEffect, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import { tronifyMaterial } from "../render/styles";

export interface ManifestEntry {
  id: string;
  path: string;
  type: "model" | "texture" | "audio";
  license?: string;
}

export interface LoadedModel {
  scene: THREE.Group;
  animations: THREE.AnimationClip[];
  /** Bounding-box size of the un-scaled scene, in the model's local space. */
  size: THREE.Vector3;
  /** Bounding-box minimum Y of the un-scaled scene (for ground snapping). */
  minY: number;
}

let manifest: Map<string, ManifestEntry> | null = null;
let manifestPromise: Promise<void> | null = null;

async function loadManifest(): Promise<void> {
  if (manifest) return;
  if (!manifestPromise) {
    manifestPromise = fetch("/assets/manifest.json")
      .then((r) => (r.ok ? r.json() : []))
      .catch(() => [])
      .then((entries: ManifestEntry[]) => {
        manifest = new Map(entries.map((e) => [e.id, e]));
      });
  }
  await manifestPromise;
}

const loader = new GLTFLoader();
// Asset Lab game-ready GLBs use EXT_meshopt_compression.
loader.setMeshoptDecoder(MeshoptDecoder);
const modelCache = new Map<string, Promise<LoadedModel | null>>();

/** Building-shell assets whose walls run the tron code rain (towers read as
 * glowing data-cubes); props, vehicles and characters stay plain slabs. */
const CODE_RAIN_IDS = /skyscraper|cb01|floor_|groundfloor|storefront|slum|structure|cyberpunk/;

async function loadModel(id: string): Promise<LoadedModel | null> {
  await loadManifest();
  const entry = manifest?.get(id);
  if (!entry) return null;
  const codeRain = CODE_RAIN_IDS.test(id);
  try {
    const gltf = await loader.loadAsync(`/assets/${entry.path}`);
    gltf.scene.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) {
        obj.castShadow = true;
        obj.receiveShadow = true;
        // Kit textures (perforated metal, fences, grilles) alias into moiré
        // bands at grazing angles without anisotropic filtering.
        const mats = (obj as THREE.Mesh).material;
        for (const mat of Array.isArray(mats) ? mats : [mats]) {
          const m = mat as THREE.MeshStandardMaterial;
          for (const tex of [m.map, m.normalMap, m.roughnessMap, m.metalnessMap, m.aoMap]) {
            if (tex) tex.anisotropy = 8;
          }
          // Tron mode collapses every authored asset material to the black
          // slab (idempotent across shared materials; material clones drop
          // onBeforeCompile, so restyled characters are unaffected).
          tronifyMaterial(m, "tron-std", { codeRain });
        }
      }
    });
    const bbox = new THREE.Box3().setFromObject(gltf.scene);
    const size = bbox.getSize(new THREE.Vector3());
    return { scene: gltf.scene, animations: gltf.animations, size, minY: bbox.min.y };
  } catch {
    return null;
  }
}

function getModel(id: string): Promise<LoadedModel | null> {
  let promise = modelCache.get(id);
  if (!promise) {
    promise = loadModel(id);
    modelCache.set(id, promise);
  }
  return promise;
}

/**
 * Load a manifest model; returns a fresh clone per caller (null = use
 * procedural fallback). Uses SkeletonUtils so skinned/rigged models clone
 * correctly; animation clips are shared (they are immutable).
 */
export function useAssetModel(id: string | undefined): LoadedModel | null {
  const [model, setModel] = useState<LoadedModel | null>(null);
  useEffect(() => {
    if (!id) return;
    let alive = true;
    getModel(id).then((loaded) => {
      if (alive && loaded) {
        setModel({
          scene: cloneSkinned(loaded.scene) as THREE.Group,
          animations: loaded.animations,
          size: loaded.size,
          minY: loaded.minY,
        });
      }
    });
    return () => {
      alive = false;
    };
  }, [id]);
  return model;
}

/**
 * Load a manifest model and return the shared (uncloned) instance. For
 * instanced rendering that only reads geometry/materials: callers must not
 * mutate the scene or add it to the graph.
 */
export function useSharedModel(id: string | undefined): LoadedModel | null {
  const [model, setModel] = useState<LoadedModel | null>(null);
  useEffect(() => {
    if (!id) return;
    let alive = true;
    getModel(id).then((loaded) => {
      if (alive && loaded) setModel(loaded);
    });
    return () => {
      alive = false;
    };
  }, [id]);
  return model;
}

// ---------------------------------------------------------------------------
// PBR texture sets (assets/textures/<name>/{color,normal,roughness}.jpg)
// ---------------------------------------------------------------------------

export interface PbrTextureSet {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  roughnessMap: THREE.Texture;
}

const textureLoader = new THREE.TextureLoader();
const textureCache = new Map<string, Promise<PbrTextureSet | null>>();

function configureTexture(tex: THREE.Texture, isColor: boolean): THREE.Texture {
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  if (isColor) tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

async function loadPbrSet(name: string): Promise<PbrTextureSet | null> {
  const base = `/assets/textures/${name}`;
  try {
    const [map, normalMap, roughnessMap] = await Promise.all([
      textureLoader.loadAsync(`${base}/color.jpg`),
      textureLoader.loadAsync(`${base}/normal.jpg`),
      textureLoader.loadAsync(`${base}/roughness.jpg`),
    ]);
    configureTexture(map, true);
    configureTexture(normalMap, false);
    configureTexture(roughnessMap, false);
    return { map, normalMap, roughnessMap };
  } catch {
    return null;
  }
}

/** Load (and cache) a PBR texture set by folder name, e.g. "asphalt". */
export function getPbrTextureSet(name: string): Promise<PbrTextureSet | null> {
  let promise = textureCache.get(name);
  if (!promise) {
    promise = loadPbrSet(name);
    textureCache.set(name, promise);
  }
  return promise;
}

/** React hook wrapper; returns null until loaded (or on failure). */
export function usePbrTextureSet(name: string | undefined): PbrTextureSet | null {
  const [set, setSet] = useState<PbrTextureSet | null>(null);
  useEffect(() => {
    if (!name) return;
    let alive = true;
    getPbrTextureSet(name).then((loaded) => {
      if (alive) setSet(loaded);
    });
    return () => {
      alive = false;
    };
  }, [name]);
  return set;
}

export const CHARACTER_MODEL = "character_main";
export const PISTOL_MODEL = "weapon_pistol";

export async function getAudioUrl(id: string): Promise<string | null> {
  await loadManifest();
  const entry = manifest?.get(id);
  return entry ? `/assets/${entry.path}` : null;
}
