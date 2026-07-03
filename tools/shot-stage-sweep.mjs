// Sweep validation: opens the Building Stage, selects a prefab, zooms to
// facade level and captures a series of small orbit steps to catch
// view-dependent artifacts (z-fighting, interpenetration).
//   PORT=5175 PREFAB="CB01 mid-rise" SHOT=tmp/sweep node tools/shot-stage-sweep.mjs
import puppeteer from "puppeteer";

const PORT = process.env.PORT ?? "5175";
const PREFAB = process.env.PREFAB ?? "CB01 mid-rise";
const PREFIX = process.env.SHOT ?? "tmp/stage-sweep";

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
  await new Promise((r) => setTimeout(r, 400));
}
async function zoom(steps) {
  await page.mouse.move(cx, cy);
  for (let i = 0; i < Math.abs(steps); i++) {
    await page.mouse.wheel({ deltaY: steps > 0 ? -240 : 240 });
    await new Promise((r) => setTimeout(r, 100));
  }
  await new Promise((r) => setTimeout(r, 400));
}

// Drop to facade level and zoom in, then sweep around the corner in small
// azimuth steps.
await orbit(0, -120); // lower the elevation (drag up moves camera down)
await zoom(6);
for (let i = 0; i < 6; i++) {
  await page.screenshot({ path: `${PREFIX}-${i}.png` });
  await orbit(Math.round(box.width / 12), 0);
}

console.log("done");
await browser.close();
