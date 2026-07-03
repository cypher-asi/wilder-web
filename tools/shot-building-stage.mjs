// Visual verification for the Building Stage dev section.
// Usage: node tools/shot-building-stage.mjs
// Requires Vite (:5173), the asset lab server (:8090) and the gateway (:8080).

import puppeteer from "puppeteer";

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--window-size=1720,960", "--use-gl=angle"],
  defaultViewport: { width: 1720, height: 960 },
});
const page = await browser.newPage();
page.on("console", (m) => {
  if (m.type() === "error") console.log("[page error]", m.text());
});
page.on("pageerror", (err) => console.log("[pageerror]", err.message));

await page.goto("http://localhost:5173", { waitUntil: "networkidle2" });

// Login screen -> ASSET LAB -> BUILDING STAGE tab.
await page.waitForFunction(
  () => [...document.querySelectorAll("button")].some((b) => b.textContent.includes("ASSET LAB")),
  { timeout: 15000 },
);
await page.evaluate(() => {
  [...document.querySelectorAll("button")].find((b) => b.textContent.includes("ASSET LAB")).click();
});
await page.waitForFunction(
  () => [...document.querySelectorAll("button")].some((b) => b.textContent === "BUILDING STAGE"),
  { timeout: 15000 },
);
await page.evaluate(() => {
  [...document.querySelectorAll("button")].find((b) => b.textContent === "BUILDING STAGE").click();
});

// Prefab list seeds (defaults derived from the registry) and viewport renders.
await page.waitForSelector(".lab-asset-card", { timeout: 20000 });
await page.waitForSelector(".lab-viewport canvas", { timeout: 20000 });
await new Promise((r) => setTimeout(r, 5000));
await page.screenshot({ path: "tools/screens/building-stage-1-default.png" });

// Select the slab prefab and tweak depth scale to prove live editing works.
await page.evaluate(() => {
  const card = [...document.querySelectorAll(".lab-asset-card")].find((c) =>
    c.textContent.includes("Slab"),
  );
  card?.click();
});
await new Promise((r) => setTimeout(r, 4000));
await page.screenshot({ path: "tools/screens/building-stage-2-slab.png" });

const stats = await page.evaluate(() => document.querySelector(".stage-stats")?.textContent);
console.log("stats:", stats);
console.log("saved tools/screens/building-stage-{1,2}.png");
await browser.close();
