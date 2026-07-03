// Hover target diagram: when the cursor is over an enemy, a thin React
// diamond-in-diamond reticle locks onto it, always facing the camera via a
// screen-space drei Html overlay, with a quick scale-in snap on acquire.

import { Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useRef, useState } from "react";
import * as THREE from "three";
import { game } from "../state/game";

const CHEST_HEIGHT = 1.15;

export function TargetReticle() {
  const group = useRef<THREE.Group>(null);
  const [visible, setVisible] = useState(false);
  const lastVisible = useRef(false);
  const [acquireKey, setAcquireKey] = useState(0);
  const lastTarget = useRef<number | null>(null);

  useFrame(() => {
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
    group.current.position.set(target.x, target.y + CHEST_HEIGHT, target.z);
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
