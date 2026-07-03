// Close-up validation: opens the Building Stage, selects a prefab and takes
// zoomed screenshots (corner + mid-face) to inspect tile seams and shadows.
//   PORT=5199 PREFAB="Wide" node tools/shot-stage-closeup.mjs
import puppeteer from "puppeteer";

const PORT = process.env.PORT ?? "5199";
const PREFAB = process.env.PREFAB ?? "Wide";
const PREFIX = process.env.SHOT ?? "tools/screens/stage-closeup";

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--window-size=1600,1000", "--use-gl=angle"],
  defaultViewport: { width: 1600, height: 1000 },
});
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 400)));
page.on("requestfailed", (r) => console.log("[requestfailed]", r.url(), r.failure()?.errorText));
page.on("response", (r) => {
  if (r.status() >= 400) console.log("[http]", r.status(), r.url());
});
page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning")
    console.log(`[console.${m.type()}]`, m.text().slice(0, 300));
});

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
await page.evaluate(() => {
  [...document.querySelectorAll("button")].find((b) => /reset defaults/i.test(b.textContent))?.click();
});
await new Promise((r) => setTimeout(r, 500));
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
  await page.mouse.move(cx + dx, cy + dy, { steps: 15 });
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 400));
}
async function zoom(steps) {
  await page.mouse.move(cx, cy);
  for (let i = 0; i < Math.abs(steps); i++) {
    await page.mouse.wheel({ deltaY: steps > 0 ? -240 : 240 });
    await new Promise((r) => setTimeout(r, 120));
  }
  await new Promise((r) => setTimeout(r, 500));
}

// Shot 1: zoomed into the corner at mid height.
await zoom(8);
await page.screenshot({ path: `${PREFIX}-corner.png` });

// Shot 2: orbit to face-on and look along the wall (grazing angle).
await orbit(220, 40);
await page.screenshot({ path: `${PREFIX}-graze.png` });

// Shot 3: zoom in further on the seam between two tiles.
await zoom(4);
await page.screenshot({ path: `${PREFIX}-seam.png` });

console.log("done");
await browser.close();
