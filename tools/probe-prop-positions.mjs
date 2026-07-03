// Dev probe: join the world and print world positions of streamed props by
// archetype (car/traffic light/kiosk/...), to aim freecam screenshots at.
import puppeteer from "puppeteer";

const PORT = process.env.PORT ?? "5173";
const browser = await puppeteer.launch({
  headless: "new",
  args: ["--window-size=1600,900", "--use-gl=angle"],
  defaultViewport: { width: 1600, height: 900 },
});
const page = await browser.newPage();
await page.goto(`http://localhost:${PORT}`, { waitUntil: "networkidle2" });
await page.waitForFunction(
  () => [...document.querySelectorAll("button")].some((b) => b.textContent.includes("DEV LOGIN")),
  { timeout: 15000 },
);
await page.evaluate(() => {
  [...document.querySelectorAll("button")].find((b) => b.textContent.includes("DEV LOGIN")).click();
});
await page.waitForSelector(".char-card", { timeout: 15000 });
await new Promise((r) => setTimeout(r, 800));
// A card can silently fail to join when a stale session holds the character.
const cardCount = await page.evaluate(() => document.querySelectorAll(".char-card").length);
let joined = false;
for (let i = cardCount - 1; i >= 0 && !joined; i--) {
  await page.evaluate((idx) => document.querySelectorAll(".char-card")[idx].click(), i);
  joined = await page
    .waitForFunction(() => window.__game && window.__game.localEntityId !== 0, { timeout: 10000 })
    .then(() => true)
    .catch(() => false);
  if (!joined) {
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
  console.error("no join");
  process.exit(2);
}
await new Promise((r) => setTimeout(r, 10000));

const out = await page.evaluate(() => {
  const NAMES = {
    0: "streetlight", 1: "bench", 2: "trash", 3: "hydrant", 4: "neon", 5: "vent",
    6: "tree", 7: "car", 8: "barrier", 9: "kiosk", 10: "traffic_light", 11: "stop_sign",
  };
  const CHUNK = 64;
  const byType = {};
  for (const chunk of window.__game.chunks.chunks.values()) {
    for (const p of chunk.props) {
      const name = NAMES[p.archetype] ?? `a${p.archetype}`;
      (byType[name] ??= []).push([
        Math.round(chunk.coord.x * CHUNK + p.x),
        Math.round(chunk.coord.z * CHUNK + p.z),
      ]);
    }
  }
  for (const k of Object.keys(byType)) byType[k] = byType[k].slice(0, 8);
  return byType;
});
console.log(JSON.stringify(out, null, 1));
await browser.close();
