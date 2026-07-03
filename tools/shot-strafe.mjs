// Visual verification for directional locomotion: aims at a fixed cursor
// position and walks in all 8 directions plus stop/start transitions,
// screenshotting each so leg direction vs torso facing can be inspected.
import puppeteer from "puppeteer";

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--window-size=1600,900", "--use-gl=angle"],
  defaultViewport: { width: 1600, height: 900 },
});
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
page.on("console", (m) => {
  if (m.type() === "error") console.log("[console]", m.text());
});
page.on("response", async (r) => {
  if (r.status() >= 400 && !r.url().endsWith(".ico")) {
    let body = "";
    try {
      body = (await r.text()).slice(0, 200);
    } catch {}
    console.log("[http", r.status() + "]", r.url(), body);
  }
});

await page.goto("http://localhost:5173", { waitUntil: "networkidle2" });

await page.waitForFunction(
  () => [...document.querySelectorAll("button")].some((b) => b.textContent.includes("DEV LOGIN")),
  { timeout: 15000 },
);
await page.evaluate(() => {
  [...document.querySelectorAll("button")].find((b) => b.textContent.includes("DEV LOGIN")).click();
});
await page.waitForFunction(
  () => document.querySelector(".char-card") || document.querySelector("input.field"),
  { timeout: 15000 },
);
const hasChar = await page.evaluate(() => !!document.querySelector(".char-card"));
if (!hasChar) {
  await page.type("input.field", "Strafe");
  await page.evaluate(() => {
    [...document.querySelectorAll("button")]
      .find((b) => b.textContent.includes("CREATE RUNNER"))
      .click();
  });
  await page.waitForSelector(".char-card", { timeout: 15000 });
}
await page.click(".char-card");
await page.waitForSelector("canvas", { timeout: 20000 });
try {
  await page.waitForFunction(() => window.__game && window.__game.localEntityId !== 0, {
    timeout: 60000,
  });
} catch (e) {
  await page.screenshot({ path: "tools/screens/strafe_JOINFAIL.png" });
  const diag = await page.evaluate(() => ({
    game: !!window.__game,
    localId: window.__game?.localEntityId,
    ui: window.__ui?.getState
      ? {
          connected: window.__ui.getState().connected,
          joined: window.__ui.getState().joined,
          lastError: window.__ui.getState().lastError,
        }
      : null,
  }));
  console.log("JOIN FAIL", JSON.stringify(diag));
  await browser.close();
  process.exit(1);
}
await new Promise((r) => setTimeout(r, 4000));

async function chat(cmd) {
  await page.keyboard.press("Enter");
  await new Promise((r) => setTimeout(r, 300));
  await page.keyboard.type(cmd);
  await page.keyboard.press("Enter");
  await new Promise((r) => setTimeout(r, 800));
  await page.keyboard.press("Escape");
}
await chat("/tp 8 2");

// Zoom in.
await page.mouse.move(800, 450);
for (let i = 0; i < 20; i++) {
  await page.mouse.wheel({ deltaY: -120 });
  await new Promise((r) => setTimeout(r, 80));
}
await new Promise((r) => setTimeout(r, 1200));

// Fixed aim above the character: torso should keep facing "up" the screen.
await page.mouse.move(800, 250);
await new Promise((r) => setTimeout(r, 400));

async function state() {
  return page.evaluate(() => {
    const g = window.__game;
    const me = g?.entities.get(g.localEntityId);
    return {
      anim: me?.anim,
      yaw: +me?.yaw.toFixed(2),
      vx: +me?.vx.toFixed(2),
      vz: +me?.vz.toFixed(2),
    };
  });
}

async function shot(name) {
  await page.screenshot({ path: `tools/screens/strafe_${name}.png` });
  console.log(`saved strafe_${name}`, JSON.stringify(await state()));
}

const DIRS = [
  ["fwd", ["KeyW"]],
  ["fwd_left", ["KeyW", "KeyA"]],
  ["left", ["KeyA"]],
  ["bwd_left", ["KeyS", "KeyA"]],
  ["bwd", ["KeyS"]],
  ["bwd_right", ["KeyS", "KeyD"]],
  ["right", ["KeyD"]],
  ["fwd_right", ["KeyW", "KeyD"]],
];

await shot("idle");
for (const [name, keysList] of DIRS) {
  for (const k of keysList) await page.keyboard.down(k);
  // Keep the cursor pinned so aim stays constant while we move.
  await page.mouse.move(800, 250);
  await new Promise((r) => setTimeout(r, 1100));
  await page.mouse.move(800, 250);
  await shot(name);
  for (const k of keysList) await page.keyboard.up(k);
  await new Promise((r) => setTimeout(r, 500));
}

// Sprint backward + transition midpoint (start moving, shoot early).
await page.keyboard.down("ShiftLeft");
await page.keyboard.down("KeyS");
await new Promise((r) => setTimeout(r, 250));
await shot("bwd_sprint_early");
await new Promise((r) => setTimeout(r, 900));
await shot("bwd_sprint");
await page.keyboard.up("KeyS");
await page.keyboard.up("ShiftLeft");
await new Promise((r) => setTimeout(r, 200));
await shot("stop_blend");

await browser.close();
