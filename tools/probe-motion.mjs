// Temporary: steady-state smoothness probe for the rendered local player.
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
await page.waitForSelector(".char-card", { timeout: 15000 });
await page.click(".char-card");
await page.waitForSelector("canvas", { timeout: 20000 });
await page.waitForFunction(
  () => window.__game && window.__game.localEntityId !== 0,
  { timeout: 30000 },
);
await new Promise((r) => setTimeout(r, 5000));

// Teleport to an open road spot so we don't ram buildings mid-sample.
await page.keyboard.press("Enter");
await new Promise((r) => setTimeout(r, 300));
await page.keyboard.type("/tp 8 2");
await page.keyboard.press("Enter");
await new Promise((r) => setTimeout(r, 1000));
await page.keyboard.press("Escape");
await new Promise((r) => setTimeout(r, 500));

async function sample(label, frames = 120) {
  const stats = await page.evaluate(
    (n) =>
      new Promise((resolve) => {
        const g = window.__game;
        const pts = [];
        function tick() {
          const me = g.entities.get(g.localEntityId);
          if (me) pts.push({ t: performance.now(), x: me.x, z: me.z });
          if (pts.length < n) requestAnimationFrame(tick);
          else resolve(pts);
        }
        requestAnimationFrame(tick);
      }),
    frames,
  ).then((pts) => {
    const speeds = [];
    for (let i = 1; i < pts.length; i++) {
      const dt = (pts[i].t - pts[i - 1].t) / 1000;
      if (dt <= 0) continue;
      speeds.push(Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z) / dt);
    }
    const still = speeds.filter((s) => s < 0.01).length;
    const mean = speeds.reduce((a, b) => a + b, 0) / speeds.length;
    const sd = Math.sqrt(speeds.reduce((a, b) => a + (b - mean) ** 2, 0) / speeds.length);
    const max = Math.max(...speeds);
    const min = Math.min(...speeds);
    return {
      frames: speeds.length,
      stillFrames: still,
      meanSpeed: +mean.toFixed(2),
      sd: +sd.toFixed(2),
      min: +min.toFixed(2),
      max: +max.toFixed(2),
    };
  });
  console.log(label, JSON.stringify(stats));
}

// Walk: 1 s warm-up to steady state, then sample ~2 s of frames.
await page.keyboard.down("KeyW");
await new Promise((r) => setTimeout(r, 1000));
await sample("walk:");
await page.keyboard.up("KeyW");
await new Promise((r) => setTimeout(r, 500));

// Run back the other way (open road behind us).
await page.keyboard.down("KeyS");
await page.keyboard.down("ShiftLeft");
await new Promise((r) => setTimeout(r, 1000));
await sample("run:");
await page.keyboard.up("ShiftLeft");
await page.keyboard.up("KeyS");

await browser.close();
