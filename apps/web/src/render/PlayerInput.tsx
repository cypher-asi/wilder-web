// Input: WASD (camera-relative) with client prediction at the server tick
// rate, and hold-LMB to fire at the aim point. Movement is WASD only (no
// click-to-move). Aiming is mouse-look while the canvas holds pointer lock
// (character faces camera forward, shots raycast from the center crosshair);
// the legacy twin-stick cursor aim remains as the unlocked fallback.

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import * as THREE from "three";
import {
  CROUCH_SPEED,
  ROLL_COOLDOWN,
  ROLL_DURATION,
  ROLL_SPEED,
  RUN_SPEED,
  stepMoveSpeed,
  WALK_SPEED,
} from "../game/collision";
import { playSfx } from "../assets/audio";
import { INTERACT_KINDS, openServicePanel } from "../game/interact";
import { interiorRegistry } from "../game/interiors";
import { GameConnection } from "../net/connection";
import { AbilityKind } from "../net/protocol";
import { perf } from "../perf/perf";
import { activeWeaponKind, game, GameEntity, useGame } from "../state/game";
import { cameraKick, cameraState, OTS_START_DISTANCE } from "./CameraRig";
import { groundHeightAt } from "./Ground";
import { pressOpenDoor } from "./Interior";

const TICK_DT = 1 / 20;

// Scratch objects reused across frames to avoid per-frame allocations.
const aimNdcScratch = new THREE.Vector2();
const aimHitScratch = new THREE.Vector3();
const muzzleScratch = new THREE.Vector3();

/** Client mirror of server weapon cooldowns (seconds) for fire pacing. */
const WEAPON_COOLDOWN: Record<string, number> = {
  Pistol: 0.3,
  Smg: 0.1,
  Pipe: 1.0,
  Knife: 0.55,
};
const FIST_COOLDOWN = 0.8;

/** Client mirror of server weapon ranges (m) for fire-time aim assist. */
const WEAPON_RANGE: Record<string, number> = {
  Pistol: 18,
  Smg: 15,
};
const FIST_RANGE = 1.5;
/** Perpendicular slack (m) for snapping a shot onto a nearby enemy. */
const AIM_ASSIST_RADIUS = 1.2;

/** Seconds LMB takes to draw the gun before the first shot can fire. */
const DRAW_TIME = 0.25;
/** Seconds without shooting before the gun is holstered again. */
const HOLSTER_AFTER = 5.0;
/**
 * Click buffer (ms): a click that lands mid-cooldown (or mid-draw) queues one
 * shot that fires the moment the gun is ready, so rapid semi-auto clicking
 * reaches the full fire rate instead of dropping shots whose press/release
 * fell inside the cooldown window. Long enough to cover the draw time.
 */
const SHOT_BUFFER_MS = 350;

const RANGED_WEAPONS = new Set(["Pistol", "Smg"]);

/** Interact (E) range in metres — matches the server's storefront range and
 * the proximity radius the HUD uses to surface the "PRESS E" prompts. */
const INTERACT_RANGE = 5.0;

function equippedCooldown(): number {
  const weapon = activeWeaponKind(useGame.getState().inventory);
  return (weapon && WEAPON_COOLDOWN[weapon]) || FIST_COOLDOWN;
}

function equippedRange(): number {
  const weapon = activeWeaponKind(useGame.getState().inventory);
  return (weapon && WEAPON_RANGE[weapon]) || FIST_RANGE;
}

function hasRangedWeapon(): boolean {
  const weapon = activeWeaponKind(useGame.getState().inventory);
  return weapon != null && RANGED_WEAPONS.has(weapon);
}

function ammoCount(): number {
  const inv = useGame.getState().inventory;
  if (!inv) return 0;
  let total = 0;
  for (const s of inv.slots) if (s?.kind === "Ammo9mm") total += s.count;
  return total;
}

export function PlayerInput({ connection }: { connection: GameConnection }) {
  const { camera, gl } = useThree();
  const keys = useRef<Record<string, boolean>>({});
  const accumulator = useRef(0);
  const pointer = useRef({ x: 0, y: 0, inside: false });
  const firing = useRef(false);
  // Sprint is hold-to-run: running only while Shift is held down.
  const running = useRef(false);
  const lastShotAt = useRef(0);
  /** Timestamp of the latest unconsumed click, for the shot buffer. */
  const pendingShotAt = useRef(-Infinity);
  /** Throttle for the out-of-ammo click/warning. */
  const lastDryFireAt = useRef(0);
  const raycaster = useRef(new THREE.Raycaster());
  const groundPlane = useRef(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0));

  useEffect(() => {
    const canvas = gl.domElement;

    const down = (event: KeyboardEvent) => {
      // Ignore game keys while typing in chat/UI inputs.
      if ((event.target as HTMLElement)?.tagName === "INPUT") return;
      // Dead: the death overlay owns the keyboard (any key respawns); no game
      // action should fire underneath it.
      if (useGame.getState().death) return;
      // While the fullscreen map is open only map keys work (HoloMap handles
      // Escape/T itself); everything else must not reach the paused game.
      if (useGame.getState().mapOpen && event.code !== "KeyM") return;
      // Same for the economy dashboard (it handles Escape itself).
      if (useGame.getState().economyOpen && event.code !== "KeyK") return;
      // While the game menu is open, Escape (resume) is the only game key.
      if (useGame.getState().menuOpen) {
        if (event.code === "Escape" && !event.repeat) {
          event.preventDefault();
          useGame.getState().set({ menuOpen: false });
        }
        return;
      }
      if (event.code === "Escape" && !event.repeat) {
        event.preventDefault();
        // Escape closes any visibly open panel first; with nothing open it
        // brings up the game menu. Flags can be set while the panel renders
        // nothing (no inventory yet, walked away from a station) — those
        // must not swallow the keypress.
        const ui = useGame.getState();
        const panelVisible =
          (ui.inventoryOpen && ui.inventory !== null) ||
          (ui.craftOpen && ui.nearStation !== null) ||
          (ui.marketOpen && ui.nearMarket) ||
          (ui.vendorOpen && ui.nearVendor !== null);
        if (panelVisible) {
          // This Escape is spent closing the panel. Closing it re-acquires
          // pointer lock, and the browser can immediately kick that lock back
          // out for the very same Escape press — CameraRig must not treat
          // that unlock as "open the game menu".
          cameraState.suppressMenuUntil = performance.now() + 1500;
          ui.set({
            inventoryOpen: false,
            craftOpen: false,
            marketOpen: false,
            vendorOpen: false,
          });
        } else {
          ui.set({ menuOpen: true });
        }
        return;
      }
      keys.current[event.code] = true;
      if (event.code === "KeyI" || event.code === "Tab" || event.code === "KeyB") {
        event.preventDefault();
        useGame.getState().toggleInventory();
      }
      if (event.code === "KeyM") {
        event.preventDefault();
        useGame.getState().toggleMap();
      }
      if (event.code === "KeyK") {
        event.preventDefault();
        useGame.getState().toggleEconomy();
      }
      if (event.code === "ShiftLeft" || event.code === "ShiftRight") {
        running.current = true;
      }
      if (event.code === "Enter") {
        // Prevent the same key stroke from submitting the just-focused input.
        event.preventDefault();
        useGame.getState().set({ chatOpen: true });
      }
      if (event.code === "Space" && !event.repeat) {
        event.preventDefault();
        startRoll();
      }
      // Ctrl is hold-to-crouch (crouch while held); C stays a toggle.
      if ((event.code === "ControlLeft" || event.code === "ControlRight") && !event.repeat) {
        event.preventDefault();
        setCrouch(true);
      }
      if (event.code === "KeyC" && !event.repeat) {
        event.preventDefault();
        toggleCrouch();
      }
      if (event.code === "KeyQ" && !event.repeat) useAbility("Stim");
      if (event.code === "KeyG" && !event.repeat) useAbility("Shockwave");
      if (event.code === "KeyR" && !event.repeat) useAbility("Overcharge");
      if (event.code === "KeyE" && !event.repeat) interact();
      const digit = /^(?:Digit|Numpad)([0-9])$/.exec(event.code);
      if (digit && !event.repeat) {
        const n = Number(digit[1]);
        if (n === 0) holsterToFists();
        else if (n === 1 || n === 2) selectWeapon(n - 1);
      }
    };
    const up = (event: KeyboardEvent) => {
      keys.current[event.code] = false;
      if (event.code === "ShiftLeft" || event.code === "ShiftRight") {
        running.current = false;
      }
      if (event.code === "ControlLeft" || event.code === "ControlRight") {
        setCrouch(false);
      }
    };

    const onPointerMove = (event: PointerEvent) => {
      pointer.current.x = (event.clientX / window.innerWidth) * 2 - 1;
      pointer.current.y = -(event.clientY / window.innerHeight) * 2 + 1;
      pointer.current.inside = true;
      // Mirror the raw cursor so the on-target reticle can follow where the
      // aim lands on the enemy silhouette (not a fixed chest point).
      game.pointer.ndcX = pointer.current.x;
      game.pointer.ndcY = pointer.current.y;
      game.pointer.inside = true;
    };
    const onPointerLeave = () => {
      pointer.current.inside = false;
      game.pointer.inside = false;
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      // Don't fire while the death overlay is up (it dismisses on click).
      if (useGame.getState().death) return;
      // The unlocked canvas click only (re)acquires pointer lock (CameraRig);
      // it must not double as a trigger pull. When pointer lock is denied
      // outright (embedded browsers, test harnesses) the twin-stick fallback
      // stays live, so clicks keep firing there.
      if (!cameraState.locked && !cameraState.lockUnavailable) return;
      const now = performance.now();
      // Draw is a ranged-only concept: melee/fists punch immediately with no
      // draw delay and no invisible-gun aim pose.
      if (hasRangedWeapon() && !game.gun.drawn) {
        // First click draws the weapon; shooting starts on the next click
        // (or by holding once the draw finishes).
        game.gun.drawn = true;
        game.gun.readyAt = now + DRAW_TIME * 1000;
        game.gun.lastShotAt = now; // baseline for the auto-holster timer
      }
      firing.current = true;
      pendingShotAt.current = now;
    };
    const onPointerUp = (event: PointerEvent) => {
      if (event.button === 0) firing.current = false;
    };
    const onBlur = () => {
      firing.current = false;
      // Held keys never get their keyup once focus leaves; release run/crouch
      // so the player doesn't stay stuck sprinting or crouched.
      running.current = false;
      setCrouch(false);
    };

    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("pointermove", onPointerMove);
    document.documentElement.addEventListener("pointerleave", onPointerLeave);
    canvas.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("pointermove", onPointerMove);
      document.documentElement.removeEventListener("pointerleave", onPointerLeave);
      canvas.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [gl, connection]);

  /** Current WASD direction in world space, or null when no key is held. */
  function moveDirection(): [number, number] | null {
    const k = keys.current;
    let ix = 0;
    let iz = 0;
    if (k.KeyW || k.ArrowUp) iz -= 1;
    if (k.KeyS || k.ArrowDown) iz += 1;
    if (k.KeyA || k.ArrowLeft) ix -= 1;
    if (k.KeyD || k.ArrowRight) ix += 1;
    if (ix === 0 && iz === 0) return null;
    // Camera-relative: forward = away from camera on XZ.
    const yaw = cameraState.yaw;
    const fx = -Math.cos(yaw);
    const fz = -Math.sin(yaw);
    const rx = -fz;
    const rz = fx;
    let dx = fx * -iz + rx * ix;
    let dz = fz * -iz + rz * ix;
    const len = Math.hypot(dx, dz);
    return [dx / len, dz / len];
  }

  /** Space: dodge roll along the movement direction (fallback: facing). */
  function startRoll() {
    const now = performance.now();
    if (game.roll || now < game.rollReadyAt || game.localEntityId === 0) return;
    const dir = moveDirection();
    const yaw = game.aim.active ? game.aim.yaw : game.predicted.yaw;
    const [dx, dz] = dir ?? [Math.cos(yaw), Math.sin(yaw)];
    if (game.crouching) toggleCrouch();
    game.roll = { until: now + ROLL_DURATION * 1000, dx, dz };
    game.rollReadyAt = now + ROLL_COOLDOWN * 1000;
    // Snap the visual yaw to the dash direction immediately so the whole
    // roll plays head-first along it instead of easing around mid-tumble.
    game.predicted.yaw = Math.atan2(dz, dx);
    game.rendered.yaw = game.predicted.yaw;
    const seq = game.nextSeq++;
    connection.send({ t: "Roll", d: { seq, dx, dz } });
  }

  function setCrouch(on: boolean) {
    if (game.localEntityId === 0 || game.crouching === on) return;
    if (on && game.roll) return; // can't crouch mid-roll
    game.crouching = on;
    connection.send({ t: "SetCrouch", d: { on } });
  }

  function toggleCrouch() {
    setCrouch(!game.crouching);
  }

  /**
   * E: interact with the nearest service building/station/vendor/market within
   * range. Key-driven so clicking a building never accidentally opens a menu.
   * Pressing E again closes an already-open panel (toggle). Standing inside a
   * walk-in store room counts as in range of its service regardless of the
   * distance to the entity anchor out on the sidewalk.
   */
  function interact() {
    if (game.localEntityId === 0) return;
    const px = game.predicted.x;
    const pz = game.predicted.z;
    const room = interiorRegistry.roomAt(px, pz);
    // Outside a room, E first serves the door: force the nearest one open
    // and walk in — the service panel opens at the counter, not the curb.
    if (!room && pressOpenDoor(px, pz)) return;
    let best: GameEntity | null = null;
    let bestDist = INTERACT_RANGE;
    for (const e of game.entities.values()) {
      if (!INTERACT_KINDS.has(e.kind)) continue;
      const inRoom = room !== null && room.doors.some((dr) => dr.entity === e.id);
      const d = inRoom ? 0 : Math.hypot(e.x - px, e.z - pz);
      if (d < bestDist) {
        bestDist = d;
        best = e;
      }
    }
    if (!best) return;
    openServicePanel(best.kind, best.id);
  }

  /** Q/G/R: fire an ability if it's off cooldown (server re-validates). */
  function useAbility(ability: AbilityKind) {
    if (game.localEntityId === 0) return;
    const state = useGame.getState().abilities[ability];
    if (performance.now() < state.readyAt) return;
    const seq = game.nextSeq++;
    connection.send({ t: "UseAbility", d: { seq, ability } });
  }

  /** Keys 1/2: switch the weapon in hand to Weapon 1 / Weapon 2. */
  function selectWeapon(weaponSlot: number) {
    if (game.localEntityId === 0) return;
    const inv = useGame.getState().inventory;
    if (!inv || inv.active_weapon === weaponSlot) return;
    game.gun.drawn = false;
    connection.send({
      t: "InventoryAction",
      d: { t: "SelectWeapon", d: { weapon_slot: weaponSlot } },
    });
  }

  /** Key 0: holster the active weapon and fight bare-fisted (melee). */
  function holsterToFists() {
    if (game.localEntityId === 0) return;
    const inv = useGame.getState().inventory;
    if (!inv || !activeWeaponKind(inv)) return;
    game.gun.drawn = false;
    connection.send({
      t: "InventoryAction",
      d: { t: "Unequip", d: { weapon: true, weapon_slot: inv.active_weapon } },
    });
  }

  useFrame((_, rawDt) => {
    perf.begin("input");
    // Clamp dt: resuming from the paused map frameloop reports one huge delta,
    // which would otherwise burst-fire dozens of catch-up move ticks.
    const dt = Math.min(rawDt, 0.1);
    updateAim();
    updateFire();
    updateHolster();
    accumulator.current += dt;
    while (accumulator.current >= TICK_DT) {
      accumulator.current -= TICK_DT;
      stepInput();
    }
    // Live input state for the local anim controller (Entities.tsx).
    const liveDir = moveDirection();
    game.input.moving = liveDir !== null;
    game.input.dx = liveDir ? liveDir[0] : 0;
    game.input.dz = liveDir ? liveDir[1] : 0;
    game.input.run = running.current;
    updateRendered(dt);
    perf.end("input");
  });

  /**
   * Ease the visual position toward the 20 Hz sim so the character doesn't
   * step across the screen; the sim itself stays discrete for reconciliation.
   */
  function updateRendered(dt: number) {
    const r = game.rendered;
    const p = game.predicted;
    if (Math.hypot(p.x - r.x, p.z - r.z) > 2) {
      // Teleport/respawn: don't glide across the map.
      r.x = p.x;
      r.z = p.z;
      r.yaw = p.yaw;
      return;
    }
    const t = 1 - Math.exp(-dt * 18);
    r.x += (p.x - r.x) * t;
    r.z += (p.z - r.z) * t;
    let dy = p.yaw - r.yaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    r.yaw += dy * t;
  }

  /** Put the gun away after a few seconds without shooting. */
  function updateHolster() {
    if (!game.gun.drawn || firing.current) return;
    if (performance.now() - game.gun.lastShotAt > HOLSTER_AFTER * 1000) {
      game.gun.drawn = false;
    }
  }

  /** The hovered enemy, if it's still a valid (alive, known) target. */
  function hoverTarget(): GameEntity | null {
    if (game.hoverTargetId == null) return null;
    const target = game.entities.get(game.hoverTargetId);
    if (!target || target.healthPct <= 0 || target.anim === "Death") return null;
    return target;
  }

  /**
   * Ground point the shot should actually be sent at. A hovered enemy wins;
   * otherwise, if the aim ray passes close to a live enemy within weapon range,
   * snap onto it so the server hitscan lands even without a pixel-perfect
   * hover. Falls back to the raw cursor point.
   */
  function fireTarget(): { x: number; z: number } {
    const hovered = hoverTarget();
    if (hovered) return { x: hovered.x, z: hovered.z };
    if (!hasRangedWeapon()) return { x: game.aim.x, z: game.aim.z };
    const px = game.rendered.x;
    const pz = game.rendered.z;
    const dirX = Math.cos(game.aim.yaw);
    const dirZ = Math.sin(game.aim.yaw);
    const range = equippedRange();
    let best: GameEntity | null = null;
    let bestAlong = Infinity;
    for (const e of game.entities.values()) {
      if (
        (e.kind !== "Npc" && e.kind !== "Agent") ||
        e.healthPct <= 0 ||
        e.anim === "Death"
      )
        continue;
      const rx = e.x - px;
      const rz = e.z - pz;
      const along = rx * dirX + rz * dirZ;
      if (along < 0.3 || along > range) continue;
      const perp = Math.abs(rx * dirZ - rz * dirX);
      if (perp <= AIM_ASSIST_RADIUS && along < bestAlong) {
        bestAlong = along;
        best = e;
      }
    }
    return best ? { x: best.x, z: best.z } : { x: game.aim.x, z: game.aim.z };
  }

  /**
   * Mouse-look (pointer locked): aim straight along camera forward, with the
   * aim point taken from the center-crosshair ray. Unlocked fallback: project
   * the cursor onto the ground plane at the player's elevation (twin-stick).
   */
  function updateAim() {
    if (cameraState.locked) {
      // RMB free-look: hold the current facing while the camera swings.
      if (cameraState.dragging) return;
      const px = game.rendered.x;
      const pz = game.rendered.z;
      // cameraState.yaw points from player toward the camera; forward is the
      // opposite direction.
      game.aim.yaw = cameraState.yaw + Math.PI;
      // Screen center is the aim reference for everything (crosshair,
      // reticle, fire target).
      game.pointer.ndcX = 0;
      game.pointer.ndcY = 0;
      game.pointer.inside = true;
      groundPlane.current.constant = -groundHeightAt(px, pz);
      aimNdcScratch.set(0, 0);
      raycaster.current.setFromCamera(aimNdcScratch, camera);
      const centerHit = aimHitScratch;
      if (raycaster.current.ray.intersectPlane(groundPlane.current, centerHit)) {
        game.aim.x = centerHit.x;
        game.aim.z = centerHit.z;
      } else {
        // Looking above the horizon: aim far along forward on the ground.
        game.aim.x = px + Math.cos(game.aim.yaw) * 50;
        game.aim.z = pz + Math.sin(game.aim.yaw) * 50;
      }
      game.aim.active = true;
      return;
    }
    if (!pointer.current.inside) {
      game.aim.active = false;
      return;
    }
    // While RMB-dragging the camera, hold the current facing: the cursor's
    // ground projection sweeps as the camera orbits, so recomputing here would
    // spin the character and prevent you from viewing its front.
    if (cameraState.dragging) return;
    // Aim relative to the smoothed (on-screen) position so the ring and the
    // aim line stay glued to the character.
    const px = game.rendered.x;
    const pz = game.rendered.z;
    groundPlane.current.constant = -groundHeightAt(px, pz);
    aimNdcScratch.set(pointer.current.x, pointer.current.y);
    raycaster.current.setFromCamera(aimNdcScratch, camera);
    const hit = aimHitScratch;
    if (!raycaster.current.ray.intersectPlane(groundPlane.current, hit)) return;
    game.aim.x = hit.x;
    game.aim.z = hit.z;
    const dx = hit.x - px;
    const dz = hit.z - pz;
    if (dx * dx + dz * dz > 0.01) {
      game.aim.yaw = Math.atan2(dz, dx);
    }
    // Soft lock: while hovering an enemy, face (and aim at) it exactly.
    const target = hoverTarget();
    if (target) {
      const tdx = target.x - px;
      const tdz = target.z - pz;
      if (tdx * tdx + tdz * tdz > 0.01) {
        game.aim.x = target.x;
        game.aim.z = target.z;
        game.aim.yaw = Math.atan2(tdz, tdx);
      }
    }
    game.aim.active = true;
  }

  /**
   * Hold-to-fire at the equipped weapon's rate, aimed at the cursor (or
   * snapped to the hovered enemy). Only shoots once the weapon is drawn
   * (first click) and the draw finished. Works from every movement state
   * except mid-roll.
   */
  function updateFire() {
    const now = performance.now();
    // A recent click keeps one shot queued even if the button was already
    // released, so quick taps never fall between cooldown windows.
    const buffered = now - pendingShotAt.current < SHOT_BUFFER_MS;
    if ((!firing.current && !buffered) || !game.aim.active) return;
    // Draw/ready gate is ranged-only; melee and bare fists punch immediately.
    if (hasRangedWeapon() && (!game.gun.drawn || now < game.gun.readyAt)) return;
    if (game.roll) return; // no attacking mid-roll
    if (now - lastShotAt.current < equippedCooldown() * 1000) return;
    // Dry trigger: don't send a doomed Attack or play phantom shot FX that
    // would look like hits silently not registering. Surface it loudly so
    // the player knows why nothing is firing.
    if (hasRangedWeapon() && ammoCount() === 0) {
      if (now - lastDryFireAt.current > 1000) {
        lastDryFireAt.current = now;
        useGame.getState().pushChat({
          from: "system",
          text: "Out of ammo! (9mm)",
          system: true,
        });
      }
      pendingShotAt.current = -Infinity;
      return;
    }
    pendingShotAt.current = -Infinity; // consume the buffered click
    lastShotAt.current = now;
    game.gun.lastShotAt = now;
    game.gun.shotSeq++;
    const seq = game.nextSeq++;
    const target = fireTarget();
    connection.send({ t: "Attack", d: { seq, tx: target.x, tz: target.z } });

    // Instant local feedback: muzzle flash, projectile, shell, recoil, sfx.
    // The server's MuzzleFlash event is skipped for our own shots.
    if (hasRangedWeapon()) {
      void playSfx("sfx_shoot", 0.3);
      // Orient the FX toward the resolved target so the flash/projectile
      // follow the shot even when aim assist snapped it onto a nearby enemy.
      const yaw = Math.atan2(
        target.z - game.rendered.z,
        target.x - game.rendered.x,
      );
      const mount = game.gunMounts.get(game.localEntityId);
      const muzzle = mount
        ? mount.muzzle.getWorldPosition(muzzleScratch)
        : null;
      const mx = muzzle?.x ?? game.rendered.x + Math.cos(yaw) * 0.5;
      const my = muzzle?.y ?? 1.35;
      const mz = muzzle?.z ?? game.rendered.z + Math.sin(yaw) * 0.5;
      game.fx.push({ type: "flash", x: mx, y: my, z: mz, yaw, at: now });
      // Projectile spawns immediately so rapid fire has zero server lag on
      // your own bullets (remote players' bolts come from MuzzleFlash).
      game.fx.push({
        type: "tracer",
        fx: mx,
        fy: my,
        fz: mz,
        tx: target.x,
        ty: 1.25,
        tz: target.z,
        at: now,
      });
      game.fx.push({
        type: "shell",
        x: mx,
        y: my,
        z: mz,
        dirX: -Math.sin(yaw),
        dirZ: Math.cos(yaw),
        at: now,
      });
      const weapon = activeWeaponKind(useGame.getState().inventory);
      cameraKick(weapon === "Smg" ? 0.1 : 0.22, yaw);
    }
  }

  function stepInput() {
    const now = performance.now();

    // Active dodge roll: predict the server's dash locally; the server drains
    // (and acks) any queued MoveInputs without applying them, so we don't
    // send movement while rolling.
    if (game.roll) {
      if (now >= game.roll.until) {
        game.roll = null;
      } else {
        const [nx, nz] = stepMoveSpeed(
          game.chunks,
          game.predicted.x,
          game.predicted.z,
          game.roll.dx,
          game.roll.dz,
          ROLL_SPEED,
          TICK_DT,
        );
        game.predicted.x = nx;
        game.predicted.z = nz;
        game.predicted.yaw = Math.atan2(game.roll.dz, game.roll.dx);
        game.lastDirectInputAt = now;
        game.moveMarker = null;
        return;
      }
    }

    const dir = moveDirection();
    if (!dir) return;
    const [dx, dz] = dir;

    const run = running.current; // walk by default; hold Shift to run
    const speed = game.crouching ? CROUCH_SPEED : run ? RUN_SPEED : WALK_SPEED;

    // Facing follows the aim (twin-stick); fall back to move direction.
    const yaw = game.aim.active ? game.aim.yaw : Math.atan2(dz, dx);
    const seq = game.nextSeq++;
    connection.send({ t: "MoveInput", d: { seq, dx, dz, yaw, run } });
    game.pendingInputs.push({ seq, dx, dz, speed, dt: TICK_DT });
    if (game.pendingInputs.length > 120) game.pendingInputs.shift();

    // Predict locally with identical rules.
    const [nx, nz] = stepMoveSpeed(
      game.chunks,
      game.predicted.x,
      game.predicted.z,
      dx,
      dz,
      speed,
      TICK_DT,
    );
    game.predicted.x = nx;
    game.predicted.z = nz;
    game.predicted.yaw = yaw;
    game.lastDirectInputAt = now;
    game.moveMarker = null;
  }

  return (
    <>
      <AimRing />
    </>
  );
}

/**
 * The Ascent-style aim ring: a red ring under the player with a directional
 * arc + aim line that tracks the mouse in real time.
 */
function AimRing() {
  const group = useRef<THREE.Group>(null);

  useFrame(() => {
    if (!group.current) return;
    // Hidden in the over-the-shoulder zoom band: a ground ring under your own
    // feet is just noise when the camera sits at the shoulder.
    const visible =
      game.localEntityId !== 0 &&
      game.aim.active &&
      cameraState.distance > OTS_START_DISTANCE;
    group.current.visible = visible;
    if (!visible) return;
    const px = game.rendered.x;
    const pz = game.rendered.z;
    group.current.position.set(px, groundHeightAt(px, pz) + 0.05, pz);
    // Flat group: local +X maps to world +X, local +Y to world -Z, so a world
    // yaw of φ is a local rotation of -φ (see Euler XYZ order: Z applies first).
    group.current.rotation.set(-Math.PI / 2, 0, -game.aim.yaw);
  });

  // toneMapped={false} keeps the teal above the bloom threshold so the ring
  // reads as a soft glowing circuit rather than flat painted UI.
  return (
    <group ref={group} visible={false}>
      {/* base ring */}
      <mesh>
        <ringGeometry args={[0.57, 0.615, 40]} />
        <meshBasicMaterial
          color="#4fd0e0"
          transparent
          opacity={0.4}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
      {/* direction arc (centered on local +X = aim direction) */}
      <mesh>
        <ringGeometry args={[0.68, 0.76, 16, 1, -0.45, 0.9]} />
        <meshBasicMaterial
          color="#8fe6f2"
          transparent
          opacity={0.7}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
      {/* aim line extending toward the cursor */}
      <mesh position={[2.05, 0, 0]}>
        <planeGeometry args={[2.2, 0.035]} />
        <meshBasicMaterial
          color="#4fd0e0"
          transparent
          opacity={0.18}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
    </group>
  );
}
