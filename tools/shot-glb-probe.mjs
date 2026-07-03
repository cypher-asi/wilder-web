// Captures the glb-probe.html page at four camera azimuths.
//   ID=sm_skyscraper_module10 node tools/shot-glb-probe.mjs
import puppeteer from "puppeteer";

const PORT = process.env.PORT ?? "5199";
const ID = process.env.ID ?? "sm_skyscraper_module10";
const PREFIX = process.env.SHOT ?? `tools/screens/glbprobe-${ID}`;

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--window-size=900,700", "--use-gl=angle"],
  defaultViewport: { width: 900, height: 700 },
});
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 300)));
page.on("console", (m) => {
  if (m.type() === "error") console.log("[console.error]", m.text().slice(0, 300));
});

for (const az of [45, 135, 225, 315]) {
  await page.goto(`http://localhost:${PORT}/tools/glb-probe.html?id=${ID}&az=${az}`, {
    waitUntil: "networkidle2",
  });
  await page.waitForFunction(() => window.PROBE_DONE === true, { timeout: 20000 });
  await new Promise((r) => setTimeout(r, 300));
  await page.screenshot({ path: `${PREFIX}-az${az}.png` });
}
console.log("done");
await browser.close();
