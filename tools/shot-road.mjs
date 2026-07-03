// Close-up road/ground screenshot: slight tilt, zoomed in (dev only).
// Usage: node tools/shot-road.mjs [outPrefix] [dragY] [scrollClicks] [walkKeys] [walkSec]
import puppeteer from "puppeteer";

const outPrefix = process.argv[2] ?? "road";
const dragY = Number(process.argv[3] ?? 120);
const scrollClicks = Number(process.argv[4] ?? 6);
const walkKeys = (process.argv[5] ?? "").split("").filter((c) => "wasd".includes(c));
const walkSec = Number(process.argv[6] ?? 3);

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
// Try each "Shot" runner card in turn: a card can silently fail to join when
// a stale session still holds that character server-side.
await page.waitForSelector(".char-card", { timeout: 15000 });
await new Promise((r) => setTimeout(r, 800));
let joined = false;
for (let attempt = 0; attempt < 4 && !joined; attempt++) {
  await page.evaluate((i) => {
    const cards = [...document.querySelectorAll(".char-card")];
    const shots = cards.filter((c) => /shot/i.test(c.textContent));
    const pick = shots.length > 0 ? shots[i % shots.length] : cards[cards.length - 1];
    pick.click();
  }, attempt);
  try {
    await page.waitForFunction(
      () => window.__game && window.__game.localEntityId !== 0,
      { timeout: 12000 },
    );
    joined = true;
  } catch {
    // Back to the character list and try the next card.
    await page.reload({ waitUntil: "networkidle2" });
    await page.evaluate(() => {
      const dev = [...document.querySelectorAll("button")].find((b) =>
        b.textContent.includes("DEV LOGIN"),
      );
      if (dev) dev.click();
    });
    await page.waitForSelector(".char-card", { timeout: 15000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 800));
  }
}
if (!joined) {
  console.error("world did not join; aborting shot");
  await browser.close();
  process.exit(2);
}
await new Promise((r) => setTimeout(r, 6000));

// Optionally walk (WASD) to reach a road before framing the shot.
if (walkKeys.length > 0) {
  for (const k of walkKeys) await page.keyboard.down(`Key${k.toUpperCase()}`);
  await new Promise((r) => setTimeout(r, walkSec * 1000));
  for (const k of walkKeys) await page.keyboard.up(`Key${k.toUpperCase()}`);
  await new Promise((r) => setTimeout(r, 800));
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
