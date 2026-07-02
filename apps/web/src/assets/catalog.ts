// Asset catalog: maps archetype ids -> manifest asset ids, loads GLBs from the
// gateway-served /assets tree, and exposes graceful fallbacks (null) when an
// asset is missing so procedural stand-ins render instead.

import { useEffect, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";

export interface ManifestEntry {
  id: string;
  path: string;
  type: "model" | "texture" | "audio";
  license?: string;
}

export interface LoadedModel {
  scene: THREE.Group;
  animations: THREE.AnimationClip[];
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
const modelCache = new Map<string, Promise<LoadedModel | null>>();

async function loadModel(id: string): Promise<LoadedModel | null> {
  await loadManifest();
  const entry = manifest?.get(id);
  if (!entry) return null;
  try {
    const gltf = await loader.loadAsync(`/assets/${entry.path}`);
    gltf.scene.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) {
        obj.castShadow = true;
        obj.receiveShadow = true;
      }
    });
    return { scene: gltf.scene, animations: gltf.animations };
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
        });
      }
    });
    return () => {
      alive = false;
    };
  }, [id]);
  return model;
}

/** Prop archetype id -> manifest asset id (see wilder-terrain::props). */
export const PROP_MODELS: Record<number, string> = {
  0: "prop_streetlight",
  1: "prop_bench",
  2: "prop_trash",
  3: "prop_hydrant",
  5: "prop_vent",
  9: "prop_box",
};

/** Car archetype rotates between model variants for street variety. */
export const CAR_MODELS = ["prop_car_sedan", "prop_car_hatchback", "prop_car_taxi"];

export const CHARACTER_MODEL = "character_main";

export async function getAudioUrl(id: string): Promise<string | null> {
  await loadManifest();
  const entry = manifest?.get(id);
  return entry ? `/assets/${entry.path}` : null;
}
