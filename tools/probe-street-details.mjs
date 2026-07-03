// Find world positions of streamed-in storm drains + manholes (dev only):
// identifies RoadDetails meshes by their shared geometry parameters and prints
// world coordinates suitable for screenshot-b.mjs --tp.
import puppeteer from "puppeteer";

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
await page.waitForSelector(".char-card", { timeout: 15000 });
await new Promise((r) => setTimeout(r, 800));
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
await new Promise((r) => setTimeout(r, 8000));

const found = await page.evaluate(() => {
  const scene = window.__wilderGl?.scene;
  if (!scene) return { error: "no __wilderGl" };
  scene.updateMatrixWorld(true);
  const drains = [];
  const manholes = [];
  scene.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    const p = o.geometry.parameters;
    const e = o.matrixWorld.elements;
    if (p && Math.abs((p.width ?? 0) - 0.96) < 1e-6 && Math.abs((p.depth ?? 0) - 0.46) < 1e-6) {
      drains.push([Math.round(e[12] * 10) / 10, Math.round(e[14] * 10) / 10]);
    }
    if (p && Math.abs((p.innerRadius ?? 0) - 0.275) < 1e-6) {
      manholes.push([Math.round(e[12] * 10) / 10, Math.round(e[14] * 10) / 10]);
    }
  });
  return { drains: drains.slice(0, 10), manholes: manholes.slice(0, 10) };
});
console.log(JSON.stringify(found, null, 2));
await browser.close();
