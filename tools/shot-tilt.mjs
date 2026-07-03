// Screenshot with an RMB-drag tilt so the horizon/sky is visible (dev only).
// Usage: node tools/shot-tilt.mjs [outPrefix] [dragY]
import puppeteer from "puppeteer";

const outPrefix = process.argv[2] ?? "tilt";
const dragY = Number(process.argv[3] ?? 320); // pixels to drag upward

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

// RMB drag upward: lowers pitch toward the horizon.
await page.mouse.move(800, 450);
await page.mouse.down({ button: "right" });
for (let i = 0; i < 20; i++) {
  await page.mouse.move(800, 450 - (dragY / 20) * (i + 1));
  await new Promise((r) => setTimeout(r, 30));
}
await page.mouse.up({ button: "right" });
await new Promise((r) => setTimeout(r, 1500));

await page.screenshot({ path: `tools/screens/${outPrefix}.png` });
console.log(`saved tools/screens/${outPrefix}.png`);
await browser.close();
