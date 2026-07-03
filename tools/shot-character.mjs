// Temporary visual verification for the character overhaul.
import puppeteer from "puppeteer";

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--window-size=1600,900", "--use-gl=angle"],
  defaultViewport: { width: 1600, height: 900 },
});
const page = await browser.newPage();
page.on("console", (m) => {
  if (m.type() === "error") console.log("[page error]", m.text());
});
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
page.on("requestfailed", (r) => console.log("[reqfail]", r.url()));
page.on("response", (r) => {
  if (r.status() >= 400) console.log("[http", r.status() + "]", r.url());
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
  await page.type("input.field", "Shot");
  await page.evaluate(() => {
    [...document.querySelectorAll("button")]
      .find((b) => b.textContent.includes("CREATE RUNNER"))
      .click();
  });
  await page.waitForSelector(".char-card", { timeout: 15000 });
}
await page.click(".char-card");

await page.waitForSelector("canvas", { timeout: 20000 });
// Wait for the world join to complete (gateway may still be settling).
await page.waitForFunction(
  () => window.__game && window.__game.localEntityId !== 0,
  { timeout: 30000 },
);
await new Promise((r) => setTimeout(r, 5000));

// Teleport to an open road spot (dev command) so buildings don't occlude,
// and top up ammo so shots actually fire.
async function chat(cmd) {
  await page.keyboard.press("Enter");
  await new Promise((r) => setTimeout(r, 300));
  await page.keyboard.type(cmd);
  await page.keyboard.press("Enter");
  await new Promise((r) => setTimeout(r, 800));
  await page.keyboard.press("Escape");
}
await chat("/tp 8 2");
await chat("/give ammo 120");

// Zoom in for a closer look at the character.
await page.mouse.move(800, 450);
for (let i = 0; i < 24; i++) {
  await page.mouse.wheel({ deltaY: -120 });
  await new Promise((r) => setTimeout(r, 100));
}
await new Promise((r) => setTimeout(r, 1500));

async function shot(name) {
  await page.screenshot({ path: `tools/screens/char_${name}.png` });
  console.log(`saved char_${name}`);
}

async function animState() {
  return page.evaluate(() => {
    const g = window.__game;
    const me = g?.entities.get(g.localEntityId);
    return me?.anim;
  });
}

/** Sample the local entity's rendered position per frame for jitter analysis. */
async function sampleMotion(frames = 60) {
  const pts = await page.evaluate(
    (n) =>
      new Promise((resolve) => {
        const g = window.__game;
        const out = [];
        function tick() {
          const me = g.entities.get(g.localEntityId);
          out.push({ t: performance.now(), x: me.x, z: me.z });
          if (out.length < n) requestAnimationFrame(tick);
          else resolve(out);
        }
        requestAnimationFrame(tick);
      }),
    frames,
  );
  // Per-frame speed (m/s); smooth motion = every frame moves at ~constant speed.
  const speeds = [];
  for (let i = 1; i < pts.length; i++) {
    const dt = (pts[i].t - pts[i - 1].t) / 1000;
    if (dt <= 0) continue;
    speeds.push(Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z) / dt);
  }
  const still = speeds.filter((s) => s < 0.01).length;
  const mean = speeds.reduce((a, b) => a + b, 0) / speeds.length;
  const sd = Math.sqrt(
    speeds.reduce((a, b) => a + (b - mean) ** 2, 0) / speeds.length,
  );
  return {
    frames: speeds.length,
    stillFrames: still,
    meanSpeed: +mean.toFixed(3),
    sd: +sd.toFixed(3),
  };
}

// 1. Idle (holstered stance, pistol in hand).
await shot("idle");
console.log("idle anim:", await animState());

// 2. Walk (default, no shift).
await page.keyboard.down("KeyW");
await new Promise((r) => setTimeout(r, 900));
console.log("walk anim:", await animState());
const walkMotion = await sampleMotion();
console.log("walk motion:", JSON.stringify(walkMotion));
await shot("walk");

// 3. Run (hold shift).
await page.keyboard.down("ShiftLeft");
await new Promise((r) => setTimeout(r, 700));
console.log("run anim:", await animState());
const runMotion = await sampleMotion();
console.log("run motion:", JSON.stringify(runMotion));
await shot("run");

// 4. Roll mid-run.
await page.keyboard.press("Space");
await new Promise((r) => setTimeout(r, 250));
console.log("roll anim:", await animState());
await shot("roll");
await new Promise((r) => setTimeout(r, 600));
await page.keyboard.up("ShiftLeft");
await page.keyboard.up("KeyW");
await new Promise((r) => setTimeout(r, 700));

// 5. Crouch idle (Left Ctrl toggle).
await page.keyboard.press("ControlLeft");
await new Promise((r) => setTimeout(r, 700));
console.log("crouch anim:", await animState());
await shot("crouch");

// 6. Crouch walk.
await page.keyboard.down("KeyS");
await new Promise((r) => setTimeout(r, 800));
console.log("crouchwalk anim:", await animState());
await shot("crouchwalk");
await page.keyboard.up("KeyS");
await page.keyboard.press("ControlLeft");
await new Promise((r) => setTimeout(r, 500));

// 7. Draw + shoot (LMB): first click draws, hold fires.
await page.mouse.move(1000, 380);
await page.mouse.down();
await new Promise((r) => setTimeout(r, 200));
await shot("draw");
await new Promise((r) => setTimeout(r, 700));
await shot("shoot");
await page.mouse.up();

// 8. Anim state dump for sanity.
const state = await page.evaluate(() => {
  const g = window.__game;
  const me = g?.entities.get(g.localEntityId);
  return { anim: me?.anim, gun: g?.gun, crouching: g?.crouching };
});
console.log("state:", JSON.stringify(state));

await browser.close();
