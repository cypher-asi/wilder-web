// Street-level validation: opens the Building Stage, selects a prefab, pans
// the camera down to the ground band and captures close screenshots.
//   PORT=5199 PREFAB="Tower" node tools/shot-stage-street.mjs
import puppeteer from "puppeteer";

const PORT = process.env.PORT ?? "5199";
const PREFAB = process.env.PREFAB ?? "Tower";
const PREFIX = process.env.SHOT ?? "tools/screens/stage-street";

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

// Pan down (right-drag) so the street level fills the frame, then zoom in.
await page.mouse.move(cx, cy);
await page.mouse.down({ button: "right" });
await page.mouse.move(cx, cy - 260, { steps: 15 });
await page.mouse.up({ button: "right" });
await new Promise((r) => setTimeout(r, 400));
await page.mouse.move(cx, cy);
for (let i = 0; i < 9; i++) {
  await page.mouse.wheel({ deltaY: -240 });
  await new Promise((r) => setTimeout(r, 120));
}
await new Promise((r) => setTimeout(r, 700));
await page.screenshot({ path: `${PREFIX}-1.png` });

// Orbit to see a second face and the corner at street level.
await page.mouse.move(cx, cy);
await page.mouse.down();
await page.mouse.move(cx + 320, cy - 30, { steps: 15 });
await page.mouse.up();
await new Promise((r) => setTimeout(r, 700));
await page.screenshot({ path: `${PREFIX}-2.png` });

console.log("done");
await browser.close();
