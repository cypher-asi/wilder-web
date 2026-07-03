// Entity rendering: interpolates remote entities between server snapshots,
// uses the predicted transform for the local player, and animates a rigged
// GLB character (posed off-screen, then faded in once ready).

import { Html } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import * as THREE from "three";
import { setFootsteps } from "../assets/audio";
import { CHARACTER_MODEL, PISTOL_MODEL, useAssetModel } from "../assets/catalog";
import {
  chunkKey,
  CROUCH_SPEED,
  ROLL_DURATION,
  RUN_SPEED,
  WALK_SPEED,
} from "../game/collision";
import { POI_STYLES } from "../game/poi";
import { NODE_RESOURCES, RESOURCE_COLORS } from "../game/recipes";
import { AnimState, CHUNK_SIZE, EntityKind, TILE_SIZE } from "../net/protocol";
import { perf } from "../perf/perf";
import {
  activeWeaponKind,
  game,
  GameEntity,
  getEntityRosterVersion,
  GunMount,
  subscribeEntityRoster,
  useGame,
} from "../state/game";
import { RED_NUM } from "../ui/colors";
import { groundHeightAt } from "./Ground";
import { itemSpriteMaterial } from "./itemSprite";
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
const HIT_FLASH_COLOR = new THREE.Color(RED_NUM);

/** Characters materialize over this window once their rig is posed, instead
 * of popping in (or flashing a bind pose / placeholder). */
const FADE_IN_MS = 350;

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
/**
 * At or below this speed the walk clip is used instead of the jog (m/s).
 * Sits just above the player WALK_SPEED (3.0) so walking plays a sped-up
 * walk cycle (~1.9x) rather than a slowed-down jog, which read as slow
 * motion.
 */
const WALK_MAX = 3.2;
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
      m.emissive.set(RED_NUM);
      // Solid, dim flat fill; the brighter rim (drawn after) frames it.
      m.emissiveIntensity = 0.55;
      m.roughness = 1;
      m.metalness = 0;
      m.transparent = false;
      m.opacity = 1;
      m.depthWrite = true;
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
        m.emissive.set(hostile ? RED_NUM : 0x4fd0e0);
        m.emissiveIntensity = hostile ? 2.6 : 3.2;
        m.roughness = 0.3;
        m.metalness = 0.6;
      } else {
        m.color.set(0x101318);
        m.emissive.set(hostile ? RED_NUM : tint || 0x40e8ff);
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
    // Skinned meshes animate outside their static (bind pose) bounds, so the
    // default sphere would pop limbs at the screen edge. But disabling
    // culling entirely kept every off-screen character in the draw list;
    // instead cull against a generous character-sized sphere that covers
    // every animation pose. (Geometry is shared across clones; the sphere is
    // identical for all of them, so overwriting it repeatedly is harmless.)
    if ((mesh as unknown as THREE.SkinnedMesh).isSkinnedMesh) {
      mesh.geometry.boundingSphere = CHARACTER_BOUNDS.clone();
    }
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

/**
 * Cheap stand-in for the per-entity point lights that used to sit on
 * resource nodes, stations, and market terminals: an additive radial ground
 * disc (same trick as the streetlight pools). A real point light multiplies
 * shading cost across every forward-pass fragment in range; this is one
 * blended quad.
 */
const entityGlowTexture = (() => {
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 64;
  const ctx = c.getContext("2d")!;
  const grad = ctx.createRadialGradient(32, 32, 2, 32, 32, 32);
  grad.addColorStop(0, "rgba(255, 255, 255, 0.55)");
  grad.addColorStop(0.5, "rgba(255, 255, 255, 0.16)");
  grad.addColorStop(1, "rgba(255, 255, 255, 0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
})();
const entityGlowGeo = new THREE.CircleGeometry(1, 20).rotateX(-Math.PI / 2);
/** Keep the glow disc out of interact/aim raycasts (it sits in clickable groups). */
const noRaycast = () => null;

function GroundGlow({
  color,
  radius,
  opacity = 0.22,
  y = 0.03,
}: {
  color: string;
  radius: number;
  opacity?: number;
  y?: number;
}) {
  const material = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color,
        map: entityGlowTexture,
        transparent: true,
        opacity,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      }),
    [color, opacity],
  );
  useEffect(() => () => material.dispose(), [material]);
  return (
    <mesh
      geometry={entityGlowGeo}
      material={material}
      scale={[radius, 1, radius]}
      position={[0, y, 0]}
      raycast={noRaycast}
    />
  );
}

/** Generous local-space culling bounds for skinned characters: centered at
 * chest height with enough radius to cover rolls, deaths, and melee lunges. */
const CHARACTER_BOUNDS = new THREE.Sphere(new THREE.Vector3(0, 1, 0), 3);

/**
 * Silhouette border colors. Brightened past their base hue (>1.0 channels,
 * tone mapping disabled) so the rim reads clearly brighter than the body fill
 * and blooms into a glow: warning red for hostiles, friendly blue for players.
 */
const PLAYER_OUTLINE_HEX = "#e6f0ff";
const ENEMY_OUTLINE_COLOR = new THREE.Color(RED_NUM).multiplyScalar(1.7);
const PLAYER_OUTLINE_COLOR = new THREE.Color(PLAYER_OUTLINE_HEX).multiplyScalar(1.7);
/** World-space border half-width, in metres. */
const ENEMY_OUTLINE_THICKNESS = 0.015;

const OUTLINE_VERT = /* glsl */ `
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

const OUTLINE_FRAG = /* glsl */ `
  uniform vec3 color;
  uniform float opacity;
  void main() {
    gl_FragColor = vec4(color, opacity);
  }
`;

function makeOutlineMaterial(color: THREE.Color): THREE.ShaderMaterial {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    uniforms: {
      color: { value: color.clone() },
      opacity: { value: 0.9 },
      thickness: { value: ENEMY_OUTLINE_THICKNESS },
    },
    vertexShader: OUTLINE_VERT,
    fragmentShader: OUTLINE_FRAG,
  });
  mat.toneMapped = false;
  return mat;
}

/**
 * Inverted-hull border: for every skinned mesh in the rig, add a slightly
 * inflated back-face clone sharing the same skeleton so it tracks the pose.
 * The expanded back faces peek out around the silhouette as a thin colored rim
 * (bloom softens it into a glow) — red for enemies, blue for players. Returns
 * the created materials (for pulsing) and a cleanup that detaches the clones.
 */
function attachOutline(
  scene: THREE.Group,
  color: THREE.Color,
): {
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
    const mat = makeOutlineMaterial(color);
    const outline = new THREE.SkinnedMesh(skinned.geometry, mat);
    outline.bind(skinned.skeleton, skinned.bindMatrix);
    // Shares the body geometry, so it culls against CHARACTER_BOUNDS too.
    // Draw AFTER the body so the expanded back faces are depth-culled inside
    // the silhouette (the body writes depth) and only survive as a clean rim
    // around the edge — otherwise the border bleeds through the transparent
    // interior and the two read as one flat shape.
    outline.renderOrder = 2;
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
  /** Accumulated dt across frames skipped by the distance-tiered updater. */
  const animAccum = useRef(0);
  /** Frame counter for the update stride (offset by entity id to spread). */
  const animFrame = useRef(0);
  /** ms timestamp the fade-in reveal started (0 = not started yet). */
  const fadeStartAt = useRef(0);
  /** True once the fade-in finished and material state was restored. */
  const fadeDone = useRef(false);

  // Layout effect (not passive): R3F renders on rAF after commit, so setting
  // up the mixer here guarantees the rig is posed before its first visible
  // frame — no bind-pose (T-pose) flash.
  useLayoutEffect(() => {
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
    // Pose before the first visible frame: idle at full weight + one mixer
    // step so the skeleton starts in a real stance, never the bind pose.
    const idle = actions.current["Idle_Loop"];
    if (idle) {
      idle.setEffectiveWeight(1);
      locoWeights.current["Idle_Loop"] = 1;
    }
    m.update(0);
    // Start the reveal hidden; useFrame ramps opacity to 1 over FADE_IN_MS,
    // then applyMannequinPalette restores the exact authored material state.
    if (!fadeDone.current) {
      fadeStartAt.current = performance.now();
      for (const f of flashMats.current) {
        f.mat.transparent = true;
        f.mat.opacity = 0;
      }
    }
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
    // Don't undo an in-flight reveal (the palette resets opacity to 1); the
    // per-frame fade ramp owns opacity until it hands material state back.
    if (!fadeDone.current) {
      for (const f of flashMats.current) {
        f.mat.transparent = true;
        f.mat.opacity = 0;
      }
    }
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

  // Glowing silhouette border: red for enemies, blue for players.
  useEffect(() => {
    if (!model) return;
    const color = isNpc ? ENEMY_OUTLINE_COLOR : PLAYER_OUTLINE_COLOR;
    const { materials, cleanup } = attachOutline(model.scene, color);
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

  useFrame((state, rawDt) => {
    if (!mixer.current || !model) return;

    // Distance-tiered updates: full rate near the camera, half rate at mid
    // range, third beyond. Distant characters are a few pixels tall, so the
    // mixer + blend work (the bulk of per-entity CPU) runs at 20-30 Hz for
    // them without visible stepping. Skipped frames accumulate dt so clip
    // playback speed is unaffected; entity id staggers which frame each
    // character updates on so the work spreads instead of clumping.
    animAccum.current += rawDt;
    animFrame.current++;
    const camPos = state.camera.position;
    const cdx = entity.x - camPos.x;
    const cdz = entity.z - camPos.z;
    const camDistSq = cdx * cdx + cdz * cdz;
    const stride = camDistSq < 60 * 60 ? 1 : camDistSq < 120 * 120 ? 2 : 3;
    if (stride > 1 && (animFrame.current + entity.id) % stride !== 0) return;
    const dt = animAccum.current;
    animAccum.current = 0;

    perf.begin("entities.anim");
    mixer.current.update(dt);

    const isLocal = entity.id === game.localEntityId;
    const now = performance.now();
    const dying = entity.anim === "Death" || entity.healthPct <= 0;

    // Fade-in reveal: ramp the (already posed) character from invisible to
    // full over FADE_IN_MS, then restore the exact authored material state
    // (transparent flags, opacity) so flash/palette logic behaves as usual.
    let fade = 1;
    if (!fadeDone.current) {
      fade = THREE.MathUtils.clamp((now - fadeStartAt.current) / FADE_IN_MS, 0, 1);
      if (fade >= 1) {
        fadeDone.current = true;
        applyMannequinPalette(flashMats.current, entity.tint, isNpc, tronStyle);
      } else {
        for (const f of flashMats.current) f.mat.opacity = fade;
      }
    }

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
          ? activeWeaponKind(useGame.getState().inventory)
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
      // Gentle breathing glow; fade the border out as the character dies and
      // in with the reveal.
      const pulse = 0.85 + Math.sin(now * 0.005) * 0.12;
      const alpha = dying ? 0 : pulse * fade;
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
      // the visuals can't suggest shooting is possible bare-handed. The gun
      // shares materials across clones (can't fade it), so it stays hidden
      // until the body reveal completes.
      if (fade < 1) {
        mount.holder.visible = false;
      } else if (isLocal) {
        const weapon = activeWeaponKind(useGame.getState().inventory);
        mount.holder.visible = weapon === "Pistol" || weapon === "Smg";
      } else {
        mount.holder.visible = true;
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

  // Nothing while the GLB loads (preloaded at character select, so this is
  // typically a frame or two); the posed rig then fades in via FADE_IN_MS.
  if (!model) return null;
  return <primitive object={model.scene} />;
}

// LootCrate resources are shared across all crates (~150 ammo caches can be
// streamed in at once). The pulse animations are functions of the global
// clock, identical for every crate, so one shared material per variant is
// driven by a single useFrame in the first mounted crate that frame.
const crateBoxGeo = new THREE.BoxGeometry(0.6, 0.55, 0.6);
const crateCapGeo = new THREE.BoxGeometry(0.5, 0.06, 0.5);
const crateBodyMat = new THREE.MeshStandardMaterial({
  color: "#2a2f36",
  roughness: 0.6,
  metalness: 0.3,
});
const ammoBodyMat = new THREE.MeshStandardMaterial({
  color: "#323841",
  roughness: 0.6,
  metalness: 0.3,
});
const crateCapMat = new THREE.MeshStandardMaterial({
  color: "#ffffff",
  emissive: "#e8f2ff",
  emissiveIntensity: 2,
});
const ammoCapMat = new THREE.MeshStandardMaterial({
  color: "#ffffff",
  emissive: "#f4faff",
  emissiveIntensity: 2,
});
/** Soft white halo behind a crate's floating item icon (shared material). */
const crateIconHaloMat = new THREE.SpriteMaterial({
  map: entityGlowTexture,
  color: "#ffffff",
  transparent: true,
  opacity: 0.3,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
});
let cratePulseFrame = -1;

function LootCrate({ entity }: { entity: GameEntity }) {
  // Ammo caches (variant 1) get a brighter cap + ground glow so ammo is easy
  // to spot without a tall beacon beam cluttering the scene.
  const isAmmo = entity.variant === 1;
  const icon = useRef<THREE.Group>(null);
  useFrame(({ clock }) => {
    // Shared materials only need one update per frame, not one per crate.
    if (cratePulseFrame !== clock.elapsedTime) {
      cratePulseFrame = clock.elapsedTime;
      const pulse = 1.5 + Math.sin(clock.elapsedTime * 4) * 0.8;
      crateCapMat.emissiveIntensity = pulse;
      ammoCapMat.emissiveIntensity = pulse + 1.5;
    }
    // Gentle per-crate bob for the floating icon (phase from the entity id).
    if (icon.current) {
      icon.current.position.y = 1.02 + Math.sin(clock.elapsedTime * 1.8 + entity.id) * 0.05;
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
      <mesh
        position={[0, 0.28, 0]}
        castShadow
        geometry={crateBoxGeo}
        material={isAmmo ? ammoBodyMat : crateBodyMat}
      />
      <mesh
        position={[0, 0.58, 0]}
        geometry={crateCapGeo}
        material={isAmmo ? ammoCapMat : crateCapMat}
      />
      {/* White glowing icon of the contents, floating above the crate: a soft
          additive halo behind the item's inventory glyph. Subtle at range but
          instantly tells you what the drop is. */}
      {entity.item && (
        <group ref={icon} position={[0, 1.02, 0]}>
          <sprite material={crateIconHaloMat} scale={[0.95, 0.95, 1]} raycast={noRaycast} />
          <sprite material={itemSpriteMaterial(entity.item)} scale={[0.5, 0.5, 1]} raycast={noRaycast} />
        </group>
      )}
      {/* No real pointLight here: with ~150 ammo caches replicated, per-crate
          lights multiply every material's shading cost (each forward-rendered
          fragment loops over all scene lights) and force shader recompiles.
          A flat ground glow marks the cache instead of a tall beacon beam. */}
      {isAmmo && <GroundGlow color="#ffffff" radius={2.2} opacity={0.4} />}
    </group>
  );
}

function ExtractionBeacon({ entity }: { entity: GameEntity }) {
  return (
    <group
      onClick={(e) => {
        e.stopPropagation();
        game.send?.({ t: "Interact", d: { entity_id: entity.id } });
      }}
      onPointerOver={() => (document.body.style.cursor = "pointer")}
      onPointerOut={() => (document.body.style.cursor = "default")}
    >
      {/* Ground pad only — the tall vertical light beam was removed. The pad
          plus ground glow marks the extraction point without a sky-high cone. */}
      <mesh position={[0, 0.15, 0]}>
        <cylinderGeometry args={[1.1, 1.3, 0.3, 24]} />
        <meshStandardMaterial color="#0f2a24" emissive="#1affc4" emissiveIntensity={0.7} />
      </mesh>
      <GroundGlow color="#1affc4" radius={2.4} opacity={0.4} />
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
      <GroundGlow color={color} radius={2.4} y={0.13} />
    </group>
  );
}

/** One cached canvas texture per building kind: the floating holo sign that
 * labels every service building in-world. ~10 kinds total, shared by all
 * instances, so texture cost is flat regardless of entity count. */
const signCache = new Map<string, { tex: THREE.CanvasTexture; aspect: number }>();

function signTexture(kind: EntityKind): { tex: THREE.CanvasTexture; aspect: number } | null {
  const style = POI_STYLES[kind];
  if (!style) return null;
  let entry = signCache.get(kind);
  if (entry) return entry;
  const pad = 14;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  ctx.font = "700 40px Rajdhani, system-ui, sans-serif";
  const tw = Math.ceil(ctx.measureText(style.label).width);
  canvas.width = tw + pad * 2;
  canvas.height = 64;
  ctx.font = "700 40px Rajdhani, system-ui, sans-serif";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "rgba(5, 10, 18, 0.55)";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.shadowColor = style.color;
  ctx.shadowBlur = 10;
  ctx.fillStyle = style.color;
  ctx.fillText(style.label, pad, canvas.height / 2 + 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.anisotropy = 4;
  entry = { tex, aspect: canvas.width / canvas.height };
  signCache.set(kind, entry);
  return entry;
}

/** Floating holographic name sign above a service building. */
function HoloSign({ kind, y = 3.1 }: { kind: EntityKind; y?: number }) {
  const sign = signTexture(kind);
  if (!sign) return null;
  const h = 0.62;
  return (
    <sprite position={[0, y, 0]} scale={[sign.aspect * h, h, 1]} raycast={noRaycast}>
      <spriteMaterial map={sign.tex} transparent depthWrite={false} />
    </sprite>
  );
}

// ---------------------------------------------------------------------------
// Service POI storefronts
// ---------------------------------------------------------------------------

/** Panel opened alongside the Interact message when a shop is clicked. */
function openShopPanel(kind: EntityKind): void {
  const { set } = useGame.getState();
  switch (kind) {
    case "Building":
      set({ inventoryOpen: true });
      break;
    case "MarketTerminal":
      set({ marketOpen: true });
      break;
    case "Refinery":
    case "Factory":
    case "Laboratory":
      set({ craftOpen: true });
      break;
    case "Armory":
    case "Bank":
    case "Bodega":
      set({ vendorOpen: true });
      break;
    default:
      break; // Dealership: interact only (placeholder until vehicles ship)
  }
}

/** Fascia sign per kind: a dark board with the location name glowing in its
 * accent color. One canvas texture + material per kind, shared by every
 * instance. */
const shopSignCache = new Map<string, { mat: THREE.MeshBasicMaterial; aspect: number }>();

function shopSignMaterial(kind: EntityKind): { mat: THREE.MeshBasicMaterial; aspect: number } | null {
  const style = POI_STYLES[kind];
  if (!style) return null;
  let entry = shopSignCache.get(kind);
  if (entry) return entry;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  const font = "700 54px Rajdhani, system-ui, sans-serif";
  const applyFont = () => {
    ctx.font = font;
    ctx.letterSpacing = "5px";
  };
  applyFont();
  const pad = 30;
  const tw = Math.ceil(ctx.measureText(style.label).width);
  canvas.width = tw + pad * 2;
  canvas.height = 92;
  // Board face: near-black plate with a faint accent keyline.
  ctx.fillStyle = "#0a0d13";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.globalAlpha = 0.35;
  ctx.strokeStyle = style.color;
  ctx.lineWidth = 3;
  ctx.strokeRect(4, 4, canvas.width - 8, canvas.height - 8);
  ctx.globalAlpha = 1;
  applyFont(); // resizing the canvas reset the 2D state
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  ctx.shadowColor = style.color;
  ctx.shadowBlur = 16;
  ctx.fillStyle = style.color;
  ctx.fillText(style.label, canvas.width / 2, canvas.height / 2 + 3);
  ctx.shadowBlur = 0;
  ctx.fillText(style.label, canvas.width / 2, canvas.height / 2 + 3);
  const tex = new THREE.CanvasTexture(canvas);
  tex.anisotropy = 8;
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false });
  entry = { mat, aspect: canvas.width / canvas.height };
  shopSignCache.set(kind, entry);
  return entry;
}

/**
 * The building whose street face hosts this POI. The server places service
 * entities on the sidewalk tile fronting a building footprint (-z face), so
 * the hosting building is the nearest one whose front row is just behind
 * the entity. Returns placement data in world space, or null while the
 * chunk hasn't streamed in yet.
 */
interface HostFace {
  /** World x-extent of the hosting building's front face. */
  x0: number;
  x1: number;
  /** World z of the front wall plane (building side; front is -z). */
  wallZ: number;
}

function hostBuildingFace(x: number, z: number): HostFace | null {
  const cx = Math.floor(x / CHUNK_SIZE);
  const cz = Math.floor(z / CHUNK_SIZE);
  const chunk = game.chunks.chunks.get(chunkKey(cx, cz));
  if (!chunk) return null;
  const ox = cx * CHUNK_SIZE;
  const oz = cz * CHUNK_SIZE;
  let best: HostFace | null = null;
  let bestD = Infinity;
  for (const b of chunk.buildings) {
    const x0 = ox + b.tx0 * TILE_SIZE;
    const x1 = ox + b.tx1 * TILE_SIZE;
    const wallZ = oz + b.tz0 * TILE_SIZE;
    // The entity must stand in front of the face (within one tile of the
    // wall) and within its x-extent.
    if (x < x0 - 0.5 || x > x1 + 0.5) continue;
    const dz = wallZ - z;
    if (dz < 0 || dz > TILE_SIZE * 1.5) continue;
    if (dz < bestD) {
      bestD = dz;
      best = { x0, x1, wallZ };
    }
  }
  return best;
}

/**
 * Service POI anchored to the procedural storefront of its hosting city
 * building: a text sign board mounted on the building's fascia over the
 * entity, a soft accent strip, and an invisible interaction volume over
 * the storefront bay. The building itself renders through Chunks/Buildings
 * as usual — nothing extra is built here.
 */
function ShopFront({ entity }: { entity: GameEntity }) {
  const accent = POI_STYLES[entity.kind]?.color ?? "#4fc3ff";
  // The hosting building's chunk may stream in after the entity spawns.
  const [host, setHost] = useState<HostFace | null>(() =>
    hostBuildingFace(entity.x, entity.z),
  );
  useFrame(() => {
    if (host === null) {
      const resolved = hostBuildingFace(entity.x, entity.z);
      if (resolved !== null) setHost(resolved);
    }
  });

  const sign = shopSignMaterial(entity.kind);
  // Everything below is positioned relative to the entity (the group's
  // origin), which stands on the sidewalk tile fronting the building.
  // Fascia geometry constants mirror building.ts buildStorefront: fascia
  // band centered at y 3.95; random shop boards reach ~0.53 proud of the
  // wall, so this board mounts clear of them at ~0.7.
  const wallDz = host ? host.wallZ - entity.z : TILE_SIZE / 2;
  const signY = 3.95;
  // Sign plane sized from the texture aspect, clamped to the hosting face.
  const faceW = host ? host.x1 - host.x0 : 6;
  let signH = 0.85;
  let signW = signH * (sign?.aspect ?? 4);
  const maxW = Math.min(5.6, faceW - 0.8);
  if (signW > maxW) {
    signW = maxW;
    signH = signW / (sign?.aspect ?? 4);
  }

  return (
    <group
      onClick={(e) => {
        e.stopPropagation();
        game.send?.({ t: "Interact", d: { entity_id: entity.id } });
        openShopPanel(entity.kind);
      }}
      onPointerOver={() => (document.body.style.cursor = "pointer")}
      onPointerOut={() => (document.body.style.cursor = "default")}
    >
      {/* Sign board on the hosting building's fascia: dark backing + text,
          mounted proud of the fascia so it always beats the building's own
          random sign boards for the wall. */}
      <group position={[0, signY, wallDz - 0.7]}>
        <mesh position={[0, 0, 0.09]} castShadow>
          <boxGeometry args={[signW + 0.24, signH + 0.22, 0.14]} />
          <meshStandardMaterial color="#1c1e22" roughness={0.5} metalness={0.75} />
        </mesh>
        {sign && (
          <mesh rotation={[0, Math.PI, 0]} position={[0, 0, 0]} material={sign.mat}>
            <planeGeometry args={[signW, signH]} />
          </mesh>
        )}
        {/* Thin accent strip under the sign board. */}
        <mesh rotation={[0, Math.PI, 0]} position={[0, -(signH / 2) - 0.16, 0.02]}>
          <planeGeometry args={[signW + 0.24, 0.05]} />
          <meshBasicMaterial color={accent} toneMapped={false} />
        </mesh>
      </group>
      {/* Invisible interaction volume over the storefront bay. */}
      <mesh position={[0, 1.7, wallDz / 2]} visible={false}>
        <boxGeometry args={[Math.max(signW + 0.4, 3), 3.4, Math.max(wallDz, 1.2)]} />
        <meshBasicMaterial />
      </mesh>
      <GroundGlow color={accent} radius={2.4} opacity={0.12} />
    </group>
  );
}

/** Safehouse: a green-lit shelter dome with a ring marking the safety bubble. */
function SafehouseView({ entity }: { entity: GameEntity }) {
  const accent = POI_STYLES.Safehouse?.color ?? "#29d98c";
  const ring = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    if (ring.current) {
      (ring.current.material as THREE.MeshBasicMaterial).opacity =
        0.22 + Math.sin(clock.elapsedTime * 1.6) * 0.08;
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
      <mesh position={[0, 0.75, 0]} castShadow>
        <cylinderGeometry args={[1.3, 1.5, 1.5, 8]} />
        <meshStandardMaterial color="#101b16" roughness={0.5} metalness={0.5} />
      </mesh>
      <mesh position={[0, 1.62, 0]}>
        <sphereGeometry args={[1.32, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2]} />
        <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.5} />
      </mesh>
      {/* Safety-bubble boundary (matches the server's SAFEHOUSE_RADIUS). */}
      <mesh ref={ring} position={[0, 0.08, 0]} rotation={[-Math.PI / 2, 0, 0]} raycast={noRaycast}>
        <ringGeometry args={[9.6, 10, 48]} />
        <meshBasicMaterial color={accent} transparent opacity={0.25} depthWrite={false} />
      </mesh>
      <HoloSign kind="Safehouse" />
      <GroundGlow color={accent} radius={3} />
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
    // Mutate in place: a fresh object here was one allocation per character
    // per frame.
    if (prevPos.current) {
      prevPos.current.x = entity.x;
      prevPos.current.z = entity.z;
    } else {
      prevPos.current = { x: entity.x, z: entity.z };
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
    case "ResourceNode":
      body = <ResourceNodeView entity={entity} />;
      break;
    case "Building":
    case "MarketTerminal":
    case "Refinery":
    case "Factory":
    case "Laboratory":
    case "Armory":
    case "Bank":
    case "Bodega":
    case "Dealership":
      body = <ShopFront entity={entity} />;
      break;
    case "Safehouse":
      body = <SafehouseView entity={entity} />;
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
 * Camera distance (m) at which the bar renders at its base CSS size. Closer
 * than this it scales up (much larger, reading as attached to the enemy),
 * farther it shrinks — keeping a roughly constant size relative to the enemy
 * instead of a fixed pixel size on screen.
 */
const HP_SCALE_REF = 14;
/** Clamp so point-blank bars stay sane and distant ones stay legible. */
const HP_SCALE_MIN = 0.45;
const HP_SCALE_MAX = 3.2;

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
    let dist = 0;
    if (alive) {
      g.getWorldPosition(world.current);
      dist = camera.position.distanceTo(world.current);
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
      if (container.current) {
        container.current.style.opacity = String(opacity);
        // Scale inversely with distance so the bar keeps a constant size
        // relative to the enemy: much larger up close, smaller far away.
        const scale = THREE.MathUtils.clamp(
          HP_SCALE_REF / dist,
          HP_SCALE_MIN,
          HP_SCALE_MAX,
        );
        container.current.style.transform = `scale(${scale})`;
      }
      if (fill.current) {
        fill.current.style.width = `${Math.max(entity.healthPct, 0.02) * 100}%`;
      }
    }
  });

  return (
    <group ref={group} position={[0, 2.05, 0]}>
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

/** Memoized: an entity's object identity is stable for its lifetime, so
 * roster changes only reconcile keys instead of re-rendering every view. */
const MemoEntityView = memo(EntityView);

export function Entities() {
  // Mount/unmount entity views the moment the spawn/despawn arrives: the
  // roster version bumps synchronously with the network handler (the old
  // 500 ms poll added up to half a second before a spawned entity appeared).
  useSyncExternalStore(subscribeEntityRoster, getEntityRosterVersion);

  return (
    <>
      {[...game.entities.values()].map((entity) => (
        <MemoEntityView key={entity.id} entity={entity} />
      ))}
      <TargetReticle />
    </>
  );
}
