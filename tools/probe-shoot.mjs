// Probe: does shooting an NPC actually deplete its health end-to-end?
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

async function world() {
  return page.evaluate(() => {
    const g = window.__game;
    const me = g.entities.get(g.localEntityId);
    const ui = window.__ui.getState();
    const ammo = ui.inventory?.slots
      .filter((s) => s?.kind === "Ammo9mm")
      .reduce((a, s) => a + s.count, 0);
    let npc = null;
    for (const e of g.entities.values()) {
      if (e.kind !== "Npc" || e.healthPct <= 0) continue;
      const d = me ? Math.hypot(e.x - me.x, e.z - me.z) : 1e9;
      if (!npc || d < npc.d) npc = { id: e.id, x: e.x, z: e.z, d, hp: e.healthPct, hitReactAt: e.hitReactAt };
    }
    return {
      me: me ? { x: +me.x.toFixed(1), z: +me.z.toFixed(1) } : null,
      ammo,
      weapon: ui.inventory?.equipped_weapon,
      npc,
      chat: ui.chat.slice(-3).map((c) => c.text),
    };
  });
}

// Find an NPC.
let w = null;
for (const [x, z] of [[60, 60], [90, 30], [30, 90], [120, 60]]) {
  await chat(`/tp ${x} ${z}`);
  await new Promise((r) => setTimeout(r, 1500));
  w = await world();
  if (w.npc && w.npc.d < 30) break;
}
console.log("setup:", JSON.stringify(w));
if (!w.npc) {
  console.log("NO NPC");
  await browser.close();
  process.exit(1);
}
// Stand 12m from it (typical engagement range; inside its aggro radius so
// it starts moving, matching real play).
await chat(`/tp ${(w.npc.x - 12).toFixed(1)} ${w.npc.z.toFixed(1)}`);
await chat("/heal");
await chat("/give ammo 200");
await new Promise((r) => setTimeout(r, 800));
w = await world();
console.log("positioned:", JSON.stringify(w));
const targetId = w.npc.id;

// Count combat FX events as they're queued (before CombatFx drains them).
await page.evaluate(() => {
  const g = window.__game;
  window.__fxCount = { hit: 0, impact: 0, tracer: 0, flash: 0, shell: 0 };
  const origPush = g.fx.push.bind(g.fx);
  g.fx.push = (...evs) => {
    for (const ev of evs) {
      if (window.__fxCount[ev.type] != null) window.__fxCount[ev.type]++;
      if (ev.type === "impact") {
        window.__fxCount[ev.kind] = (window.__fxCount[ev.kind] ?? 0) + 1;
      }
    }
    return origPush(...evs);
  };
});

// Phase 1: server pipeline in isolation — send Attack straight at the NPC's
// current position, bypassing mouse aim entirely.
for (let i = 0; i < 6; i++) {
  await page.evaluate((tid) => {
    const g = window.__game;
    const t = g.entities.get(tid);
    if (t) g.send({ t: "Attack", d: { seq: g.nextSeq++, tx: t.x, tz: t.z } });
  }, targetId);
  await new Promise((r) => setTimeout(r, 700));
  const s = await page.evaluate((tid) => {
    const t = window.__game.entities.get(tid);
    return {
      hp: t ? +t.healthPct.toFixed(2) : null,
      fx: window.__fxCount,
      err: window.__ui.getState().chat.slice(-1)[0]?.text,
    };
  }, targetId);
  console.log(`direct shot ${i + 1}:`, JSON.stringify(s));
}

// Phase 2: real input path — hold LMB with the cursor roughly on the NPC.
await page.mouse.move(800, 450);
await page.mouse.down();
for (let i = 0; i < 6; i++) {
  await new Promise((r) => setTimeout(r, 300));
  const s = await page.evaluate((tid) => {
    const g = window.__game;
    const t = g.entities.get(tid);
    const ui = window.__ui.getState();
    const ammo = ui.inventory?.slots
      .filter((s2) => s2?.kind === "Ammo9mm")
      .reduce((a, s2) => a + s2.count, 0);
    return {
      shotSeq: g.gun.shotSeq,
      drawn: g.gun.drawn,
      ammo,
      hp: t ? +t.healthPct.toFixed(2) : null,
      hitReact: t ? Math.round(performance.now() - t.hitReactAt) : null,
      hover: g.hoverTargetId,
      fx: window.__fxCount,
      err: ui.chat.slice(-1)[0]?.text,
    };
  }, targetId);
  console.log(`t=${(i + 1) * 300}ms`, JSON.stringify(s));
}
await page.mouse.up();
await browser.close();
