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
import { RED_HEX } from "../ui/colors";
import { cameraState } from "./CameraRig";
import { groundHeightAt } from "./Ground";
import { itemSpriteMaterial } from "./itemSprite";

/** Projectile travel speed (m/s); the bolt's lifetime scales with distance. */
const PROJECTILE_SPEED = 40;

const LIFETIME_MS: Record<CombatFxEvent["type"], number> = {
  // Upper bound for pruning: max weapon range / projectile speed.
  tracer: 550,
  hit: 800,
  death: 600,
  gib: 700,
  shockwave: 550,
  flash: 90,
  impact: 380,
  shell: 700,
  lootPop: 650,
  coinBurst: 900,
};

interface ActiveFx {
  id: number;
  ev: CombatFxEvent;
}

let nextFxId = 1;

// ---------------------------------------------------------------------------
// Shared GPU resources. Effect components mount/unmount constantly during
// combat; keeping geometries (and immutable materials) at module scope avoids
// re-creating and re-uploading buffers per shot. Meshes that use them carry
// dispose={null} so R3F leaves the shared objects alone on unmount; materials
// whose opacity is animated per instance are cloned from a base (cheap: the
// shader program is shared) and disposed in an effect cleanup.
// ---------------------------------------------------------------------------

const TRACER_CORE_GEO = new THREE.CylinderGeometry(0.05, 0.05, 1, 6);
const TRACER_HALO_GEO = new THREE.CylinderGeometry(0.1, 0.1, 1, 6);
const TRACER_TRAIL_GEO = new THREE.CylinderGeometry(0.035, 0.035, 1, 5);
const FLASH_TONGUE_GEO = new THREE.PlaneGeometry(0.62, 0.16);
const FLASH_SPIKE_GEO = new THREE.PlaneGeometry(0.34, 0.12);
const FLASH_FIN_GEO = new THREE.PlaneGeometry(0.5, 0.14);
const IMPACT_PART_GEO = new THREE.SphereGeometry(1, 4, 4);
const SHELL_GEO = new THREE.CylinderGeometry(0.014, 0.014, 0.05, 6);
const HIT_SPARK_GEO = new THREE.SphereGeometry(0.22, 8, 8);
const SHOCKWAVE_GEO = new THREE.RingGeometry(0.82, 1.0, 48);
const DEATH_RING_GEO = new THREE.RingGeometry(0.7, 0.85, 32);

const TRACER_CORE_MAT = new THREE.MeshBasicMaterial({
  color: "#dff3ff",
  toneMapped: false,
});
const TRACER_HALO_MAT = new THREE.MeshBasicMaterial({
  color: "#4fc3ff",
  transparent: true,
  opacity: 0.55,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
});
const TRACER_TRAIL_MAT_BASE = new THREE.MeshBasicMaterial({
  color: "#4fd0e0",
  transparent: true,
  opacity: 0.5,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
});
const FLASH_MAT_BASE = new THREE.MeshBasicMaterial({
  color: "#bfe9ff",
  transparent: true,
  opacity: 1,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  side: THREE.DoubleSide,
});
const SHELL_MAT_BASE = new THREE.MeshStandardMaterial({
  color: "#d9a63c",
  metalness: 0.8,
  roughness: 0.35,
  transparent: true,
  opacity: 1,
});
const HIT_SPARK_MAT_BASE = new THREE.MeshBasicMaterial({
  color: "#ffe9b0",
  transparent: true,
  opacity: 0.55,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
});
const SHOCKWAVE_MAT_BASE = new THREE.MeshBasicMaterial({
  color: "#40e8ff",
  transparent: true,
  opacity: 0.85,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
});
const DEATH_RING_MAT_BASE = new THREE.MeshBasicMaterial({
  color: RED_HEX,
  transparent: true,
  opacity: 0.7,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
});

/** Per-instance clone of a base material, disposed when the effect unmounts. */
function useClonedMaterial<T extends THREE.Material>(base: T): T {
  const mat = useMemo(() => base.clone() as T, [base]);
  useEffect(() => () => mat.dispose(), [mat]);
  return mat;
}

// ---------------------------------------------------------------------------
// Pooled damage numbers. The previous drei <Html> floats created/destroyed
// DOM nodes per hit and forced layout work every frame; these are plain
// sprites with small canvas textures, driven by one imperative update loop
// with zero React/DOM involvement.
// ---------------------------------------------------------------------------

const DMG_POOL_SIZE = 24;
const DMG_CANVAS_W = 96;
const DMG_CANVAS_H = 40;
const DMG_BASE_W = 1.15;
const DMG_BASE_H = DMG_BASE_W * (DMG_CANVAS_H / DMG_CANVAS_W);

interface DmgEntry {
  sprite: THREE.Sprite;
  material: THREE.SpriteMaterial;
  texture: THREE.CanvasTexture;
  ctx: CanvasRenderingContext2D;
  bornAt: number;
  x: number;
  y: number;
  z: number;
  driftX: number;
  driftZ: number;
  active: boolean;
}

class DamageNumberPool {
  readonly group = new THREE.Group();
  private entries: DmgEntry[] = [];
  private cursor = 0;

  constructor() {
    for (let i = 0; i < DMG_POOL_SIZE; i++) {
      const canvas = document.createElement("canvas");
      canvas.width = DMG_CANVAS_W;
      canvas.height = DMG_CANVAS_H;
      const ctx = canvas.getContext("2d")!;
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      const material = new THREE.SpriteMaterial({
        map: texture,
        transparent: true,
        depthWrite: false,
        depthTest: false, // always readable, like the old DOM overlay
        toneMapped: false,
      });
      const sprite = new THREE.Sprite(material);
      sprite.visible = false;
      sprite.renderOrder = 100;
      this.group.add(sprite);
      this.entries.push({
        sprite,
        material,
        texture,
        ctx,
        bornAt: 0,
        x: 0,
        y: 0,
        z: 0,
        driftX: 0,
        driftZ: 0,
        active: false,
      });
    }
  }

  spawn(x: number, y: number, z: number, damage: number) {
    const e = this.entries[this.cursor];
    this.cursor = (this.cursor + 1) % this.entries.length;
    this.draw(e, damage);
    e.bornAt = performance.now();
    e.x = x;
    e.y = y;
    e.z = z;
    e.driftX = (Math.random() - 0.5) * 1.1;
    e.driftZ = (Math.random() - 0.5) * 1.1;
    e.active = true;
    e.sprite.visible = true;
  }

  /** Mirrors the old CSS dmg-rise keyframes: pop in, drift up, fade out. */
  update(now: number) {
    // The old DOM floats were constant screen-size; scale with camera
    // distance so the sprites read the same at any zoom.
    const zoom = cameraState.distance / 48;
    for (const e of this.entries) {
      if (!e.active) continue;
      const t = (now - e.bornAt) / LIFETIME_MS.hit;
      if (t >= 1) {
        e.active = false;
        e.sprite.visible = false;
        continue;
      }
      const ease = 1 - (1 - t) * (1 - t);
      e.sprite.position.set(
        e.x + e.driftX * ease,
        e.y + ease * 1.3,
        e.z + e.driftZ * ease,
      );
      const pop =
        (t < 0.15 ? 0.7 + (t / 0.15) * 0.5 : 1.2 - ((t - 0.15) / 0.85) * 0.25) *
        zoom;
      e.sprite.scale.set(DMG_BASE_W * pop, DMG_BASE_H * pop, 1);
      e.material.opacity = t < 0.15 ? t / 0.15 : 1 - (t - 0.15) / 0.85;
    }
  }

  private draw(e: DmgEntry, damage: number) {
    const { ctx } = e;
    const text = String(Math.round(damage));
    ctx.clearRect(0, 0, DMG_CANVAS_W, DMG_CANVAS_H);
    ctx.font = "800 26px dDin, 'Segoe UI', system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    // Two passes to match the CSS text-shadow: dark drop + red glow.
    ctx.shadowColor = "#000";
    ctx.shadowBlur = 2;
    ctx.shadowOffsetY = 1;
    ctx.fillStyle = RED_HEX;
    ctx.fillText(text, DMG_CANVAS_W / 2, DMG_CANVAS_H / 2);
    ctx.shadowColor = "rgba(255, 106, 124, 0.7)";
    ctx.shadowBlur = 8;
    ctx.shadowOffsetY = 0;
    ctx.fillText(text, DMG_CANVAS_W / 2, DMG_CANVAS_H / 2);
    e.texture.needsUpdate = true;
  }

  dispose() {
    for (const e of this.entries) {
      e.texture.dispose();
      e.material.dispose();
    }
  }
}

export function CombatFx() {
  const [effects, setEffects] = useState<ActiveFx[]>([]);
  const dmgPool = useMemo(() => new DamageNumberPool(), []);
  useEffect(() => () => dmgPool.dispose(), [dmgPool]);
  if (import.meta.env.DEV) {
    (window as unknown as { __dmgPool?: DamageNumberPool }).__dmgPool = dmgPool;
  }

  useFrame(() => {
    perf.begin("combatFx");
    if (game.fx.length > 0) {
      const drained = game.fx.splice(0, game.fx.length);
      for (const ev of drained) {
        if (ev.type === "hit") dmgPool.spawn(ev.x, ev.y, ev.z, ev.damage);
      }
      setEffects((prev) =>
        [...prev, ...drained.map((ev) => ({ id: nextFxId++, ev }))].slice(-48),
      );
    }
    dmgPool.update(performance.now());
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
      <primitive object={dmgPool.group} />
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
        ) : ev.type === "lootPop" ? (
          <LootPopFx key={id} ev={ev} />
        ) : ev.type === "coinBurst" ? (
          <CoinBurstFx key={id} ev={ev} />
        ) : ev.type === "gib" ? (
          <GibBurst key={id} ev={ev} />
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
  const trailMat = useClonedMaterial(TRACER_TRAIL_MAT_BASE);

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
      trailMat.opacity = THREE.MathUtils.clamp(1 - t * 0.5, 0, 1) * 0.5;
    }
  });

  return (
    <group ref={group} quaternion={quat} visible={false}>
      {/* Bolt head: hot elongated slug. Opaque core so it stays visible on
          bright daylight backgrounds where additive glow washes out. */}
      <mesh
        scale={[1, 0.45, 1]}
        geometry={TRACER_CORE_GEO}
        material={TRACER_CORE_MAT}
        dispose={null}
      />
      {/* Additive halo around the core. */}
      <mesh
        scale={[1, 0.55, 1]}
        geometry={TRACER_HALO_GEO}
        material={TRACER_HALO_MAT}
        dispose={null}
      />
      {/* Fading streak trail behind the bolt. */}
      <mesh
        ref={trail}
        geometry={TRACER_TRAIL_GEO}
        material={trailMat}
        dispose={null}
      />
    </group>
  );
}

/** Crossed additive star + light at the muzzle for a single shot. */
function MuzzleFlashFx({ ev }: { ev: Extract<CombatFxEvent, { type: "flash" }> }) {
  const group = useRef<THREE.Group>(null);
  const light = useRef<THREE.PointLight>(null);
  const material = useClonedMaterial(FLASH_MAT_BASE);
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
      <mesh
        geometry={FLASH_TONGUE_GEO}
        material={material}
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0.28, 0, 0]}
        dispose={null}
      />
      {/* side spikes */}
      <mesh
        geometry={FLASH_SPIKE_GEO}
        material={material}
        rotation={[-Math.PI / 2, 0, Math.PI / 2]}
        position={[0.1, 0, 0]}
        dispose={null}
      />
      {/* vertical fin so the flash also reads at low camera angles */}
      <mesh
        geometry={FLASH_FIN_GEO}
        material={material}
        position={[0.28, 0, 0]}
        dispose={null}
      />
      <pointLight ref={light} color="#8fdcff" intensity={22} distance={8} />
    </group>
  );
}

const IMPACT_COLORS = { flesh: "#ff5a4a", dust: "#d8cdb6" } as const;
const IMPACT_GRAVITY = 7;

/** Directional spark burst where a shot lands (flesh) or whiffs (dust). */
function ImpactBurst({ ev }: { ev: Extract<CombatFxEvent, { type: "impact" }> }) {
  const group = useRef<THREE.Group>(null);
  const material = useClonedMaterial(HIT_SPARK_MAT_BASE);
  useMemo(() => {
    material.color.set(IMPACT_COLORS[ev.kind]);
    material.opacity = 0.95;
  }, [material, ev.kind]);
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
        <mesh
          key={i}
          geometry={IMPACT_PART_GEO}
          material={material}
          scale={p.size}
          dispose={null}
        />
      ))}
    </group>
  );
}

/** Spent casing ejected sideways with spin and gravity. */
function ShellCasing({ ev }: { ev: Extract<CombatFxEvent, { type: "shell" }> }) {
  const mesh = useRef<THREE.Mesh>(null);
  const material = useClonedMaterial(SHELL_MAT_BASE);
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
    material.opacity = THREE.MathUtils.clamp((1 - life) * 4, 0, 1);
  });

  return (
    <mesh
      ref={mesh}
      visible={false}
      geometry={SHELL_GEO}
      material={material}
      dispose={null}
    />
  );
}

/** Impact spark (the floating damage number comes from DamageNumberPool). */
function HitFx({ ev }: { ev: Extract<CombatFxEvent, { type: "hit" }> }) {
  const spark = useRef<THREE.Mesh>(null);
  const material = useClonedMaterial(HIT_SPARK_MAT_BASE);

  useFrame(() => {
    if (!spark.current) return;
    const t = (performance.now() - ev.at) / 220;
    spark.current.visible = t < 1;
    if (t < 1) {
      spark.current.scale.setScalar(0.35 + t * 0.65);
      material.opacity = THREE.MathUtils.clamp(1 - t, 0, 1) * 0.55;
    }
  });

  return (
    <mesh
      ref={spark}
      position={[ev.x, ev.y, ev.z]}
      geometry={HIT_SPARK_GEO}
      material={material}
      dispose={null}
    />
  );
}

/** Shockwave ability: cyan ring expanding to the damage radius. */
function ShockwaveRing({ ev }: { ev: Extract<CombatFxEvent, { type: "shockwave" }> }) {
  const ring = useRef<THREE.Mesh>(null);
  const material = useClonedMaterial(SHOCKWAVE_MAT_BASE);
  const RADIUS = 4; // mirrors wilder-combat SHOCKWAVE_RADIUS

  useFrame(() => {
    if (!ring.current) return;
    const t = (performance.now() - ev.at) / LIFETIME_MS.shockwave;
    ring.current.visible = t < 1;
    if (t < 1) {
      const ease = 1 - (1 - t) * (1 - t);
      ring.current.scale.setScalar(0.3 + ease * RADIUS);
      material.opacity = THREE.MathUtils.clamp(1 - t, 0, 1) * 0.85;
    }
  });

  return (
    <mesh
      ref={ring}
      position={[ev.x, 0.08, ev.z]}
      rotation={[-Math.PI / 2, 0, 0]}
      geometry={SHOCKWAVE_GEO}
      material={material}
      dispose={null}
    />
  );
}

/** Expanding ground ring when something dies. */
function DeathPulse({ ev }: { ev: Extract<CombatFxEvent, { type: "death" }> }) {
  const ring = useRef<THREE.Mesh>(null);
  const material = useClonedMaterial(DEATH_RING_MAT_BASE);

  useFrame(() => {
    if (!ring.current) return;
    const t = (performance.now() - ev.at) / LIFETIME_MS.death;
    ring.current.visible = t < 1;
    if (t < 1) {
      ring.current.scale.setScalar(0.3 + t * 2.2);
      material.opacity = THREE.MathUtils.clamp(1 - t, 0, 1) * 0.7;
    }
  });

  return (
    <group>
      <mesh
        ref={ring}
        position={[ev.x, 0.06, ev.z]}
        rotation={[-Math.PI / 2, 0, 0]}
        geometry={DEATH_RING_GEO}
        material={material}
        dispose={null}
      />
      {/* Red skull that floats up over the corpse. */}
      <group position={[ev.x, ev.y + 1.2, ev.z]}>
        <Html center zIndexRange={[5, 0]} style={{ pointerEvents: "none" }}>
          <div className="death-skull">
            <svg viewBox="0 0 32 32" width={30} height={30} aria-hidden="true">
              <path
                fill={RED_HEX}
                d="M16 2C9.4 2 4 7 4 13.3c0 3.6 1.8 6.4 4.4 8.3.5.4.8 1 .8 1.6v1.5c0 .9.7 1.6 1.6 1.6h1.1v-2.3c0-.5.4-.9.9-.9s.9.4.9.9V26h2.6v-2.3c0-.5.4-.9.9-.9s.9.4.9.9V26h1.1c.9 0 1.6-.7 1.6-1.6v-1.5c0-.6.3-1.2.8-1.6 2.6-1.9 4.4-4.7 4.4-8.3C28 7 22.6 2 16 2zm-5.6 13.3a2.6 2.6 0 1 1 0-5.2 2.6 2.6 0 0 1 0 5.2zm11.2 0a2.6 2.6 0 1 1 0-5.2 2.6 2.6 0 0 1 0 5.2zM16 16.6c.7 0 1.2.7 1 1.4l-.5 2.2c-.1.5-.9.5-1 0l-.5-2.2c-.2-.7.3-1.4 1-1.4z"
              />
            </svg>
          </div>
        </Html>
      </group>
    </group>
  );
}

const LOOT_SPARK_MAT_BASE = new THREE.MeshBasicMaterial({
  color: "#ffffff",
  transparent: true,
  opacity: 0.8,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
});

/**
 * Collected loot crate: the item's white icon pops up out of the crate spot
 * and fades (Mario coin-block feel), with a few white sparks flying out.
 */
function LootPopFx({ ev }: { ev: Extract<CombatFxEvent, { type: "lootPop" }> }) {
  const icon = useRef<THREE.Sprite>(null);
  const sparks = useRef<THREE.Group>(null);
  const iconMat = useMemo(
    () => (ev.item ? itemSpriteMaterial(ev.item).clone() : null),
    [ev.item],
  );
  useEffect(() => () => iconMat?.dispose(), [iconMat]);
  const sparkMat = useClonedMaterial(LOOT_SPARK_MAT_BASE);
  const dirs = useMemo(
    () =>
      Array.from({ length: 6 }, (_, i) => {
        const a = (i / 6) * Math.PI * 2 + Math.random() * 0.6;
        return { x: Math.cos(a) * 0.8, y: 1.2 + Math.random() * 0.8, z: Math.sin(a) * 0.8 };
      }),
    [],
  );

  useFrame(() => {
    const t = (performance.now() - ev.at) / LIFETIME_MS.lootPop;
    if (t >= 1) {
      if (icon.current) icon.current.visible = false;
      if (sparks.current) sparks.current.visible = false;
      return;
    }
    const ease = 1 - (1 - t) * (1 - t);
    if (icon.current && iconMat) {
      // Coin arc: quick hop up, brief hang, fade out on the way.
      icon.current.position.y = ev.y + 0.7 + ease * 1.0;
      const pop = t < 0.2 ? 0.3 + (t / 0.2) * 0.3 : 0.6;
      icon.current.scale.set(pop, pop, 1);
      iconMat.opacity = t < 0.5 ? 0.95 : 0.95 * (1 - (t - 0.5) / 0.5);
    }
    if (sparks.current) {
      let i = 0;
      for (const child of sparks.current.children) {
        const d = dirs[i++];
        child.position.set(ev.x + d.x * ease, ev.y + 0.5 + d.y * ease - ease * ease * 0.8, ev.z + d.z * ease);
        child.scale.setScalar(0.05 * (1 - t * 0.6));
      }
      sparkMat.opacity = 0.8 * (1 - t);
    }
  });

  return (
    <group>
      {iconMat && (
        <sprite ref={icon} position={[ev.x, ev.y + 0.7, ev.z]} material={iconMat} />
      )}
      <group ref={sparks}>
        {dirs.map((_, i) => (
          <mesh key={i} geometry={IMPACT_PART_GEO} material={sparkMat} dispose={null} />
        ))}
      </group>
    </group>
  );
}

// Flat gold coin disc (thin cylinder) flung out on kills / big rewards. Shared
// geometry + base material; each burst clones the material to fade independently.
const COIN_GEO = new THREE.CylinderGeometry(0.14, 0.14, 0.03, 14);
const COIN_MAT_BASE = new THREE.MeshStandardMaterial({
  color: "#ffcc33",
  emissive: "#ffb300",
  emissiveIntensity: 0.6,
  metalness: 0.7,
  roughness: 0.3,
  transparent: true,
  opacity: 1,
});
// Silver variant for the death shower (distinct from the gold reward coins).
const COIN_MAT_SILVER = new THREE.MeshStandardMaterial({
  color: "#d8dde6",
  emissive: "#9aa6b4",
  emissiveIntensity: 0.5,
  metalness: 0.85,
  roughness: 0.25,
  transparent: true,
  opacity: 1,
});
const COIN_GRAVITY = 11;

// Small angular chunk flung out when a body is destroyed. Tetrahedron reads as
// a jagged gib; tint is set per burst to match the dead entity's body color.
const GIB_GEO = new THREE.TetrahedronGeometry(0.12, 0);
const GIB_MAT_BASE = new THREE.MeshStandardMaterial({
  color: "#ff6a7c",
  emissive: "#ff2d5e",
  emissiveIntensity: 0.5,
  roughness: 0.6,
  metalness: 0.1,
  transparent: true,
  opacity: 1,
});
const GIB_GRAVITY = 9;

/**
 * Gold coins that pop up out of a spot, spin like Mario coins, arc under
 * gravity, and fade — the reward payoff for a kill or a cashed-in gain.
 */
function CoinBurstFx({ ev }: { ev: Extract<CombatFxEvent, { type: "coinBurst" }> }) {
  const group = useRef<THREE.Group>(null);
  const material = useClonedMaterial(
    ev.metal === "silver" ? COIN_MAT_SILVER : COIN_MAT_BASE,
  );
  const coins = useMemo(() => {
    const n = Math.max(1, Math.min(ev.count, 10));
    return Array.from({ length: n }, () => {
      const a = Math.random() * Math.PI * 2;
      const speed = 1.2 + Math.random() * 1.8;
      return {
        vx: Math.cos(a) * speed,
        vy: 3.4 + Math.random() * 2.2,
        vz: Math.sin(a) * speed,
        spin: 12 + Math.random() * 16,
        phase: Math.random() * Math.PI,
      };
    });
  }, [ev.count]);

  useFrame(() => {
    if (!group.current) return;
    const life = (performance.now() - ev.at) / LIFETIME_MS.coinBurst;
    group.current.visible = life < 1;
    if (life >= 1) return;
    const t = (performance.now() - ev.at) / 1000;
    material.opacity = THREE.MathUtils.clamp((1 - life) * 2.2, 0, 1);
    group.current.children.forEach((child, i) => {
      const c = coins[i];
      child.position.set(
        c.vx * t,
        c.vy * t - COIN_GRAVITY * t * t * 0.5,
        c.vz * t,
      );
      // Face-on spin so coins flash their broad side (billboard-ish flip).
      child.rotation.z = c.phase + c.spin * t;
    });
  });

  return (
    <group ref={group} position={[ev.x, ev.y + 0.4, ev.z]}>
      {coins.map((_, i) => (
        <mesh
          key={i}
          geometry={COIN_GEO}
          material={material}
          rotation={[Math.PI / 2, 0, 0]}
          dispose={null}
        />
      ))}
    </group>
  );
}

/**
 * Body-shatter burst: a spray of jagged chunks in the dead entity's body color
 * that fly outward, tumble, and fall under gravity before fading out.
 */
function GibBurst({ ev }: { ev: Extract<CombatFxEvent, { type: "gib" }> }) {
  const group = useRef<THREE.Group>(null);
  const material = useClonedMaterial(GIB_MAT_BASE);
  useMemo(() => {
    material.color.set(ev.color);
    material.emissive.set(ev.color);
  }, [material, ev.color]);
  const parts = useMemo(
    () =>
      Array.from({ length: 12 }, () => {
        const a = Math.random() * Math.PI * 2;
        const speed = 1.6 + Math.random() * 2.8;
        return {
          vx: Math.cos(a) * speed,
          vy: 2.2 + Math.random() * 2.6,
          vz: Math.sin(a) * speed,
          spinX: 6 + Math.random() * 18,
          spinZ: 6 + Math.random() * 18,
          scale: 0.6 + Math.random() * 0.9,
        };
      }),
    [],
  );

  useFrame(() => {
    if (!group.current) return;
    const life = (performance.now() - ev.at) / LIFETIME_MS.gib;
    group.current.visible = life < 1;
    if (life >= 1) return;
    const t = (performance.now() - ev.at) / 1000;
    material.opacity = THREE.MathUtils.clamp((1 - life) * 2, 0, 1);
    group.current.children.forEach((child, i) => {
      const p = parts[i];
      child.position.set(
        p.vx * t,
        p.vy * t - GIB_GRAVITY * t * t * 0.5,
        p.vz * t,
      );
      child.rotation.set(p.spinX * t, 0, p.spinZ * t);
    });
  });

  return (
    <group ref={group} position={[ev.x, ev.y + 0.6, ev.z]}>
      {parts.map((p, i) => (
        <mesh
          key={i}
          geometry={GIB_GEO}
          material={material}
          scale={p.scale}
          dispose={null}
        />
      ))}
    </group>
  );
}
