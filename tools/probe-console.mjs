// Capture browser console errors during login/join (debugging helper).
import puppeteer from "puppeteer";

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--window-size=1600,900", "--use-gl=angle"],
  defaultViewport: { width: 1600, height: 900 },
});
const page = await browser.newPage();
page.on("console", (msg) => {
  const t = msg.type();
  if (t === "error" || t === "warn") console.log(`[${t}]`, msg.text().slice(0, 500));
});
page.on("pageerror", (err) => console.log("[pageerror]", String(err).slice(0, 800)));
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
await page.evaluate(() => {
  const cards = [...document.querySelectorAll(".char-card")];
  const shot = cards.find((c) => /shot/i.test(c.textContent));
  (shot ?? cards[cards.length - 1]).click();
});
await new Promise((r) => setTimeout(r, 15000));
const state = await page.evaluate(() => ({
  hasGame: !!window.__game,
  eid: window.__game ? window.__game.localEntityId : -1,
  hasCanvas: !!document.querySelector("canvas"),
}));
console.log("state:", JSON.stringify(state));
await browser.close();
