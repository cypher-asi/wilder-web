// Verify the original-first + clickable derivatives flow in the Asset Lab.
// Usage: node tools/screenshot-assetlab-variants.mjs [assetId]
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
await page.waitForFunction(
  () => [...document.querySelectorAll("button")].some((b) => b.textContent.includes("ASSET LAB")),
  { timeout: 15000 },
);
await page.evaluate(() => {
  [...document.querySelectorAll("button")].find((b) => b.textContent.includes("ASSET LAB")).click();
});
await page.waitForSelector(".lab-asset-card", { timeout: 20000 });
await page.type(".lab-search", assetId);
await page.click(".lab-asset-card");

// 1. Original loads first.
await page.waitForSelector(".lab-viewport canvas", { timeout: 20000 });
await new Promise((r) => setTimeout(r, 3000));
await page.screenshot({ path: "tools/screens/variants-1-original.png" });

// 2. Click each derivative chip.
const chips = await page.$$eval(".lab-variant-chip", (els) => els.map((e) => e.textContent.trim()));
console.log("derivative chips:", chips);
for (let i = 0; i < chips.length; i++) {
  await page.evaluate((idx) => {
    document.querySelectorAll(".lab-variant-chip")[idx].click();
  }, i);
  await new Promise((r) => setTimeout(r, 2500));
  await page.screenshot({ path: `tools/screens/variants-2-chip${i + 1}.png` });
}

console.log("saved tools/screens/variants-*.png");
await browser.close();
