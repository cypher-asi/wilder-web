// Screenshot driver for visual verification (dev only).
// Usage: node tools/screenshot.mjs [outPrefix] [--zoom N] [--walk dx,dz,ms]
// Requires the gateway (WILDER_DEV=1, :8080) and Vite (:5173) running.

import puppeteer from "puppeteer";

const outPrefix = process.argv[2] ?? "shot";
const args = process.argv.slice(3);
function argValue(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}

const zoomSteps = Number(argValue("--zoom") ?? 0); // + zooms in, - zooms out
const walk = argValue("--walk"); // e.g. "0,-1,3000" = hold W-ish direction

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--window-size=1600,900", "--use-gl=angle"],
  defaultViewport: { width: 1600, height: 900 },
});
const page = await browser.newPage();
page.on("console", (m) => {
  if (m.type() === "error") console.log("[page error]", m.text());
});

await page.goto("http://localhost:5173", { waitUntil: "networkidle2" });

// Dev login.
await page.waitForFunction(
  () => [...document.querySelectorAll("button")].some((b) => b.textContent.includes("DEV LOGIN")),
  { timeout: 15000 },
);
await page.evaluate(() => {
  [...document.querySelectorAll("button")].find((b) => b.textContent.includes("DEV LOGIN")).click();
});

// Character select: pick the first character, or create one.
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

// Wait for the 3D canvas and chunk streaming.
await page.waitForSelector("canvas", { timeout: 20000 });
await new Promise((r) => setTimeout(r, 7000));

if (zoomSteps !== 0) {
  await page.mouse.move(800, 450);
  for (let i = 0; i < Math.abs(zoomSteps); i++) {
    await page.mouse.wheel({ deltaY: zoomSteps > 0 ? -120 : 120 });
    await new Promise((r) => setTimeout(r, 120));
  }
  await new Promise((r) => setTimeout(r, 1200));
}

if (walk) {
  const [dx, dz, ms] = walk.split(",").map(Number);
  const key = dz < 0 ? "KeyW" : dz > 0 ? "KeyS" : dx < 0 ? "KeyA" : "KeyD";
  await page.keyboard.down(key);
  await new Promise((r) => setTimeout(r, ms || 2000));
  await page.keyboard.up(key);
  await new Promise((r) => setTimeout(r, 800));
}

await page.screenshot({ path: `tools/screens/${outPrefix}.png` });
console.log(`saved tools/screens/${outPrefix}.png`);
await browser.close();
