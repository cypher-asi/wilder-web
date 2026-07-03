// WebSocket game connection: handshake, message dispatch, input sending.

import * as THREE from "three";
import {
  playAmmo,
  playCoin,
  playDeny,
  playGrunt,
  playLevelUp,
  playPickup,
  playPowerUp,
  playPurchase,
  playSfx,
} from "../assets/audio";
import { setTerritory } from "../game/territory";
import {
  armorShield,
  bumpEntityRoster,
  game,
  initialAbilities,
  spawnEntity,
  useGame,
} from "../state/game";
import { ITEM_INFO, itemLabel } from "../ui/ItemIcon";
import { RED_HEX } from "../ui/colors";
import { C2S, decode, encode, S2C } from "./protocol";

/**
 * Entity ids the local player has damaged recently, with the ms timestamp of
 * the last hit. Lets a kill be attributed to the player so the reward juice
 * (coin burst + power-up chime) only fires on kills we earned.
 */
const recentLocalHits = new Map<number, number>();
const KILL_CREDIT_MS = 2500;

/** World position of an entity's gun muzzle, if a mount is registered. */
function muzzlePosition(entityId: number): THREE.Vector3 | null {
  const mount = game.gunMounts.get(entityId);
  if (!mount) return null;
  return mount.muzzle.getWorldPosition(new THREE.Vector3());
}

export class GameConnection {
  private ws: WebSocket | null = null;
  private token: string;
  private characterId: string;
  closedByUser = false;

  constructor(token: string, characterId: string) {
    this.token = token;
    this.characterId = characterId;
  }

  connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;

    ws.onopen = () => {
      useGame.getState().set({ connected: true });
      game.send = (msg) => this.send(msg);
      this.send({ t: "Authenticate", d: { token: this.token } });
    };
    ws.onmessage = (event) => {
      this.handle(decode(event.data as string));
    };
    ws.onclose = () => {
      useGame.getState().set({ connected: false, joined: false });
      if (!this.closedByUser) {
        useGame.getState().pushChat({
          from: "system",
          text: "Disconnected. Reconnecting in 2s...",
          system: true,
        });
        setTimeout(() => {
          if (!this.closedByUser) this.connect();
        }, 2000);
      }
    };
  }

  close() {
    this.closedByUser = true;
    this.ws?.close();
  }

  send(msg: C2S) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(encode(msg));
    }
  }

  private handle(msg: S2C) {
    const ui = useGame.getState();
    switch (msg.t) {
      case "AuthResult": {
        if (msg.d.ok) {
          this.send({ t: "JoinWorld", d: { character_id: this.characterId } });
        } else {
          ui.set({ lastError: msg.d.error ?? "auth failed" });
        }
        break;
      }
      case "WorldJoined": {
        game.reset();
        game.localEntityId = msg.d.entity_id;
        game.worldSeed = msg.d.world_seed;
        game.predicted = {
          x: msg.d.character.position[0],
          z: msg.d.character.position[2],
          yaw: msg.d.character.yaw,
        };
        ui.set({
          joined: true,
          characterName: msg.d.character.name,
          health: msg.d.character.health,
          maxHealth: msg.d.character.max_health,
          shield: msg.d.character.shield ?? 0,
          maxShield: msg.d.character.max_shield ?? 0,
          abilities: initialAbilities(),
          level: msg.d.character.level,
          xp: msg.d.character.xp ?? 0,
          nextLevelXp: msg.d.character.level * 100,
          inventory: msg.d.inventory,
          position: msg.d.character.position,
        });
        ui.pushChat({
          from: "system",
          text: `Welcome to Wilder, ${msg.d.character.name}.`,
          system: true,
        });
        break;
      }
      case "ChunkData": {
        game.chunks.add(msg.d);
        ui.set({ chunkVersion: game.chunks.version });
        break;
      }
      case "ChunkUnload": {
        game.chunks.remove(msg.d.coord.x, msg.d.coord.z);
        ui.set({ chunkVersion: game.chunks.version });
        break;
      }
      case "EntitySpawn": {
        spawnEntity(msg.d);
        break;
      }
      case "EntityDespawn": {
        const entity = game.entities.get(msg.d.id);
        // A loot crate vanishing right next to us was almost certainly picked
        // up: play the little coin-pop VFX where it stood.
        if (entity?.kind === "LootContainer") {
          const dist = Math.hypot(
            entity.x - game.predicted.x,
            entity.z - game.predicted.z,
          );
          if (dist < 6) {
            game.fx.push({
              type: "lootPop",
              x: entity.x,
              y: entity.y,
              z: entity.z,
              item: entity.item,
              at: performance.now(),
            });
          }
        } else if (entity?.kind === "CurrencyPickup") {
          // Collected a loose coin/shard/energy: the Mario coin chime plus a
          // gold pop where it sat. The "+N" wallet toast rides the WalletUpdate.
          const dist = Math.hypot(
            entity.x - game.predicted.x,
            entity.z - game.predicted.z,
          );
          if (dist < 4) {
            playCoin();
            game.fx.push({
              type: "coinBurst",
              x: entity.x,
              y: entity.y + 0.3,
              z: entity.z,
              count: 3,
              metal: "gold",
              at: performance.now(),
            });
          }
        }
        recentLocalHits.delete(msg.d.id);
        game.entities.delete(msg.d.id);
        bumpEntityRoster();
        break;
      }
      case "Snapshot": {
        const now = performance.now();
        for (const snap of msg.d.entities) {
          const entity = game.entities.get(snap.id);
          if (!entity) continue;
          entity.healthPct = snap.health_pct;
          entity.samples.push({
            time: now,
            x: snap.position[0],
            z: snap.position[2],
            yaw: snap.yaw,
            anim: snap.anim,
          });
          if (entity.samples.length > 30) entity.samples.splice(0, entity.samples.length - 30);

          if (snap.id === game.localEntityId) {
            // Reconciliation: server state + replay of unacked inputs.
            this.reconcile(snap.position[0], snap.position[2], msg.d.last_input_seq);
            // Health/shield are authoritative from our own snapshot.
            const { maxHealth, maxShield } = useGame.getState();
            const health = Math.round(snap.health_pct * maxHealth);
            const shield = Math.round((snap.shield_pct ?? 0) * maxShield);
            const cur = useGame.getState();
            if (health !== cur.health || shield !== cur.shield) {
              ui.set({ health, shield });
            }
          }
        }
        break;
      }
      case "InventoryUpdate": {
        // Shield capacity follows equipped armor (mirrors the server rule).
        const maxShield = armorShield(msg.d.equipped_armor);
        const shield = Math.min(useGame.getState().shield, maxShield);
        ui.set({ inventory: msg.d, maxShield, shield });
        break;
      }
      case "StashUpdate": {
        ui.set({ stash: msg.d.slots });
        break;
      }
      case "Chat": {
        ui.pushChat({ from: msg.d.from, text: msg.d.text });
        break;
      }
      case "CombatEvent": {
        const ev = msg.d;
        const now = performance.now();
        if (ev.t === "Hit") {
          void playSfx("sfx_hit", 0.35);
          const target = game.entities.get(ev.d.target);
          if (target) {
            target.lastHitAt = now;
            target.hitReactAt = now;
            // Shot NPCs vocalize their pain on top of the impact tick.
            if (target.kind === "Npc") void playGrunt(0.45);
          }
          if (ev.d.attacker === game.localEntityId) {
            recentLocalHits.set(ev.d.target, now);
          }
          // Impact point comes from the server (actual ray hit position).
          game.fx.push({
            type: "hit",
            x: ev.d.x,
            y: ev.d.y,
            z: ev.d.z,
            damage: ev.d.damage,
            at: now,
          });
          const attacker = game.entities.get(ev.d.attacker);
          const dx = attacker ? ev.d.x - attacker.x : 1;
          const dz = attacker ? ev.d.z - attacker.z : 0;
          const len = Math.hypot(dx, dz) || 1;
          game.fx.push({
            type: "impact",
            x: ev.d.x,
            y: ev.d.y,
            z: ev.d.z,
            dirX: dx / len,
            dirZ: dz / len,
            kind:
              target && (target.kind === "Npc" || target.kind === "Player")
                ? "flesh"
                : "dust",
            at: now,
          });
        } else if (ev.t === "Miss") {
          const attacker = game.entities.get(ev.d.attacker);
          const dx = attacker ? ev.d.x - attacker.x : 1;
          const dz = attacker ? ev.d.z - attacker.z : 0;
          const len = Math.hypot(dx, dz) || 1;
          game.fx.push({
            type: "impact",
            x: ev.d.x,
            y: 1.0,
            z: ev.d.z,
            dirX: dx / len,
            dirZ: dz / len,
            kind: "dust",
            at: now,
          });
        } else if (ev.t === "MuzzleFlash") {
          const attacker = game.entities.get(ev.d.attacker);
          if (attacker) {
            const isLocal = ev.d.attacker === game.localEntityId;
            const muzzle = muzzlePosition(ev.d.attacker);
            const fx = muzzle?.x ?? attacker.x;
            const fy = muzzle?.y ?? 1.35;
            const fz = muzzle?.z ?? attacker.z;
            if (!isLocal) {
              // The local shooter already played its flash, projectile and
              // sfx on click; only remote shots spawn them from the server.
              void playSfx("sfx_shoot", 0.3);
              attacker.lastShotAt = now;
              game.fx.push({
                type: "flash",
                x: fx,
                y: fy,
                z: fz,
                yaw: Math.atan2(ev.d.tz - attacker.z, ev.d.tx - attacker.x),
                at: now,
              });
              game.fx.push({
                type: "tracer",
                fx,
                fy,
                fz,
                tx: ev.d.tx,
                ty: 1.25,
                tz: ev.d.tz,
                at: now,
              });
            }
          }
        } else if (ev.t === "EntityDied") {
          void playSfx("sfx_death", 0.4);
          const dead = game.entities.get(ev.d.id);
          if (dead) {
            game.fx.push({ type: "death", x: dead.x, y: dead.y + 1, z: dead.z, at: now });
            // Body shatters into red chunks (matching the hostile body color)
            // plus a shower of silver bits, regardless of who landed the kill.
            game.fx.push({
              type: "gib",
              x: dead.x,
              y: dead.y + 0.6,
              z: dead.z,
              color: RED_HEX,
              at: now,
            });
            game.fx.push({
              type: "coinBurst",
              x: dead.x,
              y: dead.y + 0.6,
              z: dead.z,
              count: 8,
              metal: "silver",
              at: now,
            });
          }
          // Player-attributed kill: reward it with a power-up chime and a
          // spray of gold coins over the corpse.
          const hitAt = recentLocalHits.get(ev.d.id);
          if (dead && hitAt !== undefined && now - hitAt < KILL_CREDIT_MS) {
            playPowerUp();
            game.fx.push({
              type: "coinBurst",
              x: dead.x,
              y: dead.y + 0.8,
              z: dead.z,
              count: 6,
              metal: "gold",
              at: now,
            });
          }
          recentLocalHits.delete(ev.d.id);
        } else if (ev.t === "Shockwave") {
          void playSfx("sfx_hit", 0.5);
          const source = game.entities.get(ev.d.source);
          if (source) {
            game.fx.push({ type: "shockwave", x: source.x, y: 0.1, z: source.z, at: now });
          }
        }
        if (game.fx.length > 64) game.fx.splice(0, game.fx.length - 64);
        break;
      }
      case "XpUpdate": {
        const prevLevel = useGame.getState().level;
        ui.set({
          xp: msg.d.xp,
          level: msg.d.level,
          nextLevelXp: msg.d.next_level_xp,
        });
        if (msg.d.gained > 0) {
          ui.pushChat({ from: "system", text: `+${msg.d.gained} XP`, system: true });
        }
        // Level-up: the marquee dopamine moment — fanfare, HUD banner, and a
        // coin burst raining over the local player.
        if (msg.d.level > prevLevel) {
          playLevelUp();
          ui.celebrateLevelUp(msg.d.level);
          ui.pushChat({
            from: "system",
            text: `LEVEL UP! You reached level ${msg.d.level}.`,
            system: true,
          });
          const me = game.entities.get(game.localEntityId);
          if (me) {
            game.fx.push({
              type: "coinBurst",
              x: me.x,
              y: me.y + 1.2,
              z: me.z,
              count: 10,
              at: performance.now(),
            });
          }
        }
        break;
      }
      case "WalletUpdate": {
        const prev = useGame.getState().wallet;
        ui.set({ wallet: msg.d });
        // Currency gains are loot too: surface them in the left pickup feed
        // alongside item pickups instead of the bottom-right wallet toasts
        // (skip the initial balance push right after joining).
        if (prev) {
          if (msg.d.wild > prev.wild) {
            ui.pushPickup({ kind: null, text: `+${msg.d.wild - prev.wild} WILD` });
          }
          if (msg.d.shards > prev.shards) {
            ui.pushPickup({ kind: null, text: `+${msg.d.shards - prev.shards} SHARDS` });
          }
          if (msg.d.energy > prev.energy) {
            ui.pushPickup({ kind: null, text: `+${msg.d.energy - prev.energy} ENERGY` });
          }
        }
        break;
      }
      case "AbilityUpdate": {
        const now = performance.now();
        const abilities = { ...useGame.getState().abilities };
        abilities[msg.d.ability] = {
          readyAt: now + msg.d.cooldown * 1000,
          cooldown: msg.d.cooldown,
          activeUntil: msg.d.active > 0 ? now + msg.d.active * 1000 : 0,
        };
        ui.set({ abilities });
        break;
      }
      case "Died": {
        ui.set({ extracting: null });
        ui.pushChat({
          from: "system",
          text: `You died${msg.d.by ? ` to ${msg.d.by}` : ""}.${msg.d.lost_items ? " Your carried items were dropped." : ""}`,
          system: true,
        });
        break;
      }
      case "ExtractStart": {
        ui.set({ extracting: { seconds: msg.d.seconds, startedAt: performance.now() } });
        break;
      }
      case "ExtractCancel": {
        ui.set({ extracting: null });
        ui.pushChat({ from: "system", text: "Extraction cancelled.", system: true });
        break;
      }
      case "ExtractResult": {
        ui.set({ extracting: null });
        if (msg.d.success) {
          void playSfx("sfx_pickup", 0.5);
          const total = msg.d.banked.reduce((n, s) => n + s.count, 0);
          ui.pushChat({
            from: "system",
            text: `Extraction successful. ${total} item(s) banked to your stash.`,
            system: true,
          });
        }
        break;
      }
      case "GatherResult": {
        if (msg.d.denied) {
          playDeny();
          ui.pushPickup({ kind: null, text: "Backpack full", alert: true });
        }
        if (msg.d.gained.length > 0) {
          // One cue per pickup, by item category: ammo gets a cartridge clack,
          // currency (Cash) the coin chime, and everything else (resources,
          // materials, gear) a soft item thunk.
          const cats = new Set(
            msg.d.gained.map((g) => ITEM_INFO[g.kind]?.category),
          );
          if (cats.has("ammo")) {
            playAmmo();
          } else if (cats.has("currency")) {
            playCoin();
          } else {
            playPickup();
          }
        }
        for (const g of msg.d.gained) {
          ui.pushPickup({ kind: g.kind, text: `+${g.count} ${itemLabel(g.kind)}` });
          ui.pushChat({
            from: "system",
            text: `+${g.count} ${itemLabel(g.kind)}`,
            system: true,
          });
        }
        break;
      }
      case "CraftResult": {
        if (msg.d.ok && msg.d.produced) {
          void playSfx("sfx_pickup", 0.5);
          ui.pushChat({
            from: "system",
            text: `Crafted ${msg.d.produced.count}x ${msg.d.produced.kind}.`,
            system: true,
          });
        } else if (!msg.d.ok) {
          ui.pushChat({
            from: "system",
            text: `Craft failed: ${msg.d.error ?? "unknown error"}`,
            system: true,
          });
        }
        break;
      }
      case "ProductionState": {
        const production = { ...useGame.getState().production };
        if (msg.d.jobs.length > 0) {
          production[msg.d.building] = { jobs: msg.d.jobs, at: performance.now() };
        } else {
          delete production[msg.d.building];
        }
        ui.set({ production });
        break;
      }
      case "MarketState": {
        const prevWallet = useGame.getState().market?.wallet;
        ui.set({ market: { listings: msg.d.listings, wallet: msg.d.wallet } });
        if (prevWallet !== undefined && msg.d.wallet > prevWallet) {
          playCoin();
          ui.pushWalletToast(`+${msg.d.wallet - prevWallet} WILD`);
        }
        break;
      }
      case "MarketResult": {
        if (msg.d.ok) {
          playPurchase();
        } else {
          ui.pushChat({
            from: "system",
            text: `Market: ${msg.d.error ?? "action failed"}`,
            system: true,
          });
        }
        break;
      }
      case "VendorState": {
        const prevWallet = useGame.getState().vendor?.wallet;
        ui.set({
          vendor: {
            id: msg.d.vendor,
            kind: msg.d.kind,
            offers: msg.d.offers,
            wallet: msg.d.wallet,
          },
        });
        if (prevWallet !== undefined && msg.d.wallet > prevWallet) {
          playCoin();
          ui.pushWalletToast(`+${msg.d.wallet - prevWallet} WILD`);
        }
        break;
      }
      case "VendorResult": {
        if (msg.d.ok) {
          playPurchase();
        } else {
          ui.pushChat({
            from: "system",
            text: `Vendor: ${msg.d.error ?? "action failed"}`,
            system: true,
          });
        }
        break;
      }
      case "PoiList": {
        ui.set({ pois: msg.d.pois, zones: msg.d.zones });
        break;
      }
      case "TerritoryState": {
        setTerritory(msg.d.cells);
        break;
      }
      case "BlueprintsUpdate": {
        ui.set({ blueprints: msg.d.known });
        break;
      }
      case "EconomyState": {
        // Full snapshot on subscribe; server sends the ring oldest-first.
        ui.set({
          economy: { stats: msg.d.stats, feed: [...msg.d.recent].reverse() },
        });
        break;
      }
      case "EconomyTxs": {
        const cur = useGame.getState().economy;
        const feed = [...msg.d.txs].reverse().concat(cur?.feed ?? []).slice(0, 300);
        ui.set({ economy: { stats: msg.d.stats, feed } });
        break;
      }
      case "Error": {
        ui.pushChat({ from: "system", text: msg.d.message, system: true });
        break;
      }
      case "Ping": {
        this.send({ t: "Pong", d: { nonce: msg.d.nonce } });
        break;
      }
      default:
        break;
    }
  }

  private reconcile(serverX: number, serverZ: number, lastSeq: number) {
    game.pendingInputs = game.pendingInputs.filter((i) => i.seq > lastSeq);
    // Replay unacknowledged inputs on top of the authoritative position.
    let x = serverX;
    let z = serverZ;
    for (const input of game.pendingInputs) {
      const [nx, nz] = stepMoveSpeed(
        game.chunks,
        x,
        z,
        input.dx,
        input.dz,
        input.speed,
        input.dt,
      );
      x = nx;
      z = nz;
    }
    // Snap softly: only correct if we diverged noticeably.
    const err = Math.hypot(game.predicted.x - x, game.predicted.z - z);
    if (err > 0.05) {
      if (err > 2.0) {
        game.predicted.x = x;
        game.predicted.z = z;
      } else {
        game.predicted.x += (x - game.predicted.x) * 0.3;
        game.predicted.z += (z - game.predicted.z) * 0.3;
      }
    }
  }
}

import { stepMoveSpeed } from "../game/collision";
