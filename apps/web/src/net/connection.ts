// WebSocket game connection: handshake, message dispatch, input sending.

import { game, spawnEntity, useGame } from "../state/game";
import { C2S, decode, encode, S2C } from "./protocol";

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
        game.entities.delete(msg.d.id);
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
          }
        }
        break;
      }
      case "InventoryUpdate": {
        ui.set({ inventory: msg.d });
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
      const [nx, nz] = stepReplay(x, z, input.dx, input.dz, input.run, input.dt);
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

import { stepMove } from "../game/collision";

function stepReplay(
  x: number,
  z: number,
  dx: number,
  dz: number,
  run: boolean,
  dt: number,
): [number, number] {
  return stepMove(game.chunks, x, z, dx, dz, run, dt);
}
