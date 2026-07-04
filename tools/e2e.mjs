// Headless end-to-end driver for the Wilder gateway (dev only).
// Usage: node tools/e2e.mjs <scenario>
// Requires the gateway running with WILDER_DEV=1 on localhost:8080.
// Node >= 22 (global fetch + WebSocket).

const PORT = process.env.E2E_PORT ?? "8080";
const BASE = `http://localhost:${PORT}`;

function log(...args) {
  console.log(new Date().toISOString().slice(11, 23), ...args);
}

// Hot messages (Snapshot, MapIntel, ...) ship as binary frames; mirror the
// Snapshot layout from shared/wilder-protocol (everything else is ignorable
// map intel here). Positions are cm i32, yaw centirad i16, health/shield u8.
const ANIMS = ["Idle", "Walk", "Run", "Attack", "Hit", "Death", "Gather", "Roll", "Crouch", "CrouchWalk"];
function decodeBinary(buf) {
  const dv = new DataView(buf);
  if (dv.getUint8(0) !== 1) return null; // 1 = Snapshot; the rest is map intel
  let o = 1;
  const server_tick = Number(dv.getBigUint64(o, true));
  o += 8;
  const last_input_seq = dv.getUint32(o, true);
  o += 4;
  const n = dv.getUint32(o, true);
  o += 4;
  const entities = [];
  for (let i = 0; i < n; i++) {
    const id = Number(dv.getBigUint64(o, true));
    o += 8;
    const x = dv.getInt32(o, true) / 100;
    const y = dv.getInt32(o + 4, true) / 100;
    const z = dv.getInt32(o + 8, true) / 100;
    o += 12;
    o += 2; // yaw (unused here)
    const anim = ANIMS[dv.getUint8(o)] ?? "Idle";
    const health_pct = dv.getUint8(o + 1) / 255;
    const shield_pct = dv.getUint8(o + 2) / 255;
    o += 3;
    entities.push({ id, position: [x, y, z], anim, health_pct, shield_pct });
  }
  return { t: "Snapshot", d: { server_tick, last_input_seq, entities } };
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
    return this.loginAs("E2E");
  }

  /** Register-or-login a dedicated account (own wallet/character limit). */
  async loginAccount(username, name) {
    const creds = { username, password: "e2e-password-1" };
    let res = await fetch(`${BASE}/api/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(creds),
    });
    if (!res.ok) {
      res = await fetch(`${BASE}/api/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(creds),
      });
    }
    if (!res.ok) throw new Error(`login ${username} failed: ${res.status}`);
    const { token } = await res.json();
    this.token = token;
    await this.pickCharacter(name);
  }

  async loginAs(name) {
    const res = await fetch(`${BASE}/dev/login`, { method: "POST" });
    if (!res.ok) throw new Error(`dev login failed: ${res.status}`);
    const { token } = await res.json();
    this.token = token;
    await this.pickCharacter(name);
  }

  async pickCharacter(name) {
    const token = this.token;
    const headers = { authorization: `Bearer ${token}` };
    let chars = await (await fetch(`${BASE}/api/characters`, { headers })).json();
    // Use a dedicated character so a browser session on "Dev" doesn't conflict.
    let me = chars.find((c) => c.name === name);
    if (!me) {
      const res = await fetch(`${BASE}/api/characters`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw new Error("character create failed");
      me = await res.json();
    }
    this.characterId = me.id;
    log("logged in, character", me.name, this.characterId);
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
      ws.binaryType = "arraybuffer";
      this.ws = ws;
      ws.onopen = () => {
        this.send({ t: "Authenticate", d: { token: this.token } });
      };
      ws.onmessage = (ev) => {
        // Hot messages (Snapshot, map intel) arrive as binary frames;
        // everything else is JSON text.
        const msg =
          typeof ev.data === "string" ? JSON.parse(ev.data) : decodeBinary(ev.data);
        if (!msg) return;
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
      case "WalletUpdate":
        this.wallet = msg.d; // { wild, bank, shards, bank_shards, energy, bank_energy }
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
            "StashUpdate",
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

  // 2. Find a hostile chunk with Wape agents (the retired Npc system is now
  // the FACTION_WAPES agent pool) by hopping chunk centers.
  const hostileWapes = (cl) => cl.findEntities("Agent").filter((e) => e.name?.startsWith("WAPE-"));
  let npcs = [];
  outer: for (let cx = 3; cx < 12; cx++) {
    for (let cz = 3; cz < 12; cz++) {
      c.tp(cx * 32 + 8, cz * 32 + 8);
      await sleep(700);
      npcs = hostileWapes(c);
      if (npcs.length) {
        log("found", npcs.length, "Wapes at chunk", cx, cz);
        break outer;
      }
    }
  }
  if (!npcs.length) throw new Error("no Wapes found in hostile chunks");

  // 3. Kill a Wape.
  log("Wapes in view:", npcs.length);
  const npc = npcs.reduce((a, b) =>
    Math.hypot(a.x - c.pos[0], a.z - c.pos[2]) < Math.hypot(b.x - c.pos[0], b.z - c.pos[2]) ? a : b,
  );
  log("attacking Wape", npc.id, npc.name);
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
  if (!killed) throw new Error("failed to kill Wape");
  log("PASS combat: Wape killed");

  // 4. Loot its container (walking within range auto-picks it up; the
  // explicit interact is only a fallback for a stubborn container).
  await sleep(600);
  const loots = c.findEntities("LootContainer");
  if (!loots.length) throw new Error("no loot container after kill");
  const loot = loots.reduce((a, b) =>
    Math.hypot(a.x - c.pos[0], a.z - c.pos[2]) < Math.hypot(b.x - c.pos[0], b.z - c.pos[2]) ? a : b,
  );
  const beforeSlots = JSON.stringify(c.inventory.slots);
  c.tp(loot.x, loot.z);
  await sleep(600);
  if (c.entities.has(loot.id)) {
    c.interact(loot.id);
    await c.waitFor((m) => m.t === "InventoryUpdate" || m.t === "GatherResult", 4000, "loot result");
  }
  await sleep(300);
  if (JSON.stringify(c.inventory.slots) === beforeSlots) throw new Error("inventory unchanged after loot");
  log("PASS loot: inventory changed after looting container");

  // 5. Extract by putting loot into storage: find a stash terminal (Building),
  // stand next to it, then deposit every carried slot.
  let stash = null;
  outer2: for (const [sx, sz] of [
    [0, 0], [0, 1], [1, 0], [1, 1],
    [-1, 0], [0, -1], [-1, -1], [1, -1], [-1, 1],
  ]) {
    c.tp(sx * 32 + 16, sz * 32 + 16);
    await sleep(600);
    const buildings = c.findEntities("Building");
    if (buildings.length) {
      stash = buildings[0];
      log("found stash terminal", stash.id, "at", stash.x.toFixed(1), stash.z.toFixed(1));
      break outer2;
    }
  }
  if (!stash) throw new Error("no stash terminal found");

  c.tp(stash.x + 1, stash.z);
  await sleep(500);
  c.interact(stash.id);
  await c.waitFor((m) => m.t === "StashUpdate", 4000, "StashUpdate");
  const carriedBefore = c.inventory.slots.filter(Boolean).length;
  for (let i = 0; i < c.inventory.slots.length; i++) {
    if (c.inventory.slots[i]) {
      c.send({ t: "InventoryAction", d: { t: "Deposit", d: { slot: i } } });
      await sleep(150);
    }
  }
  await sleep(500);
  const carried = c.inventory.slots.filter(Boolean).length;
  if (!c.stash || !c.stash.some(Boolean)) throw new Error("stash empty after deposit");
  if (carried >= carriedBefore) throw new Error("backpack not reduced after deposit");
  log(`PASS storage: deposited loot to stash, carried slots ${carriedBefore} -> ${carried}`);

  // 6. Death drop: gear up again, get killed, verify items dropped.
  c.chat("/give iron 5");
  await sleep(300);
  const ironBefore = c.invCount("Iron");
  if (ironBefore < 5) throw new Error("no iron given");
  // TP into a hostile zone next to a Wape and wait to be killed.
  let hostiles = [];
  outer3: for (let cx = 3; cx < 12; cx++) {
    for (let cz = 3; cz < 12; cz++) {
      c.tp(cx * 32 + 8, cz * 32 + 8);
      await sleep(700);
      hostiles = hostileWapes(c);
      if (hostiles.length) break outer3;
    }
  }
  if (!hostiles.length) throw new Error("no Wapes for death test");
  const killer = hostiles[0];
  // Wape agents retaliate rather than blind-aggro: poke the target once in a
  // while (never enough to kill) and stand still until it finishes us off.
  const diedP = c.waitFor((m) => m.t === "Died", 60000, "Died");
  const poke = setInterval(() => {
    const t = c.entities.get(killer.id);
    if (t && c.health > 0) {
      c.tp(t.x + 0.5, t.z + 0.5);
      if (t.healthPct > 0.6) c.attack(t.x, t.z);
    }
  }, 1500);
  const died = await diedP.finally(() => clearInterval(poke));
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

  // 2. Gather from it (5 charges, 1.2 s cooldown — shared with the agent
  // population now, so another gatherer may drain or cooldown-lock the node
  // under us; we only require real yield, not sole ownership).
  c.tp(node.x + 1, node.z);
  await sleep(500);
  let gained = 0;
  for (let i = 0; i < 10 && gained < 4; i++) {
    c.interact(node.id);
    try {
      const res = await c.waitFor((m) => m.t === "GatherResult", 2000, "GatherResult");
      for (const s of res.d.gained ?? []) gained += s.count;
    } catch {
      // silent pull (cooling/contested); keep trying
    }
    await sleep(1300);
    if (!c.entities.has(node.id)) break; // despawned = depleted
  }
  if (gained < 4) throw new Error(`gathered too little: ${gained}`);
  log(`PASS gather: ${gained} units gathered from the node`);

  // 3. Queue timed production at the hub Refinery. Instant crafting is gone:
  // production runs through building queues, charging inputs AND Energy
  // up-front, with output landing in a per-owner buffer.
  c.chat("/give iron 16");
  c.chat("/give energy 10");
  await sleep(400);
  c.tp(15, 4); // hub refinery at (15,3)
  await sleep(800);
  const refinery = c.findEntities("Refinery")[0];
  if (!refinery) throw new Error("no refinery in view at the hub");
  c.tp(refinery.x + 1, refinery.z);
  await sleep(500);

  // Wrong-station check: a Factory recipe queued at the Refinery must fail.
  c.send({ t: "QueueProduction", d: { building: refinery.id, recipe: "pipe", count: 1 } });
  const bad = await c.waitFor((m) => m.t === "CraftResult", 4000, "station gating");
  if (bad.d.ok || !/Factory/i.test(bad.d.error ?? "")) {
    throw new Error("factory recipe not station-gated: " + JSON.stringify(bad.d));
  }
  log("PASS station gating:", bad.d.error);

  // Research gating: an unresearched blueprint can't be queued. (The dev
  // character persists across runs — tolerate a previously researched one.)
  c.send({ t: "QueueProduction", d: { building: refinery.id, recipe: "polymer", count: 1 } });
  const gate = await c.waitFor((m) => m.t === "CraftResult", 4000, "blueprint gating");
  if (!gate.d.ok && /blueprint/i.test(gate.d.error ?? "")) {
    log("PASS blueprint gating:", gate.d.error);
  } else if (!gate.d.ok) {
    // Known blueprint but missing inputs — still proves the queue path.
    log("NOTE polymer known on this character; queue denied on inputs:", gate.d.error);
  } else {
    log("NOTE polymer already researched AND queued (persisted character)");
  }

  // Queue 3x steel_plate: 12 iron + 3 Energy charged up-front.
  const ironBefore = c.invCount("Iron");
  const steelBefore = c.invCount("SteelPlate");
  const energyBefore = c.wallet?.energy ?? 0;
  c.send({ t: "QueueProduction", d: { building: refinery.id, recipe: "steel_plate", count: 3 } });
  const ps = await c.waitFor(
    (m) => m.t === "ProductionState" && m.d.jobs.some((j) => j.mine && j.recipe === "steel_plate"),
    4000,
    "ProductionState",
  );
  const job = ps.d.jobs.find((j) => j.mine && j.recipe === "steel_plate");
  if (job.count !== 3) throw new Error("bad job state: " + JSON.stringify(ps.d));
  if (!ps.d.energy_cap) throw new Error("ProductionState missing building energy cap");
  await sleep(600);
  if (c.invCount("Iron") !== ironBefore - 12) throw new Error("inputs not consumed on queue");
  if ((c.wallet?.energy ?? 0) !== energyBefore - 3) {
    throw new Error(`energy not charged: ${energyBefore} -> ${c.wallet?.energy}`);
  }
  log(`PASS queue: 3x steel_plate queued (cap ${ps.d.energy_cap}), 12 iron + 3 Energy charged`);

  // 4. Wait for the batch (3 x 4s + slack); standing within 5 m auto-collects
  // the output buffer into the backpack.
  await c.waitFor(
    (m) =>
      m.t === "ProductionState" &&
      m.d.building === refinery.id &&
      !m.d.jobs.some((j) => j.mine),
    25000,
    "queue drained",
  );
  await sleep(1000);
  const gainedSteel = c.invCount("SteelPlate") - steelBefore;
  if (gainedSteel !== 3) throw new Error(`expected 3 steel plates collected, got ${gainedSteel}`);
  log("PASS collect: queue drained, 3x SteelPlate auto-collected from the output buffer");

  log("ALL ECONOMY CHECKS PASSED");
  c.ws.close();
}

async function scenarioManufacturing() {
  const c = new Client();
  await c.login();
  const bp = c.waitFor((m) => m.t === "BlueprintsUpdate", 8000, "BlueprintsUpdate on join");
  await c.connect();
  const known = (await bp).d.known;
  if (!known.includes("steel_plate") || !known.includes("knife")) {
    throw new Error("default blueprints missing: " + JSON.stringify(known));
  }
  if (known.includes("polymer") && known.includes("pistol")) {
    log("NOTE: advanced blueprints already researched on this character (persisted)");
  }
  log("PASS blueprints: defaults known on join:", known.sort().join(","));
  await sleep(600);

  // Stock up (Energy fuels research and every queued job now).
  c.chat("/give fragment 8");
  c.chat("/give electronics 20");
  c.chat("/give chemicals 30");
  c.chat("/give iron 40");
  c.chat("/give biomass 10");
  c.chat("/give energy 40");
  await sleep(500);

  // 1. Unknown-recipe rejection: queue an unresearched advanced recipe.
  const factory = c.findEntities("Factory")[0];
  const refinery = c.findEntities("Refinery")[0];
  const lab = c.findEntities("Laboratory")[0];
  const market = c.findEntities("MarketTerminal")[0];
  if (!factory || !refinery || !lab || !market) {
    throw new Error("hub stations missing: " + JSON.stringify([factory, refinery, lab, market]));
  }
  log("hub stations:", `factory=${factory.id} refinery=${refinery.id} lab=${lab.id} market=${market.id}`);

  if (!known.includes("polymer")) {
    c.tp(refinery.x + 1, refinery.z);
    await sleep(500);
    c.send({ t: "QueueProduction", d: { building: refinery.id, recipe: "polymer", count: 1 } });
    const rej = await c.waitFor((m) => m.t === "CraftResult", 4000, "queue rejection");
    if (rej.d.ok || !/blueprint/.test(rej.d.error ?? "")) {
      throw new Error("unresearched recipe was not rejected: " + JSON.stringify(rej.d));
    }
    log("PASS blueprint gating: queue rejected:", rej.d.error);

    // 2. Research polymer at the Laboratory (2 fragments + 5 electronics + 5 chemicals).
    c.tp(lab.x + 1, lab.z);
    await sleep(500);
    const fragsBefore = c.invCount("BlueprintFragment");
    const resP = c.waitFor((m) => m.t === "CraftResult", 4000, "research result");
    const updP = c.waitFor((m) => m.t === "BlueprintsUpdate", 4000, "BlueprintsUpdate");
    c.send({ t: "Craft", d: { recipe: "research_polymer", station: lab.id } });
    const res = await resP;
    if (!res.d.ok) throw new Error("research failed: " + res.d.error);
    const upd = await updP;
    if (!upd.d.known.includes("polymer")) throw new Error("polymer not in known blueprints");
    await sleep(300);
    if (c.invCount("BlueprintFragment") !== fragsBefore - 2) {
      throw new Error("fragments not consumed by research");
    }
    log("PASS research: polymer blueprint unlocked at the lab, fragments consumed");
  } else {
    log("SKIP research (polymer already known); researching another if available");
  }

  // 3. Queue timed production at the refinery: 3x steel_plate (4s each, 4 iron each).
  c.tp(refinery.x + 1, refinery.z);
  await sleep(500);
  const ironBefore = c.invCount("Iron");
  const steelBefore = c.invCount("SteelPlate");
  c.send({ t: "QueueProduction", d: { building: refinery.id, recipe: "steel_plate", count: 3 } });
  const ps = await c.waitFor((m) => m.t === "ProductionState", 4000, "ProductionState");
  const job = ps.d.jobs[0];
  if (!job || job.recipe !== "steel_plate" || job.count !== 3) {
    throw new Error("bad production state: " + JSON.stringify(ps.d));
  }
  await sleep(300);
  if (c.invCount("Iron") !== ironBefore - 12) throw new Error("inputs not consumed on queue");
  // The initial reply may predate the first sim tick; wait for power-on.
  const poweredOn = [...c.events].some(
    (m) => m.t === "ProductionState" && m.d.jobs.some((j) => j.powered),
  )
    ? true
    : (
        await c.waitFor(
          (m) => m.t === "ProductionState" && m.d.jobs.some((j) => j.powered),
          4000,
          "job powered",
        )
      ).d.jobs[0].powered;
  if (!poweredOn) throw new Error("solo job should be powered");
  log("PASS queue: 3x steel_plate queued, 12 iron consumed up-front, job powered");

  // Wait for all three units (12s + slack), watching progress ticks.
  const doneState = await c.waitFor(
    (m) => m.t === "ProductionState" && m.d.building === refinery.id && m.d.jobs.length === 0,
    20000,
    "queue drained",
  );
  await sleep(300);
  const gainedSteel = c.invCount("SteelPlate") - steelBefore;
  if (gainedSteel !== 3) throw new Error(`expected 3 steel plates, got ${gainedSteel}`);
  log("PASS production: queue drained, 3x SteelPlate delivered to inventory");

  // 4. Building energy cap: 5 helpers + us queue Factory jobs. Ammo costs
  // 2 Energy per running unit and the Factory's throughput cap is 4, so only
  // 2 of the 6 jobs run concurrently; the rest wait in the queue unpowered.
  log("spawning 5 helper clients to saturate the factory energy cap...");
  const helpers = [];
  for (let i = 1; i <= 5; i++) {
    const h = new Client();
    await h.loginAccount(`e2ehelper${i}`, `Helper${i}`);
    await h.connect();
    helpers.push(h);
  }
  await sleep(500);
  for (const h of helpers) {
    h.chat("/give steel 20");
    h.chat("/give chemicals 40");
    h.chat("/give energy 30");
  }
  c.chat("/give steel 20");
  c.chat("/give chemicals 40");
  await sleep(500);
  for (const h of helpers) {
    const hf = h.findEntities("Factory")[0];
    h.tp(hf.x + 1, hf.z);
  }
  await sleep(500);
  for (const h of helpers) {
    const hf = h.findEntities("Factory")[0];
    h.send({ t: "QueueProduction", d: { building: hf.id, recipe: "ammo_9mm", count: 10 } });
  }
  c.tp(factory.x + 1, factory.z);
  await sleep(500);
  c.send({ t: "QueueProduction", d: { building: factory.id, recipe: "ammo_9mm", count: 10 } });
  await sleep(1500);
  // Latest shared queue state any client saw: powered jobs vs waiting jobs.
  const last = [...c.events]
    .reverse()
    .find((m) => m.t === "ProductionState" && m.d.building === factory.id && m.d.jobs.length);
  if (!last) throw new Error("no ProductionState for the factory");
  const poweredCount = last.d.jobs.filter((j) => j.powered).length;
  const waitingCount = last.d.jobs.filter((j) => !j.powered).length;
  log(
    `factory queue: ${last.d.jobs.length} jobs, powered=${poweredCount} waiting=${waitingCount}, ` +
      `energy ${last.d.energy_used}/${last.d.energy_cap}`,
  );
  if (last.d.jobs.length < 6) throw new Error("expected 6 jobs in the shared factory queue");
  if (poweredCount !== 2) throw new Error(`cap 4 / 2 Energy per job should power exactly 2, got ${poweredCount}`);
  if (waitingCount < 4) throw new Error("expected the remaining jobs to wait unpowered");
  log("PASS energy cap: factory cap 4 powers 2 ammo jobs, the rest queue unpowered");
  for (const h of helpers) h.ws.close();

  // 5. Market: list steel plates, buy our own listing, then list + cancel.
  c.tp(market.x + 1, market.z);
  await sleep(500);
  c.interact(market.id);
  const ms0 = await c.waitFor((m) => m.t === "MarketState", 4000, "MarketState");
  const wallet0 = ms0.d.wallet;
  log("market open: wallet", wallet0, "MILD,", ms0.d.listings.length, "listings");
  if (wallet0 <= 0) throw new Error("no MILD grant on wallet");

  const steelHeld = c.invCount("SteelPlate");
  // Register both waiters before sending: the result and the state refresh
  // land in the same batch, so a late-registered waiter misses them.
  const mr1P = c.waitFor((m) => m.t === "MarketResult", 4000, "list result");
  const ms1P = c.waitFor((m) => m.t === "MarketState", 4000, "MarketState after list");
  c.send({ t: "Market", d: { t: "List", d: { kind: "SteelPlate", count: 2, price_each: 10 } } });
  const mr1 = await mr1P;
  if (!mr1.d.ok) throw new Error("list failed: " + mr1.d.error);
  const ms1 = await ms1P;
  const listing = ms1.d.listings.find((l) => l.kind === "SteelPlate" && l.count === 2);
  if (!listing) throw new Error("listing not found after List");
  await sleep(300);
  if (c.invCount("SteelPlate") !== steelHeld - 2) throw new Error("items not escrowed on list");
  log("PASS market list: 2x SteelPlate escrowed at 10 MILD each (listing", listing.id + ")");

  // Buy our own listing (single-player verification; 5% fee burned).
  const mr2P = c.waitFor((m) => m.t === "MarketResult", 4000, "buy result");
  const ms2P = c.waitFor((m) => m.t === "MarketState", 4000, "MarketState after buy");
  c.send({ t: "Market", d: { t: "Buy", d: { listing_id: listing.id, count: 2 } } });
  const mr2 = await mr2P;
  if (!mr2.d.ok) throw new Error("buy failed: " + mr2.d.error);
  const ms2 = await ms2P;
  await sleep(300);
  if (c.invCount("SteelPlate") !== steelHeld) throw new Error("items not delivered on buy");
  if (ms2.d.listings.some((l) => l.id === listing.id)) throw new Error("listing still present");
  const fee = Math.floor((20 * 5) / 100);
  if (ms2.d.wallet !== wallet0 - fee) {
    throw new Error(`wallet ${ms2.d.wallet}, expected ${wallet0 - fee} (fee burn ${fee})`);
  }
  log(`PASS market buy: bought own listing, ${fee} MILD fee burned (wallet ${wallet0} -> ${ms2.d.wallet})`);

  // Cancel round-trip.
  const ms3P = c.waitFor(
    (m) => m.t === "MarketState" && m.d.listings.some((l) => l.kind === "SteelPlate" && l.price_each === 5),
    4000,
    "MarketState",
  );
  c.send({ t: "Market", d: { t: "List", d: { kind: "SteelPlate", count: 1, price_each: 5 } } });
  const ms3 = await ms3P;
  const l2 = ms3.d.listings.find((l) => l.kind === "SteelPlate" && l.price_each === 5);
  const mr3P = c.waitFor((m) => m.t === "MarketResult", 4000, "cancel result");
  c.send({ t: "Market", d: { t: "Cancel", d: { listing_id: l2.id } } });
  const mr3 = await mr3P;
  if (!mr3.d.ok) throw new Error("cancel failed: " + mr3.d.error);
  await sleep(300);
  if (c.invCount("SteelPlate") !== steelHeld) throw new Error("items not returned on cancel");
  log("PASS market cancel: listing cancelled, items returned");

  log("ALL PHASE 3 CHECKS PASSED");
  c.ws.close();
}

const scenario = process.argv[2] ?? "extraction";
const scenarios = {
  extraction: scenarioExtraction,
  economy: scenarioEconomy,
  manufacturing: scenarioManufacturing,
};
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
