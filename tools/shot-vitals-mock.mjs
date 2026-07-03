// One-off: render the HUD with mocked store state (no gateway needed) to
// check the floating vitals cluster styling.
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
await page.evaluate(() => {
  [...document.querySelectorAll("button")].find((b) => b.textContent.includes("DEV LOGIN")).click();
});
await page.waitForSelector(".char-card", { timeout: 15000 });
await page.click(".char-card");

// Force the HUD visible with representative vitals, no server round-trip.
await page.waitForFunction(() => !!window.__ui, { timeout: 15000 });
await page.evaluate(() => {
  window.__ui.setState({
    connected: true,
    joined: true,
    characterName: "SHOT",
    level: 2,
    health: 50,
    maxHealth: 50,
    shield: 110,
    maxShield: 110,
    inventory: {
      slots: [
        { kind: "Ammo9mm", count: 46 },
        { kind: "Smg", count: 1 },
        { kind: "Knife", count: 1 },
        null,
      ],
      equipped_weapon: "Pistol",
      equipped_armor: null,
    },
  });
});
await new Promise((r) => setTimeout(r, 1500));
await page.screenshot({ path: "tools/screens/vitals-mock.png" });
console.log("saved vitals-mock.png");

// Depleted-shield state too.
await page.evaluate(() => {
  window.__ui.setState({ health: 23, shield: 0, maxShield: 0 });
});
await new Promise((r) => setTimeout(r, 400));
await page.screenshot({ path: "tools/screens/vitals-mock-noshield.png" });
console.log("saved vitals-mock-noshield.png");

await browser.close();
