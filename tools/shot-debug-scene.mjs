// Temporary debug: screenshot + dump scene/chunk state (dev only).
import puppeteer from "puppeteer";

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--window-size=1600,900", "--use-gl=angle"],
  defaultViewport: { width: 1600, height: 900 },
});
const page = await browser.newPage();
page.on("console", (m) => console.log(`[page ${m.type()}]`, m.text()));
page.on("pageerror", (e) => console.log("[pageerror]", e.message));

await page.goto("http://localhost:5173", { waitUntil: "networkidle2" });
await page.waitForFunction(
  () => [...document.querySelectorAll("button")].some((b) => b.textContent.includes("DEV LOGIN")),
  { timeout: 15000 },
);
await page.evaluate(() => {
  [...document.querySelectorAll("button")].find((b) => b.textContent.includes("DEV LOGIN")).click();
});
await page.waitForFunction(
  () => document.querySelector(".char-card") || document.querySelector("input.field"),
  { timeout: 15000 },
);
await page.click(".char-card");
await page.waitForSelector("canvas", { timeout: 20000 });
await new Promise((r) => setTimeout(r, 15000));

const info = await page.evaluate(() => {
  const w = window;
  const scene = w.__wilderGl?.scene;
  const cam = scene ? null : null;
  let meshes = 0;
  scene?.traverse((o) => {
    if (o.isMesh) meshes++;
  });
  return {
    hasScene: !!scene,
    children: scene?.children.length,
    meshes,
    bodyText: document.body.innerText.slice(0, 200),
  };
});
console.log(JSON.stringify(info, null, 2));
await page.screenshot({ path: "tools/screens/debug-scene.png" });
console.log("saved tools/screens/debug-scene.png");
await browser.close();
