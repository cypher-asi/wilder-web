// GPU-instanced rendering for promoted Asset Lab kit GLBs. Each source model
// contributes one THREE.InstancedMesh per (geometry, material) pair, shared
// across all visible chunks, so N placements of an asset cost a fixed number
// of draw calls regardless of N.

import { useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { useSharedModel } from "../assets/catalog";

export interface KitPlacement {
  /** World-space position of the model's bottom-center anchor. */
  x: number;
  y: number;
  z: number;
  rotationY: number;
  /**
   * Extra scale on top of fit normalization (default 1). A tuple scales
   * per model axis (before rotation), e.g. to stretch tileable panels.
   */
  scale?: number | [number, number, number];
}

/**
 * Normalize the model so its bounding box matches a real-world target
 * dimension, like PROP_TARGETS does for cloned props. Omit to use the
 * model's authored scale (kit assets are meter-scaled).
 */
export interface KitFit {
  size: number;
  axis: "height" | "length";
}

/** One placed kit asset; the layer groups these by assetId. */
export interface KitEntry extends KitPlacement {
  assetId: string;
}

interface SubMesh {
  geometry: THREE.BufferGeometry;
  material: THREE.Material | THREE.Material[];
  matrix: THREE.Matrix4;
}

const UP = new THREE.Vector3(0, 1, 0);

/** Extra instance capacity allocated on growth, so streaming a few more
 * placements updates matrices in place instead of reallocating buffers. */
const CAPACITY_HEADROOM = 1.5;

/** All placements of a single kit asset as instanced meshes. */
export function InstancedKitAsset({
  assetId,
  placements,
  fit,
}: {
  assetId: string;
  placements: KitPlacement[];
  fit?: KitFit;
}) {
  const model = useSharedModel(assetId);
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);

  // Flatten the (small) GLB node hierarchy into geometry/material/transform
  // triples once; instance matrices bake each node transform back in.
  const subMeshes = useMemo<SubMesh[]>(() => {
    if (!model) return [];
    model.scene.updateMatrixWorld(true);
    const out: SubMesh[] = [];
    model.scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh) {
        out.push({
          geometry: mesh.geometry,
          material: mesh.material,
          matrix: mesh.matrixWorld.clone(),
        });
      }
    });
    return out;
  }, [model]);

  // The group lives as long as the model does; placement changes rewrite the
  // instance matrices in place (growing capacity only when exceeded), so
  // chunk streaming does not reallocate GPU buffers every rebuild.
  const group = useMemo(() => {
    if (!model || subMeshes.length === 0) return null;
    return new THREE.Group();
  }, [model, subMeshes]);

  useEffect(() => {
    if (!group || !model) return;

    let normScale = 1;
    if (fit) {
      const measured =
        fit.axis === "height" ? model.size.y : Math.max(model.size.x, model.size.z);
      if (measured > 1e-4) normScale = fit.size / measured;
    }

    const place = new THREE.Matrix4();
    const final = new THREE.Matrix4();
    const quat = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    const count = placements.length;

    const bySub = (group.userData.bySub ??= []) as (THREE.InstancedMesh | undefined)[];
    for (let s = 0; s < subMeshes.length; s++) {
      const sub = subMeshes[s];
      let im = bySub[s];
      const capacity = im ? (im.userData.capacity as number) : 0;
      if (!im || capacity < count) {
        const first = !im;
        if (im) {
          group.remove(im);
          im.dispose();
        }
        const alloc = Math.max(4, Math.ceil(count * CAPACITY_HEADROOM));
        im = new THREE.InstancedMesh(sub.geometry, sub.material, alloc);
        im.userData.capacity = alloc;
        im.castShadow = true;
        im.receiveShadow = true;
        group.add(im);
        bySub[s] = im;
        if (first) {
          // First appearance of this asset's instanced program: compile it
          // off the render path so the reveal frame doesn't stall on a
          // synchronous shader build. Capacity regrowth reuses the program.
          const mesh = im;
          mesh.userData.compiling = true;
          gl.compileAsync(mesh, camera, scene)
            .catch(() => undefined)
            .then(() => {
              mesh.userData.compiling = false;
              mesh.visible = mesh.userData.wantVisible === true;
            });
        }
      }
      for (let i = 0; i < count; i++) {
        const p = placements[i];
        const ps = p.scale ?? 1;
        if (Array.isArray(ps)) {
          scl.set(normScale * ps[0], normScale * ps[1], normScale * ps[2]);
        } else {
          scl.setScalar(normScale * ps);
        }
        // Snap the (scaled) model bottom to the placement's ground y.
        pos.set(p.x, p.y - model.minY * scl.y, p.z);
        quat.setFromAxisAngle(UP, p.rotationY);
        place.compose(pos, quat, scl);
        final.multiplyMatrices(place, sub.matrix);
        im.setMatrixAt(i, final);
      }
      im.count = count;
      im.instanceMatrix.needsUpdate = true;
      im.userData.wantVisible = count > 0;
      im.visible = count > 0 && im.userData.compiling !== true;
      if (count > 0) im.computeBoundingSphere();
    }
  }, [group, model, subMeshes, placements, fit, gl, scene, camera]);

  // Release per-instance GPU buffers on unmount; geometry and materials
  // belong to the shared model cache and stay alive.
  useEffect(() => {
    return () => {
      group?.traverse((obj) => {
        if ((obj as THREE.InstancedMesh).isInstancedMesh) {
          (obj as THREE.InstancedMesh).dispose();
        }
      });
    };
  }, [group]);

  if (!group) return null;
  return <primitive object={group} />;
}

/**
 * Renders a flat list of kit placements, grouped by asset id. Rebuilds when
 * the list identity changes (callers memo on the streamed chunk set).
 */
export function InstancedKit({
  entries,
  fits,
}: {
  entries: KitEntry[];
  fits?: Record<string, KitFit>;
}) {
  const byAsset = useMemo(() => {
    const map = new Map<string, KitPlacement[]>();
    for (const e of entries) {
      let list = map.get(e.assetId);
      if (!list) {
        list = [];
        map.set(e.assetId, list);
      }
      list.push(e);
    }
    return map;
  }, [entries]);

  return (
    <>
      {[...byAsset.entries()].map(([assetId, placements]) => (
        <InstancedKitAsset
          key={assetId}
          assetId={assetId}
          placements={placements}
          fit={fits?.[assetId]}
        />
      ))}
    </>
  );
}
