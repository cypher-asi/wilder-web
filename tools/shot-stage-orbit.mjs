// Orbit validation: opens the Building Stage, selects a prefab and captures
// four azimuths around the building at fixed elevation.
//   PREFAB="Tower" SHOT=tools/screens/orbit node tools/shot-stage-orbit.mjs
import puppeteer from "puppeteer";

const PORT = process.env.PORT ?? "5199";
const PREFAB = process.env.PREFAB ?? "Tower";
const PREFIX = process.env.SHOT ?? "tools/screens/stage-orbit";

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--window-size=1600,1000", "--use-gl=angle"],
  defaultViewport: { width: 1600, height: 1000 },
});
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 400)));

await page.goto(`http://localhost:${PORT}`, { waitUntil: "networkidle2" });
await page.waitForFunction(
  () => [...document.querySelectorAll("button")].some((b) => /asset lab/i.test(b.textContent)),
  { timeout: 15000 },
);
await page.evaluate(() => {
  [...document.querySelectorAll("button")].find((b) => /asset lab/i.test(b.textContent)).click();
});
await page.waitForFunction(
  () => [...document.querySelectorAll("button")].some((b) => /building stage/i.test(b.textContent)),
  { timeout: 15000 },
);
await page.evaluate(() => {
  [...document.querySelectorAll("button")]
    .find((b) => /building stage/i.test(b.textContent))
    .click();
});
await page.waitForSelector(".lab-asset-card", { timeout: 20000 });
const found = await page.evaluate((name) => {
  const card = [...document.querySelectorAll(".lab-asset-card")].find((c) =>
    c.textContent.toLowerCase().includes(name.toLowerCase()),
  );
  if (card) card.click();
  return Boolean(card);
}, PREFAB);
console.log(`prefab "${PREFAB}" found:`, found);
await new Promise((r) => setTimeout(r, 7000));

const canvas = await page.$(".lab-viewport canvas");
const box = await canvas.boundingBox();
const cx = box.x + box.width / 2;
const cy = box.y + box.height / 2;

async function orbit(dx, dy) {
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + dx, cy + dy, { steps: 12 });
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 500));
}

for (let i = 0; i < 4; i++) {
  await page.screenshot({ path: `${PREFIX}-az${i}.png` });
  // Quarter turn: OrbitControls default rotate speed maps canvas width ~ PI.
  await orbit(Math.round(box.width / 4), 0);
}

console.log("done");
await browser.close();
