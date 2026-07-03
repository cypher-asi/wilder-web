// Short-lived combat visuals: tracers + muzzle flashes for ranged shots,
// impact sparks, shell casings, hit sparks with floating damage numbers,
// and a death pulse. Events are queued in `game.fx` by the connection layer
// (or PlayerInput for instant local feedback) and drained here each frame.

import { Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { perf } from "../perf/perf";
import { CombatFxEvent, game } from "../state/game";
import { groundHeightAt } from "./Ground";

/** Projectile travel speed (m/s); the bolt's lifetime scales with distance. */
const PROJECTILE_SPEED = 40;

const LIFETIME_MS: Record<CombatFxEvent["type"], number> = {
  // Upper bound for pruning: max weapon range / projectile speed.
  tracer: 550,
  hit: 800,
  death: 600,
  shockwave: 550,
  flash: 90,
  impact: 380,
  shell: 700,
};

interface ActiveFx {
  id: number;
  ev: CombatFxEvent;
}

let nextFxId = 1;

export function CombatFx() {
  const [effects, setEffects] = useState<ActiveFx[]>([]);

  useFrame(() => {
    if (game.fx.length === 0) return;
    perf.begin("combatFx");
    const drained = game.fx.splice(0, game.fx.length);
    setEffects((prev) =>
      [...prev, ...drained.map((ev) => ({ id: nextFxId++, ev }))].slice(-48),
    );
    perf.end("combatFx");
  });

  // Prune expired effects (component animations end well before this).
  useEffect(() => {
    const timer = setInterval(() => {
      const now = performance.now();
      setEffects((prev) => {
        const alive = prev.filter((e) => now - e.ev.at < LIFETIME_MS[e.ev.type] + 200);
        return alive.length === prev.length ? prev : alive;
      });
    }, 400);
    return () => clearInterval(timer);
  }, []);

  return (
    <>
      {effects.map(({ id, ev }) =>
        ev.type === "tracer" ? (
          <Tracer key={id} ev={ev} />
        ) : ev.type === "hit" ? (
          <HitFx key={id} ev={ev} />
        ) : ev.type === "shockwave" ? (
          <ShockwaveRing key={id} ev={ev} />
        ) : ev.type === "flash" ? (
          <MuzzleFlashFx key={id} ev={ev} />
        ) : ev.type === "impact" ? (
          <ImpactBurst key={id} ev={ev} />
        ) : ev.type === "shell" ? (
          <ShellCasing key={id} ev={ev} />
        ) : (
          <DeathPulse key={id} ev={ev} />
        ),
      )}
    </>
  );
}

const UP = new THREE.Vector3(0, 1, 0);

/**
 * Visible projectile: a bright bolt that flies from the muzzle to the end
 * point at a constant speed (so nearby shots arrive fast and long shots read
 * as a travelling bullet), dragging a fading streak trail behind it.
 */
function Tracer({ ev }: { ev: Extract<CombatFxEvent, { type: "tracer" }> }) {
  const group = useRef<THREE.Group>(null);
  const trail = useRef<THREE.Mesh>(null);

  const { from, dir, dist, quat, travelMs } = useMemo(() => {
    const from = new THREE.Vector3(ev.fx, ev.fy, ev.fz);
    const to = new THREE.Vector3(ev.tx, ev.ty, ev.tz);
    const delta = to.clone().sub(from);
    const dist = Math.max(delta.length(), 0.1);
    const dir = delta.normalize();
    const quat = new THREE.Quaternion().setFromUnitVectors(UP, dir);
    const travelMs = (dist / PROJECTILE_SPEED) * 1000;
    return { from, dir, dist, quat, travelMs };
  }, [ev]);

  useFrame(() => {
    if (!group.current) return;
    const t = (performance.now() - ev.at) / travelMs;
    if (t >= 1) {
      group.current.visible = false;
      return;
    }
    group.current.visible = true;
    const head = t * dist;
    group.current.position.copy(from).addScaledVector(dir, head);
    if (trail.current) {
      // Trail stretches behind the bolt but never past the muzzle.
      const len = Math.min(head, 0.9);
      trail.current.scale.set(1, Math.max(len, 0.05), 1);
      trail.current.position.set(0, -len / 2 - 0.06, 0);
      (trail.current.material as THREE.MeshBasicMaterial).opacity =
        THREE.MathUtils.clamp(1 - t * 0.5, 0, 1) * 0.5;
    }
  });

  return (
    <group ref={group} quaternion={quat} visible={false}>
      {/* Bolt head: hot elongated slug. Opaque core so it stays visible on
          bright daylight backgrounds where additive glow washes out. */}
      <mesh scale={[1, 0.45, 1]}>
        <cylinderGeometry args={[0.05, 0.05, 1, 6]} />
        <meshBasicMaterial color="#fffbe8" toneMapped={false} />
      </mesh>
      {/* Additive halo around the core. */}
      <mesh scale={[1, 0.55, 1]}>
        <cylinderGeometry args={[0.1, 0.1, 1, 6]} />
        <meshBasicMaterial
          color="#ffca6a"
          transparent
          opacity={0.55}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </mesh>
      {/* Fading streak trail behind the bolt. */}
      <mesh ref={trail}>
        <cylinderGeometry args={[0.035, 0.035, 1, 5]} />
        <meshBasicMaterial
          color="#ffd27a"
          transparent
          opacity={0.5}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </mesh>
    </group>
  );
}

/** Crossed additive star + light at the muzzle for a single shot. */
function MuzzleFlashFx({ ev }: { ev: Extract<CombatFxEvent, { type: "flash" }> }) {
  const group = useRef<THREE.Group>(null);
  const light = useRef<THREE.PointLight>(null);
  const material = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: "#ffe3a0",
        transparent: true,
        opacity: 1,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    [],
  );
  const baseScale = useMemo(() => 0.85 + Math.random() * 0.35, []);

  useFrame(() => {
    const t = (performance.now() - ev.at) / LIFETIME_MS.flash;
    const fade = THREE.MathUtils.clamp(1 - t, 0, 1);
    if (group.current) {
      group.current.visible = t < 1;
      group.current.scale.setScalar(baseScale * (0.7 + t * 0.6));
    }
    material.opacity = fade;
    if (light.current) light.current.intensity = fade * 22;
  });

  return (
    <group
      ref={group}
      position={[ev.x, ev.y, ev.z]}
      rotation={[0, -ev.yaw, 0]}
      visible={false}
    >
      {/* long tongue along the barrel (flat, reads from the top-down camera) */}
      <mesh material={material} rotation={[-Math.PI / 2, 0, 0]} position={[0.28, 0, 0]}>
        <planeGeometry args={[0.62, 0.16]} />
      </mesh>
      {/* side spikes */}
      <mesh material={material} rotation={[-Math.PI / 2, 0, Math.PI / 2]} position={[0.1, 0, 0]}>
        <planeGeometry args={[0.34, 0.12]} />
      </mesh>
      {/* vertical fin so the flash also reads at low camera angles */}
      <mesh material={material} position={[0.28, 0, 0]}>
        <planeGeometry args={[0.5, 0.14]} />
      </mesh>
      <pointLight ref={light} color="#ffbf60" intensity={22} distance={8} />
    </group>
  );
}

const IMPACT_COLORS = { flesh: "#ff5a4a", dust: "#d8cdb6" } as const;
const IMPACT_GRAVITY = 7;

/** Directional spark burst where a shot lands (flesh) or whiffs (dust). */
function ImpactBurst({ ev }: { ev: Extract<CombatFxEvent, { type: "impact" }> }) {
  const group = useRef<THREE.Group>(null);
  const material = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: IMPACT_COLORS[ev.kind],
        transparent: true,
        opacity: 0.95,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    [ev.kind],
  );
  // Sparks fly back along the incoming shot with random spread + lift.
  const parts = useMemo(
    () =>
      Array.from({ length: 6 }, () => ({
        vx: -ev.dirX * (1.5 + Math.random() * 2.5) + (Math.random() - 0.5) * 2.4,
        vy: 1.2 + Math.random() * 2.4,
        vz: -ev.dirZ * (1.5 + Math.random() * 2.5) + (Math.random() - 0.5) * 2.4,
        size: 0.035 + Math.random() * 0.05,
      })),
    [ev],
  );

  useFrame(() => {
    if (!group.current) return;
    const t = (performance.now() - ev.at) / 1000;
    const life = (performance.now() - ev.at) / LIFETIME_MS.impact;
    group.current.visible = life < 1;
    if (life >= 1) return;
    material.opacity = THREE.MathUtils.clamp(1 - life, 0, 1) * 0.95;
    group.current.children.forEach((child, i) => {
      const p = parts[i];
      child.position.set(
        p.vx * t,
        p.vy * t - IMPACT_GRAVITY * t * t * 0.5,
        p.vz * t,
      );
    });
  });

  return (
    <group ref={group} position={[ev.x, ev.y, ev.z]}>
      {parts.map((p, i) => (
        <mesh key={i} material={material}>
          <sphereGeometry args={[p.size, 4, 4]} />
        </mesh>
      ))}
    </group>
  );
}

/** Spent casing ejected sideways with spin and gravity. */
function ShellCasing({ ev }: { ev: Extract<CombatFxEvent, { type: "shell" }> }) {
  const mesh = useRef<THREE.Mesh>(null);
  const v = useMemo(
    () => ({
      x: ev.dirX * (1.0 + Math.random() * 0.9) + (Math.random() - 0.5) * 0.5,
      y: 2.0 + Math.random() * 1.2,
      z: ev.dirZ * (1.0 + Math.random() * 0.9) + (Math.random() - 0.5) * 0.5,
      spinX: 8 + Math.random() * 18,
      spinZ: 8 + Math.random() * 18,
    }),
    [ev],
  );

  useFrame(() => {
    if (!mesh.current) return;
    const life = (performance.now() - ev.at) / LIFETIME_MS.shell;
    mesh.current.visible = life < 1;
    if (life >= 1) return;
    const t = (performance.now() - ev.at) / 1000;
    const x = ev.x + v.x * t;
    const z = ev.z + v.z * t;
    const floor = groundHeightAt(x, z) + 0.03;
    const y = ev.y + v.y * t - 9.8 * t * t * 0.5;
    mesh.current.position.set(x, Math.max(y, floor), z);
    if (y > floor) {
      mesh.current.rotation.x = v.spinX * t;
      mesh.current.rotation.z = v.spinZ * t;
    }
    (mesh.current.material as THREE.MeshStandardMaterial).opacity =
      THREE.MathUtils.clamp((1 - life) * 4, 0, 1);
  });

  return (
    <mesh ref={mesh} visible={false}>
      <cylinderGeometry args={[0.014, 0.014, 0.05, 6]} />
      <meshStandardMaterial
        color="#d9a63c"
        metalness={0.8}
        roughness={0.35}
        transparent
        opacity={1}
      />
    </mesh>
  );
}

/** Impact spark + floating damage number. */
function HitFx({ ev }: { ev: Extract<CombatFxEvent, { type: "hit" }> }) {
  const spark = useRef<THREE.Mesh>(null);
  // Random horizontal drift so rapid hits scatter up and around.
  const drift = useMemo(() => `${(Math.random() - 0.5) * 64}px`, []);

  useFrame(() => {
    if (!spark.current) return;
    const t = (performance.now() - ev.at) / 220;
    spark.current.visible = t < 1;
    if (t < 1) {
      spark.current.scale.setScalar(0.35 + t * 0.65);
      (spark.current.material as THREE.MeshBasicMaterial).opacity =
        THREE.MathUtils.clamp(1 - t, 0, 1) * 0.55;
    }
  });

  return (
    <group position={[ev.x, ev.y, ev.z]}>
      <mesh ref={spark}>
        <sphereGeometry args={[0.22, 8, 8]} />
        <meshBasicMaterial
          color="#ffe9b0"
          transparent
          opacity={0.55}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </mesh>
      <Html center zIndexRange={[4, 0]} style={{ pointerEvents: "none" }}>
        <div
          className="dmg-float"
          style={{ "--dx": drift } as CSSProperties}
        >
          {Math.round(ev.damage)}
        </div>
      </Html>
    </group>
  );
}

/** Shockwave ability: cyan ring expanding to the damage radius. */
function ShockwaveRing({ ev }: { ev: Extract<CombatFxEvent, { type: "shockwave" }> }) {
  const ring = useRef<THREE.Mesh>(null);
  const RADIUS = 4; // mirrors wilder-combat SHOCKWAVE_RADIUS

  useFrame(() => {
    if (!ring.current) return;
    const t = (performance.now() - ev.at) / LIFETIME_MS.shockwave;
    ring.current.visible = t < 1;
    if (t < 1) {
      const ease = 1 - (1 - t) * (1 - t);
      ring.current.scale.setScalar(0.3 + ease * RADIUS);
      (ring.current.material as THREE.MeshBasicMaterial).opacity =
        THREE.MathUtils.clamp(1 - t, 0, 1) * 0.85;
    }
  });

  return (
    <mesh ref={ring} position={[ev.x, 0.08, ev.z]} rotation={[-Math.PI / 2, 0, 0]}>
      <ringGeometry args={[0.82, 1.0, 48]} />
      <meshBasicMaterial
        color="#40e8ff"
        transparent
        opacity={0.85}
        blending={THREE.AdditiveBlending}
        depthWrite={false}
      />
    </mesh>
  );
}

/** Expanding ground ring when something dies. */
function DeathPulse({ ev }: { ev: Extract<CombatFxEvent, { type: "death" }> }) {
  const ring = useRef<THREE.Mesh>(null);

  useFrame(() => {
    if (!ring.current) return;
    const t = (performance.now() - ev.at) / LIFETIME_MS.death;
    ring.current.visible = t < 1;
    if (t < 1) {
      ring.current.scale.setScalar(0.3 + t * 2.2);
      (ring.current.material as THREE.MeshBasicMaterial).opacity =
        THREE.MathUtils.clamp(1 - t, 0, 1) * 0.7;
    }
  });

  return (
    <group>
      <mesh ref={ring} position={[ev.x, 0.06, ev.z]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.7, 0.85, 32]} />
        <meshBasicMaterial
          color="#ff5d5d"
          transparent
          opacity={0.7}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </mesh>
      {/* Red skull that floats up over the corpse. */}
      <group position={[ev.x, ev.y + 1.2, ev.z]}>
        <Html center zIndexRange={[5, 0]} style={{ pointerEvents: "none" }}>
          <div className="death-skull">
            <svg viewBox="0 0 32 32" width={30} height={30} aria-hidden="true">
              <path
                fill="#ff2a3a"
                d="M16 2C9.4 2 4 7 4 13.3c0 3.6 1.8 6.4 4.4 8.3.5.4.8 1 .8 1.6v1.5c0 .9.7 1.6 1.6 1.6h1.1v-2.3c0-.5.4-.9.9-.9s.9.4.9.9V26h2.6v-2.3c0-.5.4-.9.9-.9s.9.4.9.9V26h1.1c.9 0 1.6-.7 1.6-1.6v-1.5c0-.6.3-1.2.8-1.6 2.6-1.9 4.4-4.7 4.4-8.3C28 7 22.6 2 16 2zm-5.6 13.3a2.6 2.6 0 1 1 0-5.2 2.6 2.6 0 0 1 0 5.2zm11.2 0a2.6 2.6 0 1 1 0-5.2 2.6 2.6 0 0 1 0 5.2zM16 16.6c.7 0 1.2.7 1 1.4l-.5 2.2c-.1.5-.9.5-1 0l-.5-2.2c-.2-.7.3-1.4 1-1.4z"
              />
            </svg>
          </div>
        </Html>
      </group>
    </group>
  );
}
