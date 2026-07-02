// Headless end-to-end driver for the Wilder gateway (dev only).
// Usage: node tools/e2e.mjs <scenario>
// Requires the gateway running with WILDER_DEV=1 on localhost:8080.
// Node >= 22 (global fetch + WebSocket).

const BASE = "http://localhost:8080";

function log(...args) {
  console.log(new Date().toISOString().slice(11, 23), ...args);
}

class Client {
  constructor() {
    this.entities = new Map(); // id -> {kind, name, variant, x, z, healthPct}
    this.inventory = null;
    this.stash = null;
    this.entityId = 0;
    this.pos = [0, 0, 0];
    this.health = 100;
    this.seq = 1;
    this.events = []; // recorded interesting messages
    this.waiters = [];
  }

  async login() {
    const res = await fetch(`${BASE}/dev/login`, { method: "POST" });
    if (!res.ok) throw new Error(`dev login failed: ${res.status}`);
    const { token } = await res.json();
    this.token = token;
    const headers = { authorization: `Bearer ${token}` };
    let chars = await (await fetch(`${BASE}/api/characters`, { headers })).json();
    // Use a dedicated character so a browser session on "Dev" doesn't conflict.
    let me = chars.find((c) => c.name === "E2E");
    if (!me) {
      const res = await fetch(`${BASE}/api/characters`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ name: "E2E" }),
      });
      if (!res.ok) throw new Error("character create failed");
      me = await res.json();
    }
    this.characterId = me.id;
    log("logged in, character", me.name, this.characterId);
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:8080/ws`);
      this.ws = ws;
      ws.onopen = () => {
        this.send({ t: "Authenticate", d: { token: this.token } });
      };
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        this.handle(msg);
        if (msg.t === "WorldJoined") resolve();
      };
      ws.onerror = (e) => reject(new Error("ws error"));
      ws.onclose = () => log("ws closed");
      setTimeout(() => reject(new Error("join timeout")), 8000);
    });
  }

  send(msg) {
    this.ws.send(JSON.stringify(msg));
  }

  handle(msg) {
    switch (msg.t) {
      case "AuthResult":
        if (msg.d.ok) {
          this.send({ t: "JoinWorld", d: { character_id: this.characterId } });
        } else {
          throw new Error("auth failed: " + msg.d.error);
        }
        break;
      case "WorldJoined":
        this.entityId = msg.d.entity_id;
        this.pos = msg.d.character.position;
        this.health = msg.d.character.health;
        this.inventory = msg.d.inventory;
        log("joined as entity", this.entityId, "at", this.pos);
        break;
      case "EntitySpawn":
        this.entities.set(msg.d.id, {
          id: msg.d.id,
          kind: msg.d.kind,
          name: msg.d.name,
          variant: msg.d.variant,
          x: msg.d.position[0],
          z: msg.d.position[2],
          healthPct: msg.d.health_pct,
        });
        break;
      case "EntityDespawn":
        this.entities.delete(msg.d.id);
        break;
      case "Snapshot":
        for (const s of msg.d.entities) {
          const e = this.entities.get(s.id);
          if (e) {
            e.x = s.position[0];
            e.z = s.position[2];
            e.healthPct = s.health_pct;
            e.anim = s.anim;
          }
          if (s.id === this.entityId) {
            this.pos = s.position;
            this.health = s.health_pct * 100;
          }
        }
        break;
      case "InventoryUpdate":
        this.inventory = msg.d;
        break;
      case "StashUpdate":
        this.stash = msg.d.slots;
        this.events.push(msg);
        break;
      case "Ping":
        this.send({ t: "Pong", d: { nonce: msg.d.nonce } });
        break;
      case "ChunkData":
      case "ChunkUnload":
        break;
      case "CombatEvent":
        this.events.push(msg);
        if (this.logCombat) log("<< CombatEvent", JSON.stringify(msg.d));
        break;
      default:
        this.events.push(msg);
        if (
          [
            "ExtractStart",
            "ExtractCancel",
            "ExtractResult",
            "Died",
            "Error",
            "Chat",
            "CraftResult",
            "GatherResult",
            "ProductionState",
            "MarketState",
            "MarketResult",
            "BlueprintsUpdate",
          ].includes(msg.t)
        ) {
          log("<<", msg.t, JSON.stringify(msg.d ?? {}).slice(0, 220));
        }
        break;
    }
    for (const w of [...this.waiters]) {
      if (w.pred(msg)) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        w.resolve(msg);
      }
    }
  }

  waitFor(pred, timeoutMs = 10000, label = "message") {
    return new Promise((resolve, reject) => {
      const w = { pred, resolve };
      this.waiters.push(w);
      setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) {
          this.waiters.splice(i, 1);
          reject(new Error(`timeout waiting for ${label}`));
        }
      }, timeoutMs);
    });
  }

  chat(text) {
    this.send({ t: "Chat", d: { text } });
  }

  tp(x, z) {
    this.chat(`/tp ${x} ${z}`);
  }

  attack(tx, tz) {
    this.send({ t: "Attack", d: { seq: this.seq++, tx, tz } });
  }

  interact(id) {
    this.send({ t: "Interact", d: { entity_id: id } });
  }

  invCount(kind) {
    return (this.inventory?.slots ?? [])
      .filter((s) => s && s.kind === kind)
      .reduce((n, s) => n + s.count, 0);
  }

  stashCount(kind) {
    return (this.stash ?? [])
      .filter((s) => s && s.kind === kind)
      .reduce((n, s) => n + s.count, 0);
  }

  findEntities(kind) {
    return [...this.entities.values()].filter((e) => e.kind === kind);
  }

  slotOf(kind) {
    return (this.inventory?.slots ?? []).findIndex((s) => s && s.kind === kind);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function scenarioExtraction() {
  const c = new Client();
  await c.login();
  await c.connect();
  await sleep(600);

  // 1. Gear up.
  c.chat("/give pistol");
  c.chat("/give ammo 90");
  await sleep(400);
  const pistolSlot = c.slotOf("Pistol");
  if (pistolSlot < 0) throw new Error("no pistol after /give");
  c.send({ t: "InventoryAction", d: { t: "Equip", d: { slot: pistolSlot } } });
  await sleep(300);
  if (c.inventory.equipped_weapon !== "Pistol") throw new Error("pistol not equipped");
  log("PASS gear: pistol equipped, ammo", c.invCount("Ammo9mm"));

  // 2. Find a hostile chunk with an extraction point by hopping chunk centers.
  let extraction = null;
  outer: for (let cx = 3; cx < 12; cx++) {
    for (let cz = 3; cz < 12; cz++) {
      c.tp(cx * 32 + 8, cz * 32 + 8);
      await sleep(700);
      const points = c.findEntities("ExtractionPoint");
      if (points.length) {
        extraction = points[0];
        log("found extraction point", extraction.id, "at", extraction.x.toFixed(1), extraction.z.toFixed(1));
        break outer;
      }
    }
  }
  if (!extraction) throw new Error("no extraction point found");

  // 3. Kill an NPC.
  let npcs = c.findEntities("Npc");
  log("NPCs in view:", npcs.length);
  if (!npcs.length) throw new Error("no NPCs near extraction chunk");
  const npc = npcs.reduce((a, b) =>
    Math.hypot(a.x - c.pos[0], a.z - c.pos[2]) < Math.hypot(b.x - c.pos[0], b.z - c.pos[2]) ? a : b,
  );
  log("attacking NPC", npc.id, npc.name);
  c.logCombat = true;
  let killed = false;
  for (let i = 0; i < 40; i++) {
    const target = c.entities.get(npc.id);
    if (!target) {
      killed = true; // despawned = died
      break;
    }
    if (target.healthPct <= 0 || target.anim === "Death") {
      killed = true;
      break;
    }
    // Stand exactly on the NPC's tile (guaranteed walkable) and shoot point-blank.
    c.tp(target.x, target.z);
    c.attack(target.x + 0.1, target.z);
    c.chat("/heal");
    await sleep(700);
  }
  c.logCombat = false;
  if (!killed) throw new Error("failed to kill NPC");
  log("PASS combat: NPC killed");

  // 4. Loot its container.
  await sleep(600);
  const loots = c.findEntities("LootContainer");
  if (!loots.length) throw new Error("no loot container after kill");
  const loot = loots.reduce((a, b) =>
    Math.hypot(a.x - c.pos[0], a.z - c.pos[2]) < Math.hypot(b.x - c.pos[0], b.z - c.pos[2]) ? a : b,
  );
  const beforeSlots = JSON.stringify(c.inventory.slots);
  c.tp(loot.x, loot.z);
  await sleep(400);
  c.interact(loot.id);
  await c.waitFor((m) => m.t === "InventoryUpdate" || m.t === "GatherResult", 4000, "loot result");
  await sleep(300);
  if (JSON.stringify(c.inventory.slots) === beforeSlots) throw new Error("inventory unchanged after loot");
  log("PASS loot: inventory changed after looting container");

  // 5. Extract.
  c.tp(extraction.x + 1, extraction.z);
  await sleep(600);
  c.interact(extraction.id);
  await c.waitFor((m) => m.t === "ExtractStart", 4000, "ExtractStart");
  log("extraction channeling for 5s (standing still)...");
  const result = await c.waitFor(
    (m) => m.t === "ExtractResult" || m.t === "ExtractCancel",
    9000,
    "ExtractResult",
  );
  if (result.t !== "ExtractResult" || !result.d.success) {
    throw new Error("extraction did not complete: " + JSON.stringify(result));
  }
  const banked = result.d.banked.reduce((n, s) => n + s.count, 0);
  await sleep(500);
  const carried = c.inventory.slots.filter(Boolean).length;
  log(
    `PASS extraction: banked ${banked} items, carried slots now ${carried}, position`,
    c.pos.map((v) => v.toFixed(1)).join(","),
  );
  const [px, , pz] = c.pos;
  if (Math.abs(px - 3) > 2 || Math.abs(pz - 3) > 2) throw new Error("not teleported to hub spawn");
  if (!c.stash || !c.stash.some(Boolean)) throw new Error("stash empty after extraction");
  log("PASS stash: stash has items after extraction");

  // 6. Death drop: gear up again, get killed, verify items dropped.
  c.chat("/give iron 5");
  await sleep(300);
  const ironBefore = c.invCount("Iron");
  if (ironBefore < 5) throw new Error("no iron given");
  // TP into hostile zone next to an NPC and wait to be killed (unequip armor first).
  const npcs2 = c.findEntities("Npc");
  // move to a fresh hostile chunk to find NPCs
  c.tp(3 * 32 + 8, 3 * 32 + 8);
  await sleep(800);
  const hostiles = c.findEntities("Npc");
  if (!hostiles.length) throw new Error("no NPCs for death test");
  const killer = hostiles[0];
  c.tp(killer.x + 0.5, killer.z + 0.5);
  const died = await c.waitFor((m) => m.t === "Died", 30000, "Died");
  if (!died.d.lost_items) throw new Error("death did not drop items");
  await sleep(400);
  if (c.invCount("Iron") !== 0) throw new Error("iron still carried after death");
  log("PASS death: died and dropped carried items, respawned at", c.pos.map((v) => v.toFixed(1)).join(","));

  log("ALL PHASE 1 CHECKS PASSED");
  c.ws.close();
}

async function scenarioEconomy() {
  const c = new Client();
  await c.login();
  await c.connect();
  await sleep(600);

  // 1. Find a resource node in hostile chunks.
  let node = null;
  outer: for (let cx = 2; cx < 10; cx++) {
    for (let cz = 2; cz < 10; cz++) {
      c.tp(cx * 32 + 8, cz * 32 + 8);
      await sleep(600);
      const nodes = c.findEntities("ResourceNode");
      if (nodes.length) {
        node = nodes[0];
        break outer;
      }
    }
  }
  if (!node) throw new Error("no resource node found");
  log("found node", node.id, node.name, "at", node.x.toFixed(1), node.z.toFixed(1));

  // 2. Gather it to depletion (5 charges, 1.2s cooldown).
  c.tp(node.x + 1, node.z);
  await sleep(500);
  let gained = 0;
  for (let i = 0; i < 8; i++) {
    c.interact(node.id);
    try {
      const res = await c.waitFor((m) => m.t === "GatherResult", 2500, "GatherResult");
      if (res.d.gained) gained += res.d.gained.count;
    } catch {
      break; // depleted (no more responses)
    }
    await sleep(1400);
    if (!c.entities.has(node.id)) break; // despawned = depleted
  }
  if (gained < 4) throw new Error(`gathered too little: ${gained}`);
  const depleted = !c.entities.has(node.id);
  log(`PASS gather: ${gained} units gathered, node depleted=${depleted}`);
  if (!depleted) throw new Error("node did not deplete after 5+ gathers");

  // 3. Refine iron -> steel plates at the hub refinery.
  c.chat("/give iron 16");
  await sleep(300);
  c.tp(15, 4); // refinery at (15,3)
  await sleep(600);
  // Wrong-station check: pipe (factory recipe) at refinery must fail.
  c.send({ t: "Craft", d: { recipe: "pipe", station: null } });
  const bad = await c.waitFor((m) => m.t === "CraftResult", 4000, "CraftResult");
  if (bad.d.ok) throw new Error("factory recipe crafted at refinery!");
  log("PASS station gating:", bad.d.error);
  for (let i = 0; i < 4; i++) {
    c.send({ t: "Craft", d: { recipe: "steel_plate", station: null } });
    const r = await c.waitFor((m) => m.t === "CraftResult", 4000, "CraftResult");
    if (!r.d.ok) throw new Error("steel_plate craft failed: " + r.d.error);
  }
  if (c.invCount("SteelPlate") < 4) throw new Error("missing steel plates");
  log("PASS refine: 4x SteelPlate from 16 iron");

  // 4. Craft + equip a pipe at the factory.
  c.tp(21, 4); // factory at (21,3)
  await sleep(600);
  c.send({ t: "Craft", d: { recipe: "pipe", station: null } });
  const made = await c.waitFor((m) => m.t === "CraftResult", 4000, "CraftResult");
  if (!made.d.ok) throw new Error("pipe craft failed: " + made.d.error);
  await sleep(300);
  const pipeSlot = c.slotOf("Pipe");
  if (pipeSlot < 0) throw new Error("no pipe in inventory");
  c.send({ t: "InventoryAction", d: { t: "Equip", d: { slot: pipeSlot } } });
  await sleep(300);
  if (c.inventory.equipped_weapon !== "Pipe") throw new Error("pipe not equipped");
  log("PASS factory: pipe crafted and equipped");

  log("ALL PHASE 2 CHECKS PASSED");
  c.ws.close();
}

const scenario = process.argv[2] ?? "extraction";
const scenarios = { extraction: scenarioExtraction, economy: scenarioEconomy };
if (!scenarios[scenario]) {
  console.error("unknown scenario", scenario);
  process.exit(1);
}
scenarios[scenario]().then(
  () => process.exit(0),
  (e) => {
    console.error("FAILED:", e.message);
    process.exit(1);
  },
);
