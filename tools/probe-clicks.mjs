// Probe: rapid individual clicks on a hovered enemy — how many clicks does a
// kill take, do all clicks become shots, and do hits register?
import puppeteer from "puppeteer";

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--window-size=1600,900", "--use-gl=angle"],
  defaultViewport: { width: 1600, height: 900 },
});
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", e.message));

await page.goto("http://localhost:5173", { waitUntil: "networkidle2" });
await page.waitForFunction(
  () => [...document.querySelectorAll("button")].some((b) => b.textContent.includes("DEV LOGIN")),
  { timeout: 15000 },
);
await page.evaluate(() => {
  [...document.querySelectorAll("button")].find((b) => b.textContent.includes("DEV LOGIN")).click();
});
await page.waitForFunction(() => document.querySelectorAll(".char-card").length > 0, {
  timeout: 15000,
});
const cardCount = await page.evaluate(() => document.querySelectorAll(".char-card").length);
let joined = false;
for (let i = 0; i < cardCount && !joined; i++) {
  await page.evaluate((idx) => document.querySelectorAll(".char-card")[idx].click(), i);
  try {
    await page.waitForFunction(() => window.__game && window.__game.localEntityId !== 0, {
      timeout: 8000,
    });
    joined = true;
  } catch {
    await page.reload({ waitUntil: "networkidle2" });
    await page.waitForFunction(
      () =>
        document.querySelectorAll(".char-card").length > 0 ||
        [...document.querySelectorAll("button")].some((b) => b.textContent.includes("DEV LOGIN")),
      { timeout: 15000 },
    );
    const needLogin = await page.evaluate(
      () => document.querySelectorAll(".char-card").length === 0,
    );
    if (needLogin) {
      await page.evaluate(() => {
        [...document.querySelectorAll("button")]
          .find((b) => b.textContent.includes("DEV LOGIN"))
          .click();
      });
      await page.waitForFunction(() => document.querySelectorAll(".char-card").length > 0, {
        timeout: 15000,
      });
    }
  }
}
if (!joined) {
  console.log("NO CHARACTER COULD JOIN");
  await browser.close();
  process.exit(1);
}
await new Promise((r) => setTimeout(r, 3000));

async function chat(cmd) {
  await page.keyboard.press("Enter");
  await new Promise((r) => setTimeout(r, 250));
  await page.keyboard.type(cmd);
  await page.keyboard.press("Enter");
  await new Promise((r) => setTimeout(r, 600));
  await page.keyboard.press("Escape");
}
await chat("/give pistol");
await chat("/give ammo 200");
await chat("/heal");
await page.evaluate(() => {
  const ui = window.__ui.getState();
  const slot = ui.inventory?.slots.findIndex((s) => s?.kind === "Pistol");
  if (slot >= 0 && ui.inventory.equipped_weapon !== "Pistol") {
    window.__game.send({ t: "InventoryAction", d: { t: "Equip", d: { slot } } });
  }
});
await new Promise((r) => setTimeout(r, 500));

async function nearestNpc() {
  return page.evaluate(() => {
    const g = window.__game;
    const me = g.entities.get(g.localEntityId);
    let best = null;
    for (const e of g.entities.values()) {
      if (e.kind !== "Npc" || e.healthPct <= 0) continue;
      const d = Math.hypot(e.x - me.x, e.z - me.z);
      if (!best || d < best.d) best = { id: e.id, x: e.x, z: e.z, d, hp: e.healthPct };
    }
    return best;
  });
}

let npc = null;
for (const [x, z] of [[60, 60], [90, 30], [30, 90], [120, 60]]) {
  await chat(`/tp ${x} ${z}`);
  await new Promise((r) => setTimeout(r, 1500));
  npc = await nearestNpc();
  if (npc && npc.d < 30) break;
}
console.log("npc:", JSON.stringify(npc));
if (!npc) {
  console.log("NO NPC");
  await browser.close();
  process.exit(1);
}
await chat(`/tp ${(npc.x - 10).toFixed(1)} ${npc.z.toFixed(1)}`);

// Death on approach drops carried items; restock + verify until we're
// actually alive with ammo next to the NPC (retry a few times).
async function status() {
  return page.evaluate(() => {
    const g = window.__game;
    const ui = window.__ui.getState();
    const me = g.entities.get(g.localEntityId);
    return {
      hp: ui.health,
      x: me ? +me.x.toFixed(1) : null,
      z: me ? +me.z.toFixed(1) : null,
      weapon: ui.inventory?.equipped_weapon,
      ammo: ui.inventory?.slots
        .filter((s) => s?.kind === "Ammo9mm")
        .reduce((a, s) => a + s.count, 0),
      chat: ui.chat.slice(-3).map((c) => c.text),
    };
  });
}
let ready = false;
for (let attempt = 0; attempt < 4 && !ready; attempt++) {
  await chat("/heal");
  await chat("/give pistol");
  await chat("/give ammo 200");
  await page.evaluate(() => {
    const ui = window.__ui.getState();
    const slot = ui.inventory?.slots.findIndex((s) => s?.kind === "Pistol");
    if (slot >= 0 && ui.inventory.equipped_weapon !== "Pistol") {
      window.__game.send({ t: "InventoryAction", d: { t: "Equip", d: { slot } } });
    }
  });
  await new Promise((r) => setTimeout(r, 800));
  const s = await status();
  console.log(`restock attempt ${attempt}:`, JSON.stringify(s));
  const nearNpc = s.x != null && Math.hypot(s.x - npc.x, s.z - npc.z) < 20;
  if (s.ammo > 0 && s.weapon === "Pistol" && nearNpc) ready = true;
  else if (!nearNpc) {
    // Died and respawned at the hub: go back to the NPC.
    await chat(`/tp ${(npc.x - 10).toFixed(1)} ${npc.z.toFixed(1)}`);
    await new Promise((r) => setTimeout(r, 800));
  }
}
if (!ready) {
  console.log("COULD NOT GET READY (alive+ammo near NPC)");
  await page.screenshot({ path: "tools/screens/probe_clicks_fail.png" });
  await browser.close();
  process.exit(1);
}

// Find the NPC on screen: project its world position.
async function npcScreen(id) {
  return page.evaluate((tid) => {
    const g = window.__game;
    const t = g.entities.get(tid);
    if (!t) return null;
    const scene = window.__scene;
    // Project via the camera if exposed; fall back to hover sweep otherwise.
    const cam = window.__camera;
    if (!cam) return null;
    const v = { x: t.x, y: 1.2, z: t.z };
    const THREE_proj = (() => {
      // minimal projection without importing THREE
      const e = cam.matrixWorldInverse.elements;
      return null;
    })();
    return null;
  }, id);
}

// Hover sweep to find the enemy under the cursor.
let hoverAt = null;
for (let ry = 200; ry <= 700 && !hoverAt; ry += 40) {
  for (let rx = 300; rx <= 1300; rx += 40) {
    await page.mouse.move(rx, ry);
    await new Promise((r) => setTimeout(r, 16));
    const hit = await page.evaluate(() => window.__game.hoverTargetId);
    if (hit != null) {
      hoverAt = { rx, ry, id: hit };
      break;
    }
  }
}
console.log("hover:", JSON.stringify(hoverAt));
if (!hoverAt) {
  console.log("NO HOVER — clicking at screen position of NPC without hover");
}

const targetId = hoverAt?.id ?? npc.id;
const clickX = hoverAt?.rx ?? 800;
const clickY = hoverAt?.ry ?? 450;

// Baseline.
const before = await page.evaluate((tid) => {
  const g = window.__game;
  const ui = window.__ui.getState();
  return {
    shotSeq: g.gun.shotSeq,
    drawn: g.gun.drawn,
    weapon: ui.inventory?.equipped_weapon,
    ammo: ui.inventory?.slots
      .filter((s) => s?.kind === "Ammo9mm")
      .reduce((a, s) => a + s.count, 0),
    hp: g.entities.get(tid)?.healthPct ?? null,
  };
}, targetId);
console.log("before:", JSON.stringify(before));

// 20 rapid individual clicks, ~140ms apart (faster than the 300ms cooldown).
for (let i = 0; i < 20; i++) {
  await page.mouse.move(clickX, clickY);
  await page.mouse.down();
  await new Promise((r) => setTimeout(r, 50));
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 90));
  if (i % 4 === 3) {
    const s = await page.evaluate((tid) => {
      const g = window.__game;
      const t = g.entities.get(tid);
      return {
        shotSeq: g.gun.shotSeq,
        hp: t ? +t.healthPct.toFixed(2) : null,
        hover: g.hoverTargetId,
      };
    }, targetId);
    console.log(`after click ${i + 1}:`, JSON.stringify(s));
    if (s.hp === null || s.hp <= 0) {
      console.log("TARGET DEAD after", i + 1, "clicks");
      break;
    }
  }
}

const after = await page.evaluate((tid) => {
  const g = window.__game;
  const ui = window.__ui.getState();
  return {
    shotSeq: g.gun.shotSeq,
    ammo: ui.inventory?.slots
      .filter((s) => s?.kind === "Ammo9mm")
      .reduce((a, s) => a + s.count, 0),
    hp: g.entities.get(tid)?.healthPct ?? null,
    chat: ui.chat.slice(-4).map((c) => c.text),
  };
}, targetId);
console.log("after:", JSON.stringify(after));
await page.screenshot({ path: "tools/screens/probe_clicks.png" });
await browser.close();
