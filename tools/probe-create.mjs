// Probe the create-runner flow (debugging helper).
import puppeteer from "puppeteer";

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--window-size=1600,900", "--use-gl=angle"],
  defaultViewport: { width: 1600, height: 900 },
});
const page = await browser.newPage();
page.on("pageerror", (err) => console.log("[pageerror]", String(err).slice(0, 500)));
await page.goto("http://localhost:5173", { waitUntil: "networkidle2" });
await page.waitForFunction(
  () => [...document.querySelectorAll("button")].some((b) => b.textContent.includes("DEV LOGIN")),
  { timeout: 15000 },
);
await page.evaluate(() => {
  [...document.querySelectorAll("button")].find((b) => b.textContent.includes("DEV LOGIN")).click();
});
await page.waitForSelector("input.field", { timeout: 15000 });
await new Promise((r) => setTimeout(r, 800));
const name = `S${Date.now().toString(36).slice(-6)}`;
console.log("creating runner", name);
await page.type("input.field", name);
await page.evaluate(() => {
  [...document.querySelectorAll("button")]
    .find((b) => b.textContent.includes("CREATE RUNNER"))
    .click();
});
for (let i = 0; i < 10; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  const state = await page.evaluate(() => ({
    hasCanvas: !!document.querySelector("canvas"),
    eid: window.__game ? window.__game.localEntityId : -1,
    cards: [...document.querySelectorAll(".char-card")].length,
    body: document.body.innerText.slice(0, 200).replace(/\n/g, " | "),
  }));
  console.log(i, JSON.stringify(state));
  if (state.eid > 0) break;
}
await browser.close();
