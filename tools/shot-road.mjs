// Close-up road/ground screenshot: slight tilt, zoomed in (dev only).
// Usage: node tools/shot-road.mjs [outPrefix] [dragY] [scrollClicks]
import puppeteer from "puppeteer";

const outPrefix = process.argv[2] ?? "road";
const dragY = Number(process.argv[3] ?? 120);
const scrollClicks = Number(process.argv[4] ?? 6);

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

// Verify the world actually joined (HUD up, not disconnected).
const joined = await page.evaluate(() => document.body.innerText.includes("PISTOL"));
if (!joined) {
  console.error("world did not join (no HUD); aborting shot");
  await browser.close();
  process.exit(2);
}

// Zoom in with the scroll wheel.
await page.mouse.move(800, 450);
for (let i = 0; i < scrollClicks; i++) {
  await page.mouse.wheel({ deltaY: -120 });
  await new Promise((r) => setTimeout(r, 80));
}

if (dragY !== 0) {
  await page.mouse.down({ button: "right" });
  for (let i = 0; i < 15; i++) {
    await page.mouse.move(800, 450 - (dragY / 15) * (i + 1));
    await new Promise((r) => setTimeout(r, 30));
  }
  await page.mouse.up({ button: "right" });
}
await new Promise((r) => setTimeout(r, 1500));

await page.screenshot({ path: `tools/screens/${outPrefix}.png` });
console.log(`saved tools/screens/${outPrefix}.png`);
await browser.close();
