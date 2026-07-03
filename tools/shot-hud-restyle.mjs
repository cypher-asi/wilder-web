// One-off: screenshot the login screen and in-game HUD after the restyle.
import puppeteer from "puppeteer";

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--window-size=1600,900", "--use-gl=angle"],
  defaultViewport: { width: 1600, height: 900 },
});
const page = await browser.newPage();
page.on("pageerror", (e) => console.error("[pageerror]", e.message));
await page.goto("http://localhost:5173", { waitUntil: "networkidle2" });

await page.waitForFunction(
  () => [...document.querySelectorAll("button")].some((b) => b.textContent.includes("DEV LOGIN")),
  { timeout: 15000 },
);
await new Promise((r) => setTimeout(r, 800));
await page.screenshot({ path: "tools/screens/restyle-login.png" });
console.log("saved restyle-login.png");

await page.evaluate(() => {
  [...document.querySelectorAll("button")].find((b) => b.textContent.includes("DEV LOGIN")).click();
});
await page.waitForFunction(
  () => document.querySelector(".char-card") || document.querySelector("input.field"),
  { timeout: 15000 },
);
if (!(await page.$(".char-card"))) {
  await page.type("input.field", "Dev");
  await page.evaluate(() => {
    [...document.querySelectorAll("button")]
      .find((b) => b.textContent.includes("CREATE RUNNER"))
      .click();
  });
  await page.waitForSelector(".char-card", { timeout: 15000 });
}
await new Promise((r) => setTimeout(r, 500));
await page.screenshot({ path: "tools/screens/restyle-charselect.png" });
console.log("saved restyle-charselect.png");

await page.click(".char-card");
await page.waitForFunction(() => window.__ui?.getState?.().joined === true, { timeout: 20000 });
await new Promise((r) => setTimeout(r, 8000));
await page.screenshot({ path: "tools/screens/restyle-hud.png" });
console.log("saved restyle-hud.png");

// Open the inventory panel too (I key).
await page.keyboard.press("KeyI");
await new Promise((r) => setTimeout(r, 800));
await page.screenshot({ path: "tools/screens/restyle-hud-inventory.png" });
console.log("saved restyle-hud-inventory.png");

await browser.close();
