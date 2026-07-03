// Entity rendering: interpolates remote entities between server snapshots,
// uses the predicted transform for the local player, and animates a rigged
// GLB character when available (procedural runner otherwise).

import { Html, Outlines } from "@react-three/drei";
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
import { perf } from "../perf/perf";
import { game, GameEntity, GunMount, useGame } from "../state/game";
import { groundHeightAt } from "./Ground";
import { isTronStyle } from "./styles";
import { TargetReticle } from "./TargetReticle";

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
 * Bones above the hips (post-GLTF name sanitization, so `DEF-spine.001`
 * appears as `DEF-spine001` in track names). Tracks matching this drive the
 * upper-body animation layer; legs/hips stay with locomotion.
 */
const UPPER_BODY_BONES =
  /spine00[1-3]|neck|head|shoulder|upper_arm|forearm|hand|thumb|index|middle|ring|pinky/i;

/**
 * Mixer weight for the upper-body layer. Actions blend by weighted average,
 * so a high weight lets the shoot/flinch pose dominate locomotion arm swing
 * on shared bones (12 -> ~92%).
 */
const UPPER_WEIGHT = 12;
const UPPER_SUFFIX = "@upper";

/** Copy of a clip keeping only upper-body tracks, for layered playback. */
function upperBodyClip(clip: THREE.AnimationClip): THREE.AnimationClip {
  const tracks = clip.tracks.filter((t) => UPPER_BODY_BONES.test(t.name));
  return new THREE.AnimationClip(clip.name + UPPER_SUFFIX, clip.duration, tracks);
}

/** Clips available on the upper-body layer. */
const UPPER_CLIPS = ["Pistol_Shoot", "Hit_Chest", "Punch_Cross", "Punch_Jab"];

/** Ranged weapons; anything else (melee or nothing) attacks with a punch. */
const RANGED_WEAPONS = new Set(["Pistol", "Smg"]);
/** Punch clips alternated on successive melee/fist attacks for variety. */
const PUNCH_CLIPS = ["Punch_Cross", "Punch_Jab"];
/** Playback rate for the upper-body punch overlay. */
const PUNCH_ANIM_SCALE = 1.2;

/** How long the gun mesh bucks after a shot, ms. */
const GUN_KICK_MS = 110;
/** Seconds the shoot clip takes; keeps the arm pose ahead of the fire rate. */
const SHOOT_ANIM_TIME = 0.25;
// --- Sidearm hold / aim tuning (see attachPistol + the per-frame aim) -------
/** Uniform scale applied to the pistol GLB in the hand. */
const GUN_SCALE = 0.35;
/** Distance from the grip to the muzzle empty, holder-local +X (barrel). */
const GUN_BARREL_LEN = 0.28;
/** Roll about the barrel axis; nudge if the gun reads rotated in-hand. */
const GUN_ROLL = 0;
/** Recoil kick angle (rad) the muzzle rises right after a shot. */
const GUN_RECOIL_KICK = 0.45;
/** Constant downward tilt of the barrel (rad); keeps it a touch below level. */
const GUN_AIM_PITCH = 0.05;
/** Duration of the red damage flash, ms. */
const HIT_FLASH_MS = 200;
const HIT_FLASH_COLOR = new THREE.Color(0xff2822);

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

// ---------------------------------------------------------------------------
// Directional locomotion blender
// ---------------------------------------------------------------------------
//
// The UAL Standard pack ships forward gaits only, so directional movement is
// synthesized: the whole model turns so the legs lead into the actual
// movement direction, the spine counter-twists so the torso keeps facing the
// aim, and backpedaling plays the gait in reverse (legs face away from the
// travel direction). All locomotion actions stay on the mixer with
// exponentially damped weights and a shared normalized gait phase, so
// idle/walk/run/crouch and every direction change blend continuously instead
// of snapping between clips.

const GAIT_CLIPS = [
  "Walk_Loop",
  "Jog_Fwd_Loop",
  "Sprint_Loop",
  "Crouch_Fwd_Loop",
] as const;
const IDLE_CLIPS = ["Idle_Loop", "Pistol_Idle_Loop", "Crouch_Idle_Loop"] as const;
const LOCO_CLIPS: readonly string[] = [...GAIT_CLIPS, ...IDLE_CLIPS];
const GAIT_SET = new Set<string>(GAIT_CLIPS);

/** How fast locomotion blend weights chase their targets (1/s). */
const WEIGHT_DAMP = 10;
/** How fast the legs turn toward the movement direction (1/s). */
const LEG_DAMP = 12;
/** How fast the gait flips between forward and reversed playback (1/s). */
const DIR_DAMP = 8;
/** Speed (m/s) at which the gait fully replaces idle. */
const FULL_GAIT_SPEED = 1.2;
/** Minimum speed that counts as moving for animation purposes. */
const MOVE_EPSILON = 0.15;
/** Legs never turn further than this away from the torso (rad). */
const MAX_LEG_YAW = (75 * Math.PI) / 180;
/** Above this speed the sprint clip takes over from the jog (m/s). */
const SPRINT_MIN = (WALK_SPEED + RUN_SPEED) / 2;
/** Below this speed the slow walk clip is used instead of the jog (m/s). */
const WALK_MAX = 2.2;
/** Spine bones sharing the torso counter-twist (GLTF-sanitized names). */
const SPINE_BONES = ["DEF-spine001", "DEF-spine002", "DEF-spine003"];

interface ClipChoice {
  name: string;
  timeScale: number;
}

/**
 * Full-body override states (death, roll, gather, NPC melee). Everything else
 * renders through the locomotion blender; player shooting rides the
 * upper-body layer.
 */
function chooseOverride(anim: AnimState, isNpc: boolean): ClipChoice | null {
  switch (anim) {
    case "Death":
      return { name: "Death01", timeScale: 1 };
    case "Roll":
      // Sync the roll animation to the dash duration exactly.
      return { name: "Roll", timeScale: 1 };
    case "Attack":
      // Players shoot via the upper-body layer on top of locomotion, so the
      // base layer keeps its idle/moving pose; NPCs swing full-body.
      return isNpc ? { name: "Punch_Cross", timeScale: 1.15 } : null;
    case "Gather":
      return { name: "Interact", timeScale: 1 };
    default:
      return null;
  }
}

function wrapAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

const Y_AXIS = new THREE.Vector3(0, 1, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);
const spineTwistQ = new THREE.Quaternion();
// Scratch objects reused every frame while aiming the gun (no per-frame alloc).
const gunAimDir = new THREE.Vector3();
const gunSide = new THREE.Vector3();
const gunUp = new THREE.Vector3();
const gunBasis = new THREE.Matrix4();
const gunWorldQ = new THREE.Quaternion();
const gunParentQ = new THREE.Quaternion();
const gunRecoilQ = new THREE.Quaternion();

/**
 * Map a replicated anim state to a single base-layer clip: full-body
 * overrides first, then locomotion loops (players shoot via the upper-body
 * layer, so Attack falls through to idle/locomotion here).
 */
function chooseClip(anim: AnimState, isNpc: boolean, gunIdle: boolean): ClipChoice {
  const override = chooseOverride(anim, isNpc);
  if (override) return override;
  switch (anim) {
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
      // A real walk cycle for everyone; players pace it up to their 3 m/s
      // move speed (brisk march) instead of playing the jog clip slowed
      // down, which read as slow motion.
      return isNpc
        ? { name: "Walk_Loop", timeScale: 1 }
        : { name: "Walk_Loop", timeScale: WALK_SPEED / CLIP_REF_SPEED.Walk_Loop };
    default:
      return gunIdle
        ? { name: "Pistol_Idle_Loop", timeScale: 1 }
        : { name: "Idle_Loop", timeScale: 1 };
  }
}

/** Cloned material + its resting emissive, for the red damage flash. */
interface FlashMaterial {
  mat: THREE.MeshStandardMaterial;
  joints: boolean;
  baseEmissive: THREE.Color;
  baseIntensity: number;
}

/**
 * Recolor the mannequin's cloned materials for the active style. Default:
 * gunmetal shell with emissive neon joints. Tron: near-black shell with
 * hot blue trim (white-hot cores under bloom); hostiles keep a warning red
 * in both. Safe to re-run live on style switches — it also refreshes the
 * resting emissive the hit flash lerps back to.
 */
function applyMannequinPalette(
  flashables: FlashMaterial[],
  tint: number,
  hostile: boolean,
  tron: boolean,
): void {
  for (const f of flashables) {
    const m = f.mat;
    if (tron && hostile) {
      // Flat, light red silhouette: kill all shading/detail so the whole
      // body reads as one translucent shape (the border does the rest).
      m.color.set(0x000000);
      m.emissive.set(0xff5566);
      m.emissiveIntensity = 0.8;
      m.roughness = 1;
      m.metalness = 0;
      m.transparent = true;
      m.opacity = 0.55;
      f.baseEmissive.copy(m.emissive);
      f.baseIntensity = m.emissiveIntensity;
      continue;
    }
    // Reset opacity in case we're switching back from the tron silhouette.
    m.transparent = false;
    m.opacity = 1;
    if (f.joints) {
      if (tron) {
        m.color.set(0x04080c);
        m.emissive.set(hostile ? 0xff4028 : 0x4fd0e0);
        m.emissiveIntensity = hostile ? 2.6 : 3.2;
        m.roughness = 0.3;
        m.metalness = 0.6;
      } else {
        m.color.set(0x101318);
        m.emissive.set(hostile ? 0xff3040 : tint || 0x40e8ff);
        m.emissiveIntensity = 1.6;
        m.roughness = 0.35;
        m.metalness = 0.5;
      }
    } else if (tron) {
      // Tron shell: black silhouette with a faint teal self-glow so the
      // body reads against the black city.
      m.color.set(0x040a0e);
      m.emissive.set(0x0d4552);
      m.emissiveIntensity = 0.35;
      m.roughness = 0.4;
      m.metalness = 0.75;
    } else {
      // M_Main: dark gunmetal shell.
      m.color.set(hostile ? 0x2c2126 : 0x232936);
      m.emissive.set(0x000000);
      m.emissiveIntensity = 1;
      m.roughness = 0.5;
      m.metalness = 0.65;
    }
    f.baseEmissive.copy(m.emissive);
    f.baseIntensity = m.emissiveIntensity;
  }
}

/** Clone the mannequin materials and apply the active-style palette. */
function restyleMannequin(
  scene: THREE.Group,
  tint: number,
  hostile: boolean,
): FlashMaterial[] {
  const flashables: FlashMaterial[] = [];
  const restyle = (mat: THREE.Material): THREE.Material => {
    const m = (mat as THREE.MeshStandardMaterial).clone();
    flashables.push({
      mat: m,
      joints: m.name === "M_Joints",
      baseEmissive: new THREE.Color(),
      baseIntensity: 1,
    });
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
  applyMannequinPalette(
    flashables,
    tint,
    hostile,
    isTronStyle(useGame.getState().visualStyle),
  );
  return flashables;
}

/** Warning red for the enemy silhouette border (matches reticle/hpbar). */
const ENEMY_OUTLINE_COLOR = new THREE.Color("#ff3040");
/** World-space border half-width, in metres. */
const ENEMY_OUTLINE_THICKNESS = 0.015;

const ENEMY_OUTLINE_VERT = /* glsl */ `
  #include <common>
  #include <skinning_pars_vertex>
  uniform float thickness;
  void main() {
    #include <beginnormal_vertex>
    #include <skinbase_vertex>
    #include <skinnormal_vertex>
    #include <begin_vertex>
    #include <skinning_vertex>
    vec3 newPosition = transformed + objectNormal * thickness;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(newPosition, 1.0);
  }
`;

const ENEMY_OUTLINE_FRAG = /* glsl */ `
  uniform vec3 color;
  uniform float opacity;
  void main() {
    gl_FragColor = vec4(color, opacity);
  }
`;

function makeEnemyOutlineMaterial(): THREE.ShaderMaterial {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    uniforms: {
      color: { value: ENEMY_OUTLINE_COLOR.clone() },
      opacity: { value: 0.55 },
      thickness: { value: ENEMY_OUTLINE_THICKNESS },
    },
    vertexShader: ENEMY_OUTLINE_VERT,
    fragmentShader: ENEMY_OUTLINE_FRAG,
  });
  mat.toneMapped = false;
  return mat;
}

/**
 * Inverted-hull border: for every skinned mesh in the rig, add a slightly
 * inflated back-face clone sharing the same skeleton so it tracks the pose.
 * The expanded back faces peek out around the silhouette as a thin red rim
 * (bloom softens it into a glow). Returns the created materials (for pulsing)
 * and a cleanup that detaches the clones.
 */
function attachEnemyOutline(scene: THREE.Group): {
  materials: THREE.ShaderMaterial[];
  cleanup: () => void;
} {
  const materials: THREE.ShaderMaterial[] = [];
  const created: THREE.Object3D[] = [];
  const skins: THREE.SkinnedMesh[] = [];
  scene.traverse((obj) => {
    const skinned = obj as THREE.SkinnedMesh;
    if (skinned.isSkinnedMesh && skinned.parent) skins.push(skinned);
  });
  for (const skinned of skins) {
    const mat = makeEnemyOutlineMaterial();
    const outline = new THREE.SkinnedMesh(skinned.geometry, mat);
    outline.bind(skinned.skeleton, skinned.bindMatrix);
    outline.frustumCulled = false;
    outline.renderOrder = -1;
    skinned.parent!.add(outline);
    materials.push(mat);
    created.push(outline);
  }
  return {
    materials,
    cleanup: () => {
      for (const obj of created) obj.removeFromParent();
      for (const mat of materials) mat.dispose();
    },
  };
}

/**
 * Sidearm mesh parented to the right hand bone, with a muzzle empty. The
 * holder is re-oriented every frame (see the useFrame aim block) so its local
 * +X points at the aim target, so here we only line the pistol's barrel up
 * with that +X axis and drop the muzzle empty at the barrel tip. The pistol
 * GLB's barrel is its native +X; keeping it on the holder's +X means the aim
 * rotation drives the gun exactly where the player is pointing.
 */
function attachPistol(rig: THREE.Group, pistol: THREE.Group): GunMount | null {
  const hand = rig.getObjectByName("DEF-handR") ?? rig.getObjectByName("DEF-hand.R");
  if (!hand) return null;
  const holder = new THREE.Group();
  pistol.scale.setScalar(GUN_SCALE);
  pistol.position.set(0, 0, 0);
  pistol.rotation.set(GUN_ROLL, 0, 0);
  holder.add(pistol);
  // Muzzle empty just past the barrel; world position anchors flash/tracer FX.
  const muzzle = new THREE.Object3D();
  muzzle.position.set(GUN_BARREL_LEN, 0, 0);
  holder.add(muzzle);
  hand.add(holder);
  return { holder, muzzle };
}

function CharacterModel({ entity }: { entity: GameEntity }) {
  const isNpc = entity.kind === "Npc";
  const model = useAssetModel(CHARACTER_MODEL);
  const pistolModel = useAssetModel(isNpc ? undefined : PISTOL_MODEL);
  const mixer = useRef<THREE.AnimationMixer | null>(null);
  const actions = useRef<Record<string, THREE.AnimationAction>>({});
  /** Upper-body layer actions (shoot / hit flinch over locomotion). */
  const upperActions = useRef<Record<string, THREE.AnimationAction>>({});
  /** Active full-body override clip name ("" = locomotion blend). */
  const current = useRef<string>("");
  /** Name of the one-shot currently holding the pose (cleared on finish). */
  const oneShot = useRef<string>("");
  /** Damped blend weight per locomotion clip. */
  const locoWeights = useRef<Record<string, number>>({});
  /** Damped master fade of the locomotion group (0 while an override plays). */
  const locoScale = useRef(1);
  /** Damped leg turn relative to the torso facing (rad). */
  const legYaw = useRef(0);
  /** Damped gait playback direction: +1 forward, -1 backpedal. */
  const gaitDir = useRef(1);
  /** Hysteresis flag: currently moving backward relative to facing. */
  const backpedal = useRef(false);
  /** Shared normalized gait phase, keeps directional blends foot-synced. */
  const gaitPhase = useRef(0);
  const spineBones = useRef<THREE.Object3D[]>([]);
  const flashMats = useRef<FlashMaterial[]>([]);
  const flashActive = useRef(false);
  /** Outline shader materials for enemies (pulsed for a subtle glow). */
  const outlineMats = useRef<THREE.ShaderMaterial[]>([]);
  /** Last seen shot counter / timestamps, so triggers fire exactly once. */
  const seenShot = useRef(0);
  const seenHit = useRef(0);
  /** ms timestamp of the last shot, for the gun mesh recoil kick. */
  const gunKickAt = useRef(0);
  /** Alternates Punch_Cross/Punch_Jab on successive melee attacks. */
  const punchIndex = useRef(0);

  useEffect(() => {
    if (!model || model.animations.length === 0) return;
    flashMats.current = restyleMannequin(model.scene, entity.tint, isNpc);
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
    // Locomotion clips all stay active on the mixer; per-frame damped weights
    // do the blending. Gait clips advance via the shared phase, not the clock.
    locoWeights.current = {};
    for (const name of LOCO_CLIPS) {
      const action = actions.current[name];
      if (!action) continue;
      action.play();
      action.setEffectiveWeight(0);
      if (GAIT_SET.has(name)) action.timeScale = 0;
      locoWeights.current[name] = 0;
    }
    spineBones.current = SPINE_BONES.flatMap((name) => {
      const bone = model.scene.getObjectByName(name);
      return bone ? [bone] : [];
    });
    locoScale.current = 1;
    legYaw.current = 0;
    gaitDir.current = 1;
    backpedal.current = false;
    gaitPhase.current = 0;
    upperActions.current = {};
    for (const name of UPPER_CLIPS) {
      const clip = model.animations.find((c) => c.name === name);
      if (!clip) continue;
      const action = m.clipAction(upperBodyClip(clip));
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
      upperActions.current[name] = action;
    }
    const onFinished = (e: { action: THREE.AnimationAction }) => {
      const name = e.action.getClip().name;
      if (name === oneShot.current) oneShot.current = "";
      // Blend the upper-body layer back out instead of popping.
      if (name.endsWith(UPPER_SUFFIX)) e.action.fadeOut(0.15);
    };
    m.addEventListener("finished", onFinished);
    current.current = "";
    oneShot.current = "";
    // Baseline the triggers so a fresh mount doesn't replay old events.
    seenShot.current =
      entity.id === game.localEntityId ? game.gun.shotSeq : entity.lastShotAt;
    seenHit.current = entity.hitReactAt;
    return () => {
      m.removeEventListener("finished", onFinished);
      m.stopAllAction();
    };
  }, [model, entity.tint, entity.id, isNpc]);

  // Live restyle on visual style switches (the mixer effect above must not
  // re-run for a palette change — it would reset the animation state).
  const tronStyle = useGame((s) => isTronStyle(s.visualStyle));
  useEffect(() => {
    applyMannequinPalette(flashMats.current, entity.tint, isNpc, tronStyle);
  }, [tronStyle, entity.tint, isNpc, model]);

  useEffect(() => {
    if (!model || !pistolModel) return;
    const mount = attachPistol(model.scene, pistolModel.scene);
    if (mount) game.gunMounts.set(entity.id, mount);
    return () => {
      if (mount) {
        if (game.gunMounts.get(entity.id) === mount) game.gunMounts.delete(entity.id);
        mount.holder.removeFromParent();
      }
    };
  }, [model, pistolModel, entity.id]);

  // Glowing red silhouette border, enemies only.
  useEffect(() => {
    if (!model || !isNpc) return;
    const { materials, cleanup } = attachEnemyOutline(model.scene);
    outlineMats.current = materials;
    return () => {
      outlineMats.current = [];
      cleanup();
    };
  }, [model, isNpc]);

  /** Fire a clip on the upper-body layer without touching locomotion. */
  function playUpper(name: string, timeScale: number) {
    const action = upperActions.current[name];
    if (!action) return;
    action.reset();
    action.setEffectiveWeight(UPPER_WEIGHT);
    action.setEffectiveTimeScale(timeScale);
    action.play();
  }

  useFrame((_, dt) => {
    if (!mixer.current || !model) return;
    perf.begin("entities.anim");
    mixer.current.update(dt);

    const isLocal = entity.id === game.localEntityId;
    const now = performance.now();
    const dying = entity.anim === "Death" || entity.healthPct <= 0;

    // Upper-body shoot layer: local shots via the fire counter, remote shots
    // via their MuzzleFlash event timestamp. Works in every locomotion state.
    const shotMark = isLocal ? game.gun.shotSeq : entity.lastShotAt;
    if (shotMark > seenShot.current) {
      seenShot.current = shotMark;
      if (!isNpc && !dying) {
        // Ranged weapons play the pistol recoil; melee and bare fists throw a
        // punch. Remote players only trigger here via the ranged-only
        // MuzzleFlash event, so their attacks are always the shoot pose.
        const weapon = isLocal
          ? useGame.getState().inventory?.equipped_weapon
          : "Pistol";
        if (weapon != null && RANGED_WEAPONS.has(weapon)) {
          // Scale the clip so the full recoil pose completes within the fire
          // interval even at high rates of fire.
          const clipDur =
            upperActions.current["Pistol_Shoot"]?.getClip().duration ?? 0.4;
          playUpper("Pistol_Shoot", clipDur / SHOOT_ANIM_TIME);
          gunKickAt.current = now;
        } else {
          const punch = PUNCH_CLIPS[punchIndex.current % PUNCH_CLIPS.length];
          punchIndex.current++;
          playUpper(punch, PUNCH_ANIM_SCALE);
        }
      }
    }
    // Hit flinch layer + red damage flash.
    if (entity.hitReactAt > seenHit.current) {
      seenHit.current = entity.hitReactAt;
      if (!dying) playUpper("Hit_Chest", 1.3);
    }
    const flash =
      Math.max(0, 1 - (now - entity.hitReactAt) / HIT_FLASH_MS) * 0.55;
    if (flash > 0 || flashActive.current) {
      for (const f of flashMats.current) {
        f.mat.emissive.copy(f.baseEmissive).lerp(HIT_FLASH_COLOR, flash);
        f.mat.emissiveIntensity = f.baseIntensity + flash * 1.6;
      }
      flashActive.current = flash > 0;
    }
    if (outlineMats.current.length > 0) {
      // Gentle breathing glow; fade the border out as the enemy dies.
      const pulse = 0.5 + Math.sin(now * 0.005) * 0.12;
      const alpha = dying ? 0 : pulse;
      for (const mat of outlineMats.current) mat.uniforms.opacity.value = alpha;
    }
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

    // ---- Full-body override layer (death / roll / gather / NPC melee) ----
    const want = chooseOverride(anim, isNpc);
    // Death latches at the last frame.
    const deathLatched = current.current === "Death01" && want?.name === "Death01";
    // A running one-shot holds the pose until it finishes; only death or a
    // roll preempts it.
    const oneShotHolds =
      oneShot.current && want?.name !== "Death01" && want?.name !== "Roll";

    if (!deathLatched && !oneShotHolds) {
      if (want && current.current !== want.name) {
        const action = actions.current[want.name];
        if (action) {
          actions.current[current.current]?.fadeOut(CROSSFADE);
          action.reset().fadeIn(CROSSFADE).play();
          action.timeScale =
            want.name === "Roll"
              ? // Finish the roll clip exactly when the dash ends.
                action.getClip().duration / ROLL_DURATION
              : want.timeScale;
          current.current = want.name;
          oneShot.current = ONE_SHOTS.has(want.name) ? want.name : "";
        }
      } else if (want && ONE_SHOTS.has(want.name) && !oneShot.current && want.name !== "Roll") {
        // Same one-shot requested again after finishing (e.g. an NPC chaining
        // attacks). Rolls are excluded: the anim state can outlive the clip by
        // a few frames, which used to retrigger a visible second tumble.
        actions.current[want.name]?.reset().play();
        oneShot.current = want.name;
      } else if (!want && current.current) {
        // Override released: fade back into the locomotion blend.
        actions.current[current.current]?.fadeOut(CROSSFADE);
        current.current = "";
      }
    }
    const overrideActive = !!current.current || !!oneShot.current;

    // ---- Locomotion blend layer -----------------------------------------
    const kWeight = 1 - Math.exp(-WEIGHT_DAMP * dt);
    locoScale.current += ((overrideActive ? 0 : 1) - locoScale.current) * kWeight;

    const speed = Math.hypot(entity.vx, entity.vz);
    const crouched =
      anim === "Crouch" || anim === "CrouchWalk" || (isLocal && game.crouching);
    const moveFactor = THREE.MathUtils.clamp(speed / FULL_GAIT_SPEED, 0, 1);
    const gaitName = crouched
      ? "Crouch_Fwd_Loop"
      : speed >= SPRINT_MIN
        ? "Sprint_Loop"
        : speed <= WALK_MAX
          ? "Walk_Loop"
          : "Jog_Fwd_Loop";
    const idleName = crouched
      ? "Crouch_Idle_Loop"
      : gunIdle
        ? "Pistol_Idle_Loop"
        : "Idle_Loop";

    for (const name of LOCO_CLIPS) {
      const action = actions.current[name];
      if (!action) continue;
      const target =
        (name === gaitName ? moveFactor : 0) + (name === idleName ? 1 - moveFactor : 0);
      const w = locoWeights.current[name] ?? 0;
      const next = w + (target * locoScale.current - w) * kWeight;
      locoWeights.current[name] = next;
      action.setEffectiveWeight(next);
    }

    // Leg direction + gait reversal: legs lead into the travel direction
    // (front hemisphere); moving backward keeps the legs forward-ish and
    // plays the gait in reverse. Hysteresis avoids flapping at +/-90 degrees.
    let targetLeg = 0;
    if (speed > MOVE_EPSILON && !overrideActive) {
      const rel = wrapAngle(Math.atan2(entity.vz, entity.vx) - entity.yaw);
      const away = Math.abs(rel);
      if (backpedal.current) {
        if (away < Math.PI / 2 - 0.18) backpedal.current = false;
      } else if (away > Math.PI / 2 + 0.18) {
        backpedal.current = true;
      }
      targetLeg = THREE.MathUtils.clamp(
        backpedal.current ? wrapAngle(rel - Math.PI) : rel,
        -MAX_LEG_YAW,
        MAX_LEG_YAW,
      );
    }
    legYaw.current += (targetLeg - legYaw.current) * (1 - Math.exp(-LEG_DAMP * dt));
    gaitDir.current +=
      ((backpedal.current ? -1 : 1) - gaitDir.current) * (1 - Math.exp(-DIR_DAMP * dt));

    // Advance the shared gait phase at the dominant clip's cadence so feet
    // don't slide, and pin every gait clip to it (normalized time sync).
    const gaitAction = actions.current[gaitName];
    if (gaitAction) {
      const dur = gaitAction.getClip().duration;
      const ref = CLIP_REF_SPEED[gaitName] ?? WALK_SPEED;
      gaitPhase.current += (gaitDir.current * speed * dt) / (ref * dur);
      gaitPhase.current -= Math.floor(gaitPhase.current);
      for (const name of GAIT_CLIPS) {
        const action = actions.current[name];
        if (action) action.time = gaitPhase.current * action.getClip().duration;
      }
    }

    // Whole model turns with the legs; the spine counter-twists back to the
    // aim so the torso (and gun) keep pointing at the cursor.
    const turn = legYaw.current * locoScale.current;
    model.scene.rotation.y = -turn;
    if (turn !== 0 && spineBones.current.length > 0) {
      spineTwistQ.setFromAxisAngle(Y_AXIS, turn / spineBones.current.length);
      for (const bone of spineBones.current) bone.quaternion.multiply(spineTwistQ);
    }

    // Procedurally aim the gun: point the holder's +X (the barrel) at the
    // aim direction in world space, independent of the arm animation, so the
    // muzzle always lines up with where shots actually go. Runs after the
    // spine twist above so the hand bone reflects this frame's pose.
    const mount = game.gunMounts.get(entity.id);
    if (mount?.holder.parent) {
      // Hide the pistol mesh when the local player has no gun equipped, so
      // the visuals can't suggest shooting is possible bare-handed.
      if (isLocal) {
        const weapon = useGame.getState().inventory?.equipped_weapon;
        mount.holder.visible = weapon === "Pistol" || weapon === "Smg";
      }
      const yaw = isLocal && game.aim.active ? game.aim.yaw : entity.yaw;
      const cp = Math.cos(GUN_AIM_PITCH);
      gunAimDir.set(Math.cos(yaw) * cp, -Math.sin(GUN_AIM_PITCH), Math.sin(yaw) * cp);
      gunSide.copy(gunAimDir).cross(Y_AXIS);
      if (gunSide.lengthSq() < 1e-6) gunSide.copy(Z_AXIS);
      else gunSide.normalize();
      gunUp.copy(gunSide).cross(gunAimDir).normalize();
      // Columns map holder-local X->barrel, Y->up, Z->side.
      gunBasis.makeBasis(gunAimDir, gunUp, gunSide);
      gunWorldQ.setFromRotationMatrix(gunBasis);
      // Convert the desired world orientation into the hand bone's local frame.
      mount.holder.parent.getWorldQuaternion(gunParentQ);
      mount.holder.quaternion.copy(gunParentQ.invert()).multiply(gunWorldQ);
      // Recoil: the muzzle rises briefly after each shot (about the side axis).
      const kick = (now - gunKickAt.current) / GUN_KICK_MS;
      if (kick < 1) {
        gunRecoilQ.setFromAxisAngle(Z_AXIS, GUN_RECOIL_KICK * (1 - kick));
        mount.holder.quaternion.multiply(gunRecoilQ);
      }
    }
    perf.end("entities.anim");
  });

  if (!model) return <ProceduralCharacter entity={entity} />;
  return <primitive object={model.scene} />;
}

/** Stylized runner: capsule body, emissive visor, walk bob. */
function ProceduralCharacter({ entity }: { entity: GameEntity }) {
  const group = useRef<THREE.Group>(null);
  const tron = useGame((s) => isTronStyle(s.visualStyle));
  const tint = tron ? new THREE.Color("#4fd0e0") : new THREE.Color(entity.tint);
  const isNpc = entity.kind === "Npc";
  const bodyColor = tron ? "#040a0e" : isNpc ? "#4a3038" : "#2b3550";
  const visor = tron
    ? isNpc
      ? "#ff4028"
      : "#4fd0e0"
    : isNpc
      ? "#ff4444"
      : "#40e8ff";

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
        {isNpc && (
          <Outlines color="#ff3040" thickness={3.5} transparent opacity={0.85} screenspace />
        )}
      </mesh>
      {/* shoulder tint band */}
      <mesh position={[0, 1.25, 0]}>
        <cylinderGeometry args={[0.34, 0.34, 0.12, 12]} />
        <meshStandardMaterial color={tint} roughness={0.4} metalness={0.4} />
      </mesh>
      <mesh position={[0, 1.66, 0]} castShadow>
        <sphereGeometry args={[0.21, 12, 12]} />
        <meshStandardMaterial color="#14161c" roughness={0.3} metalness={0.6} />
        {isNpc && (
          <Outlines color="#ff3040" thickness={3.5} transparent opacity={0.85} screenspace />
        )}
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
  /** Previous render position, for velocity estimation. */
  const prevPos = useRef<{ x: number; z: number } | null>(null);

  useFrame((_, dt) => {
    if (!group.current) return;
    perf.begin("entities.move");
    const isLocal = entity.id === game.localEntityId;
    const now = performance.now();

    if (!isCharacter) {
      group.current.position.set(
        entity.x,
        entity.y + groundHeightAt(entity.x, entity.z),
        entity.z,
      );
      perf.end("entities.move");
      return;
    }

    const predicting =
      isLocal && entity.healthPct > 0 && now - game.lastDirectInputAt < PREDICT_WINDOW;
    if (predicting) {
      // Prediction drives the local player during WASD movement; render the
      // smoothed position so the 20 Hz sim steps don't show on screen.
      entity.x = game.rendered.x;
      entity.z = game.rendered.z;
      entity.yaw = game.rendered.yaw;
      // Snapshot sampling is skipped here, so derive the anim from input
      // instead of waiting for the server (which froze the old state).
      if (game.roll) entity.anim = "Roll";
      else if (game.input.moving) {
        entity.anim = game.crouching ? "CrouchWalk" : game.input.run ? "Run" : "Walk";
      } else {
        entity.anim = game.crouching ? "Crouch" : "Idle";
      }
    } else {
      sampleTransform(entity, now - INTERP_DELAY);
      if (isLocal) {
        // Keep prediction in sync while server-driven (click-to-move).
        game.predicted.x = entity.x;
        game.predicted.z = entity.z;
        game.predicted.yaw = entity.yaw;
        game.rendered.x = entity.x;
        game.rendered.z = entity.z;
        game.rendered.yaw = entity.yaw;
      }
    }

    // Twin-stick facing: the local player always points at the mouse
    // (except mid-roll, where the body follows the dash direction).
    if (isLocal && game.aim.active && !game.roll) {
      entity.yaw = game.aim.yaw;
    }

    // Smoothed world velocity for the directional locomotion blender. The
    // local player uses input intent (instant response); remotes and NPCs
    // differentiate the interpolated transform.
    if (dt > 0) {
      let tx = 0;
      let tz = 0;
      if (predicting && game.input.moving && !game.roll) {
        const speed = game.crouching
          ? CROUCH_SPEED
          : game.input.run
            ? RUN_SPEED
            : WALK_SPEED;
        tx = game.input.dx * speed;
        tz = game.input.dz * speed;
      } else if (prevPos.current) {
        const ddx = (entity.x - prevPos.current.x) / dt;
        const ddz = (entity.z - prevPos.current.z) / dt;
        // Ignore teleport spikes (respawn, chunk snap).
        if (Math.hypot(ddx, ddz) < 20) {
          tx = ddx;
          tz = ddz;
        }
      }
      const k = 1 - Math.exp(-dt * 12);
      entity.vx += (tx - entity.vx) * k;
      entity.vz += (tz - entity.vz) * k;
    }
    prevPos.current = { x: entity.x, z: entity.z };

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
    perf.end("entities.move");
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
          onPointerOver={() => {
            game.hoverTargetId = entity.id;
          }}
          onPointerOut={() => {
            if (game.hoverTargetId === entity.id) game.hoverTargetId = null;
          }}
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

/** Camera distances (m) between which the bar fades from full to faint. */
const HP_FADE_NEAR = 12;
const HP_FADE_FAR = 60;
/** Minimum opacity for distant (but still visible) enemies. */
const HP_MIN_OPACITY = 0.3;

/**
 * React health bar: a dark rectangle with a red fill sized to the enemy's
 * remaining health, rendered via drei Html above their head. Shown for every
 * living enemy that is on screen; bars fade with camera distance so far-away
 * enemies read as fainter than nearby ones.
 */
function HealthBar({ entity }: { entity: GameEntity }) {
  const group = useRef<THREE.Group>(null);
  const container = useRef<HTMLDivElement>(null);
  const fill = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const lastVisible = useRef(false);
  const world = useRef(new THREE.Vector3());

  useFrame(({ camera }) => {
    const g = group.current;
    if (!g) return;
    const alive = entity.anim !== "Death" && entity.healthPct > 0;
    let show = false;
    let opacity = 1;
    if (alive) {
      g.getWorldPosition(world.current);
      const dist = camera.position.distanceTo(world.current);
      // Project to normalized device coords to test on-screen visibility.
      world.current.project(camera);
      const v = world.current;
      show =
        v.z < 1 && v.x > -1.05 && v.x < 1.05 && v.y > -1.05 && v.y < 1.05;
      opacity = THREE.MathUtils.clamp(
        1 -
          ((dist - HP_FADE_NEAR) / (HP_FADE_FAR - HP_FADE_NEAR)) *
            (1 - HP_MIN_OPACITY),
        HP_MIN_OPACITY,
        1,
      );
    }
    if (show !== lastVisible.current) {
      lastVisible.current = show;
      setVisible(show);
    }
    if (show) {
      if (container.current) container.current.style.opacity = String(opacity);
      if (fill.current) {
        fill.current.style.width = `${Math.max(entity.healthPct, 0.02) * 100}%`;
      }
    }
  });

  return (
    <group ref={group} position={[0, 2.25, 0]}>
      {visible && (
        <Html center zIndexRange={[4, 0]} style={{ pointerEvents: "none" }}>
          <div ref={container} className="enemy-hpbar">
            <div ref={fill} className="enemy-hpbar-fill" />
          </div>
        </Html>
      )}
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
      <TargetReticle />
    </>
  );
}
