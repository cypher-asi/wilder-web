// Temporary: diagnose why the dev-login join fails.
import puppeteer from "puppeteer";

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--window-size=1600,900", "--use-gl=angle"],
  defaultViewport: { width: 1600, height: 900 },
});
const page = await browser.newPage();
page.on("console", (m) => console.log("[console]", m.type(), m.text()));
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
page.on("response", (r) => {
  if (r.status() >= 400) console.log("[http", r.status() + "]", r.url());
});

await page.goto("http://localhost:5173", { waitUntil: "networkidle2" });
await new Promise((r) => setTimeout(r, 2000));

const body = await page.evaluate(() => document.body.innerText.slice(0, 600));
console.log("body:", JSON.stringify(body));

const hasDev = await page.evaluate(() =>
  [...document.querySelectorAll("button")].map((b) => b.textContent),
);
console.log("buttons:", JSON.stringify(hasDev));

const devBtn = await page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) =>
    x.textContent.includes("DEV LOGIN"),
  );
  if (b) b.click();
  return !!b;
});
console.log("clicked dev login:", devBtn);
await new Promise((r) => setTimeout(r, 3000));

const step2 = await page.evaluate(() => ({
  charCard: !!document.querySelector(".char-card"),
  field: !!document.querySelector("input.field"),
  body: document.body.innerText.slice(0, 400),
}));
console.log("step2:", JSON.stringify(step2));

if (!step2.charCard && step2.field) {
  await page.type("input.field", "Shot");
  await page.evaluate(() => {
    [...document.querySelectorAll("button")]
      .find((b) => b.textContent.includes("CREATE RUNNER"))
      ?.click();
  });
  await new Promise((r) => setTimeout(r, 3000));
}
const hasCard = await page.evaluate(() => !!document.querySelector(".char-card"));
console.log("char card:", hasCard);
if (hasCard) {
  await page.click(".char-card");
}
await new Promise((r) => setTimeout(r, 10000));

const state = await page.evaluate(() => {
  const g = window.__game;
  const ui = window.__ui?.getState?.();
  return {
    hasGame: !!g,
    localEntityId: g?.localEntityId,
    entityCount: g?.entities?.size,
    connected: ui?.connected,
    joined: ui?.joined,
    lastError: ui?.lastError,
    chat: ui?.chat?.slice(-5),
  };
});
console.log("state:", JSON.stringify(state, null, 1));
await page.screenshot({ path: "tools/screens/probe.png" });
await browser.close();
