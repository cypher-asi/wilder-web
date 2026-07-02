// Entity rendering: interpolates remote entities between server snapshots,
// uses the predicted transform for the local player, and animates a rigged
// GLB character when available (procedural runner otherwise).

import { useFrame } from "@react-three/fiber";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { setFootsteps } from "../assets/audio";
import { CHARACTER_MODEL, useAssetModel } from "../assets/catalog";
import { game, GameEntity, useGame } from "../state/game";

/** Render remote entities this many ms in the past for smooth interpolation. */
const INTERP_DELAY = 120;
/** Fall back to prediction only if a direct input happened recently. */
const PREDICT_WINDOW = 250;

function sampleTransform(entity: GameEntity, renderTime: number) {
  const s = entity.samples;
  if (s.length === 0) return;
  // Find the pair straddling renderTime.
  let older = s[0];
  let newer = s[s.length - 1];
  for (let i = s.length - 1; i >= 0; i--) {
    if (s[i].time <= renderTime) {
      older = s[i];
      newer = s[Math.min(i + 1, s.length - 1)];
      break;
    }
  }
  const span = newer.time - older.time;
  const t = span > 1 ? THREE.MathUtils.clamp((renderTime - older.time) / span, 0, 1) : 1;
  entity.x = THREE.MathUtils.lerp(older.x, newer.x, t);
  entity.z = THREE.MathUtils.lerp(older.z, newer.z, t);
  // Shortest-arc yaw lerp.
  let dy = newer.yaw - older.yaw;
  while (dy > Math.PI) dy -= Math.PI * 2;
  while (dy < -Math.PI) dy += Math.PI * 2;
  entity.yaw = older.yaw + dy * t;
  entity.anim = newer.anim;
}

function CharacterModel({ entity }: { entity: GameEntity }) {
  const model = useAssetModel(CHARACTER_MODEL);
  const mixer = useRef<THREE.AnimationMixer | null>(null);
  const actions = useRef<Record<string, THREE.AnimationAction>>({});
  const current = useRef<string>("");

  useEffect(() => {
    if (!model || model.animations.length === 0) return;
    const m = new THREE.AnimationMixer(model.scene);
    mixer.current = m;
    actions.current = {};
    for (const clip of model.animations) {
      actions.current[clip.name.toLowerCase()] = m.clipAction(clip);
    }
    current.current = "";
    return () => {
      m.stopAllAction();
    };
  }, [model]);

  useFrame((_, dt) => {
    if (!mixer.current) return;
    mixer.current.update(dt);
    const want =
      entity.anim === "Run" ? "run" : entity.anim === "Walk" ? "walk" : "idle";
    if (current.current.indexOf(want) === -1) {
      const names = Object.keys(actions.current);
      const match =
        names.find((n) => n.includes(want)) ??
        names.find((n) => n.includes("idle")) ??
        names[0];
      if (match && match !== current.current) {
        const prev = actions.current[current.current];
        const next = actions.current[match];
        prev?.fadeOut(0.15);
        next?.reset().fadeIn(0.15).play();
        current.current = match;
      }
    }
  });

  if (!model) return <ProceduralCharacter entity={entity} />;
  return <primitive object={model.scene} />;
}

/** Stylized runner: capsule body, emissive visor, walk bob. */
function ProceduralCharacter({ entity }: { entity: GameEntity }) {
  const group = useRef<THREE.Group>(null);
  const tint = new THREE.Color(entity.tint);
  const isNpc = entity.kind === "Npc";
  const bodyColor = isNpc ? "#4a3038" : "#2b3550";
  const visor = isNpc ? "#ff4444" : "#40e8ff";

  useFrame(({ clock }) => {
    if (!group.current) return;
    const moving = entity.anim === "Walk" || entity.anim === "Run";
    const speed = entity.anim === "Run" ? 11 : 6;
    const bob = moving ? Math.abs(Math.sin(clock.elapsedTime * speed)) * 0.07 : 0;
    group.current.position.y = bob;
    const lean = moving ? 0.12 : 0;
    group.current.rotation.x = lean;
  });

  return (
    <group ref={group}>
      <mesh position={[0, 0.85, 0]} castShadow>
        <capsuleGeometry args={[0.32, 0.85, 6, 12]} />
        <meshStandardMaterial color={bodyColor} roughness={0.55} metalness={0.2} />
      </mesh>
      {/* shoulder tint band */}
      <mesh position={[0, 1.25, 0]}>
        <cylinderGeometry args={[0.34, 0.34, 0.12, 12]} />
        <meshStandardMaterial color={tint} roughness={0.4} metalness={0.4} />
      </mesh>
      <mesh position={[0, 1.66, 0]} castShadow>
        <sphereGeometry args={[0.21, 12, 12]} />
        <meshStandardMaterial color="#14161c" roughness={0.3} metalness={0.6} />
      </mesh>
      {/* visor faces +X (yaw 0 looks along +X) */}
      <mesh position={[0.14, 1.68, 0]} rotation={[0, 0, -Math.PI / 2]}>
        <capsuleGeometry args={[0.045, 0.16, 4, 8]} />
        <meshStandardMaterial color={visor} emissive={visor} emissiveIntensity={2.5} />
      </mesh>
    </group>
  );
}

function LootCrate({ entity }: { entity: GameEntity }) {
  const glow = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    if (glow.current) {
      const pulse = 1.5 + Math.sin(clock.elapsedTime * 4) * 0.8;
      (glow.current.material as THREE.MeshStandardMaterial).emissiveIntensity = pulse;
    }
  });
  return (
    <group
      onClick={(e) => {
        e.stopPropagation();
        game.send?.({ t: "Interact", d: { entity_id: entity.id } });
      }}
      onPointerOver={() => (document.body.style.cursor = "pointer")}
      onPointerOut={() => (document.body.style.cursor = "default")}
    >
      <mesh position={[0, 0.28, 0]} castShadow>
        <boxGeometry args={[0.6, 0.55, 0.6]} />
        <meshStandardMaterial color="#3a2f1d" roughness={0.6} metalness={0.3} />
      </mesh>
      <mesh ref={glow} position={[0, 0.58, 0]}>
        <boxGeometry args={[0.5, 0.06, 0.5]} />
        <meshStandardMaterial color="#ffe14d" emissive="#ffc93d" emissiveIntensity={2} />
      </mesh>
    </group>
  );
}

function ExtractionBeacon({ entity }: { entity: GameEntity }) {
  const beam = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    if (beam.current) {
      (beam.current.material as THREE.MeshBasicMaterial).opacity =
        0.25 + Math.sin(clock.elapsedTime * 2.5) * 0.1;
      beam.current.rotation.y = clock.elapsedTime * 0.4;
    }
  });
  return (
    <group
      onClick={(e) => {
        e.stopPropagation();
        game.send?.({ t: "Interact", d: { entity_id: entity.id } });
      }}
      onPointerOver={() => (document.body.style.cursor = "pointer")}
      onPointerOut={() => (document.body.style.cursor = "default")}
    >
      <mesh position={[0, 0.15, 0]}>
        <cylinderGeometry args={[1.1, 1.3, 0.3, 24]} />
        <meshStandardMaterial color="#0f2a24" emissive="#1affc4" emissiveIntensity={0.7} />
      </mesh>
      <mesh ref={beam} position={[0, 8, 0]}>
        <cylinderGeometry args={[0.55, 0.9, 16, 12, 1, true]} />
        <meshBasicMaterial
          color="#1affc4"
          transparent
          opacity={0.3}
          side={THREE.DoubleSide}
          depthWrite={false}
        />
      </mesh>
    </group>
  );
}

function StashTerminal({ entity }: { entity: GameEntity }) {
  return (
    <group
      onClick={(e) => {
        e.stopPropagation();
        game.send?.({ t: "Interact", d: { entity_id: entity.id } });
        useGame.getState().set({ inventoryOpen: true });
      }}
      onPointerOver={() => (document.body.style.cursor = "pointer")}
      onPointerOut={() => (document.body.style.cursor = "default")}
    >
      <mesh position={[0, 0.9, 0]} castShadow>
        <boxGeometry args={[1.1, 1.8, 0.7]} />
        <meshStandardMaterial color="#141a24" roughness={0.4} metalness={0.6} />
      </mesh>
      <mesh position={[0, 1.25, 0.36]}>
        <planeGeometry args={[0.8, 0.5]} />
        <meshStandardMaterial color="#40e8ff" emissive="#40e8ff" emissiveIntensity={1.6} />
      </mesh>
    </group>
  );
}

function EntityView({ entity }: { entity: GameEntity }) {
  const group = useRef<THREE.Group>(null);
  const isCharacter = entity.kind === "Player" || entity.kind === "Npc";

  useFrame(() => {
    if (!group.current) return;
    const isLocal = entity.id === game.localEntityId;
    const now = performance.now();

    if (!isCharacter) {
      group.current.position.set(entity.x, entity.y, entity.z);
      return;
    }

    if (isLocal && now - game.lastDirectInputAt < PREDICT_WINDOW) {
      // Prediction drives the local player during WASD movement.
      entity.x = game.predicted.x;
      entity.z = game.predicted.z;
      entity.yaw = game.predicted.yaw;
    } else {
      sampleTransform(entity, now - INTERP_DELAY);
      if (isLocal) {
        // Keep prediction in sync while server-driven (click-to-move).
        game.predicted.x = entity.x;
        game.predicted.z = entity.z;
        game.predicted.yaw = entity.yaw;
      }
    }

    group.current.position.set(entity.x, entity.y, entity.z);
    // Model faces +Z at yaw 0 in three.js convention; our yaw is atan2(dz,dx).
    group.current.rotation.y = -entity.yaw + Math.PI / 2;

    if (isLocal) {
      const moving = entity.anim === "Walk" || entity.anim === "Run";
      void setFootsteps(moving, entity.anim === "Run");
    }
  });

  let body: React.ReactNode;
  switch (entity.kind) {
    case "LootContainer":
      body = <LootCrate entity={entity} />;
      break;
    case "ExtractionPoint":
      body = <ExtractionBeacon entity={entity} />;
      break;
    case "Building":
      body = <StashTerminal entity={entity} />;
      break;
    case "Npc":
      body = (
        <group
          onClick={(e) => {
            e.stopPropagation();
            const seq = game.nextSeq++;
            game.send?.({ t: "Attack", d: { seq, tx: entity.x, tz: entity.z } });
          }}
          onPointerOver={() => (document.body.style.cursor = "crosshair")}
          onPointerOut={() => (document.body.style.cursor = "default")}
        >
          <ProceduralCharacter entity={entity} />
          <HealthRing entity={entity} />
        </group>
      );
      break;
    default:
      body = <CharacterModel entity={entity} />;
  }

  return <group ref={group}>{body}</group>;
}

function HealthRing({ entity }: { entity: GameEntity }) {
  const ref = useRef<THREE.Mesh>(null);
  useFrame(() => {
    if (!ref.current) return;
    ref.current.visible = entity.healthPct < 0.999 && entity.anim !== "Death";
    ref.current.scale.setScalar(Math.max(entity.healthPct, 0.05));
  });
  return (
    <mesh ref={ref} position={[0, 0.03, 0]} rotation={[-Math.PI / 2, 0, 0]}>
      <ringGeometry args={[0.5, 0.62, 24]} />
      <meshBasicMaterial color="#ff4455" transparent opacity={0.8} depthWrite={false} />
    </mesh>
  );
}

export function Entities() {
  // Re-render entity list when spawns/despawns happen (poll via joined flag +
  // an entity count check each frame would be overkill; snapshot cadence is
  // enough to keep this cheap).
  const [, force] = useState(0);
  const joined = useGame((s) => s.joined);

  useEffect(() => {
    if (!joined) return;
    const timer = setInterval(() => force((n) => n + 1), 500);
    return () => clearInterval(timer);
  }, [joined]);

  return (
    <>
      {[...game.entities.values()].map((entity) => (
        <EntityView key={entity.id} entity={entity} />
      ))}
    </>
  );
}
