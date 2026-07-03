// Sweep camera yaw 360deg (with an upward tilt) and screenshot each step, to
// validate sun glare from every direction (dev only).
// Usage: node tools/shot-sun-sweep.mjs [outPrefix] [steps]
import puppeteer from "puppeteer";

const outPrefix = process.argv[2] ?? "sun-sweep";
const steps = Number(process.argv[3] ?? 6);

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--window-size=1600,900", "--use-gl=angle"],
  defaultViewport: { width: 1600, height: 900 },
});
const page = await browser.newPage();
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
await page.click(".char-card");
await page.waitForSelector("canvas", { timeout: 20000 });
await new Promise((r) => setTimeout(r, 8000));

async function drag(dx, dy) {
  await page.mouse.move(800, 450);
  await page.mouse.down({ button: "right" });
  for (let i = 0; i < 15; i++) {
    await page.mouse.move(800 + (dx / 15) * (i + 1), 450 + (dy / 15) * (i + 1));
    await new Promise((r) => setTimeout(r, 25));
  }
  await page.mouse.up({ button: "right" });
}

// Rotate a full circle in `steps` increments. At each step, tilt up so the
// sky is in frame, screenshot, then tilt back down before the next yaw drag.
const perStep = 1600 / steps; // px of horizontal drag per step (~360/steps deg)
for (let s = 0; s < steps; s++) {
  await drag(0, -300);
  await new Promise((r) => setTimeout(r, 900));
  await page.screenshot({ path: `tools/screens/${outPrefix}-${s}.png` });
  console.log(`saved tools/screens/${outPrefix}-${s}.png`);
  await drag(0, 300);
  await drag(perStep, 0);
}

await browser.close();
