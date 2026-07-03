// Try each "Shot" character card until one joins (debugging helper).
import puppeteer from "puppeteer";

const idx = Number(process.argv[2] ?? 0);
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
await page.waitForSelector(".char-card", { timeout: 15000 });
await new Promise((r) => setTimeout(r, 800));
await page.evaluate((i) => {
  const shots = [...document.querySelectorAll(".char-card")].filter((c) =>
    /shot/i.test(c.textContent),
  );
  shots[Math.min(i, shots.length - 1)].click();
}, idx);
for (let i = 0; i < 8; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  const state = await page.evaluate(() => ({
    hasCanvas: !!document.querySelector("canvas"),
    eid: window.__game ? window.__game.localEntityId : -1,
    body: document.body.innerText.slice(0, 120).replace(/\n/g, " | "),
  }));
  console.log(idx, i, JSON.stringify(state));
  if (state.eid > 0) break;
}
await browser.close();
