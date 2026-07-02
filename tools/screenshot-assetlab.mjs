// Visual verification for the Asset Lab dev mode.
// Usage: node tools/screenshot-assetlab.mjs [assetId]
// Requires Vite (:5173) and the asset lab server (npm run lab, :8090) running.

import puppeteer from "puppeteer";

const assetId = process.argv[2] ?? "sm_barrier01";

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--window-size=1720,960", "--use-gl=angle"],
  defaultViewport: { width: 1720, height: 960 },
});
const page = await browser.newPage();
page.on("console", (m) => {
  if (m.type() === "error") console.log("[page error]", m.text());
});

await page.goto("http://localhost:5173", { waitUntil: "networkidle2" });

// Login screen -> ASSET LAB.
await page.waitForFunction(
  () => [...document.querySelectorAll("button")].some((b) => b.textContent.includes("ASSET LAB")),
  { timeout: 15000 },
);
await page.screenshot({ path: "tools/screens/assetlab-0-login.png" });
await page.evaluate(() => {
  [...document.querySelectorAll("button")].find((b) => b.textContent.includes("ASSET LAB")).click();
});

// Browser list loaded.
await page.waitForSelector(".lab-asset-card", { timeout: 15000 });
await page.screenshot({ path: "tools/screens/assetlab-1-browser.png" });

// Select the requested asset via search.
await page.type(".lab-search", assetId);
await page.waitForSelector(".lab-asset-card", { timeout: 5000 });
await page.click(".lab-asset-card");

// Viewport canvas + Sidekick data.
await page.waitForSelector(".lab-viewport canvas", { timeout: 20000 });
await new Promise((r) => setTimeout(r, 3500));
await page.screenshot({ path: "tools/screens/assetlab-2-inspect.png" });

// Wireframe toggle.
await page.evaluate(() => {
  [...document.querySelectorAll("button")].find((b) => b.textContent === "wireframe").click();
});
await new Promise((r) => setTimeout(r, 800));
await page.screenshot({ path: "tools/screens/assetlab-3-wireframe.png" });

console.log("saved tools/screens/assetlab-{0..3}.png");
await browser.close();
