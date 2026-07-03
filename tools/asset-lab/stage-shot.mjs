// Debug utility: screenshot Building Stage prefabs headlessly.
//   node tools/asset-lab/stage-shot.mjs <devServerUrl> <outDir> [prefabNameSubstring ...]
import { mkdirSync } from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer";

const [url = "http://localhost:5175", outDir = "tmp", ...names] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });

const browser = await puppeteer.launch({
  headless: true,
  args: ["--use-gl=angle", "--enable-unsafe-swiftshader", "--window-size=1600,1000"],
  defaultViewport: { width: 1600, height: 1000 },
});
const page = await browser.newPage();
page.on("console", (msg) => {
  if (msg.type() === "error") console.error("[page]", msg.text());
});
await page.goto(url, { waitUntil: "networkidle2" });

const clickByText = async (selector, text) => {
  await page.waitForFunction(
    (sel, t) => [...document.querySelectorAll(sel)].some((b) => b.textContent.includes(t)),
    { timeout: 15000 },
    selector,
    text,
  );
  await page.evaluate(
    (sel, t) => {
      const el = [...document.querySelectorAll(sel)].find((b) => b.textContent.includes(t));
      el.click();
    },
    selector,
    text,
  );
};

await clickByText("button", "ASSET LAB");
await clickByText("button", "BUILDING STAGE");
await page.waitForSelector(".lab-asset-card", { timeout: 30000 });

for (const name of names.length > 0 ? names : ["CB01 walk-up"]) {
  await clickByText(".lab-asset-card", name);
  // Let the GLBs stream in and the canvas settle.
  await new Promise((r) => setTimeout(r, 6000));
  const file = path.join(outDir, `${name.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}.png`);
  await page.screenshot({ path: file });
  console.log("saved", file);
}

await browser.close();
