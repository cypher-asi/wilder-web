// Watch-tab EXPLORE probe: enter the Watch tab, switch to EXPLORE, drag to
// pan far from the agent, and verify the world keeps streaming around the
// free camera (server SpectateAt anchor). Screenshots before/after.
// Usage: node tools/shot-watch-explore.mjs [outPrefix] [--url http://localhost:5173]

import puppeteer from "puppeteer";

const outPrefix = process.argv[2] ?? "watch-explore";
const args = process.argv.slice(3);
function argValue(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}
const url = argValue("--url") ?? "http://localhost:5173";

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--window-size=420,900", "--use-gl=angle"],
  defaultViewport: { width: 390, height: 844, isMobile: true, hasTouch: true },
});
const page = await browser.newPage();
await page.goto(url, { waitUntil: "networkidle2" });
await page.waitForSelector("canvas", { timeout: 20000 });
await new Promise((r) => setTimeout(r, 3000));

await page.evaluate(() => {
  [...document.querySelectorAll("button")]
    .find((b) => b.textContent.toUpperCase().includes("WATCH"))
    ?.click();
});
await page
  .waitForFunction(() => (window.__chunkPipeline?.revealed.size ?? 0) > 5, {
    timeout: 45000,
    polling: 1000,
  })
  .catch(() => console.log("chunks still unrevealed"));
await new Promise((r) => setTimeout(r, 4000));
await page.screenshot({ path: `tools/screens/${outPrefix}-follow.png` });

// Switch to EXPLORE and drag several times to pan.
await page.evaluate(() => {
  [...document.querySelectorAll("button")]
    .find((b) => b.textContent.includes("EXPLORE"))
    ?.click();
});
await new Promise((r) => setTimeout(r, 500));

async function drag(fromX, fromY, toX, toY) {
  await page.evaluate(
    (fx, fy, tx, ty) => {
      const el = document.querySelector(".m-watch-gesture");
      const opts = (x, y) => ({
        bubbles: true,
        pointerId: 1,
        pointerType: "touch",
        isPrimary: true,
        clientX: x,
        clientY: y,
      });
      el.dispatchEvent(new PointerEvent("pointerdown", opts(fx, fy)));
      const steps = 12;
      for (let i = 1; i <= steps; i++) {
        const x = fx + ((tx - fx) * i) / steps;
        const y = fy + ((ty - fy) * i) / steps;
        el.dispatchEvent(new PointerEvent("pointermove", opts(x, y)));
      }
      el.dispatchEvent(new PointerEvent("pointerup", opts(tx, ty)));
    },
    fromX,
    fromY,
    toX,
    toY,
  );
  await new Promise((r) => setTimeout(r, 300));
}

for (let i = 0; i < 10; i++) {
  await drag(320, 400, 60, 640);
}
// Let SpectateAt throttle fire and the new area stream + build.
await new Promise((r) => setTimeout(r, 8000));

const diag = await page.evaluate(() => {
  const g = window.__game;
  const cam = window.__camera;
  return {
    predicted: g ? { x: g.predicted.x, z: g.predicted.z } : null,
    chunksStored: g ? g.chunks.chunks.size : null,
    revealed: window.__chunkPipeline?.revealed.size ?? null,
    camPos: cam ? { x: cam.position.x, y: cam.position.y, z: cam.position.z } : null,
  };
});
console.log("explore diag:", JSON.stringify(diag));

await page.screenshot({ path: `tools/screens/${outPrefix}.png` });
console.log(`saved tools/screens/${outPrefix}.png`);
await browser.close();
