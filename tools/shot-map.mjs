// Screenshot driver for the M map overlay: joins like screenshot-b.mjs, then
// presses M and captures the fullscreen map (optionally zooming out first).
// Usage: node tools/shot-map.mjs [outPrefix] [--zoomout N]

import puppeteer from "puppeteer";

const outPrefix = process.argv[2] ?? "map";
const args = process.argv.slice(3);
const zoomOut = Number(args[args.indexOf("--zoomout") + 1] || 0);

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
await page.waitForFunction(
  () => [...document.querySelectorAll("button")].some((b) => b.textContent.includes("DEV LOGIN")),
  { timeout: 15000 },
);
await page.evaluate(() => {
  [...document.querySelectorAll("button")].find((b) => b.textContent.includes("DEV LOGIN")).click();
});
await page.waitForSelector(".char-card", { timeout: 15000 });
const cardCount = await page.evaluate(() => document.querySelectorAll(".char-card").length);
let joined = false;
for (let i = cardCount - 1; i >= 0 && !joined; i--) {
  await page.evaluate((idx) => document.querySelectorAll(".char-card")[idx].click(), i);
  await page.waitForSelector("canvas", { timeout: 20000 });
  joined = await page
    .waitForFunction(() => document.body.innerText.includes("Welcome to Wilder"), { timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  if (!joined) {
    console.log(`card ${i} did not join, trying next`);
    await page.reload({ waitUntil: "networkidle2" });
    await page.waitForSelector(".char-card", { timeout: 15000 });
  }
}
if (!joined) throw new Error("no character could join");
await new Promise((r) => setTimeout(r, 6000));

// Open the map.
await page.keyboard.press("KeyM");
await page.waitForSelector(".map-overlay", { timeout: 5000 });
await new Promise((r) => setTimeout(r, 1500));

if (zoomOut > 0) {
  const canvas = await page.$(".map-canvas");
  const box = await canvas.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < zoomOut; i++) {
    await page.mouse.wheel({ deltaY: 240 });
    await new Promise((r) => setTimeout(r, 80));
  }
  await new Promise((r) => setTimeout(r, 600));
}

await page.screenshot({ path: `tools/screens/${outPrefix}.png` });
console.log(`saved tools/screens/${outPrefix}.png`);
await browser.close();
