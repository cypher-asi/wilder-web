// Hover target diagram: when the cursor is over an enemy, a thin React
// diamond-in-diamond reticle locks onto it, always facing the camera via a
// screen-space drei Html overlay, with a quick scale-in snap on acquire.

import { Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { game } from "../state/game";

/** Center of mass used as the fallback / plane anchor, m above the feet. */
const CHEST_HEIGHT = 1.0;
/** Character silhouette half-extents the reticle is clamped within (m). */
const BODY_HALF_WIDTH = 0.4;
const BODY_FOOT = 0.25;
const BODY_HEAD = 1.85;

export function TargetReticle() {
  const group = useRef<THREE.Group>(null);
  const [visible, setVisible] = useState(false);
  const lastVisible = useRef(false);
  const [acquireKey, setAcquireKey] = useState(0);
  const lastTarget = useRef<number | null>(null);

  const raycaster = useMemo(() => new THREE.Raycaster(), []);
  const ndc = useMemo(() => new THREE.Vector2(), []);
  const plane = useMemo(() => new THREE.Plane(), []);
  const normal = useMemo(() => new THREE.Vector3(), []);
  const anchor = useMemo(() => new THREE.Vector3(), []);
  const hit = useMemo(() => new THREE.Vector3(), []);

  useFrame(({ camera }) => {
    if (!group.current) return;
    const id = game.hoverTargetId;
    const target = id != null ? game.entities.get(id) : undefined;
    const valid = !!target && target.healthPct > 0 && target.anim !== "Death";

    if (valid !== lastVisible.current) {
      lastVisible.current = valid;
      setVisible(valid);
    }
    if (!valid || !target) {
      lastTarget.current = null;
      return;
    }
    // Re-trigger the snap-in whenever a new enemy is acquired.
    if (lastTarget.current !== id) {
      lastTarget.current = id ?? null;
      setAcquireKey((k) => k + 1);
    }

    // Place the diamond where the cursor lands on the enemy: intersect the
    // mouse ray with a camera-facing plane through the target, then clamp the
    // point to the character's silhouette so it slides over the body/head
    // instead of sitting at a fixed chest point.
    anchor.set(target.x, target.y + CHEST_HEIGHT, target.z);
    if (game.pointer.inside) {
      camera.getWorldDirection(normal);
      plane.setFromNormalAndCoplanarPoint(normal, anchor);
      ndc.set(game.pointer.ndcX, game.pointer.ndcY);
      raycaster.setFromCamera(ndc, camera);
      if (raycaster.ray.intersectPlane(plane, hit)) {
        const ox = THREE.MathUtils.clamp(hit.x - target.x, -BODY_HALF_WIDTH, BODY_HALF_WIDTH);
        const oz = THREE.MathUtils.clamp(hit.z - target.z, -BODY_HALF_WIDTH, BODY_HALF_WIDTH);
        const oy = THREE.MathUtils.clamp(hit.y - target.y, BODY_FOOT, BODY_HEAD);
        group.current.position.set(target.x + ox, target.y + oy, target.z + oz);
        return;
      }
    }
    group.current.position.copy(anchor);
  });

  return (
    <group ref={group}>
      {visible && (
        <Html center zIndexRange={[6, 0]} style={{ pointerEvents: "none" }}>
          <div key={acquireKey} className="target-reticle">
            <span className="target-reticle-outer" />
            <span className="target-reticle-inner" />
          </div>
        </Html>
      )}
    </group>
  );
}
