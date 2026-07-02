// Entity rendering: interpolates remote entities between server snapshots,
// uses the predicted transform for the local player, and animates a rigged
// GLB character when available (procedural runner otherwise).

import { useFrame } from "@react-three/fiber";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { setFootsteps } from "../assets/audio";
import { CHARACTER_MODEL, PISTOL_MODEL, useAssetModel } from "../assets/catalog";
import {
  CROUCH_SPEED,
  ROLL_DURATION,
  RUN_SPEED,
  WALK_SPEED,
} from "../game/collision";
import { NODE_RESOURCES, RESOURCE_COLORS } from "../game/recipes";
import { AnimState } from "../net/protocol";
import { game, GameEntity, useGame } from "../state/game";
import { groundHeightAt } from "./Ground";

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

// ---------------------------------------------------------------------------
// Cyberpunk mannequin (Quaternius Universal Animation Library rig)
// ---------------------------------------------------------------------------

const CROSSFADE = 0.15;

/** Clips that play once and then hand control back to locomotion. */
const ONE_SHOTS = new Set([
  "Pistol_Shoot",
  "Punch_Cross",
  "Roll",
  "Hit_Chest",
  "Interact",
  "Death01",
]);

/**
 * World speed (m/s) each locomotion clip was authored around; playback rate
 * is scaled by actual movement speed so feet don't slide.
 */
const CLIP_REF_SPEED: Record<string, number> = {
  Walk_Loop: 1.6,
  Jog_Fwd_Loop: 3.5,
  Sprint_Loop: 5.5,
  Crouch_Fwd_Loop: 1.2,
};

interface ClipChoice {
  name: string;
  timeScale: number;
}

/** Map a replicated anim state to a clip for this entity. */
function chooseClip(
  anim: AnimState,
  isNpc: boolean,
  gunIdle: boolean,
): ClipChoice {
  switch (anim) {
    case "Death":
      return { name: "Death01", timeScale: 1 };
    case "Roll":
      // Sync the roll animation to the dash duration exactly.
      return { name: "Roll", timeScale: 1 };
    case "Attack":
      return isNpc
        ? { name: "Punch_Cross", timeScale: 1.15 }
        : { name: "Pistol_Shoot", timeScale: 1.4 };
    case "Gather":
      return { name: "Interact", timeScale: 1 };
    case "Crouch":
      return { name: "Crouch_Idle_Loop", timeScale: 1 };
    case "CrouchWalk":
      return {
        name: "Crouch_Fwd_Loop",
        timeScale: CROUCH_SPEED / CLIP_REF_SPEED.Crouch_Fwd_Loop,
      };
    case "Run":
      return {
        name: "Sprint_Loop",
        timeScale: RUN_SPEED / CLIP_REF_SPEED.Sprint_Loop,
      };
    case "Walk":
      // NPCs patrol slowly; players "walk" at a brisk 3 m/s (jog cadence).
      return isNpc
        ? { name: "Walk_Loop", timeScale: 1 }
        : { name: "Jog_Fwd_Loop", timeScale: WALK_SPEED / CLIP_REF_SPEED.Jog_Fwd_Loop };
    default:
      return gunIdle
        ? { name: "Pistol_Idle_Loop", timeScale: 1 }
        : { name: "Idle_Loop", timeScale: 1 };
  }
}

/** Apply the cyberpunk restyle: gunmetal body, emissive neon joints. */
function restyleMannequin(scene: THREE.Group, tint: number, hostile: boolean) {
  const joints = new THREE.Color(hostile ? 0xff3040 : tint || 0x40e8ff);
  const restyle = (mat: THREE.Material): THREE.Material => {
    const m = (mat as THREE.MeshStandardMaterial).clone();
    if (m.name === "M_Joints") {
      m.color.set(0x101318);
      m.emissive.copy(joints);
      m.emissiveIntensity = 1.6;
      m.roughness = 0.35;
      m.metalness = 0.5;
    } else {
      // M_Main: dark gunmetal shell.
      m.color.set(hostile ? 0x2c2126 : 0x232936);
      m.roughness = 0.5;
      m.metalness = 0.65;
    }
    return m;
  };
  scene.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    // Skinned meshes animate outside their static bounds; skip culling.
    mesh.frustumCulled = false;
    mesh.material = Array.isArray(mesh.material)
      ? mesh.material.map(restyle)
      : restyle(mesh.material);
  });
}

/** Sidearm mesh parented to the right hand bone. */
function attachPistol(rig: THREE.Group, pistol: THREE.Group): THREE.Group | null {
  const hand = rig.getObjectByName("DEF-handR") ?? rig.getObjectByName("DEF-hand.R");
  if (!hand) return null;
  const holder = new THREE.Group();
  holder.add(pistol);
  // Tuned for the UAL hand bone (Y along the fingers): grip in the palm,
  // barrel out past the knuckles.
  pistol.scale.setScalar(0.35);
  pistol.position.set(0, 0.06, 0.02);
  pistol.rotation.set(-Math.PI / 2, 0, Math.PI / 2);
  hand.add(holder);
  return holder;
}

function CharacterModel({ entity }: { entity: GameEntity }) {
  const isNpc = entity.kind === "Npc";
  const model = useAssetModel(CHARACTER_MODEL);
  const pistolModel = useAssetModel(isNpc ? undefined : PISTOL_MODEL);
  const mixer = useRef<THREE.AnimationMixer | null>(null);
  const actions = useRef<Record<string, THREE.AnimationAction>>({});
  const current = useRef<string>("");
  /** Name of the one-shot currently holding the pose (cleared on finish). */
  const oneShot = useRef<string>("");

  useEffect(() => {
    if (!model || model.animations.length === 0) return;
    restyleMannequin(model.scene, entity.tint, isNpc);
    const m = new THREE.AnimationMixer(model.scene);
    mixer.current = m;
    actions.current = {};
    for (const clip of model.animations) {
      const action = m.clipAction(clip);
      if (ONE_SHOTS.has(clip.name)) {
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true;
      }
      actions.current[clip.name] = action;
    }
    const onFinished = (e: { action: THREE.AnimationAction }) => {
      if (e.action.getClip().name === oneShot.current) oneShot.current = "";
    };
    m.addEventListener("finished", onFinished);
    current.current = "";
    oneShot.current = "";
    return () => {
      m.removeEventListener("finished", onFinished);
      m.stopAllAction();
    };
  }, [model, entity.tint, isNpc]);

  useEffect(() => {
    if (!model || !pistolModel) return;
    const holder = attachPistol(model.scene, pistolModel.scene);
    return () => {
      holder?.removeFromParent();
    };
  }, [model, pistolModel]);

  useFrame((_, dt) => {
    if (!mixer.current) return;
    mixer.current.update(dt);

    const isLocal = entity.id === game.localEntityId;
    let anim = entity.anim;
    if (isLocal) {
      // Instant local feedback; the server confirms a tick later.
      if (game.roll) anim = "Roll";
      else if (game.crouching && anim === "Idle") anim = "Crouch";
      else if (game.crouching && (anim === "Walk" || anim === "Run")) {
        anim = "CrouchWalk";
      }
    }
    const gunIdle = isLocal ? game.gun.drawn : false;
    const want = chooseClip(anim, isNpc, gunIdle);
    const action = actions.current[want.name];
    if (!action) return;

    // Death latches at the last frame.
    if (current.current === "Death01" && want.name === "Death01") return;

    // A running one-shot holds the pose until it finishes; only death or a
    // roll preempts it.
    if (oneShot.current && want.name !== "Death01" && want.name !== "Roll") {
      return;
    }

    if (current.current !== want.name) {
      const prev = actions.current[current.current];
      prev?.fadeOut(CROSSFADE);
      action.reset().fadeIn(CROSSFADE).play();
      current.current = want.name;
      oneShot.current = ONE_SHOTS.has(want.name) ? want.name : "";
    } else if (ONE_SHOTS.has(want.name) && !oneShot.current) {
      // Same one-shot requested again after finishing (e.g. rapid fire).
      action.reset().play();
      oneShot.current = want.name;
    }

    action.timeScale =
      want.name === "Roll"
        ? // Finish the roll clip exactly when the dash ends.
          action.getClip().duration / ROLL_DURATION
        : want.timeScale;
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

/** Crystal cluster resource node, colored by resource variant. */
function ResourceNodeView({ entity }: { entity: GameEntity }) {
  const color = RESOURCE_COLORS[NODE_RESOURCES[entity.variant % 5]] ?? "#ffffff";
  const glow = useRef<THREE.Group>(null);
  useFrame(({ clock }) => {
    if (!glow.current) return;
    const pulse = 0.9 + Math.sin(clock.elapsedTime * 2 + entity.id) * 0.25;
    glow.current.scale.setScalar(pulse * (0.6 + 0.4 * entity.healthPct));
  });
  const shards: [number, number, number, number][] = [
    [0, 0.4, 0, 0.5],
    [0.35, 0.28, 0.15, 0.34],
    [-0.3, 0.24, -0.2, 0.3],
    [0.1, 0.2, -0.35, 0.26],
    [-0.2, 0.3, 0.3, 0.28],
  ];
  return (
    <group
      onClick={(e) => {
        e.stopPropagation();
        game.send?.({ t: "Interact", d: { entity_id: entity.id } });
      }}
      onPointerOver={() => (document.body.style.cursor = "pointer")}
      onPointerOut={() => (document.body.style.cursor = "default")}
    >
      <group ref={glow}>
        {shards.map(([x, y, z, s], i) => (
          <mesh key={i} position={[x, y, z]} rotation={[x, i * 1.3, z]} castShadow>
            <octahedronGeometry args={[s, 0]} />
            <meshStandardMaterial
              color={color}
              emissive={color}
              emissiveIntensity={1.4}
              roughness={0.25}
              metalness={0.3}
            />
          </mesh>
        ))}
      </group>
      <mesh position={[0, 0.05, 0]}>
        <cylinderGeometry args={[0.7, 0.85, 0.12, 8]} />
        <meshStandardMaterial color="#20242e" roughness={0.9} />
      </mesh>
      <pointLight color={color} intensity={2.2} distance={5} position={[0, 0.8, 0]} />
    </group>
  );
}

/** Industrial crafting station (refinery = amber, factory = magenta, lab = cyan). */
function StationView({ entity }: { entity: GameEntity }) {
  const accent =
    entity.kind === "Refinery" ? "#ffb347" : entity.kind === "Factory" ? "#ff2d78" : "#40e8ff";
  const fan = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    if (fan.current) fan.current.rotation.y = clock.elapsedTime * 2.2;
  });
  return (
    <group
      onClick={(e) => {
        e.stopPropagation();
        useGame.getState().set({ craftOpen: true });
        // Fetch this station's production queue state.
        game.send?.({ t: "Interact", d: { entity_id: entity.id } });
      }}
      onPointerOver={() => (document.body.style.cursor = "pointer")}
      onPointerOut={() => (document.body.style.cursor = "default")}
    >
      {/* main housing */}
      <mesh position={[0, 0.8, 0]} castShadow>
        <boxGeometry args={[1.8, 1.6, 1.3]} />
        <meshStandardMaterial color="#1a1f2a" roughness={0.45} metalness={0.7} />
      </mesh>
      {/* stack */}
      <mesh position={[0.55, 2.0, -0.3]} castShadow>
        <cylinderGeometry args={[0.16, 0.2, 1.2, 10]} />
        <meshStandardMaterial color="#242b38" roughness={0.5} metalness={0.6} />
      </mesh>
      {/* rooftop fan */}
      <mesh ref={fan} position={[-0.4, 1.68, 0.2]}>
        <boxGeometry args={[0.7, 0.06, 0.12]} />
        <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.8} />
      </mesh>
      {/* glowing control panel */}
      <mesh position={[0, 0.95, 0.67]}>
        <planeGeometry args={[1.2, 0.55]} />
        <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={1.8} />
      </mesh>
      {/* accent piping */}
      <mesh position={[-0.92, 0.6, 0]} rotation={[0, 0, Math.PI / 2]}>
        <cylinderGeometry args={[0.07, 0.07, 0.5, 8]} />
        <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={1.2} />
      </mesh>
      <pointLight color={accent} intensity={2.5} distance={6} position={[0, 1.4, 1]} />
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

function MarketTerminal({ entity }: { entity: GameEntity }) {
  const holo = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    if (holo.current) {
      holo.current.rotation.y = clock.elapsedTime * 0.8;
      holo.current.position.y = 2.1 + Math.sin(clock.elapsedTime * 1.5) * 0.08;
    }
  });
  return (
    <group
      onClick={(e) => {
        e.stopPropagation();
        game.send?.({ t: "Interact", d: { entity_id: entity.id } });
        useGame.getState().set({ marketOpen: true });
      }}
      onPointerOver={() => (document.body.style.cursor = "pointer")}
      onPointerOut={() => (document.body.style.cursor = "default")}
    >
      <mesh position={[0, 0.9, 0]} castShadow>
        <boxGeometry args={[1.2, 1.8, 0.8]} />
        <meshStandardMaterial color="#1a1508" roughness={0.4} metalness={0.6} />
      </mesh>
      <mesh position={[0, 1.25, 0.41]}>
        <planeGeometry args={[0.9, 0.55]} />
        <meshStandardMaterial color="#ffd700" emissive="#ffd700" emissiveIntensity={1.4} />
      </mesh>
      {/* Rotating holographic "coin" above the terminal. */}
      <mesh ref={holo} position={[0, 2.1, 0]}>
        <cylinderGeometry args={[0.28, 0.28, 0.05, 16]} />
        <meshStandardMaterial
          color="#ffd700"
          emissive="#ffb700"
          emissiveIntensity={2}
          transparent
          opacity={0.85}
        />
      </mesh>
      <pointLight color="#ffd700" intensity={2} distance={5} position={[0, 1.6, 0.6]} />
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
      group.current.position.set(
        entity.x,
        entity.y + groundHeightAt(entity.x, entity.z),
        entity.z,
      );
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

    // Twin-stick facing: the local player always points at the mouse
    // (except mid-roll, where the body follows the dash direction).
    if (isLocal && game.aim.active && !game.roll) {
      entity.yaw = game.aim.yaw;
    }

    // Stand on the visual ground surface (raised sidewalks vs road grade).
    group.current.position.set(
      entity.x,
      entity.y + groundHeightAt(entity.x, entity.z),
      entity.z,
    );
    // Model faces +Z at yaw 0 in three.js convention; our yaw is atan2(dz,dx).
    group.current.rotation.y = -entity.yaw + Math.PI / 2;

    if (isLocal) {
      // Crouch-walking and rolling stay quiet (sneaking / tumbling).
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
    case "ResourceNode":
      body = <ResourceNodeView entity={entity} />;
      break;
    case "Refinery":
    case "Factory":
    case "Laboratory":
      body = <StationView entity={entity} />;
      break;
    case "MarketTerminal":
      body = <MarketTerminal entity={entity} />;
      break;
    case "Npc":
      body = (
        <group
          onPointerOver={() => (document.body.style.cursor = "crosshair")}
          onPointerOut={() => (document.body.style.cursor = "default")}
        >
          <CharacterModel entity={entity} />
          <HealthBar entity={entity} />
        </group>
      );
      break;
    default:
      body = <CharacterModel entity={entity} />;
  }

  return <group ref={group}>{body}</group>;
}

/** Show the bar this long after taking a hit even at full health, ms. */
const HEALTH_BAR_LINGER = 4000;
const HEALTH_BAR_WIDTH = 1.1;

/**
 * Ascent-style floating health bar: camera-facing dark backing with a red
 * fill, hovering above the enemy's head. Appears once damaged.
 */
function HealthBar({ entity }: { entity: GameEntity }) {
  const group = useRef<THREE.Group>(null);
  const fill = useRef<THREE.Mesh>(null);

  useFrame(({ camera }) => {
    if (!group.current) return;
    const damaged = entity.healthPct < 0.999;
    const recent = performance.now() - entity.lastHitAt < HEALTH_BAR_LINGER;
    const visible = (damaged || recent) && entity.anim !== "Death" && entity.healthPct > 0;
    group.current.visible = visible;
    if (!visible) return;
    group.current.quaternion.copy(camera.quaternion);
    if (fill.current) {
      const pct = Math.max(entity.healthPct, 0.02);
      fill.current.scale.x = pct;
      // Keep the fill anchored to the left edge as it shrinks.
      fill.current.position.x = (-(1 - pct) * HEALTH_BAR_WIDTH) / 2;
    }
  });

  return (
    <group ref={group} position={[0, 2.25, 0]} visible={false}>
      {/* backing */}
      <mesh>
        <planeGeometry args={[HEALTH_BAR_WIDTH + 0.08, 0.16]} />
        <meshBasicMaterial color="#0a0508" transparent opacity={0.85} depthWrite={false} />
      </mesh>
      {/* fill */}
      <mesh ref={fill} position={[0, 0, 0.001]}>
        <planeGeometry args={[HEALTH_BAR_WIDTH, 0.09]} />
        <meshBasicMaterial color="#ff3040" depthWrite={false} />
      </mesh>
    </group>
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
